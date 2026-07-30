/**
 * Eks-Health Developer Platform — Boot Sequence
 */

import "server-only";
import { getEventBus, buildEvent, getClock, bootKernel } from "@/kernel";
import { bootIdentity } from "@/identity";
import { bootPrograms } from "@/programs";
import { bootHealth } from "@/health";
import { bootTechnicians } from "@/technicians";
import { bootCompetitions } from "@/competitions";
import { bootMissions } from "@/missions";
import { getCli } from "./cli";
import { getSimulator } from "./simulator";
import { getDesigner } from "./designer";
import { getWorkflowBuilder } from "./workflow-builder";
import { getDebugger } from "./debugger";
import { getInspector } from "./inspector";
import { getApiExplorer } from "./api-explorer";
import { getDocsGenerator } from "./docs";
import { getSampleLibrary } from "./samples";
import { DEVELOPER_EVENTS } from "./core";

export interface DeveloperInfo {
  readonly name: string;
  readonly version: string;
  readonly bootedAt: string;
  readonly subsystems: string[];
}

let _booted = false;
let _info: DeveloperInfo | null = null;

export function bootDeveloper(): DeveloperInfo {
  if (_booted && _info) return _info;
  bootKernel(); bootIdentity(); bootPrograms(); bootHealth();
  bootTechnicians(); bootCompetitions(); bootMissions();

  getCli(); getSimulator(); getDesigner(); getWorkflowBuilder();
  getDebugger(); getInspector(); getApiExplorer(); getDocsGenerator(); getSampleLibrary();

  _booted = true;
  _info = {
    name: "Eks-Health Developer Platform",
    version: "8.0.0-m8",
    bootedAt: getClock().iso(),
    subsystems: ["core","cli","simulator","designer","workflow-builder","debugger","inspector","api-explorer","docs","samples"],
  };
  void getEventBus().publish(buildEvent(DEVELOPER_EVENTS.cliInvoked, { version: _info.version }, {}, "system"));
  return _info;
}

export function developerInfo(): DeveloperInfo {
  if (!_info) { _info = { name: "Eks-Health Developer Platform", version: "8.0.0-m8", bootedAt: getClock().iso(), subsystems: [] }; }
  return _info;
}

export function developerSnapshot() {
  ensureBooted();
  const cli = getCli();
  const sim = getSimulator();
  const designer = getDesigner();
  const wf = getWorkflowBuilder();
  const dbg = getDebugger();
  const api = getApiExplorer();
  const docs = getDocsGenerator();
  const samples = getSampleLibrary();

  return {
    info: developerInfo(),
    cli: {
      commands: cli.listCommands().map((c) => ({ name: c.name, description: c.description, category: c.category, usage: c.usage })),
      stats: cli.getStats(),
    },
    simulator: {
      scenarios: sim.listScenarios().map((s) => ({ id: s.id, name: s.name, description: s.description, entityCount: s.entities.length, eventCount: s.eventSequence.length })),
      stats: sim.getStats(),
    },
    designer: {
      templates: designer.listTemplates().map((t) => ({ type: t.type, name: t.name, description: t.description })),
      stats: designer.getStats(),
    },
    workflowBuilder: {
      nodeKinds: wf.listNodeKinds().map((k) => ({ kind: k.kind, label: k.label, description: k.description })),
      specs: wf.listSpecs().map((s) => ({ id: s.id, name: s.name, nodeCount: s.nodes.length, edgeCount: s.edges.length, version: s.version })),
      stats: wf.getStats(),
    },
    debugger: {
      stats: dbg.getStats(),
    },
    apiExplorer: {
      endpoints: api.listEndpoints().map((e) => ({ id: e.id, path: e.path, method: e.method, description: e.description, category: e.category })),
      categories: api.listCategories(),
      stats: api.getStats(),
    },
    docs: {
      stats: docs.getStats(),
    },
    samples: {
      programs: samples.list().map((s) => ({ id: s.id, slug: s.slug, name: s.name, category: s.category, difficulty: s.difficulty, features: s.features, estimatedSetupMinutes: s.estimatedSetupMinutes })),
      stats: samples.getStats(),
    },
  };
}

function ensureBooted() { if (!_booted) bootDeveloper(); }

let _seeded = false;
export function seedDeveloperDemoData(): void {
  if (_seeded) return;
  ensureBooted();
  _seeded = true;
}
