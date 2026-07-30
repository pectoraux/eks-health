/**
 * Eks-Health Research Platform — Evidence Engine
 *
 * Programs automatically accumulate evidence over time. The engine gathers
 * REAL signals from across the platform — measurements (count, improvement
 * trends), missions (completion rate), competitions (participation),
 * technician sessions (verification quality) — and computes an
 * EvidenceAccumulation with a confidence score (0-100) and an evidence
 * level (preliminary → emerging → established → strong).
 *
 * Programs grow stronger as evidence grows. All cross-subsystem calls are
 * guarded with try/catch so a missing subsystem degrades gracefully.
 */

import "server-only";
import {
  type EvidenceAccumulationId,
  type EvidenceAccumulation,
  type ProgramId,
  ResearchError,
  asEvidenceAccumulationId,
} from "../core";
import { getPrivacy } from "../privacy";
import { getEventBus, buildEvent, generateId, getClock } from "@/kernel";
import { RESEARCH_EVENTS } from "../core";

// ---------------------------------------------------------------------------
// Defensive loaders
// ---------------------------------------------------------------------------

interface HealthProfileLike {
  readonly id: string;
  readonly accountId: string;
  readonly programs: { programId: string; status: "active" | "paused" | "uninstalled"; installedAt: string }[];
}

interface MeasurementLike {
  readonly id: string;
  readonly profileId: string;
  readonly schemaId: string;
  readonly value: number | { value?: number };
  readonly verificationState: string;
  readonly provenance: { collectedAt: string };
  readonly supersededBy?: string;
}

interface MeasurementsApi {
  list(filter?: { profileId?: string; includeSuperseded?: boolean }): MeasurementLike[];
  getTrend(profileId: string, schemaId: string, from: string, to: string): {
    values: { timestamp: string; value: number }[];
    changePercent: number;
    count: number;
  };
}

interface MissionsApi {
  list(filter?: { programId?: string; state?: string }): {
    state: string;
    programId: string;
    participantId: string;
    result?: { outcome: string };
  }[];
}

interface CompetitionsApi {
  list(filter?: { programId?: string }): { programId: string; currentParticipants: number; state: string }[];
}

interface SessionsApi {
  list(filter?: { programId?: string }): { programId: string; status: string }[];
}

let _profilesCache: { list(): HealthProfileLike[] } | null | undefined;
async function loadProfiles(): Promise<{ list(): HealthProfileLike[] } | null> {
  if (_profilesCache !== undefined) return _profilesCache;
  try {
    const mod = await import("@/health");
    const getter = (mod as { getProfiles?: () => { list(): HealthProfileLike[] } }).getProfiles;
    _profilesCache = getter ? getter() : null;
  } catch {
    _profilesCache = null;
  }
  return _profilesCache;
}

let _measurementsCache: MeasurementsApi | null | undefined;
async function loadMeasurements(): Promise<MeasurementsApi | null> {
  if (_measurementsCache !== undefined) return _measurementsCache;
  try {
    const mod = await import("@/health");
    const getter = (mod as { getMeasurements?: () => MeasurementsApi }).getMeasurements;
    _measurementsCache = getter ? getter() : null;
  } catch {
    _measurementsCache = null;
  }
  return _measurementsCache;
}

let _missionsCache: MissionsApi | null | undefined;
async function loadMissions(): Promise<MissionsApi | null> {
  if (_missionsCache !== undefined) return _missionsCache;
  try {
    const mod = await import("@/missions");
    const getter = (mod as { getMissions?: () => MissionsApi }).getMissions;
    _missionsCache = getter ? getter() : null;
  } catch {
    _missionsCache = null;
  }
  return _missionsCache;
}

let _competitionsCache: CompetitionsApi | null | undefined;
async function loadCompetitions(): Promise<CompetitionsApi | null> {
  if (_competitionsCache !== undefined) return _competitionsCache;
  try {
    const mod = await import("@/competitions");
    const getter = (mod as { getCompetitions?: () => CompetitionsApi }).getCompetitions;
    _competitionsCache = getter ? getter() : null;
  } catch {
    _competitionsCache = null;
  }
  return _competitionsCache;
}

let _sessionsCache: SessionsApi | null | undefined;
async function loadSessions(): Promise<SessionsApi | null> {
  if (_sessionsCache !== undefined) return _sessionsCache;
  try {
    const mod = await import("@/technicians");
    const getter = (mod as { getSessions?: () => SessionsApi }).getSessions;
    _sessionsCache = getter ? getter() : null;
  } catch {
    _sessionsCache = null;
  }
  return _sessionsCache;
}

// ---------------------------------------------------------------------------
// Evidence level helpers
// ---------------------------------------------------------------------------

export type EvidenceLevel = "preliminary" | "emerging" | "established" | "strong";

export function computeEvidenceLevel(confidence: number): EvidenceLevel {
  if (confidence < 30) return "preliminary";
  if (confidence < 50) return "emerging";
  if (confidence < 75) return "established";
  return "strong";
}

// ---------------------------------------------------------------------------
// Comparison result
// ---------------------------------------------------------------------------

export interface EvidenceComparison {
  readonly programA: ProgramId;
  readonly programB: ProgramId;
  readonly a?: EvidenceAccumulation;
  readonly b?: EvidenceAccumulation;
  readonly differences: Record<string, { a: number; b: number; delta: number; aBetter: boolean }>;
  readonly confidenceDelta: number;
  readonly strongerProgram?: ProgramId;
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export class EvidenceEngine {
  private readonly accumulations = new Map<ProgramId, EvidenceAccumulation>();
  private readonly history = new Map<ProgramId, EvidenceAccumulation[]>();

  /**
   * Gather real evidence for a program from across the platform and compute
   * an EvidenceAccumulation. Emits evidence.updated (and
   * evidence.score_changed when the confidence score moves).
   */
  async accumulate(programId: ProgramId, listingId?: string): Promise<EvidenceAccumulation> {
    const profiles = await loadProfiles();
    let matching: HealthProfileLike[] = [];
    if (profiles) {
      try {
        matching = profiles
          .list()
          .filter((p) => p.programs.some((pp) => pp.programId === programId));
      } catch {
        matching = [];
      }
    }

    const totalParticipants = matching.length;

    // Measurements + improvement trends
    const measurements = await loadMeasurements();
    let totalMeasurements = 0;
    let verifiedMeasurements = 0;
    const perProfileImprovements: number[] = [];
    if (measurements) {
      for (const profile of matching) {
        try {
          const list = measurements.list({ profileId: profile.id, includeSuperseded: false }) ?? [];
          totalMeasurements += list.length;
          for (const m of list) {
            if (m.verificationState === "verified") verifiedMeasurements++;
          }
          // Group by schema to compute per-schema % change, then average
          const bySchema = new Map<string, MeasurementLike[]>();
          for (const m of list) {
            const arr = bySchema.get(m.schemaId) ?? [];
            arr.push(m);
            bySchema.set(m.schemaId, arr);
          }
          const schemaPercents: number[] = [];
          for (const [, arr] of bySchema) {
            if (arr.length < 2) continue;
            const sorted = [...arr].sort((a, b) => a.provenance.collectedAt.localeCompare(b.provenance.collectedAt));
            const first = measurementValue(sorted[0]);
            const last = measurementValue(sorted[sorted.length - 1]);
            if (first === 0 || !Number.isFinite(first) || !Number.isFinite(last)) continue;
            schemaPercents.push(((last - first) / Math.abs(first)) * 100);
          }
          if (schemaPercents.length > 0) {
            perProfileImprovements.push(schemaPercents.reduce((a, b) => a + b, 0) / schemaPercents.length);
          }
        } catch {
          /* skip this profile */
        }
      }
    }

    const averageImprovement = perProfileImprovements.length > 0
      ? perProfileImprovements.reduce((a, b) => a + b, 0) / perProfileImprovements.length
      : 0;
    const medianImprovement = median(perProfileImprovements);

    // Missions
    const missions = await loadMissions();
    let missionCompliance = 0;
    let completionRate = 0;
    if (missions) {
      try {
        const list = missions.list({ programId }) ?? [];
        const attempted = list.filter((m) => m.state === "completed" || m.state === "skipped" || m.state === "expired" || m.state === "cancelled");
        const completed = list.filter((m) => m.state === "completed");
        completionRate = attempted.length > 0 ? completed.length / attempted.length : 0;
        missionCompliance = list.length > 0 ? completed.length / list.length : 0;
      } catch {
        /* skip */
      }
    }

    // Competitions
    const competitions = await loadCompetitions();
    let competitionParticipation = 0;
    if (competitions) {
      try {
        const list = competitions.list({ programId }) ?? [];
        competitionParticipation = list.reduce((a, c) => a + (c.currentParticipants ?? 0), 0);
      } catch {
        /* skip */
      }
    }

    // Technician sessions
    const sessions = await loadSessions();
    let technicianVerificationQuality = 0;
    let verifiedSessions = 0;
    let totalSessions = 0;
    if (sessions) {
      try {
        const list = sessions.list({ programId }) ?? [];
        totalSessions = list.length;
        verifiedSessions = list.filter((s) => s.status === "verified").length;
        technicianVerificationQuality = totalSessions > 0 ? verifiedSessions / totalSessions : 0;
      } catch {
        /* skip */
      }
    }

    // Measurement quality = verified / total measurements for this program's participants
    const measurementQuality = totalMeasurements > 0 ? verifiedMeasurements / totalMeasurements : 0;

    // Retention: active installs / total installs (active + uninstalled)
    let totalInstalls = 0;
    let activeInstalls = 0;
    for (const p of matching) {
      for (const pp of p.programs) {
        if (pp.programId === programId) {
          totalInstalls++;
          if (pp.status === "active") activeInstalls++;
        }
      }
    }
    const retentionRate = totalInstalls > 0 ? activeInstalls / totalInstalls : 0;

    // Long-term sustainability: composite of completion + retention
    const longTermSustainability = (completionRate + retentionRate) / 2;

    const now = getClock().iso();
    const prev = this.accumulations.get(programId);

    const accumulation: EvidenceAccumulation = {
      id: asEvidenceAccumulationId(generateId("ev_")),
      programId,
      listingId,
      totalParticipants,
      totalMeasurements,
      averageImprovement: round2(averageImprovement),
      medianImprovement: round2(medianImprovement),
      completionRate: round4(completionRate),
      retentionRate: round4(retentionRate),
      missionCompliance: round4(missionCompliance),
      competitionParticipation,
      measurementQuality: round4(measurementQuality),
      technicianVerificationQuality: round4(technicianVerificationQuality),
      longTermSustainability: round4(longTermSustainability),
      confidenceScore: 0, // computed below
      evidenceLevel: "preliminary",
      lastUpdated: now,
      history: this.compressHistory(prev),
    };
    const confidence = this.computeConfidence(accumulation);
    const level = computeEvidenceLevel(confidence);
    const final: EvidenceAccumulation = {
      ...accumulation,
      confidenceScore: round2(confidence),
      evidenceLevel: level,
    };

    this.accumulations.set(programId, final);
    const hist = this.history.get(programId) ?? [];
    this.history.set(programId, [...hist, final]);

    void getEventBus().publish(
      buildEvent(
        RESEARCH_EVENTS.evidenceUpdated,
        {
          programId,
          accumulationId: final.id,
          participants: final.totalParticipants,
          confidence: final.confidenceScore,
          level: final.evidenceLevel,
        },
        {},
        "domain",
      ),
    );
    if (prev && Math.abs(prev.confidenceScore - final.confidenceScore) >= 1) {
      void getEventBus().publish(
        buildEvent(
          RESEARCH_EVENTS.programEvidenceScoreChanged,
          {
            programId,
            previousScore: prev.confidenceScore,
            newScore: final.confidenceScore,
            previousLevel: prev.evidenceLevel,
            newLevel: final.evidenceLevel,
          },
          {},
          "domain",
        ),
      );
    }
    return final;
  }

  get(programId: ProgramId): EvidenceAccumulation | undefined {
    return this.accumulations.get(programId);
  }

  getHistory(programId: ProgramId): EvidenceAccumulation[] {
    return [...(this.history.get(programId) ?? [])];
  }

  /**
   * Compute a 0-100 confidence score from an accumulation:
   *   - population size (30pts: 1000+ = 30, 100+ = 20, 10+ = 10)
   *   - improvement magnitude (25pts, scaled)
   *   - completion rate (15pts)
   *   - retention (15pts)
   *   - measurement quality (15pts)
   * Total = 100.
   */
  computeConfidence(a: EvidenceAccumulation): number {
    // Population size (30 pts)
    let pop = 0;
    if (a.totalParticipants >= 1000) pop = 30;
    else if (a.totalParticipants >= 100) pop = 20;
    else if (a.totalParticipants >= 10) pop = 10;
    else if (a.totalParticipants > 0) pop = 3;

    // Improvement magnitude (25 pts): scale 0% → 0, 5% → 5, 10% → 12, 25% → 18, 50%+ → 25
    const imp = Math.max(0, a.averageImprovement);
    let impScore: number;
    if (imp >= 50) impScore = 25;
    else if (imp >= 25) impScore = 18;
    else if (imp >= 10) impScore = 12;
    else if (imp >= 5) impScore = 5;
    else impScore = 0;

    // Completion rate (15 pts)
    const compScore = clamp01(a.completionRate) * 15;
    // Retention (15 pts)
    const retScore = clamp01(a.retentionRate) * 15;
    // Measurement quality (15 pts)
    const mqScore = clamp01(a.measurementQuality) * 15;

    return clamp(pop + impScore + compScore + retScore + mqScore, 0, 100);
  }

  compare(programIdA: ProgramId, programIdB: ProgramId): EvidenceComparison {
    const a = this.accumulations.get(programIdA);
    const b = this.accumulations.get(programIdB);
    const differences: Record<string, { a: number; b: number; delta: number; aBetter: boolean }> = {};
    if (a && b) {
      const fields: (keyof EvidenceAccumulation)[] = [
        "totalParticipants",
        "totalMeasurements",
        "averageImprovement",
        "medianImprovement",
        "completionRate",
        "retentionRate",
        "missionCompliance",
        "competitionParticipation",
        "measurementQuality",
        "technicianVerificationQuality",
        "longTermSustainability",
        "confidenceScore",
      ];
      for (const f of fields) {
        const va = a[f] as number;
        const vb = b[f] as number;
        if (typeof va === "number" && typeof vb === "number") {
          differences[f] = { a: va, b: vb, delta: va - vb, aBetter: va > vb };
        }
      }
    }
    const confidenceDelta = a && b ? a.confidenceScore - b.confidenceScore : 0;
    let stronger: ProgramId | undefined;
    if (a && b) {
      stronger = a.confidenceScore >= b.confidenceScore ? programIdA : programIdB;
    }
    return {
      programA: programIdA,
      programB: programIdB,
      a,
      b,
      differences,
      confidenceDelta,
      strongerProgram: stronger,
    };
  }

  getTopEvidence(limit = 10): EvidenceAccumulation[] {
    return [...this.accumulations.values()]
      .sort((a, b) => b.confidenceScore - a.confidenceScore)
      .slice(0, limit);
  }

  getStats(): {
    total: number;
    byLevel: Record<EvidenceLevel, number>;
    avgConfidence: number;
    avgParticipants: number;
    avgImprovement: number;
  } {
    const list = [...this.accumulations.values()];
    const byLevel: Record<EvidenceLevel, number> = {
      preliminary: 0,
      emerging: 0,
      established: 0,
      strong: 0,
    };
    let confSum = 0;
    let popSum = 0;
    let impSum = 0;
    for (const a of list) {
      byLevel[a.evidenceLevel]++;
      confSum += a.confidenceScore;
      popSum += a.totalParticipants;
      impSum += a.averageImprovement;
    }
    return {
      total: list.length,
      byLevel,
      avgConfidence: list.length > 0 ? confSum / list.length : 0,
      avgParticipants: list.length > 0 ? popSum / list.length : 0,
      avgImprovement: list.length > 0 ? impSum / list.length : 0,
    };
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private compressHistory(prev: EvidenceAccumulation | undefined): { at: string; participants: number; improvement: number; confidence: number }[] {
    const base = prev?.history ?? [];
    const next = prev
      ? [{ at: prev.lastUpdated, participants: prev.totalParticipants, improvement: prev.averageImprovement, confidence: prev.confidenceScore }]
      : [];
    // Keep last 50 history entries to avoid unbounded growth.
    return [...base, ...next].slice(-50);
  }
}

// ---------------------------------------------------------------------------
// Math helpers
// ---------------------------------------------------------------------------

function measurementValue(m: MeasurementLike): number {
  if (typeof m.value === "number") return m.value;
  if (m.value && typeof m.value === "object" && typeof m.value.value === "number") return m.value.value;
  return NaN;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

function clamp(x: number, lo: number, hi: number): number {
  if (!Number.isFinite(x)) return lo;
  return Math.max(lo, Math.min(hi, x));
}

function round2(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 100) / 100;
}

function round4(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 10000) / 10000;
}

// Privacy-safe getter for downstream consumers (e.g. benchmarks, comparative)
// — exposes the singleton measurement loaders for reuse without re-loading.
export async function getProgramParticipants(programId: ProgramId): Promise<string[]> {
  const profiles = await loadProfiles();
  if (!profiles) return [];
  try {
    return profiles
      .list()
      .filter((p) => p.programs.some((pp) => pp.programId === programId && pp.status === "active"))
      .map((p) => p.accountId);
  } catch {
    return [];
  }
}

export async function getAllProgramIds(): Promise<ProgramId[]> {
  const profiles = await loadProfiles();
  if (!profiles) return [];
  try {
    const set = new Set<string>();
    for (const p of profiles.list()) {
      for (const pp of p.programs) {
        if (pp.status === "active") set.add(pp.programId);
      }
    }
    return [...set] as ProgramId[];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _engine: EvidenceEngine | null = null;
export function getEvidenceEngine(): EvidenceEngine {
  if (!_engine) _engine = new EvidenceEngine();
  return _engine;
}

export { ResearchError, RESEARCH_EVENTS, getPrivacy };
