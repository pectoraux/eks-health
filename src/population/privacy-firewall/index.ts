/**
 * Eks-Health Population Platform — Privacy Firewall
 *
 * The platform's defining capability. Organizations see aggregates only,
 * never individual health data unless explicitly granted. Employer funds
 * Weight Program → can see 85% participation, average improvement, retention
 * → cannot see John's weight, Mary's blood pressure, individual AI
 * recommendations, private measurements — unless participant explicitly
 * grants permission.
 */

import "server-only";
import {
  type PrivacyGrantId,
  type PrivacyGrant,
  type PrivacyGrantType,
  type OrgVisibleData,
  type PopulationOrgId,
  type AccountId,
  PopulationError,
  asPrivacyGrantId,
} from "../core";
import { getEventBus, buildEvent, generateId, getClock } from "@/kernel";
import { POPULATION_EVENTS } from "../core";

// Fields that are ALWAYS visible to organizations (non-health, non-sensitive)
const ALWAYS_VISIBLE = ["membership_status", "competition_participation", "campaign_participation", "program_installation_status"];

// Fields that are NEVER visible to organizations (individual health data)
const NEVER_VISIBLE = ["weight", "blood_pressure", "heart_rate", "blood_sugar", "sleep_duration", "mood_score", "ai_recommendations", "ai_traces", "private_measurements", "technician_observations", "digital_twin_state", "research_contributions"];

export class PrivacyFirewall {
  private readonly grants = new Map<PrivacyGrantId, PrivacyGrant>();
  private readonly byParticipantOrg = new Map<string, PrivacyGrantId[]>();

  /** Grant an organization additional visibility into a participant's data. */
  grant(input: {
    participantId: AccountId;
    orgId: PopulationOrgId;
    grantType: PrivacyGrantType;
    purpose: string;
    scope: string[];
    expiryDays?: number;
  }): PrivacyGrant {
    const key = `${input.participantId}:${input.orgId}`;
    // Check for existing active grant of the same type
    const existing = (this.byParticipantOrg.get(key) ?? [])
      .map((id) => this.grants.get(id)!)
      .find((g) => g && g.grantType === input.grantType && g.status === "active");
    if (existing) return existing;

    const now = getClock().iso();
    const grant: PrivacyGrant = {
      id: asPrivacyGrantId(generateId("pgrant_")),
      participantId: input.participantId,
      orgId: input.orgId,
      grantType: input.grantType,
      purpose: input.purpose,
      scope: input.scope,
      status: "active",
      grantedAt: now,
      expiresAt: input.expiryDays ? new Date(Date.now() + input.expiryDays * 86400000).toISOString() : undefined,
      auditTrail: [{ action: "granted", at: now, detail: input.purpose }],
    };
    this.grants.set(grant.id, grant);
    const list = this.byParticipantOrg.get(key) ?? [];
    this.byParticipantOrg.set(key, [...list, grant.id]);
    void getEventBus().publish(buildEvent(POPULATION_EVENTS.privacyGranted, { grantId: grant.id, participantId: input.participantId, orgId: input.orgId, grantType: input.grantType }, {}, "domain"));
    return grant;
  }

  /** Revoke a privacy grant. */
  revoke(grantId: PrivacyGrantId, reason?: string): PrivacyGrant {
    const grant = this.grants.get(grantId);
    if (!grant) throw new PopulationError({ code: "eks.population.privacy.not_found", category: "not_found", message: "Grant not found." });
    const updated: PrivacyGrant = {
      ...grant, status: "revoked", revokedAt: getClock().iso(),
      auditTrail: [...grant.auditTrail, { action: "revoked", at: getClock().iso(), detail: reason }],
    };
    this.grants.set(grantId, updated);
    void getEventBus().publish(buildEvent(POPULATION_EVENTS.privacyRevoked, { grantId, participantId: grant.participantId, orgId: grant.orgId, reason }, {}, "domain"));
    return updated;
  }

  /** Check what data an organization can see for a participant. */
  getVisibleData(participantId: AccountId, orgId: PopulationOrgId): OrgVisibleData {
    const key = `${participantId}:${orgId}`;
    const activeGrants = (this.byParticipantOrg.get(key) ?? [])
      .map((id) => this.grants.get(id)!)
      .filter((g) => g && g.status === "active" && (!g.expiresAt || new Date(g.expiresAt).getTime() > Date.now()));

    const grantTypes = activeGrants.map((g) => g.grantType);
    const visibleFields = [...ALWAYS_VISIBLE];

    // Add fields based on grant types
    for (const grant of activeGrants) {
      if (grant.grantType === "attendance_only") {
        visibleFields.push("attendance", "participation_dates");
      } else if (grant.grantType === "competition_status") {
        visibleFields.push("competition_rank", "competition_score", "competition_participation");
      } else if (grant.grantType === "aggregate_performance") {
        visibleFields.push("aggregate_improvement", "mission_completion_rate");
      } else if (grant.grantType === "specific_measurement") {
        // Only the specific fields the participant consented to
        visibleFields.push(...grant.scope);
      } else if (grant.grantType === "wellness_certificate") {
        visibleFields.push("wellness_certificates", "achievement_badges");
      } else if (grant.grantType === "achievements") {
        visibleFields.push("achievements", "streaks", "milestones");
      } else if (grant.grantType === "program_progress") {
        visibleFields.push("program_completion", "program_progress_percentage");
      } else if (grant.grantType === "custom") {
        visibleFields.push(...grant.scope);
      }
    }

    // Remove any NEVER_VISIBLE fields that might have been added by custom grants
    // unless explicitly in the grant scope
    const hiddenFields = NEVER_VISIBLE.filter((f) => !visibleFields.includes(f));

    return {
      orgId,
      participantId,
      visibleFields: [...new Set(visibleFields)],
      hiddenFields,
      grantTypes,
      lastChecked: getClock().iso(),
    };
  }

  /** Check if an organization can access a specific field for a participant. */
  canAccess(participantId: AccountId, orgId: PopulationOrgId, field: string): boolean {
    const visible = this.getVisibleData(participantId, orgId);
    return visible.visibleFields.includes(field);
  }

  /** Get all active grants for a participant (across all orgs). */
  getActiveGrants(participantId: AccountId): PrivacyGrant[] {
    return [...this.grants.values()].filter((g) => g.participantId === participantId && g.status === "active" && (!g.expiresAt || new Date(g.expiresAt).getTime() > Date.now()));
  }

  /** Get all grants an org has received from participants. */
  getOrgGrants(orgId: PopulationOrgId): PrivacyGrant[] {
    return [...this.grants.values()].filter((g) => g.orgId === orgId && g.status === "active");
  }

  /** Sweep expired grants. */
  sweepExpired(): number {
    const now = Date.now();
    let n = 0;
    for (const [id, grant] of this.grants) {
      if (grant.status === "active" && grant.expiresAt && new Date(grant.expiresAt).getTime() < now) {
        this.grants.set(id, { ...grant, status: "expired" as const, auditTrail: [...grant.auditTrail, { action: "expired", at: getClock().iso() }] });
        n++;
      }
    }
    return n;
  }

  getStats(): { total: number; active: number; revoked: number; expired: number; byType: Record<string, number> } {
    const list = [...this.grants.values()];
    const byType: Record<string, number> = {};
    for (const g of list) byType[g.grantType] = (byType[g.grantType] ?? 0) + 1;
    return {
      total: list.length,
      active: list.filter((g) => g.status === "active").length,
      revoked: list.filter((g) => g.status === "revoked").length,
      expired: list.filter((g) => g.status === "expired").length,
      byType,
    };
  }
}

let _firewall: PrivacyFirewall | null = null;
export function getPrivacyFirewall(): PrivacyFirewall {
  if (!_firewall) _firewall = new PrivacyFirewall();
  return _firewall;
}
