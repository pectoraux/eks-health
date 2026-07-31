/**
 * Eks-Health Achievement Engine — Public API Barrel
 *
 * Import from `@/achievements` (server-only). The achievement engine is a
 * generic gamification layer: badges, XP, levels, collections, and milestones.
 * It builds on the kernel (events, ids, errors), identity (accounts), and
 * programs (programId). It references missions, competitions, health, and
 * technicians only through AchievementTrigger — never duplicating their logic.
 */

export * from "./core";
export * from "./badges";
export * from "./levels";
export * from "./collections";
