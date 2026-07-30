/**
 * Eks-Health Technician Network — Certification Framework
 *
 * Programs define technician eligibility via certifications. Support:
 * required certifications, required skills, jurisdiction requirements,
 * org membership, platform certifications, program-issued certifications,
 * continuing education, expiration, renewal, revocation, verification.
 * The platform validates eligibility automatically.
 */

import "server-only";
import {
  type CertificationId,
  type CertificationTypeId,
  type TechnicianId,
  type ProgramId,
  type AccountId,
  type AccreditationAuthorityId,
  type CertificationStatus,
  type CertificationLevel,
  TechnicianError,
  asCertificationId,
  asCertificationTypeId,
} from "../core";
import { getEventBus, buildEvent, generateId, getClock } from "@/kernel";
import { TECHNICIAN_EVENTS } from "../core";

// ---------------------------------------------------------------------------
// Certification type (defined by Programs or the platform)
// ---------------------------------------------------------------------------

export interface CertificationType {
  readonly id: CertificationTypeId;
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly category: string; // program-defined, e.g. "clinical", "fitness"
  readonly level: CertificationLevel;
  readonly issuingAuthorityType: string; // who can issue this
  readonly requiresRenewal: boolean;
  readonly validityDays?: number; // 0 or undefined = never expires
  readonly requiresContinuingEducation: boolean;
  readonly ceHoursRequired?: number;
  readonly cePeriodDays?: number;
  readonly skills: string[]; // skills this cert grants
  readonly acceptedInRegions: string[]; // jurisdictions where valid
  readonly customAttributes?: Record<string, unknown>;
  readonly createdBy: string; // "platform" | programId | orgId
  readonly createdAt: string;
}

// ---------------------------------------------------------------------------
// Certification (an instance granted to a technician)
// ---------------------------------------------------------------------------

export interface Certification {
  readonly id: CertificationId;
  readonly typeId: CertificationTypeId;
  readonly technicianId: TechnicianId;
  readonly issuedBy: AccountId;
  readonly issuingAuthorityId?: AccreditationAuthorityId;
  readonly issuingAuthorityName: string;
  readonly programId?: ProgramId; // if program-issued
  readonly status: CertificationStatus;
  readonly level: CertificationLevel;
  readonly grantedAt: string;
  readonly expiresAt?: string;
  readonly revokedAt?: string;
  readonly revokedReason?: string;
  readonly ceHoursCompleted: number;
  readonly lastRenewedAt?: string;
  readonly verificationReference?: string; // evidence/hash
  readonly metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Certification registry
// ---------------------------------------------------------------------------

export class CertificationRegistry {
  private readonly types = new Map<CertificationTypeId, CertificationType>();
  private readonly typesBySlug = new Map<string, CertificationTypeId>();
  private readonly certifications = new Map<CertificationId, Certification>();
  private readonly byTechnician = new Map<TechnicianId, CertificationId[]>();
  private readonly byType = new Map<CertificationTypeId, CertificationId[]>();

  defineType(input: Omit<CertificationType, "id" | "createdAt">): CertificationType {
    if (this.typesBySlug.has(input.slug)) {
      throw new TechnicianError({ code: "eks.technician.cert.type.duplicate", category: "state_conflict", message: `Cert type ${input.slug} exists.`, userMessage: "This certification type already exists." });
    }
    const type: CertificationType = {
      ...input,
      id: asCertificationTypeId(generateId("certype_")),
      createdAt: getClock().iso(),
    };
    this.types.set(type.id, type);
    this.typesBySlug.set(type.slug, type.id);
    return type;
  }

  getType(id: CertificationTypeId): CertificationType | undefined {
    return this.types.get(id);
  }

  getTypeBySlug(slug: string): CertificationType | undefined {
    const id = this.typesBySlug.get(slug);
    return id ? this.types.get(id) : undefined;
  }

  listTypes(filter?: { category?: string; level?: CertificationLevel }): CertificationType[] {
    let list = [...this.types.values()];
    if (filter?.category) list = list.filter((t) => t.category === filter.category);
    if (filter?.level) list = list.filter((t) => t.level === filter.level);
    return list;
  }

  grant(input: {
    typeId: CertificationTypeId;
    technicianId: TechnicianId;
    issuedBy: AccountId;
    issuingAuthorityId?: AccreditationAuthorityId;
    issuingAuthorityName: string;
    programId?: ProgramId;
    level?: CertificationLevel;
    verificationReference?: string;
    metadata?: Record<string, unknown>;
  }): Certification {
    const type = this.types.get(input.typeId);
    if (!type) throw new TechnicianError({ code: "eks.technician.cert.type_not_found", category: "not_found", message: "Cert type not found." });
    const now = getClock().iso();
    const expiresAt = type.requiresRenewal && type.validityDays
      ? new Date(Date.now() + type.validityDays * 86400000).toISOString()
      : undefined;
    const cert: Certification = {
      id: asCertificationId(generateId("cert_")),
      typeId: input.typeId,
      technicianId: input.technicianId,
      issuedBy: input.issuedBy,
      issuingAuthorityId: input.issuingAuthorityId,
      issuingAuthorityName: input.issuingAuthorityName,
      programId: input.programId,
      status: "active",
      level: input.level ?? type.level,
      grantedAt: now,
      expiresAt,
      ceHoursCompleted: 0,
      verificationReference: input.verificationReference,
      metadata: input.metadata,
    };
    this.certifications.set(cert.id, cert);
    const tList = this.byTechnician.get(input.technicianId) ?? [];
    this.byTechnician.set(input.technicianId, [...tList, cert.id]);
    const tyList = this.byType.get(input.typeId) ?? [];
    this.byType.set(input.typeId, [...tyList, cert.id]);
    void getEventBus().publish(buildEvent(TECHNICIAN_EVENTS.certificationGranted, { certificationId: cert.id, technicianId: input.technicianId, typeId: input.typeId }, {}, "domain"));
    return cert;
  }

  revoke(id: CertificationId, reason: string): Certification {
    const cert = this.certifications.get(id);
    if (!cert) throw new TechnicianError({ code: "eks.technician.cert.not_found", category: "not_found", message: "Certification not found." });
    const updated: Certification = { ...cert, status: "revoked", revokedAt: getClock().iso(), revokedReason: reason };
    this.certifications.set(id, updated);
    void getEventBus().publish(buildEvent(TECHNICIAN_EVENTS.certificationRevoked, { certificationId: id, technicianId: cert.technicianId, reason }, {}, "domain"));
    return updated;
  }

  renew(id: CertificationId): Certification {
    const cert = this.certifications.get(id);
    if (!cert) throw new TechnicianError({ code: "eks.technician.cert.not_found", category: "not_found", message: "Not found." });
    const type = this.types.get(cert.typeId);
    const expiresAt = type?.requiresRenewal && type.validityDays
      ? new Date(Date.now() + type.validityDays * 86400000).toISOString()
      : undefined;
    const updated: Certification = { ...cert, status: "active", expiresAt, lastRenewedAt: getClock().iso() };
    this.certifications.set(id, updated);
    return updated;
  }

  recordCE(id: CertificationId, hours: number): Certification {
    const cert = this.certifications.get(id);
    if (!cert) throw new TechnicianError({ code: "eks.technician.cert.not_found", category: "not_found", message: "Not found." });
    const updated: Certification = { ...cert, ceHoursCompleted: cert.ceHoursCompleted + hours };
    this.certifications.set(id, updated);
    return updated;
  }

  /** Check if a certification is currently valid (active + not expired). */
  isValid(id: CertificationId): boolean {
    const cert = this.certifications.get(id);
    if (!cert || cert.status !== "active") return false;
    if (cert.expiresAt && new Date(cert.expiresAt).getTime() < Date.now()) return false;
    return true;
  }

  /** Check if a technician holds a valid certification of a given type. */
  hasValidCert(technicianId: TechnicianId, typeSlug: string): boolean {
    const type = this.getTypeBySlug(typeSlug);
    if (!type) return false;
    const certs = (this.byTechnician.get(technicianId) ?? []).map((id) => this.certifications.get(id)!).filter(Boolean);
    return certs.some((c) => c.typeId === type.id && this.isValid(c.id));
  }

  /** All certifications for a technician. */
  listForTechnician(technicianId: TechnicianId, activeOnly?: boolean): Certification[] {
    const ids = this.byTechnician.get(technicianId) ?? [];
    let certs = ids.map((id) => this.certifications.get(id)!).filter(Boolean);
    if (activeOnly) certs = certs.filter((c) => this.isValid(c.id));
    return certs;
  }

  /** Sweep expired certifications (called by scheduler). */
  sweepExpired(): number {
    let n = 0;
    const now = Date.now();
    for (const [id, cert] of this.certifications) {
      if (cert.status === "active" && cert.expiresAt && new Date(cert.expiresAt).getTime() < now) {
        this.certifications.set(id, { ...cert, status: "expired" });
        void getEventBus().publish(buildEvent(TECHNICIAN_EVENTS.certificationExpired, { certificationId: id, technicianId: cert.technicianId }, {}, "domain"));
        n++;
      }
    }
    return n;
  }

  getStats(): { totalTypes: number; totalCerts: number; activeCerts: number; expiredCerts: number; revokedCerts: number } {
    const list = [...this.certifications.values()];
    return {
      totalTypes: this.types.size,
      totalCerts: list.length,
      activeCerts: list.filter((c) => this.isValid(c.id)).length,
      expiredCerts: list.filter((c) => c.status === "expired").length,
      revokedCerts: list.filter((c) => c.status === "revoked").length,
    };
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _registry: CertificationRegistry | null = null;
export function getCertifications(): CertificationRegistry {
  if (!_registry) _registry = new CertificationRegistry();
  return _registry;
}
