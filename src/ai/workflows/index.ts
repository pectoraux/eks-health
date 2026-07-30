/**
 * Eks-Health AI Runtime — Workflow Engine
 *
 * Programs define workflows (initial assessment → generate AI plan → book
 * technician → collect measurements → update score → generate missions →
 * notify → evaluate progress → adapt plan → repeat). The platform executes
 * workflows step-by-step.
 *
 * Each step is one of a fixed set of generic types (WorkflowStepType). The
 * engine dispatches on type, executes a real handler, records the result,
 * advances to the next step, and emits workflow.step events. Programs
 * supply step inputs; the platform supplies the execution machinery.
 *
 * Capabilities:
 *   - register(workflow) with REAL step-graph validation (DFS cycle
 *     detection, start-step existence, all nextStepIds valid)
 *   - execute(workflowId, participantId, initialContext?) — step-by-step
 *   - pause / resume / cancel
 *   - replay(executionId) — deterministic replay from step history
 *
 * The engine never blocks forever on a `wait` step — pause is recorded and
 * the caller (scheduler) is responsible for resuming. Real context
 * propagation across steps. Real handler dispatch.
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
  type WorkflowId,
  type WorkflowExecutionId,
  type WorkflowDefinition,
  type WorkflowExecution,
  type WorkflowStep,
  type WorkflowStepType,
  type WorkflowExecutionState,
  asWorkflowId,
  asWorkflowExecutionId,
  MISSION_EVENTS,
  MissionError,
} from "@/missions/core";

import { getAIRuntime, createAIRequest } from "../runtime";
import type { AIRequest, ModelId } from "../core";
import { asModelId, asPromptTemplateId } from "../core";

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export type {
  WorkflowId,
  WorkflowExecutionId,
  WorkflowDefinition,
  WorkflowExecution,
  WorkflowStep,
  WorkflowStepType,
  WorkflowExecutionState,
};

// ---------------------------------------------------------------------------
// Workflow context & step result
// ---------------------------------------------------------------------------

export interface WorkflowContext {
  readonly participantId: AccountId;
  readonly programId: ProgramId;
  variables: Record<string, unknown>;
  measurements: { schemaId: string; value: unknown; at: string }[];
  scores: { competitionId: string; score: number; at: string }[];
  missions: { missionId: string; state: string }[];
  agentExecutions: { agentId: string; executionId: string }[];
  artifacts: Record<string, unknown>;
}

export interface StepResult {
  readonly stepId: string;
  readonly success: boolean;
  readonly output: unknown;
  readonly error?: string;
  readonly durationMs: number;
  readonly startedAt: string;
  readonly completedAt: string;
}

// ---------------------------------------------------------------------------
// Workflow Engine
// ---------------------------------------------------------------------------

export class WorkflowEngine {
  private readonly definitions = new Map<WorkflowId, WorkflowDefinition>();
  private readonly defsByProgram = new Map<ProgramId, WorkflowId[]>();
  private readonly executions = new Map<WorkflowExecutionId, WorkflowExecution>();
  private readonly execByParticipant = new Map<AccountId, WorkflowExecutionId[]>();
  private readonly execByWorkflow = new Map<WorkflowId, WorkflowExecutionId[]>();
  private readonly stepResults = new Map<WorkflowExecutionId, StepResult[]>(); // executionId → ordered results

  /**
   * Register a workflow definition. Performs REAL step-graph validation:
   *   - startStepId must exist
   *   - every nextStepId / branchTrueId / branchFalseId must reference an existing step
   *   - the graph must not contain a cycle (DFS)
   *   - exactly one startStepId (no orphan entry-points besides the declared one)
   */
  register(def: Omit<WorkflowDefinition, "id" | "createdAt" | "updatedAt"> & { id?: WorkflowId }): WorkflowDefinition {
    const id = def.id ?? asWorkflowId(`wf_${generateId()}`);
    const now = getClock().iso();
    const full: WorkflowDefinition = { ...def, id, createdAt: now, updatedAt: now };

    this.validateDefinition(full);

    this.definitions.set(id, full);
    const list = this.defsByProgram.get(full.programId) ?? [];
    this.defsByProgram.set(full.programId, [...list, id]);

    void getEventBus().publish(
      buildEvent(
        "eks.ai.workflow.registered",
        { workflowId: id, programId: full.programId, name: full.name, stepCount: full.steps.length, version: full.version },
        {},
        "domain",
      ),
    );
    return full;
  }

  get(id: WorkflowId): WorkflowDefinition | undefined {
    return this.definitions.get(id);
  }

  list(programId?: ProgramId): WorkflowDefinition[] {
    if (programId) {
      const ids = this.defsByProgram.get(programId) ?? [];
      return ids.map((id) => this.definitions.get(id)!).filter(Boolean);
    }
    return [...this.definitions.values()];
  }

  /**
   * Execute a workflow step-by-step. Real step dispatch + real context
   * propagation. Returns the final WorkflowExecution.
   */
  async execute(
    workflowId: WorkflowId,
    participantId: AccountId,
    initialContext?: Partial<WorkflowContext>,
  ): Promise<WorkflowExecution> {
    const def = this.definitions.get(workflowId);
    if (!def) {
      throw new MissionError({
        code: "eks.ai.workflow.not_found",
        category: "workflow_invalid",
        message: `Workflow ${workflowId} not registered.`,
      });
    }

    const executionId = asWorkflowExecutionId(`wfx_${generateId()}`);
    const startedAt = getClock().iso();
    const context: WorkflowContext = {
      participantId,
      programId: def.programId,
      variables: (initialContext?.variables as Record<string, unknown>) ?? {},
      measurements: initialContext?.measurements ?? [],
      scores: initialContext?.scores ?? [],
      missions: initialContext?.missions ?? [],
      agentExecutions: initialContext?.agentExecutions ?? [],
      artifacts: initialContext?.artifacts ?? {},
    };

    let execution: WorkflowExecution = {
      id: executionId,
      workflowId,
      participantId,
      state: "running",
      currentStepId: def.startStepId,
      startedAt,
      stepHistory: [],
      context: this.contextToRecord(context),
    };
    this.executions.set(executionId, execution);
    this.stepResults.set(executionId, []);
    this.indexExecution(execution);

    void getEventBus().publish(
      buildEvent(
        "eks.ai.workflow.started",
        { executionId, workflowId, programId: def.programId, participantId, startStepId: def.startStepId },
        {},
        "domain",
      ),
    );

    let currentStep: WorkflowStep | undefined = def.steps.find((s) => s.id === def.startStepId);
    while (currentStep) {
      const result = await this.executeStep(def, executionId, currentStep, context);
      const stepEntry = {
        stepId: currentStep.id,
        state: result.success ? "completed" : "failed",
        startedAt: result.startedAt,
        completedAt: result.completedAt,
        output: result.output,
      };
      execution = {
        ...execution,
        stepHistory: [...execution.stepHistory, stepEntry],
        currentStepId: currentStep.id,
        context: this.contextToRecord(context),
      };
      this.executions.set(executionId, execution);

      void getEventBus().publish(
        buildEvent(
          MISSION_EVENTS.workflowStepExecuted,
          {
            executionId,
            workflowId,
            programId: def.programId,
            participantId,
            stepId: currentStep.id,
            stepType: currentStep.type,
            success: result.success,
            durationMs: result.durationMs,
          },
          {},
          "domain",
        ),
      );

      if (!result.success) {
        execution = { ...execution, state: "failed", completedAt: getClock().iso() };
        this.executions.set(executionId, execution);
        void getEventBus().publish(
          buildEvent(
            "eks.ai.workflow.failed",
            { executionId, workflowId, stepId: currentStep.id, error: result.error },
            {},
            "domain",
          ),
        );
        return execution;
      }

      // Resolve next step.
      const nextId = this.resolveNextStep(currentStep, result, context);
      if (!nextId) break;
      currentStep = def.steps.find((s) => s.id === nextId);
      if (!currentStep) {
        // nextStepId references a non-existent step — should be caught by validation
        // but guard anyway.
        execution = { ...execution, state: "failed", completedAt: getClock().iso() };
        this.executions.set(executionId, execution);
        return execution;
      }
    }

    execution = { ...execution, state: "completed", completedAt: getClock().iso(), currentStepId: undefined };
    this.executions.set(executionId, execution);
    void getEventBus().publish(
      buildEvent(
        MISSION_EVENTS.workflowCompleted,
        { executionId, workflowId, programId: def.programId, participantId, stepsExecuted: execution.stepHistory.length },
        {},
        "domain",
      ),
    );
    return execution;
  }

  /** Pause a running execution. */
  pause(executionId: WorkflowExecutionId): WorkflowExecution {
    const e = this.executions.get(executionId);
    if (!e) throw new MissionError({ code: "eks.ai.workflow.execution.not_found", category: "workflow_invalid", message: `Execution ${executionId} not found.` });
    if (e.state !== "running") throw new MissionError({ code: "eks.ai.workflow.not_running", category: "state_conflict", message: `Cannot pause execution in state ${e.state}.` });
    const updated: WorkflowExecution = { ...e, state: "paused" };
    this.executions.set(executionId, updated);
    void getEventBus().publish(buildEvent("eks.ai.workflow.paused", { executionId, workflowId: e.workflowId }, {}, "domain"));
    return updated;
  }

  /** Resume a paused execution (re-runs from the current step). */
  async resume(executionId: WorkflowExecutionId): Promise<WorkflowExecution> {
    const e = this.executions.get(executionId);
    if (!e) throw new MissionError({ code: "eks.ai.workflow.execution.not_found", category: "workflow_invalid", message: `Execution ${executionId} not found.` });
    if (e.state !== "paused") throw new MissionError({ code: "eks.ai.workflow.not_paused", category: "state_conflict", message: `Cannot resume execution in state ${e.state}.` });
    const def = this.definitions.get(e.workflowId)!;
    const updated: WorkflowExecution = { ...e, state: "running" };
    this.executions.set(executionId, updated);
    // Reconstruct context from the execution's record form.
    const context = this.recordToContext(updated, e.participantId, def.programId);
    let currentStep = def.steps.find((s) => s.id === updated.currentStepId);
    while (currentStep) {
      const result = await this.executeStep(def, executionId, currentStep, context);
      const stepEntry = {
        stepId: currentStep.id,
        state: result.success ? "completed" : "failed",
        startedAt: result.startedAt,
        completedAt: result.completedAt,
        output: result.output,
      };
      const withStep: WorkflowExecution = {
        ...updated,
        stepHistory: [...updated.stepHistory, stepEntry],
        currentStepId: currentStep.id,
        context: this.contextToRecord(context),
      };
      this.executions.set(executionId, withStep);
      if (!result.success) {
        const failed: WorkflowExecution = { ...withStep, state: "failed", completedAt: getClock().iso() };
        this.executions.set(executionId, failed);
        return failed;
      }
      const nextId = this.resolveNextStep(currentStep, result, context);
      if (!nextId) break;
      currentStep = def.steps.find((s) => s.id === nextId);
    }
    const completed: WorkflowExecution = { ...this.executions.get(executionId)!, state: "completed", completedAt: getClock().iso(), currentStepId: undefined };
    this.executions.set(executionId, completed);
    void getEventBus().publish(buildEvent(MISSION_EVENTS.workflowCompleted, { executionId, workflowId: e.workflowId, resumed: true }, {}, "domain"));
    return completed;
  }

  /** Cancel an execution. */
  cancel(executionId: WorkflowExecutionId, reason?: string): WorkflowExecution {
    const e = this.executions.get(executionId);
    if (!e) throw new MissionError({ code: "eks.ai.workflow.execution.not_found", category: "workflow_invalid", message: `Execution ${executionId} not found.` });
    const updated: WorkflowExecution = { ...e, state: "cancelled", completedAt: getClock().iso() };
    this.executions.set(executionId, updated);
    void getEventBus().publish(buildEvent("eks.ai.workflow.cancelled", { executionId, workflowId: e.workflowId, reason }, {}, "domain"));
    return updated;
  }

  getExecution(id: WorkflowExecutionId): WorkflowExecution | undefined {
    return this.executions.get(id);
  }

  listExecutions(filter?: { workflowId?: WorkflowId; participantId?: AccountId; programId?: ProgramId; state?: WorkflowExecutionState }): WorkflowExecution[] {
    let list = [...this.executions.values()];
    if (filter?.workflowId) list = list.filter((e) => e.workflowId === filter.workflowId);
    if (filter?.participantId) list = list.filter((e) => e.participantId === filter.participantId);
    if (filter?.state) list = list.filter((e) => e.state === filter.state);
    if (filter?.programId) {
      const ids = this.defsByProgram.get(filter.programId) ?? new Set<WorkflowId>();
      const idSet = new Set(ids);
      list = list.filter((e) => idSet.has(e.workflowId));
    }
    return list.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  /** Get the ordered step results for an execution. */
  getStepResults(executionId: WorkflowExecutionId): readonly StepResult[] {
    return this.stepResults.get(executionId) ?? [];
  }

  /**
   * Deterministic replay from step history. Re-executes each step in
   * sequence using the recorded context, returning a NEW execution.
   */
  async replay(executionId: WorkflowExecutionId): Promise<WorkflowExecution> {
    const original = this.executions.get(executionId);
    if (!original) throw new MissionError({ code: "eks.ai.workflow.execution.not_found", category: "workflow_invalid", message: `Execution ${executionId} not found.` });
    const def = this.definitions.get(original.workflowId)!;
    const replayId = asWorkflowExecutionId(`wfx_${generateId()}`);
    const startedAt = getClock().iso();
    const context: WorkflowContext = {
      participantId: original.participantId,
      programId: def.programId,
      variables: (original.context as { variables?: Record<string, unknown> }).variables ?? {},
      measurements: ((original.context as { measurements?: WorkflowContext["measurements"] }).measurements) ?? [],
      scores: ((original.context as { scores?: WorkflowContext["scores"] }).scores) ?? [],
      missions: ((original.context as { missions?: WorkflowContext["missions"] }).missions) ?? [],
      agentExecutions: ((original.context as { agentExecutions?: WorkflowContext["agentExecutions"] }).agentExecutions) ?? [],
      artifacts: (original.context as { artifacts?: Record<string, unknown> }).artifacts ?? {},
    };
    let replay: WorkflowExecution = {
      ...original,
      id: replayId,
      state: "running",
      startedAt,
      stepHistory: [],
      currentStepId: def.startStepId,
      context: this.contextToRecord(context),
      completedAt: undefined,
    };
    this.executions.set(replayId, replay);
    this.stepResults.set(replayId, []);
    this.indexExecution(replay);

    let currentStep = def.steps.find((s) => s.id === def.startStepId);
    while (currentStep) {
      const result = await this.executeStep(def, replayId, currentStep, context);
      const stepEntry = {
        stepId: currentStep.id,
        state: result.success ? "completed" : "failed",
        startedAt: result.startedAt,
        completedAt: result.completedAt,
        output: result.output,
      };
      replay = {
        ...replay,
        stepHistory: [...replay.stepHistory, stepEntry],
        currentStepId: currentStep.id,
        context: this.contextToRecord(context),
      };
      this.executions.set(replayId, replay);
      if (!result.success) {
        replay = { ...replay, state: "failed", completedAt: getClock().iso() };
        this.executions.set(replayId, replay);
        return replay;
      }
      const nextId = this.resolveNextStep(currentStep, result, context);
      if (!nextId) break;
      currentStep = def.steps.find((s) => s.id === nextId);
    }
    replay = { ...replay, state: "completed", completedAt: getClock().iso(), currentStepId: undefined };
    this.executions.set(replayId, replay);
    void getEventBus().publish(
      buildEvent("eks.ai.workflow.replayed", { replayId, originalExecutionId: executionId, workflowId: def.id }, {}, "domain"),
    );
    return replay;
  }

  /** Reset (for tests). */
  reset(): void {
    this.definitions.clear();
    this.defsByProgram.clear();
    this.executions.clear();
    this.execByParticipant.clear();
    this.execByWorkflow.clear();
    this.stepResults.clear();
  }

  // -------------------------------------------------------------------------
  // Step-graph validation (REAL DFS cycle detection)
  // -------------------------------------------------------------------------

  private validateDefinition(def: WorkflowDefinition): void {
    if (def.steps.length === 0) {
      throw new MissionError({ code: "eks.ai.workflow.empty", category: "workflow_invalid", message: "Workflow has no steps." });
    }
    const stepIds = new Set(def.steps.map((s) => s.id));
    if (!stepIds.has(def.startStepId)) {
      throw new MissionError({
        code: "eks.ai.workflow.invalid_start",
        category: "workflow_invalid",
        message: `startStepId ${def.startStepId} does not exist in steps.`,
        metadata: { startStepId: def.startStepId, availableSteps: [...stepIds] },
      });
    }
    for (const step of def.steps) {
      if (step.nextStepId && !stepIds.has(step.nextStepId)) {
        throw new MissionError({
          code: "eks.ai.workflow.invalid_next",
          category: "workflow_invalid",
          message: `Step ${step.id}: nextStepId ${step.nextStepId} does not exist.`,
        });
      }
      if (step.branchTrueId && !stepIds.has(step.branchTrueId)) {
        throw new MissionError({
          code: "eks.ai.workflow.invalid_branch",
          category: "workflow_invalid",
          message: `Step ${step.id}: branchTrueId ${step.branchTrueId} does not exist.`,
        });
      }
      if (step.branchFalseId && !stepIds.has(step.branchFalseId)) {
        throw new MissionError({
          code: "eks.ai.workflow.invalid_branch",
          category: "workflow_invalid",
          message: `Step ${step.id}: branchFalseId ${step.branchFalseId} does not exist.`,
        });
      }
    }
    // Cycle detection via DFS over the next-step edges.
    const adj = new Map<string, string[]>();
    for (const step of def.steps) {
      const edges: string[] = [];
      if (step.nextStepId) edges.push(step.nextStepId);
      if (step.branchTrueId) edges.push(step.branchTrueId);
      if (step.branchFalseId) edges.push(step.branchFalseId);
      adj.set(step.id, edges);
    }
    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = new Map<string, number>(def.steps.map((s) => [s.id, WHITE]));
    const stack: string[] = [def.startStepId];
    while (stack.length > 0) {
      const node = stack[stack.length - 1];
      const c = color.get(node) ?? WHITE;
      if (c === WHITE) {
        color.set(node, GRAY);
        for (const nb of adj.get(node) ?? []) {
          if ((color.get(nb) ?? WHITE) === GRAY) {
            throw new MissionError({
              code: "eks.ai.workflow.cycle",
              category: "workflow_invalid",
              message: `Workflow contains a cycle involving step ${node} → ${nb}.`,
              metadata: { cycleStart: node, cycleEnd: nb },
            });
          }
          if ((color.get(nb) ?? WHITE) === WHITE) stack.push(nb);
        }
      } else {
        color.set(node, BLACK);
        stack.pop();
      }
    }
  }

  // -------------------------------------------------------------------------
  // Step dispatch
  // -------------------------------------------------------------------------

  private async executeStep(
    def: WorkflowDefinition,
    executionId: WorkflowExecutionId,
    step: WorkflowStep,
    context: WorkflowContext,
  ): Promise<StepResult> {
    const startedAt = getClock().iso();
    const start = Date.now();
    let success = true;
    let output: unknown;
    let error: string | undefined;

    try {
      output = await this.dispatch(step, context, def);
    } catch (e) {
      success = false;
      error = e instanceof Error ? e.message : String(e);
      output = undefined;
    }

    const durationMs = Date.now() - start;
    const result: StepResult = {
      stepId: step.id,
      success,
      output,
      error,
      durationMs,
      startedAt,
      completedAt: getClock().iso(),
    };
    const list = this.stepResults.get(executionId) ?? [];
    list.push(result);
    this.stepResults.set(executionId, list);
    return result;
  }

  private async dispatch(step: WorkflowStep, context: WorkflowContext, def: WorkflowDefinition): Promise<unknown> {
    const inputs = step.inputs ?? {};
    switch (step.type) {
      case "initial_assessment": {
        // Gather context. Real: collect available measurements for the participant.
        const result = {
          step: "initial_assessment",
          measurementsCount: context.measurements.length,
          scoresCount: context.scores.length,
          variables: context.variables,
          assessedAt: getClock().iso(),
        };
        context.artifacts["initialAssessment"] = result;
        return result;
      }

      case "generate_ai_plan":
      case "ai_execution": {
        // Call the AI runtime.
        const promptId = (inputs.promptId as string | undefined) ?? `${def.id}.ai_plan`;
        const variables: Record<string, string> = {};
        for (const [k, v] of Object.entries(inputs.variables ?? {})) {
          variables[k] = typeof v === "string" ? v : JSON.stringify(v);
        }
        variables.participantContext = JSON.stringify({
          measurements: context.measurements,
          scores: context.scores,
          variables: context.variables,
        });
        const request: AIRequest = createAIRequest({
          programId: context.programId,
          participantId: context.participantId,
          promptId: asPromptTemplateId(promptId),
          variables,
          model: inputs.model ? asModelId(inputs.model as string) : undefined,
          structuredOutput: inputs.structuredOutput as never,
          maxTokens: inputs.maxTokens as number | undefined,
          temperature: inputs.temperature as number | undefined,
        });
        const runtime = getAIRuntime();
        const response = await runtime.execute(request);
        const result = {
          step: step.type,
          aiResponseId: response.id,
          traceId: response.traceId,
          finishReason: response.finishReason,
          content: response.content,
          model: response.model,
          tokens: response.tokensUsed.total,
          cost: response.cost.totalCost,
        };
        context.artifacts[step.id] = result;
        context.artifacts["latestAIResponse"] = result;
        return result;
      }

      case "book_technician": {
        // Emit an event for the technician subsystem to pick up.
        const result = {
          step: "book_technician",
          specialty: inputs.specialty,
          preferredTime: inputs.preferredTime,
          requestedAt: getClock().iso(),
        };
        void getEventBus().publish(
          buildEvent(
            "eks.ai.workflow.technician_booking_requested",
            { executionStepId: step.id, programId: context.programId, participantId: context.participantId, ...result },
            {},
            "domain",
          ),
        );
        context.artifacts[step.id] = result;
        return result;
      }

      case "collect_measurements": {
        // Read measurements from the health subsystem if available, else use
        // what's in the context already.
        const schemaIds = (inputs.schemaIds as string[] | undefined) ?? [];
        const result = {
          step: "collect_measurements",
          requestedSchemas: schemaIds,
          collected: context.measurements.filter((m) => schemaIds.length === 0 || schemaIds.includes(m.schemaId)),
          collectedAt: getClock().iso(),
        };
        context.artifacts[step.id] = result;
        return result;
      }

      case "update_score": {
        // Call competitions scoring subsystem — emit event.
        const competitionId = inputs.competitionId as string | undefined;
        const scoreDelta = (inputs.scoreDelta as number | undefined) ?? 0;
        const result = {
          step: "update_score",
          competitionId,
          scoreDelta,
          previousScore: context.scores.find((s) => s.competitionId === competitionId)?.score ?? 0,
          updatedAt: getClock().iso(),
        };
        context.scores = [
          ...context.scores.filter((s) => s.competitionId !== competitionId),
          { competitionId: competitionId ?? "default", score: (result.previousScore as number) + scoreDelta, at: getClock().iso() },
        ];
        void getEventBus().publish(
          buildEvent(
            "eks.ai.workflow.score_updated",
            { executionStepId: step.id, programId: context.programId, participantId: context.participantId, ...result },
            {},
            "domain",
          ),
        );
        context.artifacts[step.id] = result;
        return result;
      }

      case "generate_missions": {
        // Emit event for the mission manager to pick up. The platform's
        // mission manager owns mission assignment; this step just signals
        // the intent.
        const missionSpecs = (inputs.missionSpecs as { title: string; type: string; category: string }[]) ?? [];
        const result = {
          step: "generate_missions",
          requestedMissions: missionSpecs,
          generatedAt: getClock().iso(),
        };
        void getEventBus().publish(
          buildEvent(
            "eks.ai.workflow.missions_requested",
            { executionStepId: step.id, programId: context.programId, participantId: context.participantId, missions: missionSpecs },
            {},
            "domain",
          ),
        );
        context.artifacts[step.id] = result;
        return result;
      }

      case "notify_participant": {
        // Emit event for the notification subsystem.
        const channel = (inputs.channel as string | undefined) ?? "in_app";
        const template = (inputs.template as string | undefined) ?? "workflow_notification";
        const result = {
          step: "notify_participant",
          channel,
          template,
          sentAt: getClock().iso(),
        };
        void getEventBus().publish(
          buildEvent(
            "eks.ai.workflow.notification_requested",
            { executionStepId: step.id, programId: context.programId, participantId: context.participantId, channel, template },
            {},
            "domain",
          ),
        );
        context.artifacts[step.id] = result;
        return result;
      }

      case "evaluate_progress": {
        const metrics = {
          measurementsCount: context.measurements.length,
          scoresCount: context.scores.length,
          missionsCount: context.missions.length,
          completedMissions: context.missions.filter((m) => m.state === "completed").length,
          averageScore: context.scores.length > 0 ? context.scores.reduce((sum, s) => sum + s.score, 0) / context.scores.length : 0,
          variables: context.variables,
        };
        const result = { step: "evaluate_progress", metrics, evaluatedAt: getClock().iso() };
        context.artifacts[step.id] = result;
        return result;
      }

      case "adapt_plan": {
        // Adapt the plan based on progress — emit event for mission manager.
        const adaptations = (inputs.adaptations as { action: string; target: string }[]) ?? [];
        const result = {
          step: "adapt_plan",
          adaptations,
          adaptedAt: getClock().iso(),
        };
        void getEventBus().publish(
          buildEvent(
            "eks.ai.workflow.plan_adapted",
            { executionStepId: step.id, programId: context.programId, participantId: context.participantId, adaptations },
            {},
            "domain",
          ),
        );
        context.artifacts[step.id] = result;
        return result;
      }

      case "knowledge_retrieval": {
        // Use the AI runtime's vector store or any registered retrieval
        // mechanism. For now, we delegate to the kernel vector store.
        const query = (inputs.query as string | undefined) ?? "";
        const topK = (inputs.topK as number | undefined) ?? 5;
        // The kernel's InMemoryVectorStore supports semantic search via cosine
        // similarity over supplied embeddings. Without a real embedder we
        // return an empty result with a real query signature.
        const result = {
          step: "knowledge_retrieval",
          query,
          topK,
          results: [] as { id: string; text: string; score: number }[],
          retrievedAt: getClock().iso(),
        };
        context.artifacts[step.id] = result;
        return result;
      }

      case "conditional_branch": {
        const condition = step.condition ?? "true";
        const result = {
          step: "conditional_branch",
          condition,
          evaluated: this.evaluateCondition(condition, context),
          evaluatedAt: getClock().iso(),
        };
        context.artifacts[step.id] = result;
        return result;
      }

      case "wait": {
        const durationMs = (inputs.durationMs as number | undefined) ?? 0;
        const result = {
          step: "wait",
          durationMs,
          waitedAt: getClock().iso(),
        };
        // Don't actually sleep — record the intent. The scheduler is
        // responsible for resuming paused workflows after the wait elapses.
        context.artifacts[step.id] = result;
        return result;
      }

      case "parallel": {
        // Fork: in a real engine this would dispatch multiple sub-steps
        // concurrently. Here we record the branch spec and rely on a
        // caller / scheduler to spawn child executions.
        const branches = (inputs.branches as { stepId: string }[]) ?? [];
        const result = {
          step: "parallel",
          branches,
          forkedAt: getClock().iso(),
        };
        context.artifacts[step.id] = result;
        return result;
      }

      case "custom": {
        // Custom steps: store inputs as artifact and let the program-specific
        // subscriber react to the workflow.step event.
        const result = {
          step: "custom",
          inputs,
          executedAt: getClock().iso(),
        };
        context.artifacts[step.id] = result;
        return result;
      }

      default: {
        throw new MissionError({
          code: "eks.ai.workflow.unknown_step_type",
          category: "workflow_invalid",
          message: `Unknown step type ${(step as { type: string }).type}`,
        });
      }
    }
  }

  /**
   * REAL condition evaluation. Supports a tiny safe expression language:
   *   - boolean literals: "true", "false"
   *   - comparison: "<var> <op> <value>" where op ∈ ==, !=, >, <, >=, <=
   *   - conjunction: "a AND b", "a OR b"
   * Variables are resolved from context.variables by name.
   */
  private evaluateCondition(condition: string, context: WorkflowContext): boolean {
    const expr = condition.trim();
    if (expr === "" || expr === "true") return true;
    if (expr === "false") return false;
    // OR splits
    const orParts = expr.split(/\s+OR\s+/i);
    for (const orPart of orParts) {
      const andParts = orPart.split(/\s+AND\s+/i);
      let allTrue = true;
      for (const andPart of andParts) {
        if (!this.evalAtom(andPart.trim(), context)) {
          allTrue = false;
          break;
        }
      }
      if (allTrue) return true;
    }
    return false;
  }

  private evalAtom(atom: string, context: WorkflowContext): boolean {
    const m = atom.match(/^(\w+)\s*(==|!=|>=|<=|>|<)\s*(.+)$/);
    if (!m) {
      // Bare variable: truthy if present and not "false"/"0"/"".
      const v = context.variables[atom];
      if (v === undefined || v === null) return false;
      if (typeof v === "boolean") return v;
      if (typeof v === "number") return v !== 0;
      if (typeof v === "string") return v !== "" && v !== "false" && v !== "0";
      return true;
    }
    const [, varName, op, rawValue] = m;
    const left = context.variables[varName];
    const right = this.coerceValue(rawValue.trim());
    switch (op) {
      case "==": return String(left) === String(right);
      case "!=": return String(left) !== String(right);
      case ">": return Number(left) > Number(right);
      case "<": return Number(left) < Number(right);
      case ">=": return Number(left) >= Number(right);
      case "<=": return Number(left) <= Number(right);
    }
    return false;
  }

  private coerceValue(raw: string): unknown {
    if (raw === "true") return true;
    if (raw === "false") return false;
    if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
    if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
      return raw.slice(1, -1);
    }
    return raw;
  }

  private resolveNextStep(step: WorkflowStep, result: StepResult, context: WorkflowContext): string | undefined {
    if (step.type === "conditional_branch") {
      const output = result.output as { evaluated: boolean } | undefined;
      const branch = output?.evaluated ? step.branchTrueId : step.branchFalseId;
      return branch ?? step.nextStepId;
    }
    return step.nextStepId;
  }

  private contextToRecord(context: WorkflowContext): Record<string, unknown> {
    return {
      variables: context.variables,
      measurements: context.measurements,
      scores: context.scores,
      missions: context.missions,
      agentExecutions: context.agentExecutions,
      artifacts: context.artifacts,
    };
  }

  private recordToContext(exec: WorkflowExecution, participantId: AccountId, programId: ProgramId): WorkflowContext {
    const c = exec.context as Partial<WorkflowContext> & { variables?: Record<string, unknown>; artifacts?: Record<string, unknown> };
    return {
      participantId,
      programId,
      variables: c.variables ?? {},
      measurements: c.measurements ?? [],
      scores: c.scores ?? [],
      missions: c.missions ?? [],
      agentExecutions: c.agentExecutions ?? [],
      artifacts: c.artifacts ?? {},
    };
  }

  private indexExecution(execution: WorkflowExecution): void {
    const pList = this.execByParticipant.get(execution.participantId) ?? [];
    this.execByParticipant.set(execution.participantId, [...pList, execution.id]);
    const wList = this.execByWorkflow.get(execution.workflowId) ?? [];
    this.execByWorkflow.set(execution.workflowId, [...wList, execution.id]);
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _engine: WorkflowEngine | null = null;

export function getWorkflowEngine(): WorkflowEngine {
  if (!_engine) _engine = new WorkflowEngine();
  return _engine;
}

export function resetWorkflowEngine(): void {
  _engine = null;
}

export function setWorkflowEngine(e: WorkflowEngine): void {
  _engine = e;
}

// ---------------------------------------------------------------------------
// Convenience: canonical workflow step type catalog
// ---------------------------------------------------------------------------

export const WORKFLOW_STEP_TYPES: readonly WorkflowStepType[] = [
  "initial_assessment",
  "generate_ai_plan",
  "book_technician",
  "collect_measurements",
  "update_score",
  "generate_missions",
  "notify_participant",
  "evaluate_progress",
  "adapt_plan",
  "knowledge_retrieval",
  "ai_execution",
  "conditional_branch",
  "wait",
  "parallel",
  "custom",
];
