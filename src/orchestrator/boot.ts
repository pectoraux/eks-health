/** Eks-Health Health Orchestrator — Boot Sequence */
import "server-only";
import { getEventBus, buildEvent, getClock, bootKernel } from "@/kernel";
import { bootIdentity, asAccountId } from "@/identity";
import { bootPrograms, asProgramId } from "@/programs";
import { bootHealth } from "@/health";
import { bootTechnicians } from "@/technicians";
import { bootCompetitions } from "@/competitions";
import { bootMissions } from "@/missions";
import { bootDeveloper } from "@/developer";
import { bootMarketplace } from "@/marketplace";
import { bootResearch } from "@/research";
import { getTwin } from "./twin";
import { getContext } from "./context";
import { getScheduler } from "./scheduler";
import { getConflicts } from "./conflicts";
import { getWorkload } from "./workload";
import { getCoordinator } from "./coordinator";
import { getTimeline } from "./timeline";
import { getSharedGoals } from "./shared-goals";
import { getSharedMeasurements } from "./shared-measurements";
import { getOrchestrationAnalytics } from "./analytics";
import { ORCHESTRATOR_EVENTS, type ProgramId } from "./core";

export interface OrchestratorInfo { readonly name: string; readonly version: string; readonly bootedAt: string; readonly subsystems: string[]; }
let _booted = false; let _info: OrchestratorInfo | null = null;

export function bootOrchestrator(): OrchestratorInfo {
  if (_booted && _info) return _info;
  bootKernel(); bootIdentity(); bootPrograms(); bootHealth(); bootTechnicians(); bootCompetitions(); bootMissions(); bootDeveloper(); bootMarketplace(); bootResearch();
  getTwin(); getContext(); getScheduler(); getConflicts(); getWorkload(); getCoordinator(); getTimeline(); getSharedGoals(); getSharedMeasurements(); getOrchestrationAnalytics();
  _booted = true;
  _info = { name: "Eks-Health Health Orchestrator", version: "11.0.0-m11", bootedAt: getClock().iso(), subsystems: ["core","twin","context","scheduler","conflicts","workload","coordinator","timeline","shared-goals","shared-measurements","analytics"] };
  void getEventBus().publish(buildEvent(ORCHESTRATOR_EVENTS.twinUpdated, { version: _info.version }, {}, "system"));
  return _info;
}
export function orchestratorInfo(): OrchestratorInfo { if (!_info) _info = { name: "Eks-Health Health Orchestrator", version: "11.0.0-m11", bootedAt: getClock().iso(), subsystems: [] }; return _info; }

export function orchestratorSnapshot() {
  if (!_booted) bootOrchestrator();
  const twin = getTwin();
  const context = getContext();
  const scheduler = getScheduler();
  const conflicts = getConflicts();
  const workload = getWorkload();
  const coordinator = getCoordinator();
  const timeline = getTimeline();
  const sharedGoals = getSharedGoals();
  const sharedMeasurements = getSharedMeasurements();
  const analytics = getOrchestrationAnalytics();
  return {
    info: orchestratorInfo(),
    twin: twin.getStats(),
    context: context.getStats(),
    scheduler: scheduler.getStats(),
    conflicts: conflicts.getStats(),
    workload: workload.getStats(),
    coordinator: coordinator.getStats(),
    timeline: timeline.getStats(),
    sharedGoals: sharedGoals.getStats(),
    sharedMeasurements: sharedMeasurements.getStats(),
    analytics: { stats: analytics.getStats() },
  };
}

let _seeded = false;
export function seedOrchestratorDemoData(): { twinId?: string } {
  if (_seeded) return {}; if (!_booted) bootOrchestrator();
  const twin = getTwin();
  const participantId = asAccountId("acc_demo_1");
  const programId = asProgramId("prg_cardio_care");
  // Create a Digital Twin
  const t = twin.getOrCreate(participantId);
  twin.setGoals(participantId, [
    { name: "Reduce Blood Pressure", progress: 45, contributors: [programId] },
    { name: "Improve Cardiovascular Fitness", progress: 30, contributors: [programId] },
  ]);
  twin.setRiskIndicators(participantId, [
    { name: "Elevated BP", level: "medium", detail: "Systolic 140mmHg" },
  ]);
  twin.setFatigueScore(participantId, 25);
  twin.recordContribution(participantId, { programId, type: "observation", description: "Resting HR trending down 5% over 2 weeks", value: { trend: "improving" } });
  // Create a shared goal
  const sg = getSharedGoals().create(participantId, "Improve Cardiovascular Health", "Unified goal across multiple programs", 100, "points");
  getSharedGoals().addContributor(sg.id, programId, 30, "Cardio Care contributes exercise + BP monitoring");
  _seeded = true;
  return { twinId: t.id };
}
