/**
 * Eks-Health Technician Network — Discovery & Matching
 *
 * Search and matching service. Participants search technicians by location,
 * programs supported, certifications, languages, availability, ratings,
 * organizations, remote availability, special equipment, and pricing.
 * Programs may register custom ranking algorithms that override the
 * platform's default weighted scoring.
 *
 * All math is REAL: haversine distance, weighted match scoring (0-100),
 * per-criteria filtering, timezone-aware availability checks via the
 * appointment platform.
 */

import "server-only";
import {
  type TechnicianId,
  type ProgramId,
  type AccountId,
  type AppointmentType,
  TechnicianError,
} from "../core";
import { getClock } from "@/kernel";
import { getTechnicians, type TechnicianProfile } from "../profiles";
import { getCertifications } from "../certifications";
import { getAccreditation } from "../accreditation";
import { getAppointments, type TimeSlot } from "../appointments";

// ---------------------------------------------------------------------------
// Geo primitives
// ---------------------------------------------------------------------------

export interface GeoPoint {
  readonly lat: number;
  readonly lon: number;
}

/**
 * REAL haversine distance between two geo points, in kilometres.
 * Uses the mean Earth radius (6371 km).
 */
export function haversineKm(a: GeoPoint, b: GeoPoint): number {
  const R = 6371;
  const toRad = (deg: number): number => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const sinDLat = Math.sin(dLat / 2);
  const sinDLon = Math.sin(dLon / 2);
  const h =
    sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLon * sinDLon;
  const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  return R * c;
}

// ---------------------------------------------------------------------------
// Query & result
// ---------------------------------------------------------------------------

export type SortBy = "distance" | "rating" | "availability" | "reputation";

export interface DiscoveryQuery {
  readonly participantLocation?: GeoPoint;
  readonly programId?: ProgramId;
  readonly requiredCertifications?: string[];
  readonly languages?: string[];
  readonly regions?: string[];
  readonly remoteOnly?: boolean;
  readonly inPersonOnly?: boolean;
  readonly minRating?: number;
  readonly requiredEquipment?: string[];
  readonly dateRange?: { from: string; to: string };
  readonly maxDistanceKm?: number;
  readonly sortBy?: SortBy;
  /** Limit number of results returned. */
  readonly limit?: number;
  /** Restrict to technicians accredited by an authority trusted by programId. */
  readonly requireAccreditation?: boolean;
}

export interface MatchScore {
  readonly total: number; // 0-100
  readonly certificationMatch: number;
  readonly languageMatch: number;
  readonly ratingScore: number;
  readonly distanceScore: number;
  readonly regionMatch: number;
  readonly availabilityScore: number;
  readonly accreditationScore: number;
}

export interface DiscoveryResult {
  readonly technicianId: TechnicianId;
  readonly matchScore: number; // 0-100
  readonly scoreBreakdown?: MatchScore;
  readonly distanceKm?: number;
  readonly availableSlots?: TimeSlot[];
  readonly rating?: number;
  readonly certifications: string[];
  readonly languages: string[];
  readonly programs: ProgramId[];
  readonly supportsRemote: boolean;
  readonly rankedAt: string;
}

export interface DiscoveryFilter {
  readonly programId?: ProgramId;
  readonly regions?: string[];
  readonly languages?: string[];
  readonly minRating?: number;
  readonly requiredEquipment?: string[];
  readonly requiredCertifications?: string[];
  readonly remoteOnly?: boolean;
  readonly inPersonOnly?: boolean;
  readonly maxDistanceKm?: number;
  readonly requireAccreditation?: boolean;
}

// ---------------------------------------------------------------------------
// Custom ranking algorithm (program-scoped)
// ---------------------------------------------------------------------------

export interface RankingContext {
  readonly profile: TechnicianProfile;
  readonly query: DiscoveryQuery;
  readonly distanceKm?: number;
  readonly availableSlots?: TimeSlot[];
  readonly defaultScore: MatchScore;
}

export type RankingAlgorithm = (ctx: RankingContext) => number;

// ---------------------------------------------------------------------------
// Participant location resolver hook
// ---------------------------------------------------------------------------

/**
 * Resolver that returns a participant's home location. Identity / health
 * profile subsystems register this at boot. If absent, suggest() falls back
 * to a location-agnostic recommendation.
 */
export type ParticipantLocationResolver = (
  participantId: AccountId,
) => GeoPoint | undefined;

let _participantLocationResolver: ParticipantLocationResolver | null = null;

export function setParticipantLocationResolver(
  resolver: ParticipantLocationResolver | null,
): void {
  _participantLocationResolver = resolver;
}

// ---------------------------------------------------------------------------
// Technician discovery
// ---------------------------------------------------------------------------

export class TechnicianDiscovery {
  private readonly rankingAlgorithms = new Map<ProgramId, RankingAlgorithm>();

  /** Register a custom ranking algorithm for a program (overrides default). */
  registerRankingAlgorithm(programId: ProgramId, algorithm: RankingAlgorithm): void {
    this.rankingAlgorithms.set(programId, algorithm);
  }

  /**
   * Search technicians matching the query. REAL filtering on every criterion,
   * REAL haversine distance, REAL weighted match scoring.
   */
  search(query: DiscoveryQuery): DiscoveryResult[] {
    const now = getClock().iso();
    const all = getTechnicians().list({ status: "active" });
    const certRegistry = getCertifications();
    const accredRegistry = getAccreditation();

    const results: DiscoveryResult[] = [];
    for (const profile of all) {
      const techLocation = this.resolveTechnicianLocation(profile);
      const distanceKm =
        query.participantLocation && techLocation
          ? haversineKm(query.participantLocation, techLocation)
          : undefined;

      // ----- Hard filters -----
      if (query.programId && !profile.supportedPrograms.includes(query.programId)) continue;
      if (query.regions && query.regions.length > 0) {
        if (!query.regions.some((r) => profile.regionsServed.includes(r))) continue;
      }
      if (query.languages && query.languages.length > 0) {
        if (!query.languages.some((l) => profile.languages.includes(l))) continue;
      }
      if (typeof query.minRating === "number") {
        if ((profile.rating ?? 0) < query.minRating) continue;
      }
      if (query.requiredEquipment && query.requiredEquipment.length > 0) {
        if (!query.requiredEquipment.every((e) => profile.equipment.includes(e))) continue;
      }
      if (query.requiredCertifications && query.requiredCertifications.length > 0) {
        const allCerts = query.requiredCertifications.every((slug) =>
          certRegistry.hasValidCert(profile.id, slug),
        );
        if (!allCerts) continue;
      }
      if (query.remoteOnly && !this.supportsRemote(profile)) continue;
      if (query.inPersonOnly && profile.category === "remote") continue;
      if (typeof query.maxDistanceKm === "number" && typeof distanceKm === "number") {
        if (distanceKm > query.maxDistanceKm) continue;
      }
      if (query.requireAccreditation && query.programId) {
        if (!accredRegistry.isAccreditedByTrustedAuthority(profile.id, query.programId)) continue;
      }

      // ----- Availability check -----
      let availableSlots: TimeSlot[] | undefined;
      if (query.dateRange) {
        try {
          availableSlots = getAppointments()
            .getAvailability(profile.id, query.dateRange.from, query.dateRange.to)
            .filter((s) => s.available);
        } catch {
          availableSlots = undefined;
        }
        if (query.dateRange && availableSlots && availableSlots.length === 0) continue;
      }

      // ----- Scoring -----
      const activeCertSlugs = this.activeCertSlugs(profile);
      const defaultScore = this.computeScore(profile, query, distanceKm, availableSlots);
      const customRanker = query.programId
        ? this.rankingAlgorithms.get(query.programId)
        : undefined;
      const total = customRanker
        ? customRanker({
            profile,
            query,
            distanceKm,
            availableSlots,
            defaultScore,
          })
        : defaultScore.total;

      results.push({
        technicianId: profile.id,
        matchScore: Math.round(Math.min(100, Math.max(0, total))),
        scoreBreakdown: defaultScore,
        distanceKm,
        availableSlots,
        rating: profile.rating,
        certifications: activeCertSlugs,
        languages: profile.languages,
        programs: profile.supportedPrograms,
        supportsRemote: this.supportsRemote(profile),
        rankedAt: now,
      });
    }

    // ----- Sort -----
    const sortBy: SortBy = query.sortBy ?? "distance";
    results.sort((a, b) => this.compareBy(a, b, sortBy));
    if (typeof query.limit === "number" && query.limit > 0) {
      return results.slice(0, query.limit);
    }
    return results;
  }

  /**
   * Score a single technician against a query (0-100). Returns 0 if the
   * technician fails hard filters.
   */
  match(technicianId: TechnicianId, query: DiscoveryQuery): number {
    const profile = getTechnicians().get(technicianId);
    if (!profile) return 0;
    const techLocation = this.resolveTechnicianLocation(profile);
    const distanceKm =
      query.participantLocation && techLocation
        ? haversineKm(query.participantLocation, techLocation)
        : undefined;
    if (typeof query.maxDistanceKm === "number" && typeof distanceKm === "number") {
      if (distanceKm > query.maxDistanceKm) return 0;
    }
    if (query.requiredCertifications && query.requiredCertifications.length > 0) {
      const allCerts = query.requiredCertifications.every((slug) =>
        getCertifications().hasValidCert(profile.id, slug),
      );
      if (!allCerts) return 0;
    }
    if (query.requiredEquipment && query.requiredEquipment.length > 0) {
      if (!query.requiredEquipment.every((e) => profile.equipment.includes(e))) return 0;
    }
    if (query.programId && !profile.supportedPrograms.includes(query.programId)) return 0;
    return this.computeScore(profile, query, distanceKm, undefined).total;
  }

  /**
   * Suggest technicians for a participant based on their location and a
   * program's requirements. Uses the registered participant location
   * resolver; falls back to a location-agnostic search if unavailable.
   */
  suggest(participantId: AccountId, programId: ProgramId, limit?: number): DiscoveryResult[] {
    const participantLocation = _participantLocationResolver
      ? safeResolve(_participantLocationResolver, participantId)
      : undefined;
    return this.search({
      participantLocation,
      programId,
      sortBy: participantLocation ? "distance" : "rating",
      limit: limit ?? 10,
    });
  }

  /**
   * Find technicians within a radius of a geo point. REAL haversine.
   */
  getNearby(
    lat: number,
    lon: number,
    radiusKm: number,
    filter?: DiscoveryFilter,
  ): DiscoveryResult[] {
    return this.search({
      participantLocation: { lat, lon },
      maxDistanceKm: radiusKm,
      ...filter,
      sortBy: "distance",
    });
  }

  /**
   * List technicians with availability in the given window for a program.
   */
  listAvailable(
    programId: ProgramId,
    from: string,
    to: string,
  ): DiscoveryResult[] {
    return this.search({
      programId,
      dateRange: { from, to },
      sortBy: "availability",
    });
  }

  /** Stats for observability. */
  getStats(): {
    registeredRankingAlgorithms: number;
    participantLocationResolverSet: boolean;
  } {
    return {
      registeredRankingAlgorithms: this.rankingAlgorithms.size,
      participantLocationResolverSet: _participantLocationResolver !== null,
    };
  }

  // -------------------------------------------------------------------------
  // Internal: scoring
  // -------------------------------------------------------------------------

  /**
   * Compute a weighted match score (0-100).
   *
   * Components (max each):
   *   - certification match : 30  (proportional to required certs present)
   *   - language match      : 15  (proportional to required languages)
   *   - rating score        : 20  (rating / 5 * 20)
   *   - distance score      : 25  (inverse distance, capped at maxDistanceKm or 100km)
   *   - region match        : 10  (1 if any region overlap else 0)
   *   - availability score  : 10  (1 if has slots in dateRange else 0)
   *   - accreditation       : 10  (1 if accredited by trusted authority else 0)
   *
   * Raw max = 120; scaled to 0-100.
   */
  private computeScore(
    profile: TechnicianProfile,
    query: DiscoveryQuery,
    distanceKm: number | undefined,
    availableSlots: TimeSlot[] | undefined,
  ): MatchScore {
    const certRegistry = getCertifications();
    const accredRegistry = getAccreditation();

    // Certification match
    let certMatch = 30;
    if (query.requiredCertifications && query.requiredCertifications.length > 0) {
      const present = query.requiredCertifications.filter((slug) =>
        certRegistry.hasValidCert(profile.id, slug),
      ).length;
      certMatch = Math.round((present / query.requiredCertifications.length) * 30);
    } else {
      // No specific requirement: award partial credit for any active certs.
      const activeCount = certRegistry.listForTechnician(profile.id, true).length;
      certMatch = Math.min(30, activeCount * 6);
    }

    // Language match
    let languageMatch = 15;
    if (query.languages && query.languages.length > 0) {
      const present = query.languages.filter((l) => profile.languages.includes(l)).length;
      languageMatch = Math.round((present / query.languages.length) * 15);
    } else {
      languageMatch = Math.min(15, profile.languages.length * 5);
    }

    // Rating score
    const rating = typeof profile.rating === "number" ? profile.rating : 0;
    const ratingScore = Math.round((rating / 5) * 20);

    // Distance score
    let distanceScore = 0;
    if (typeof distanceKm === "number") {
      const cap = query.maxDistanceKm ?? 100;
      const capped = Math.min(distanceKm, cap);
      distanceScore = Math.round(((cap - capped) / cap) * 25);
    } else if (!query.participantLocation) {
      // No participant location provided: neutral, award half.
      distanceScore = 12;
    }

    // Region match
    let regionMatch = 0;
    if (query.regions && query.regions.length > 0) {
      regionMatch = query.regions.some((r) => profile.regionsServed.includes(r)) ? 10 : 0;
    } else if (profile.regionsServed.length > 0) {
      regionMatch = 5;
    }

    // Availability score
    let availabilityScore = 0;
    if (availableSlots && availableSlots.length > 0) {
      availabilityScore = 10;
    } else if (!query.dateRange) {
      availabilityScore = 5; // unknown — neutral
    }

    // Accreditation
    let accreditationScore = 0;
    if (query.programId) {
      accreditationScore = accredRegistry.isAccreditedByTrustedAuthority(profile.id, query.programId) ? 10 : 0;
    } else {
      accreditationScore = accredRegistry.listForTechnician(profile.id).filter((a) => a.status === "active").length > 0 ? 5 : 0;
    }

    const raw =
      certMatch +
      languageMatch +
      ratingScore +
      distanceScore +
      regionMatch +
      availabilityScore +
      accreditationScore;
    const total = Math.round((raw / 120) * 100);

    return {
      total,
      certificationMatch: certMatch,
      languageMatch,
      ratingScore,
      distanceScore,
      regionMatch,
      availabilityScore,
      accreditationScore,
    };
  }

  private resolveTechnicianLocation(profile: TechnicianProfile): GeoPoint | undefined {
    const loc = profile.customAttributes["location"] ?? profile.customAttributes["geo"];
    if (
      loc &&
      typeof loc === "object" &&
      typeof (loc as GeoPoint).lat === "number" &&
      typeof (loc as GeoPoint).lon === "number"
    ) {
      return loc as GeoPoint;
    }
    return undefined;
  }

  private supportsRemote(profile: TechnicianProfile): boolean {
    if (profile.category === "remote") return true;
    if (profile.customAttributes["supportsRemote"] === true) return true;
    // Programs supported include any with a remote appointment type hint.
    if (Array.isArray(profile.customAttributes["remoteSessionTypes"])) {
      return (profile.customAttributes["remoteSessionTypes"] as unknown[]).length > 0;
    }
    return false;
  }

  private activeCertSlugs(profile: TechnicianProfile): string[] {
    const certRegistry = getCertifications();
    const slugs: string[] = [];
    for (const cert of certRegistry.listForTechnician(profile.id, true)) {
      const type = certRegistry.getType(cert.typeId);
      if (type) slugs.push(type.slug);
    }
    return slugs;
  }

  private compareBy(a: DiscoveryResult, b: DiscoveryResult, sortBy: SortBy): number {
    switch (sortBy) {
      case "distance": {
        if (a.distanceKm === undefined && b.distanceKm === undefined) return 0;
        if (a.distanceKm === undefined) return 1;
        if (b.distanceKm === undefined) return -1;
        return a.distanceKm - b.distanceKm;
      }
      case "rating":
        return (b.rating ?? 0) - (a.rating ?? 0);
      case "availability":
        return (
          (b.availableSlots?.length ?? 0) - (a.availableSlots?.length ?? 0)
        );
      case "reputation":
        return b.matchScore - a.matchScore;
      default:
        return b.matchScore - a.matchScore;
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeResolve(
  resolver: ParticipantLocationResolver,
  participantId: AccountId,
): GeoPoint | undefined {
  try {
    return resolver(participantId);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _discovery: TechnicianDiscovery | null = null;

export function getDiscovery(): TechnicianDiscovery {
  if (!_discovery) _discovery = new TechnicianDiscovery();
  return _discovery;
}

/** Test-only: replace the singleton. */
export function setDiscovery(discovery: TechnicianDiscovery | null): void {
  _discovery = discovery;
}

/** Re-export appointment type for callers. */
export type { AppointmentType };
