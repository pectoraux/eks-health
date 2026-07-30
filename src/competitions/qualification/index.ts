/**
 * Eks-Health Competition Platform — Qualification Engine & Participation
 *
 * Programs define qualification requirements:
 *   - min_measurements  : participant has recorded at least N measurements.
 *   - min_activity      : participant has at least N measurements within a
 *                          rolling time window.
 *   - verified_visits   : participant has at least N verified technician
 *                          measurement sessions.
 *   - program_completion: participant has completed the program (program-
 *                          specific; treated as opt-in via metadata).
 *   - min_duration      : participant has been registered for at least N days.
 *   - min_score         : participant has a current score >= threshold.
 *   - custom            : program-defined; treated as passing with a note.
 *
 * The manager evaluates requirements against REAL data (real measurement
 * counts via getMeasurements, real session counts via technician sessions,
 * real scores via getScoring). All cross-subsystem calls are guarded with
 * try/catch so a missing subsystem degrades gracefully.
 *
 * Participation tracking: register, withdraw, ban, assign division, list,
 * and aggregate stats.
 */

import "server-only";
import {
  type QualificationId,
  type QualificationRequirement,
  type QualificationStatus,
  type Participation,
  type ParticipationStatus,
  type ParticipationId,
  type CompetitionId,
  type SeasonId,
  type DivisionId,
  type ScoreSpecId,
  type AccountId,
  CompetitionError,
  COMPETITION_EVENTS,
  asQualificationId,
  asParticipationId,
} from "../core";
import { getCompetitions } from "../competitions";
import { getEventBus, buildEvent, generateId, getClock } from "@/kernel";
import type { SchemaId, ProfileId } from "@/health";
import { getMeasurements } from "@/health";
import { getProfiles } from "@/health";
import { getSessions } from "@/technicians";
import { getScoring, setQualificationProvider } from "../scoring";

// ---------------------------------------------------------------------------
// Public types (re-exported)
// ---------------------------------------------------------------------------

export type {
  QualificationId,
  QualificationRequirement,
  QualificationStatus,
  Participation,
  ParticipationStatus,
  ParticipationId,
};

// ---------------------------------------------------------------------------
// New types
// ---------------------------------------------------------------------------

export interface QualificationCheck {
  readonly requirement: QualificationRequirement;
  readonly passed: boolean;
  readonly detail: string;
  readonly observed: number;
  readonly required: number;
}

export interface QualificationResult {
  readonly id: QualificationId;
  readonly participantId: AccountId;
  readonly competitionId: CompetitionId;
  readonly seasonId: SeasonId;
  readonly status: QualificationStatus;
  readonly checks: QualificationCheck[];
  readonly evaluatedAt: string;
  readonly qualifiedAt?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface SetRequirementsInput {
  readonly competitionId: CompetitionId;
  readonly requirements: QualificationRequirement[];
}

export interface RegisterInput {
  readonly participantId: AccountId;
  readonly competitionId: CompetitionId;
  readonly seasonId: SeasonId;
  readonly divisionId?: DivisionId;
  readonly metadata?: Record<string, unknown>;
}

export interface ParticipationStats {
  readonly total: number;
  readonly registered: number;
  readonly qualified: number;
  readonly active: number;
  readonly eliminated: number;
  readonly withdrawn: number;
  readonly banned: number;
  readonly byCompetition: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Qualification manager
// ---------------------------------------------------------------------------

export class QualificationManager {
  private readonly requirements = new Map<CompetitionId, QualificationRequirement[]>();
  private readonly participations = new Map<ParticipationId, Participation>();
  private readonly byParticipantCompetition = new Map<string, ParticipationId>();
  private readonly byCompetition = new Map<CompetitionId, ParticipationId[]>();
  private readonly byParticipant = new Map<AccountId, ParticipationId[]>();
  private readonly evaluations = new Map<QualificationId, QualificationResult>();
  private readonly latestEvaluation = new Map<string, QualificationId>(); // participantId|competitionId → resultId

  constructor() {
    // Register as the qualification provider for the scoring subsystem so
    // ScoreCompiler.recalculate can enumerate participants. This breaks the
    // circular static import: qualification imports scoring (for min_score
    // checks) and scoring imports qualification (for participant enumeration).
    // Both modules load; the indirection resolves at runtime.
    try {
      setQualificationProvider({
        listParticipations: (filter) => this.listParticipations(filter).map((p) => ({ participantId: p.participantId })),
      });
    } catch {
      // scoring subsystem not initialized; ignore.
    }
  }

  // -------------------------------------------------------------------------
  // Requirements management
  // -------------------------------------------------------------------------

  setRequirements(input: SetRequirementsInput): QualificationRequirement[] {
    // Validate
    for (const r of input.requirements) {
      if (r.value < 0) {
        throw new CompetitionError({
          code: "eks.competition.qualification.invalid_requirement",
          category: "validation",
          message: `Requirement '${r.type}' has negative value ${r.value}.`,
          userMessage: "A qualification requirement has an invalid value.",
          metadata: { type: r.type, value: r.value },
        });
      }
    }
    this.requirements.set(input.competitionId, [...input.requirements]);
    return [...input.requirements];
  }

  getRequirements(competitionId: CompetitionId): QualificationRequirement[] {
    return [...(this.requirements.get(competitionId) ?? [])];
  }

  listRequirements(): Array<{ competitionId: CompetitionId; requirements: QualificationRequirement[] }> {
    return [...this.requirements.entries()].map(([competitionId, requirements]) => ({ competitionId, requirements: [...requirements] }));
  }

  // -------------------------------------------------------------------------
  // Evaluate
  // -------------------------------------------------------------------------

  evaluate(participantId: AccountId, competitionId: CompetitionId, seasonId: SeasonId): QualificationResult {
    const reqs = this.requirements.get(competitionId) ?? [];
    const checks: QualificationCheck[] = [];

    const participation = this.getParticipation(participantId, competitionId);

    for (const req of reqs) {
      const check = this.evaluateRequirement(req, participantId, competitionId, seasonId, participation);
      checks.push(check);
    }

    const allPassed = checks.length > 0 && checks.every((c) => c.passed);
    const status: QualificationStatus = allPassed ? "qualified" : "not_qualified";
    const now = getClock().iso();

    const result: QualificationResult = {
      id: asQualificationId(generateId("qual_")),
      participantId,
      competitionId,
      seasonId,
      status,
      checks,
      evaluatedAt: now,
      qualifiedAt: allPassed ? now : undefined,
    };

    this.evaluations.set(result.id, result);
    const key = `${String(participantId)}|${String(competitionId)}`;
    this.latestEvaluation.set(key, result.id);

    // If the participant is registered and just qualified, promote their participation status.
    if (allPassed && participation && participation.status === "registered") {
      this.updateParticipation(participation.id, { status: "qualified", qualifiedAt: now });
      void getEventBus().publish(
        buildEvent(
          COMPETITION_EVENTS.qualificationAchieved,
          {
            qualificationId: result.id,
            participantId,
            competitionId,
            seasonId,
          },
          {},
          "domain",
        ),
      );
    }

    return result;
  }

  getEvaluation(id: QualificationId): QualificationResult | undefined {
    return this.evaluations.get(id);
  }

  getLatestEvaluation(participantId: AccountId, competitionId: CompetitionId): QualificationResult | undefined {
    const key = `${String(participantId)}|${String(competitionId)}`;
    const id = this.latestEvaluation.get(key);
    return id ? this.evaluations.get(id) : undefined;
  }

  private evaluateRequirement(
    req: QualificationRequirement,
    participantId: AccountId,
    competitionId: CompetitionId,
    _seasonId: SeasonId,
    participation: Participation | undefined,
  ): QualificationCheck {
    switch (req.type) {
      case "min_measurements":
        return this.checkMinMeasurements(req, participantId);
      case "min_activity":
        return this.checkMinActivity(req, participantId);
      case "verified_visits":
        return this.checkVerifiedVisits(req, participantId);
      case "program_completion":
        return this.checkProgramCompletion(req, participantId, participation);
      case "min_duration":
        return this.checkMinDuration(req, participation);
      case "min_score":
        return this.checkMinScore(req, participantId, competitionId);
      case "custom":
      default:
        return {
          requirement: req,
          passed: true,
          detail: `Custom requirement '${req.description}' treated as passing (program-defined).`,
          observed: 1,
          required: req.value,
        };
    }
  }

  private checkMinMeasurements(req: QualificationRequirement, participantId: AccountId): QualificationCheck {
    const observed = countMeasurementsForParticipant(participantId, undefined, undefined, undefined);
    const passed = observed >= req.value;
    return {
      requirement: req,
      passed,
      detail: `Participant has ${observed} measurement(s); required ${req.value}.`,
      observed,
      required: req.value,
    };
  }

  private checkMinActivity(req: QualificationRequirement, participantId: AccountId): QualificationCheck {
    const windowDays = req.timeWindowDays ?? 30;
    const toIso = getClock().iso();
    const fromMs = Date.now() - windowDays * 24 * 60 * 60 * 1000;
    const fromIso = new Date(fromMs).toISOString();
    const observed = countMeasurementsForParticipant(participantId, undefined, fromIso, toIso);
    const passed = observed >= req.value;
    return {
      requirement: req,
      passed,
      detail: `Participant has ${observed} measurement(s) in the last ${windowDays} days; required ${req.value}.`,
      observed,
      required: req.value,
    };
  }

  private checkVerifiedVisits(req: QualificationRequirement, participantId: AccountId): QualificationCheck {
    let observed = 0;
    try {
      const sessions = getSessions().list({ participantId, status: "verified" });
      observed = sessions.length;
    } catch {
      observed = 0;
    }
    const passed = observed >= req.value;
    return {
      requirement: req,
      passed,
      detail: `Participant has ${observed} verified technician session(s); required ${req.value}.`,
      observed,
      required: req.value,
    };
  }

  private checkProgramCompletion(
    req: QualificationRequirement,
    participantId: AccountId,
    participation: Participation | undefined,
  ): QualificationCheck {
    // Program completion is program-defined. Look for a `programCompleted`
    // flag in participation metadata; default to false.
    const meta = participation?.metadata as { programCompleted?: boolean } | undefined;
    const completed = meta?.programCompleted === true;
    const observed = completed ? 1 : 0;
    const passed = observed >= req.value;
    return {
      requirement: req,
      passed,
      detail: `Program completion flag is ${completed ? "set" : "not set"} for participant ${participantId}.`,
      observed,
      required: req.value,
    };
  }

  private checkMinDuration(req: QualificationRequirement, participation: Participation | undefined): QualificationCheck {
    if (!participation) {
      return {
        requirement: req,
        passed: false,
        detail: "Participant is not registered; cannot evaluate min_duration.",
        observed: 0,
        required: req.value,
      };
    }
    const registeredAtMs = new Date(participation.registeredAt).getTime();
    const nowMs = Date.now();
    const daysRegistered = (nowMs - registeredAtMs) / (1000 * 60 * 60 * 24);
    const passed = daysRegistered >= req.value;
    return {
      requirement: req,
      passed,
      detail: `Participant has been registered for ${daysRegistered.toFixed(2)} days; required ${req.value}.`,
      observed: Math.floor(daysRegistered),
      required: req.value,
    };
  }

  private checkMinScore(req: QualificationRequirement, participantId: AccountId, competitionId: CompetitionId): QualificationCheck {
    let observed = 0;
    let detail = "";
    try {
      const scoring = getScoring();
      // Find the latest score for this participant in any season of the competition.
      // We iterate over all participations of this participant to find the season.
      const parts = this.listParticipations({ participantId });
      let best: number | undefined;
      for (const p of parts) {
        if (p.competitionId !== competitionId) continue;
        const rec = scoring.getLatestScore(participantId, competitionId, p.seasonId);
        if (rec && (best === undefined || rec.totalScore > best)) best = rec.totalScore;
      }
      observed = best ?? 0;
      detail = `Participant's best score in competition is ${observed}; required ${req.value}.`;
    } catch {
      detail = `Scoring subsystem unavailable; treated as score 0 (required ${req.value}).`;
      observed = 0;
    }
    const passed = observed >= req.value;
    return {
      requirement: req,
      passed,
      detail,
      observed,
      required: req.value,
    };
  }

  // -------------------------------------------------------------------------
  // Participation management
  // -------------------------------------------------------------------------

  register(input: RegisterInput): Participation {
    const comp = getCompetitions().get(input.competitionId);
    if (!comp) {
      throw new CompetitionError({
        code: "eks.competition.participation.competition_not_found",
        category: "not_found",
        message: `Competition ${input.competitionId} not found.`,
        userMessage: "This competition does not exist.",
        metadata: { competitionId: input.competitionId },
      });
    }
    // Eligibility check: state must allow registration
    if (comp.state !== "registration" && comp.state !== "qualification" && comp.state !== "active") {
      throw new CompetitionError({
        code: "eks.competition.participation.registration_closed",
        category: "state_conflict",
        message: `Competition is in state '${comp.state}'; registration not allowed.`,
        userMessage: "Registration for this competition is not currently open.",
        metadata: { competitionId: input.competitionId, state: comp.state },
      });
    }
    // Max participants
    if (comp.maxParticipants !== undefined && comp.currentParticipants >= comp.maxParticipants) {
      throw new CompetitionError({
        code: "eks.competition.participation.quota_exceeded",
        category: "quota_exceeded",
        message: `Competition has reached max participants (${comp.maxParticipants}).`,
        userMessage: "This competition is full.",
        metadata: { competitionId: input.competitionId, max: comp.maxParticipants },
      });
    }
    // Already registered?
    const existing = this.getParticipation(input.participantId, input.competitionId);
    if (existing && existing.status !== "withdrawn" && existing.status !== "banned") {
      throw new CompetitionError({
        code: "eks.competition.participation.already_registered",
        category: "state_conflict",
        message: `Participant ${input.participantId} is already registered (status ${existing.status}).`,
        userMessage: "You are already registered for this competition.",
        metadata: { participationId: existing.id, status: existing.status },
      });
    }
    if (existing?.status === "banned") {
      throw new CompetitionError({
        code: "eks.competition.participation.banned",
        category: "not_eligible",
        message: `Participant ${input.participantId} is banned from this competition.`,
        userMessage: "You are banned from this competition.",
        metadata: { participationId: existing.id },
      });
    }

    const now = getClock().iso();
    const participation: Participation = {
      id: asParticipationId(generateId("part_")),
      competitionId: input.competitionId,
      seasonId: input.seasonId,
      participantId: input.participantId,
      divisionId: input.divisionId,
      status: "registered",
      registeredAt: now,
      measurementCount: 0,
      metadata: input.metadata,
    };
    this.participations.set(participation.id, participation);
    const key = `${String(input.participantId)}|${String(input.competitionId)}`;
    this.byParticipantCompetition.set(key, participation.id);
    const cList = this.byCompetition.get(input.competitionId) ?? [];
    this.byCompetition.set(input.competitionId, [...cList, participation.id]);
    const pList = this.byParticipant.get(input.participantId) ?? [];
    this.byParticipant.set(input.participantId, [...pList, participation.id]);

    // Increment competition participant counter
    getCompetitions().incrementParticipants(input.competitionId);

    void getEventBus().publish(
      buildEvent(
        COMPETITION_EVENTS.participantJoined,
        {
          participationId: participation.id,
          participantId: input.participantId,
          competitionId: input.competitionId,
          seasonId: input.seasonId,
        },
        {},
        "domain",
      ),
    );

    return participation;
  }

  withdraw(participantId: AccountId, competitionId: CompetitionId): Participation {
    const p = this.getParticipation(participantId, competitionId);
    if (!p) {
      throw new CompetitionError({
        code: "eks.competition.participation.not_found",
        category: "not_found",
        message: `Participation for ${participantId} in ${competitionId} not found.`,
        userMessage: "You are not registered for this competition.",
      });
    }
    if (p.status === "withdrawn") return p;
    const updated = this.updateParticipation(p.id, { status: "withdrawn" });
    getCompetitions().decrementParticipants(competitionId);
    void getEventBus().publish(
      buildEvent(
        COMPETITION_EVENTS.participantWithdrawn,
        {
          participationId: p.id,
          participantId,
          competitionId,
          seasonId: p.seasonId,
        },
        {},
        "domain",
      ),
    );
    return updated;
  }

  getParticipation(participantId: AccountId, competitionId: CompetitionId): Participation | undefined {
    const key = `${String(participantId)}|${String(competitionId)}`;
    const id = this.byParticipantCompetition.get(key);
    return id ? this.participations.get(id) : undefined;
  }

  listParticipations(filter?: { competitionId?: CompetitionId; participantId?: AccountId }): Participation[] {
    if (filter?.competitionId && filter?.participantId) {
      const p = this.getParticipation(filter.participantId, filter.competitionId);
      return p ? [p] : [];
    }
    if (filter?.competitionId) {
      return (this.byCompetition.get(filter.competitionId) ?? [])
        .map((id) => this.participations.get(id)!)
        .filter(Boolean);
    }
    if (filter?.participantId) {
      return (this.byParticipant.get(filter.participantId) ?? [])
        .map((id) => this.participations.get(id)!)
        .filter(Boolean);
    }
    return [...this.participations.values()];
  }

  updateParticipation(id: ParticipationId, updates: Partial<Omit<Participation, "id" | "competitionId" | "seasonId" | "participantId" | "registeredAt">>): Participation {
    const p = this.participations.get(id);
    if (!p) {
      throw new CompetitionError({
        code: "eks.competition.participation.not_found",
        category: "not_found",
        message: `Participation ${id} not found.`,
        userMessage: "Participation record not found.",
      });
    }
    const updated: Participation = { ...p, ...updates };
    this.participations.set(id, updated);
    return updated;
  }

  assignDivision(participantId: AccountId, competitionId: CompetitionId, divisionId: DivisionId): Participation {
    const p = this.getParticipation(participantId, competitionId);
    if (!p) {
      throw new CompetitionError({
        code: "eks.competition.participation.not_found",
        category: "not_found",
        message: `Participation for ${participantId} in ${competitionId} not found.`,
      });
    }
    return this.updateParticipation(p.id, { divisionId });
  }

  ban(participantId: AccountId, competitionId: CompetitionId, reason: string): Participation {
    const p = this.getParticipation(participantId, competitionId);
    if (!p) {
      throw new CompetitionError({
        code: "eks.competition.participation.not_found",
        category: "not_found",
        message: `Participation for ${participantId} in ${competitionId} not found.`,
      });
    }
    const updated = this.updateParticipation(p.id, {
      status: "banned",
      metadata: { ...(p.metadata ?? {}), banReason: reason, bannedAt: getClock().iso() },
    });
    getCompetitions().decrementParticipants(competitionId);
    return updated;
  }

  // -------------------------------------------------------------------------
  // Stats
  // -------------------------------------------------------------------------

  getStats(competitionId?: CompetitionId): ParticipationStats {
    const list = this.listParticipations(competitionId ? { competitionId } : undefined);
    const byCompetition: Record<string, number> = {};
    let registered = 0, qualified = 0, active = 0, eliminated = 0, withdrawn = 0, banned = 0;
    for (const p of list) {
      byCompetition[String(p.competitionId)] = (byCompetition[String(p.competitionId)] ?? 0) + 1;
      switch (p.status) {
        case "registered": registered++; break;
        case "qualified": qualified++; break;
        case "active": active++; break;
        case "eliminated": eliminated++; break;
        case "withdrawn": withdrawn++; break;
        case "banned": banned++; break;
      }
    }
    return {
      total: list.length,
      registered,
      qualified,
      active,
      eliminated,
      withdrawn,
      banned,
      byCompetition,
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers — measurement counting via the health subsystem (guarded)
// ---------------------------------------------------------------------------

function countMeasurementsForParticipant(
  participantId: AccountId,
  schemaId: SchemaId | undefined,
  fromIso: string | undefined,
  toIso: string | undefined,
): number {
  try {
    let profileId: ProfileId | undefined;
    try {
      profileId = getProfiles().get(participantId)?.id;
    } catch {
      profileId = undefined;
    }
    if (!profileId) return 0;
    return getMeasurements().count({
      profileId,
      schemaId,
      from: fromIso,
      to: toIso,
      includeSuperseded: false,
    });
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _mgr: QualificationManager | null = null;
export function getQualification(): QualificationManager {
  if (!_mgr) _mgr = new QualificationManager();
  return _mgr;
}
export function resetQualification(): void {
  _mgr = null;
}

// Re-export ScoreSpecId for callers building program-scoped qualification packs
export type { ScoreSpecId } from "../core";
