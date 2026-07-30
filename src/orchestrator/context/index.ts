/**
 * Eks-Health Health Orchestrator — Health Context Engine
 *
 * Maintains shared participant context: current goals, risks, today's workload,
 * recent measurements, current competitions, recent technician visits, travel
 * status, offline status, fatigue score, preference changes. Programs request
 * context rather than maintaining conflicting copies.
 */

import "server-only";
import {
  type AccountId,
  type ProgramId,
  type HealthContext,
  OrchestratorError,
} from "../core";
import { getClock } from "@/kernel";

export class ContextEngine {
  private readonly contexts = new Map<AccountId, HealthContext>();

  /** Build or refresh the health context for a participant from the Digital Twin + platform data. */
  build(participantId: AccountId, twinData?: {
    goals?: { name: string; progress: number }[];
    riskIndicators?: { name: string; level: "low" | "medium" | "high" }[];
    fatigueScore?: number;
    travelStatus?: string;
    offlineStatus?: boolean;
    preferences?: Record<string, unknown>;
  }, platformData?: {
    measurements?: { schemaId: string; value: unknown; at: string }[];
    competitions?: { competitionId: string; rank: number }[];
    technicianVisits?: { at: string; summary: string }[];
    workload?: { totalMinutes: number; physicalEffort: number; mentalEffort: number };
  }): HealthContext {
    const workload = platformData?.workload ?? { totalMinutes: 0, physicalEffort: 0, mentalEffort: 0 };
    const level = workload.totalMinutes < 30 ? "light" : workload.totalMinutes < 60 ? "moderate" : workload.totalMinutes < 120 ? "heavy" : "heavy";

    const context: HealthContext = {
      participantId,
      currentGoals: (twinData?.goals ?? []).map((g) => ({ ...g, source: "" as ProgramId })),
      currentRisks: twinData?.riskIndicators ?? [],
      todayWorkload: { ...workload, level: level as "light" | "moderate" | "heavy" },
      recentMeasurements: (platformData?.measurements ?? []) as HealthContext["recentMeasurements"],
      currentCompetitions: platformData?.competitions ?? [],
      recentTechnicianVisits: platformData?.technicianVisits ?? [],
      travelStatus: twinData?.travelStatus,
      offlineStatus: twinData?.offlineStatus ?? false,
      fatigueScore: twinData?.fatigueScore ?? 0,
      preferenceChanges: [],
      updatedAt: getClock().iso(),
    };
    this.contexts.set(participantId, context);
    return context;
  }

  get(participantId: AccountId): HealthContext | undefined {
    return this.contexts.get(participantId);
  }

  /** Programs request context — returns the shared context. */
  requestContext(participantId: AccountId): HealthContext | undefined {
    return this.contexts.get(participantId);
  }

  /** Update a specific context field. */
  updateField(participantId: AccountId, field: keyof HealthContext, value: unknown): HealthContext | undefined {
    const ctx = this.contexts.get(participantId);
    if (!ctx) return undefined;
    const updated = { ...ctx, [field]: value, updatedAt: getClock().iso() };
    this.contexts.set(participantId, updated as HealthContext);
    return updated;
  }

  /** Record a preference change. */
  recordPreferenceChange(participantId: AccountId, key: string, oldValue: unknown, newValue: unknown): void {
    const ctx = this.contexts.get(participantId);
    if (!ctx) return;
    this.contexts.set(participantId, {
      ...ctx,
      preferenceChanges: [...ctx.preferenceChanges, { key, oldValue, newValue, at: getClock().iso() }],
      updatedAt: getClock().iso(),
    });
  }

  getStats(): { totalContexts: number; avgGoals: number; avgWorkload: number } {
    const list = [...this.contexts.values()];
    return {
      totalContexts: list.length,
      avgGoals: list.length > 0 ? list.reduce((a, c) => a + c.currentGoals.length, 0) / list.length : 0,
      avgWorkload: list.length > 0 ? list.reduce((a, c) => a + c.todayWorkload.totalMinutes, 0) / list.length : 0,
    };
  }
}

let _engine: ContextEngine | null = null;
export function getContext(): ContextEngine {
  if (!_engine) _engine = new ContextEngine();
  return _engine;
}
