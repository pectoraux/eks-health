/**
 * Eks-Health Mission Engine — Explainability
 *
 * Every recommendation, mission assignment, and plan change should be
 * EXPLAINABLE. Participants can ask:
 *   - "Why was this mission assigned?"
 *   - "Why did my plan change?"
 *   - "Why is this recommendation important?"
 *
 * Programs register explanation templates (with {variable} placeholders).
 * The engine fetches the subject's real data (mission / goal / plan /
 * recommendation), renders the template, and constructs structured factors
 * that the UI can present consistently.
 */

import "server-only";
import {
  type ExplanationId,
  type Explanation,
  type ProgramId,
  type AccountId,
  type Recommendation,
  type MissionId,
  type GoalId,
  type PlanId,
  MissionError,
  asExplanationId,
  asMissionId,
  asGoalId,
  asPlanId,
} from "../core";
import { getEventBus, buildEvent, generateId, getClock } from "@/kernel";
import { getMissions } from "../missions";
import { getGoals } from "../goals";
import { getPlans } from "../plans";
import { getPersonalization } from "../personalization";

// ---------------------------------------------------------------------------
// Explanation types
// ---------------------------------------------------------------------------

export type ExplanationSubjectType = Explanation["subjectType"];

export interface ExplanationRequest {
  readonly participantId: AccountId;
  readonly subjectType: ExplanationSubjectType;
  readonly subjectId: string;
  readonly question: string;
  readonly programId?: ProgramId;
}

export interface ExplanationTemplate {
  readonly id: string;
  readonly programId?: ProgramId;
  readonly subjectType: ExplanationSubjectType;
  readonly question: string; // canonical question this template answers
  readonly template: string; // {variable} placeholders
  readonly factors?: ReadonlyArray<{ label: string; variable: string; weight?: number }>;
}

export interface ExplanationFactor {
  readonly label: string;
  readonly value: string;
  readonly weight?: number;
}

export interface ExplanationStats {
  readonly total: number;
  readonly bySubjectType: Record<string, number>;
  readonly avgFactorsPerExplanation: number;
  readonly totalTemplates: number;
}

export type RecommendationProvider = (
  id: string,
) => Recommendation | undefined;

// ---------------------------------------------------------------------------
// Explainability engine
// ---------------------------------------------------------------------------

export class ExplainabilityEngine {
  private readonly templates = new Map<string, ExplanationTemplate>();
  private readonly explanations = new Map<ExplanationId, Explanation>();
  private readonly byParticipant = new Map<AccountId, ExplanationId[]>();
  private readonly bySubject = new Map<string, ExplanationId[]>();
  private recommendationProvider: RecommendationProvider | null = null;

  /** Register a provider that resolves recommendation ids (set by m7-2). */
  registerRecommendationProvider(provider: RecommendationProvider): void {
    this.recommendationProvider = provider;
  }

  registerTemplate(template: ExplanationTemplate): ExplanationTemplate {
    this.templates.set(template.id, template);
    return template;
  }

  getTemplate(id: string): ExplanationTemplate | undefined {
    return this.templates.get(id);
  }

  listTemplates(programId?: ProgramId, subjectType?: ExplanationSubjectType): ExplanationTemplate[] {
    let list = [...this.templates.values()];
    if (programId) list = list.filter((t) => t.programId === programId || t.programId === undefined);
    if (subjectType) list = list.filter((t) => t.subjectType === subjectType);
    return list;
  }

  /**
   * Generate an explanation for a subject. Fetches the subject's real data,
   * picks the best matching template, renders it, and constructs structured
   * factors.
   */
  generate(request: ExplanationRequest): Explanation {
    const subject = this.fetchSubject(request.subjectType, request.subjectId);
    if (!subject) {
      throw new MissionError({
        code: "eks.mission.explanation.subject_not_found",
        category: "not_found",
        message: `${request.subjectType} ${request.subjectId} not found.`,
        userMessage: "The subject of this explanation could not be found.",
        metadata: { subjectType: request.subjectType, subjectId: request.subjectId },
      });
    }

    const programId = (subject.programId as ProgramId | undefined) ?? request.programId;
    if (!programId) {
      throw new MissionError({
        code: "eks.mission.explanation.no_program",
        category: "validation",
        message: "Cannot determine programId for explanation.",
        userMessage: "Cannot generate explanation without a program context.",
      });
    }

    const template = this.findTemplate(programId, request.subjectType, request.question);
    const variables = this.buildVariables(subject, request);
    const answer = template
      ? this.renderTemplate(template.template, variables)
      : this.defaultAnswer(request, subject);
    const factors = this.buildFactors(subject, request, template, variables);

    const explanation: Explanation = {
      id: asExplanationId(generateId("exp_")),
      programId,
      participantId: request.participantId,
      subjectType: request.subjectType,
      subjectId: request.subjectId,
      question: request.question,
      answer,
      factors,
      aiTraceId: this.extractAiTrace(subject),
      createdAt: getClock().iso(),
    };
    this.explanations.set(explanation.id, explanation);
    const pList = this.byParticipant.get(request.participantId) ?? [];
    this.byParticipant.set(request.participantId, [...pList, explanation.id]);
    const subjKey = `${request.subjectType}:${request.subjectId}`;
    const sList = this.bySubject.get(subjKey) ?? [];
    this.bySubject.set(subjKey, [...sList, explanation.id]);

    void getEventBus().publish(
      buildEvent(
        "eks.mission.explanation.generated",
        {
          explanationId: explanation.id,
          participantId: request.participantId,
          programId,
          subjectType: request.subjectType,
          subjectId: request.subjectId,
          factorCount: factors.length,
        },
        {},
        "domain",
      ),
    );
    void getEventBus().publish(
      buildEvent(
        "eks.mission.explanation.requested",
        {
          explanationId: explanation.id,
          participantId: request.participantId,
          question: request.question,
        },
        {},
        "domain",
      ),
    );
    return explanation;
  }

  get(id: ExplanationId): Explanation | undefined {
    return this.explanations.get(id);
  }

  list(filter?: { participantId?: AccountId; subjectType?: ExplanationSubjectType }): Explanation[] {
    let list = [...this.explanations.values()];
    if (filter?.participantId) list = list.filter((e) => e.participantId === filter.participantId);
    if (filter?.subjectType) list = list.filter((e) => e.subjectType === filter.subjectType);
    return list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Shortcut: why was this mission assigned? */
  explainMission(missionId: string): Explanation {
    const mission = getMissions().get(asMissionId(missionId));
    if (!mission) {
      throw new MissionError({
        code: "eks.mission.explanation.mission_not_found",
        category: "not_found",
        message: `Mission ${missionId} not found.`,
        userMessage: "Mission not found.",
      });
    }
    // Build personalization context (best-effort) to enrich the explanation.
    let contextFactors: ExplanationFactor[] = [];
    try {
      const result = getPersonalization().buildResult({
        participantId: mission.participantId,
        programId: mission.programId,
      });
      contextFactors = [
        {
          label: "Recent activity",
          value: result.context.behaviorHistory?.lastActiveAt ?? "no recent activity",
          weight: 0.6,
        },
        {
          label: "Mission completion rate",
          value: result.context.behaviorHistory
            ? `${(result.context.behaviorHistory.missionCompletionRate * 100).toFixed(0)}%`
            : "unknown",
          weight: 0.7,
        },
      ];
    } catch {
      /* personalization unavailable */
    }
    // Fetch the plan this mission belongs to (if any)
    let planName = "standalone (no plan)";
    if (mission.planId) {
      try {
        const plan = getPlans().get(mission.planId);
        if (plan) planName = plan.name;
      } catch {
        /* plans unavailable */
      }
    }
    const request: ExplanationRequest = {
      participantId: mission.participantId,
      subjectType: "mission",
      subjectId: missionId,
      question: "Why was this mission assigned?",
      programId: mission.programId,
    };
    const explanation = this.generate(request);
    // Merge in the mission-specific context factors
    const merged: Explanation = {
      ...explanation,
      factors: [
        ...explanation.factors,
        { label: "Plan", value: planName, weight: 0.8 },
        { label: "Mission type", value: mission.type, weight: 0.5 },
        { label: "Category", value: mission.category, weight: 0.5 },
        { label: "Priority", value: mission.priority, weight: 0.6 },
        { label: "Difficulty", value: mission.difficulty, weight: 0.4 },
        {
          label: "Assigned by",
          value: mission.aiGenerated ? `AI (trace ${mission.aiTraceId ?? "n/a"})` : "Program",
          weight: 0.7,
        },
        ...contextFactors,
      ],
    };
    this.explanations.set(merged.id, merged);
    return merged;
  }

  /** Shortcut: why did the plan change at this version? */
  explainPlanChange(planId: string, version: number): Explanation {
    const plans = getPlans();
    const pid = asPlanId(planId);
    const plan = plans.get(pid);
    if (!plan) {
      throw new MissionError({
        code: "eks.mission.explanation.plan_not_found",
        category: "not_found",
        message: `Plan ${planId} not found.`,
        userMessage: "Plan not found.",
      });
    }
    // Find the adaptation that produced this version
    const adaptations = plans.getAdaptations(pid);
    const adaptation = adaptations.find((a) => a.newVersion === version);
    // Find the snapshot at the previous version
    const history = plans.getVersionHistory(pid);
    const prevSnap = history.find((s) => s.version === version - 1);

    const factors: ExplanationFactor[] = [];
    if (adaptation) {
      factors.push(
        { label: "Trigger", value: adaptation.trigger, weight: 1.0 },
        { label: "Action", value: adaptation.action, weight: 1.0 },
        { label: "Reason", value: adaptation.reason, weight: 0.9 },
        { label: "Applied", value: adaptation.applied ? "yes" : "no (trigger not met)", weight: 0.8 },
      );
      if (adaptation.params) {
        factors.push({ label: "Parameters", value: JSON.stringify(adaptation.params), weight: 0.5 });
      }
    } else {
      factors.push({
        label: "Version change",
        value: `No adaptation recorded for version ${version}; change was a manual update.`,
        weight: 0.7,
      });
    }
    if (prevSnap) {
      factors.push(
        { label: "Previous state", value: prevSnap.state, weight: 0.6 },
        {
          label: "Previous mission count",
          value: String(prevSnap.missionIds.length),
          weight: 0.4,
        },
      );
    }

    const answer = adaptation
      ? `Plan "${plan.name}" changed to version ${version} because the adaptivity rule "${adaptation.trigger}" matched. Action "${adaptation.action}" was applied: ${adaptation.reason}`
      : `Plan "${plan.name}" was manually updated to version ${version}.`;

    const explanation: Explanation = {
      id: asExplanationId(generateId("exp_")),
      programId: plan.programId,
      participantId: plan.participantId,
      subjectType: "plan",
      subjectId: planId,
      question: `Why did the plan change to version ${version}?`,
      answer,
      factors,
      createdAt: getClock().iso(),
    };
    this.explanations.set(explanation.id, explanation);
    const pList = this.byParticipant.get(plan.participantId) ?? [];
    this.byParticipant.set(plan.participantId, [...pList, explanation.id]);
    const sList = this.bySubject.get(`plan:${planId}`) ?? [];
    this.bySubject.set(`plan:${planId}`, [...sList, explanation.id]);

    void getEventBus().publish(
      buildEvent(
        "eks.mission.explanation.generated",
        {
          explanationId: explanation.id,
          participantId: plan.participantId,
          programId: plan.programId,
          subjectType: "plan",
          subjectId: planId,
          factorCount: factors.length,
        },
        {},
        "domain",
      ),
    );
    return explanation;
  }

  /** Shortcut: why is this recommendation important? */
  explainRecommendation(recommendationId: string): Explanation {
    let recommendation: Recommendation | undefined;
    if (this.recommendationProvider) {
      try {
        recommendation = this.recommendationProvider(recommendationId);
      } catch {
        recommendation = undefined;
      }
    }
    if (!recommendation) {
      throw new MissionError({
        code: "eks.mission.explanation.recommendation_not_found",
        category: "not_found",
        message: `Recommendation ${recommendationId} not found.${this.recommendationProvider ? "" : " No recommendation provider registered."}`,
        userMessage: "Recommendation not found.",
        metadata: { recommendationId, providerRegistered: this.recommendationProvider !== null },
      });
    }
    const factors: ExplanationFactor[] = [
      { label: "Source", value: recommendation.source, weight: 1.0 },
      { label: "Rationale", value: recommendation.rationale, weight: 1.0 },
      { label: "Category", value: recommendation.category, weight: 0.6 },
      { label: "Priority", value: recommendation.priority, weight: 0.7 },
      { label: "Status", value: recommendation.status, weight: 0.5 },
    ];
    if (recommendation.aiTraceId) {
      factors.push({ label: "AI trace", value: recommendation.aiTraceId, weight: 0.8 });
    }
    if (recommendation.relatedMissionId) {
      factors.push({ label: "Related mission", value: recommendation.relatedMissionId, weight: 0.6 });
    }
    if (recommendation.relatedGoalId) {
      factors.push({ label: "Related goal", value: recommendation.relatedGoalId, weight: 0.6 });
    }

    const answer = `This recommendation (${recommendation.title}) was generated by ${recommendation.source}. ${recommendation.rationale}`;

    const explanation: Explanation = {
      id: asExplanationId(generateId("exp_")),
      programId: recommendation.programId,
      participantId: recommendation.participantId,
      subjectType: "recommendation",
      subjectId: recommendationId,
      question: "Why is this recommendation important?",
      answer,
      factors,
      aiTraceId: recommendation.aiTraceId,
      createdAt: getClock().iso(),
    };
    this.explanations.set(explanation.id, explanation);
    const pList = this.byParticipant.get(recommendation.participantId) ?? [];
    this.byParticipant.set(recommendation.participantId, [...pList, explanation.id]);
    const sList = this.bySubject.get(`recommendation:${recommendationId}`) ?? [];
    this.bySubject.set(`recommendation:${recommendationId}`, [...sList, explanation.id]);

    void getEventBus().publish(
      buildEvent(
        "eks.mission.explanation.generated",
        {
          explanationId: explanation.id,
          participantId: recommendation.participantId,
          programId: recommendation.programId,
          subjectType: "recommendation",
          subjectId: recommendationId,
          factorCount: factors.length,
        },
        {},
        "domain",
      ),
    );
    return explanation;
  }

  getStats(programId?: ProgramId): ExplanationStats {
    let list = [...this.explanations.values()];
    if (programId) list = list.filter((e) => e.programId === programId);
    const bySubjectType: Record<string, number> = {};
    let totalFactors = 0;
    for (const e of list) {
      bySubjectType[e.subjectType] = (bySubjectType[e.subjectType] ?? 0) + 1;
      totalFactors += e.factors.length;
    }
    const templateCount = programId
      ? this.listTemplates(programId).length
      : this.templates.size;
    return {
      total: list.length,
      bySubjectType,
      avgFactorsPerExplanation: list.length > 0 ? totalFactors / list.length : 0,
      totalTemplates: templateCount,
    };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private fetchSubject(
    subjectType: ExplanationSubjectType,
    subjectId: string,
  ): { programId: ProgramId; participantId: AccountId; [k: string]: unknown } | undefined {
    switch (subjectType) {
      case "mission": {
        try {
          const m = getMissions().get(asMissionId(subjectId));
          return m ? { ...m } : undefined;
        } catch {
          return undefined;
        }
      }
      case "goal": {
        try {
          const g = getGoals().get(asGoalId(subjectId));
          return g ? { ...g } : undefined;
        } catch {
          return undefined;
        }
      }
      case "plan": {
        try {
          const p = getPlans().get(asPlanId(subjectId));
          return p ? { ...p } : undefined;
        } catch {
          return undefined;
        }
      }
      case "recommendation": {
        if (!this.recommendationProvider) return undefined;
        try {
          const r = this.recommendationProvider(subjectId);
          return r ? { ...r } : undefined;
        } catch {
          return undefined;
        }
      }
      case "workflow":
        return undefined;
      default:
        return undefined;
    }
  }

  private findTemplate(
    programId: ProgramId,
    subjectType: ExplanationSubjectType,
    question: string,
  ): ExplanationTemplate | undefined {
    // Exact match on programId + subjectType + question
    let best = [...this.templates.values()].find(
      (t) =>
        t.programId === programId &&
        t.subjectType === subjectType &&
        t.question.toLowerCase() === question.toLowerCase(),
    );
    if (best) return best;
    // Program-level fallback on subjectType + question
    best = [...this.templates.values()].find(
      (t) =>
        t.programId === programId &&
        t.subjectType === subjectType &&
        question.toLowerCase().includes(t.question.toLowerCase().split(" ")[0]!),
    );
    if (best) return best;
    // Global fallback (no programId) on subjectType
    best = [...this.templates.values()].find(
      (t) => t.programId === undefined && t.subjectType === subjectType,
    );
    return best;
  }

  private buildVariables(
    subject: { [k: string]: unknown },
    request: ExplanationRequest,
  ): Record<string, string> {
    const vars: Record<string, string> = {
      subjectId: request.subjectId,
      subjectType: request.subjectType,
      question: request.question,
    };
    for (const [k, v] of Object.entries(subject)) {
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
        vars[k] = String(v);
      } else if (Array.isArray(v)) {
        vars[k] = v.length + " items";
      } else if (v && typeof v === "object") {
        vars[k] = "[object]";
      }
    }
    return vars;
  }

  private renderTemplate(template: string, vars: Record<string, string>): string {
    return template.replace(/\{(\w+)\}/g, (_match, key: string) => {
      return vars[key] ?? `{${key}}`;
    });
  }

  private buildFactors(
    subject: { [k: string]: unknown },
    request: ExplanationRequest,
    template: ExplanationTemplate | undefined,
    variables: Record<string, string>,
  ): ExplanationFactor[] {
    const factors: ExplanationFactor[] = [];
    if (template?.factors) {
      for (const f of template.factors) {
        factors.push({
          label: f.label,
          value: variables[f.variable] ?? "n/a",
          weight: f.weight,
        });
      }
    }
    // Always include a few canonical factors from the subject
    if (subject["state"]) {
      factors.push({ label: "State", value: String(subject["state"]), weight: 0.5 });
    }
    if (subject["priority"]) {
      factors.push({ label: "Priority", value: String(subject["priority"]), weight: 0.6 });
    }
    if (subject["aiGenerated"] !== undefined) {
      factors.push({
        label: "AI-generated",
        value: subject["aiGenerated"] ? "yes" : "no",
        weight: 0.7,
      });
    }
    return factors;
  }

  private defaultAnswer(
    request: ExplanationRequest,
    subject: { [k: string]: unknown },
  ): string {
    const name = String(subject["name"] ?? subject["title"] ?? request.subjectId);
    return `This ${request.subjectType} (${name}) was generated for participant ${request.participantId} under program ${String(subject["programId"] ?? "unknown")}.`;
  }

  private extractAiTrace(subject: { [k: string]: unknown }): string | undefined {
    const t = subject["aiTraceId"];
    return typeof t === "string" ? t : undefined;
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _engine: ExplainabilityEngine | null = null;
export function getExplainability(): ExplainabilityEngine {
  if (!_engine) _engine = new ExplainabilityEngine();
  return _engine;
}

export function resetExplainability(): void {
  _engine = null;
}

export type {
  ExplanationId,
  Explanation,
  ProgramId,
  AccountId,
  Recommendation,
};
