/**
 * Eks-Health Research Platform — Research Consent
 *
 * Expand the consent engine for research. Participants independently consent
 * to: anonymous research, academic, commercial, government, employer wellness,
 * insurance analytics, AI training, program improvement, cross-program
 * benchmarking, international studies. Each consent is granular, revocable,
 * versioned, time-limited, purpose-specific.
 */

import "server-only";
import {
  type ResearchConsentId,
  type ResearchConsentType,
  type ResearchConsentStatus,
  type ResearchConsent,
  type AccountId,
  ResearchError,
  asResearchConsentId,
} from "../core";
import { getEventBus, buildEvent, generateId, getClock } from "@/kernel";
import { RESEARCH_EVENTS } from "../core";

export const RESEARCH_CONSENT_TYPES: readonly { type: ResearchConsentType; label: string; description: string; defaultExpiryDays: number }[] = [
  { type: "anonymous_research", label: "Anonymous Research", description: "Your anonymized data may be used for general health research.", defaultExpiryDays: 365 },
  { type: "academic_research", label: "Academic Research", description: "Your data may be used in peer-reviewed academic studies.", defaultExpiryDays: 365 },
  { type: "commercial_research", label: "Commercial Research", description: "Your data may inform commercial Program development.", defaultExpiryDays: 180 },
  { type: "government_research", label: "Government Research", description: "Your data may support public health initiatives.", defaultExpiryDays: 365 },
  { type: "employer_wellness_analytics", label: "Employer Wellness Analytics", description: "Aggregated insights may be shared with your employer wellness program.", defaultExpiryDays: 90 },
  { type: "insurance_analytics", label: "Insurance Analytics", description: "Aggregated insights may inform insurance wellness programs.", defaultExpiryDays: 90 },
  { type: "ai_training", label: "AI Training", description: "Your anonymized data may be used to train AI models that improve health coaching.", defaultExpiryDays: 365 },
  { type: "program_improvement", label: "Program Improvement", description: "Your data may be used to improve the Programs you use.", defaultExpiryDays: 365 },
  { type: "cross_program_benchmarking", label: "Cross-Program Benchmarking", description: "Your anonymized outcomes may be compared across Programs.", defaultExpiryDays: 365 },
  { type: "international_studies", label: "International Studies", description: "Your data may be included in multi-country research collaborations.", defaultExpiryDays: 365 },
];

const CONSENT_INDEX = new Map(RESEARCH_CONSENT_TYPES.map((c) => [c.type, c]));

export function getConsentTypeMeta(type: ResearchConsentType) {
  return CONSENT_INDEX.get(type);
}

export class ResearchConsentManager {
  private readonly consents = new Map<ResearchConsentId, ResearchConsent>();
  private readonly byParticipant = new Map<AccountId, ResearchConsentId[]>();

  grant(input: {
    participantId: AccountId;
    type: ResearchConsentType;
    purpose: string;
    scope: string[];
    expiryDays?: number;
    grantedBy: AccountId;
  }): ResearchConsent {
    // Check for existing active consent
    const existing = this.findByParticipantAndType(input.participantId, input.type);
    if (existing && existing.status === "granted") return existing;

    const meta = CONSENT_INDEX.get(input.type);
    const now = getClock().iso();
    const consent: ResearchConsent = {
      id: asResearchConsentId(generateId("rcon_")),
      participantId: input.participantId,
      type: input.type,
      status: "granted",
      grantedAt: now,
      expiresAt: new Date(Date.now() + (input.expiryDays ?? meta?.defaultExpiryDays ?? 365) * 86400000).toISOString(),
      purpose: input.purpose,
      scope: input.scope,
      version: 1,
      consentHistory: [{ action: "granted", at: now, by: input.grantedBy }],
    };
    this.consents.set(consent.id, consent);
    const list = this.byParticipant.get(input.participantId) ?? [];
    this.byParticipant.set(input.participantId, [...list, consent.id]);
    void getEventBus().publish(buildEvent(RESEARCH_EVENTS.consentGranted, { consentId: consent.id, participantId: input.participantId, type: input.type }, {}, "domain"));
    return consent;
  }

  revoke(id: ResearchConsentId, revokedBy: AccountId, reason?: string): ResearchConsent {
    const consent = this.consents.get(id);
    if (!consent) throw new ResearchError({ code: "eks.research.consent.not_found", category: "not_found", message: "Consent not found." });
    const updated: ResearchConsent = {
      ...consent,
      status: "revoked",
      revokedAt: getClock().iso(),
      version: consent.version + 1,
      consentHistory: [...consent.consentHistory, { action: "revoked", at: getClock().iso(), by: revokedBy }],
    };
    this.consents.set(id, updated);
    void getEventBus().publish(buildEvent(RESEARCH_EVENTS.consentRevoked, { consentId: id, participantId: consent.participantId, type: consent.type, reason }, {}, "domain"));
    return updated;
  }

  /** Check if a participant has an active consent for a research type. */
  hasConsent(participantId: AccountId, type: ResearchConsentType): boolean {
    return !!this.findByParticipantAndType(participantId, type)?.status?.startsWith("grant");
  }

  /** Get all active consents for a participant. */
  getActiveConsents(participantId: AccountId): ResearchConsent[] {
    return (this.byParticipant.get(participantId) ?? [])
      .map((id) => this.consents.get(id)!)
      .filter((c) => c && c.status === "granted" && (!c.expiresAt || new Date(c.expiresAt).getTime() > Date.now()));
  }

  /** Get all consents (including revoked/expired) for a participant. */
  getAllConsents(participantId: AccountId): ResearchConsent[] {
    return (this.byParticipant.get(participantId) ?? []).map((id) => this.consents.get(id)!).filter(Boolean);
  }

  /** Get participants who have consented to a specific research type. */
  getConsentingParticipants(type: ResearchConsentType): AccountId[] {
    return [...this.consents.values()]
      .filter((c) => c.type === type && c.status === "granted" && (!c.expiresAt || new Date(c.expiresAt).getTime() > Date.now()))
      .map((c) => c.participantId);
  }

  /** Sweep expired consents. */
  sweepExpired(): number {
    const now = Date.now();
    let n = 0;
    for (const [id, consent] of this.consents) {
      if (consent.status === "granted" && consent.expiresAt && new Date(consent.expiresAt).getTime() < now) {
        this.consents.set(id, { ...consent, status: "expired" as const });
        n++;
      }
    }
    return n;
  }

  getStats(): { total: number; active: number; revoked: number; expired: number; byType: Record<string, number> } {
    const list = [...this.consents.values()];
    const byType: Record<string, number> = {};
    for (const c of list) byType[c.type] = (byType[c.type] ?? 0) + 1;
    return {
      total: list.length,
      active: list.filter((c) => c.status === "granted").length,
      revoked: list.filter((c) => c.status === "revoked").length,
      expired: list.filter((c) => c.status === "expired").length,
      byType,
    };
  }

  private findByParticipantAndType(participantId: AccountId, type: ResearchConsentType): ResearchConsent | undefined {
    return (this.byParticipant.get(participantId) ?? [])
      .map((id) => this.consents.get(id)!)
      .find((c) => c && c.type === type);
  }
}

let _mgr: ResearchConsentManager | null = null;
export function getResearchConsent(): ResearchConsentManager {
  if (!_mgr) _mgr = new ResearchConsentManager();
  return _mgr;
}
