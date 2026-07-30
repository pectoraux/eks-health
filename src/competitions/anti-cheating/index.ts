/**
 * Eks-Health Competition Platform — Anti-Cheating Framework
 *
 * Infrastructure for fair competition: score validation, measurement
 * validation, duplicate detection, rapid improvement detection, collusion
 * detection, abnormal ranking changes, statistical outliers, manual review,
 * automatic flags, and appeals.
 *
 * Seven pre-registered detectors run real analysis on a context provided by
 * the caller (typically the scoring engine before it commits a score):
 *  1. score_validation      — re-compute & range-check the score.
 *  2. measurement_validation— verify the underlying measurement is verified.
 *  3. duplicate_detection   — same measurement in multiple competitions.
 *  4. rapid_improvement     — |Δ|/|prior| > 50% in one step.
 *  5. collusion_suspected   — 3+ participants with identical scores or
 *                              shared measurement IDs.
 *  6. abnormal_ranking_change — rank delta > 10 positions.
 *  7. statistical_outlier   — |z-score| > 3 among all participants (Welford's).
 *
 * Flag lifecycle: open → investigating → confirmed | false_positive → resolved.
 * Appeals: pending → approved | denied.
 */

import "server-only";
import {
  type AntiCheatFlagId,
  type AntiCheatFlagType,
  type AntiCheatFlagSeverity,
  type AntiCheatFlagStatus,
  type CompetitionId,
  type SeasonId,
  type AccountId,
  type ScoreId,
  type MeasurementId,
  CompetitionError,
  asAntiCheatFlagId,
} from "../core";
import { getEventBus, buildEvent, generateId, getClock } from "@/kernel";
import { COMPETITION_EVENTS } from "../core";

// ---------------------------------------------------------------------------
// Signals & context
// ---------------------------------------------------------------------------

export interface AntiCheatSignal {
  readonly type: AntiCheatFlagType;
  readonly value: number;
  readonly threshold: number;
  readonly detail: string;
}

export interface AntiCheatAnalysisContext {
  readonly competitionId: CompetitionId;
  readonly seasonId: SeasonId;
  readonly participantId: AccountId;
  readonly scoreId?: ScoreId;
  readonly measurementId?: MeasurementId;
  readonly score?: number;
  readonly previousScore?: number;
  readonly scoreHistory?: { score: number; at: string }[];
  readonly allScores?: { participantId: AccountId; score: number }[];
  readonly measurementVerified?: boolean;
  readonly measurementCompetitions?: CompetitionId[];
  readonly peerScores?: { participantId: AccountId; score: number; measurementIds?: MeasurementId[] }[];
  readonly rankChange?: number;
  readonly recomputedScore?: number;
  readonly scoreFloor?: number;
  readonly scoreCap?: number;
}

export interface AntiCheatDetector {
  readonly id: string;
  readonly type: AntiCheatFlagType;
  check(ctx: AntiCheatAnalysisContext): Promise<AntiCheatSignal | null> | AntiCheatSignal | null;
}

export interface AntiCheatAnalysisResult {
  readonly participantId: AccountId;
  readonly analyzedAt: string;
  readonly signals: AntiCheatSignal[];
  readonly shouldFlag: boolean;
  readonly suggestedSeverity: AntiCheatFlagSeverity;
  readonly suggestedType: AntiCheatFlagType;
}

// ---------------------------------------------------------------------------
// Flags & appeals
// ---------------------------------------------------------------------------

export interface AntiCheatFlag {
  readonly id: AntiCheatFlagId;
  readonly type: AntiCheatFlagType;
  readonly severity: AntiCheatFlagSeverity;
  readonly status: AntiCheatFlagStatus;
  readonly competitionId: CompetitionId;
  readonly seasonId: SeasonId;
  readonly participantId?: AccountId;
  readonly scoreId?: ScoreId;
  readonly measurementId?: MeasurementId;
  readonly description: string;
  readonly detectedAt: string;
  readonly signals: AntiCheatSignal[];
  readonly resolvedAt?: string;
  readonly resolvedBy?: string;
  readonly resolution?: string;
  readonly appealId?: string;
}

export interface AntiCheatAppeal {
  readonly id: string;
  readonly flagId: AntiCheatFlagId;
  readonly appealedBy: AccountId;
  readonly reason: string;
  readonly submittedAt: string;
  readonly status: "pending" | "approved" | "denied";
  readonly reviewedBy?: string;
  readonly reviewedAt?: string;
  readonly decision?: string;
}

export interface AntiCheatStats {
  readonly total: number;
  readonly byType: Record<string, number>;
  readonly bySeverity: Record<string, number>;
  readonly byStatus: Record<string, number>;
  readonly confirmationRate: number;
  readonly falsePositiveRate: number;
}

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

export const ANTI_CHEAT_THRESHOLDS = {
  RAPID_IMPROVEMENT_PCT: 0.5, // >50% change in one step
  COLLUSION_MIN_IDENTICAL: 3, // 3+ participants with identical score
  COLLUSION_MIN_SHARED_MEASUREMENT: 2, // 2+ participants sharing a measurement
  RANK_CHANGE_POSITIONS: 10, // >10 rank positions in one update
  STATISTICAL_OUTLIER_Z: 3, // |z| > 3
  SCORE_MIN: 0,
  SCORE_MAX: 100,
} as const;

// ---------------------------------------------------------------------------
// Flag state machine
// ---------------------------------------------------------------------------

const FLAG_TRANSITIONS: Record<AntiCheatFlagStatus, AntiCheatFlagStatus[]> = {
  open: ["investigating", "confirmed", "false_positive", "resolved"],
  investigating: ["confirmed", "false_positive", "resolved"],
  confirmed: ["resolved"],
  false_positive: ["resolved"],
  resolved: [],
};

function canTransitionFlag(from: AntiCheatFlagStatus, to: AntiCheatFlagStatus): boolean {
  return (FLAG_TRANSITIONS[from] ?? []).includes(to);
}

// ---------------------------------------------------------------------------
// Built-in detectors
// ---------------------------------------------------------------------------

/** 1. Score validation — range check + recomputed-score comparison. */
function makeScoreValidationDetector(): AntiCheatDetector {
  return {
    id: "score_validation_default",
    type: "score_validation",
    check(ctx) {
      if (ctx.score === undefined || !Number.isFinite(ctx.score)) {
        return {
          type: "score_validation",
          value: ctx.score ?? NaN,
          threshold: 0,
          detail: `Score is ${ctx.score === undefined ? "missing" : "not finite"}`,
        };
      }
      const lo = ctx.scoreFloor ?? ANTI_CHEAT_THRESHOLDS.SCORE_MIN;
      const hi = ctx.scoreCap ?? ANTI_CHEAT_THRESHOLDS.SCORE_MAX;
      if (ctx.score < lo || ctx.score > hi) {
        return {
          type: "score_validation",
          value: ctx.score,
          threshold: lo,
          detail: `Score ${ctx.score} is outside valid range [${lo}, ${hi}]`,
        };
      }
      if (ctx.recomputedScore !== undefined && Number.isFinite(ctx.recomputedScore)) {
        const diff = Math.abs(ctx.score - ctx.recomputedScore);
        if (diff > 0.01) {
          return {
            type: "score_validation",
            value: ctx.score,
            threshold: ctx.recomputedScore,
            detail: `Score ${ctx.score} does not match recomputed ${ctx.recomputedScore} (Δ=${diff.toFixed(4)})`,
          };
        }
      }
      return null;
    },
  };
}

/** 2. Measurement validation — checks if the underlying measurement is verified. */
function makeMeasurementValidationDetector(): AntiCheatDetector {
  return {
    id: "measurement_validation_default",
    type: "measurement_validation",
    check(ctx) {
      if (ctx.measurementId && ctx.measurementVerified === false) {
        return {
          type: "measurement_validation",
          value: 0,
          threshold: 1,
          detail: `Measurement ${ctx.measurementId} is not verified`,
        };
      }
      return null;
    },
  };
}

/** 3. Duplicate detection — same measurement in multiple competitions. */
function makeDuplicateDetectionDetector(): AntiCheatDetector {
  return {
    id: "duplicate_detection_default",
    type: "duplicate_detection",
    check(ctx) {
      const comps = ctx.measurementCompetitions ?? [];
      if (ctx.measurementId && comps.length > 1) {
        return {
          type: "duplicate_detection",
          value: comps.length,
          threshold: 1,
          detail: `Measurement ${ctx.measurementId} appears in ${comps.length} competitions: ${comps.slice(0, 5).join(", ")}`,
        };
      }
      return null;
    },
  };
}

/** 4. Rapid improvement — |Δ|/|prior| > 50% in one step. Fetches history via
 *     getScoring() (guarded) if not provided in the context. */
function makeRapidImprovementDetector(): AntiCheatDetector {
  return {
    id: "rapid_improvement_default",
    type: "rapid_improvement",
    async check(ctx) {
      let history = ctx.scoreHistory ?? [];
      if (history.length === 0 && ctx.competitionId && ctx.seasonId) {
        try {
          const path = "../scoring";
          const mod: { getScoring?: () => unknown } = (await import(path)) as { getScoring?: () => unknown };
          const mgr = mod?.getScoring?.() as {
            getScoreHistory?: (p: AccountId, c: CompetitionId, s: SeasonId) => { score: number; at: string }[] | Promise<{ score: number; at: string }[]>;
          } | undefined;
          if (mgr?.getScoreHistory) {
            const fetched = await mgr.getScoreHistory(ctx.participantId, ctx.competitionId, ctx.seasonId);
            if (Array.isArray(fetched)) history = fetched;
          }
        } catch {
          /* scoring module unavailable — degrade gracefully */
        }
      }
      const prev = ctx.previousScore ?? (history.length >= 2 ? history[history.length - 2].score : undefined);
      const curr = ctx.score ?? (history.length >= 1 ? history[history.length - 1].score : undefined);
      if (prev === undefined || curr === undefined || !Number.isFinite(prev) || !Number.isFinite(curr)) {
        return null;
      }
      if (prev === 0) {
        // Can't compute a ratio against zero; flag only if curr is large.
        if (Math.abs(curr) > 50) {
          return {
            type: "rapid_improvement",
            value: curr,
            threshold: ANTI_CHEAT_THRESHOLDS.RAPID_IMPROVEMENT_PCT,
            detail: `Score jumped from 0 to ${curr} (impossible improvement)`,
          };
        }
        return null;
      }
      const changePct = Math.abs(curr - prev) / Math.abs(prev);
      if (changePct > ANTI_CHEAT_THRESHOLDS.RAPID_IMPROVEMENT_PCT) {
        return {
          type: "rapid_improvement",
          value: changePct,
          threshold: ANTI_CHEAT_THRESHOLDS.RAPID_IMPROVEMENT_PCT,
          detail: `Score changed ${(changePct * 100).toFixed(1)}% (${prev} → ${curr}) in one step`,
        };
      }
      return null;
    },
  };
}

/** 5. Collusion suspected — 3+ participants with identical scores, or 2+
 *     participants sharing a measurement ID. Real pattern matching. */
function makeCollusionSuspectedDetector(): AntiCheatDetector {
  return {
    id: "collusion_suspected_default",
    type: "collusion_suspected",
    check(ctx) {
      const peers = ctx.peerScores ?? [];
      if (peers.length < ANTI_CHEAT_THRESHOLDS.COLLUSION_MIN_IDENTICAL) return null;
      // Group by exact score.
      const byScore = new Map<number, AccountId[]>();
      for (const p of peers) {
        const list = byScore.get(p.score) ?? [];
        list.push(p.participantId);
        byScore.set(p.score, list);
      }
      for (const [score, ids] of byScore) {
        if (ids.length >= ANTI_CHEAT_THRESHOLDS.COLLUSION_MIN_IDENTICAL) {
          return {
            type: "collusion_suspected",
            value: ids.length,
            threshold: ANTI_CHEAT_THRESHOLDS.COLLUSION_MIN_IDENTICAL,
            detail: `${ids.length} participants have identical score ${score}: ${ids.slice(0, 5).join(", ")}`,
          };
        }
      }
      // Check measurement-ID overlap (shared evidence).
      const peersWithMeasurements = peers.filter((p) => p.measurementIds && p.measurementIds.length > 0);
      if (peersWithMeasurements.length >= 2) {
        const measurementOwners = new Map<string, Set<string>>();
        for (const p of peersWithMeasurements) {
          for (const m of p.measurementIds ?? []) {
            const set = measurementOwners.get(m) ?? new Set<string>();
            set.add(p.participantId);
            measurementOwners.set(m, set);
          }
        }
        for (const [mid, owners] of measurementOwners) {
          if (owners.size >= ANTI_CHEAT_THRESHOLDS.COLLUSION_MIN_SHARED_MEASUREMENT) {
            return {
              type: "collusion_suspected",
              value: owners.size,
              threshold: ANTI_CHEAT_THRESHOLDS.COLLUSION_MIN_SHARED_MEASUREMENT,
              detail: `Measurement ${mid} shared by ${owners.size} participants`,
            };
          }
        }
      }
      return null;
    },
  };
}

/** 6. Abnormal ranking change — |rank delta| > 10 positions. */
function makeAbnormalRankingChangeDetector(): AntiCheatDetector {
  return {
    id: "abnormal_ranking_change_default",
    type: "abnormal_ranking_change",
    check(ctx) {
      if (ctx.rankChange === undefined || !Number.isFinite(ctx.rankChange)) return null;
      if (Math.abs(ctx.rankChange) > ANTI_CHEAT_THRESHOLDS.RANK_CHANGE_POSITIONS) {
        return {
          type: "abnormal_ranking_change",
          value: ctx.rankChange,
          threshold: ANTI_CHEAT_THRESHOLDS.RANK_CHANGE_POSITIONS,
          detail: `Rank changed by ${ctx.rankChange} positions`,
        };
      }
      return null;
    },
  };
}

/** 7. Statistical outlier — |z-score| > 3 among all participants (Welford's). */
function makeStatisticalOutlierDetector(): AntiCheatDetector {
  return {
    id: "statistical_outlier_default",
    type: "statistical_outlier",
    check(ctx) {
      const all = ctx.allScores ?? [];
      if (all.length < 5 || ctx.score === undefined || !Number.isFinite(ctx.score)) return null;
      // Welford's online algorithm for mean & variance.
      let n = 0;
      let mean = 0;
      let M2 = 0;
      for (const s of all) {
        if (!Number.isFinite(s.score)) continue;
        n++;
        const delta = s.score - mean;
        mean += delta / n;
        const delta2 = s.score - mean;
        M2 += delta * delta2;
      }
      if (n < 5) return null;
      const variance = n > 1 ? M2 / (n - 1) : 0;
      const stddev = Math.sqrt(variance);
      if (stddev === 0) return null;
      const z = (ctx.score - mean) / stddev;
      if (Math.abs(z) > ANTI_CHEAT_THRESHOLDS.STATISTICAL_OUTLIER_Z) {
        return {
          type: "statistical_outlier",
          value: z,
          threshold: ANTI_CHEAT_THRESHOLDS.STATISTICAL_OUTLIER_Z,
          detail: `Score ${ctx.score} is a statistical outlier (z=${z.toFixed(2)}, mean=${mean.toFixed(2)}, stddev=${stddev.toFixed(2)}, n=${n})`,
        };
      }
      return null;
    },
  };
}

// ---------------------------------------------------------------------------
// Severity inference
// ---------------------------------------------------------------------------

function inferSeverity(signals: AntiCheatSignal[]): AntiCheatFlagSeverity {
  if (signals.length === 0) return "low";
  const types = new Set(signals.map((s) => s.type));
  if (signals.length >= 3) return "critical";
  if (signals.length >= 2) return "high";
  if (types.has("collusion_suspected") || types.has("duplicate_detection")) return "high";
  if (types.has("rapid_improvement") || types.has("statistical_outlier")) return "medium";
  return "low";
}

// ---------------------------------------------------------------------------
// Anti-cheat engine
// ---------------------------------------------------------------------------

export class AntiCheatEngine {
  private readonly detectors = new Map<string, AntiCheatDetector>();
  private readonly flags = new Map<AntiCheatFlagId, AntiCheatFlag>();
  private readonly appeals = new Map<string, AntiCheatAppeal>();
  private readonly flagsByCompetition = new Map<CompetitionId, AntiCheatFlagId[]>();
  private readonly flagsByParticipant = new Map<AccountId, AntiCheatFlagId[]>();

  constructor() {
    // Pre-register the seven built-in detectors.
    this.registerDetector(makeScoreValidationDetector());
    this.registerDetector(makeMeasurementValidationDetector());
    this.registerDetector(makeDuplicateDetectionDetector());
    this.registerDetector(makeRapidImprovementDetector());
    this.registerDetector(makeCollusionSuspectedDetector());
    this.registerDetector(makeAbnormalRankingChangeDetector());
    this.registerDetector(makeStatisticalOutlierDetector());
  }

  registerDetector(detector: AntiCheatDetector): void {
    if (this.detectors.has(detector.id)) {
      throw new CompetitionError({
        code: "eks.competition.anticheat.duplicate_detector",
        category: "state_conflict",
        message: `Detector '${detector.id}' is already registered.`,
      });
    }
    this.detectors.set(detector.id, detector);
  }

  listDetectors(): readonly AntiCheatDetector[] {
    return [...this.detectors.values()];
  }

  /**
   * Run all detectors against a context. Real analysis:
   *  - score_validation re-checks the range and (if provided) the recomputed score.
   *  - measurement_validation checks the verified flag.
   *  - duplicate_detection checks measurementCompetitions.
   *  - rapid_improvement computes |Δ|/|prior| (fetches history if needed).
   *  - collusion_suspected groups peer scores & checks measurement overlap.
   *  - abnormal_ranking_change checks |rankChange|.
   *  - statistical_outlier computes a z-score via Welford's algorithm.
   */
  async analyze(input: { ctx: AntiCheatAnalysisContext }): Promise<AntiCheatAnalysisResult> {
    const ctx = input.ctx;
    const signals: AntiCheatSignal[] = [];
    for (const detector of this.detectors.values()) {
      try {
        const signal = await detector.check(ctx);
        if (signal) signals.push(signal);
      } catch {
        // A detector that throws is treated as producing no signal.
      }
    }
    const shouldFlag = signals.length > 0;
    const suggestedSeverity = inferSeverity(signals);
    const suggestedType: AntiCheatFlagType = signals[0]?.type ?? "manual_review";
    return {
      participantId: ctx.participantId,
      analyzedAt: getClock().iso(),
      signals,
      shouldFlag,
      suggestedSeverity,
      suggestedType,
    };
  }

  createFlag(input: {
    readonly type: AntiCheatFlagType;
    readonly severity: AntiCheatFlagSeverity;
    readonly competitionId: CompetitionId;
    readonly seasonId: SeasonId;
    readonly participantId?: AccountId;
    readonly scoreId?: ScoreId;
    readonly measurementId?: MeasurementId;
    readonly description: string;
    readonly signals?: AntiCheatSignal[];
  }): AntiCheatFlag {
    const flag: AntiCheatFlag = {
      id: asAntiCheatFlagId(generateId("acf_")),
      type: input.type,
      severity: input.severity,
      status: "open",
      competitionId: input.competitionId,
      seasonId: input.seasonId,
      participantId: input.participantId,
      scoreId: input.scoreId,
      measurementId: input.measurementId,
      description: input.description,
      detectedAt: getClock().iso(),
      signals: input.signals ?? [],
    };
    this.flags.set(flag.id, flag);
    const cl = this.flagsByCompetition.get(input.competitionId) ?? [];
    this.flagsByCompetition.set(input.competitionId, [...cl, flag.id]);
    if (input.participantId) {
      const pl = this.flagsByParticipant.get(input.participantId) ?? [];
      this.flagsByParticipant.set(input.participantId, [...pl, flag.id]);
    }
    void getEventBus().publish(
      buildEvent(
        COMPETITION_EVENTS.antiCheatFlagCreated,
        { flagId: flag.id, type: flag.type, severity: flag.severity, competitionId: flag.competitionId, seasonId: flag.seasonId, participantId: flag.participantId, scoreId: flag.scoreId, measurementId: flag.measurementId },
        {},
        "domain",
      ),
    );
    return flag;
  }

  getFlag(id: AntiCheatFlagId): AntiCheatFlag | undefined {
    return this.flags.get(id);
  }

  listFlags(filter?: {
    readonly status?: AntiCheatFlagStatus;
    readonly severity?: AntiCheatFlagSeverity;
    readonly type?: AntiCheatFlagType;
    readonly competitionId?: CompetitionId;
    readonly participantId?: AccountId;
  }): readonly AntiCheatFlag[] {
    let list = [...this.flags.values()];
    if (filter?.status) list = list.filter((f) => f.status === filter.status);
    if (filter?.severity) list = list.filter((f) => f.severity === filter.severity);
    if (filter?.type) list = list.filter((f) => f.type === filter.type);
    if (filter?.competitionId) list = list.filter((f) => f.competitionId === filter.competitionId);
    if (filter?.participantId) list = list.filter((f) => f.participantId === filter.participantId);
    return list;
  }

  private transitionFlag(id: AntiCheatFlagId, to: AntiCheatFlagStatus, by?: string, resolution?: string): AntiCheatFlag {
    const flag = this.flags.get(id);
    if (!flag) {
      throw new CompetitionError({
        code: "eks.competition.anticheat.flag.not_found",
        category: "not_found",
        message: `Anti-cheat flag ${id} not found.`,
      });
    }
    if (!canTransitionFlag(flag.status, to)) {
      throw new CompetitionError({
        code: "eks.competition.anticheat.flag.invalid_transition",
        category: "state_conflict",
        message: `Cannot transition flag from '${flag.status}' to '${to}'.`,
        userMessage: "This flag cannot be updated in its current state.",
        metadata: { flagId: id, from: flag.status, to },
      });
    }
    const now = getClock().iso();
    const updated: AntiCheatFlag = {
      ...flag,
      status: to,
      resolvedAt: to === "resolved" ? now : flag.resolvedAt,
      resolvedBy: to === "resolved" ? by : flag.resolvedBy,
      resolution: to === "resolved" ? (resolution ?? flag.resolution) : flag.resolution,
    };
    this.flags.set(id, updated);
    return updated;
  }

  investigate(id: AntiCheatFlagId): AntiCheatFlag {
    return this.transitionFlag(id, "investigating");
  }

  confirm(id: AntiCheatFlagId, by: string): AntiCheatFlag {
    return this.transitionFlag(id, "confirmed", by);
  }

  markFalsePositive(id: AntiCheatFlagId, by: string): AntiCheatFlag {
    return this.transitionFlag(id, "false_positive", by);
  }

  resolve(id: AntiCheatFlagId, resolution: string, by: string): AntiCheatFlag {
    return this.transitionFlag(id, "resolved", by, resolution);
  }

  /** Create an appeal for a flag. */
  appeal(flagId: AntiCheatFlagId, input: { appealedBy: AccountId; reason: string }): AntiCheatAppeal {
    const flag = this.flags.get(flagId);
    if (!flag) {
      throw new CompetitionError({
        code: "eks.competition.anticheat.flag.not_found",
        category: "not_found",
        message: `Anti-cheat flag ${flagId} not found.`,
      });
    }
    const appeal: AntiCheatAppeal = {
      id: generateId("appeal_"),
      flagId,
      appealedBy: input.appealedBy,
      reason: input.reason,
      submittedAt: getClock().iso(),
      status: "pending",
    };
    this.appeals.set(appeal.id, appeal);
    // Link the appeal to the flag.
    this.flags.set(flagId, { ...flag, appealId: appeal.id });
    return appeal;
  }

  getAppeal(appealId: string): AntiCheatAppeal | undefined {
    return this.appeals.get(appealId);
  }

  listAppeals(flagId?: AntiCheatFlagId): readonly AntiCheatAppeal[] {
    let list = [...this.appeals.values()];
    if (flagId) list = list.filter((a) => a.flagId === flagId);
    return list;
  }

  reviewAppeal(appealId: string, decision: "approved" | "denied", by: string): AntiCheatAppeal {
    const appeal = this.appeals.get(appealId);
    if (!appeal) {
      throw new CompetitionError({
        code: "eks.competition.anticheat.appeal.not_found",
        category: "not_found",
        message: `Appeal ${appealId} not found.`,
      });
    }
    if (appeal.status !== "pending") {
      throw new CompetitionError({
        code: "eks.competition.anticheat.appeal.invalid_state",
        category: "state_conflict",
        message: `Appeal ${appealId} has already been reviewed (status: ${appeal.status}).`,
      });
    }
    const now = getClock().iso();
    const updated: AntiCheatAppeal = {
      ...appeal,
      status: decision,
      reviewedBy: by,
      reviewedAt: now,
      decision: decision === "approved" ? "Appeal approved; flag will be resolved as false positive." : "Appeal denied; flag stands.",
    };
    this.appeals.set(appealId, updated);
    // If approved, auto-resolve the flag as a false positive.
    if (decision === "approved") {
      const flag = this.flags.get(appeal.flagId);
      if (flag && flag.status !== "resolved" && flag.status !== "false_positive") {
        this.transitionFlag(appeal.flagId, "false_positive", by, "Appeal approved");
      }
    }
    return updated;
  }

  getStats(competitionId?: CompetitionId): AntiCheatStats {
    let flags = [...this.flags.values()];
    if (competitionId) flags = flags.filter((f) => f.competitionId === competitionId);
    const byType: Record<string, number> = {};
    const bySeverity: Record<string, number> = {};
    const byStatus: Record<string, number> = {};
    for (const f of flags) {
      byType[f.type] = (byType[f.type] ?? 0) + 1;
      bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
      byStatus[f.status] = (byStatus[f.status] ?? 0) + 1;
    }
    const resolved = flags.filter((f) => f.status === "confirmed" || f.status === "false_positive" || f.status === "resolved");
    const confirmed = flags.filter((f) => f.status === "confirmed" || f.status === "resolved").length;
    const falsePositive = flags.filter((f) => f.status === "false_positive").length;
    const confirmationRate = resolved.length > 0 ? confirmed / resolved.length : 0;
    const falsePositiveRate = resolved.length > 0 ? falsePositive / resolved.length : 0;
    return { total: flags.length, byType, bySeverity, byStatus, confirmationRate, falsePositiveRate };
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _engine: AntiCheatEngine | null = null;
export function getAntiCheat(): AntiCheatEngine {
  if (!_engine) _engine = new AntiCheatEngine();
  return _engine;
}

export function resetAntiCheat(): void {
  _engine = null;
}
