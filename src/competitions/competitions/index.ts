/**
 * Eks-Health Competition Platform — Competitions
 *
 * Programs create fully configurable competitions. Competitions have a
 * lifecycle (draft→scheduled→registration→qualification→active→paused→
 * completed→archived→cancelled), a scope (global/national/regional/org/etc.),
 * eligibility rules, score specs, seasons, divisions, and reward schedules.
 * Everything is versioned and auditable.
 */

import "server-only";
import {
  type CompetitionId,
  type ProgramId,
  type AccountId,
  type CompetitionState,
  type CompetitionScope,
  type ScoreSpecId,
  type SeasonId,
  type DivisionId,
  type RewardScheduleId,
  type PrizePoolId,
  CompetitionError,
  asCompetitionId,
} from "../core";
import { getEventBus, buildEvent, generateId, getClock } from "@/kernel";
import { COMPETITION_EVENTS } from "../core";
import { db } from "@/lib/db";

// ---------------------------------------------------------------------------
// Competition definition
// ---------------------------------------------------------------------------

export interface Competition {
  readonly id: CompetitionId;
  readonly programId: ProgramId;
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly scope: CompetitionScope;
  readonly scopeFilter?: Record<string, unknown>;
  readonly state: CompetitionState;
  readonly scoreSpecId?: ScoreSpecId;
  readonly divisionIds: DivisionId[];
  readonly seasonIds: SeasonId[];
  readonly rewardScheduleIds: RewardScheduleId[];
  readonly prizePoolId?: PrizePoolId;
  readonly eligibilityRules: CompetitionEligibilityRule[];
  readonly createdBy: AccountId;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startsAt?: string;
  readonly endsAt?: string;
  readonly registrationOpensAt?: string;
  readonly registrationClosesAt?: string;
  readonly maxParticipants?: number;
  readonly currentParticipants: number;
  readonly version: number;
  readonly tags: string[];
  readonly customAttributes?: Record<string, unknown>;
}

export interface CompetitionEligibilityRule {
  readonly field: string; // e.g. "country", "age", "org", "risk_profile"
  readonly operator: "eq" | "ne" | "in" | "not_in" | "gt" | "lt" | "gte" | "lte" | "exists";
  readonly value: unknown;
  readonly description?: string;
}

export interface CreateCompetitionInput {
  readonly programId: ProgramId;
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly scope: CompetitionScope;
  readonly scopeFilter?: Record<string, unknown>;
  readonly eligibilityRules?: CompetitionEligibilityRule[];
  readonly startsAt?: string;
  readonly endsAt?: string;
  readonly registrationOpensAt?: string;
  readonly registrationClosesAt?: string;
  readonly maxParticipants?: number;
  readonly tags?: string[];
  readonly createdBy: AccountId;
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

const TRANSITIONS: Record<CompetitionState, CompetitionState[]> = {
  draft: ["scheduled", "cancelled"],
  scheduled: ["registration", "draft", "cancelled"],
  registration: ["qualification", "active", "cancelled"],
  qualification: ["active", "registration", "cancelled"],
  active: ["paused", "completed", "cancelled"],
  paused: ["active", "completed", "cancelled"],
  completed: ["archived"],
  archived: [],
  cancelled: [],
};

export function canTransition(from: CompetitionState, to: CompetitionState): boolean {
  return (TRANSITIONS[from] ?? []).includes(to);
}

// ---------------------------------------------------------------------------
// Competition registry
// ---------------------------------------------------------------------------

export class CompetitionRegistry {
  private readonly competitions = new Map<CompetitionId, Competition>();
  private readonly bySlug = new Map<string, CompetitionId>();
  private readonly byProgram = new Map<ProgramId, CompetitionId[]>();
  private readonly auditLog: CompetitionAuditEntry[] = [];

  create(input: CreateCompetitionInput): Competition {
    if (this.bySlug.has(input.slug)) {
      throw new CompetitionError({
        code: "eks.competition.duplicate_slug",
        category: "state_conflict",
        message: `Competition slug '${input.slug}' already exists.`,
        userMessage: "A competition with this slug already exists.",
      });
    }
    const now = getClock().iso();
    const comp: Competition = {
      id: asCompetitionId(generateId("comp_")),
      programId: input.programId,
      slug: input.slug,
      name: input.name,
      description: input.description,
      scope: input.scope,
      scopeFilter: input.scopeFilter,
      state: "draft",
      divisionIds: [],
      seasonIds: [],
      rewardScheduleIds: [],
      eligibilityRules: input.eligibilityRules ?? [],
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      registrationOpensAt: input.registrationOpensAt,
      registrationClosesAt: input.registrationClosesAt,
      maxParticipants: input.maxParticipants,
      currentParticipants: 0,
      version: 1,
      tags: input.tags ?? [],
    };
    this.competitions.set(comp.id, comp);
    void this._persist(comp.id);
    this.bySlug.set(input.slug, comp.id);
    const pList = this.byProgram.get(input.programId) ?? [];
    this.byProgram.set(input.programId, [...pList, comp.id]);
    this.recordAudit(comp.id, "created", { slug: input.slug });
    void getEventBus().publish(buildEvent(COMPETITION_EVENTS.competitionCreated, { competitionId: comp.id, slug: input.slug, programId: input.programId }, {}, "domain"));
    return comp;
  }

  get(id: CompetitionId): Competition | undefined {
    return this.competitions.get(id);
  }

  getBySlug(slug: string): Competition | undefined {
    const id = this.bySlug.get(slug);
    return id ? this.competitions.get(id) : undefined;
  }

  list(filter?: { programId?: ProgramId; state?: CompetitionState; scope?: CompetitionScope }): Competition[] {
    let list = [...this.competitions.values()];
    if (filter?.programId) list = list.filter((c) => c.programId === filter.programId);
    if (filter?.state) list = list.filter((c) => c.state === filter.state);
    if (filter?.scope) list = list.filter((c) => c.scope === filter.scope);
    return list;
  }

  listByProgram(programId: ProgramId): Competition[] {
    return (this.byProgram.get(programId) ?? []).map((id) => this.competitions.get(id)!).filter(Boolean);
  }

  transition(id: CompetitionId, to: CompetitionState): Competition {
    const comp = this.competitions.get(id);
    if (!comp) throw new CompetitionError({ code: "eks.competition.not_found", category: "not_found", message: "Competition not found." });
    if (!canTransition(comp.state, to)) {
      throw new CompetitionError({
        code: "eks.competition.invalid_transition",
        category: "state_conflict",
        message: `Cannot transition from ${comp.state} to ${to}.`,
        userMessage: `This action is not allowed in the current state (${comp.state}).`,
        metadata: { from: comp.state, to, allowed: TRANSITIONS[comp.state] },
      });
    }
    const updated: Competition = { ...comp, state: to, updatedAt: getClock().iso() };
    this.competitions.set(id, updated);
    void this._persist(id);
    this.recordAudit(id, to, {});
    const eventMap: Partial<Record<CompetitionState, string>> = {
      active: COMPETITION_EVENTS.competitionStarted,
      paused: COMPETITION_EVENTS.competitionPaused,
      completed: COMPETITION_EVENTS.competitionCompleted,
      cancelled: COMPETITION_EVENTS.competitionCancelled,
    };
    const evt = eventMap[to];
    if (evt) void getEventBus().publish(buildEvent(evt, { competitionId: id, to }, {}, "domain"));
    return updated;
  }

  update(id: CompetitionId, updates: Partial<Omit<Competition, "id" | "programId" | "createdAt" | "version">>): Competition {
    const comp = this.competitions.get(id);
    if (!comp) throw new CompetitionError({ code: "eks.competition.not_found", category: "not_found", message: "Not found." });
    const updated: Competition = { ...comp, ...updates, updatedAt: getClock().iso(), version: comp.version + 1 };
    this.competitions.set(id, updated);
    void this._persist(id);
    return updated;
  }

  setScoreSpec(id: CompetitionId, specId: ScoreSpecId): Competition {
    return this.update(id, { scoreSpecId: specId });
  }

  addDivision(id: CompetitionId, divisionId: DivisionId): Competition {
    const comp = this.competitions.get(id);
    if (!comp) throw new CompetitionError({ code: "eks.competition.not_found", category: "not_found", message: "Not found." });
    if (comp.divisionIds.includes(divisionId)) return comp;
    return this.update(id, { divisionIds: [...comp.divisionIds, divisionId] });
  }

  addSeason(id: CompetitionId, seasonId: SeasonId): Competition {
    const comp = this.competitions.get(id);
    if (!comp) throw new CompetitionError({ code: "eks.competition.not_found", category: "not_found", message: "Not found." });
    if (comp.seasonIds.includes(seasonId)) return comp;
    return this.update(id, { seasonIds: [...comp.seasonIds, seasonId] });
  }

  addRewardSchedule(id: CompetitionId, scheduleId: RewardScheduleId): Competition {
    const comp = this.competitions.get(id);
    if (!comp) throw new CompetitionError({ code: "eks.competition.not_found", category: "not_found", message: "Not found." });
    if (comp.rewardScheduleIds.includes(scheduleId)) return comp;
    return this.update(id, { rewardScheduleIds: [...comp.rewardScheduleIds, scheduleId] });
  }

  setPrizePool(id: CompetitionId, poolId: PrizePoolId): Competition {
    return this.update(id, { prizePoolId: poolId });
  }

  incrementParticipants(id: CompetitionId): void {
    const comp = this.competitions.get(id);
    if (!comp) return;
    this.competitions.set(id, { ...comp, currentParticipants: comp.currentParticipants + 1, updatedAt: getClock().iso() });
    void this._persist(id);
  }

  decrementParticipants(id: CompetitionId): void {
    const comp = this.competitions.get(id);
    if (!comp) return;
    this.competitions.set(id, { ...comp, currentParticipants: Math.max(0, comp.currentParticipants - 1), updatedAt: getClock().iso() });
    void this._persist(id);
  }

  getAuditLog(competitionId?: CompetitionId): readonly CompetitionAuditEntry[] {
    return competitionId ? this.auditLog.filter((a) => a.competitionId === competitionId) : this.auditLog;
  }

  getStats(): { total: number; byState: Record<string, number>; byScope: Record<string, number>; totalParticipants: number } {
    const list = [...this.competitions.values()];
    const byState: Record<string, number> = {};
    const byScope: Record<string, number> = {};
    let totalParticipants = 0;
    for (const c of list) {
      byState[c.state] = (byState[c.state] ?? 0) + 1;
      byScope[c.scope] = (byScope[c.scope] ?? 0) + 1;
      totalParticipants += c.currentParticipants;
    }
    return { total: list.length, byState, byScope, totalParticipants };
  }

  private recordAudit(competitionId: CompetitionId, event: string, metadata: Record<string, unknown>): void {
    this.auditLog.push({ competitionId, event, at: getClock().iso(), metadata });
  }

  /** Write-behind: upsert competition as JSON snapshot to EksCompetition. */
  private async _persist(id: CompetitionId): Promise<void> {
    const c = this.competitions.get(id);
    if (!c) return;
    try {
      await db.eksCompetition.upsert({
        where: { id },
        create: {
          id: c.id,
          slug: c.slug,
          programId: c.programId,
          dataJson: JSON.stringify(c),
          state: c.state,
          createdAt: new Date(c.createdAt),
        },
        update: {
          dataJson: JSON.stringify(c),
          state: c.state,
        },
      });
    } catch (err) {
      console.error("[competitions] DB write-behind failed for", c.id, err);
    }
  }

  /** Hydrate competitions from DB. Rebuilds bySlug/byProgram indexes. */
  async hydrateFromDb(): Promise<number> {
    try {
      const rows = await db.eksCompetition.findMany();
      let loaded = 0;
      for (const row of rows) {
        if (this.competitions.has(row.id as CompetitionId)) continue;
        try {
          const c = JSON.parse(row.dataJson) as Competition;
          this.competitions.set(c.id, c);
          this.bySlug.set(c.slug, c.id);
          const pList = this.byProgram.get(c.programId) ?? [];
          this.byProgram.set(c.programId, [...pList, c.id]);
          loaded++;
        } catch {
          // skip malformed
        }
      }
      return loaded;
    } catch (err) {
      console.error("[competitions] DB hydration failed:", err);
      return 0;
    }
  }
}

export interface CompetitionAuditEntry {
  readonly competitionId: CompetitionId;
  readonly event: string;
  readonly at: string;
  readonly metadata: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _registry: CompetitionRegistry | null = null;
export function getCompetitions(): CompetitionRegistry {
  if (!_registry) _registry = new CompetitionRegistry();
  return _registry;
}
