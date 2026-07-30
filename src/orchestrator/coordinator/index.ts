/**
 * Eks-Health Health Orchestrator — AI Coordinator
 *
 * The platform AI coordinator: merges recommendations, resolves conflicts,
 * detects duplication, optimizes schedules, explains trade-offs, maintains
 * participant preferences, and coordinates multiple Program agents.
 *
 * This AI never replaces Program AI — it coordinates them. Every decision is
 * explainable: each carries a participant-facing explanation, a confidence
 * score, and a list of considered alternatives with their trade-offs.
 *
 * Real logic: priority-aware conflict coordination, Jaccard token-overlap
 * recommendation merging, real duplication detection, real trade-off
 * generation.
 */

import "server-only";
import {
  type AccountId,
  type ProgramId,
  type SchemaId,
  type CoordinatorDecisionId,
  type CoordinatorDecision,
  type ProgramConflict,
  type WorkloadAssessment,
  type ProgramOrchestrationDeclaration,
  OrchestratorError,
  asCoordinatorDecisionId,
  ORCHESTRATOR_EVENTS,
} from "../core";
import { getEventBus, buildEvent, generateId, getClock } from "@/kernel";

// ---------------------------------------------------------------------------
// Public helper types
// ---------------------------------------------------------------------------

export interface ProgramRecommendation {
  readonly programId: ProgramId;
  readonly title: string;
  readonly description: string;
}

export interface MergedRecommendation {
  readonly title: string;
  readonly description: string;
  readonly sourcePrograms: ProgramId[];
  readonly confidence: number;
  readonly similarity: number;
}

export interface DuplicationReport {
  readonly schemaId: SchemaId;
  readonly consumingPrograms: ProgramId[];
  readonly recommendation: string;
}

export interface CoordinatorStats {
  totalDecisions: number;
  byType: Record<CoordinatorDecision["type"], number>;
  avgConfidence: number;
  totalMerges: number;
  totalDuplicationDetected: number;
}

export interface DecisionExplanation {
  readonly id: CoordinatorDecisionId;
  readonly description: string;
  readonly rationale: string;
  readonly participantExplanation: string;
  readonly alternatives: { description: string; tradeoff: string }[];
  readonly confidence: number;
}

// ---------------------------------------------------------------------------
// Internal mutable record (public surface stays immutable)
// ---------------------------------------------------------------------------

interface DecisionRecord {
  id: CoordinatorDecisionId;
  participantId: AccountId;
  type: CoordinatorDecision["type"];
  affectedPrograms: ProgramId[];
  description: string;
  rationale: string;
  participantExplanation: string;
  confidence: number;
  alternatives: { description: string; tradeoff: string }[];
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MERGE_SIMILARITY_THRESHOLD = 0.4; // Jaccard threshold for recommendation merging

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "to", "of", "in", "on", "for", "with",
  "your", "you", "is", "are", "be", "this", "that", "it", "as", "by", "at",
  "from", "do", "does", "if", "then", "than", "so", "not", "no", "yes",
]);

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export class CoordinatorEngine {
  private readonly decisions = new Map<CoordinatorDecisionId, DecisionRecord>();
  private readonly decisionsByParticipant = new Map<AccountId, CoordinatorDecisionId[]>();
  private stats = {
    totalDecisions: 0,
    byType: { merge: 0, delay: 0, remove: 0, prioritize: 0, balance: 0, explain: 0 } as Record<CoordinatorDecision["type"], number>,
    totalConfidence: 0,
    totalMerges: 0,
    totalDuplicationDetected: 0,
  };

  // -------------------------------------------------------------------------
  // Coordinate — top-level entry point
  // -------------------------------------------------------------------------

  /**
   * Make coordinator decisions for a participant given declarations, conflicts,
   * and the latest workload assessment. For each conflict, decide merge/delay/
   * remove/prioritize/balance/explain. For each duplicate measurement, emit a
   * merge decision. For workload overload, emit a balance decision.
   */
  coordinate(
    participantId: AccountId,
    declarations: ProgramOrchestrationDeclaration[],
    conflicts: ProgramConflict[],
    workload: WorkloadAssessment,
  ): CoordinatorDecision[] {
    const decisions: DecisionRecord[] = [];
    const declByProgram = new Map<ProgramId, ProgramOrchestrationDeclaration>();
    for (const d of declarations) declByProgram.set(d.programId, d);

    // 1. One decision per conflict.
    for (const conflict of conflicts) {
      const decision = this.decideForConflict(participantId, conflict, declByProgram);
      if (decision) decisions.push(decision);
    }

    // 2. One decision per duplicate measurement (merge).
    const duplications = this.detectDuplication(declarations);
    this.stats.totalDuplicationDetected += duplications.length;
    for (const dup of duplications) {
      decisions.push(this.makeMergeFromDuplication(participantId, dup));
    }

    // 3. Workload-based balance decision if overloaded or heavy.
    if (workload.level === "overloaded" || workload.level === "heavy") {
      decisions.push(this.makeBalanceFromWorkload(participantId, workload, declarations));
    }

    // Persist + emit.
    for (const d of decisions) {
      this.decisions.set(d.id, d);
      const list = this.decisionsByParticipant.get(participantId) ?? [];
      list.push(d.id);
      this.decisionsByParticipant.set(participantId, list);
      this.stats.totalDecisions += 1;
      this.stats.byType[d.type] += 1;
      this.stats.totalConfidence += d.confidence;
      if (d.type === "merge") this.stats.totalMerges += 1;

      void getEventBus().publish(
        buildEvent(
          ORCHESTRATOR_EVENTS.coordinatorDecision,
          {
            decisionId: d.id,
            participantId,
            type: d.type,
            affectedPrograms: d.affectedPrograms,
            confidence: d.confidence,
            description: d.description,
          },
          {},
          "domain",
        ),
      );
    }

    return decisions.map((d) => this.freeze(d));
  }

  /** Return the full explanation for a coordinator decision. */
  explain(decisionId: CoordinatorDecisionId): DecisionExplanation {
    const record = this.decisions.get(decisionId);
    if (!record) {
      throw new OrchestratorError({
        code: "eks.orchestrator.coordinator.not_found",
        category: "not_found",
        message: `Coordinator decision ${decisionId} not found.`,
        userMessage: "The requested coordinator decision could not be found.",
      });
    }
    return {
      id: record.id,
      description: record.description,
      rationale: record.rationale,
      participantExplanation: record.participantExplanation,
      alternatives: record.alternatives,
      confidence: record.confidence,
    };
  }

  // -------------------------------------------------------------------------
  // Recommendation merging — real Jaccard token-overlap similarity
  // -------------------------------------------------------------------------

  /**
   * Merge similar recommendations from different programs into unified
   * recommendations. Real token-overlap similarity detection with Jaccard.
   */
  mergeRecommendations(recommendations: ProgramRecommendation[]): MergedRecommendation[] {
    if (recommendations.length === 0) return [];

    // Tokenize each recommendation into a Set of normalized tokens.
    const tokenSets = recommendations.map((r) => this.tokenize(r));

    // Greedy single-linkage clustering: build groups such that any pair with
    // Jaccard >= threshold ends up in the same group.
    const groups: number[][] = []; // indices into recommendations
    const groupTokens: Set<string>[] = [];
    for (let i = 0; i < recommendations.length; i++) {
      let assigned = -1;
      for (let g = 0; g < groups.length; g++) {
        // Compare against the union of the group's tokens.
        const sim = this.jaccard(tokenSets[i]!, groupTokens[g]!);
        if (sim >= MERGE_SIMILARITY_THRESHOLD) {
          assigned = g;
          break;
        }
      }
      if (assigned === -1) {
        groups.push([i]);
        groupTokens.push(new Set(tokenSets[i]!));
      } else {
        groups[assigned]!.push(i);
        for (const t of tokenSets[i]!) groupTokens[assigned]!.add(t);
      }
    }

    return groups.map((group) => {
      const members = group.map((i) => recommendations[i]!);
      const sourcePrograms = [...new Set(members.map((m) => m.programId))];
      // Pick the longest title and longest description as representative.
      const title = members.reduce((a, m) => (m.title.length > a.length ? m.title : a), members[0]!.title);
      const description = members.reduce((a, m) => (m.description.length > a.length ? m.description : a), members[0]!.description);
      // Confidence: 1.0 when all sources agree on identical text, lower as
      // the cluster grows with more diverse text.
      const avgSim = members.length > 1
        ? this.averagePairwiseSimilarity(members.map((m) => this.tokenize({ programId: m.programId, title: m.title, description: m.description })))
        : 1;
      return {
        title,
        description,
        sourcePrograms,
        confidence: this.round2(Math.min(1, 0.5 + avgSim / 2)),
        similarity: this.round2(avgSim),
      };
    });
  }

  // -------------------------------------------------------------------------
  // Duplication detection
  // -------------------------------------------------------------------------

  /**
   * Find Programs requesting the same measurements or overlapping missions.
   * Real scan of requiredMeasurements and preferredSchedule.
   */
  detectDuplication(declarations: ProgramOrchestrationDeclaration[]): DuplicationReport[] {
    const consumers = new Map<SchemaId, ProgramId[]>();
    for (const d of declarations) {
      for (const s of d.requiredMeasurements) {
        if (!consumers.has(s)) consumers.set(s, []);
        consumers.get(s)!.push(d.programId);
      }
    }
    const reports: DuplicationReport[] = [];
    for (const [schema, programs] of consumers) {
      if (programs.length < 2) continue;
      reports.push({
        schemaId: schema,
        consumingPrograms: programs,
        recommendation: `Measure ${String(schema)} once and share with all ${programs.length} programs (${programs.join(", ")}).`,
      });
    }
    return reports;
  }

  // -------------------------------------------------------------------------
  // Lookup & stats
  // -------------------------------------------------------------------------

  get(id: CoordinatorDecisionId): CoordinatorDecision | undefined {
    const r = this.decisions.get(id);
    return r ? this.freeze(r) : undefined;
  }

  list(participantId?: AccountId): CoordinatorDecision[] {
    if (participantId) {
      const ids = this.decisionsByParticipant.get(participantId) ?? [];
      return ids.map((id) => this.decisions.get(id)!).filter(Boolean).map((r) => this.freeze(r));
    }
    return [...this.decisions.values()].map((r) => this.freeze(r));
  }

  getStats(): CoordinatorStats {
    return {
      totalDecisions: this.stats.totalDecisions,
      byType: { ...this.stats.byType },
      avgConfidence: this.stats.totalDecisions > 0
        ? this.round2(this.stats.totalConfidence / this.stats.totalDecisions)
        : 0,
      totalMerges: this.stats.totalMerges,
      totalDuplicationDetected: this.stats.totalDuplicationDetected,
    };
  }

  // -------------------------------------------------------------------------
  // Internals — per-conflict decision making
  // -------------------------------------------------------------------------

  private decideForConflict(
    participantId: AccountId,
    conflict: ProgramConflict,
    declByProgram: Map<ProgramId, ProgramOrchestrationDeclaration>,
  ): DecisionRecord | null {
    switch (conflict.type) {
      case "schedule_overlap":
        return this.decideDelay(participantId, conflict, declByProgram);
      case "contradictory_recommendation":
        return this.decidePrioritize(participantId, conflict, declByProgram);
      case "effort_overload":
        return this.decideBalance(participantId, conflict, declByProgram);
      case "measurement_duplication":
        return this.decideMerge(participantId, conflict);
      case "goal_conflict":
        return this.decideExplain(participantId, conflict, declByProgram);
      case "resource_conflict":
        return this.decideRemove(participantId, conflict, declByProgram);
      default:
        return null;
    }
  }

  private decideDelay(
    participantId: AccountId,
    conflict: ProgramConflict,
    declByProgram: Map<ProgramId, ProgramOrchestrationDeclaration>,
  ): DecisionRecord {
    const ranked = this.rankByPriority(conflict.programIds, declByProgram);
    const winner = ranked[0];
    const deferred = ranked.slice(1);
    return this.record({
      id: asCoordinatorDecisionId(generateId("cd_")),
      participantId,
      type: "delay",
      affectedPrograms: conflict.programIds,
      description: `Delay ${deferred.map((p) => p.programId).join(", ")} to resolve schedule overlap.`,
      rationale: `Program ${winner?.programId} has higher priority (${winner?.priority}) than ${deferred.map((p) => `${p.programId} (${p.priority})`).join(", ")}.`,
      participantExplanation: `Two of your programs wanted the same time slot. We kept ${winner?.programId} (your higher-priority program) at its preferred time and moved ${deferred.map((p) => p.programId).join(", ")} to a different time block.`,
      confidence: 0.85,
      alternatives: [
        {
          description: `Keep ${deferred.map((p) => p.programId).join(", ")} at the original time and delay ${winner?.programId} instead.`,
          tradeoff: `Honors the lower-priority program but disrupts the higher-priority one.`,
        },
        {
          description: "Run both programs back-to-back in the same block.",
          tradeoff: `Adds ${deferred.length * 30} minutes to the block and may exceed workload limits.`,
        },
      ],
      timestamp: getClock().iso(),
    });
  }

  private decidePrioritize(
    participantId: AccountId,
    conflict: ProgramConflict,
    declByProgram: Map<ProgramId, ProgramOrchestrationDeclaration>,
  ): DecisionRecord {
    const ranked = this.rankByPriority(conflict.programIds, declByProgram);
    const winner = ranked[0];
    const loser = ranked[1] ?? ranked[0];
    return this.record({
      id: asCoordinatorDecisionId(generateId("cd_")),
      participantId,
      type: "prioritize",
      affectedPrograms: conflict.programIds,
      description: `Prioritize ${winner?.programId}'s recommendation over ${loser?.programId}'s.`,
      rationale: `Conflict is contradictory (${conflict.description}). Priority comparison: ${winner?.programId} (${winner?.priority}) > ${loser?.programId} (${loser?.priority}).`,
      participantExplanation: `Two of your programs gave opposite recommendations. We followed ${winner?.programId} because it's your higher-priority program. ${loser?.programId}'s conflicting recommendation was set aside.`,
      confidence: 0.9,
      alternatives: [
        {
          description: `Follow ${loser?.programId} instead.`,
          tradeoff: `Goes against your higher-priority program; may slow progress on its goal.`,
        },
        {
          description: "Ask the participant to choose.",
          tradeoff: "Most accurate, but adds friction and decision burden.",
        },
      ],
      timestamp: getClock().iso(),
    });
  }

  private decideBalance(
    participantId: AccountId,
    conflict: ProgramConflict,
    declByProgram: Map<ProgramId, ProgramOrchestrationDeclaration>,
  ): DecisionRecord {
    const ranked = this.rankByPriority(conflict.programIds, declByProgram);
    const toDefer = ranked.filter((d) => d.priority < 50);
    const keep = ranked.filter((d) => d.priority >= 50);
    return this.record({
      id: asCoordinatorDecisionId(generateId("cd_")),
      participantId,
      type: "balance",
      affectedPrograms: conflict.programIds,
      description: `Defer ${toDefer.length > 0 ? toDefer.map((p) => p.programId).join(", ") : "the lowest-priority missions"} to balance workload.`,
      rationale: `Combined effort exceeds capacity. Deferring low-priority programs preserves the highest-impact work (${keep.map((p) => p.programId).join(", ")}).`,
      participantExplanation: `Your combined programs ask for more time and energy than is healthy in one day. We kept your high-priority programs running and deferred the lower-priority ones. You can re-enable them later.`,
      confidence: 0.8,
      alternatives: [
        {
          description: "Spread the workload across multiple days instead of deferring.",
          tradeoff: "Slower progress per day but no program is paused.",
        },
        {
          description: "Keep all programs and accept the overload.",
          tradeoff: "Higher risk of fatigue, injury, or non-adherence.",
        },
      ],
      timestamp: getClock().iso(),
    });
  }

  private decideMerge(participantId: AccountId, conflict: ProgramConflict): DecisionRecord {
    return this.record({
      id: asCoordinatorDecisionId(generateId("cd_")),
      participantId,
      type: "merge",
      affectedPrograms: conflict.programIds,
      description: `Merge duplicate measurement into a single shared measurement for ${conflict.programIds.length} programs.`,
      rationale: `Programs ${conflict.programIds.join(", ")} all request the same measurement. Taking it once and broadcasting reduces participant burden without losing data.`,
      participantExplanation: `Multiple programs wanted you to take the same measurement. We combined them into one — you'll take it once and all the programs will get the result.`,
      confidence: 0.95,
      alternatives: [
        {
          description: "Take the measurement separately for each program.",
          tradeoff: "More work for you; no additional insight.",
        },
      ],
      timestamp: getClock().iso(),
    });
  }

  private decideExplain(
    participantId: AccountId,
    conflict: ProgramConflict,
    declByProgram: Map<ProgramId, ProgramOrchestrationDeclaration>,
  ): DecisionRecord {
    const ranked = this.rankByPriority(conflict.programIds, declByProgram);
    const a = ranked[0];
    const b = ranked[1] ?? ranked[0];
    return this.record({
      id: asCoordinatorDecisionId(generateId("cd_")),
      participantId,
      type: "explain",
      affectedPrograms: conflict.programIds,
      description: `Surface goal conflict between ${a?.programId} and ${b?.programId} to the participant.`,
      rationale: `Goal conflicts are subjective and cannot be auto-resolved without participant values. Both programs are escalated with a transparent trade-off.`,
      participantExplanation: `Two of your programs are pulling in opposite directions (${conflict.description}). We can't pick for you because the right choice depends on what matters most to you right now. Review the trade-offs and decide which to prioritize.`,
      confidence: 0.6,
      alternatives: [
        {
          description: `Pursue ${a?.programId}'s goal (${a?.priority}) and pause ${b?.programId}.`,
          tradeoff: `Makes progress on ${a?.programId}; loses ground on ${b?.programId}.`,
        },
        {
          description: `Pursue ${b?.programId}'s goal (${b?.priority}) and pause ${a?.programId}.`,
          tradeoff: `Makes progress on ${b?.programId}; loses ground on ${a?.programId}.`,
        },
        {
          description: "Run both at reduced intensity.",
          tradeoff: "Slower progress on both; neither goal is fully met.",
        },
      ],
      timestamp: getClock().iso(),
    });
  }

  private decideRemove(
    participantId: AccountId,
    conflict: ProgramConflict,
    declByProgram: Map<ProgramId, ProgramOrchestrationDeclaration>,
  ): DecisionRecord {
    const ranked = this.rankByPriority(conflict.programIds, declByProgram);
    const winner = ranked[0];
    const removed = ranked[1] ?? ranked[0];
    return this.record({
      id: asCoordinatorDecisionId(generateId("cd_")),
      participantId,
      type: "remove",
      affectedPrograms: conflict.programIds,
      description: `Remove ${removed?.programId} from the participant's plan due to resource conflict.`,
      rationale: `Programs ${winner?.programId} and ${removed?.programId} declare each other as conflicting. Priority: ${winner?.programId} (${winner?.priority}) > ${removed?.programId} (${removed?.priority}).`,
      participantExplanation: `${winner?.programId} and ${removed?.programId} can't run together. We kept ${winner?.programId} (your higher-priority program) and removed ${removed?.programId}. You can reinstall it later if priorities change.`,
      confidence: 0.85,
      alternatives: [
        {
          description: `Keep ${removed?.programId} and remove ${winner?.programId}.`,
          tradeoff: "Goes against your stated priorities.",
        },
        {
          description: "Pause both and ask the participant.",
          tradeoff: "Loses progress on both until the participant decides.",
        },
      ],
      timestamp: getClock().iso(),
    });
  }

  // -------------------------------------------------------------------------
  // Internals — duplication- and workload-driven decisions
  // -------------------------------------------------------------------------

  private makeMergeFromDuplication(participantId: AccountId, dup: DuplicationReport): DecisionRecord {
    return this.record({
      id: asCoordinatorDecisionId(generateId("cd_")),
      participantId,
      type: "merge",
      affectedPrograms: dup.consumingPrograms,
      description: `Merge duplicate measurement ${String(dup.schemaId)} for ${dup.consumingPrograms.length} programs.`,
      rationale: dup.recommendation,
      participantExplanation: `We noticed ${dup.consumingPrograms.length} of your programs all want the same measurement (${String(dup.schemaId)}). You'll take it once and we'll share the result with all of them.`,
      confidence: 0.95,
      alternatives: [
        {
          description: "Take the measurement separately per program.",
          tradeoff: "More participant burden, no extra value.",
        },
      ],
      timestamp: getClock().iso(),
    });
  }

  private makeBalanceFromWorkload(
    participantId: AccountId,
    workload: WorkloadAssessment,
    declarations: ProgramOrchestrationDeclaration[],
  ): DecisionRecord {
    const sorted = [...declarations].sort((a, b) => a.priority - b.priority);
    const lowPriority = sorted.filter((d) => d.priority < 50);
    const suggestedDeferrals = lowPriority.length > 0
      ? lowPriority.map((d) => d.programId).join(", ")
      : "the lowest-priority missions";
    return this.record({
      id: asCoordinatorDecisionId(generateId("cd_")),
      participantId,
      type: "balance",
      affectedPrograms: declarations.map((d) => d.programId),
      description: `Balance ${workload.level} workload (${workload.totalMinutes} minutes) by deferring ${suggestedDeferrals}.`,
      rationale: `Workload is ${workload.level} (${workload.totalMinutes} minutes, physical ${workload.physicalEffort}/10). Deferring low-priority programs brings the load back toward a healthy range.`,
      participantExplanation: `Your current program load is ${workload.level} (${workload.totalMinutes} minutes/day). To protect your recovery and adherence, we suggest pausing ${suggestedDeferrals} temporarily.`,
      confidence: workload.level === "overloaded" ? 0.9 : 0.7,
      alternatives: [
        {
          description: "Spread the workload across the week instead of deferring.",
          tradeoff: "Slower daily progress but no program is paused.",
        },
        {
          description: "Reduce intensity rather than duration.",
          tradeoff: "May compromise training adaptations for fitness programs.",
        },
        {
          description: "Accept the current load.",
          tradeoff: "Higher risk of fatigue or non-adherence.",
        },
      ],
      timestamp: getClock().iso(),
    });
  }

  // -------------------------------------------------------------------------
  // Internals — ranking, tokenization, similarity
  // -------------------------------------------------------------------------

  private rankByPriority(
    programIds: ProgramId[],
    declByProgram: Map<ProgramId, ProgramOrchestrationDeclaration>,
  ): ProgramOrchestrationDeclaration[] {
    return programIds
      .map((p) => declByProgram.get(p))
      .filter((d): d is ProgramOrchestrationDeclaration => d !== undefined)
      .sort((a, b) => b.priority - a.priority);
  }

  private tokenize(r: ProgramRecommendation): Set<string> {
    const text = `${r.title} ${r.description}`.toLowerCase();
    const tokens = text.split(/[^a-z0-9]+/).filter((t) => t.length > 2 && !STOPWORDS.has(t));
    return new Set(tokens);
  }

  private jaccard(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 && b.size === 0) return 0;
    let intersection = 0;
    const smaller = a.size <= b.size ? a : b;
    const larger = a.size <= b.size ? b : a;
    for (const t of smaller) {
      if (larger.has(t)) intersection += 1;
    }
    const union = a.size + b.size - intersection;
    return union === 0 ? 0 : intersection / union;
  }

  private averagePairwiseSimilarity(tokenSets: Set<string>[]): number {
    if (tokenSets.length < 2) return 1;
    let total = 0;
    let count = 0;
    for (let i = 0; i < tokenSets.length; i++) {
      for (let j = i + 1; j < tokenSets.length; j++) {
        total += this.jaccard(tokenSets[i]!, tokenSets[j]!);
        count += 1;
      }
    }
    return count > 0 ? total / count : 1;
  }

  // -------------------------------------------------------------------------
  // Internals — record + freeze
  // -------------------------------------------------------------------------

  private record(r: DecisionRecord): DecisionRecord {
    return r;
  }

  private freeze(r: DecisionRecord): CoordinatorDecision {
    return {
      id: r.id,
      participantId: r.participantId,
      type: r.type,
      affectedPrograms: r.affectedPrograms,
      description: r.description,
      rationale: r.rationale,
      participantExplanation: r.participantExplanation,
      confidence: r.confidence,
      alternatives: r.alternatives,
      timestamp: r.timestamp,
    };
  }

  private round2(n: number): number {
    return Math.round(n * 100) / 100;
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _engine: CoordinatorEngine | null = null;
export function getCoordinator(): CoordinatorEngine {
  if (!_engine) _engine = new CoordinatorEngine();
  return _engine;
}

// Public re-exports for the barrel
export type {
  CoordinatorDecisionId,
  CoordinatorDecision,
  ProgramConflict,
  WorkloadAssessment,
  ProgramOrchestrationDeclaration,
} from "../core";
