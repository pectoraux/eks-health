/**
 * Eks-Health Technician Network — Accreditation Engine
 *
 * Multiple accreditation authorities: government, hospitals, professional
 * associations, universities, program developers, platform, independent
 * organizations. Programs decide which authorities they trust.
 */

import "server-only";
import {
  type AccreditationId,
  type AccreditationAuthorityId,
  type AccreditationAuthorityType,
  type TechnicianId,
  type ProgramId,
  type OrgId,
  TechnicianError,
  asAccreditationId,
  asAccreditationAuthorityId,
} from "../core";
import { getEventBus, buildEvent, generateId, getClock } from "@/kernel";
import { TECHNICIAN_EVENTS } from "../core";

// ---------------------------------------------------------------------------
// Accreditation authority
// ---------------------------------------------------------------------------

export interface AccreditationAuthority {
  readonly id: AccreditationAuthorityId;
  readonly name: string;
  readonly type: AccreditationAuthorityType;
  readonly description?: string;
  readonly jurisdiction?: string; // country/region
  readonly verified: boolean;
  readonly verifiedAt?: string;
  readonly trustLevel: AuthorityTrustLevel;
  readonly trustedByPrograms: ProgramId[];
  readonly contactEmail?: string;
  readonly website?: string;
  readonly customAttributes?: Record<string, unknown>;
  readonly createdAt: string;
}

export type AuthorityTrustLevel = "unverified" | "verified" | "trusted" | "authoritative";

// ---------------------------------------------------------------------------
// Accreditation (an authority accredits a technician or org)
// ---------------------------------------------------------------------------

export interface Accreditation {
  readonly id: AccreditationId;
  readonly authorityId: AccreditationAuthorityId;
  readonly technicianId?: TechnicianId;
  readonly orgId?: OrgId;
  readonly scope: string; // what they're accredited for
  readonly status: "pending" | "active" | "expired" | "revoked";
  readonly grantedAt: string;
  readonly expiresAt?: string;
  readonly revokedAt?: string;
  readonly revokedReason?: string;
  readonly evidenceReference?: string;
  readonly metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Accreditation registry
// ---------------------------------------------------------------------------

export class AccreditationRegistry {
  private readonly authorities = new Map<AccreditationAuthorityId, AccreditationAuthority>();
  private readonly accreditations = new Map<AccreditationId, Accreditation>();
  private readonly byTechnician = new Map<TechnicianId, AccreditationId[]>();
  private readonly byAuthority = new Map<AccreditationAuthorityId, AccreditationId[]>();

  registerAuthority(input: Omit<AccreditationAuthority, "id" | "createdAt" | "trustLevel" | "verified" | "trustedByPrograms"> & {
    trustLevel?: AuthorityTrustLevel;
    verified?: boolean;
    trustedByPrograms?: ProgramId[];
  }): AccreditationAuthority {
    const authority: AccreditationAuthority = {
      ...input,
      id: asAccreditationAuthorityId(generateId("auth_")),
      trustLevel: input.trustLevel ?? "unverified",
      verified: input.verified ?? false,
      trustedByPrograms: input.trustedByPrograms ?? [],
      createdAt: getClock().iso(),
    };
    this.authorities.set(authority.id, authority);
    return authority;
  }

  getAuthority(id: AccreditationAuthorityId): AccreditationAuthority | undefined {
    return this.authorities.get(id);
  }

  listAuthorities(filter?: { type?: AccreditationAuthorityType; jurisdiction?: string; verifiedOnly?: boolean }): AccreditationAuthority[] {
    let list = [...this.authorities.values()];
    if (filter?.type) list = list.filter((a) => a.type === filter.type);
    if (filter?.jurisdiction) list = list.filter((a) => a.jurisdiction === filter.jurisdiction);
    if (filter?.verifiedOnly) list = list.filter((a) => a.verified);
    return list;
  }

  verifyAuthority(id: AccreditationAuthorityId): AccreditationAuthority {
    const a = this.authorities.get(id);
    if (!a) throw new TechnicianError({ code: "eks.technician.auth.not_found", category: "not_found", message: "Authority not found." });
    const updated = { ...a, verified: true, verifiedAt: getClock().iso(), trustLevel: a.trustLevel === "unverified" ? "verified" as const : a.trustLevel };
    this.authorities.set(id, updated);
    return updated;
  }

  trustAuthority(id: AccreditationAuthorityId, programId: ProgramId): void {
    const a = this.authorities.get(id);
    if (!a) return;
    if (a.trustedByPrograms.includes(programId)) return;
    this.authorities.set(id, { ...a, trustedByPrograms: [...a.trustedByPrograms, programId] });
  }

  accredit(input: {
    authorityId: AccreditationAuthorityId;
    technicianId?: TechnicianId;
    orgId?: OrgId;
    scope: string;
    expiresAt?: string;
    evidenceReference?: string;
    metadata?: Record<string, unknown>;
  }): Accreditation {
    const authority = this.authorities.get(input.authorityId);
    if (!authority) throw new TechnicianError({ code: "eks.technician.auth.not_found", category: "not_found", message: "Authority not found." });
    if (!authority.verified) throw new TechnicianError({ code: "eks.technician.auth.unverified", category: "validation", message: "Authority is not verified.", userMessage: "This accreditation authority is not verified." });
    const accreditation: Accreditation = {
      id: asAccreditationId(generateId("accred_")),
      authorityId: input.authorityId,
      technicianId: input.technicianId,
      orgId: input.orgId,
      scope: input.scope,
      status: "active",
      grantedAt: getClock().iso(),
      expiresAt: input.expiresAt,
      evidenceReference: input.evidenceReference,
      metadata: input.metadata,
    };
    this.accreditations.set(accreditation.id, accreditation);
    if (input.technicianId) {
      const list = this.byTechnician.get(input.technicianId) ?? [];
      this.byTechnician.set(input.technicianId, [...list, accreditation.id]);
    }
    const aList = this.byAuthority.get(input.authorityId) ?? [];
    this.byAuthority.set(input.authorityId, [...aList, accreditation.id]);
    void getEventBus().publish(buildEvent(TECHNICIAN_EVENTS.accreditationGranted, { accreditationId: accreditation.id, authorityId: input.authorityId, technicianId: input.technicianId }, {}, "domain"));
    return accreditation;
  }

  revokeAccreditation(id: AccreditationId, reason: string): void {
    const a = this.accreditations.get(id);
    if (!a) return;
    this.accreditations.set(id, { ...a, status: "revoked", revokedAt: getClock().iso(), revokedReason: reason });
  }

  listForTechnician(technicianId: TechnicianId): Accreditation[] {
    return (this.byTechnician.get(technicianId) ?? []).map((id) => this.accreditations.get(id)!).filter(Boolean);
  }

  /** Check if a technician is accredited by an authority trusted by a program. */
  isAccreditedByTrustedAuthority(technicianId: TechnicianId, programId: ProgramId, scope?: string): boolean {
    const accreditations = this.listForTechnician(technicianId).filter((a) => a.status === "active");
    for (const acc of accreditations) {
      if (scope && acc.scope !== scope) continue;
      const authority = this.authorities.get(acc.authorityId);
      if (authority?.trustedByPrograms.includes(programId)) return true;
    }
    return false;
  }

  getStats(): { totalAuthorities: number; verifiedAuthorities: number; totalAccreditations: number; activeAccreditations: number } {
    const authorities = [...this.authorities.values()];
    const accreditations = [...this.accreditations.values()];
    return {
      totalAuthorities: authorities.length,
      verifiedAuthorities: authorities.filter((a) => a.verified).length,
      totalAccreditations: accreditations.length,
      activeAccreditations: accreditations.filter((a) => a.status === "active").length,
    };
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _registry: AccreditationRegistry | null = null;
export function getAccreditation(): AccreditationRegistry {
  if (!_registry) _registry = new AccreditationRegistry();
  return _registry;
}
