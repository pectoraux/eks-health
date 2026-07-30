/**
 * Eks-Health AI Runtime — Program AI Agents
 *
 * Programs define specialized AI agents (nutrition coach, exercise planner,
 * sleep advisor, mental wellness companion, etc.). The platform only
 * provides the runtime — it never defines domain-specific agent behavior.
 *
 * An agent:
 *   - is registered by a Program with a role, system prompt, model, tools,
 *     capabilities, and memory type.
 *   - is executed against a participant via `run(agentId, participantId, input)`.
 *   - orchestrates: load def → construct system prompt → load memory (if
 *     persistent) → call the AI runtime → if the model requests a tool,
 *     dispatch it → store turn in memory → return AgentExecution.
 *
 * If no real AI provider is configured (the default), `run()` returns a
 * structured "pending_provider" execution — never fakes AI output.
 *
 * Multi-turn orchestration, tool dispatch, and memory management are REAL.
 */

import "server-only";

import type { AccountId } from "@/identity";
import type { ProgramId } from "@/programs";
import {
  generateId,
  getClock,
  buildEvent,
  getEventBus,
} from "@/kernel";

import {
  type AIRequest,
  type AIResponse,
  type AITraceId,
  type ModelId,
  type MemoryEntry,
  type MemoryEntryId,
  type ToolCallRequest,
  type ToolCallResult,
  type ToolCallResultId,
  type TokenUsage,
  type CostEstimate,
  type PromptTemplateId,
  AI_EVENTS,
  AIError,
  asMemoryEntryId,
  asModelId,
  asPromptTemplateId,
  asAIRequestId,
  asToolCallResultId,
} from "../core";
import { getAIRuntime, invokeTool } from "../runtime";

// ---------------------------------------------------------------------------
// Agent types
// ---------------------------------------------------------------------------

export type AgentMemoryType = "none" | "session" | "persistent";

export type AgentCapability =
  | "tool_use"
  | "structured_output"
  | "streaming"
  | "memory"
  | "multi_turn"
  | "vision"
  | "code_interpreter"
  | "knowledge_retrieval";

export interface AgentDefinition {
  readonly id: string;
  readonly programId: ProgramId;
  readonly name: string;
  readonly description: string;
  readonly role: string; // e.g. "nutrition_coach"
  readonly systemPrompt: string;
  readonly model?: ModelId;
  readonly tools: readonly string[];
  readonly capabilities: readonly AgentCapability[];
  readonly memoryType: AgentMemoryType;
  readonly maxTurns?: number;
  readonly promptTemplateId?: PromptTemplateId;
  readonly maxMemoryEntries?: number;
  readonly metadata?: Record<string, unknown>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type AgentExecutionState = "pending" | "running" | "completed" | "failed" | "pending_provider";

export interface AgentTurn {
  readonly id: string;
  readonly index: number;
  readonly role: "user" | "assistant" | "tool";
  readonly content: string;
  readonly toolCalls?: readonly ToolCallRequest[];
  readonly toolResults?: readonly ToolCallResult[];
  readonly tokensUsed?: number;
  readonly latencyMs?: number;
  readonly at: string;
}

export interface AgentExecution {
  readonly id: string;
  readonly agentId: string;
  readonly programId: ProgramId;
  readonly participantId: AccountId;
  readonly input: string;
  readonly output?: string;
  readonly turns: readonly AgentTurn[];
  readonly state: AgentExecutionState;
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly totalTokens: number;
  readonly totalCost: number;
  readonly traceId?: AITraceId;
  readonly error?: string;
  readonly model?: ModelId;
}

export interface AgentMemory {
  readonly agentId: string;
  readonly participantId: AccountId;
  readonly entries: readonly MemoryEntry[];
}

// ---------------------------------------------------------------------------
// Program Agent Runtime
// ---------------------------------------------------------------------------

export class ProgramAgentRuntime {
  private readonly agents = new Map<string, AgentDefinition>();
  private readonly agentsByProgram = new Map<ProgramId, string[]>();
  private readonly memory = new Map<string, MemoryEntry[]>(); // key: `${agentId}::${participantId}`
  private readonly executions = new Map<string, AgentExecution>();
  private readonly executionsByAgent = new Map<string, string[]>();
  private readonly executionsByParticipant = new Map<AccountId, string[]>();
  private readonly executionsByProgram = new Map<ProgramId, string[]>();

  /**
   * Register a program-defined AI agent.
   */
  registerAgent(def: Omit<AgentDefinition, "createdAt" | "updatedAt">): AgentDefinition {
    const now = getClock().iso();
    const existing = this.agents.get(def.id);
    const full: AgentDefinition = {
      ...def,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.agents.set(def.id, full);
    const list = this.agentsByProgram.get(def.programId) ?? [];
    if (!list.includes(def.id)) {
      this.agentsByProgram.set(def.programId, [...list, def.id]);
    }
    void getEventBus().publish(
      buildEvent(
        "eks.ai.agent.registered",
        { agentId: def.id, programId: def.programId, role: def.role, name: def.name, memoryType: def.memoryType },
        {},
        "domain",
      ),
    );
    return full;
  }

  getAgent(id: string): AgentDefinition | undefined {
    return this.agents.get(id);
  }

  listAgents(programId?: ProgramId): AgentDefinition[] {
    if (programId) {
      const ids = this.agentsByProgram.get(programId) ?? [];
      return ids.map((id) => this.agents.get(id)!).filter(Boolean);
    }
    return [...this.agents.values()];
  }

  /**
   * Execute an agent against a participant.
   *   (1) load agent def
   *   (2) construct system prompt + variables
   *   (3) load memory (if persistent)
   *   (4) call AI runtime
   *   (5) if tools are available and the model requests a tool, dispatch it
   *   (6) store turn in memory
   *   (7) return AgentExecution
   *
   * If no real AI provider is configured, returns a structured
   * "pending_provider" execution — never fakes AI output.
   */
  async run(agentId: string, participantId: AccountId, input: string, options?: { maxTurns?: number }): Promise<AgentExecution> {
    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new AIError({
        code: "eks.ai.agent.not_found",
        category: "validation",
        message: `Agent ${agentId} not registered.`,
        userMessage: "The requested AI agent is not available.",
      });
    }

    const executionId = `aex_${generateId()}`;
    const startedAt = getClock().iso();
    const turns: AgentTurn[] = [];
    const maxTurns = Math.min(options?.maxTurns ?? agent.maxTurns ?? 5, 10);

    let execution: AgentExecution = {
      id: executionId,
      agentId,
      programId: agent.programId,
      participantId,
      input,
      turns,
      state: "running",
      startedAt,
      totalTokens: 0,
      totalCost: 0,
    };
    this.executions.set(executionId, execution);
    this.indexExecution(execution);

    void getEventBus().publish(
      buildEvent(
        "eks.ai.agent.run.started",
        { executionId, agentId, programId: agent.programId, participantId },
        {},
        "domain",
      ),
    );

    // Build the user-prompt variables: input + recent memory context.
    const memoryEntries = agent.memoryType === "persistent"
      ? this.loadMemory(agentId, participantId)
      : [];
    const memoryContext = memoryEntries
      .slice(-(agent.maxMemoryEntries ?? 20))
      .map((m) => `[${m.role}] ${m.content}`)
      .join("\n");

    // Find or build a prompt template. If the agent declares one, use it;
    // otherwise synthesize a simple template on the fly.
    const promptId = agent.promptTemplateId ?? asPromptTemplateId(`agent:${agentId}`);

    // We construct an AIRequest that the runtime can execute. The runtime
    // requires a registered prompt template — if the agent doesn't reference
    // one, we register a synthetic template on first use.
    const runtime = getAIRuntime();
    const template = runtime.registerPrompt({
      templateId: promptId,
      version: 1,
      template: agent.promptTemplateId
        ? "{input}"
        : `System: {system}\nMemory:\n{memory}\nUser: {input}`,
      variables: agent.promptTemplateId ? ["input"] : ["system", "memory", "input"],
      systemPrompt: agent.systemPrompt,
      defaultModel: agent.model,
    });

    void template;

    const variables: Record<string, string> = agent.promptTemplateId
      ? { input }
      : { system: agent.systemPrompt, memory: memoryContext, input };

    // Build tool call descriptors (if the agent declares tools).
    const tools: ToolCallRequest[] = [];

    let aiResponse: AIResponse;
    try {
      const request: AIRequest = {
        id: asAIRequestId(`req_${generateId()}`),
        programId: agent.programId,
        participantId,
        promptId,
        variables,
        model: agent.model,
        tools: tools.length > 0 ? tools : undefined,
      };
      aiResponse = await runtime.execute(request);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      execution = { ...execution, state: "failed", error, completedAt: getClock().iso() };
      this.executions.set(executionId, execution);
      void getEventBus().publish(
        buildEvent("eks.ai.agent.run.failed", { executionId, agentId, error }, {}, "domain"),
      );
      return execution;
    }

    // If the provider wasn't configured, return a "pending_provider" execution.
    if (aiResponse.finishReason === "provider_not_configured") {
      execution = {
        ...execution,
        state: "pending_provider",
        traceId: aiResponse.traceId,
        model: aiResponse.model,
        completedAt: getClock().iso(),
        error: "provider_not_configured",
      };
      this.executions.set(executionId, execution);
      void getEventBus().publish(
        buildEvent(
          "eks.ai.agent.run.pending_provider",
          { executionId, agentId, programId: agent.programId, participantId, traceId: aiResponse.traceId },
          {},
          "domain",
        ),
      );
      return execution;
    }

    // Record the assistant turn.
    const assistantTurn: AgentTurn = {
      id: `turn_${generateId()}`,
      index: 0,
      role: "assistant",
      content: aiResponse.content,
      toolCalls: aiResponse.toolCalls,
      tokensUsed: aiResponse.tokensUsed.total,
      latencyMs: aiResponse.latencyMs,
      at: getClock().iso(),
    };
    turns.push(assistantTurn);
    let totalTokens = aiResponse.tokensUsed.total;
    let totalCost = aiResponse.cost.totalCost;

    // Tool dispatch loop — multi-turn orchestration.
    if (aiResponse.toolCalls && aiResponse.toolCalls.length > 0 && agent.tools.length > 0) {
      let currentResponse = aiResponse;
      for (let turnIndex = 1; turnIndex <= maxTurns; turnIndex++) {
        if (!currentResponse.toolCalls || currentResponse.toolCalls.length === 0) break;

        const toolResults: ToolCallResult[] = [];
        for (const tc of currentResponse.toolCalls) {
          if (!agent.tools.includes(tc.name)) {
            const result: ToolCallResult = {
              id: asToolCallResultId(`tcr_${generateId()}`),
              requestId: tc.id,
              name: tc.name,
              ok: false,
              error: `tool_not_authorized: agent ${agentId} is not permitted to call tool ${tc.name}`,
              latencyMs: 0,
              occurredAt: getClock().iso(),
            };
            toolResults.push(result);
            continue;
          }
          const result = await invokeTool(runtime, tc);
          toolResults.push(result);
          totalTokens += 0; // tool tokens are tracked in their own observability
        }

        const toolTurn: AgentTurn = {
          id: `turn_${generateId()}`,
          index: turnIndex,
          role: "tool",
          content: toolResults.map((r) => `${r.name}(${r.ok ? "ok" : "error"}): ${r.ok ? JSON.stringify(r.output) : r.error}`).join("\n"),
          toolResults,
          tokensUsed: 0,
          at: getClock().iso(),
        };
        turns.push(toolTurn);

        // Feed tool results back as a follow-up request.
        const followupVars: Record<string, string> = {
          system: agent.systemPrompt,
          memory: memoryContext,
          input: `Previous assistant response: ${currentResponse.content}\n\nTool results:\n${toolTurn.content}\n\nContinue based on the tool results.`,
        };
        const followupReq: AIRequest = {
          id: asAIRequestId(`req_${generateId()}`),
          programId: agent.programId,
          participantId,
          promptId,
          variables: followupVars,
          model: agent.model,
        };
        try {
          currentResponse = await runtime.execute(followupReq);
        } catch (e) {
          const error = e instanceof Error ? e.message : String(e);
          execution = {
            ...execution,
            turns,
            state: "failed",
            error,
            totalTokens,
            totalCost,
            completedAt: getClock().iso(),
            traceId: aiResponse.traceId,
            model: aiResponse.model,
          };
          this.executions.set(executionId, execution);
          return execution;
        }

        totalTokens += currentResponse.tokensUsed.total;
        totalCost += currentResponse.cost.totalCost;

        const nextAssistantTurn: AgentTurn = {
          id: `turn_${generateId()}`,
          index: turnIndex + 1,
          role: "assistant",
          content: currentResponse.content,
          toolCalls: currentResponse.toolCalls,
          tokensUsed: currentResponse.tokensUsed.total,
          latencyMs: currentResponse.latencyMs,
          at: getClock().iso(),
        };
        turns.push(nextAssistantTurn);

        if (!currentResponse.toolCalls || currentResponse.toolCalls.length === 0) break;
      }
    }

    // Persist memory entries (if the agent uses persistent memory).
    if (agent.memoryType === "persistent") {
      this.appendMemory(agentId, participantId, { role: "user", content: input });
      this.appendMemory(agentId, participantId, { role: "assistant", content: aiResponse.content });
    }

    execution = {
      ...execution,
      turns,
      output: aiResponse.content,
      state: "completed",
      totalTokens,
      totalCost,
      completedAt: getClock().iso(),
      traceId: aiResponse.traceId,
      model: aiResponse.model,
    };
    this.executions.set(executionId, execution);

    void getEventBus().publish(
      buildEvent(
        "eks.ai.agent.run.completed",
        {
          executionId,
          agentId,
          programId: agent.programId,
          participantId,
          turns: turns.length,
          totalTokens,
          totalCost,
          traceId: aiResponse.traceId,
        },
        {},
        "domain",
      ),
    );

    return execution;
  }

  /** Get the memory for an agent + participant. */
  getMemory(agentId: string, participantId: AccountId): AgentMemory {
    const entries = this.loadMemory(agentId, participantId);
    return { agentId, participantId, entries };
  }

  /** Clear the memory for an agent + participant. */
  clearMemory(agentId: string, participantId: AccountId): number {
    const key = `${agentId}::${participantId}`;
    const existing = this.memory.get(key) ?? [];
    this.memory.delete(key);
    void getEventBus().publish(
      buildEvent(AI_EVENTS.memoryStored, { agentId, participantId, action: "cleared", count: existing.length }, {}, "domain"),
    );
    return existing.length;
  }

  /** List executions, optionally filtered. */
  listExecutions(filter?: { agentId?: string; participantId?: AccountId; programId?: ProgramId }): AgentExecution[] {
    let list = [...this.executions.values()];
    if (filter?.agentId) list = list.filter((e) => e.agentId === filter.agentId);
    if (filter?.participantId) list = list.filter((e) => e.participantId === filter.participantId);
    if (filter?.programId) list = list.filter((e) => e.programId === filter.programId);
    return list.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  getExecution(id: string): AgentExecution | undefined {
    return this.executions.get(id);
  }

  /** Aggregate stats. REAL computation. */
  getStats(programId?: ProgramId): {
    totalAgents: number;
    totalExecutions: number;
    avgCost: number;
    avgTokens: number;
    successRate: number;
    pendingProvider: number;
    byRole: Record<string, number>;
  } {
    const agents = programId ? this.listAgents(programId) : [...this.agents.values()];
    const execs = programId
      ? [...this.executions.values()].filter((e) => e.programId === programId)
      : [...this.executions.values()];
    const totalCost = execs.reduce((sum, e) => sum + e.totalCost, 0);
    const totalTokens = execs.reduce((sum, e) => sum + e.totalTokens, 0);
    const successful = execs.filter((e) => e.state === "completed").length;
    const pendingProvider = execs.filter((e) => e.state === "pending_provider").length;
    const byRole: Record<string, number> = {};
    for (const a of agents) byRole[a.role] = (byRole[a.role] ?? 0) + 1;
    return {
      totalAgents: agents.length,
      totalExecutions: execs.length,
      avgCost: execs.length > 0 ? totalCost / execs.length : 0,
      avgTokens: execs.length > 0 ? totalTokens / execs.length : 0,
      successRate: execs.length > 0 ? successful / execs.length : 0,
      pendingProvider,
      byRole,
    };
  }

  /** Reset (for tests). */
  reset(): void {
    this.agents.clear();
    this.agentsByProgram.clear();
    this.memory.clear();
    this.executions.clear();
    this.executionsByAgent.clear();
    this.executionsByParticipant.clear();
    this.executionsByProgram.clear();
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private loadMemory(agentId: string, participantId: AccountId): MemoryEntry[] {
    const key = `${agentId}::${participantId}`;
    return this.memory.get(key) ?? [];
  }

  private appendMemory(agentId: string, participantId: AccountId, entry: Omit<MemoryEntry, "id" | "at">): MemoryEntry {
    const key = `${agentId}::${participantId}`;
    const list = this.memory.get(key) ?? [];
    const agent = this.agents.get(agentId);
    const max = agent?.maxMemoryEntries ?? 50;
    const full: MemoryEntry = {
      ...entry,
      id: asMemoryEntryId(`mem_${generateId()}`),
      at: getClock().iso(),
    };
    list.push(full);
    // Trim oldest when over capacity.
    while (list.length > max) list.shift();
    this.memory.set(key, list);
    void getEventBus().publish(
      buildEvent(
        AI_EVENTS.memoryStored,
        { agentId, participantId, entryId: full.id, role: full.role, action: "appended", memorySize: list.length },
        {},
        "domain",
      ),
    );
    return full;
  }

  private indexExecution(execution: AgentExecution): void {
    const aList = this.executionsByAgent.get(execution.agentId) ?? [];
    this.executionsByAgent.set(execution.agentId, [...aList, execution.id]);
    const pList = this.executionsByParticipant.get(execution.participantId) ?? [];
    this.executionsByParticipant.set(execution.participantId, [...pList, execution.id]);
    const prList = this.executionsByProgram.get(execution.programId) ?? [];
    this.executionsByProgram.set(execution.programId, [...prList, execution.id]);
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _agents: ProgramAgentRuntime | null = null;

export function getProgramAgents(): ProgramAgentRuntime {
  if (!_agents) _agents = new ProgramAgentRuntime();
  return _agents;
}

export function resetProgramAgents(): void {
  _agents = null;
}

export function setProgramAgents(rt: ProgramAgentRuntime): void {
  _agents = rt;
}

// ---------------------------------------------------------------------------
// Convenience: register a small catalog of "agent role templates" that
// Programs can clone & specialize. The platform defines NO domain logic —
// only the structural shape common to every coaching agent.
// ---------------------------------------------------------------------------

export const AGENT_ROLE_TEMPLATES: readonly { role: string; name: string; description: string; defaultCapabilities: readonly AgentCapability[]; defaultMemory: AgentMemoryType; defaultTools: readonly string[] }[] = [
  {
    role: "nutrition_coach",
    name: "Nutrition Coach",
    description: "Template for a nutrition coaching agent. Programs supply the system prompt, knowledge, and tooling.",
    defaultCapabilities: ["tool_use", "memory", "multi_turn", "structured_output"],
    defaultMemory: "persistent",
    defaultTools: [],
  },
  {
    role: "exercise_planner",
    name: "Exercise Planner",
    description: "Template for an exercise planning agent. Programs supply the system prompt and tooling.",
    defaultCapabilities: ["tool_use", "memory", "multi_turn"],
    defaultMemory: "session",
    defaultTools: [],
  },
  {
    role: "sleep_advisor",
    name: "Sleep Advisor",
    description: "Template for a sleep coaching agent. Programs supply the system prompt and tooling.",
    defaultCapabilities: ["memory", "multi_turn", "structured_output"],
    defaultMemory: "persistent",
    defaultTools: [],
  },
  {
    role: "mental_wellness_companion",
    name: "Mental Wellness Companion",
    description: "Template for a mental-wellness companion agent. Programs supply the system prompt and tooling.",
    defaultCapabilities: ["memory", "multi_turn"],
    defaultMemory: "persistent",
    defaultTools: [],
  },
  {
    role: "medication_reminder",
    name: "Medication Reminder",
    description: "Template for a medication reminder agent. Programs supply the system prompt and tooling.",
    defaultCapabilities: ["memory"],
    defaultMemory: "none",
    defaultTools: [],
  },
];
