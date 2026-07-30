/**
 * Eks-Health Health Orchestrator — Digital Health Twin
 *
 * Every participant receives a continuously evolving Digital Twin — a real-time
 * representation of their health state built from verified measurements, program
 * progress, mission completion, competition history, technician observations,
 * wearable data, goals, preferences, consent, risk indicators, and historical
 * trends. The Twin belongs to the participant. Programs interact through secure APIs.
 */

import "server-only";
import {
  type TwinId,
  type AccountId,
  type ProgramId,
  type DigitalHealthTwin,
  type TwinState,
  type ProgramContribution,
  type ProgramContributionId,
  OrchestratorError,
  asTwinId,
  asProgramContributionId,
} from "../core";
import { getEventBus, buildEvent, generateId, getClock } from "@/kernel";
import { ORCHESTRATOR_EVENTS } from "../core";

export class TwinManager {
  private readonly twins = new Map<AccountId, DigitalHealthTwin>();
  private readonly contributions = new Map<ProgramContributionId, ProgramContribution>();

  /** Get or create a Digital Twin for a participant. */
  getOrCreate(participantId: AccountId): DigitalHealthTwin {
    let twin = this.twins.get(participantId);
    if (!twin) {
      twin = {
        id: asTwinId(generateId("twin_")),
        participantId,
        state: {
          measurements: [],
          programProgress: [],
          missionCompletion: { totalAssigned: 0, totalCompleted: 0, streak: 0 },
          competitionHistory: [],
          technicianObservations: [],
          historicalTrends: [],
        },
        lastUpdated: getClock().iso(),
        version: 1,
        programContributions: [],
        riskIndicators: [],
        goals: [],
        preferences: {},
        fatigueScore: 0,
        offlineStatus: false,
      };
      this.twins.set(participantId, twin);
    }
    return twin;
  }

  get(participantId: AccountId): DigitalHealthTwin | undefined {
    return this.twins.get(participantId);
  }

  /** Update the Twin's state from platform data. */
  updateState(participantId: AccountId, stateUpdate: Partial<TwinState>): DigitalHealthTwin {
    const twin = this.getOrCreate(participantId);
    const updated: DigitalHealthTwin = {
      ...twin,
      state: { ...twin.state, ...stateUpdate },
      lastUpdated: getClock().iso(),
      version: twin.version + 1,
    };
    this.twins.set(participantId, updated);
    void getEventBus().publish(buildEvent(ORCHESTRATOR_EVENTS.twinUpdated, { twinId: updated.id, participantId, version: updated.version }, {}, "domain"));
    return updated;
  }

  /** Record a Program contribution to the Twin. */
  recordContribution(participantId: AccountId, input: {
    programId: ProgramId;
    type: ProgramContribution["type"];
    description: string;
    value?: unknown;
  }): ProgramContribution {
    const twin = this.getOrCreate(participantId);
    const contribution: ProgramContribution = {
      id: asProgramContributionId(generateId("pc_")),
      programId: input.programId,
      type: input.type,
      description: input.description,
      value: input.value,
      timestamp: getClock().iso(),
    };
    this.contributions.set(contribution.id, contribution);
    const updated: DigitalHealthTwin = {
      ...twin,
      programContributions: [...twin.programContributions, contribution],
      lastUpdated: getClock().iso(),
      version: twin.version + 1,
    };
    this.twins.set(participantId, updated);
    return contribution;
  }

  /** Set risk indicators on the Twin. */
  setRiskIndicators(participantId: AccountId, risks: DigitalHealthTwin["riskIndicators"]): DigitalHealthTwin {
    const twin = this.getOrCreate(participantId);
    const updated: DigitalHealthTwin = { ...twin, riskIndicators: risks, lastUpdated: getClock().iso(), version: twin.version + 1 };
    this.twins.set(participantId, updated);
    return updated;
  }

  /** Set goals on the Twin. */
  setGoals(participantId: AccountId, goals: DigitalHealthTwin["goals"]): DigitalHealthTwin {
    const twin = this.getOrCreate(participantId);
    const updated: DigitalHealthTwin = { ...twin, goals, lastUpdated: getClock().iso(), version: twin.version + 1 };
    this.twins.set(participantId, updated);
    return updated;
  }

  /** Set fatigue score (0-100). */
  setFatigueScore(participantId: AccountId, score: number): DigitalHealthTwin {
    const twin = this.getOrCreate(participantId);
    const updated: DigitalHealthTwin = { ...twin, fatigueScore: Math.min(100, Math.max(0, score)), lastUpdated: getClock().iso(), version: twin.version + 1 };
    this.twins.set(participantId, updated);
    return updated;
  }

  /** Set travel/offline status. */
  setStatus(participantId: AccountId, travel?: string, offline?: boolean): DigitalHealthTwin {
    const twin = this.getOrCreate(participantId);
    const updated: DigitalHealthTwin = { ...twin, travelStatus: travel, offlineStatus: offline ?? twin.offlineStatus, lastUpdated: getClock().iso(), version: twin.version + 1 };
    this.twins.set(participantId, updated);
    return updated;
  }

  /** Set participant preferences. */
  setPreferences(participantId: AccountId, prefs: Record<string, unknown>): DigitalHealthTwin {
    const twin = this.getOrCreate(participantId);
    const updated: DigitalHealthTwin = { ...twin, preferences: { ...twin.preferences, ...prefs }, lastUpdated: getClock().iso(), version: twin.version + 1 };
    this.twins.set(participantId, updated);
    return updated;
  }

  /** Get the full Twin state for a participant (secure API for Programs). */
  getFullState(participantId: AccountId): DigitalHealthTwin | undefined {
    return this.twins.get(participantId);
  }

  /** List all known twins (used by global analytics). */
  listTwins(): DigitalHealthTwin[] {
    return [...this.twins.values()].sort((a, b) => b.lastUpdated.localeCompare(a.lastUpdated));
  }

  /** Get program contributions for a specific Program. */
  getContributions(participantId: AccountId, programId?: ProgramId): ProgramContribution[] {
    const twin = this.twins.get(participantId);
    if (!twin) return [];
    return programId ? twin.programContributions.filter((c) => c.programId === programId) : twin.programContributions;
  }

  getStats(): { totalTwins: number; totalContributions: number; avgVersion: number } {
    const list = [...this.twins.values()];
    return {
      totalTwins: list.length,
      totalContributions: list.reduce((a, t) => a + t.programContributions.length, 0),
      avgVersion: list.length > 0 ? list.reduce((a, t) => a + t.version, 0) / list.length : 0,
    };
  }
}

let _mgr: TwinManager | null = null;
export function getTwin(): TwinManager {
  if (!_mgr) _mgr = new TwinManager();
  return _mgr;
}
