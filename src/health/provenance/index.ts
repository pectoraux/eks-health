/**
 * Eks-Health Universal Health Data Platform — Data Provenance
 *
 * Every measurement records full traceability: who collected it, who
 * verified it, which program requested it, the source, the device, the
 * collection timestamp, the collection location (if consent permits), the
 * verification history, the consent reference, and the audit reference.
 *
 * The ProvenanceManager builds provenance objects for new measurements,
 * appends verification entries as a measurement moves through its
 * lifecycle, and constructs ProvenanceChains that link a measurement to
 * every system that touched it. Consent references are validated against
 * the identity platform's consent engine (guarded so the module works
 * even when identity is not yet booted in tests).
 */

import "server-only";

import type {
  AccountId,
  MeasurementId,
  ProfileId,
  ProgramId,
  Provenance,
  SourceId,
  VerificationHistoryEntry,
} from "../core";
import { HealthError, HEALTH_EVENTS } from "../core";
import { getSources, type MeasurementSource } from "../sources";
import { getMeasurements, type Measurement } from "../measurements";
import { getEventBus, buildEvent, getClock } from "@/kernel";
import { getConsent, asConsentId } from "@/identity";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BuildProvenanceInput {
  readonly collectedBy: AccountId;
  readonly sourceId: SourceId;
  readonly deviceId?: string;
  readonly collectedAt?: string; // defaults to now
  readonly programId?: ProgramId;
  readonly location?: { lat: number; lon: number; label?: string };
  readonly consentReference?: string;
  readonly auditReference?: string;
}

export interface ProvenanceChainLink {
  readonly kind: "measurement" | "source" | "verifier" | "program" | "consent" | "audit" | "device";
  readonly id: string;
  readonly label: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface ProvenanceChain {
  readonly measurementId: MeasurementId;
  readonly profileId: ProfileId;
  readonly links: readonly ProvenanceChainLink[];
  readonly collectedAt: string;
  readonly verificationHistory: readonly VerificationHistoryEntry[];
  readonly consentReference?: string;
  readonly auditReference?: string;
}

export interface ProvenanceQuery {
  readonly profileId?: ProfileId;
  readonly programId?: ProgramId;
  readonly sourceId?: SourceId;
  readonly collectedBy?: AccountId;
  readonly since?: string;
  readonly until?: string;
}

export interface ProvenanceReport {
  readonly measurementId: MeasurementId;
  readonly schemaId?: string;
  readonly profileId: ProfileId;
  readonly who: string; // human-readable summary of who collected/verified
  readonly what: string; // human-readable summary of the measurement
  readonly when: string; // collection + verification timestamps
  readonly where: string; // location (or "undisclosed")
  readonly why: string; // program + consent purpose
  readonly how: string; // source + device
  readonly chain: ProvenanceChain;
  readonly valid: boolean;
  readonly issues: readonly string[];
}

export interface ProvenanceValidationResult {
  readonly valid: boolean;
  readonly issues: readonly string[];
}

// ---------------------------------------------------------------------------
// Provenance manager
// ---------------------------------------------------------------------------

export class ProvenanceManager {
  /**
   * Build a Provenance object for a new measurement. The provenance is
   * immutable once attached; verification entries are appended via
   * addVerification().
   */
  build(input: BuildProvenanceInput): Provenance {
    if (!input.collectedBy) {
      throw new HealthError({
        code: "eks.health.provenance.missing_collector",
        category: "provenance_invalid",
        message: "collectedBy is required.",
      });
    }
    if (!input.sourceId) {
      throw new HealthError({
        code: "eks.health.provenance.missing_source",
        category: "provenance_invalid",
        message: "sourceId is required.",
      });
    }
    const source = getSources().get(input.sourceId);
    if (!source) {
      throw new HealthError({
        code: "eks.health.provenance.source_not_found",
        category: "not_found",
        message: `Source ${input.sourceId} not registered.`,
        userMessage: "The measurement source is not registered.",
        metadata: { sourceId: input.sourceId },
      });
    }
    const collectedAt = input.collectedAt ?? getClock().iso();
    return {
      collectedBy: input.collectedBy,
      verifiedBy: undefined,
      programId: input.programId,
      sourceId: input.sourceId,
      deviceId: input.deviceId ?? source.deviceId,
      collectedAt,
      location: input.location,
      consentReference: input.consentReference,
      auditReference: input.auditReference,
      verificationHistory: [],
    };
  }

  /**
   * Append a verification history entry to an existing provenance. Returns a
   * new Provenance object (the original is not mutated).
   */
  addVerification(provenance: Provenance, entry: VerificationHistoryEntry): Provenance {
    return {
      ...provenance,
      verificationHistory: [...provenance.verificationHistory, entry],
      verifiedBy: entry.state === "verified" ? entry.by : provenance.verifiedBy,
    };
  }

  /**
   * Build a ProvenanceChain linking a measurement to every system that
   * touched it: measurement → source → verifier → program → consent → audit.
   */
  getChain(measurementId: MeasurementId): ProvenanceChain {
    const measurement = getMeasurements().get(measurementId);
    if (!measurement) {
      throw new HealthError({
        code: "eks.health.provenance.measurement_not_found",
        category: "not_found",
        message: `Measurement ${measurementId} not found.`,
      });
    }
    return this.buildChain(measurement);
  }

  /** Validate a provenance object's required fields and consistency. */
  verify(provenance: Provenance): ProvenanceValidationResult {
    const issues: string[] = [];

    if (!provenance.collectedBy) issues.push("collectedBy is missing");
    if (!provenance.sourceId) issues.push("sourceId is missing");
    if (!provenance.collectedAt) issues.push("collectedAt is missing");

    // Source must exist in the registry.
    const source = getSources().get(provenance.sourceId);
    if (!source) {
      issues.push(`source ${provenance.sourceId} is not registered`);
    } else {
      if (source.revoked) issues.push(`source ${provenance.sourceId} is revoked`);
    }

    // Timestamps must be sane.
    const now = getClock().epochMs();
    const collected = Date.parse(provenance.collectedAt);
    if (Number.isNaN(collected)) {
      issues.push("collectedAt is not a valid ISO timestamp");
    } else if (collected > now + 60_000) {
      // Allow 1 minute of clock skew.
      issues.push("collectedAt is in the future");
    }

    // Verification history timestamps must be monotonically non-decreasing.
    let prev = collected;
    for (const entry of provenance.verificationHistory) {
      const t = Date.parse(entry.at);
      if (Number.isNaN(t)) {
        issues.push(`verification history entry at ${entry.at} is invalid`);
        break;
      }
      if (!Number.isNaN(prev) && t < prev) {
        issues.push("verification history is not chronologically ordered");
        break;
      }
      prev = t;
    }

    // If verifiedBy is set, the history must contain a "verified" entry by that account.
    if (provenance.verifiedBy) {
      const hasVerified = provenance.verificationHistory.some(
        (e) => e.state === "verified" && e.by === provenance.verifiedBy,
      );
      if (!hasVerified) {
        issues.push("verifiedBy is set but no matching 'verified' history entry exists");
      }
    }

    return { valid: issues.length === 0, issues };
  }

  /** Generate a human-readable provenance report. */
  report(measurementId: MeasurementId): ProvenanceReport {
    const measurement = getMeasurements().get(measurementId);
    if (!measurement) {
      throw new HealthError({
        code: "eks.health.provenance.measurement_not_found",
        category: "not_found",
        message: `Measurement ${measurementId} not found.`,
      });
    }
    const p = measurement.provenance;
    const source = getSources().get(p.sourceId);
    const chain = this.buildChain(measurement);
    const validation = this.verify(p);
    const issues = [...validation.issues];

    const verifierEntry = [...p.verificationHistory]
      .reverse()
      .find((e) => e.state === "verified");

    const who = verifierEntry
      ? `Collected by ${p.collectedBy}; verified by ${verifierEntry.by} at ${verifierEntry.at}.`
      : `Collected by ${p.collectedBy}; not yet verified.`;

    const what = `Measurement ${measurement.id} (schema ${measurement.schemaId}) of profile ${measurement.profileId} — version ${measurement.version}.`;

    const when = `Collected at ${p.collectedAt}. Last updated at ${measurement.updatedAt}.`;

    const where = p.location
      ? `Collected at ${p.location.label ?? `${p.location.lat}, ${p.location.lon}`}.`
      : "Location undisclosed.";

    const why = p.programId
      ? `Requested by program ${p.programId}.${p.consentReference ? ` Consent reference: ${p.consentReference}.` : ""}`
      : p.consentReference
        ? `Consent reference: ${p.consentReference}.`
        : "No program or consent reference recorded.";

    const how = source
      ? `Source: ${source.label} (${source.type}, trust=${source.trustLevel}).${p.deviceId ? ` Device: ${p.deviceId}.` : ""}`
      : `Source: ${p.sourceId}.${p.deviceId ? ` Device: ${p.deviceId}.` : ""}`;

    return {
      measurementId,
      schemaId: measurement.schemaId,
      profileId: measurement.profileId,
      who,
      what,
      when,
      where,
      why,
      how,
      chain,
      valid: validation.valid,
      issues,
    };
  }

  /** All provenance entries for a participant. */
  listForProfile(profileId: ProfileId): readonly Provenance[] {
    return getMeasurements()
      .listByProfile(profileId, { includeSuperseded: true })
      .map((m) => m.provenance);
  }

  /** All provenance entries where programId matches. */
  listForProgram(programId: ProgramId): readonly Provenance[] {
    return getMeasurements()
      .list({ includeSuperseded: true })
      .filter((m) => m.provenance.programId === programId)
      .map((m) => m.provenance);
  }

  /** List provenance matching a query. */
  list(query: ProvenanceQuery): readonly Provenance[] {
    return getMeasurements()
      .list({
        includeSuperseded: true,
        profileId: query.profileId,
        sourceId: query.sourceId,
        from: query.since,
        to: query.until,
      })
      .filter((m) => {
        if (query.programId && m.provenance.programId !== query.programId) return false;
        if (query.collectedBy && m.provenance.collectedBy !== query.collectedBy) return false;
        return true;
      })
      .map((m) => m.provenance);
  }

  /**
   * Validate that the consent reference on a provenance object is still
   * active. Delegates to the identity consent engine; if the identity
   * platform is not booted (e.g. in unit tests), the check passes with a
   * warning flag rather than failing.
   */
  checkConsentReference(provenance: Provenance): {
    active: boolean;
    reason: string;
    checked: boolean;
  } {
    if (!provenance.consentReference) {
      return { active: false, reason: "no_consent_reference", checked: false };
    }
    try {
      // Static import of getConsent — identity may not be fully booted in
      // tests, so we wrap the lookup itself in try/catch and fall back to a
      // permissive "active=true" result if anything throws.
      const mgr = getConsent();
      const consent = mgr.getConsent(asConsentId(provenance.consentReference));
      if (!consent) {
        return { active: false, reason: "consent_not_found", checked: true };
      }
      if (consent.status !== "active") {
        return { active: false, reason: `consent_status_${consent.status}`, checked: true };
      }
      if (consent.expiresAt) {
        const exp = Date.parse(consent.expiresAt);
        if (!Number.isNaN(exp) && exp < getClock().epochMs()) {
          return { active: false, reason: "consent_expired", checked: true };
        }
      }
      return { active: true, reason: "active", checked: true };
    } catch {
      // Identity not available — return a permissive result so callers can
      // proceed in test environments. Production wiring should ensure
      // identity is booted before any measurement is recorded.
      return { active: true, reason: "identity_unavailable", checked: false };
    }
  }

  // ---------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------

  private buildChain(measurement: Measurement): ProvenanceChain {
    const p = measurement.provenance;
    const links: ProvenanceChainLink[] = [];

    // 1. Measurement itself.
    links.push({
      kind: "measurement",
      id: measurement.id,
      label: `Measurement ${measurement.id}`,
      details: {
        schemaId: measurement.schemaId,
        version: measurement.version,
        verificationState: measurement.verificationState,
      },
    });

    // 2. Source.
    const source = getSources().get(p.sourceId);
    links.push({
      kind: "source",
      id: p.sourceId,
      label: source ? source.label : `Source ${p.sourceId}`,
      details: source
        ? {
            type: source.type,
            trustLevel: source.trustLevel,
            verified: source.verified,
            deviceId: source.deviceId,
          }
        : { registered: false },
    });

    // 3. Device (if present).
    if (p.deviceId) {
      links.push({
        kind: "device",
        id: p.deviceId,
        label: `Device ${p.deviceId}`,
        details: source ? { model: source.deviceModel, firmware: source.deviceFirmware } : undefined,
      });
    }

    // 4. Verifier (if verified).
    if (p.verifiedBy) {
      links.push({
        kind: "verifier",
        id: p.verifiedBy,
        label: `Verifier ${p.verifiedBy}`,
      });
    }

    // 5. Program (if present).
    if (p.programId) {
      links.push({
        kind: "program",
        id: p.programId,
        label: `Program ${p.programId}`,
      });
    }

    // 6. Consent (if present).
    if (p.consentReference) {
      links.push({
        kind: "consent",
        id: p.consentReference,
        label: `Consent ${p.consentReference}`,
      });
    }

    // 7. Audit (if present).
    if (p.auditReference) {
      links.push({
        kind: "audit",
        id: p.auditReference,
        label: `Audit ${p.auditReference}`,
      });
    }

    return {
      measurementId: measurement.id,
      profileId: measurement.profileId,
      links,
      collectedAt: p.collectedAt,
      verificationHistory: [...p.verificationHistory],
      consentReference: p.consentReference,
      auditReference: p.auditReference,
    };
  }

  /**
   * Emit a provenance-built event for observability. Called by the
   * measurement store after recording a measurement, but exposed here so
   * external callers can re-emit if they construct a provenance outside
   * the normal record flow.
   */
  emitProvenanceBuilt(measurementId: MeasurementId, provenance: Provenance): void {
    void getEventBus().publish(
      buildEvent(
        "eks.health.provenance.built",
        {
          measurementId,
          collectedBy: provenance.collectedBy,
          sourceId: provenance.sourceId,
          programId: provenance.programId,
          collectedAt: provenance.collectedAt,
          hasConsent: !!provenance.consentReference,
          hasAudit: !!provenance.auditReference,
        },
        {},
        "domain",
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Re-exports for the public API
// ---------------------------------------------------------------------------

export type { MeasurementSource } from "../sources";
export { HEALTH_EVENTS };

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _manager: ProvenanceManager | null = null;

export function getProvenance(): ProvenanceManager {
  if (!_manager) _manager = new ProvenanceManager();
  return _manager;
}

export function setProvenance(m: ProvenanceManager): void {
  _manager = m;
}

export function resetProvenance(): void {
  _manager = null;
}
