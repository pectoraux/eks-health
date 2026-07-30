/**
 * Eks-Health Technician Network — Public API Barrel
 *
 * Import from `@/technicians` (server-only). The platform understands ONLY
 * generic concepts (Technician, Certification, Eligibility, Appointment,
 * Measurement Session, Verification, Evidence, Trust, Reputation,
 * Accreditation) — never profession-specific types.
 */

export * from "./core";
export * from "./profiles";
export * from "./certifications";
export * from "./accreditation";
export * from "./eligibility";
export * from "./sessions";
export * from "./appointments";
// discovery & fraud both export haversineKm — re-export discovery fully,
// then fraud explicitly minus the colliding name.
export * from "./discovery";
export type {
  FraudAlert,
  FraudDetector,
  FraudRiskScore,
  FraudSignal,
  FraudPattern,
} from "./fraud";
export {
  FraudDetectionEngine,
  getFraudDetection,
} from "./fraud";
export * from "./reputation";
export * from "./disputes";
export * from "./devices";
export * from "./chain-of-custody";
export * from "./payments";

// Boot sequence
export { bootTechnicians, techniciansInfo, techniciansSnapshot, seedTechnicianDemoData } from "./boot";
