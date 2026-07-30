/**
 * Eks-Health Program Operating System — Public API Barrel
 *
 * Import from `@/programs` (server-only). The Program OS is the secure
 * runtime that hosts third-party health programs. The platform itself knows
 * only generic concepts — never disease-specific logic.
 */

export * from "./core";
export * from "./manifests";
export * from "./capabilities";
export * from "./lifecycle";
export * from "./sandbox";
export * from "./quotas";
export * from "./storage";
export * from "./events";
export * from "./certification";
export * from "./sdk";
export * from "./testing";
export * from "./dependencies";
export * from "./marketplace";
export * from "./observability";
export * from "./developer";
export * from "./execution";

// Boot sequence
export { bootPrograms, programsInfo, programsSnapshot, seedProgramDemoData } from "./boot";
