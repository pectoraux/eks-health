/**
 * Eks-Health Technician Network — Technician Profiles
 *
 * Comprehensive technician profiles: professional info, certifications,
 * accreditations, skills, languages, regions served, availability,
 * equipment, affiliated orgs, experience, reputation, verification
 * statistics, measurement history, audit history, programs supported.
 * Profiles are extensible — Programs add custom attributes.
 */

import "server-only";
import {
  type TechnicianId,
  type TechnicianCategory,
  type AccountId,
  type OrgId,
  type ProgramId,
  TechnicianError,
  asTechnicianId,
} from "../core";
import { getEventBus, buildEvent, generateId, getClock } from "@/kernel";
import { TECHNICIAN_EVENTS } from "../core";

// ---------------------------------------------------------------------------
// Technician profile
// ---------------------------------------------------------------------------

export interface TechnicianProfile {
  readonly id: TechnicianId;
  readonly accountId: AccountId;
  readonly category: TechnicianCategory;
  readonly displayName: string;
  readonly bio?: string;
  readonly avatarUrl?: string;
  readonly contactEmail?: string;
  readonly contactPhone?: string;
  readonly languages: string[];
  readonly regionsServed: string[]; // country codes or region labels
  readonly skills: string[]; // program-defined, e.g. "blood_pressure", "phlebotomy"
  readonly equipment: string[]; // device types they can operate
  readonly affiliatedOrganizations: OrgAffiliation[];
  readonly supportedPrograms: ProgramId[];
  readonly availability: AvailabilitySchedule;
  readonly rating?: number; // 0-5 aggregate
  readonly reviewCount: number;
  readonly totalSessions: number;
  readonly verifiedSessions: number;
  readonly disputedSessions: number;
  readonly customAttributes: Record<string, unknown>; // program-scoped extras
  readonly status: TechnicianProfileStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly suspendedAt?: string;
  readonly suspendedReason?: string;
}

export type TechnicianProfileStatus = "active" | "suspended" | "deactivated";

export interface OrgAffiliation {
  readonly orgId: OrgId;
  readonly role: string; // e.g. "staff", "contractor", "lead"
  readonly since: string;
  readonly until?: string;
}

export interface AvailabilitySchedule {
  readonly timezone: string;
  readonly weeklyHours: WeeklyAvailability[];
  readonly blackoutPeriods: { from: string; to: string; reason?: string }[];
  readonly bookingLeadTimeHours: number;
  readonly bookingHorizonDays: number;
  readonly maxConcurrentBookings: number;
}

export interface WeeklyAvailability {
  readonly dayOfWeek: number; // 0=Sun ... 6=Sat
  readonly slots: { startHour: number; endHour: number }[];
}

// ---------------------------------------------------------------------------
// Technician registry
// ---------------------------------------------------------------------------

export interface RegisterTechnicianInput {
  readonly accountId: AccountId;
  readonly category: TechnicianCategory;
  readonly displayName: string;
  readonly bio?: string;
  readonly languages?: string[];
  readonly regionsServed?: string[];
  readonly skills?: string[];
  readonly equipment?: string[];
  readonly timezone?: string;
  readonly supportedPrograms?: ProgramId[];
}

export class TechnicianRegistry {
  private readonly technicians = new Map<TechnicianId, TechnicianProfile>();
  private readonly byAccount = new Map<AccountId, TechnicianId[]>();
  private readonly byOrg = new Map<OrgId, TechnicianId[]>();
  private readonly byProgram = new Map<ProgramId, TechnicianId[]>();
  private readonly byRegion = new Map<string, TechnicianId[]>();

  register(input: RegisterTechnicianInput): TechnicianProfile {
    const now = getClock().iso();
    const profile: TechnicianProfile = {
      id: asTechnicianId(generateId("tech_")),
      accountId: input.accountId,
      category: input.category,
      displayName: input.displayName,
      bio: input.bio,
      languages: input.languages ?? [],
      regionsServed: input.regionsServed ?? [],
      skills: input.skills ?? [],
      equipment: input.equipment ?? [],
      affiliatedOrganizations: [],
      supportedPrograms: input.supportedPrograms ?? [],
      availability: {
        timezone: input.timezone ?? "UTC",
        weeklyHours: [],
        blackoutPeriods: [],
        bookingLeadTimeHours: 1,
        bookingHorizonDays: 30,
        maxConcurrentBookings: 1,
      },
      reviewCount: 0,
      totalSessions: 0,
      verifiedSessions: 0,
      disputedSessions: 0,
      customAttributes: {},
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    this.technicians.set(profile.id, profile);
    this.indexBy(profile);
    void getEventBus().publish(buildEvent(TECHNICIAN_EVENTS.technicianRegistered, { technicianId: profile.id, accountId: input.accountId, category: input.category }, {}, "domain"));
    return profile;
  }

  get(id: TechnicianId): TechnicianProfile | undefined {
    return this.technicians.get(id);
  }

  getByAccount(accountId: AccountId): TechnicianProfile[] {
    return (this.byAccount.get(accountId) ?? []).map((id) => this.technicians.get(id)!).filter(Boolean);
  }

  list(filter?: {
    category?: TechnicianCategory;
    region?: string;
    programId?: ProgramId;
    orgId?: OrgId;
    status?: TechnicianProfileStatus;
    language?: string;
    skill?: string;
  }): TechnicianProfile[] {
    let list = [...this.technicians.values()];
    if (filter?.category) list = list.filter((t) => t.category === filter.category);
    if (filter?.region) list = list.filter((t) => t.regionsServed.includes(filter.region!));
    if (filter?.programId) list = list.filter((t) => t.supportedPrograms.includes(filter.programId!));
    if (filter?.orgId) list = list.filter((t) => t.affiliatedOrganizations.some((a) => a.orgId === filter.orgId));
    if (filter?.status) list = list.filter((t) => t.status === filter.status);
    if (filter?.language) list = list.filter((t) => t.languages.includes(filter.language!));
    if (filter?.skill) list = list.filter((t) => t.skills.includes(filter.skill!));
    return list;
  }

  update(id: TechnicianId, updates: Partial<Omit<TechnicianProfile, "id" | "accountId" | "createdAt">>): TechnicianProfile {
    const existing = this.technicians.get(id);
    if (!existing) throw new TechnicianError({ code: "eks.technician.not_found", category: "not_found", message: "Technician not found." });
    const updated = { ...existing, ...updates, updatedAt: getClock().iso() };
    this.technicians.set(id, updated);
    // Re-index
    this.removeFromIndices(existing);
    this.indexBy(updated);
    return updated;
  }

  affiliate(id: TechnicianId, affiliation: OrgAffiliation): TechnicianProfile {
    const t = this.technicians.get(id);
    if (!t) throw new TechnicianError({ code: "eks.technician.not_found", category: "not_found", message: "Not found." });
    return this.update(id, { affiliatedOrganizations: [...t.affiliatedOrganizations, affiliation] });
  }

  setAvailability(id: TechnicianId, availability: AvailabilitySchedule): TechnicianProfile {
    return this.update(id, { availability });
  }

  addProgram(id: TechnicianId, programId: ProgramId): TechnicianProfile {
    const t = this.technicians.get(id);
    if (!t) throw new TechnicianError({ code: "eks.technician.not_found", category: "not_found", message: "Not found." });
    if (t.supportedPrograms.includes(programId)) return t;
    return this.update(id, { supportedPrograms: [...t.supportedPrograms, programId] });
  }

  setCustomAttribute(id: TechnicianId, key: string, value: unknown): TechnicianProfile {
    const t = this.technicians.get(id);
    if (!t) throw new TechnicianError({ code: "eks.technician.not_found", category: "not_found", message: "Not found." });
    return this.update(id, { customAttributes: { ...t.customAttributes, [key]: value } });
  }

  suspend(id: TechnicianId, reason: string): TechnicianProfile {
    const updated = this.update(id, { status: "suspended", suspendedAt: getClock().iso(), suspendedReason: reason });
    void getEventBus().publish(buildEvent(TECHNICIAN_EVENTS.technicianSuspended, { technicianId: id, reason }, {}, "domain"));
    return updated;
  }

  reactivate(id: TechnicianId): TechnicianProfile {
    return this.update(id, { status: "active", suspendedAt: undefined, suspendedReason: undefined });
  }

  recordSession(id: TechnicianId, verified: boolean, disputed: boolean): void {
    const t = this.technicians.get(id);
    if (!t) return;
    this.update(id, {
      totalSessions: t.totalSessions + 1,
      verifiedSessions: t.verifiedSessions + (verified ? 1 : 0),
      disputedSessions: t.disputedSessions + (disputed ? 1 : 0),
    });
  }

  updateRating(id: TechnicianId, newRating: number, reviewCount: number): void {
    this.update(id, { rating: newRating, reviewCount });
  }

  getStats(): {
    total: number;
    active: number;
    suspended: number;
    byCategory: Record<string, number>;
    totalSessions: number;
    avgRating: number;
  } {
    const list = [...this.technicians.values()];
    const byCategory: Record<string, number> = {};
    let totalSessions = 0;
    let ratingSum = 0;
    let ratedCount = 0;
    for (const t of list) {
      byCategory[t.category] = (byCategory[t.category] ?? 0) + 1;
      totalSessions += t.totalSessions;
      if (t.rating !== undefined) { ratingSum += t.rating; ratedCount++; }
    }
    return {
      total: list.length,
      active: list.filter((t) => t.status === "active").length,
      suspended: list.filter((t) => t.status === "suspended").length,
      byCategory,
      totalSessions,
      avgRating: ratedCount > 0 ? ratingSum / ratedCount : 0,
    };
  }

  private indexBy(t: TechnicianProfile): void {
    const aList = this.byAccount.get(t.accountId) ?? [];
    this.byAccount.set(t.accountId, [...aList, t.id]);
    for (const aff of t.affiliatedOrganizations) {
      const oList = this.byOrg.get(aff.orgId) ?? [];
      this.byOrg.set(aff.orgId, [...oList, t.id]);
    }
    for (const p of t.supportedPrograms) {
      const pList = this.byProgram.get(p) ?? [];
      this.byProgram.set(p, [...pList, t.id]);
    }
    for (const r of t.regionsServed) {
      const rList = this.byRegion.get(r) ?? [];
      this.byRegion.set(r, [...rList, t.id]);
    }
  }

  private removeFromIndices(t: TechnicianProfile): void {
    const aList = this.byAccount.get(t.accountId) ?? [];
    this.byAccount.set(t.accountId, aList.filter((id) => id !== t.id));
    for (const aff of t.affiliatedOrganizations) {
      const oList = this.byOrg.get(aff.orgId) ?? [];
      this.byOrg.set(aff.orgId, oList.filter((id) => id !== t.id));
    }
    for (const p of t.supportedPrograms) {
      const pList = this.byProgram.get(p) ?? [];
      this.byProgram.set(p, pList.filter((id) => id !== t.id));
    }
    for (const r of t.regionsServed) {
      const rList = this.byRegion.get(r) ?? [];
      this.byRegion.set(r, rList.filter((id) => id !== t.id));
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _registry: TechnicianRegistry | null = null;
export function getTechnicians(): TechnicianRegistry {
  if (!_registry) _registry = new TechnicianRegistry();
  return _registry;
}
