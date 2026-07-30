/**
 * Eks-Health Universal Health Data Platform — Public API Barrel
 *
 * Import from `@/health` (server-only). The platform understands ONLY
 * generic concepts — never disease-specific fields.
 */

export * from "./core";
export * from "./schemas";
export * from "./units";
export * from "./sources";
// measurements, evidence, verification, provenance, timeline, composite,
// derived, validation, profiles, search, interop, versioning, analytics
// all re-export types that may collide (Measurement, EvidenceRequirement,
// MeasurementQuery are defined locally in several). Re-export explicitly.
export {
  type Measurement,
  type MeasurementRecord,
  type MeasurementFilter,
  type TrendResult,
  type MeasurementStats,
  MeasurementStore,
  getMeasurements,
} from "./measurements";
export {
  type Evidence,
  type EvidenceUpload,
  EvidenceManager,
  getEvidence,
} from "./evidence";
export {
  type VerificationRequest,
  VerificationManager,
  getVerification,
} from "./verification";
export {
  type ProvenanceChain,
  type ProvenanceQuery,
  type ProvenanceReport,
  ProvenanceManager,
  getProvenance,
} from "./provenance";
export {
  type Timeline,
  type TimelineEntry,
  type TimelineComparison,
  TimelineManager,
  getTimeline,
} from "./timeline";
export {
  type CompositeMetric,
  type CompositeResult,
  CompositeEngine,
  getComposite,
} from "./composite";
export {
  type DerivedMetric,
  type DerivationResult,
  DerivedEngine,
  getDerived,
} from "./derived";
export {
  type ValidationResult,
  type ValidationRule,
  ValidationEngine,
  getValidation,
} from "./validation";
export {
  type HealthProfile,
  type ProfileDemographics,
  ProfileManager,
  getProfiles,
} from "./profiles";
export {
  type SearchQuery,
  type SearchResult,
  HealthSearchEngine,
  getHealthSearch,
} from "./search";
export {
  type FhirResource,
  type ImportResult,
  InteropManager,
  getInterop,
} from "./interop";
export {
  type VersionDiff,
  type CompatibilityReport,
  VersioningManager,
  getVersioning,
} from "./versioning";
export {
  type PopulationStat,
  type LongitudinalAnalysis,
  AnalyticsEngine,
  getAnalytics,
} from "./analytics";

// Boot sequence
export { bootHealth, healthInfo, healthSnapshot, seedHealthDemoData } from "./boot";
