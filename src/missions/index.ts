/**
 * Eks-Health Mission Engine — Public API Barrel
 *
 * Import from `@/missions` (server-only). The platform understands ONLY
 * generic concepts (Mission, Goal, Plan, Task, Habit, Milestone,
 * Recommendation, Workflow, Context, Outcome) — never health-specific
 * coaching logic.
 */

export * from "./core";
export * from "./missions";
export * from "./goals";
// habits re-exports Streak which core also exports — re-export explicitly.
export type {
  Habit,
  HabitCompletion,
} from "./habits";
export {
  HabitManager,
  getHabits,
} from "./habits";
export * from "./plans";
export * from "./personalization";
export * from "./knowledge";
export * from "./explainability";
export * from "./notifications";

// Boot sequence
export { bootMissions, missionsInfo, missionsSnapshot, seedMissionDemoData } from "./boot";
