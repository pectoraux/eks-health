/**
 * Eks-Health Social Platform — Public API Barrel
 *
 * Import from `@/social` (server-only). The social platform is a generic
 * social graph: friends, teams, communities, messaging, invites, and activity
 * feeds. It builds on the kernel (events, ids, errors) and identity (accounts)
 * only — it owns no healthcare concepts.
 */

export * from "./core";
export * from "./friends";
export * from "./teams";
export * from "./communities";
export * from "./messaging";
export * from "./feeds";
export * from "./invites";
