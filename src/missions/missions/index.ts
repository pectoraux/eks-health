/**
 * Eks-Health Mission Engine — Missions
 *
 * Universal mission platform. Programs create daily missions, weekly plans,
 * monthly programs, seasonal goals, long-term journeys, one-time tasks,
 * recurring habits, checklists, learning modules, appointments, assessments.
 * The platform stores, schedules, tracks, and audits these missions.
 */

import "server-only";
import {
  type MissionId,
  type MissionTemplateId,
  type ProgramId,
  type AccountId,
  type PlanId,
  type GoalId,
  type MissionType,
  type MissionState,
  type MissionPriority,
  type MissionCategory,
  MissionError,
  asMissionId,
  asMissionTemplateId,
} from "../core";
import { getEventBus, buildEvent, generateId, getClock } from "@/kernel";
import { MISSION_EVENTS } from "../core";

// ---------------------------------------------------------------------------
// Mission
// ---------------------------------------------------------------------------

export interface Mission {
  readonly id: MissionId;
  readonly programId: ProgramId;
  readonly participantId: AccountId;
  readonly planId?: PlanId;
  readonly goalId?: GoalId;
  readonly templateId?: MissionTemplateId;
  readonly type: MissionType;
  readonly category: MissionCategory;
  readonly title: string;
  readonly description: string;
  readonly instructions?: string;
  readonly state: MissionState;
  readonly priority: MissionPriority;
  readonly scheduledFor: string; // when the mission should be done
  readonly dueAt?: string; // deadline
  readonly durationMinutes?: number;
  readonly difficulty: "easy" | "medium" | "hard" | "expert";
  readonly measurementSchemaId?: string; // if mission requires a measurement
  readonly targetValue?: number;
  readonly evidenceRequired: boolean;
  readonly aiGenerated: boolean;
  readonly aiTraceId?: string;
  readonly explanationId?: string;
  readonly assignedAt: string;
  readonly activatedAt?: string;
  readonly completedAt?: string;
  readonly skippedAt?: string;
  readonly result?: MissionResult;
  readonly metadata?: Record<string, unknown>;
  readonly version: number;
}

export interface MissionResult {
  readonly outcome: "success" | "partial" | "failed" | "skipped";
  readonly value?: unknown;
  readonly evidenceIds?: string[];
  readonly notes?: string;
  readonly durationMs?: number;
  readonly completedAt: string;
}

export interface MissionTemplate {
  readonly id: MissionTemplateId;
  readonly programId: ProgramId;
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly type: MissionType;
  readonly category: MissionCategory;
  readonly defaultPriority: MissionPriority;
  readonly defaultDifficulty: "easy" | "medium" | "hard" | "expert";
  readonly defaultDurationMinutes?: number;
  readonly measurementSchemaId?: string;
  readonly targetValue?: number;
  readonly evidenceRequired: boolean;
  readonly instructions?: string;
  readonly tags: string[];
  readonly createdAt: string;
}

// ---------------------------------------------------------------------------
// Mission manager
// ---------------------------------------------------------------------------

const TRANSITIONS: Record<MissionState, MissionState[]> = {
  draft: ["scheduled", "cancelled"],
  scheduled: ["assigned", "cancelled"],
  assigned: ["active", "skipped", "expired", "cancelled"],
  active: ["completed", "skipped", "expired", "cancelled"],
  completed: ["archived"],
  skipped: ["archived"],
  expired: ["archived"],
  cancelled: [],
  archived: [],
};

export class MissionManager {
  private readonly missions = new Map<MissionId, Mission>();
  private readonly templates = new Map<MissionTemplateId, MissionTemplate>();
  private readonly byParticipant = new Map<AccountId, MissionId[]>();
  private readonly byProgram = new Map<ProgramId, MissionId[]>();

  defineTemplate(input: Omit<MissionTemplate, "id" | "createdAt">): MissionTemplate {
    const tpl: MissionTemplate = { ...input, id: asMissionTemplateId(generateId("mtpl_")), createdAt: getClock().iso() };
    this.templates.set(tpl.id, tpl);
    return tpl;
  }

  getTemplate(id: MissionTemplateId): MissionTemplate | undefined {
    return this.templates.get(id);
  }

  listTemplates(programId?: ProgramId): MissionTemplate[] {
    const list = [...this.templates.values()];
    return programId ? list.filter((t) => t.programId === programId) : list;
  }

  assign(input: {
    programId: ProgramId;
    participantId: AccountId;
    planId?: PlanId;
    goalId?: GoalId;
    templateId?: MissionTemplateId;
    type: MissionType;
    category: MissionCategory;
    title: string;
    description: string;
    instructions?: string;
    priority?: MissionPriority;
    scheduledFor: string;
    dueAt?: string;
    durationMinutes?: number;
    difficulty?: "easy" | "medium" | "hard" | "expert";
    measurementSchemaId?: string;
    targetValue?: number;
    evidenceRequired?: boolean;
    aiGenerated?: boolean;
    aiTraceId?: string;
    metadata?: Record<string, unknown>;
  }): Mission {
    const tpl = input.templateId ? this.templates.get(input.templateId) : undefined;
    const mission: Mission = {
      id: asMissionId(generateId("mis_")),
      programId: input.programId,
      participantId: input.participantId,
      planId: input.planId,
      goalId: input.goalId,
      templateId: input.templateId,
      type: input.type,
      category: input.category,
      title: input.title,
      description: input.description,
      instructions: input.instructions ?? tpl?.instructions,
      state: "assigned",
      priority: input.priority ?? tpl?.defaultPriority ?? "normal",
      scheduledFor: input.scheduledFor,
      dueAt: input.dueAt,
      durationMinutes: input.durationMinutes ?? tpl?.defaultDurationMinutes,
      difficulty: input.difficulty ?? tpl?.defaultDifficulty ?? "medium",
      measurementSchemaId: input.measurementSchemaId ?? tpl?.measurementSchemaId,
      targetValue: input.targetValue ?? tpl?.targetValue,
      evidenceRequired: input.evidenceRequired ?? tpl?.evidenceRequired ?? false,
      aiGenerated: input.aiGenerated ?? false,
      aiTraceId: input.aiTraceId,
      assignedAt: getClock().iso(),
      version: 1,
      metadata: input.metadata,
    };
    this.missions.set(mission.id, mission);
    this.indexBy(mission);
    void getEventBus().publish(buildEvent(MISSION_EVENTS.missionAssigned, { missionId: mission.id, participantId: input.participantId, programId: input.programId, type: input.type }, {}, "domain"));
    return mission;
  }

  get(id: MissionId): Mission | undefined {
    return this.missions.get(id);
  }

  list(filter?: { participantId?: AccountId; programId?: ProgramId; state?: MissionState; category?: MissionCategory; dateFrom?: string; dateTo?: string }): Mission[] {
    let list = [...this.missions.values()];
    if (filter?.participantId) list = list.filter((m) => m.participantId === filter.participantId);
    if (filter?.programId) list = list.filter((m) => m.programId === filter.programId);
    if (filter?.state) list = list.filter((m) => m.state === filter.state);
    if (filter?.category) list = list.filter((m) => m.category === filter.category);
    if (filter?.dateFrom) list = list.filter((m) => m.scheduledFor >= filter.dateFrom!);
    if (filter?.dateTo) list = list.filter((m) => m.scheduledFor <= filter.dateTo!);
    return list.sort((a, b) => a.scheduledFor.localeCompare(b.scheduledFor));
  }

  getToday(participantId: AccountId): Mission[] {
    const today = new Date().toISOString().slice(0, 10);
    return this.list({ participantId, state: "active" }).filter((m) => m.scheduledFor.slice(0, 10) === today)
      .concat(this.list({ participantId, state: "assigned" }).filter((m) => m.scheduledFor.slice(0, 10) === today));
  }

  activate(id: MissionId): Mission {
    return this.transition(id, "active");
  }

  complete(id: MissionId, result: Omit<MissionResult, "completedAt">): Mission {
    const mission = this.missions.get(id);
    if (!mission) throw new MissionError({ code: "eks.mission.not_found", category: "not_found", message: "Mission not found." });
    const fullResult: MissionResult = { ...result, completedAt: getClock().iso() };
    this.transition(id, "completed");
    const updated = { ...this.missions.get(id)!, result: fullResult, completedAt: getClock().iso() };
    this.missions.set(id, updated);
    void getEventBus().publish(buildEvent(MISSION_EVENTS.missionCompleted, { missionId: id, participantId: mission.participantId, outcome: result.outcome }, {}, "domain"));
    return updated;
  }

  skip(id: MissionId, reason?: string): Mission {
    const mission = this.missions.get(id);
    if (!mission) throw new MissionError({ code: "eks.mission.not_found", category: "not_found", message: "Not found." });
    this.transition(id, "skipped");
    const updated = { ...this.missions.get(id)!, skippedAt: getClock().iso(), metadata: { ...mission.metadata, skipReason: reason } };
    this.missions.set(id, updated);
    void getEventBus().publish(buildEvent(MISSION_EVENTS.missionSkipped, { missionId: id, participantId: mission.participantId, reason }, {}, "domain"));
    return updated;
  }

  expire(id: MissionId): Mission {
    return this.transition(id, "expired");
  }

  cancel(id: MissionId): Mission {
    return this.transition(id, "cancelled");
  }

  archive(id: MissionId): Mission {
    return this.transition(id, "archived");
  }

  transition(id: MissionId, to: MissionState): Mission {
    const mission = this.missions.get(id);
    if (!mission) throw new MissionError({ code: "eks.mission.not_found", category: "not_found", message: "Mission not found." });
    if (!TRANSITIONS[mission.state]?.includes(to)) {
      throw new MissionError({ code: "eks.mission.invalid_transition", category: "state_conflict", message: `Cannot transition ${mission.state}→${to}.`, metadata: { from: mission.state, to } });
    }
    const updates: { state: MissionState; activatedAt?: string } = { state: to };
    if (to === "active") updates.activatedAt = getClock().iso();
    if (to === "expired") void getEventBus().publish(buildEvent(MISSION_EVENTS.missionExpired, { missionId: id }, {}, "domain"));
    const updated = { ...mission, ...updates, version: mission.version + 1 };
    this.missions.set(id, updated);
    return updated;
  }

  /** Sweep: expire missions past their due date. */
  sweepExpired(): number {
    const now = Date.now();
    let n = 0;
    for (const [id, m] of this.missions) {
      if ((m.state === "assigned" || m.state === "active") && m.dueAt && new Date(m.dueAt).getTime() < now) {
        try { this.expire(id); n++; } catch { /* ignore */ }
      }
    }
    return n;
  }

  getStats(participantId?: AccountId): {
    total: number; active: number; completed: number; skipped: number; expired: number;
    completionRate: number; byCategory: Record<string, number>; byType: Record<string, number>;
  } {
    let list = [...this.missions.values()];
    if (participantId) list = list.filter((m) => m.participantId === participantId);
    const byCategory: Record<string, number> = {};
    const byType: Record<string, number> = {};
    let active = 0, completed = 0, skipped = 0, expired = 0;
    for (const m of list) {
      byCategory[m.category] = (byCategory[m.category] ?? 0) + 1;
      byType[m.type] = (byType[m.type] ?? 0) + 1;
      if (m.state === "active") active++;
      else if (m.state === "completed") completed++;
      else if (m.state === "skipped") skipped++;
      else if (m.state === "expired") expired++;
    }
    const attempted = completed + skipped + expired;
    return { total: list.length, active, completed, skipped, expired, completionRate: attempted > 0 ? completed / attempted : 0, byCategory, byType };
  }

  private indexBy(m: Mission): void {
    const pList = this.byParticipant.get(m.participantId) ?? [];
    this.byParticipant.set(m.participantId, [...pList, m.id]);
    const prList = this.byProgram.get(m.programId) ?? [];
    this.byProgram.set(m.programId, [...prList, m.id]);
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _mgr: MissionManager | null = null;
export function getMissions(): MissionManager {
  if (!_mgr) _mgr = new MissionManager();
  return _mgr;
}
