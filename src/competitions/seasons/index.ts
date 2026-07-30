/**
 * Eks-Health Competition Platform — Seasons
 *
 * Competitions support seasons (weekly, monthly, quarterly, annual, rolling,
 * continuous, custom). Seasons archive automatically. Each season has its
 * own leaderboards, scores, and prize pools.
 */

import "server-only";
import {
  type SeasonId,
  type CompetitionId,
  type SeasonType,
  type SeasonState,
  CompetitionError,
  asSeasonId,
} from "../core";
import { getEventBus, buildEvent, generateId, getClock } from "@/kernel";
import { COMPETITION_EVENTS } from "../core";

// ---------------------------------------------------------------------------
// Season
// ---------------------------------------------------------------------------

export interface Season {
  readonly id: SeasonId;
  readonly competitionId: CompetitionId;
  readonly name: string;
  readonly type: SeasonType;
  readonly state: SeasonState;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly archiveAt?: string;
  readonly createdAt: string;
  readonly activatedAt?: string;
  readonly archivedAt?: string;
  readonly parentSeasonId?: SeasonId; // for rolling seasons
  readonly sequence: number; // 1st season, 2nd season, etc.
  readonly metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Season manager
// ---------------------------------------------------------------------------

const SEASON_TRANSITIONS: Record<SeasonState, SeasonState[]> = {
  upcoming: ["active", "cancelled"],
  active: ["archived", "cancelled"],
  archived: [],
  cancelled: [],
};

export class SeasonManager {
  private readonly seasons = new Map<SeasonId, Season>();
  private readonly byCompetition = new Map<CompetitionId, SeasonId[]>();
  private readonly sequenceCounters = new Map<CompetitionId, number>();

  create(input: {
    competitionId: CompetitionId;
    name: string;
    type: SeasonType;
    startsAt: string;
    endsAt: string;
    archiveAt?: string;
    parentSeasonId?: SeasonId;
    metadata?: Record<string, unknown>;
  }): Season {
    const seq = (this.sequenceCounters.get(input.competitionId) ?? 0) + 1;
    this.sequenceCounters.set(input.competitionId, seq);
    const season: Season = {
      id: asSeasonId(generateId("season_")),
      competitionId: input.competitionId,
      name: input.name,
      type: input.type,
      state: "upcoming",
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      archiveAt: input.archiveAt,
      createdAt: getClock().iso(),
      parentSeasonId: input.parentSeasonId,
      sequence: seq,
      metadata: input.metadata,
    };
    this.seasons.set(season.id, season);
    const list = this.byCompetition.get(input.competitionId) ?? [];
    this.byCompetition.set(input.competitionId, [...list, season.id]);
    return season;
  }

  get(id: SeasonId): Season | undefined {
    return this.seasons.get(id);
  }

  list(competitionId?: CompetitionId): Season[] {
    if (competitionId) {
      return (this.byCompetition.get(competitionId) ?? []).map((id) => this.seasons.get(id)!).filter(Boolean);
    }
    return [...this.seasons.values()];
  }

  listByCompetition(competitionId: CompetitionId): Season[] {
    return this.list(competitionId);
  }

  getActive(competitionId: CompetitionId): Season | undefined {
    return this.listByCompetition(competitionId).find((s) => s.state === "active");
  }

  getLatest(competitionId: CompetitionId): Season | undefined {
    const seasons = this.listByCompetition(competitionId);
    return seasons[seasons.length - 1];
  }

  activate(id: SeasonId): Season {
    const season = this.seasons.get(id);
    if (!season) throw new CompetitionError({ code: "eks.competition.season.not_found", category: "not_found", message: "Season not found." });
    if (!SEASON_TRANSITIONS[season.state].includes("active")) {
      throw new CompetitionError({ code: "eks.competition.season.invalid_transition", category: "state_conflict", message: `Cannot activate from ${season.state}.` });
    }
    // Deactivate any other active season in the same competition
    const currentActive = this.getActive(season.competitionId);
    if (currentActive && currentActive.id !== id) {
      this.archive(currentActive.id);
    }
    const updated: Season = { ...season, state: "active", activatedAt: getClock().iso() };
    this.seasons.set(id, updated);
    void getEventBus().publish(buildEvent(COMPETITION_EVENTS.seasonStarted, { seasonId: id, competitionId: season.competitionId }, {}, "domain"));
    return updated;
  }

  archive(id: SeasonId): Season {
    const season = this.seasons.get(id);
    if (!season) throw new CompetitionError({ code: "eks.competition.season.not_found", category: "not_found", message: "Season not found." });
    if (!SEASON_TRANSITIONS[season.state].includes("archived")) {
      throw new CompetitionError({ code: "eks.competition.season.invalid_transition", category: "state_conflict", message: `Cannot archive from ${season.state}.` });
    }
    const updated: Season = { ...season, state: "archived", archivedAt: getClock().iso() };
    this.seasons.set(id, updated);
    void getEventBus().publish(buildEvent(COMPETITION_EVENTS.seasonClosed, { seasonId: id, competitionId: season.competitionId }, {}, "domain"));
    return updated;
  }

  cancel(id: SeasonId): Season {
    const season = this.seasons.get(id);
    if (!season) throw new CompetitionError({ code: "eks.competition.season.not_found", category: "not_found", message: "Not found." });
    const updated: Season = { ...season, state: "cancelled" };
    this.seasons.set(id, updated);
    return updated;
  }

  /** Create the next season based on the type of the current one. */
  createNext(competitionId: CompetitionId): Season | undefined {
    const latest = this.getLatest(competitionId);
    if (!latest) return undefined;
    const duration = new Date(latest.endsAt).getTime() - new Date(latest.startsAt).getTime();
    const newStart = latest.endsAt;
    const newEnd = new Date(new Date(newStart).getTime() + duration).toISOString();
    return this.create({
      competitionId,
      name: this.generateNextName(latest),
      type: latest.type,
      startsAt: newStart,
      endsAt: newEnd,
      parentSeasonId: latest.id,
    });
  }

  private generateNextName(latest: Season): string {
    const seq = latest.sequence + 1;
    switch (latest.type) {
      case "weekly": return `Week ${seq}`;
      case "monthly": return `Month ${seq}`;
      case "quarterly": return `Q${Math.ceil(seq / 4)} Y${Math.ceil(seq / 4)}`;
      case "annual": return `Year ${seq}`;
      default: return `Season ${seq}`;
    }
  }

  /** Sweep: activate upcoming seasons whose start time has arrived, archive active ones past end time. */
  sweep(): { activated: number; archived: number } {
    const now = Date.now();
    let activated = 0, archived = 0;
    for (const [id, season] of this.seasons) {
      if (season.state === "upcoming" && new Date(season.startsAt).getTime() <= now) {
        try { this.activate(id); activated++; } catch { /* another season active */ }
      }
      if (season.state === "active" && new Date(season.endsAt).getTime() <= now) {
        try { this.archive(id); archived++; } catch { /* ignore */ }
      }
    }
    return { activated, archived };
  }

  getStats(): { total: number; active: number; upcoming: number; archived: number } {
    const list = [...this.seasons.values()];
    return {
      total: list.length,
      active: list.filter((s) => s.state === "active").length,
      upcoming: list.filter((s) => s.state === "upcoming").length,
      archived: list.filter((s) => s.state === "archived").length,
    };
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _mgr: SeasonManager | null = null;
export function getSeasons(): SeasonManager {
  if (!_mgr) _mgr = new SeasonManager();
  return _mgr;
}
