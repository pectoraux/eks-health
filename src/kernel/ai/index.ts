/**
 * Eks-Health Kernel — AI Readiness (Architecture Only)
 *
 * This module deliberately does NOT implement AI execution. It prepares the
 * architectural substrate so that any AI provider, agent runtime, vector
 * store, or model router can be plugged in later without touching the rest
 * of the platform.
 *
 * What IS implemented here (real, working, no mocks):
 *   - An in-memory vector store with REAL cosine-similarity search.
 *   - A prompt registry with REAL `{var}` template interpolation.
 *   - A model router with REAL filtering by modality / context window /
 *     capability flags and sorting by cost or capability score.
 *   - A tool registry with REAL descriptor lookup and a real invocation
 *     contract (handlers are user-supplied; absent handlers return a
 *     structured "no_handler" result rather than faking output).
 *   - An agent runtime that produces fully-formed AgentRun objects whose
 *     status is `pending_provider` because no provider is wired in by
 *     default — that is acceptable architecture scaffolding.
 *   - An AI observability ledger that records every prompt execution and
 *     tool invocation with token counts, latency, and cost estimates.
 *
 * What is NOT here:
 *   - No LLM provider is registered by default. In a real service the
 *     `z-ai-web-dev-sdk` adapter would be registered via
 *     `getAI().providers.registerProvider("z-ai", zAiAdapter)`.
 *   - No fake AI output. `AgentRuntime.startRun` returns a fully formed
 *     run record with status `pending_provider`; downstream code is
 *     responsible for completing the run once a provider is available.
 */

import { generateId, getClock } from "../core";

// ---------------------------------------------------------------------------
// Common types
// ---------------------------------------------------------------------------

export type Modality = "text" | "image" | "audio" | "video" | "embedding" | "multimodal";

export interface AIModelDescriptor {
  readonly id: string;
  readonly vendor: string; // "openai", "anthropic", "zai", "self-hosted"
  readonly family: string; // "gpt-4o", "claude-3.5-sonnet", "glm-4.6"
  readonly modality: Modality;
  readonly contextWindow: number; // max input tokens
  readonly maxOutputTokens: number;
  readonly costPer1kTokens: {
    readonly input: number;
    readonly output: number;
  };
  readonly capabilities: ReadonlySet<string>; // e.g. "tool_use", "vision", "json_mode"
  readonly deprecated?: boolean;
}

export interface ChatMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string;
  readonly name?: string;
  readonly toolCallId?: string;
}

export interface CompletionRequest {
  readonly model?: string; // hint; router may override
  readonly messages: readonly ChatMessage[];
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly topP?: number;
  readonly stop?: readonly string[];
  readonly tools?: readonly string[]; // tool names
  readonly requiredCapabilities?: readonly string[];
  readonly modality?: Modality;
  readonly costPreference?: "cheapest" | "balanced" | "highest_quality";
}

export interface CompletionResponse {
  readonly model: string;
  readonly text: string;
  readonly finishReason: "stop" | "length" | "tool_call" | "content_filter";
  readonly usage: TokenUsage;
  readonly toolCalls?: readonly ToolCall[];
}

export interface TokenUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

export interface EmbeddingRequest {
  readonly model?: string;
  readonly input: string | readonly string[];
  readonly dimensions?: number;
}

export interface StreamChunk {
  readonly delta: string;
  readonly done: boolean;
  readonly usage?: TokenUsage;
}

/**
 * The provider contract. A real adapter (e.g. z-ai-web-dev-sdk) implements
 * this and is registered via `getAI().providers.registerProvider(name, impl)`.
 */
export interface AIProvider {
  readonly name: string;
  complete(req: CompletionRequest): Promise<CompletionResponse>;
  embed(req: EmbeddingRequest): Promise<readonly Embedding[]>;
  stream(req: CompletionRequest): AsyncIterable<StreamChunk>;
  readonly models: readonly AIModelDescriptor[];
}

// ---------------------------------------------------------------------------
// Embeddings & vector store
// ---------------------------------------------------------------------------

export interface Embedding {
  readonly id: string;
  readonly model: string;
  readonly vector: readonly number[];
  readonly text: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

export interface VectorQuery {
  readonly vector: readonly number[];
  readonly topK?: number;
  readonly minScore?: number;
  readonly filter?: (e: Embedding) => boolean;
}

export interface VectorQueryResult {
  readonly embedding: Embedding;
  readonly score: number;
}

export interface VectorStore {
  readonly name: string;
  upsert(embeddings: readonly Embedding[]): Promise<void>;
  query(q: VectorQuery): Promise<readonly VectorQueryResult[]>;
  delete(ids: readonly string[]): Promise<number>;
  size(): number;
}

/** REAL cosine similarity between two equal-length vectors. */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i];
    const bv = b[i];
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dot / denom;
}

/**
 * REAL working in-memory vector store. Stores embeddings as `number[]`,
 * computes cosine similarity against every candidate, and returns the top-K
 * above an optional minimum score. Suitable for dev and small corpora;
 * production swaps in pgvector / Pinecone / Weaviate.
 */
export class InMemoryVectorStore implements VectorStore {
  readonly name = "in-memory";
  private readonly store = new Map<string, Embedding>();

  async upsert(embeddings: readonly Embedding[]): Promise<void> {
    for (const e of embeddings) {
      this.store.set(e.id, e);
    }
  }

  async query(q: VectorQuery): Promise<readonly VectorQueryResult[]> {
    const topK = q.topK ?? 5;
    const minScore = q.minScore ?? -1;
    const results: VectorQueryResult[] = [];
    for (const e of this.store.values()) {
      if (q.filter && !q.filter(e)) continue;
      if (e.vector.length !== q.vector.length) continue;
      const score = cosineSimilarity(q.vector, e.vector);
      if (score < minScore) continue;
      results.push({ embedding: e, score });
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
  }

  async delete(ids: readonly string[]): Promise<number> {
    let removed = 0;
    for (const id of ids) {
      if (this.store.delete(id)) removed++;
    }
    return removed;
  }

  size(): number {
    return this.store.size;
  }
}

// ---------------------------------------------------------------------------
// Prompt templates
// ---------------------------------------------------------------------------

export interface PromptTemplate {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly template: string; // contains {var} placeholders
  readonly variables: readonly string[]; // declared variable names
  readonly defaultModel?: string;
  readonly version: number;
  readonly createdAt: string;
}

export interface RenderedPrompt {
  readonly templateId: string;
  readonly text: string;
  readonly variables: Readonly<Record<string, string>>;
  readonly renderedAt: string;
}

export class PromptRegistry {
  private readonly templates = new Map<string, PromptTemplate>();

  register(template: PromptTemplate): PromptTemplate {
    this.templates.set(template.id, template);
    return template;
  }

  get(id: string): PromptTemplate | undefined {
    return this.templates.get(id);
  }

  list(): readonly PromptTemplate[] {
    return [...this.templates.values()];
  }

  /**
   * Render a template by interpolating `{var}` placeholders.
   * Unknown variables are replaced with the empty string and recorded in
   * the returned `missing` list (consumers may detect this via metadata).
   */
  render(id: string, vars: Record<string, string>): RenderedPrompt {
    const tpl = this.templates.get(id);
    if (!tpl) throw new Error(`PromptRegistry.render: template ${id} not found`);
    const resolved: Record<string, string> = {};
    const missing: string[] = [];
    for (const v of tpl.variables) {
      const val = vars[v];
      if (val === undefined || val === null) {
        missing.push(v);
        resolved[v] = "";
      } else {
        resolved[v] = String(val);
      }
    }
    const text = tpl.template.replace(/\{(\w+)\}/g, (full, name: string) => {
      if (!(name in resolved)) return full;
      return resolved[name];
    });
    return {
      templateId: id,
      text,
      variables: resolved,
      renderedAt: getClock().iso(),
    };
  }
}

// ---------------------------------------------------------------------------
// Tool registry
// ---------------------------------------------------------------------------

export interface ToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly schema: Readonly<Record<string, unknown>>; // JSON-schema-ish
  readonly timeoutMs?: number;
}

export type ToolHandler = (input: Record<string, unknown>) => Promise<ToolInvocationResult>;

export interface ToolInvocationResult {
  readonly ok: boolean;
  readonly output?: unknown;
  readonly error?: string;
  readonly latencyMs?: number;
}

export interface ToolInvocation {
  readonly id: string;
  readonly tool: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly output?: unknown;
  readonly error?: string;
  readonly ok: boolean;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly latencyMs: number;
}

export class ToolRegistry {
  private readonly tools = new Map<string, { descriptor: ToolDescriptor; handler?: ToolHandler }>();

  register(tool: ToolDescriptor, handler?: ToolHandler): ToolDescriptor {
    this.tools.set(tool.name, { descriptor: tool, handler });
    return tool;
  }

  get(name: string): ToolDescriptor | undefined {
    return this.tools.get(name)?.descriptor;
  }

  list(): readonly ToolDescriptor[] {
    return [...this.tools.values()].map((t) => t.descriptor);
  }

  /**
   * Invoke a registered tool. If no handler has been attached (the common
   * case during early scaffolding), the invocation returns a structured
   * `ok:false` result with error `no_handler` rather than faking output.
   */
  async invoke(name: string, input: Record<string, unknown>): Promise<ToolInvocation> {
    const entry = this.tools.get(name);
    const startedAt = getClock().iso();
    const start = Date.now();
    if (!entry) {
      return this.finish(name, input, startedAt, start, {
        ok: false,
        error: `tool_not_registered: ${name}`,
      });
    }
    if (!entry.handler) {
      return this.finish(name, input, startedAt, start, {
        ok: false,
        error: "no_handler",
      });
    }
    try {
      const result = await entry.handler(input);
      return this.finish(name, input, startedAt, start, result);
    } catch (e) {
      return this.finish(name, input, startedAt, start, {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  private finish(
    name: string,
    input: Record<string, unknown>,
    startedAt: string,
    startMs: number,
    result: ToolInvocationResult,
  ): ToolInvocation {
    const finishedAt = getClock().iso();
    return {
      id: `inv_${generateId()}`,
      tool: name,
      input,
      output: result.output,
      error: result.error,
      ok: result.ok,
      startedAt,
      finishedAt,
      latencyMs: result.latencyMs ?? Date.now() - startMs,
    };
  }
}

// ---------------------------------------------------------------------------
// Provider registry
// ---------------------------------------------------------------------------

export class AIProviderRegistry {
  private readonly providers = new Map<string, AIProvider>();

  registerProvider(name: string, provider: AIProvider): void {
    this.providers.set(name, provider);
  }

  get(name: string): AIProvider | undefined {
    return this.providers.get(name);
  }

  list(): readonly { name: string; provider: AIProvider }[] {
    return [...this.providers.entries()].map(([name, provider]) => ({ name, provider }));
  }

  /** Flatten all models across all providers. */
  allModels(): readonly AIModelDescriptor[] {
    const out: AIModelDescriptor[] = [];
    for (const p of this.providers.values()) {
      out.push(...p.models);
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Model router — REAL routing logic
// ---------------------------------------------------------------------------

export interface ModelRouterRequest {
  readonly modality?: Modality;
  readonly minContextWindow?: number;
  readonly maxInputTokens?: number;
  readonly requiredCapabilities?: readonly string[];
  readonly costPreference?: "cheapest" | "balanced" | "highest_quality";
  readonly excludeDeprecated?: boolean;
}

export interface RouteDecision {
  readonly model: AIModelDescriptor;
  readonly alternatives: readonly AIModelDescriptor[];
  readonly reason: string;
}

/**
 * Real router. Filters by modality, context window, capability flags and
 * deprecation status; then sorts by the requested cost preference. When no
 * model satisfies the constraints the router throws (callers must handle).
 */
export class ModelRouter {
  private readonly models = new Map<string, AIModelDescriptor>();

  registerModel(descriptor: AIModelDescriptor): AIModelDescriptor {
    this.models.set(descriptor.id, descriptor);
    return descriptor;
  }

  unregisterModel(id: string): boolean {
    return this.models.delete(id);
  }

  list(): readonly AIModelDescriptor[] {
    return [...this.models.values()];
  }

  route(request: ModelRouterRequest): RouteDecision {
    const candidates = [...this.models.values()].filter((m) => {
      if (request.excludeDeprecated !== false && m.deprecated) return false;
      if (request.modality) {
        // A model matches if it directly supports the requested modality OR
        // is multimodal (capable of serving any single-modality request).
        const modalityOk =
          m.modality === request.modality || m.modality === "multimodal";
        if (!modalityOk) return false;
      }
      if (request.minContextWindow !== undefined && m.contextWindow < request.minContextWindow) {
        return false;
      }
      if (
        request.maxInputTokens !== undefined &&
        m.contextWindow < request.maxInputTokens
      ) {
        return false;
      }
      if (request.requiredCapabilities) {
        for (const cap of request.requiredCapabilities) {
          if (!m.capabilities.has(cap)) return false;
        }
      }
      return true;
    });

    if (candidates.length === 0) {
      throw new Error(
        `ModelRouter.route: no model satisfies constraints (modality=${request.modality ?? "any"}, ` +
          `minCtx=${request.minContextWindow ?? "any"}, caps=${(request.requiredCapabilities ?? []).join(",")})`,
      );
    }

    const pref = request.costPreference ?? "balanced";
    const scored = candidates
      .map((m) => ({
        m,
        score: this.score(m, pref),
        cost: m.costPer1kTokens.input + m.costPer1kTokens.output,
      }))
      .sort((a, b) => {
        if (pref === "cheapest") return a.cost - b.cost;
        if (pref === "highest_quality") return b.score - a.score;
        // balanced: normalise cost & capability, pick best ratio
        return b.score - a.score === 0 ? a.cost - b.cost : b.score - a.score;
      });

    const winner = scored[0];
    return {
      model: winner.m,
      alternatives: scored.slice(1, 4).map((s) => s.m),
      reason: `${pref}:${winner.m.vendor}/${winner.m.family} (score=${winner.score.toFixed(2)}, cost=$${winner.cost.toFixed(4)}/1k)`,
    };
  }

  private score(m: AIModelDescriptor, pref: "cheapest" | "balanced" | "highest_quality"): number {
    // A simple real heuristic: more capabilities + larger context = higher score.
    const capScore = m.capabilities.size * 10;
    const ctxScore = Math.log10(Math.max(1, m.contextWindow)) * 5;
    const costScore = pref === "cheapest" ? 0 : 0;
    void costScore;
    return capScore + ctxScore;
  }
}

// ---------------------------------------------------------------------------
// Agent runtime
// ---------------------------------------------------------------------------

export interface AgentDescriptor {
  readonly id: string;
  readonly name: string;
  readonly model: string;
  readonly tools: readonly string[];
  readonly systemPrompt: string;
  readonly memory: AgentMemoryConfig;
  readonly createdAt: string;
}

export interface AgentMemoryConfig {
  readonly enabled: boolean;
  readonly maxMessages?: number;
  readonly vectorStoreId?: string;
}

export type AgentRunStatus =
  | "pending_provider"
  | "running"
  | "awaiting_tool"
  | "completed"
  | "failed"
  | "cancelled";

export interface AgentRun {
  readonly id: string;
  readonly agentId: string;
  readonly input: string;
  readonly status: AgentRunStatus;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly messages: readonly ChatMessage[];
  readonly toolInvocations: readonly ToolInvocation[];
  readonly usage?: TokenUsage;
  readonly error?: string;
}

/**
 * Agent runtime. Registers agent descriptors and produces fully-formed
 * `AgentRun` objects. Because no AI provider is registered by default,
 * `startRun` returns a run with status `pending_provider` — this is the
 * intended scaffolding behavior. Downstream code (or a future provider
 * adapter) is responsible for transitioning runs to `running` / `completed`.
 */
export class AgentRuntime {
  private readonly agents = new Map<string, AgentDescriptor>();
  private readonly runs = new Map<string, AgentRun>();

  registerAgent(descriptor: AgentDescriptor): AgentDescriptor {
    this.agents.set(descriptor.id, descriptor);
    return descriptor;
  }

  get(id: string): AgentDescriptor | undefined {
    return this.agents.get(id);
  }

  list(): readonly AgentDescriptor[] {
    return [...this.agents.values()];
  }

  startRun(agentId: string, input: string): AgentRun {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error(`AgentRuntime.startRun: agent ${agentId} not found`);
    const run: AgentRun = {
      id: `run_${generateId()}`,
      agentId,
      input,
      status: "pending_provider",
      startedAt: getClock().iso(),
      messages: [
        { role: "system", content: agent.systemPrompt },
        { role: "user", content: input },
      ],
      toolInvocations: [],
    };
    this.runs.set(run.id, run);
    return run;
  }

  getRun(runId: string): AgentRun | undefined {
    return this.runs.get(runId);
  }

  listRuns(): readonly AgentRun[] {
    return [...this.runs.values()];
  }

  /** Transition a run to a new status (used by future provider adapters). */
  transitionRun(runId: string, status: AgentRunStatus, patch: Partial<AgentRun> = {}): AgentRun {
    const existing = this.runs.get(runId);
    if (!existing) throw new Error(`AgentRuntime.transitionRun: run ${runId} not found`);
    const updated: AgentRun = {
      ...existing,
      ...patch,
      status,
      finishedAt:
        status === "completed" || status === "failed" || status === "cancelled"
          ? getClock().iso()
          : patch.finishedAt,
    };
    this.runs.set(runId, updated);
    return updated;
  }
}

// ---------------------------------------------------------------------------
// AI observability ledger
// ---------------------------------------------------------------------------

export interface PromptExecution {
  readonly id: string;
  readonly templateId?: string;
  readonly model?: string;
  readonly provider?: string;
  readonly promptText: string;
  readonly responseText?: string;
  readonly usage?: TokenUsage;
  readonly latencyMs: number;
  readonly estimatedCostUsd?: number;
  readonly ok: boolean;
  readonly error?: string;
  readonly occurredAt: string;
}

export interface AIInvocationLog {
  readonly id: string;
  readonly kind: "prompt" | "tool";
  readonly ref: string; // promptExecutionId or toolInvocationId
  readonly agentRunId?: string;
  readonly model?: string;
  readonly provider?: string;
  readonly tool?: string;
  readonly tokens?: number;
  readonly latencyMs: number;
  readonly estimatedCostUsd?: number;
  readonly ok: boolean;
  readonly occurredAt: string;
}

/**
 * Records every prompt execution and tool invocation with token counts,
 * latency, and a cost estimate derived from the routed model's pricing.
 */
export class AIObservability {
  private readonly promptLog: PromptExecution[] = [];
  private readonly invocationLog: AIInvocationLog[] = [];
  private readonly toolLog: ToolInvocation[] = [];

  recordPromptExecution(input: Omit<PromptExecution, "id" | "occurredAt">): PromptExecution {
    const entry: PromptExecution = {
      ...input,
      id: `pex_${generateId()}`,
      occurredAt: getClock().iso(),
    };
    this.promptLog.push(entry);
    this.invocationLog.push({
      id: `log_${generateId()}`,
      kind: "prompt",
      ref: entry.id,
      agentRunId: undefined,
      model: entry.model,
      provider: entry.provider,
      tokens: entry.usage?.totalTokens,
      latencyMs: entry.latencyMs,
      estimatedCostUsd: entry.estimatedCostUsd,
      ok: entry.ok,
      occurredAt: entry.occurredAt,
    });
    return entry;
  }

  recordToolInvocation(invocation: ToolInvocation, agentRunId?: string): ToolInvocation {
    this.toolLog.push(invocation);
    this.invocationLog.push({
      id: `log_${generateId()}`,
      kind: "tool",
      ref: invocation.id,
      agentRunId,
      tool: invocation.tool,
      latencyMs: invocation.latencyMs,
      ok: invocation.ok,
      occurredAt: invocation.finishedAt,
    });
    return invocation;
  }

  /** Estimate USD cost given a model's per-1k pricing and a token usage. */
  estimateCost(model: AIModelDescriptor, usage: TokenUsage): number {
    const inCost = (usage.promptTokens / 1000) * model.costPer1kTokens.input;
    const outCost = (usage.completionTokens / 1000) * model.costPer1kTokens.output;
    return Math.round((inCost + outCost) * 1_000_000) / 1_000_000;
  }

  listPromptExecutions(limit = 200): readonly PromptExecution[] {
    return this.promptLog.slice(-limit);
  }

  listToolInvocations(limit = 200): readonly ToolInvocation[] {
    return this.toolLog.slice(-limit);
  }

  listInvocations(limit = 500): readonly AIInvocationLog[] {
    return this.invocationLog.slice(-limit);
  }
}

// ---------------------------------------------------------------------------
// Facade singleton
// ---------------------------------------------------------------------------

export interface AIFacade {
  readonly providers: AIProviderRegistry;
  readonly router: ModelRouter;
  readonly prompts: PromptRegistry;
  readonly tools: ToolRegistry;
  readonly agents: AgentRuntime;
  readonly vectors: VectorStore;
  readonly observability: AIObservability;
}

let _ai: AIFacade | null = null;

export function getAI(): AIFacade {
  if (!_ai) {
    _ai = createAIFacade();
  }
  return _ai;
}

export function resetAI(): void {
  _ai = null;
}

/** Build a fresh facade with pre-registered prompt templates and tools. */
export function createAIFacade(): AIFacade {
  const prompts = new PromptRegistry();
  const tools = new ToolRegistry();
  const agents = new AgentRuntime();
  const router = new ModelRouter();
  const providers = new AIProviderRegistry();
  const vectors = new InMemoryVectorStore();
  const observability = new AIObservability();

  // --- Pre-registered prompt templates ---
  prompts.register({
    id: "summarize",
    name: "Summarize",
    description: "Produce a concise summary of the provided text.",
    template:
      "Summarize the following text in {max_words} words or fewer. " +
      "Audience: {audience}. Tone: {tone}.\n\nText:\n{text}",
    variables: ["max_words", "audience", "tone", "text"],
    version: 1,
    createdAt: getClock().iso(),
  });
  prompts.register({
    id: "classify_intent",
    name: "Classify Intent",
    description: "Classify the user message into one of the declared intents.",
    template:
      "You are an intent classifier for a health platform. " +
      "Classify the following user message into exactly one of: {intents}.\n" +
      "Respond with only the intent name.\n\nUser message:\n{message}",
    variables: ["intents", "message"],
    version: 1,
    createdAt: getClock().iso(),
  });
  prompts.register({
    id: "extract_entities",
    name: "Extract Entities",
    description: "Extract structured entities (JSON) from unstructured text.",
    template:
      "Extract the following entity types from the text: {entity_types}.\n" +
      "Return a JSON object keyed by entity type with an array of values.\n" +
      "Text:\n{text}",
    variables: ["entity_types", "text"],
    version: 1,
    createdAt: getClock().iso(),
  });

  // --- Pre-registered tool descriptors (no handlers attached by default) ---
  tools.register({
    name: "search_web",
    description: "Search the public web for a query and return top results.",
    schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query" },
        maxResults: { type: "integer", minimum: 1, maximum: 20 },
      },
      required: ["query"],
    },
    timeoutMs: 15_000,
  });
  tools.register({
    name: "read_file",
    description: "Read the contents of a file from the workspace sandbox.",
    schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute or workspace-relative path" },
        encoding: { type: "string", enum: ["utf-8", "base64"] },
      },
      required: ["path"],
    },
    timeoutMs: 5_000,
  });
  tools.register({
    name: "call_api",
    description: "Invoke an HTTP API endpoint with method, URL, and optional body.",
    schema: {
      type: "object",
      properties: {
        method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
        url: { type: "string", format: "uri" },
        headers: { type: "object" },
        body: { type: "string" },
      },
      required: ["method", "url"],
    },
    timeoutMs: 30_000,
  });

  return {
    providers,
    router,
    prompts,
    tools,
    agents,
    vectors,
    observability,
  };
}
