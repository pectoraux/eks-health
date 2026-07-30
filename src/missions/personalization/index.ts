/**
 * Eks-Health Mission Engine — Personalization Engine
 *
 * Every participant receives an individualized experience. The platform
 * exposes SECURE inputs to Programs: measurements, competition standing,
 * demographics, preferences, behavior history, mission completion, program
 * history, technician feedback, connected devices, environmental context,
 * org membership, and custom program data. Programs decide how to use them.
 *
 * This engine GATHERS those inputs from the live platform subsystems
 * (health, competitions, identity, missions, goals, habits) into a single
 * `PersonalizationContext`. Every gather is guarded — if a subsystem is
 * unavailable, the corresponding factor is simply omitted.
 */

import "server-only";
import {
  type PersonalizationContext,
  type ProgramId,
  type AccountId,
  type OrgId,
  type SchemaId,
  type CompetitionId,
  MissionError,
} from "../core";
import { getEventBus, buildEvent, generateId, getClock } from "@/kernel";
import { getMissions } from "../missions";
import { getGoals } from "../goals";
import { getHabits } from "../habits";
import { getProfiles, getMeasurements } from "@/health";
import { getLeaderboards } from "@/competitions";
import { getOrganizations } from "@/identity";

// ---------------------------------------------------------------------------
// Personalization types
// ---------------------------------------------------------------------------

export interface ContextFactor {
  readonly name: string;
  readonly value: unknown;
  readonly source: string;
  readonly confidence: number; // 0-1
  readonly lastUpdated?: string;
}

export interface PersonalizationInput {
  readonly participantId: AccountId;
  readonly programId: ProgramId;
  readonly options?: PersonalizationOptions;
}

export interface PersonalizationOptions {
  readonly includeMeasurements?: boolean;
  readonly includeCompetition?: boolean;
  readonly includeDemographics?: boolean;
  readonly includeBehavior?: boolean;
  readonly includeProgramHistory?: boolean;
  readonly includeDevices?: boolean;
  readonly includeOrgs?: boolean;
  readonly includeTechnicianFeedback?: boolean;
  readonly includeEnvironmental?: boolean;
  readonly includePreferences?: boolean;
  readonly includeCustom?: boolean;
}

export interface PersonalizationResult {
  readonly context: PersonalizationContext;
  readonly factors: ContextFactor[];
  readonly computedAt: string;
  readonly freshnessScore: number; // 0-1
}

export interface PersonalizationStats {
  readonly totalContextsBuilt: number;
  readonly avgFactors: number;
  readonly avgFreshness: number;
  readonly bySource: Record<string, number>;
}

export interface PersonalizationComparison {
  readonly participantId: AccountId;
  readonly otherParticipantId: AccountId;
  readonly similarity: number; // 0-1, higher = more similar
  readonly sharedFactors: string[];
  readonly differingFactors: string[];
}

// ---------------------------------------------------------------------------
// Personalization engine
// ---------------------------------------------------------------------------

export class PersonalizationEngine {
  private readonly results = new Map<string, PersonalizationResult>(); // key: `${participantId}::${programId}`
  private totalBuilt = 0;
  private totalFactors = 0;
  private totalFreshness = 0;
  private readonly bySource: Record<string, number> = {};

  /**
   * Gather ALL personalization inputs for a participant into a single
   * PersonalizationContext. Every subsystem access is guarded — if a
   * subsystem is unavailable, the corresponding factor is omitted.
   */
  buildContext(input: PersonalizationInput): PersonalizationContext {
    const opts = input.options ?? {};
    const factors: ContextFactor[] = [];
    const participantId = input.participantId;
    const programId = input.programId;

    // -- Measurements -------------------------------------------------------
    const measurements: PersonalizationContext["measurements"] = [];
    if (opts.includeMeasurements !== false) {
      try {
        const profiles = getProfiles();
        const profile = profiles.get(participantId);
        if (profile) {
          const store = getMeasurements();
          const all = store.list({ profileId: profile.id });
          // Group by schemaId, find latest, compute trend
          const bySchema = new Map<
            string,
            { values: Array<{ value: unknown; ts: string }> }
          >();
          for (const m of all) {
            const sid = m.schemaId as string;
            const entry = bySchema.get(sid) ?? { values: [] };
            entry.values.push({ value: m.value, ts: m.provenance?.collectedAt ?? m.createdAt });
            bySchema.set(sid, entry);
          }
          for (const [schemaId, { values }] of bySchema) {
            if (values.length === 0) continue;
            values.sort((a, b) => b.ts.localeCompare(a.ts));
            const latest = values[0]!;
            const trend = this.computeTrend(values);
            measurements.push({
              schemaId: schemaId as SchemaId,
              latestValue: latest.value,
              trend,
              count: values.length,
            });
            factors.push({
              name: `measurement:${schemaId}`,
              value: latest.value,
              source: "health.measurements",
              confidence: 0.95,
              lastUpdated: latest.ts,
            });
          }
        }
      } catch {
        /* measurements unavailable */
      }
    }

    // -- Competition standing ----------------------------------------------
    let competitionStanding: PersonalizationContext["competitionStanding"];
    if (opts.includeCompetition !== false) {
      try {
        const lbs = getLeaderboards();
        const boards = lbs.list() ?? [];
        let best: { competitionId: CompetitionId; rank: number; score: number; division?: string } | undefined;
        for (const b of boards) {
          const r = lbs.getRank(b.id, participantId);
          const entry = r?.entry;
          if (!entry) continue;
          if (!best || entry.rank < best.rank) {
            best = {
              competitionId: b.competitionId,
              rank: entry.rank,
              score: entry.score,
              division: b.divisionId as string | undefined,
            };
          }
        }
        competitionStanding = best;
        if (best) {
          factors.push({
            name: "competitionStanding",
            value: best,
            source: "competitions.leaderboards",
            confidence: 0.9,
            lastUpdated: getClock().iso(),
          });
        }
      } catch {
        /* competitions unavailable */
      }
    }

    // -- Demographics, preferences, devices, program history ---------------
    let demographics: PersonalizationContext["demographics"];
    let preferences: Record<string, unknown> | undefined;
    let connectedDevices: string[] | undefined;
    let programHistory: PersonalizationContext["programHistory"];
    let customProgramData: Record<string, unknown> | undefined;

    try {
      const profiles = getProfiles();
      const profile = profiles.get(participantId);
      if (profile) {
        if (opts.includeDemographics !== false) {
          demographics = {
            ageRange: profile.demographics.ageRange,
            biologicalSex: profile.demographics.biologicalSex,
            country: profile.demographics.country,
            timezone: profile.demographics.timezone,
          };
          if (demographics) {
            factors.push({
              name: "demographics",
              value: demographics,
              source: "health.profiles",
              confidence: 0.9,
              lastUpdated: profile.updatedAt,
            });
          }
        }
        if (opts.includePreferences !== false) {
          const prefs = profiles.getPreferences(participantId);
          if (prefs.length > 0) {
            preferences = {};
            for (const p of prefs) preferences[p.key] = p.value;
            factors.push({
              name: "preferences",
              value: preferences,
              source: "health.profiles",
              confidence: 0.85,
              lastUpdated: prefs[0]!.updatedAt,
            });
          }
        }
        if (opts.includeDevices !== false) {
          const devs = profiles.listDevices(participantId, false);
          if (devs.length > 0) {
            connectedDevices = devs.map((d) => d.type);
            factors.push({
              name: "connectedDevices",
              value: connectedDevices,
              source: "health.profiles",
              confidence: 0.9,
              lastUpdated: devs[0]!.registeredAt,
            });
          }
        }
        if (opts.includeProgramHistory !== false) {
          const progs = profiles.listPrograms(participantId, true);
          if (progs.length > 0) {
            const joined = progs[0]!;
            programHistory = {
              joinedAt: joined.installedAt,
              missionsCompleted: 0, // filled from missions below
              goalsAchieved: 0, // filled from goals below
            };
          }
        }
        if (opts.includeCustom !== false) {
          const attrs = profiles.listCustomAttributes(participantId);
          if (attrs.length > 0) {
            customProgramData = {};
            for (const { key, attr } of attrs) customProgramData[key] = attr.value;
          }
        }
      }
    } catch {
      /* profiles unavailable */
    }

    // -- Behavior history (mission completion rate) -----------------------
    let behaviorHistory: PersonalizationContext["behaviorHistory"];
    if (opts.includeBehavior !== false) {
      try {
        const missions = getMissions().list({ participantId });
        const completed = missions.filter((m) => m.state === "completed");
        const attempted = missions.filter(
          (m) => m.state === "completed" || m.state === "skipped" || m.state === "expired",
        );
        const completionRate = attempted.length > 0 ? completed.length / attempted.length : 0;
        const durations = completed
          .map((m) => m.result?.durationMs)
          .filter((d): d is number => typeof d === "number");
        const avgSession = durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : 0;
        const lastActiveAts = completed
          .map((m) => m.completedAt)
          .filter((x): x is string => Boolean(x))
          .sort((a, b) => b.localeCompare(a));
        const lastActiveAt = lastActiveAts[0];
        behaviorHistory = {
          missionCompletionRate: completionRate,
          avgSessionDuration: avgSession,
          lastActiveAt,
        };
        if (programHistory) {
          programHistory = { ...programHistory, missionsCompleted: completed.length };
        }
        factors.push({
          name: "behaviorHistory",
          value: behaviorHistory,
          source: "missions.missions",
          confidence: 0.95,
          lastUpdated: lastActiveAt,
        });
      } catch {
        /* missions unavailable */
      }
    }

    // -- Goals achieved count (enriches programHistory) -------------------
    if (opts.includeProgramHistory !== false) {
      try {
        const goals = getGoals().list({ participantId });
        const achieved = goals.filter((g) => g.state === "achieved").length;
        if (programHistory) {
          programHistory = { ...programHistory, goalsAchieved: achieved };
        } else if (achieved > 0) {
          programHistory = { joinedAt: getClock().iso(), missionsCompleted: 0, goalsAchieved: achieved };
        }
      } catch {
        /* goals unavailable */
      }
    }

    // -- Technician feedback (from mission metadata) ----------------------
    let technicianFeedback: string[] | undefined;
    if (opts.includeTechnicianFeedback !== false) {
      try {
        const missions = getMissions().list({ participantId });
        const feedback: string[] = [];
        for (const m of missions) {
          const obs = m.metadata?.["technicianObservation"];
          if (typeof obs === "string") feedback.push(obs);
        }
        if (feedback.length > 0) {
          technicianFeedback = feedback;
          factors.push({
            name: "technicianFeedback",
            value: feedback,
            source: "missions.missions.metadata",
            confidence: 0.8,
          });
        }
      } catch {
        /* missions unavailable */
      }
    }

    // -- Org membership ----------------------------------------------------
    let orgMembership: OrgId[] | undefined;
    if (opts.includeOrgs !== false) {
      try {
        const orgs = getOrganizations();
        const memberships = orgs.listMembershipsForAccount(participantId);
        const active = memberships.filter((m) => m.active).map((m) => m.orgId);
        if (active.length > 0) {
          orgMembership = active;
          factors.push({
            name: "orgMembership",
            value: active,
            source: "identity.organizations",
            confidence: 0.95,
            lastUpdated: memberships[0]!.addedAt,
          });
        }
      } catch {
        /* organizations unavailable */
      }
    }

    // -- Habit streaks (enriches behavior signal) -------------------------
    try {
      const habits = getHabits().list({ participantId });
      if (habits.length > 0) {
        const bestStreak = Math.max(...habits.map((h) => h.streak.current));
        factors.push({
          name: "habitBestStreak",
          value: bestStreak,
          source: "missions.habits",
          confidence: 0.9,
          lastUpdated: habits[0]!.lastCompletedAt,
        });
      }
    } catch {
      /* habits unavailable */
    }

    // -- Environmental context (placeholder — sourced from external APIs
    // in production; here we leave it undefined unless customAttributes
    // carry it) -----------------------------------------------------------
    let environmentalContext: PersonalizationContext["environmentalContext"];
    if (opts.includeEnvironmental !== false && customProgramData) {
      const env = customProgramData["environmentalContext"];
      if (env && typeof env === "object") {
        environmentalContext = env as PersonalizationContext["environmentalContext"];
        factors.push({
          name: "environmentalContext",
          value: environmentalContext,
          source: "customProgramData",
          confidence: 0.6,
        });
      }
    }

    const now = getClock().iso();
    const context: PersonalizationContext = {
      participantId,
      programId,
      measurements,
      competitionStanding,
      demographics,
      preferences,
      behaviorHistory,
      programHistory,
      technicianFeedback,
      connectedDevices,
      environmentalContext,
      orgMembership,
      customProgramData,
    };

    // Cache the result (with factors) for later retrieval / stats
    const freshness = this.scoreFreshnessFromFactors(factors, now);
    const result: PersonalizationResult = { context, factors, computedAt: now, freshnessScore: freshness };
    const key = `${participantId}::${programId}`;
    this.results.set(key, result);
    this.totalBuilt++;
    this.totalFactors += factors.length;
    this.totalFreshness += freshness;
    for (const f of factors) {
      this.bySource[f.source] = (this.bySource[f.source] ?? 0) + 1;
    }

    void getEventBus().publish(
      buildEvent(
        "eks.mission.personalization.context_built",
        {
          participantId,
          programId,
          factorCount: factors.length,
          freshnessScore: freshness,
        },
        {},
        "domain",
      ),
    );

    return context;
  }

  /** Build the full PersonalizationResult (context + factors + freshness). */
  buildResult(input: PersonalizationInput): PersonalizationResult {
    const context = this.buildContext(input);
    const key = `${input.participantId}::${input.programId}`;
    const cached = this.results.get(key);
    if (cached) return cached;
    // Fallback (shouldn't happen — buildContext always caches)
    return {
      context,
      factors: this.deriveFactors(context),
      computedAt: getClock().iso(),
      freshnessScore: this.scoreFreshness(context),
    };
  }

  /** Get a cached result for a participant+program (without rebuilding). */
  getCached(participantId: AccountId, programId: ProgramId): PersonalizationResult | undefined {
    return this.results.get(`${participantId}::${programId}`);
  }

  /** Extract a specific factor by name from a context (derives on the fly). */
  getFactor(context: PersonalizationContext, name: string): ContextFactor | undefined {
    const factors = this.deriveFactors(context);
    return factors.find((f) => f.name === name);
  }

  /**
   * Compute a 0-1 freshness score based on how recent the context's data is.
   * Uses behaviorHistory.lastActiveAt as the primary signal (when the
   * participant was last active), falling back to programHistory.joinedAt.
   *   - active within 1 day  → 1.0
   *   - within 7 days        → 0.7-1.0 (linear)
   *   - within 30 days       → 0.3-0.7 (linear)
   *   - older                → 0.0-0.3 (linear)
   *   - no timestamp         → 0.0
   */
  scoreFreshness(context: PersonalizationContext): number {
    const ts =
      context.behaviorHistory?.lastActiveAt ??
      context.programHistory?.joinedAt;
    return this.scoreFreshnessFromTimestamp(ts);
  }

  /** Compare two participants' contexts for similarity (0-1). */
  compare(
    participantId: AccountId,
    otherParticipantId: AccountId,
    programId?: ProgramId,
  ): PersonalizationComparison {
    const a = programId
      ? this.getCached(participantId, programId)?.context
      : this.findLatestContext(participantId);
    const b = programId
      ? this.getCached(otherParticipantId, programId)?.context
      : this.findLatestContext(otherParticipantId);
    if (!a || !b) {
      return {
        participantId,
        otherParticipantId,
        similarity: 0,
        sharedFactors: [],
        differingFactors: [],
      };
    }
    return this.compareContexts(a, b, participantId, otherParticipantId);
  }

  getStats(): PersonalizationStats {
    return {
      totalContextsBuilt: this.totalBuilt,
      avgFactors: this.totalBuilt > 0 ? this.totalFactors / this.totalBuilt : 0,
      avgFreshness: this.totalBuilt > 0 ? this.totalFreshness / this.totalBuilt : 0,
      bySource: { ...this.bySource },
    };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** Derive a flat factor list from a context (on-demand, no timestamps). */
  private deriveFactors(context: PersonalizationContext): ContextFactor[] {
    const factors: ContextFactor[] = [];
    for (const m of context.measurements) {
      factors.push({
        name: `measurement:${m.schemaId}`,
        value: m.latestValue,
        source: "health.measurements",
        confidence: 0.95,
      });
    }
    if (context.competitionStanding) {
      factors.push({ name: "competitionStanding", value: context.competitionStanding, source: "competitions.leaderboards", confidence: 0.9 });
    }
    if (context.demographics) {
      factors.push({ name: "demographics", value: context.demographics, source: "health.profiles", confidence: 0.9 });
    }
    if (context.preferences) {
      factors.push({ name: "preferences", value: context.preferences, source: "health.profiles", confidence: 0.85 });
    }
    if (context.behaviorHistory) {
      factors.push({ name: "behaviorHistory", value: context.behaviorHistory, source: "missions.missions", confidence: 0.95, lastUpdated: context.behaviorHistory.lastActiveAt });
    }
    if (context.programHistory) {
      factors.push({ name: "programHistory", value: context.programHistory, source: "health.profiles", confidence: 0.9, lastUpdated: context.programHistory.joinedAt });
    }
    if (context.technicianFeedback) {
      factors.push({ name: "technicianFeedback", value: context.technicianFeedback, source: "missions.missions.metadata", confidence: 0.8 });
    }
    if (context.connectedDevices) {
      factors.push({ name: "connectedDevices", value: context.connectedDevices, source: "health.profiles", confidence: 0.9 });
    }
    if (context.environmentalContext) {
      factors.push({ name: "environmentalContext", value: context.environmentalContext, source: "customProgramData", confidence: 0.6 });
    }
    if (context.orgMembership) {
      factors.push({ name: "orgMembership", value: context.orgMembership, source: "identity.organizations", confidence: 0.95 });
    }
    if (context.customProgramData) {
      factors.push({ name: "customProgramData", value: context.customProgramData, source: "customProgramData", confidence: 0.7 });
    }
    return factors;
  }

  private computeTrend(
    values: Array<{ value: unknown; ts: string }>,
  ): "up" | "down" | "stable" | undefined {
    const numeric = values
      .map((v) => (typeof v.value === "number" ? v.value : typeof v.value === "object" && v.value !== null && "value" in v.value ? (v.value as { value: unknown }).value : undefined))
      .filter((v): v is number => typeof v === "number");
    if (numeric.length < 2) return undefined;
    // values are sorted most-recent-first; compare first half avg vs second half avg
    const recent = numeric.slice(0, Math.ceil(numeric.length / 2));
    const older = numeric.slice(Math.ceil(numeric.length / 2));
    const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
    const olderAvg = older.length > 0 ? older.reduce((a, b) => a + b, 0) / older.length : recentAvg;
    const delta = recentAvg - olderAvg;
    const threshold = Math.max(Math.abs(olderAvg) * 0.05, 0.01);
    if (delta > threshold) return "up";
    if (delta < -threshold) return "down";
    return "stable";
  }

  private scoreFreshnessFromTimestamp(ts: string | undefined): number {
    if (!ts) return 0;
    const now = Date.now();
    const then = new Date(ts).getTime();
    if (Number.isNaN(then)) return 0;
    const ageDays = (now - then) / 86400000;
    if (ageDays <= 1) return 1;
    if (ageDays <= 7) return 1 - ((ageDays - 1) / 6) * 0.3; // 1.0 → 0.7
    if (ageDays <= 30) return 0.7 - ((ageDays - 7) / 23) * 0.4; // 0.7 → 0.3
    if (ageDays <= 90) return 0.3 - ((ageDays - 30) / 60) * 0.3; // 0.3 → 0.0
    return 0;
  }

  private scoreFreshnessFromFactors(factors: ContextFactor[], now: string): number {
    if (factors.length === 0) return 0;
    let sum = 0;
    let count = 0;
    for (const f of factors) {
      const ts = f.lastUpdated;
      if (ts) {
        sum += this.scoreFreshnessFromTimestamp(ts);
        count++;
      }
    }
    if (count === 0) {
      // No timestamps available — infer from `now` (just built, so fresh)
      void now;
      return 0.5;
    }
    return sum / count;
  }

  private findLatestContext(participantId: AccountId): PersonalizationContext | undefined {
    let latest: PersonalizationResult | undefined;
    for (const r of this.results.values()) {
      if (r.context.participantId !== participantId) continue;
      if (!latest || r.computedAt > latest.computedAt) latest = r;
    }
    return latest?.context;
  }

  private compareContexts(
    a: PersonalizationContext,
    b: PersonalizationContext,
    aid: AccountId,
    bid: AccountId,
  ): PersonalizationComparison {
    const shared: string[] = [];
    const differing: string[] = [];
    let matches = 0;
    let total = 0;

    // Demographics similarity
    total++;
    if (a.demographics && b.demographics) {
      const sameCountry = a.demographics.country === b.demographics.country;
      const sameTimezone = a.demographics.timezone === b.demographics.timezone;
      if (sameCountry && sameTimezone) {
        matches++;
        shared.push("demographics");
      } else {
        differing.push("demographics");
      }
    } else {
      differing.push("demographics");
    }

    // Behavior similarity (completion rate within 0.2)
    total++;
    const ar = a.behaviorHistory?.missionCompletionRate;
    const br = b.behaviorHistory?.missionCompletionRate;
    if (typeof ar === "number" && typeof br === "number") {
      if (Math.abs(ar - br) <= 0.2) {
        matches++;
        shared.push("behaviorHistory");
      } else {
        differing.push("behaviorHistory");
      }
    } else {
      differing.push("behaviorHistory");
    }

    // Org membership overlap (Jaccard)
    total++;
    const ao = new Set(a.orgMembership ?? []);
    const bo = new Set(b.orgMembership ?? []);
    if (ao.size > 0 && bo.size > 0) {
      let intersection = 0;
      for (const o of ao) if (bo.has(o)) intersection++;
      const union = ao.size + bo.size - intersection;
      const jaccard = union > 0 ? intersection / union : 0;
      if (jaccard > 0.5) {
        matches++;
        shared.push("orgMembership");
      } else {
        differing.push("orgMembership");
      }
    } else {
      differing.push("orgMembership");
    }

    // Measurement schema overlap
    total++;
    const ams = new Set(a.measurements.map((m) => m.schemaId));
    const bms = new Set(b.measurements.map((m) => m.schemaId));
    if (ams.size > 0 && bms.size > 0) {
      let intersection = 0;
      for (const s of ams) if (bms.has(s)) intersection++;
      const union = ams.size + bms.size - intersection;
      const jaccard = union > 0 ? intersection / union : 0;
      if (jaccard > 0.5) {
        matches++;
        shared.push("measurements");
      } else {
        differing.push("measurements");
      }
    } else {
      differing.push("measurements");
    }

    const similarity = total > 0 ? matches / total : 0;
    return {
      participantId: aid,
      otherParticipantId: bid,
      similarity,
      sharedFactors: shared,
      differingFactors: differing,
    };
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _engine: PersonalizationEngine | null = null;
export function getPersonalization(): PersonalizationEngine {
  if (!_engine) _engine = new PersonalizationEngine();
  return _engine;
}

export function resetPersonalization(): void {
  _engine = null;
}

export type {
  PersonalizationContext,
  ProgramId,
  AccountId,
  OrgId,
  SchemaId,
  CompetitionId,
};
