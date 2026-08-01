/** Eks-Health Research Platform — Boot Sequence */
import "server-only";
import { getEventBus, buildEvent, getClock, bootKernel } from "@/kernel";
import { bootIdentity } from "@/identity";
import { bootPrograms } from "@/programs";
import { bootHealth } from "@/health";
import { bootTechnicians } from "@/technicians";
import { bootCompetitions } from "@/competitions";
import { bootMissions } from "@/missions";
import { bootDeveloper } from "@/developer";
import { bootMarketplace } from "@/marketplace";
import { getResearchConsent } from "./consent";
import { getCohorts } from "./cohorts";
import { getPrivacy } from "./privacy";
import { getEvidenceEngine } from "./evidence";
import { getPopulation } from "./population";
import { getBenchmarks } from "./benchmarks";
import { getComparative } from "./comparative";
import { getWorkspaces } from "./workspace";
import { getPublications } from "./publications";
import { getInsights } from "./ai-insights";
import { getGovernance } from "./governance";
import { getDatasets } from "./datasets";
import { RESEARCH_EVENTS } from "./core";
import { asAccountId } from "@/identity";

export interface ResearchInfo { readonly name: string; readonly version: string; readonly bootedAt: string; readonly subsystems: string[]; }
let _booted = false; let _info: ResearchInfo | null = null;

export function bootResearch(): ResearchInfo {
  if (_booted && _info) return _info;
  bootKernel(); bootIdentity(); bootPrograms(); bootHealth(); bootTechnicians(); bootCompetitions(); bootMissions(); bootDeveloper(); bootMarketplace();
  getResearchConsent(); getCohorts(); getPrivacy(); getEvidenceEngine(); getPopulation(); getBenchmarks(); getComparative(); getWorkspaces(); getPublications(); getInsights(); getGovernance(); getDatasets();
  _booted = true;
  _info = { name: "Eks-Health Research & Population Intelligence Platform", version: "10.0.0-m10", bootedAt: getClock().iso(), subsystems: ["core","consent","cohorts","privacy","evidence","population","benchmarks","comparative","workspace","publications","ai-insights","governance","datasets"] };
  void getEventBus().publish(buildEvent(RESEARCH_EVENTS.consentGranted, { version: _info.version }, {}, "system"));
  return _info;
}
export function researchInfo(): ResearchInfo { if (!_info) _info = { name: "Eks-Health Research & Population Intelligence Platform", version: "10.0.0-m10", bootedAt: getClock().iso(), subsystems: [] }; return _info; }

export function researchSnapshot() {
  if (!_booted) bootResearch();
  const consent = getResearchConsent();
  const privacy = getPrivacy();
  const evidence = getEvidenceEngine();
  const population = getPopulation();
  const benchmarks = getBenchmarks();
  const comparative = getComparative();
  const workspaces = getWorkspaces();
  const publications = getPublications();
  const insights = getInsights();
  const governance = getGovernance();
  const datasets = getDatasets();
  const cohorts = getCohorts();
  return {
    info: researchInfo(),
    consent: { stats: consent.getStats(), types: consent.getActiveConsents(asAccountId("acc_demo_1")).map((c) => ({ type: c.type, status: c.status, purpose: c.purpose, expiresAt: c.expiresAt })) },
    privacy: privacy.getStats(),
    evidence: evidence.getStats(),
    population: { latest: population.getLatest(), stats: population.getStats() },
    benchmarks: benchmarks.getStats(),
    comparative: comparative.getStats(),
    workspaces: workspaces.getStats(),
    publications: publications.getStats(),
    insights: insights.getStats(),
    governance: governance.getStats(),
    datasets: datasets.getStats(),
    cohorts: cohorts.getStats(),
  };
}

let _seeded = false;
export function seedResearchDemoData(): void {
  if (_seeded) return; if (!_booted) bootResearch();
  const consent = getResearchConsent();
  const participantId = asAccountId("acc_demo_1");
  // Grant demo research consents
  try { consent.grant({ participantId, type: "anonymous_research", purpose: "Contribute anonymized data to general health research", scope: ["measurements", "outcomes"], grantedBy: participantId }); } catch { /* */ }
  try { consent.grant({ participantId, type: "program_improvement", purpose: "Help improve the programs I use", scope: ["measurements", "mission_completion", "competition_results"], grantedBy: participantId }); } catch { /* */ }
  try { consent.grant({ participantId, type: "ai_training", purpose: "Help train better AI health coaches", scope: ["measurements", "behavioral_patterns"], grantedBy: participantId }); } catch { /* */ }

  // Create demo datasets — use a fixed cohort ID (cohort create is async,
  // but datasets.create only needs the ID as a reference string)
  const datasets = getDatasets();
  const effectiveCohortId = "coh_demo_1";

  try {
    datasets.create({
      name: "Cardiovascular Health Outcomes",
      description: "Anonymized dataset of cardiovascular measurement trends and program outcomes.",
      cohortId: effectiveCohortId as never,
      dataCategories: ["measurements", "outcomes", "demographics"],
      privacyLevel: "pseudonymized",
      kAnonymityThreshold: 5,
      createdBy: participantId,
      retentionDays: 365,
    });
  } catch { /* already exists */ }
  try {
    datasets.create({
      name: "Sleep Quality Improvement Study",
      description: "Sleep duration and quality metrics from Sleep Optimizer program participants.",
      cohortId: effectiveCohortId as never,
      dataCategories: ["measurements", "behavioral_patterns"],
      privacyLevel: "aggregated",
      kAnonymityThreshold: 10,
      createdBy: participantId,
      retentionDays: 180,
    });
  } catch { /* already exists */ }

  // Generate demo AI insights
  const insights = getInsights();
  try {
    insights.generate({
      type: "trend" as never,
      createdBy: participantId,
      programId: "prg_cardio_care" as never,
      metric: "resting_heart_rate",
      categoryFocus: "cardiovascular",
      areaOfInterest: "improvement_over_30_days",
      horizonDays: 30,
    });
  } catch { /* */ }
  try {
    insights.generate({
      type: "comparison" as never,
      createdBy: participantId,
      programIds: ["prg_cardio_care", "prg_sleep_optimizer"] as never,
      metric: "participant_engagement",
      areaOfInterest: "program_effectiveness",
      horizonDays: 90,
    });
  } catch { /* */ }

  // Trigger evidence accumulation for demo programs (async, fire-and-forget,
  // NOT awaited — don't block the seed on this)
  // Skip on serverless to avoid cold-start delays — evidence will accumulate
  // naturally when the evidence API is called.
  // const evidence = getEvidenceEngine();
  // const demoProgramIds = ["prg_cardio_care", "prg_sleep_optimizer", "prg_fit_streak"];
  // for (const pid of demoProgramIds) {
  //   void evidence.accumulate(pid as never).catch(() => { /* graceful */ });
  // }

  _seeded = true;
}
