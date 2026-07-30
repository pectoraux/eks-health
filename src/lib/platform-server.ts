/**
 * Server-side platform access helper.
 *
 * Boots the kernel + identity platform once (idempotent) and exposes typed
 * accessors for route handlers. Singletons persist for the Node process
 * lifetime, so state accumulates across requests — what a console needs.
 */

import "server-only";
import {
  bootKernel,
  kernelInfo,
  kernelSnapshot,
  getEventBus,
  getFlags,
  getConfiguration,
  getScheduler,
  getObservability,
  getRegistry,
  getTenants,
  getSecurity,
  getGateway,
  getTime,
  getI18n,
  getStorage,
  getSearch,
  getNotifications,
  type KernelError,
} from "@/kernel";
import {
  bootIdentity,
  identityInfo,
  identitySnapshot,
  seedIdentityDemoData,
  getAccounts,
  getAuth,
  getSessions,
  getDevices,
  getOrganizations,
  getRoles,
  getAuthorization,
  getConsent,
  getPrivacy,
  getDataGateway,
  getAudit,
  getSecurityPolicies,
  getMonitoring,
  getCompliance,
  type IdentityError,
} from "@/identity";
import {
  bootPrograms,
  programsInfo,
  programsSnapshot,
  seedProgramDemoData,
  getRegistry as getProgramRegistry,
  getCapabilities as getProgramCapabilities,
  getCertification,
  getSdk,
  getMarketplace,
  getProgramObservability,
  getDeveloperManager,
  getExecutionManager,
  getSandboxManager,
  getQuotas,
  getProgramStorage,
  getProgramEvents,
  getDependencies,
  getTesting,
  type ProgramError,
} from "@/programs";
import {
  bootHealth,
  healthInfo,
  healthSnapshot,
  seedHealthDemoData,
  getSchemas as getHealthSchemas,
  getMeasurements as getHealthMeasurements,
  getEvidence as getHealthEvidence,
  getSources as getHealthSources,
  getProfiles as getHealthProfiles,
  getUnits as getHealthUnits,
  getComposite as getHealthComposite,
  getDerived as getHealthDerived,
  getAnalytics as getHealthAnalytics,
  getInterop as getHealthInterop,
  getHealthSearch,
  type HealthError,
} from "@/health";
import {
  bootTechnicians,
  techniciansInfo,
  techniciansSnapshot,
  seedTechnicianDemoData,
  getTechnicians as getTechnicianRegistry,
  getCertifications as getCertificationRegistry,
  getAccreditation as getAccreditationRegistry,
  getSessions as getSessionManager,
  getAppointments as getAppointmentManager,
  getReputation as getReputationManager,
  getDisputes as getDisputeManager,
  getDevices as getDeviceRegistry,
  getFraudDetection,
  getPayments,
  getEligibility,
  getDiscovery,
  type TechnicianError,
} from "@/technicians";
import {
  bootCompetitions,
  competitionsInfo,
  competitionsSnapshot,
  seedCompetitionDemoData,
  getCompetitions as getCompetitionRegistry,
  getSeasons as getSeasonManager,
  getDivisions as getDivisionManager,
  getScoring as getScoreCompiler,
  getLeaderboards as getLeaderboardManager,
  getRanking as getRankingEngine,
  getQualification as getQualificationManager,
  getRewards as getRewardManager,
  getPrizePools as getPrizePoolManager,
  getAntiCheat as getAntiCheatEngine,
  getCompetitionAnalytics as getCompetitionAnalyticsEngine,
  type CompetitionError,
} from "@/competitions";
import {
  bootMissions,
  missionsInfo,
  missionsSnapshot,
  seedMissionDemoData,
  getMissions as getMissionManager,
  getGoals as getGoalManager,
  getHabits as getHabitManager,
  getPlans as getPlanManager,
  getKnowledge as getKnowledgeManager,
  getPersonalization as getPersonalizationEngine,
  getExplainability as getExplainabilityEngine,
  getReminders as getReminderManager,
  type MissionError,
} from "@/missions";
import {
  bootDeveloper,
  developerInfo,
  developerSnapshot,
  seedDeveloperDemoData,
  getCli,
  getSimulator,
  getDesigner,
  getWorkflowBuilder,
  getDebugger,
  getInspector,
  getApiExplorer,
  getDocsGenerator,
  getSampleLibrary,
  type DeveloperError,
} from "@/developer";
import {
  bootMarketplace,
  marketplaceInfo,
  marketplaceSnapshot,
  seedMarketplaceDemoData,
  getProfiles as getListingRegistry,
  getDiscovery as getDiscoveryEngine,
  getMatching as getSolutionMatcher,
  getOutcomes as getOutcomeTracker,
  getEvidence as getEvidenceManager,
  getComparison as getComparisonEngine,
  getCollections as getCollectionManager,
  getMonetization as getMonetizationManager,
  getRevenue as getRevenueShareEngine,
  getReviews as getReviewManager,
  getMarketplaceAnalytics,
  type MarketplaceError,
} from "@/marketplace";

let _booted = false;
export function ensurePlatform() {
  if (!_booted) {
    bootKernel();
    bootIdentity();
    seedIdentityDemoData();
    bootPrograms();
    seedProgramDemoData();
    bootHealth();
    seedHealthDemoData();
    bootTechnicians();
    seedTechnicianDemoData();
    bootCompetitions();
    seedCompetitionDemoData();
    bootMissions();
    seedMissionDemoData();
    bootDeveloper();
    seedDeveloperDemoData();
    bootMarketplace();
    seedMarketplaceDemoData();
    _booted = true;
  }
  return { kernel: kernelInfo(), identity: identityInfo(), programs: programsInfo(), health: healthInfo(), technicians: techniciansInfo(), competitions: competitionsInfo(), missions: missionsInfo(), developer: developerInfo(), marketplace: marketplaceInfo() };
}

export function platformSnapshot() {
  ensurePlatform();
  return { kernel: kernelSnapshot(), identity: identitySnapshot(), programs: programsSnapshot(), health: healthSnapshot(), technicians: techniciansSnapshot(), competitions: competitionsSnapshot(), missions: missionsSnapshot(), developer: developerSnapshot(), marketplace: marketplaceSnapshot() };
}

export {
  getEventBus,
  getFlags,
  getConfiguration,
  getScheduler,
  getObservability,
  getRegistry,
  getTenants,
  getSecurity,
  getGateway,
  getTime,
  getI18n,
  getStorage,
  getSearch,
  getNotifications,
  getAccounts,
  getAuth,
  getSessions,
  getDevices,
  getOrganizations,
  getRoles,
  getAuthorization,
  getConsent,
  getPrivacy,
  getDataGateway,
  getAudit,
  getSecurityPolicies,
  getMonitoring,
  getCompliance,
  getProgramRegistry,
  getProgramCapabilities,
  getCertification,
  getSdk,
  getMarketplace,
  getProgramObservability,
  getDeveloperManager,
  getExecutionManager,
  getSandboxManager,
  getQuotas,
  getProgramStorage,
  getProgramEvents,
  getDependencies,
  getTesting,
  getHealthSchemas,
  getHealthMeasurements,
  getHealthEvidence,
  getHealthSources,
  getHealthProfiles,
  getHealthUnits,
  getHealthComposite,
  getHealthDerived,
  getHealthAnalytics,
  getHealthInterop,
  getHealthSearch,
  getTechnicianRegistry,
  getCertificationRegistry,
  getAccreditationRegistry,
  getSessionManager,
  getAppointmentManager,
  getReputationManager,
  getDisputeManager,
  getDeviceRegistry,
  getFraudDetection,
  getPayments,
  getEligibility,
  getDiscovery,
  getCompetitionRegistry,
  getSeasonManager,
  getDivisionManager,
  getScoreCompiler,
  getLeaderboardManager,
  getRankingEngine,
  getQualificationManager,
  getRewardManager,
  getPrizePoolManager,
  getAntiCheatEngine,
  getCompetitionAnalyticsEngine,
  getMissionManager,
  getGoalManager,
  getHabitManager,
  getPlanManager,
  getKnowledgeManager,
  getPersonalizationEngine,
  getExplainabilityEngine,
  getReminderManager,
  getCli,
  getSimulator,
  getDesigner,
  getWorkflowBuilder,
  getDebugger,
  getInspector,
  getApiExplorer,
  getDocsGenerator,
  getSampleLibrary,
  getListingRegistry,
  getDiscoveryEngine,
  getSolutionMatcher,
  getOutcomeTracker,
  getEvidenceManager,
  getComparisonEngine,
  getCollectionManager,
  getMonetizationManager,
  getRevenueShareEngine,
  getReviewManager,
  getMarketplaceAnalytics,
};

/** Wrap a handler so the platform is booted and errors become JSON. */
export function withPlatform<T>(
  fn: () => T | Promise<T>,
): Promise<Response> {
  return Promise.resolve()
    .then(() => {
      ensurePlatform();
      return fn();
    })
    .then((data) =>
      Response.json({
        ok: true,
        data,
        meta: { kernel: kernelInfo().version, identity: identityInfo().version, programs: programsInfo().version, health: healthInfo().version, technicians: techniciansInfo().version, competitions: competitionsInfo().version, missions: missionsInfo().version, developer: developerInfo().version, marketplace: marketplaceInfo().version, at: new Date().toISOString() },
      }),
    )
    .catch((err: unknown) => {
      // MarketplaceError
      if (err && typeof err === "object" && "category" in err && "code" in err && "userMessage" in err && typeof (err as { code: string }).code === "string" && (err as { code: string }).code.startsWith("eks.marketplace.")) {
        const e = err as MarketplaceError;
        const body = { ok: false, error: e.toJSON() };
        const status =
          e.category === "validation" ? 400 :
          e.category === "not_found" ? 404 :
          e.category === "not_authorized" ? 403 :
          e.category === "payment_required" ? 402 :
          e.category === "state_conflict" ? 409 :
          e.category === "not_available" ? 410 :
          e.category === "quota_exceeded" ? 429 : 500;
        return Response.json(body, { status });
      }
      // DeveloperError
      if (err && typeof err === "object" && "category" in err && "code" in err && "userMessage" in err && typeof (err as { code: string }).code === "string" && (err as { code: string }).code.startsWith("eks.developer.")) {
        const e = err as DeveloperError;
        const body = { ok: false, error: e.toJSON() };
        const status =
          e.category === "validation" ? 400 :
          e.category === "not_found" ? 404 :
          e.category === "not_authorized" ? 403 :
          e.category === "state_conflict" ? 409 :
          e.category === "build_failed" || e.category === "certification_blocked" ? 422 :
          e.category === "quota_exceeded" ? 429 : 500;
        return Response.json(body, { status });
      }
      // MissionError
      if (err && typeof err === "object" && "category" in err && "code" in err && "userMessage" in err && typeof (err as { code: string }).code === "string" && ((err as { code: string }).code.startsWith("eks.mission.") || (err as { code: string }).code.startsWith("eks.ai."))) {
        const e = err as MissionError;
        const body = { ok: false, error: e.toJSON() };
        const status =
          e.category === "validation" ? 400 :
          e.category === "not_found" ? 404 :
          e.category === "not_authorized" || e.category === "ai_safety_violation" ? 403 :
          e.category === "state_conflict" || e.category === "version_conflict" ? 409 :
          e.category === "workflow_invalid" ? 422 :
          e.category === "quota_exceeded" ? 429 : 500;
        return Response.json(body, { status });
      }
      // CompetitionError
      if (err && typeof err === "object" && "category" in err && "code" in err && "userMessage" in err && typeof (err as { code: string }).code === "string" && (err as { code: string }).code.startsWith("eks.competition.")) {
        const e = err as CompetitionError;
        const body = { ok: false, error: e.toJSON() };
        const status =
          e.category === "validation" || e.category === "score_invalid" || e.category === "leaderboard_invalid" ? 400 :
          e.category === "not_found" ? 404 :
          e.category === "not_eligible" || e.category === "not_qualified" || e.category === "anti_cheat_violation" ? 403 :
          e.category === "state_conflict" || e.category === "version_conflict" ? 409 :
          e.category === "reward_invalid" ? 422 :
          e.category === "quota_exceeded" ? 429 : 500;
        return Response.json(body, { status });
      }
      // TechnicianError
      if (err && typeof err === "object" && "category" in err && "code" in err && "userMessage" in err && typeof (err as { code: string }).code === "string" && (err as { code: string }).code.startsWith("eks.technician.")) {
        const e = err as TechnicianError;
        const body = { ok: false, error: e.toJSON() };
        const status =
          e.category === "validation" ? 400 :
          e.category === "not_found" ? 404 :
          e.category === "not_certified" || e.category === "not_eligible" || e.category === "device_not_trusted" || e.category === "fraud_detected" ? 403 :
          e.category === "certification_expired" ? 410 :
          e.category === "appointment_conflict" || e.category === "state_conflict" ? 409 :
          e.category === "payment_required" ? 402 :
          e.category === "session_invalid" || e.category === "verification_failed" || e.category === "dispute_invalid" ? 422 : 500;
        return Response.json(body, { status });
      }
      // HealthError
      if (err && typeof err === "object" && "category" in err && "code" in err && "userMessage" in err && typeof (err as { code: string }).code === "string" && (err as { code: string }).code.startsWith("eks.health.")) {
        const e = err as HealthError;
        const body = { ok: false, error: e.toJSON() };
        const status =
          e.category === "schema_invalid" || e.category === "validation_failed" || e.category === "range_exceeded" || e.category === "unit_mismatch" ? 400 :
          e.category === "not_found" ? 404 :
          e.category === "consent_required" || e.category === "verification_required" || e.category === "evidence_required" ? 403 :
          e.category === "duplicate_measurement" || e.category === "version_conflict" || e.category === "state_conflict" ? 409 :
          e.category === "quota_exceeded" ? 429 : 500;
        return Response.json(body, { status });
      }
      // ProgramError
      if (err && typeof err === "object" && "category" in err && "code" in err && "userMessage" in err) {
        const e = err as ProgramError;
        const body = { ok: false, error: e.toJSON() };
        const status =
          e.category === "validation" || e.category === "manifest_invalid" ? 400 :
          e.category === "not_found" ? 404 :
          e.category === "capability_denied" || e.category === "sandbox_violation" ? 403 :
          e.category === "quota_exceeded" ? 429 :
          e.category === "version_conflict" || e.category === "state_conflict" ? 409 :
          e.category === "certification_failed" ? 422 : 500;
        return Response.json(body, { status });
      }
      if (err && typeof err === "object" && "toJSON" in err) {
        const e = err as IdentityError;
        const body = { ok: false, error: e.toJSON() };
        const status =
          e.category === "validation" ? 400 :
          e.category === "not_found" || e.category === "account_not_found" ? 404 :
          e.category === "invalid_credentials" || e.category === "mfa_required" || e.category === "mfa_failed" ||
          e.category === "session_expired" || e.category === "session_revoked" || e.category === "verification_required" ? 401 :
          e.category === "permission_denied" || e.category === "consent_required" || e.category === "consent_denied" ||
          e.category === "device_untrusted" || e.category === "policy_violation" ||
          e.category === "account_disabled" || e.category === "account_locked" ? 403 :
          e.category === "rate_limited" ? 429 :
          e.category === "conflict" ? 409 : 500;
        return Response.json(body, { status });
      }
      const ke = err as KernelError;
      if (ke?.code) {
        const body = { ok: false, error: ke.toJSON() };
        const status =
          ke.category === "validation" ? 400 :
          ke.category === "not_found" ? 404 :
          ke.category === "unauthorized" ? 401 :
          ke.category === "forbidden" ? 403 :
          ke.category === "rate_limited" ? 429 :
          ke.category === "conflict" ? 409 :
          ke.category === "unavailable" ? 503 : 500;
        return Response.json(body, { status });
      }
      return Response.json(
        { ok: false, error: { code: "eks.error.internal", message: err instanceof Error ? err.message : String(err) } },
        { status: 500 },
      );
    });
}
