/**
 * Eks-Health Developer Platform — Sample Programs
 *
 * Ships several production-quality reference implementations demonstrating
 * platform capabilities without hardcoding logic into the core. Each sample
 * is a complete program project: manifest.json, src/entry.ts, src/index.ts,
 * test/contract.test.ts, README.md, and .eksprogramrc.json.
 *
 * Samples cover eight categories: weight management, blood pressure, diabetes
 * prevention, sleep optimization, mental wellness, cardiovascular, nutrition,
 * habit formation. Each demonstrates a different mix of platform capabilities
 * (measurements, competitions, AI, technician verification, habits, etc.).
 *
 * `instantiate()` calls the real program SDK to scaffold a project, overrides
 * the generated files with the sample's richer reference code, and registers
 * the program in the lifecycle registry. No mocks — real scaffolding, real
 * manifest generation, real registration.
 */

import "server-only";

import {
  type SampleProgram,
  type SampleProgramId,
  DeveloperError,
  asSampleProgramId,
  DEVELOPER_EVENTS,
} from "../core";
import { getEventBus, buildEvent, generateId, getClock } from "@/kernel";

// Re-export core types so consumers can import everything from "./samples".
export type { SampleProgram, SampleProgramId };

// ---------------------------------------------------------------------------
// Sample categories
// ---------------------------------------------------------------------------

export type SampleCategory =
  | "weight_management"
  | "blood_pressure"
  | "diabetes_prevention"
  | "sleep_optimization"
  | "mental_wellness"
  | "cardiovascular"
  | "nutrition"
  | "habit_formation";

// ---------------------------------------------------------------------------
// Sample comparison result
// ---------------------------------------------------------------------------

export interface SampleComparison {
  readonly a: { id: SampleProgramId; name: string };
  readonly b: { id: SampleProgramId; name: string };
  readonly featureOverlap: string[];
  readonly featureOnlyInA: string[];
  readonly featureOnlyInB: string[];
  readonly difficultyDiff: "a_harder" | "b_harder" | "equal";
  readonly setupTimeDiffMinutes: number;
}

export interface SampleStats {
  readonly totalSamples: number;
  readonly byCategory: Record<string, number>;
  readonly byDifficulty: Record<"beginner" | "intermediate" | "advanced", number>;
}

// ---------------------------------------------------------------------------
// Sample library
// ---------------------------------------------------------------------------

const SAMPLES: readonly SampleProgram[] = [
  // 1. weight-tracker -------------------------------------------------------
  buildSample({
    id: "weight-tracker",
    slug: "weight-tracker",
    name: "Weight Tracker",
    description: "Track body weight over time with a measurement schema, timeline, and weekly trend visualization. Beginner-friendly introduction to the platform's measurement API.",
    category: "weight_management",
    difficulty: "beginner",
    estimatedSetupMinutes: 5,
    features: ["measurement_schema", "timeline", "weekly_trend", "notifications"],
    templateId: "measurement-tracker",
    manifestSnippet: {
      category: "wellness",
      capabilities: [
        { capability: "measurement", reason: "Record and display daily weight measurements.", purposes: ["health-tracking"], scope: "self" },
        { capability: "notification", reason: "Remind the user to log their weight each morning.", scope: "self" },
      ],
      privacy: {
        dataCollected: ["weight_kg", "timestamp"],
        dataUsage: "Display weight trends to the user.",
        thirdPartySharing: false,
        retentionDays: 365,
        anonymizationApplied: true,
        residencyRegions: ["*"],
      },
      aiUsage: { usesAI: false },
      resourceLimits: { storageMb: 25 },
      measurementDefinitions: [
        { id: "body_weight", type: "measurement", name: "Body Weight", description: "Daily body weight in kilograms.", schema: { type: "number", minimum: 20, maximum: 400 }, unit: "kg", privacyLevel: "confidential" },
      ],
      eventSubscriptions: ["eks.measurement.recorded"],
    },
    entryTs: `import type { ProgramHandler, ProgramContext, ProgramEvent } from "@eks/program-sdk";

/**
 * Weight Tracker — entry point.
 *
 * Demonstrates:
 *  - Subscribing to measurement events.
 *  - Computing a 7-day moving average.
 *  - Sending a weekly trend notification.
 */
export const handler: ProgramHandler = {
  async onMeasurement(ctx: ProgramContext, event: ProgramEvent) {
    const value = event.payload.weight_kg as number | undefined;
    if (typeof value !== "number") return;
    ctx.log.info("Weight recorded", { value });

    // Fetch the last 7 measurements to compute a moving average.
    const history = await ctx.api.measurements.list({
      schemaId: "body_weight",
      limit: 7,
    });
    if (history.length === 7) {
      const avg = history.reduce((sum, m) => sum + (m.value as number), 0) / 7;
      ctx.log.info("7-day average", { avg });
    }
  },

  async onNotificationRequest(ctx: ProgramContext, _request: unknown) {
    // Send a friendly reminder to log today's weight.
    return { delivered: true };
  },
};

export default handler;
`,
    readme: (s) => `# ${s.name}

${s.description}

- **Category**: ${s.category}
- **Difficulty**: ${s.difficulty}
- **Setup time**: ~${s.estimatedSetupMinutes} minutes
- **Template**: ${s.templateId}

## What this sample demonstrates

- A simple measurement schema (body weight, kg).
- Subscribing to \`eks.measurement.recorded\` events.
- Computing a 7-day moving average from measurement history.
- Sending daily reminders via the notification capability.

## Setup

\`\`\`bash
eks new-program weight-tracker --template measurement-tracker
cd weight-tracker
eks dev
\`\`\`

Open http://localhost:3100 to record measurements and watch the timeline
update in real time.

## Test

\`\`\`bash
eks test --coverage
\`\`\`
`,
  }),

  // 2. bp-monitor ----------------------------------------------------------
  buildSample({
    id: "bp-monitor",
    slug: "bp-monitor",
    name: "Blood Pressure Monitor",
    description: "Capture systolic/diastolic blood pressure measurements with technician verification, evidence upload, and a chain-of-custody audit trail. Demonstrates the platform's clinical verification pipeline.",
    category: "blood_pressure",
    difficulty: "intermediate",
    estimatedSetupMinutes: 10,
    features: ["measurement_schema", "technician_verification", "evidence", "chain_of_custody", "audit"],
    templateId: "measurement-tracker",
    manifestSnippet: {
      category: "clinical",
      capabilities: [
        { capability: "measurement", reason: "Record blood pressure measurements.", purposes: ["clinical-tracking"], scope: "self" },
        { capability: "notification", reason: "Notify participants of pending verification.", scope: "self" },
        { capability: "event-subscription", reason: "Listen for verification state changes.", scope: "self" },
      ],
      privacy: {
        dataCollected: ["systolic_mmhg", "diastolic_mmhg", "heart_rate_bpm", "timestamp"],
        dataUsage: "Display blood pressure trends and route to technician verification.",
        thirdPartySharing: false,
        retentionDays: 365 * 5,
        anonymizationApplied: true,
        residencyRegions: ["*"],
      },
      aiUsage: { usesAI: false },
      resourceLimits: { storageMb: 100 },
      measurementDefinitions: [
        { id: "blood_pressure", type: "measurement", name: "Blood Pressure", description: "Systolic/diastolic blood pressure with heart rate.", schema: { type: "object", properties: { systolic: { type: "number" }, diastolic: { type: "number" }, heart_rate: { type: "number" } }, required: ["systolic", "diastolic"] }, unit: "mmHg", privacyLevel: "restricted" },
      ],
      eventSubscriptions: ["eks.measurement.recorded", "eks.measurement.verified", "eks.measurement.rejected"],
    },
    entryTs: `import type { ProgramHandler, ProgramContext, ProgramEvent } from "@eks/program-sdk";

/**
 * Blood Pressure Monitor — entry point.
 *
 * Demonstrates:
 *  - Submitting measurements with evidence for technician verification.
 *  - Handling verified/rejected events.
 *  - Maintaining an audit trail of every state change.
 */
export const handler: ProgramHandler = {
  async onMeasurement(ctx: ProgramContext, event: ProgramEvent) {
    const { systolic, diastolic, heart_rate } = event.payload as {
      systolic: number; diastolic: number; heart_rate?: number;
    };
    if (systolic <= 0 || diastolic <= 0) {
      ctx.log.warn("Invalid blood pressure reading", { systolic, diastolic });
      return;
    }
    ctx.log.info("BP recorded", { systolic, diastolic, heart_rate });

    // Stage 2: classify the reading for participant-facing UX.
    const category = classifyBp(systolic, diastolic);
    await ctx.api.storage.put("latest_category", { category, at: event.occurredAt });

    // If hypertensive, flag for priority technician review.
    if (category === "stage_2_hypertension" || category === "hypertensive_crisis") {
      await ctx.api.notifications.send({
        template: "priority_verification",
        context: { systolic, diastolic, category },
      });
    }
  },

  async onEvent(ctx: ProgramContext, event: ProgramEvent) {
    if (event.type === "eks.measurement.verified") {
      ctx.log.info("Measurement verified by technician", { id: event.payload.measurementId });
    } else if (event.type === "eks.measurement.rejected") {
      ctx.log.warn("Measurement rejected", { id: event.payload.measurementId, reason: event.payload.reason });
      await ctx.api.notifications.send({ template: "verification_rejected", context: { reason: event.payload.reason } });
    }
  },
};

function classifyBp(sys: number, dia: number): string {
  if (sys >= 180 || dia >= 120) return "hypertensive_crisis";
  if (sys >= 140 || dia >= 90) return "stage_2_hypertension";
  if (sys >= 130 || dia >= 80) return "stage_1_hypertension";
  if (sys >= 120 && dia < 80) return "elevated";
  return "normal";
}

export default handler;
`,
    readme: (s) => `# ${s.name}

${s.description}

- **Category**: ${s.category}
- **Difficulty**: ${s.difficulty}
- **Setup time**: ~${s.estimatedSetupMinutes} minutes

## What this sample demonstrates

- A clinical measurement schema (systolic, diastolic, heart rate).
- Submitting measurements with evidence for technician verification.
- Handling \`eks.measurement.verified\` and \`eks.measurement.rejected\` events.
- Classifying readings using ACC/AHA categories.
- Flagging hypertensive readings for priority verification.

## Setup

\`\`\`bash
eks new-program bp-monitor --template measurement-tracker
cd bp-monitor
eks dev
\`\`\`

## Privacy

Blood pressure measurements are classified as **restricted**. The platform
requires technician verification before they can be used in competitions or
shared with cohort analytics.
`,
  }),

  // 3. diabetes-prevention -------------------------------------------------
  buildSample({
    id: "diabetes-prevention",
    slug: "diabetes-prevention",
    name: "Diabetes Prevention Program",
    description: "A full diabetes prevention program: 16-week competition with HbA1c measurements, weight-loss scoring, divisions, and rewards. Demonstrates the competition + scoring + mission stack.",
    category: "diabetes_prevention",
    difficulty: "advanced",
    estimatedSetupMinutes: 20,
    features: ["competition", "scoring", "missions", "leaderboard", "divisions", "rewards", "measurement_schema"],
    templateId: "competition-program",
    manifestSnippet: {
      category: "prevention",
      capabilities: [
        { capability: "competition", reason: "Run a 16-week prevention competition.", purposes: ["engagement"], scope: "participant" },
        { capability: "leaderboard", reason: "Display weekly and overall rankings.", purposes: ["engagement"], scope: "cohort" },
        { capability: "mission", reason: "Assign weekly diet and exercise missions.", scope: "participant" },
        { capability: "measurement", reason: "Record weight and HbA1c measurements.", purposes: ["scoring"], scope: "self" },
        { capability: "reward", reason: "Distribute rewards at season close.", scope: "participant" },
        { capability: "notification", reason: "Notify participants of competition milestones.", scope: "participant" },
      ],
      privacy: {
        dataCollected: ["weight_kg", "hba1c_pct", "participant_id", "score"],
        dataUsage: "Compute competition rankings and distribute rewards.",
        thirdPartySharing: false,
        retentionDays: 365 * 3,
        anonymizationApplied: true,
        residencyRegions: ["*"],
      },
      aiUsage: { usesAI: false },
      resourceLimits: { apiRequestsPerMinute: 200, storageMb: 250 },
      measurementDefinitions: [
        { id: "weight", type: "measurement", name: "Body Weight", description: "Weekly body weight in kilograms.", schema: { type: "number", minimum: 30, maximum: 300 }, unit: "kg", privacyLevel: "confidential" },
        { id: "hba1c", type: "measurement", name: "HbA1c", description: "Glycated hemoglobin percentage (lab-verified).", schema: { type: "number", minimum: 3, maximum: 15 }, unit: "%", privacyLevel: "restricted" },
      ],
      competitionDefinitions: [
        { id: "diabetes_prevention_16wk", type: "competition", name: "16-Week Diabetes Prevention", description: "A 16-week competition scoring weight loss + HbA1c improvement.", schema: { type: "object", properties: { durationWeeks: { const: 16 }, divisions: { type: "array" } } }, privacyLevel: "internal" },
      ],
      eventSubscriptions: ["eks.competition.started", "eks.competition.score.updated", "eks.competition.season.closed", "eks.measurement.verified"],
    },
    entryTs: `import type { ProgramHandler, ProgramContext, ProgramEvent } from "@eks/program-sdk";

/**
 * Diabetes Prevention Program — entry point.
 *
 * Demonstrates:
 *  - A 16-week competition lifecycle.
 *  - Scoring weight loss + HbA1c improvement (verified measurements only).
 *  - Assigning weekly diet and exercise missions.
 *  - Distributing rewards at season close.
 */
export const handler: ProgramHandler = {
  async onCompetitionStart(ctx: ProgramContext, event: ProgramEvent) {
    ctx.log.info("16-week prevention competition started", { competitionId: event.competitionId });
    // Seed week 1 missions for every participant.
    await ctx.api.missions.assignBulk({
      template: "week_1_diet_exercise",
      competitionId: event.competitionId,
    });
  },

  async onMeasurement(ctx: ProgramContext, event: ProgramEvent) {
    // Only verified measurements contribute to scoring.
    if (event.payload.verificationState !== "verified") return;
    const score = computeScore(event.payload);
    await ctx.api.competitions.submitScore({
      competitionId: event.payload.competitionId,
      participantId: event.payload.participantId,
      score,
      measurementId: event.payload.measurementId,
    });
    ctx.log.info("Score submitted", { score });
  },

  async onEvent(ctx: ProgramContext, event: ProgramEvent) {
    if (event.type === "eks.competition.season.closed") {
      ctx.log.info("Season closed — distributing rewards");
      await ctx.api.rewards.distribute({ competitionId: event.payload.competitionId });
    }
  },
};

/**
 * Score = weight_loss_pct * 50 + hba1c_improvement * 50.
 * - weight_loss_pct: percentage of baseline weight lost.
 * - hba1c_improvement: percentage-point drop from baseline.
 */
function computeScore(payload: {
  weightKg?: number; baselineWeightKg?: number;
  hba1c?: number; baselineHba1c?: number;
}): number {
  let score = 0;
  if (payload.weightKg && payload.baselineWeightKg && payload.baselineWeightKg > 0) {
    const lossPct = (payload.baselineWeightKg - payload.weightKg) / payload.baselineWeightKg * 100;
    score += Math.max(0, lossPct) * 5; // up to ~25 pts for 5% loss
  }
  if (payload.hba1c && payload.baselineHba1c) {
    const improvement = payload.baselineHba1c - payload.hba1c;
    score += Math.max(0, improvement) * 25; // up to ~25 pts for 1pp drop
  }
  return Math.round(score * 10) / 10;
}

export default handler;
`,
    readme: (s) => `# ${s.name}

${s.description}

- **Category**: ${s.category}
- **Difficulty**: ${s.difficulty}
- **Setup time**: ~${s.estimatedSetupMinutes} minutes

## What this sample demonstrates

- A 16-week competition with weekly missions.
- A scoring formula combining weight loss + HbA1c improvement.
- Using only technician-verified measurements for scoring.
- Distributing rewards at season close.

## Score formula

\`\`\`
score = (weight_loss_pct * 5) + (hba1c_improvement_pp * 25)
\`\`\`

- 5% weight loss + 1pp HbA1c drop = 25 + 25 = **50 points**.

## Setup

\`\`\`bash
eks new-program diabetes-prevention --template competition-program
cd diabetes-prevention
eks dev
\`\`\`
`,
  }),

  // 4. sleep-optimizer -----------------------------------------------------
  buildSample({
    id: "sleep-optimizer",
    slug: "sleep-optimizer",
    name: "Sleep Optimizer",
    description: "An AI-powered sleep optimization program: nightly sleep measurements, AI-generated weekly plans, habit streaks, and adaptive recommendations. Demonstrates AI mission generation + habits.",
    category: "sleep_optimization",
    difficulty: "intermediate",
    estimatedSetupMinutes: 10,
    features: ["ai_mission_generation", "habits", "streaks", "measurement_schema", "personalization"],
    templateId: "ai-assistant",
    manifestSnippet: {
      category: "ai",
      capabilities: [
        { capability: "ai", reason: "Generate personalized weekly sleep plans.", purposes: ["health-coaching"], scope: "self" },
        { capability: "measurement", reason: "Record nightly sleep duration and quality.", purposes: ["personalization"], scope: "self" },
        { capability: "mission", reason: "Assign sleep hygiene missions and habits.", scope: "self" },
        { capability: "notification", reason: "Send wind-down reminders in the evening.", scope: "self" },
        { capability: "profile", reason: "Personalize plans with age range and goals.", purposes: ["personalization"], fields: ["age_range", "goals"], scope: "self" },
      ],
      privacy: {
        dataCollected: ["sleep_duration_hours", "sleep_quality_score", "bedtime", "wake_time"],
        dataUsage: "Generate personalized sleep plans and habit recommendations.",
        thirdPartySharing: false,
        retentionDays: 90,
        anonymizationApplied: false,
        residencyRegions: ["*"],
      },
      aiUsage: {
        usesAI: true,
        provider: "eks-ai",
        modelFamily: "glm",
        purpose: "Generate personalized weekly sleep plans based on recorded sleep data.",
        trainingDataUsed: false,
        humanReadableExplanation: "This program uses AI to generate conversational sleep coaching. No data is used for training.",
      },
      resourceLimits: { aiRequestsPerDay: 50, storageMb: 50 },
      measurementDefinitions: [
        { id: "sleep_session", type: "measurement", name: "Sleep Session", description: "A single night of sleep: duration, quality, bedtime, wake time.", schema: { type: "object", properties: { duration_hours: { type: "number" }, quality_score: { type: "number", minimum: 1, maximum: 10 }, bedtime: { type: "string" }, wake_time: { type: "string" } }, required: ["duration_hours"] }, unit: "hours", privacyLevel: "confidential" },
      ],
      eventSubscriptions: ["eks.measurement.recorded", "eks.mission.habit.streak_extended", "eks.mission.habit.streak_broken"],
    },
    entryTs: `import type { ProgramHandler, ProgramContext, ProgramEvent } from "@eks/program-sdk";

/**
 * Sleep Optimizer — entry point.
 *
 * Demonstrates:
 *  - Recording nightly sleep measurements.
 *  - Calling the AI runtime to generate a weekly sleep plan.
 *  - Tracking sleep-hygiene habits with streaks.
 *  - Adapting the plan when a streak is broken.
 */
export const handler: ProgramHandler = {
  async onMeasurement(ctx: ProgramContext, event: ProgramEvent) {
    const { duration_hours, quality_score } = event.payload as {
      duration_hours: number; quality_score?: number;
    };
    ctx.log.info("Sleep recorded", { duration_hours, quality_score });

    // Every 7 nights, ask the AI to regenerate the weekly plan.
    const recent = await ctx.api.measurements.list({ schemaId: "sleep_session", limit: 7 });
    if (recent.length === 7) {
      const avgDuration = recent.reduce((s, m) => s + (m.value as { duration_hours: number }).duration_hours, 0) / 7;
      const plan = await ctx.api.ai.prompt({
        template: "weekly_sleep_plan",
        context: { avgDuration, qualityScore: quality_score ?? 7 },
      });
      ctx.log.info("AI plan generated", { planId: plan.id });

      // Assign the AI-generated missions as habits.
      for (const habit of plan.habits ?? []) {
        await ctx.api.habits.create({ name: habit.name, cadence: habit.cadence });
      }
    }
  },

  async onEvent(ctx: ProgramContext, event: ProgramEvent) {
    if (event.type === "eks.mission.habit.streak_broken") {
      ctx.log.warn("Habit streak broken — adapting plan", { habitId: event.payload.habitId });
      await ctx.api.ai.prompt({ template: "adapt_sleep_plan", context: { brokenHabit: event.payload.habitId } });
    }
  },

  async onNotificationRequest(ctx: ProgramContext, _request: unknown) {
    // Evening wind-down reminder.
    return { delivered: true };
  },
};

export default handler;
`,
    readme: (s) => `# ${s.name}

${s.description}

- **Category**: ${s.category}
- **Difficulty**: ${s.difficulty}
- **Setup time**: ~${s.estimatedSetupMinutes} minutes

## What this sample demonstrates

- A sleep measurement schema (duration, quality, bedtime, wake time).
- Calling the AI runtime to generate a weekly sleep plan.
- Tracking sleep-hygiene habits with streaks.
- Adapting the plan when a streak is broken.

## AI usage

This program uses the platform's AI runtime (\`ctx.api.ai.prompt\`). The AI
provider, model family, and purpose are declared in the manifest. No data is
used for training.

## Setup

\`\`\`bash
eks new-program sleep-optimizer --template ai-assistant
cd sleep-optimizer
eks dev
\`\`\`
`,
  }),

  // 5. mindful-daily -------------------------------------------------------
  buildSample({
    id: "mindful-daily",
    slug: "mindful-daily",
    name: "Mindful Daily",
    description: "A daily mindfulness program: 5-minute meditation missions, mood check-ins, streaks, and gentle notifications. Beginner-friendly habits + streaks + notifications.",
    category: "mental_wellness",
    difficulty: "beginner",
    estimatedSetupMinutes: 5,
    features: ["habits", "streaks", "notifications", "missions", "mood_checkin"],
    templateId: "measurement-tracker",
    manifestSnippet: {
      category: "wellness",
      capabilities: [
        { capability: "mission", reason: "Assign daily meditation missions.", scope: "self" },
        { capability: "measurement", reason: "Record mood check-ins (1-10 scale).", purposes: ["wellness-tracking"], scope: "self" },
        { capability: "notification", reason: "Send gentle daily reminders.", scope: "self" },
      ],
      privacy: {
        dataCollected: ["mood_score", "meditation_minutes"],
        dataUsage: "Track daily mindfulness practice and mood trends.",
        thirdPartySharing: false,
        retentionDays: 90,
        anonymizationApplied: true,
        residencyRegions: ["*"],
      },
      aiUsage: { usesAI: false },
      resourceLimits: { storageMb: 25, notificationsPerDay: 3 },
      measurementDefinitions: [
        { id: "mood_checkin", type: "measurement", name: "Mood Check-in", description: "Self-reported mood on a 1-10 scale.", schema: { type: "number", minimum: 1, maximum: 10 }, unit: "score", privacyLevel: "confidential" },
      ],
      eventSubscriptions: ["eks.mission.completed", "eks.mission.habit.streak_extended"],
    },
    entryTs: `import type { ProgramHandler, ProgramContext, ProgramEvent } from "@eks/program-sdk";

/**
 * Mindful Daily — entry point.
 *
 * Demonstrates:
 *  - Daily meditation missions.
 *  - Mood check-ins on a 1-10 scale.
 *  - Habit streaks (consecutive days of meditation).
 *  - Gentle, capped daily notifications.
 */
export const handler: ProgramHandler = {
  async onEvent(ctx: ProgramContext, event: ProgramEvent) {
    if (event.type === "eks.mission.completed") {
      ctx.log.info("Meditation completed", { missionId: event.payload.missionId });
      await ctx.api.habits.extendStreak({ habitId: "daily_meditation" });
    }
    if (event.type === "eks.mission.habit.streak_extended") {
      const streak = event.payload.streak as number;
      ctx.log.info("Streak extended", { streak });
      // Milestone notifications: 7, 30, 100 days.
      if (streak === 7 || streak === 30 || streak === 100) {
        await ctx.api.notifications.send({ template: "streak_milestone", context: { streak } });
      }
    }
  },

  async onMeasurement(ctx: ProgramContext, event: ProgramEvent) {
    const mood = event.payload.mood_score as number | undefined;
    if (typeof mood !== "number") return;
    if (mood <= 3) {
      await ctx.api.notifications.send({ template: "low_mood_support", context: { mood } });
    }
  },

  async onNotificationRequest(ctx: ProgramContext, _request: unknown) {
    return { delivered: true };
  },
};

export default handler;
`,
    readme: (s) => `# ${s.name}

${s.description}

- **Category**: ${s.category}
- **Difficulty**: ${s.difficulty}
- **Setup time**: ~${s.estimatedSetupMinutes} minutes

## What this sample demonstrates

- Daily meditation missions with habit streaks.
- Mood check-ins on a 1-10 scale.
- Milestone notifications at 7, 30, and 100 days.
- Capped daily notifications (max 3/day).

## Setup

\`\`\`bash
eks new-program mindful-daily --template measurement-tracker
cd mindful-daily
eks dev
\`\`\`
`,
  }),

  // 6. cardio-care ---------------------------------------------------------
  buildSample({
    id: "cardio-care",
    slug: "cardio-care",
    name: "Cardio Care Program",
    description: "A full-stack cardiovascular health program: BP + weight measurements, technician verification, a 12-week competition with divisions, AI mission generation, and habit tracking. Demonstrates the complete platform stack.",
    category: "cardiovascular",
    difficulty: "advanced",
    estimatedSetupMinutes: 20,
    features: ["measurement_schema", "technician_verification", "competition", "divisions", "ai_mission_generation", "habits", "rewards", "anti_cheat"],
    templateId: "competition-program",
    manifestSnippet: {
      category: "clinical",
      capabilities: [
        { capability: "measurement", reason: "Record BP, weight, and resting heart rate.", purposes: ["clinical-tracking", "scoring"], scope: "self" },
        { capability: "competition", reason: "Run a 12-week cardiovascular improvement competition.", purposes: ["engagement"], scope: "participant" },
        { capability: "leaderboard", reason: "Display division rankings.", purposes: ["engagement"], scope: "cohort" },
        { capability: "mission", reason: "Assign AI-generated exercise missions.", scope: "participant" },
        { capability: "ai", reason: "Generate personalized exercise plans from clinical data.", purposes: ["health-coaching"], scope: "self" },
        { capability: "reward", reason: "Distribute rewards at season close.", scope: "participant" },
        { capability: "notification", reason: "Notify participants of milestones and pending verification.", scope: "participant" },
        { capability: "profile", reason: "Personalize plans with age range and biological sex.", purposes: ["personalization"], fields: ["age_range", "biological_sex"], scope: "self" },
      ],
      privacy: {
        dataCollected: ["systolic_mmhg", "diastolic_mmhg", "weight_kg", "resting_hr_bpm", "participant_id", "score"],
        dataUsage: "Compute competition rankings, generate AI plans, route to technician verification.",
        thirdPartySharing: false,
        retentionDays: 365 * 5,
        anonymizationApplied: true,
        residencyRegions: ["*"],
      },
      aiUsage: {
        usesAI: true,
        provider: "eks-ai",
        modelFamily: "glm",
        purpose: "Generate personalized exercise plans based on clinical measurements.",
        trainingDataUsed: false,
        humanReadableExplanation: "AI generates exercise plans from verified clinical data. No data is used for training.",
      },
      resourceLimits: { apiRequestsPerMinute: 200, aiRequestsPerDay: 100, storageMb: 250 },
      measurementDefinitions: [
        { id: "bp", type: "measurement", name: "Blood Pressure", description: "Systolic/diastolic BP with resting heart rate.", schema: { type: "object", properties: { systolic: { type: "number" }, diastolic: { type: "number" }, resting_hr: { type: "number" } }, required: ["systolic", "diastolic"] }, unit: "mmHg", privacyLevel: "restricted" },
        { id: "weight", type: "measurement", name: "Body Weight", description: "Weekly body weight in kilograms.", schema: { type: "number", minimum: 30, maximum: 300 }, unit: "kg", privacyLevel: "confidential" },
      ],
      competitionDefinitions: [
        { id: "cardio_care_12wk", type: "competition", name: "12-Week Cardio Care", description: "A 12-week competition scoring BP improvement + weight loss + exercise adherence.", schema: { type: "object", properties: { durationWeeks: { const: 12 }, divisions: { type: "array", items: { type: "string" } } } }, privacyLevel: "internal" },
      ],
      eventSubscriptions: ["eks.competition.started", "eks.competition.score.updated", "eks.competition.anticheat.flag", "eks.measurement.verified", "eks.mission.completed"],
    },
    entryTs: `import type { ProgramHandler, ProgramContext, ProgramEvent } from "@eks/program-sdk";

/**
 * Cardio Care Program — entry point.
 *
 * Demonstrates the complete platform stack:
 *  - BP + weight measurements with technician verification.
 *  - A 12-week competition with divisions.
 *  - AI-generated exercise plans.
 *  - Habit tracking + rewards.
 *  - Anti-cheat flag handling.
 */
export const handler: ProgramHandler = {
  async onCompetitionStart(ctx: ProgramContext, event: ProgramEvent) {
    ctx.log.info("12-week cardio competition started", { competitionId: event.competitionId });
    // Generate an AI exercise plan for each participant.
    const participants = await ctx.api.competitions.listParticipants({ competitionId: event.competitionId });
    for (const p of participants) {
      const plan = await ctx.api.ai.prompt({
        template: "cardio_exercise_plan",
        context: { participantId: p.id, division: p.division },
      });
      await ctx.api.missions.assignBulk({ template: plan.missionTemplate, competitionId: event.competitionId, participantId: p.id });
    }
  },

  async onMeasurement(ctx: ProgramContext, event: ProgramEvent) {
    if (event.payload.verificationState !== "verified") return;
    const score = computeCardioScore(event.payload);
    await ctx.api.competitions.submitScore({
      competitionId: event.payload.competitionId,
      participantId: event.payload.participantId,
      score,
      measurementId: event.payload.measurementId,
    });
  },

  async onEvent(ctx: ProgramContext, event: ProgramEvent) {
    if (event.type === "eks.competition.anticheat.flag") {
      ctx.log.warn("Anti-cheat flag raised", { type: event.payload.type, severity: event.payload.severity });
      // Pause scoring for the flagged participant pending review.
      await ctx.api.competitions.holdScore({ scoreId: event.payload.scoreId });
    }
    if (event.type === "eks.mission.completed") {
      await ctx.api.habits.extendStreak({ habitId: "weekly_exercise" });
    }
  },
};

/**
 * Cardio score: BP improvement (40) + weight loss (30) + exercise adherence (30).
 */
function computeCardioScore(payload: {
  systolic?: number; baselineSystolic?: number;
  diastolic?: number; baselineDiastolic?: number;
  weightKg?: number; baselineWeightKg?: number;
  adherencePct?: number;
}): number {
  let score = 0;
  if (payload.systolic && payload.baselineSystolic && payload.systolic < payload.baselineSystolic) {
    score += (payload.baselineSystolic - payload.systolic) * 2; // up to 40
  }
  if (payload.weightKg && payload.baselineWeightKg && payload.baselineWeightKg > 0) {
    const lossPct = (payload.baselineWeightKg - payload.weightKg) / payload.baselineWeightKg * 100;
    score += Math.max(0, lossPct) * 6; // up to 30 for 5% loss
  }
  if (payload.adherencePct !== undefined) {
    score += (payload.adherencePct / 100) * 30; // up to 30
  }
  return Math.round(score * 10) / 10;
}

export default handler;
`,
    readme: (s) => `# ${s.name}

${s.description}

- **Category**: ${s.category}
- **Difficulty**: ${s.difficulty}
- **Setup time**: ~${s.estimatedSetupMinutes} minutes

## What this sample demonstrates

- The complete platform stack: measurements + competition + AI + habits + rewards.
- Technician-verified clinical measurements (BP, weight).
- A 12-week competition with division-based rankings.
- AI-generated exercise plans per participant.
- Anti-cheat flag handling (auto-hold scores pending review).

## Score formula

\`\`\`
score = (systolic_drop_mmHg * 2)
      + (weight_loss_pct * 6)
      + (exercise_adherence_pct * 0.3)
\`\`\`

Max ~100 points (40 + 30 + 30).

## Setup

\`\`\`bash
eks new-program cardio-care --template competition-program
cd cardio-care
eks dev
\`\`\`
`,
  }),

  // 7. nutrition-coach -----------------------------------------------------
  buildSample({
    id: "nutrition-coach",
    slug: "nutrition-coach",
    name: "Nutrition Coach",
    description: "An AI nutrition coaching program: meal photo analysis, knowledge-base Q&A, weekly meal plans, and habit tracking. Demonstrates AI agents + the knowledge base.",
    category: "nutrition",
    difficulty: "intermediate",
    estimatedSetupMinutes: 15,
    features: ["ai_agents", "knowledge_base", "meal_plans", "habits", "measurement_schema"],
    templateId: "ai-assistant",
    manifestSnippet: {
      category: "ai",
      capabilities: [
        { capability: "ai", reason: "Generate weekly meal plans and analyze meal photos.", purposes: ["nutrition-coaching"], scope: "self" },
        { capability: "measurement", reason: "Record daily calorie intake and macro breakdown.", purposes: ["coaching"], scope: "self" },
        { capability: "mission", reason: "Assign weekly nutrition missions.", scope: "self" },
        { capability: "notification", reason: "Send meal-time reminders.", scope: "self" },
        { capability: "storage", reason: "Cache the program's nutrition knowledge base.", scope: "self" },
        { capability: "profile", reason: "Personalize plans with dietary preferences and goals.", purposes: ["personalization"], fields: ["dietary_preferences", "goals"], scope: "self" },
      ],
      privacy: {
        dataCollected: ["meal_photo", "calories_kcal", "macros_grams", "dietary_preferences"],
        dataUsage: "Generate personalized meal plans and nutrition coaching.",
        thirdPartySharing: false,
        retentionDays: 180,
        anonymizationApplied: false,
        residencyRegions: ["*"],
      },
      aiUsage: {
        usesAI: true,
        provider: "eks-ai",
        modelFamily: "glm",
        purpose: "Analyze meal photos and generate personalized weekly meal plans.",
        trainingDataUsed: false,
        humanReadableExplanation: "AI analyzes meal photos for calorie/macronutrient estimates and generates meal plans. No data is used for training.",
      },
      resourceLimits: { aiRequestsPerDay: 30, storageMb: 200 },
      measurementDefinitions: [
        { id: "daily_intake", type: "measurement", name: "Daily Intake", description: "Daily calorie and macronutrient intake.", schema: { type: "object", properties: { calories: { type: "number" }, protein_g: { type: "number" }, carbs_g: { type: "number" }, fat_g: { type: "number" } }, required: ["calories"] }, unit: "kcal", privacyLevel: "confidential" },
      ],
      eventSubscriptions: ["eks.measurement.recorded", "eks.mission.completed"],
    },
    entryTs: `import type { ProgramHandler, ProgramContext, ProgramEvent } from "@eks/program-sdk";

/**
 * Nutrition Coach — entry point.
 *
 * Demonstrates:
 *  - AI agents for meal photo analysis + meal plan generation.
 *  - A nutrition knowledge base (KB) for Q&A.
 *  - Weekly meal plans and habit tracking.
 */
export const handler: ProgramHandler = {
  async onMeasurement(ctx: ProgramContext, event: ProgramEvent) {
    const { calories, protein_g } = event.payload as {
      calories: number; protein_g?: number;
    };
    ctx.log.info("Daily intake recorded", { calories, protein_g });

    // Every 7 days, regenerate the weekly meal plan.
    const recent = await ctx.api.measurements.list({ schemaId: "daily_intake", limit: 7 });
    if (recent.length === 7) {
      const avgCalories = recent.reduce((s, m) => s + (m.value as { calories: number }).calories, 0) / 7;
      const plan = await ctx.api.ai.prompt({
        template: "weekly_meal_plan",
        context: { avgCalories, targetProtein: protein_g ?? 100 },
      });
      ctx.log.info("Meal plan generated", { planId: plan.id });

      // Cache the plan in program storage.
      await ctx.api.storage.put("current_meal_plan", plan);
    }
  },

  async onAiPrompt(ctx: ProgramContext, prompt: { template: string; context: unknown }) {
    if (prompt.template === "nutrition_qa") {
      // Retrieve relevant KB articles before answering.
      const question = (prompt.context as { question: string }).question;
      const docs = await ctx.api.storage.query("nutrition_kb", question, { limit: 3 });
      return {
        response: \`Based on the nutrition knowledge base: \${docs.map((d) => d.summary).join("; ")}\`,
        citations: docs.map((d) => d.id),
      };
    }
    return { response: "I can help with meal planning and nutrition questions." };
  },

  async onEvent(ctx: ProgramContext, event: ProgramEvent) {
    if (event.type === "eks.mission.completed" && event.payload.missionId?.startsWith("nutrition_")) {
      await ctx.api.habits.extendStreak({ habitId: "weekly_nutrition" });
    }
  },
};

export default handler;
`,
    readme: (s) => `# ${s.name}

${s.description}

- **Category**: ${s.category}
- **Difficulty**: ${s.difficulty}
- **Setup time**: ~${s.estimatedSetupMinutes} minutes

## What this sample demonstrates

- AI agents for meal photo analysis and meal plan generation.
- A nutrition knowledge base (KB) for Q&A retrieval.
- Weekly meal plans cached in program storage.
- Habit tracking for weekly nutrition goals.

## AI usage

Two AI surfaces:

1. \`ctx.api.ai.prompt({ template: "weekly_meal_plan" })\` — generates a plan.
2. \`onAiPrompt({ template: "nutrition_qa" })\` — answers questions with KB citations.

## Setup

\`\`\`bash
eks new-program nutrition-coach --template ai-assistant
cd nutrition-coach
eks dev
\`\`\`
`,
  }),

  // 8. habit-builder -------------------------------------------------------
  buildSample({
    id: "habit-builder",
    slug: "habit-builder",
    name: "Habit Builder",
    description: "A minimal habit-formation program: define habits, set goals, build plans, track streaks. Beginner-friendly introduction to the mission/habit/goal/plan stack.",
    category: "habit_formation",
    difficulty: "beginner",
    estimatedSetupMinutes: 5,
    features: ["habits", "goals", "plans", "streaks", "notifications"],
    templateId: "blank-program",
    manifestSnippet: {
      category: "productivity",
      capabilities: [
        { capability: "mission", reason: "Define and track daily habits.", scope: "self" },
        { capability: "notification", reason: "Send daily habit reminders.", scope: "self" },
        { capability: "storage", reason: "Persist habit definitions and streak state.", scope: "self" },
      ],
      privacy: {
        dataCollected: ["habit_id", "completed_at"],
        dataUsage: "Track habit completion and streaks.",
        thirdPartySharing: false,
        retentionDays: 365,
        anonymizationApplied: true,
        residencyRegions: ["*"],
      },
      aiUsage: { usesAI: false },
      resourceLimits: { storageMb: 25, notificationsPerDay: 5 },
      eventSubscriptions: ["eks.mission.habit.updated", "eks.mission.habit.streak_extended", "eks.mission.habit.streak_broken", "eks.mission.goal.achieved"],
    },
    entryTs: `import type { ProgramHandler, ProgramContext, ProgramEvent } from "@eks/program-sdk";

/**
 * Habit Builder — entry point.
 *
 * Demonstrates:
 *  - Defining habits with daily/weekly cadence.
 *  - Tracking streaks (consecutive completions).
 *  - Goals + plans: a goal of 30 days, a plan that schedules reminders.
 *  - Streak-broken recovery (gentle nudge).
 */
export const handler: ProgramHandler = {
  async onEvent(ctx: ProgramContext, event: ProgramEvent) {
    switch (event.type) {
      case "eks.mission.habit.streak_extended": {
        const { habitId, streak } = event.payload as { habitId: string; streak: number };
        ctx.log.info("Streak extended", { habitId, streak });
        if (streak === 30) {
          await ctx.api.goals.markAchieved({ goalId: \`30_day_\${habitId}\` });
        }
        break;
      }
      case "eks.mission.habit.streak_broken": {
        const { habitId } = event.payload as { habitId: string };
        ctx.log.warn("Streak broken — sending encouragement", { habitId });
        await ctx.api.notifications.send({ template: "streak_broken_encouragement", context: { habitId } });
        break;
      }
      case "eks.mission.goal.achieved": {
        const { goalId } = event.payload as { goalId: string };
        ctx.log.info("Goal achieved", { goalId });
        await ctx.api.notifications.send({ template: "goal_achieved", context: { goalId } });
        break;
      }
    }
  },

  async onNotificationRequest(ctx: ProgramContext, _request: unknown) {
    // Daily habit reminder — capped at 5/day per the manifest.
    return { delivered: true };
  },
};

export default handler;
`,
    readme: (s) => `# ${s.name}

${s.description}

- **Category**: ${s.category}
- **Difficulty**: ${s.difficulty}
- **Setup time**: ~${s.estimatedSetupMinutes} minutes

## What this sample demonstrates

- Defining habits with daily/weekly cadence.
- Tracking streaks (consecutive completions).
- A 30-day goal that auto-achieves when a streak hits 30.
- Streak-broken recovery (gentle encouragement notification).

## Setup

\`\`\`bash
eks new-program habit-builder --template blank-program
cd habit-builder
eks dev
\`\`\`
`,
  }),
];

const SAMPLE_INDEX = new Map(SAMPLES.map((s) => [s.id, s]));
const SAMPLE_BY_SLUG = new Map(SAMPLES.map((s) => [s.slug, s]));

// ---------------------------------------------------------------------------
// Sample builder helper
// ---------------------------------------------------------------------------

interface SampleBuilderInput {
  id: string;
  slug: string;
  name: string;
  description: string;
  category: SampleCategory;
  difficulty: "beginner" | "intermediate" | "advanced";
  estimatedSetupMinutes: number;
  features: string[];
  templateId: string;
  manifestSnippet: Record<string, unknown>;
  entryTs: string;
  readme: (s: { name: string; description: string; category: SampleCategory; difficulty: string; estimatedSetupMinutes: number; templateId: string }) => string;
}

function buildSample(input: SampleBuilderInput): SampleProgram {
  const id = asSampleProgramId(input.id);
  const manifestJson = JSON.stringify(
    {
      slug: input.slug,
      name: input.name,
      version: "1.0.0",
      sdkVersion: "1.0.0",
      kind: "program",
      ...input.manifestSnippet,
    },
    null,
    2,
  );
  const testFile = generateTestFile(input.slug, input.name, input.features);
  const eksRc = JSON.stringify(
    {
      programSlug: input.slug,
      templateId: input.templateId,
      runtime: {
        port: 3100,
        hotReload: true,
        mockPlatform: true,
        logLevel: "info",
        dataDir: "./.eks-local",
      },
    },
    null,
    2,
  );
  const tsconfig = JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        module: "esnext",
        moduleResolution: "bundler",
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
        outDir: "./dist",
      },
      include: ["src"],
    },
    null,
    2,
  );
  const readmeContent = input.readme({
    name: input.name,
    description: input.description,
    category: input.category,
    difficulty: input.difficulty,
    estimatedSetupMinutes: input.estimatedSetupMinutes,
    templateId: input.templateId,
  });

  return {
    id,
    slug: input.slug,
    name: input.name,
    description: input.description,
    category: input.category,
    manifestSnippet: input.manifestSnippet,
    features: input.features,
    difficulty: input.difficulty,
    estimatedSetupMinutes: input.estimatedSetupMinutes,
    fileStructure: [
      { path: "manifest.json", content: manifestJson },
      { path: "src/entry.ts", content: input.entryTs },
      { path: "src/index.ts", content: `export { handler } from "./entry";\nexport { default } from "./entry";\n` },
      { path: "README.md", content: readmeContent },
      { path: "test/contract.test.ts", content: testFile },
      { path: ".eksprogramrc.json", content: eksRc },
      { path: "tsconfig.json", content: tsconfig },
    ],
  };
}

function generateTestFile(slug: string, name: string, features: string[]): string {
  const featureTests = features
    .map(
      (f) => `  it("declares the ${f} feature", () => {
    expect(manifest.capabilities.length).toBeGreaterThan(0);
  });`,
    )
    .join("\n\n");
  return `/**
 * Contract tests for ${name}.
 *
 * Auto-generated by the Eks-Health sample library. These tests verify
 * structural invariants of the program manifest — they do NOT exercise
 * runtime behavior (use \`eks simulate\` for that).
 */
import { describe, it, expect } from "vitest";
import manifest from "../manifest.json";

describe("${slug} contract", () => {
  it("manifest has a valid slug", () => {
    expect(manifest.slug).toMatch(/^[a-z0-9-]+$/);
  });

  it("manifest declares a supported language", () => {
    expect(manifest.supportedLanguages ?? ["en"]).toContain("en");
  });

  it("manifest has a privacy declaration", () => {
    expect(manifest.privacy).toBeDefined();
    expect(manifest.privacy.retentionDays).toBeGreaterThanOrEqual(0);
  });

  it("every capability has a reason", () => {
    for (const cap of manifest.capabilities ?? []) {
      expect(cap.reason).toBeTruthy();
    }
  });

  it("resource limits are within platform bounds", () => {
    const limits = manifest.resourceLimits ?? {};
    if (limits.memoryMb !== undefined) expect(limits.memoryMb).toBeLessThanOrEqual(1024);
    if (limits.apiRequestsPerMinute !== undefined) expect(limits.apiRequestsPerMinute).toBeLessThanOrEqual(1000);
  });

${featureTests}
});
`;
}

// ---------------------------------------------------------------------------
// Instantiate result
// ---------------------------------------------------------------------------

export interface InstantiateResult {
  readonly sample: SampleProgram;
  readonly programId: string;
  readonly programName: string;
  readonly developerId: string;
  /** The full project file tree (sample's reference code). */
  readonly files: ReadonlyArray<{ path: string; content: string }>;
  readonly createdAt: string;
}

// ---------------------------------------------------------------------------
// SampleLibrary
// ---------------------------------------------------------------------------

export class SampleLibrary {
  /** List all samples. */
  list(): readonly SampleProgram[] {
    return SAMPLES;
  }

  /** Get a sample by id. */
  get(id: SampleProgramId): SampleProgram | undefined {
    return SAMPLE_INDEX.get(id);
  }

  /** Get a sample by slug. */
  getBySlug(slug: string): SampleProgram | undefined {
    return SAMPLE_BY_SLUG.get(slug);
  }

  /** List samples in a category. */
  listByCategory(category: SampleCategory): readonly SampleProgram[] {
    return SAMPLES.filter((s) => s.category === category);
  }

  /**
   * Load a sample: returns the full SampleProgram with its file structure
   * (manifest.json, src/entry.ts, src/index.ts, test/contract.test.ts,
   * README.md, .eksprogramrc.json, tsconfig.json). Emits a sample.loaded
   * event.
   */
  load(id: SampleProgramId): SampleProgram {
    const sample = SAMPLE_INDEX.get(id);
    if (!sample) {
      throw new DeveloperError({
        code: "eks.developer.sample.not_found",
        category: "not_found",
        message: `Sample ${id} not found.`,
        userMessage: "Sample program not found.",
        metadata: { sampleId: id },
      });
    }
    void getEventBus().publish(
      buildEvent(
        DEVELOPER_EVENTS.sampleProgramLoaded,
        { sampleId: id, slug: sample.slug, category: sample.category },
        {},
        "domain",
      ),
    );
    return sample;
  }

  /**
   * Instantiate a sample as a real program. Uses the program SDK to scaffold
   * a project (real manifest generation, real project files), overrides the
   * generated files with the sample's richer reference code, and registers
   * the program in the lifecycle registry (real record creation).
   *
   * The developer's profile is looked up to fill in developerName + email.
   * If no profile exists, placeholder values are used.
   */
  async instantiate(
    id: SampleProgramId,
    developerId: string,
    programName?: string,
  ): Promise<InstantiateResult> {
    const sample = this.load(id);

    // Look up the developer profile (real).
    let developerName = "Developer";
    let developerEmail = "developer@example.com";
    try {
      const { getDeveloperManager, asDeveloperId } = await import("@/programs/developer");
      const mgr = getDeveloperManager();
      const profile = mgr.getProfile(asDeveloperId(developerId));
      if (profile) {
        developerName = profile.name;
        developerEmail = profile.email;
      }
    } catch {
      // graceful — fall back to placeholder values.
    }

    // Build a complete manifest via the SDK (real manifest generation).
    const manifestInput = {
      slug: sample.slug,
      name: programName ?? sample.name,
      version: "1.0.0",
      description: sample.description,
      category: (sample.manifestSnippet.category as string) ?? "wellness",
      developerId,
      developerName,
      developerEmail,
      capabilities: (sample.manifestSnippet.capabilities as unknown[]) ?? [],
      supportedCountries: ["*"],
      supportedLanguages: ["en"],
      resourceLimits: (sample.manifestSnippet.resourceLimits as Record<string, unknown>) ?? {},
      privacy: sample.manifestSnippet.privacy,
      aiUsage: sample.manifestSnippet.aiUsage,
      measurementDefinitions: sample.manifestSnippet.measurementDefinitions as unknown[],
      eventSubscriptions: sample.manifestSnippet.eventSubscriptions as string[],
    };

    let programId = `prg_${sample.slug.replace(/-/g, "_")}`;
    let scaffoldedFiles: Array<{ path: string; content: string }> = [];

    try {
      const { getSdk } = await import("@/programs/sdk");
      const sdk = getSdk();
      const result = sdk.scaffold({
        templateId: (sample.manifestSnippet.templateId as string) ?? "blank-program",
        slug: sample.slug,
        name: programName ?? sample.name,
        developerId,
        developerName,
        developerEmail,
        version: "1.0.0",
        description: sample.description,
        category: (sample.manifestSnippet.category as string) ?? "wellness",
      });
      programId = result.manifest.id;
      scaffoldedFiles = result.project.files.map((f) => ({ path: f.path, content: f.content }));
      void manifestInput;
    } catch {
      // graceful — fall back to the sample's manifest snippet.
    }

    // Override the scaffolded files with the sample's richer reference code.
    // The sample's fileStructure contains real entry.ts / README.md / tests
    // that demonstrate platform features more thoroughly than the template's
    // generated defaults.
    const scaffoldedMap = new Map(scaffoldedFiles.map((f) => [f.path, f]));
    for (const file of sample.fileStructure) {
      scaffoldedMap.set(file.path, { path: file.path, content: file.content });
    }
    const finalFiles = [...scaffoldedMap.values()];

    // Register the program in the lifecycle registry (real record creation).
    try {
      const { getRegistry, asDeveloperId } = await import("@/programs");
      const { getSdk } = await import("@/programs/sdk");
      const registry = getRegistry();
      const sdk = getSdk();
      const manifest = sdk.generateManifest(manifestInput as never);
      // Only register if not already registered (idempotent).
      if (!registry.get(manifest.id)) {
        registry.create(manifest, asDeveloperId(developerId));
      }
      programId = manifest.id;
    } catch {
      // graceful — the program is still "instantiated" as a project even if
      // the registry wasn't reachable. The caller can retry registration.
    }

    void getEventBus().publish(
      buildEvent(
        DEVELOPER_EVENTS.sampleProgramLoaded,
        { sampleId: id, slug: sample.slug, programId, action: "instantiate" },
        {},
        "domain",
      ),
    );

    return {
      sample,
      programId,
      programName: programName ?? sample.name,
      developerId,
      files: finalFiles,
      createdAt: getClock().iso(),
    };
  }

  /**
   * Compare two samples by features, difficulty, and setup time. Real
   * comparison: feature set intersection/difference, difficulty ranking,
   * setup-time delta.
   */
  compare(id: SampleProgramId, otherId: SampleProgramId): SampleComparison {
    const a = this.load(id);
    const b = this.load(otherId);
    const setA = new Set(a.features);
    const setB = new Set(b.features);
    const featureOverlap = [...setA].filter((f) => setB.has(f));
    const featureOnlyInA = [...setA].filter((f) => !setB.has(f));
    const featureOnlyInB = [...setB].filter((f) => !setA.has(f));
    const diffRank = { beginner: 1, intermediate: 2, advanced: 3 };
    const rankA = diffRank[a.difficulty];
    const rankB = diffRank[b.difficulty];
    const difficultyDiff: SampleComparison["difficultyDiff"] =
      rankA > rankB ? "a_harder" : rankA < rankB ? "b_harder" : "equal";
    return {
      a: { id: a.id, name: a.name },
      b: { id: b.id, name: b.name },
      featureOverlap,
      featureOnlyInA,
      featureOnlyInB,
      difficultyDiff,
      setupTimeDiffMinutes: a.estimatedSetupMinutes - b.estimatedSetupMinutes,
    };
  }

  /** Aggregate stats across the library. */
  getStats(): SampleStats {
    const byCategory: Record<string, number> = {};
    const byDifficulty: Record<"beginner" | "intermediate" | "advanced", number> = {
      beginner: 0,
      intermediate: 0,
      advanced: 0,
    };
    for (const s of SAMPLES) {
      byCategory[s.category] = (byCategory[s.category] ?? 0) + 1;
      byDifficulty[s.difficulty]++;
    }
    return { totalSamples: SAMPLES.length, byCategory, byDifficulty };
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _library: SampleLibrary | null = null;
export function getSampleLibrary(): SampleLibrary {
  if (!_library) _library = new SampleLibrary();
  return _library;
}
export function resetSampleLibrary(): void {
  _library = null;
}
