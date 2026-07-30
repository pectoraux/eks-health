/**
 * Eks-Health Universal Health Data Platform — Measurement Sources
 *
 * Multiple trusted sources: health technician, medical device, laboratory,
 * clinic, hospital, wearable, mobile app, manual entry, government registry,
 * research organization, program, import, custom. Programs define which
 * sources are acceptable for their schemas.
 */

import "server-only";
import {
  type SourceId,
  type SourceType,
  type AccountId,
  type OrgId,
  HealthError,
  asSourceId,
} from "../core";
import { getEventBus, buildEvent, generateId, getClock } from "@/kernel";

// ---------------------------------------------------------------------------
// Source definition
// ---------------------------------------------------------------------------

export interface MeasurementSource {
  readonly id: SourceId;
  readonly type: SourceType;
  readonly label: string;
  readonly description?: string;
  readonly trustLevel: SourceTrustLevel;
  readonly verified: boolean;
  readonly verifiedAt?: string;
  readonly verifiedBy?: AccountId;
  readonly orgId?: OrgId;
  readonly deviceId?: string;
  readonly deviceModel?: string;
  readonly deviceFirmware?: string;
  readonly capabilities?: string[]; // e.g. ["blood_pressure", "heart_rate"]
  readonly metadata?: Record<string, unknown>;
  readonly createdAt: string;
  readonly lastUsedAt?: string;
  readonly revoked?: boolean;
  readonly revokedAt?: string;
  readonly revokedReason?: string;
}

export type SourceTrustLevel = "untrusted" | "verified" | "trusted" | "clinical" | "authoritative";

// ---------------------------------------------------------------------------
// Source type catalog
// ---------------------------------------------------------------------------

export const SOURCE_TYPES: readonly { type: SourceType; label: string; defaultTrust: SourceTrustLevel; description: string }[] = [
  { type: "health_technician", label: "Health Technician", defaultTrust: "clinical", description: "A trained clinical staff member collecting measurements manually." },
  { type: "medical_device", label: "Medical Device", defaultTrust: "trusted", description: "A certified medical device (e.g. BP monitor, glucometer)." },
  { type: "laboratory", label: "Laboratory", defaultTrust: "authoritative", description: "A certified laboratory performing tests." },
  { type: "clinic", label: "Clinic", defaultTrust: "clinical", description: "A clinic submitting measurements." },
  { type: "hospital", label: "Hospital", defaultTrust: "clinical", description: "A hospital system submitting measurements." },
  { type: "wearable", label: "Wearable", defaultTrust: "verified", description: "A consumer wearable device (e.g. smartwatch)." },
  { type: "mobile_app", label: "Mobile App", defaultTrust: "verified", description: "A mobile application collecting sensor data." },
  { type: "manual_entry", label: "Manual Entry", defaultTrust: "untrusted", description: "Self-reported by the participant." },
  { type: "government_registry", label: "Government Registry", defaultTrust: "authoritative", description: "A government health registry." },
  { type: "research_organization", label: "Research Organization", defaultTrust: "trusted", description: "A research institution collecting study data." },
  { type: "program", label: "Program", defaultTrust: "verified", description: "A platform Program computing or collecting data." },
  { type: "import", label: "Import", defaultTrust: "untrusted", description: "Bulk-imported from an external system." },
  { type: "custom", label: "Custom", defaultTrust: "untrusted", description: "A custom source type defined by a Program." },
];

const SOURCE_TYPE_INDEX = new Map(SOURCE_TYPES.map((s) => [s.type, s]));

export function getSourceTypeMeta(type: SourceType): { label: string; defaultTrust: SourceTrustLevel; description: string } | undefined {
  return SOURCE_TYPE_INDEX.get(type);
}

// ---------------------------------------------------------------------------
// Source registry
// ---------------------------------------------------------------------------

export class SourceRegistry {
  private readonly sources = new Map<SourceId, MeasurementSource>();
  private readonly byOrg = new Map<OrgId, SourceId[]>();
  private readonly byDevice = new Map<string, SourceId>();

  register(input: Omit<MeasurementSource, "id" | "createdAt">): MeasurementSource {
    if (input.deviceId && this.byDevice.has(input.deviceId)) {
      const existing = this.sources.get(this.byDevice.get(input.deviceId)!)!;
      if (!existing.revoked) return existing;
    }
    const source: MeasurementSource = {
      ...input,
      id: asSourceId(generateId("src_")),
      createdAt: getClock().iso(),
    };
    this.sources.set(source.id, source);
    if (source.deviceId) this.byDevice.set(source.deviceId, source.id);
    if (source.orgId) {
      const list = this.byOrg.get(source.orgId) ?? [];
      this.byOrg.set(source.orgId, [...list, source.id]);
    }
    return source;
  }

  get(id: SourceId): MeasurementSource | undefined {
    return this.sources.get(id);
  }

  list(filter?: { type?: SourceType; orgId?: OrgId; trustLevel?: SourceTrustLevel; verifiedOnly?: boolean }): MeasurementSource[] {
    let list = [...this.sources.values()];
    if (filter?.type) list = list.filter((s) => s.type === filter.type);
    if (filter?.orgId) list = list.filter((s) => s.orgId === filter.orgId);
    if (filter?.trustLevel) list = list.filter((s) => s.trustLevel === filter.trustLevel);
    if (filter?.verifiedOnly) list = list.filter((s) => s.verified);
    return list.filter((s) => !s.revoked);
  }

  verify(id: SourceId, verifiedBy: AccountId): MeasurementSource {
    const source = this.sources.get(id);
    if (!source) throw new HealthError({ code: "eks.health.source.not_found", category: "not_found", message: "Source not found." });
    const updated: MeasurementSource = {
      ...source,
      verified: true,
      verifiedAt: getClock().iso(),
      verifiedBy,
      trustLevel: source.trustLevel === "untrusted" ? "verified" : source.trustLevel,
    };
    this.sources.set(id, updated);
    return updated;
  }

  revoke(id: SourceId, reason: string): void {
    const source = this.sources.get(id);
    if (!source) return;
    this.sources.set(id, { ...source, revoked: true, revokedAt: getClock().iso(), revokedReason: reason });
    if (source.deviceId) this.byDevice.delete(source.deviceId);
  }

  touch(id: SourceId): void {
    const source = this.sources.get(id);
    if (!source) return;
    this.sources.set(id, { ...source, lastUsedAt: getClock().iso() });
  }

  /** Check if a source is acceptable for a schema's allowed sources. */
  isAcceptable(source: MeasurementSource, allowedTypes: SourceType[]): boolean {
    if (source.revoked) return false;
    if (!allowedTypes.includes(source.type)) return false;
    return true;
  }

  listTypes(): readonly typeof SOURCE_TYPES[number][] {
    return SOURCE_TYPES;
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _registry: SourceRegistry | null = null;
export function getSources(): SourceRegistry {
  if (!_registry) _registry = new SourceRegistry();
  return _registry;
}
