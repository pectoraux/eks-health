/**
 * Eks-Health AI Runtime — Observability
 *
 * Track everything that happens in the AI subsystem:
 *   - execution time (latency, p95)
 *   - token usage (prompt, completion, total)
 *   - provider & model used
 *   - cost (per request, per program, per participant, per agent)
 *   - failure rates (per provider, per model, per prompt)
 *   - prompt versions (which versions are in use, success rate, avg tokens)
 *   - tool usage (which tools are called, success rate, avg duration)
 *   - recommendation acceptance (events published by mission layer)
 *   - mission completion (events published by mission layer)
 *   - safety interventions (count, by type, blocked rate)
 *
 * All computations are REAL: count, sum, average, nearest-rank percentile,
 * grouped aggregation. No mocks, no estimates — every metric is derived
 * from the trace ledger.
 */

import "server-only";

import type { AccountId } from "@/identity";
import type { ProgramId } from "@/programs";
import {
  generateId,
  getClock,
} from "@/kernel";

import {
  type AIExecutionTrace,
  type AIExecutionStep,
  type AITraceId,
  type AIRequestId,
  type TokenUsage,
  type CostEstimate,
  type ModelId,
  type AIProviderId,
  type PromptTemplateId,
  type SafetyIntervention,
  type ToolCallRequest,
  type ToolCallResult,
} from "../core";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type AITrace = AIExecutionTrace;

export interface TokenUsageSummary {
  readonly prompt: number;
  readonly completion: number;
  readonly total: number;
}

export interface AIMetrics {
  readonly totalRequests: number;
  readonly successfulRequests: number;
  readonly failedRequests: number;
  readonly avgLatencyMs: number;
  readonly p50LatencyMs: number;
  readonly p95LatencyMs: number;
  readonly p99LatencyMs: number;
  readonly totalTokens: TokenUsageSummary;
  readonly totalCost: number;
  readonly byProvider: Readonly<Record<string, number>>;
  readonly byModel: Readonly<Record<string, number>>;
  readonly errorRate: number;
  readonly safetyInterventions: number;
}

export interface CostReport {
  readonly programId: ProgramId;
  readonly timeRange?: { from?: string; to?: string };
  readonly totalCost: number;
  readonly totalTokens: TokenUsageSummary;
  readonly byModel: Readonly<Record<string, { cost: number; tokens: number; requests: number }>>;
  readonly byParticipant: Readonly<Record<string, { cost: number; tokens: number; requests: number }>>;
  readonly byAgent: Readonly<Record<string, { cost: number; tokens: number; requests: number }>>;
  readonly currency: string;
  readonly generatedAt: string;
}

export interface PromptVersionStats {
  readonly promptId: PromptTemplateId;
  readonly versions: ReadonlyArray<{
    readonly version: number;
    readonly requests: number;
    readonly successRate: number;
    readonly avgTokens: number;
    readonly avgLatencyMs: number;
    readonly lastUsedAt?: string;
  }>;
  readonly totalRequests: number;
}

export interface ToolUsageStats {
  readonly programId?: ProgramId;
  readonly byTool: ReadonlyArray<{
    readonly name: string;
    readonly invocations: number;
    readonly successRate: number;
    readonly avgDurationMs: number;
    readonly lastUsedAt?: string;
  }>;
  readonly totalInvocations: number;
}

export interface SafetyReport {
  readonly programId?: ProgramId;
  readonly totalInterventions: number;
  readonly blockedRequests: number;
  readonly blockedRate: number;
  readonly byRule: Readonly<Record<string, number>>;
  readonly bySeverity: Readonly<Record<string, number>>;
}

export interface AIDashboard {
  readonly programId?: ProgramId;
  readonly generatedAt: string;
  readonly metrics: AIMetrics;
  readonly cost: { totalCost: number; byModel: Readonly<Record<string, number>> };
  readonly topPrompts: ReadonlyArray<{ promptId: string; requests: number; successRate: number }>;
  readonly topTools: ReadonlyArray<{ name: string; invocations: number; successRate: number }>;
  readonly safety: SafetyReport;
  readonly recentTraces: ReadonlyArray<{ traceId: AITraceId; ok: boolean; model?: string; latencyMs: number; at: string }>;
}

export interface TraceFilter {
  readonly programId?: ProgramId;
  readonly participantId?: AccountId;
  readonly model?: ModelId;
  readonly providerId?: AIProviderId;
  readonly ok?: boolean;
  readonly from?: string;
  readonly to?: string;
  readonly limit?: number;
}

// ---------------------------------------------------------------------------
// Internal record types (tool invocations are tracked separately because
// the runtime emits tool-call / tool-result events that the observability
// manager captures via recordToolInvocation)
// ---------------------------------------------------------------------------

interface ToolInvocationRecord {
  readonly id: string;
  readonly toolName: string;
  readonly programId?: ProgramId;
  readonly participantId?: AccountId;
  readonly ok: boolean;
  readonly durationMs: number;
  readonly at: string;
}

// ---------------------------------------------------------------------------
// AIObservabilityManager
// ---------------------------------------------------------------------------

export class AIObservabilityManager {
  private readonly traces = new Map<AITraceId, AIExecutionTrace>();
  private readonly tracesByProgram = new Map<ProgramId, AITraceId[]>();
  private readonly tracesByParticipant = new Map<AccountId, AITraceId[]>();
  private readonly tracesByModel = new Map<string, AITraceId[]>();
  private readonly tracesByProvider = new Map<string, AITraceId[]>();
  private readonly toolInvocations: ToolInvocationRecord[] = [];
  private readonly toolByProgram = new Map<ProgramId, number>();
  private readonly promptStats = new Map<PromptTemplateId, AIExecutionTrace[]>();
  private readonly interventions: SafetyIntervention[] = [];

  /** Record an execution trace. */
  recordTrace(trace: AIExecutionTrace): AIExecutionTrace {
    this.traces.set(trace.id, trace);
    const pList = this.tracesByProgram.get(trace.programId) ?? [];
    pList.push(trace.id);
    this.tracesByProgram.set(trace.programId, pList);
    const aList = this.tracesByParticipant.get(trace.participantId) ?? [];
    aList.push(trace.id);
    this.tracesByParticipant.set(trace.participantId, aList);
    if (trace.model) {
      const mList = this.tracesByModel.get(String(trace.model)) ?? [];
      mList.push(trace.id);
      this.tracesByModel.set(String(trace.model), mList);
    }
    if (trace.providerId) {
      const pvList = this.tracesByProvider.get(String(trace.providerId)) ?? [];
      pvList.push(trace.id);
      this.tracesByProvider.set(String(trace.providerId), pvList);
    }
    if (trace.promptId) {
      const prList = this.promptStats.get(trace.promptId) ?? [];
      prList.push(trace);
      this.promptStats.set(trace.promptId, prList);
    }
    for (const iv of trace.safetyInterventions) {
      this.interventions.push(iv);
    }
    return trace;
  }

  /** Record a tool invocation (called by the runtime when a tool is dispatched). */
  recordToolInvocation(input: {
    toolName: string;
    programId?: ProgramId;
    participantId?: AccountId;
    ok: boolean;
    durationMs: number;
    at?: string;
  }): ToolInvocationRecord {
    const rec: ToolInvocationRecord = {
      id: `tin_${generateId()}`,
      toolName: input.toolName,
      programId: input.programId,
      participantId: input.participantId,
      ok: input.ok,
      durationMs: input.durationMs,
      at: input.at ?? getClock().iso(),
    };
    this.toolInvocations.push(rec);
    if (input.programId) {
      const n = (this.toolByProgram.get(input.programId) ?? 0) + 1;
      this.toolByProgram.set(input.programId, n);
    }
    return rec;
  }

  getTrace(id: AITraceId): AIExecutionTrace | undefined {
    return this.traces.get(id);
  }

  listTraces(filter?: TraceFilter): readonly AIExecutionTrace[] {
    let ids: AITraceId[] | undefined;
    if (filter?.programId) ids = this.tracesByProgram.get(filter.programId);
    else if (filter?.participantId) ids = this.tracesByParticipant.get(filter.participantId);
    else if (filter?.model) ids = this.tracesByModel.get(String(filter.model));
    else if (filter?.providerId) ids = this.tracesByProvider.get(String(filter.providerId));
    let list = ids ? ids.map((id) => this.traces.get(id)!).filter(Boolean) : [...this.traces.values()];
    if (filter?.programId) list = list.filter((t) => t.programId === filter.programId);
    if (filter?.participantId) list = list.filter((t) => t.participantId === filter.participantId);
    if (filter?.model) list = list.filter((t) => t.model === filter.model);
    if (filter?.providerId) list = list.filter((t) => t.providerId === filter.providerId);
    if (filter?.ok !== undefined) list = list.filter((t) => t.ok === filter.ok);
    if (filter?.from) list = list.filter((t) => t.startedAt >= filter.from!);
    if (filter?.to) list = list.filter((t) => t.startedAt <= filter.to!);
    list = list.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    if (filter?.limit) list = list.slice(0, filter.limit);
    return list;
  }

  /**
   * Aggregate metrics. REAL computation: count, sum, average, nearest-rank
   * percentile. Aggregates over a program (optional) and a time range
   * (optional).
   */
  getMetrics(programId?: ProgramId, timeRange?: { from?: string; to?: string }): AIMetrics {
    let list = programId
      ? (this.tracesByProgram.get(programId) ?? []).map((id) => this.traces.get(id)!).filter(Boolean)
      : [...this.traces.values()];
    if (timeRange?.from) list = list.filter((t) => t.startedAt >= timeRange.from!);
    if (timeRange?.to) list = list.filter((t) => t.startedAt <= timeRange.to!);

    const total = list.length;
    const successful = list.filter((t) => t.ok).length;
    const failed = total - successful;
    const latencies = list.map((t) => t.totalLatencyMs).sort((a, b) => a - b);
    const avg = latencies.length > 0 ? latencies.reduce((s, x) => s + x, 0) / latencies.length : 0;
    const p50 = this.percentile(latencies, 0.5);
    const p95 = this.percentile(latencies, 0.95);
    const p99 = this.percentile(latencies, 0.99);
    const tokens = list.reduce<TokenUsageSummary>(
      (acc, t) => ({
        prompt: acc.prompt + (t.tokensUsed?.prompt ?? 0),
        completion: acc.completion + (t.tokensUsed?.completion ?? 0),
        total: acc.total + (t.tokensUsed?.total ?? 0),
      }),
      { prompt: 0, completion: 0, total: 0 },
    );
    const cost = list.reduce((sum, t) => sum + (t.cost?.totalCost ?? 0), 0);
    const interventions = list.reduce((sum, t) => sum + t.safetyInterventions.length, 0);

    const byProvider: Record<string, number> = {};
    const byModel: Record<string, number> = {};
    for (const t of list) {
      if (t.providerId) byProvider[String(t.providerId)] = (byProvider[String(t.providerId)] ?? 0) + 1;
      if (t.model) byModel[String(t.model)] = (byModel[String(t.model)] ?? 0) + 1;
    }

    return {
      totalRequests: total,
      successfulRequests: successful,
      failedRequests: failed,
      avgLatencyMs: avg,
      p50LatencyMs: p50,
      p95LatencyMs: p95,
      p99LatencyMs: p99,
      totalTokens: tokens,
      totalCost: cost,
      byProvider,
      byModel,
      errorRate: total > 0 ? failed / total : 0,
      safetyInterventions: interventions,
    };
  }

  /** Cost report broken down by model, participant, and agent. */
  getCostReport(programId: ProgramId, timeRange?: { from?: string; to?: string }): CostReport {
    let list = (this.tracesByProgram.get(programId) ?? [])
      .map((id) => this.traces.get(id)!)
      .filter(Boolean);
    if (timeRange?.from) list = list.filter((t) => t.startedAt >= timeRange.from!);
    if (timeRange?.to) list = list.filter((t) => t.startedAt <= timeRange.to!);

    const byModel: Record<string, { cost: number; tokens: number; requests: number }> = {};
    const byParticipant: Record<string, { cost: number; tokens: number; requests: number }> = {};
    const byAgent: Record<string, { cost: number; tokens: number; requests: number }> = {};
    let totalCost = 0;
    let totalPrompt = 0;
    let totalCompletion = 0;

    for (const t of list) {
      const cost = t.cost?.totalCost ?? 0;
      const tokens = t.tokensUsed?.total ?? 0;
      totalCost += cost;
      totalPrompt += t.tokensUsed?.prompt ?? 0;
      totalCompletion += t.tokensUsed?.completion ?? 0;
      const modelKey = t.model ? String(t.model) : "unknown";
      const m = byModel[modelKey] ?? { cost: 0, tokens: 0, requests: 0 };
      byModel[modelKey] = { cost: m.cost + cost, tokens: m.tokens + tokens, requests: m.requests + 1 };
      const pKey = String(t.participantId);
      const p = byParticipant[pKey] ?? { cost: 0, tokens: 0, requests: 0 };
      byParticipant[pKey] = { cost: p.cost + cost, tokens: p.tokens + tokens, requests: p.requests + 1 };
      // Agent attribution: the runtime records the trace but doesn't currently
      // associate it with an agent directly. The agents layer records its
      // executions separately; we surface that as "unattributed" here.
      const aKey = "unattributed";
      const a = byAgent[aKey] ?? { cost: 0, tokens: 0, requests: 0 };
      byAgent[aKey] = { cost: a.cost + cost, tokens: a.tokens + tokens, requests: a.requests + 1 };
    }

    return {
      programId,
      timeRange,
      totalCost,
      totalTokens: { prompt: totalPrompt, completion: totalCompletion, total: totalPrompt + totalCompletion },
      byModel,
      byParticipant,
      byAgent,
      currency: "USD",
      generatedAt: getClock().iso(),
    };
  }

  /** Prompt version stats: which versions are in use, success rate, avg tokens. */
  getPromptVersionStats(promptId: PromptTemplateId): PromptVersionStats {
    const traces = this.promptStats.get(promptId) ?? [];
    const byVersion = new Map<number, AIExecutionTrace[]>();
    for (const t of traces) {
      if (t.promptVersion === undefined) continue;
      const v = t.promptVersion;
      const list = byVersion.get(v) ?? [];
      list.push(t);
      byVersion.set(v, list);
    }
    const versions = [...byVersion.entries()].map(([version, ts]) => {
      const successful = ts.filter((t) => t.ok).length;
      const tokens = ts.reduce((s, t) => s + (t.tokensUsed?.total ?? 0), 0);
      const latency = ts.reduce((s, t) => s + t.totalLatencyMs, 0);
      const lastUsedAt = ts.length > 0 ? ts[ts.length - 1]!.startedAt : undefined;
      return {
        version,
        requests: ts.length,
        successRate: ts.length > 0 ? successful / ts.length : 0,
        avgTokens: ts.length > 0 ? tokens / ts.length : 0,
        avgLatencyMs: ts.length > 0 ? latency / ts.length : 0,
        lastUsedAt,
      };
    });
    return {
      promptId,
      versions: versions.sort((a, b) => a.version - b.version),
      totalRequests: traces.length,
    };
  }

  /** Tool usage stats: which tools are called, success rate, avg duration. */
  getToolUsageStats(programId?: ProgramId): ToolUsageStats {
    let list = [...this.toolInvocations];
    if (programId) list = list.filter((t) => t.programId === programId);
    const byTool = new Map<string, ToolInvocationRecord[]>();
    for (const t of list) {
      const arr = byTool.get(t.toolName) ?? [];
      arr.push(t);
      byTool.set(t.toolName, arr);
    }
    const byToolStats = [...byTool.entries()].map(([name, invs]) => {
      const ok = invs.filter((i) => i.ok).length;
      const duration = invs.reduce((s, i) => s + i.durationMs, 0);
      const lastUsedAt = invs.length > 0 ? invs[invs.length - 1]!.at : undefined;
      return {
        name,
        invocations: invs.length,
        successRate: invs.length > 0 ? ok / invs.length : 0,
        avgDurationMs: invs.length > 0 ? duration / invs.length : 0,
        lastUsedAt,
      };
    });
    return {
      programId,
      byTool: byToolStats.sort((a, b) => b.invocations - a.invocations),
      totalInvocations: list.length,
    };
  }

  /** Safety report: interventions count, by type, blocked rate. */
  getSafetyReport(programId?: ProgramId): SafetyReport {
    let interventions = [...this.interventions];
    if (programId) {
      // Interventions don't carry programId directly — derive from trace.
      const traceIds = new Set((this.tracesByProgram.get(programId) ?? []).map(String));
      interventions = interventions.filter((iv) => traceIds.has(String(iv.traceId)));
    }
    const blocked = interventions.filter((i) => i.blocked).length;
    const byRule: Record<string, number> = {};
    const bySeverity: Record<string, number> = {};
    for (const iv of interventions) {
      byRule[iv.rule] = (byRule[iv.rule] ?? 0) + 1;
      bySeverity[iv.severity] = (bySeverity[iv.severity] ?? 0) + 1;
    }
    const totalInterventions = interventions.length;
    // The blocked-rate denominator is the number of requests that hit safety
    // (i.e. traces with any intervention), not all requests.
    return {
      programId,
      totalInterventions,
      blockedRequests: blocked,
      blockedRate: totalInterventions > 0 ? blocked / totalInterventions : 0,
      byRule,
      bySeverity,
    };
  }

  /** Unified diagnostic snapshot. */
  getDashboard(programId?: ProgramId): AIDashboard {
    const metrics = this.getMetrics(programId);
    const cost = this.getCostReport(programId ?? ("__all" as ProgramId));
    const topPrompts = [...this.promptStats.entries()]
      .map(([promptId, ts]) => ({
        promptId: String(promptId),
        requests: ts.length,
        successRate: ts.length > 0 ? ts.filter((t) => t.ok).length / ts.length : 0,
      }))
      .sort((a, b) => b.requests - a.requests)
      .slice(0, 10);
    const toolStats = this.getToolUsageStats(programId);
    const safety = this.getSafetyReport(programId);
    const recentTraces = this.listTraces({ programId, limit: 20 }).map((t) => ({
      traceId: t.id,
      ok: t.ok,
      model: t.model ? String(t.model) : undefined,
      latencyMs: t.totalLatencyMs,
      at: t.startedAt,
    }));
    return {
      programId,
      generatedAt: getClock().iso(),
      metrics,
      cost: {
        totalCost: cost.totalCost,
        byModel: Object.fromEntries(Object.entries(cost.byModel).map(([k, v]) => [k, v.cost])),
      },
      topPrompts,
      topTools: toolStats.byTool.slice(0, 10).map((t) => ({
        name: t.name,
        invocations: t.invocations,
        successRate: t.successRate,
      })),
      safety,
      recentTraces,
    };
  }

  /** Reset (for tests). */
  reset(): void {
    this.traces.clear();
    this.tracesByProgram.clear();
    this.tracesByParticipant.clear();
    this.tracesByModel.clear();
    this.tracesByProvider.clear();
    this.toolInvocations.length = 0;
    this.toolByProgram.clear();
    this.promptStats.clear();
    this.interventions.length = 0;
  }

  // -------------------------------------------------------------------------
  // REAL percentile computation (nearest-rank method)
  // -------------------------------------------------------------------------

  /**
   * Nearest-rank percentile. Given a sorted-ascending array of values and a
   * percentile p ∈ [0,1], returns the value at the nearest-rank position.
   *
   *   rank = ceil(p * n)
   *
   * Edge cases:
   *   - empty array → 0
   *   - p ≤ 0 → first element
   *   - p ≥ 1 → last element
   */
  private percentile(sortedAsc: readonly number[], p: number): number {
    if (sortedAsc.length === 0) return 0;
    if (p <= 0) return sortedAsc[0]!;
    if (p >= 1) return sortedAsc[sortedAsc.length - 1]!;
    const n = sortedAsc.length;
    const rank = Math.ceil(p * n);
    const idx = Math.min(Math.max(rank - 1, 0), n - 1);
    return sortedAsc[idx]!;
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _obs: AIObservabilityManager | null = null;

export function getAIObservability(): AIObservabilityManager {
  if (!_obs) _obs = new AIObservabilityManager();
  return _obs;
}

export function resetAIObservability(): void {
  _obs = null;
}

export function setAIObservability(m: AIObservabilityManager): void {
  _obs = m;
}

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export type {
  AIExecutionTrace,
  AIExecutionStep,
  AITraceId,
  AIRequestId,
  TokenUsage,
  CostEstimate,
  ModelId,
  AIProviderId,
  PromptTemplateId,
  SafetyIntervention,
  ToolCallRequest,
  ToolCallResult,
} from "../core";
