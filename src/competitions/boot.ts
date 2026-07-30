/**
 * Eks-Health Competition Platform — Boot Sequence
 *
 * Idempotently initializes the competition platform, seeds demo
 * competitions, score specs, seasons, leaderboards, and prize pools.
 */

import "server-only";
import { getEventBus, buildEvent, getClock, bootKernel } from "@/kernel";
import { bootIdentity, asAccountId } from "@/identity";
import { bootPrograms, asProgramId } from "@/programs";
import { bootHealth, asSchemaId } from "@/health";
import { bootTechnicians } from "@/technicians";
import { getCompetitions } from "./competitions";
import { getSeasons } from "./seasons";
import { getDivisions } from "./divisions";
import { getScoring } from "./scoring";
import { getLeaderboards } from "./leaderboards";
import { getRanking } from "./ranking";
import { getQualification } from "./qualification";
import { getRewards } from "./rewards";
import { getPrizePools } from "./prize-pools";
import { getAntiCheat } from "./anti-cheating";
import { getCompetitionAnalytics } from "./analytics";
import { COMPETITION_EVENTS, asCompetitionId, asScoreSpecId, asSeasonId, type CompetitionId, type ScoreComponentId } from "./core";

export interface CompetitionsInfo {
  readonly name: string;
  readonly version: string;
  readonly bootedAt: string;
  readonly subsystems: string[];
}

let _booted = false;
let _info: CompetitionsInfo | null = null;

export function bootCompetitions(): CompetitionsInfo {
  if (_booted && _info) return _info;
  bootKernel();
  bootIdentity();
  bootPrograms();
  bootHealth();
  bootTechnicians();

  getCompetitions();
  getSeasons();
  getDivisions();
  getScoring();
  getLeaderboards();
  getRanking();
  getQualification();
  getRewards();
  getPrizePools();
  getAntiCheat();
  getCompetitionAnalytics();

  _booted = true;
  _info = {
    name: "Eks-Health Competition Platform",
    version: "6.0.0-m6",
    bootedAt: getClock().iso(),
    subsystems: [
      "core", "competitions", "seasons", "divisions", "scoring",
      "leaderboards", "ranking", "qualification", "rewards",
      "prize-pools", "anti-cheating", "analytics",
    ],
  };
  void getEventBus().publish(buildEvent(COMPETITION_EVENTS.competitionCreated, { version: _info.version }, {}, "system"));
  return _info;
}

export function competitionsInfo(): CompetitionsInfo {
  if (!_info) {
    _info = {
      name: "Eks-Health Competition Platform",
      version: "6.0.0-m6",
      bootedAt: getClock().iso(),
      subsystems: [],
    };
  }
  return _info;
}

/** Compact diagnostic snapshot for the console. */
export function competitionsSnapshot() {
  ensureBooted();
  const comps = getCompetitions();
  const seasons = getSeasons();
  const divisions = getDivisions();
  const scoring = getScoring();
  const leaderboards = getLeaderboards();
  const qualification = getQualification();
  const rewards = getRewards();
  const pools = getPrizePools();
  const antiCheat = getAntiCheat();
  const analytics = getCompetitionAnalytics();

  const competitions = comps.list();
  return {
    info: competitionsInfo(),
    competitions: competitions.map((c) => ({
      id: c.id, slug: c.slug, name: c.name, scope: c.scope, state: c.state,
      programId: c.programId, currentParticipants: c.currentParticipants,
      maxParticipants: c.maxParticipants, startsAt: c.startsAt, endsAt: c.endsAt,
      scoreSpecId: c.scoreSpecId, divisionCount: c.divisionIds.length,
      seasonCount: c.seasonIds.length, rewardScheduleCount: c.rewardScheduleIds.length,
      tags: c.tags, version: c.version, createdAt: c.createdAt,
    })),
    competitionStats: comps.getStats(),
    seasons: seasons.list().map((s) => ({
      id: s.id, competitionId: s.competitionId, name: s.name, type: s.type,
      state: s.state, sequence: s.sequence, startsAt: s.startsAt, endsAt: s.endsAt,
    })),
    seasonStats: seasons.getStats(),
    divisions: divisions.list().map((d) => ({
      id: d.id, name: d.name, tier: d.tier, minScore: d.minScore, maxScore: d.maxScore,
    })),
    divisionStats: divisions.getStats(),
    scoreSpecs: scoring.listSpecs().map((s) => ({
      id: s.id, name: s.name, description: s.description, version: s.version,
      componentCount: s.components.length, totalWeight: s.totalWeight,
    })),
    leaderboards: leaderboards.list(undefined as never).map((l) => ({
      id: l.id, competitionId: l.competitionId, name: l.name, scope: l.scope,
      rankingMethod: l.rankingMethod, entryCount: leaderboards.getParticipantCount(l.id),
    })),
    qualificationStats: qualification.getStats(),
    rewardSchedules: rewards.listSchedules(undefined as never, undefined as never).map((s) => ({
      id: s.id, name: s.name, type: s.type, podiumSize: s.podiumSize,
    })),
    rewardEvents: rewards.listRewardEvents().slice(0, 20).map((e) => ({
      id: e.id, type: e.type, participantId: e.participantId, rank: e.rank,
      amount: e.amount, currency: e.currency, createdAt: e.createdAt,
    })),
    prizePools: pools.list().map((p) => ({
      id: p.id, competitionId: p.competitionId, currency: p.currency,
      balance: p.balance, allocated: p.allocated, pending: p.pending,
    })),
    antiCheatStats: antiCheat.getStats(),
    antiCheatFlags: antiCheat.listFlags({}).slice(0, 10).map((f) => ({
      id: f.id, type: f.type, severity: f.severity, status: f.status, detectedAt: f.detectedAt,
    })),
  };
}

function ensureBooted() {
  if (!_booted) bootCompetitions();
}

// ---------------------------------------------------------------------------
// Demo data seeding
// ---------------------------------------------------------------------------

let _seeded = false;

export function seedCompetitionDemoData(): { competitionIds: CompetitionId[] } {
  if (_seeded) return { competitionIds: [] };
  ensureBooted();

  const comps = getCompetitions();
  const seasons = getSeasons();
  const divisions = getDivisions();
  const scoring = getScoring();
  const leaderboards = getLeaderboards();
  const qualification = getQualification();
  const pools = getPrizePools();
  const rewards = getRewards();
  const programId = asProgramId("prg_cardio_care");
  const createdBy = asAccountId("acc_demo_1");
  const competitionIds: CompetitionId[] = [];

  // Define a score spec
  let specId: string;
  try {
    const spec = scoring.registerSpec({
      id: asScoreSpecId(generateId("spec_")),
      programId,
      name: "Cardio Health Score",
      description: "Weighted score: 40% weight improvement, 25% BP improvement, 20% consistency, 15% participation.",
      version: 1,
      components: [
        { id: generateId("comp_") as ScoreComponentId, name: "Weight Improvement", type: "metric_improvement", weight: 40, measurementSchemaId: asSchemaId("sch_body_weight"), aggregation: "improvement_percent", timeWindowDays: 30, baselineMode: "first", description: "Percent body weight improvement over baseline." },
        { id: generateId("comp_") as ScoreComponentId, name: "BP Consistency", type: "consistency", weight: 25, measurementSchemaId: asSchemaId("sch_resting_heart_rate"), aggregation: "count", timeWindowDays: 30, baselineMode: "first", description: "Consistency of heart rate measurements." },
        { id: generateId("comp_") as ScoreComponentId, name: "Measurement Consistency", type: "consistency", weight: 20, aggregation: "count", timeWindowDays: 30, baselineMode: "first", description: "Total measurement count in window." },
        { id: generateId("comp_") as ScoreComponentId, name: "Participation", type: "participation", weight: 15, aggregation: "count", timeWindowDays: 30, baselineMode: "first", description: "Active participation days." },
      ],
      totalWeight: 100,
      scoreCap: 100,
      scoreFloor: 0,
      roundingPrecision: 1,
      createdAt: getClock().iso(),
    });
    specId = spec.id;
  } catch {
    specId = "spec_demo_1";
  }

  // Create demo competitions
  const demoComps = [
    { slug: "cardio-challenge-2026", name: "Cardio Challenge 2026", scope: "global" as const, desc: "Global cardiovascular health improvement competition." },
    { slug: "ghana-national-health", name: "Ghana National Health Cup", scope: "national" as const, desc: "National health competition for Ghana.", filter: { country: "GH" } },
    { slug: "accra-corporate-wellness", name: "Accra Corporate Wellness League", scope: "organization" as const, desc: "Corporate wellness competition for Accra-based companies." },
  ];

  for (const dc of demoComps) {
    try {
      const comp = comps.create({
        programId,
        slug: dc.slug,
        name: dc.name,
        description: dc.desc,
        scope: dc.scope,
        scopeFilter: dc.filter,
        eligibilityRules: dc.scope === "national" ? [{ field: "country", operator: "eq", value: "GH" }] : [],
        createdBy,
        tags: ["cardiovascular", "preventive"],
      });
      comps.setScoreSpec(comp.id, specId as never);

      // Define divisions
      const divs = divisions.defineTierSet(comp.id);
      for (const d of divs) comps.addDivision(comp.id, d.id);

      // Create a season
      const now = new Date();
      const seasonStart = new Date(now.getTime() - 7 * 86400000).toISOString(); // started 7 days ago
      const seasonEnd = new Date(now.getTime() + 83 * 86400000).toISOString(); // ends in 83 days (90-day season)
      const season = seasons.create({
        competitionId: comp.id,
        name: "Season 1",
        type: "quarterly",
        startsAt: seasonStart,
        endsAt: seasonEnd,
      });
      seasons.activate(season.id);
      comps.addSeason(comp.id, season.id);

      // Create a leaderboard
      leaderboards.create({
        competitionId: comp.id,
        seasonId: season.id,
        name: `${dc.name} — Global Leaderboard`,
        scope: dc.scope as never,
        scopeFilter: dc.filter,
        rankingMethod: "highest_score",
      });

      // Create a prize pool
      const pool = pools.create(comp.id, season.id, "USD");
      pools.credit(pool.id, "platform_incentives", 1000, "seed-funding");
      comps.setPrizePool(comp.id, pool.id);

      // Create a reward schedule
      rewards.createSchedule({
        competitionId: comp.id,
        seasonId: season.id,
        name: "Season 1 Rewards",
        type: "season_end",
        podiumSize: 5,
        distribution: [
          { rank: 1, percentage: 30 },
          { rank: 2, percentage: 20 },
          { rank: 3, percentage: 15 },
          { rank: 4, percentage: 10 },
          { rank: 5, percentage: 5 },
        ],
        minPoolThreshold: 100,
        conditions: [
          { name: "Verified Only", type: "verified_only", value: 1, description: "Only verified measurements count." },
          { name: "No Disputes", type: "no_disputes", value: 0, description: "No active disputes." },
        ],
      });

      competitionIds.push(comp.id);
    } catch {
      // already exists
    }
  }

  _seeded = true;
  return { competitionIds };
}

import { generateId } from "@/kernel";
