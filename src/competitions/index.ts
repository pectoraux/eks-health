/**
 * Eks-Health Competition Platform — Public API Barrel
 *
 * Import from `@/competitions` (server-only). The platform understands ONLY
 * generic concepts (Competition, Season, League, Division, Score, Metric,
 * Leaderboard, Reward Schedule, Prize Pool, Ranking, Eligibility,
 * Qualification) — never health-specific concepts.
 */

export * from "./core";
export * from "./competitions";
export * from "./seasons";
export * from "./divisions";
export * from "./scoring";
export * from "./leaderboards";
export * from "./ranking";
export * from "./qualification";
export * from "./rewards";
export * from "./prize-pools";
export * from "./anti-cheating";
// analytics re-exports ParticipationStats which qualification also exports.
export type {
  CompetitionAnalytics,
  ScoreDistribution,
  LeaderboardDynamics,
  ImprovementTrend,
  RewardUtilization,
  PrizePoolGrowth,
  HistoricalComparison,
} from "./analytics";
export { getCompetitionAnalytics } from "./analytics";

// Boot sequence
export { bootCompetitions, competitionsInfo, competitionsSnapshot, seedCompetitionDemoData } from "./boot";
