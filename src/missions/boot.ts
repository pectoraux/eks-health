/**
 * Eks-Health Mission Engine — Boot Sequence
 *
 * Idempotently initializes the mission engine + AI runtime, seeds demo
 * missions, goals, habits, plans, and knowledge bases.
 */

import "server-only";
import { getEventBus, buildEvent, getClock, bootKernel, generateId } from "@/kernel";
import { bootIdentity, asAccountId } from "@/identity";
import { bootPrograms, asProgramId } from "@/programs";
import { bootHealth } from "@/health";
import { bootTechnicians } from "@/technicians";
import { bootCompetitions } from "@/competitions";
import { getMissions } from "./missions";
import { getGoals } from "./goals";
import { getHabits } from "./habits";
import { getPlans } from "./plans";
import { getPersonalization } from "./personalization";
import { getKnowledge } from "./knowledge";
import { getExplainability } from "./explainability";
import { getReminders } from "./notifications";
import { MISSION_EVENTS, asMissionId, type MissionId } from "./core";

export interface MissionsInfo {
  readonly name: string;
  readonly version: string;
  readonly bootedAt: string;
  readonly subsystems: string[];
}

let _booted = false;
let _info: MissionsInfo | null = null;

export function bootMissions(): MissionsInfo {
  if (_booted && _info) return _info;
  bootKernel();
  bootIdentity();
  bootPrograms();
  bootHealth();
  bootTechnicians();
  bootCompetitions();

  getMissions();
  getGoals();
  getHabits();
  getPlans();
  getPersonalization();
  getKnowledge();
  getExplainability();
  getReminders();

  _booted = true;
  _info = {
    name: "Eks-Health Mission Engine & AI Runtime",
    version: "7.0.0-m7",
    bootedAt: getClock().iso(),
    subsystems: [
      "core", "missions", "goals", "habits", "plans", "personalization",
      "knowledge", "explainability", "notifications",
    ],
  };
  void getEventBus().publish(buildEvent(MISSION_EVENTS.missionAssigned, { version: _info.version }, {}, "system"));
  return _info;
}

export function missionsInfo(): MissionsInfo {
  if (!_info) {
    _info = {
      name: "Eks-Health Mission Engine & AI Runtime",
      version: "7.0.0-m7",
      bootedAt: getClock().iso(),
      subsystems: [],
    };
  }
  return _info;
}

/** Compact diagnostic snapshot for the console. */
export function missionsSnapshot() {
  ensureBooted();
  const missions = getMissions();
  const goals = getGoals();
  const habits = getHabits();
  const plans = getPlans();
  const knowledge = getKnowledge();

  return {
    info: missionsInfo(),
    missions: {
      stats: missions.getStats(),
      recent: missions.list({}).slice(0, 30).map((m) => ({
        id: m.id, title: m.title, type: m.type, category: m.category,
        state: m.state, priority: m.priority, scheduledFor: m.scheduledFor,
        participantId: m.participantId, programId: m.programId,
        aiGenerated: m.aiGenerated, difficulty: m.difficulty,
      })),
      templates: missions.listTemplates().map((t) => ({
        id: t.id, slug: t.slug, name: t.name, type: t.type, category: t.category,
      })),
    },
    goals: {
      stats: goals.getStats(),
      recent: goals.list().slice(0, 20).map((g) => ({
        id: g.id, name: g.name, type: g.type, state: g.state,
        targetValue: g.targetValue, currentValue: g.currentValue, unit: g.unit,
        progress: g.targetValue > 0 ? (g.currentValue / g.targetValue) * 100 : 0,
        milestoneCount: g.milestones.length, achievedMilestones: g.milestones.filter((m) => m.achievedAt).length,
      })),
    },
    habits: {
      stats: habits.getStats(),
      recent: habits.list().slice(0, 20).map((h) => ({
        id: h.id, name: h.name, frequency: h.frequency, active: h.active,
        currentStreak: h.streak.current, bestStreak: h.streak.best,
        totalCompletions: h.totalCompletions, score: h.score,
      })),
    },
    plans: {
      stats: plans.getStats(),
      recent: plans.list().slice(0, 20).map((p) => ({
        id: p.id, name: p.name, state: p.state, version: p.version,
        missionCount: p.missionIds.length, goalCount: p.goalIds.length,
        habitCount: p.habitIds.length, participantId: p.participantId,
      })),
    },
    knowledge: {
      stats: knowledge.getStats(),
      bases: knowledge.listBases().map((b) => ({
        id: b.id, name: b.name, type: b.type, entryCount: b.entryCount,
        allowedRetrieval: b.licensing?.allowedRetrieval ?? true,
      })),
    },
  };
}

function ensureBooted() {
  if (!_booted) bootMissions();
}

// ---------------------------------------------------------------------------
// Demo data seeding
// ---------------------------------------------------------------------------

let _seeded = false;

export function seedMissionDemoData(): { missionIds: MissionId[] } {
  if (_seeded) return { missionIds: [] };
  ensureBooted();

  const missions = getMissions();
  const goals = getGoals();
  const habits = getHabits();
  const plans = getPlans();
  const knowledge = getKnowledge();
  const programId = asProgramId("prg_cardio_care");
  const participantId = asAccountId("acc_demo_1");
  const missionIds: MissionId[] = [];
  const now = new Date();
  const todayISO = (offsetDays = 0) => new Date(now.getTime() + offsetDays * 86400000).toISOString();

  // Define mission templates
  const templateDefs = [
    { slug: "daily_steps", name: "Daily Steps", type: "daily_mission" as const, category: "activity" as const, defaultPriority: "normal" as const, defaultDifficulty: "medium" as const, targetValue: 8000, measurementSchemaId: "sch_daily_steps", evidenceRequired: false, tags: ["activity", "fitness"] },
    { slug: "sleep_before_10", name: "Sleep Before 10 PM", type: "daily_mission" as const, category: "sleep" as const, defaultPriority: "normal" as const, defaultDifficulty: "easy" as const, evidenceRequired: false, tags: ["sleep", "recovery"] },
    { slug: "log_meals", name: "Log Today's Meals", type: "daily_mission" as const, category: "nutrition" as const, defaultPriority: "low" as const, defaultDifficulty: "easy" as const, evidenceRequired: false, tags: ["nutrition"] },
    { slug: "book_technician", name: "Book a Technician Visit", type: "appointment" as const, category: "appointment" as const, defaultPriority: "high" as const, defaultDifficulty: "easy" as const, evidenceRequired: false, tags: ["appointment"] },
    { slug: "breathing_exercise", name: "Practice Breathing Exercises", type: "daily_mission" as const, category: "mental_wellness" as const, defaultPriority: "low" as const, defaultDifficulty: "easy" as const, durationMinutes: 15, evidenceRequired: false, tags: ["mental_wellness"] },
    { slug: "educational_lesson", name: "Watch Educational Lesson", type: "learning_module" as const, category: "education" as const, defaultPriority: "normal" as const, defaultDifficulty: "easy" as const, durationMinutes: 20, evidenceRequired: false, tags: ["education"] },
  ];
  for (const t of templateDefs) {
    try {
      missions.defineTemplate({ ...t, programId, description: t.name });
    } catch { /* already exists */ }
  }

  // Create a plan
  let planId: string;
  try {
    const plan = plans.create({
      programId,
      participantId,
      name: "Cardio Care Personal Plan",
      description: "Personalized daily plan for cardiovascular health improvement.",
      validFrom: todayISO(),
      adaptivityRules: [
        { name: "Low Completion Rate", trigger: "completion_rate < 0.5", action: "modify_difficulty", params: { difficulty: "easy" } },
        { name: "High Completion Rate", trigger: "completion_rate > 0.8", action: "modify_difficulty", params: { difficulty: "hard" } },
      ],
    });
    planId = plan.id;
  } catch {
    planId = "plan_demo_1";
  }

  // Assign today's missions
  const todayMissions = [
    { templateSlug: "daily_steps", title: "Walk 8,200 steps today", category: "activity" as const, priority: "normal" as const, difficulty: "medium" as const },
    { templateSlug: "sleep_before_10", title: "Aim to sleep before 10:00 PM tonight", category: "sleep" as const, priority: "normal" as const, difficulty: "easy" as const },
    { templateSlug: "log_meals", title: "Log today's meals", category: "nutrition" as const, priority: "low" as const, difficulty: "easy" as const },
    { templateSlug: "breathing_exercise", title: "Practice 15 minutes of breathing exercises", category: "mental_wellness" as const, priority: "low" as const, difficulty: "easy" as const },
  ];
  for (const tm of todayMissions) {
    try {
      const tpl = missions.listTemplates(programId).find((t) => t.slug === tm.templateSlug);
      const m = missions.assign({
        programId, participantId, planId: planId as never,
        templateId: tpl?.id,
        type: "daily_mission", category: tm.category,
        title: tm.title, description: tm.title,
        priority: tm.priority, difficulty: tm.difficulty,
        scheduledFor: todayISO(),
        dueAt: todayISO(0),
        measurementSchemaId: tpl?.measurementSchemaId,
        targetValue: tpl?.targetValue,
        evidenceRequired: tpl?.evidenceRequired ?? false,
        aiGenerated: true, aiTraceId: generateId("trace_"),
      });
      missions.activate(m.id);
      missionIds.push(m.id);
    } catch { /* already exists */ }
  }

  // Create a goal
  try {
    goals.create({
      programId, participantId,
      name: "Reduce Resting Heart Rate",
      description: "Lower resting heart rate to 60 bpm over 90 days.",
      type: "measurement_target",
      targetValue: 60, unit: "bpm",
      measurementSchemaId: "sch_resting_heart_rate",
      deadline: todayISO(90),
      adaptive: true,
      milestones: [
        { name: "Below 70", description: "Reduce to below 70 bpm", targetValue: 70, deadline: todayISO(30), dependencies: [] },
        { name: "Below 65", description: "Reduce to below 65 bpm", targetValue: 65, deadline: todayISO(60), dependencies: [] },
      ],
    });
  } catch { /* already exists */ }

  // Create habits
  const habitDefs = [
    { name: "Morning Meditation", description: "Meditate for 10 minutes each morning", frequency: "daily" as const },
    { name: "Hydration Check", description: "Drink 8 glasses of water", frequency: "daily" as const },
  ];
  for (const h of habitDefs) {
    try {
      const habit = habits.create({ programId, participantId, ...h });
      // Simulate some completions
      for (let i = 0; i < 5; i++) {
        try { habits.complete(habit.id); } catch { /* ignore */ }
      }
    } catch { /* already exists */ }
  }

  // Create a knowledge base
  try {
    const kb = knowledge.createBase({
      programId,
      name: "Cardiovascular Health Guidelines",
      description: "Clinical guidelines and educational content for cardiovascular health.",
      type: "clinical_guideline",
      licensing: { license: "CC-BY-4.0", allowedRetrieval: true },
    });
    knowledge.addEntry(kb.id, { title: "Understanding Resting Heart Rate", content: "Resting heart rate is a key indicator of cardiovascular fitness...", tags: ["heart_rate", "cardiovascular"] });
    knowledge.addEntry(kb.id, { title: "Benefits of Daily Walking", content: "Regular walking of 8,000+ steps per day improves cardiovascular health...", tags: ["activity", "walking"] });
    knowledge.addEntry(kb.id, { title: "Sleep and Heart Health", content: "Quality sleep before 10 PM supports cardiovascular recovery...", tags: ["sleep", "recovery"] });
  } catch { /* already exists */ }

  _seeded = true;
  return { missionIds };
}
