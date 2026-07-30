/**
 * Eks-Health Universal Health Data Platform — Health Profile Engine
 *
 * A generic participant profile. The Core Platform contains NO
 * disease-specific fields. Profiles contain ONLY generic, privacy-safe
 * attributes: demographics (age RANGE, never birthdate), preferences,
 * devices, programs (installed), consents, organizations, and
 * program-scoped custom attributes. Everything else comes from Programs.
 *
 * Privacy by design:
 *  - Demographics store age RANGE, not birthdate.
 *  - No name, address, or contact info (those live in the identity platform).
 *  - Custom attributes are program-scoped (each attribute records its programId).
 *
 * Capabilities:
 *  - getOrCreate / get / list
 *  - updateDemographics
 *  - setPreference / getPreferences
 *  - registerDevice / listDevices / revokeDevice
 *  - addProgram / removeProgram / listPrograms
 *  - setCustomAttribute / getCustomAttribute / listCustomAttributes
 *  - snapshot (aggregates counts + last measurement date from measurements)
 *  - merge (account consolidation)
 *  - delete (GDPR right to erasure — audited)
 *
 * Emits eks.health.profile.created and eks.health.profile.changed.
 */

import "server-only";
import {
  type ProfileId,
  type MeasurementId,
  type SchemaId,
  type ProgramId,
  HealthError,
  HEALTH_EVENTS,
  asProfileId,
} from "../core";
import type { AccountId } from "@/identity";
import { getEventBus, buildEvent, generateId, getClock } from "@/kernel";

// ---------------------------------------------------------------------------
// Profile types
// ---------------------------------------------------------------------------

export interface HealthProfile {
  readonly id: ProfileId;
  readonly accountId: AccountId;
  demographics: ProfileDemographics;
  preferences: ProfilePreference[];
  devices: ProfileDevice[];
  programs: ProfileProgram[];
  customAttributes: Record<string, ProfileCustomAttribute>;
  readonly createdAt: string;
  updatedAt: string;
  readonly deletedAt?: string;
}

export interface ProfileDemographics {
  ageRange?: string; // e.g. "30-39" — never exact birthdate
  biologicalSex?: "male" | "female" | "intersex" | "unspecified";
  country?: string; // ISO 3166-1 alpha-2
  region?: string;
  timezone?: string; // IANA tz, e.g. "Africa/Lagos"
  locale?: string; // BCP-47, e.g. "en-NG"
}

export interface ProfilePreference {
  key: string;
  value: unknown;
  scope?: "platform" | ProgramId;
  updatedAt: string;
}

export interface ProfileDevice {
  id: string;
  name: string;
  type: string; // e.g. "wearable", "glucometer", "bp_monitor"
  manufacturer?: string;
  model?: string;
  firmware?: string;
  registeredAt: string;
  lastSeenAt?: string;
  revoked?: boolean;
  revokedAt?: string;
  revokedReason?: string;
  metadata?: Record<string, unknown>;
}

export interface ProfileProgram {
  programId: ProgramId;
  installedAt: string;
  status: "active" | "paused" | "uninstalled";
  version?: string;
  configuration?: Record<string, unknown>;
}

export interface ProfileCustomAttribute {
  value: unknown;
  programId?: ProgramId;
  updatedAt: string;
}

export interface ProfileSnapshot {
  readonly accountId: AccountId;
  readonly profileId: ProfileId;
  readonly demographics: ProfileDemographics;
  readonly preferenceCount: number;
  readonly deviceCount: number;
  readonly activeDeviceCount: number;
  readonly programCount: number;
  readonly activeProgramCount: number;
  readonly customAttributeCount: number;
  readonly measurementCount?: number;
  readonly lastMeasurementAt?: string;
  readonly snapshotAt: string;
}

// ---------------------------------------------------------------------------
// Defensive measurements loader (m4-2 ships ../measurements in parallel).
// ---------------------------------------------------------------------------

interface MeasurementLike {
  readonly id: MeasurementId;
  readonly profileId: ProfileId;
  readonly schemaId: SchemaId;
  readonly timestamp: string;
  readonly [k: string]: unknown;
}

interface MeasurementsApi {
  listByProfile(profileId: ProfileId): MeasurementLike[] | Promise<MeasurementLike[]>;
  list(filter?: Record<string, unknown>): MeasurementLike[] | Promise<MeasurementLike[]>;
}

const MEASUREMENTS_PATH = "../measurements";
let _measurementsCache: MeasurementsApi | null | undefined;

async function loadMeasurements(): Promise<MeasurementsApi | null> {
  if (_measurementsCache !== undefined) return _measurementsCache;
  try {
    const mod = await import(MEASUREMENTS_PATH);
    const getter = (mod as { getMeasurements?: () => MeasurementsApi }).getMeasurements;
    _measurementsCache = getter ? getter() : null;
  } catch {
    _measurementsCache = null;
  }
  return _measurementsCache;
}

async function resolveArray<T>(v: T[] | Promise<T[]> | undefined | null): Promise<T[]> {
  if (v == null) return [];
  if (Array.isArray(v)) return v;
  return await v;
}

// ---------------------------------------------------------------------------
// Profile manager
// ---------------------------------------------------------------------------

export class ProfileManager {
  private readonly profiles = new Map<AccountId, HealthProfile>();
  private readonly byProfileId = new Map<ProfileId, AccountId>();

  /** Returns the participant's health profile, creating one if needed. */
  getOrCreate(accountId: AccountId): HealthProfile {
    let p = this.profiles.get(accountId);
    if (!p) {
      const now = getClock().iso();
      p = {
        id: asProfileId(generateId("prof_")),
        accountId,
        demographics: {},
        preferences: [],
        devices: [],
        programs: [],
        customAttributes: {},
        createdAt: now,
        updatedAt: now,
      };
      this.profiles.set(accountId, p);
      this.byProfileId.set(p.id, accountId);
      void getEventBus().publish(
        buildEvent(
          HEALTH_EVENTS.profileCreated,
          { profileId: p.id, accountId },
          {},
          "domain",
        ),
      );
    }
    return p;
  }

  /** Get a profile by account id. */
  get(accountId: AccountId): HealthProfile | undefined {
    const p = this.profiles.get(accountId);
    if (!p || p.deletedAt) return undefined;
    return p;
  }

  /** Get a profile by its ProfileId. */
  getById(profileId: ProfileId): HealthProfile | undefined {
    const accountId = this.byProfileId.get(profileId);
    if (!accountId) return undefined;
    return this.get(accountId);
  }

  /** List all (non-deleted) profiles. */
  list(): HealthProfile[] {
    return [...this.profiles.values()].filter((p) => !p.deletedAt);
  }

  /** Update demographics. Merges with existing. */
  updateDemographics(accountId: AccountId, demographics: Partial<ProfileDemographics>): HealthProfile {
    const p = this.getOrCreate(accountId);
    const merged: ProfileDemographics = { ...p.demographics, ...demographics };
    const updated: HealthProfile = {
      ...p,
      demographics: merged,
      updatedAt: getClock().iso(),
    };
    this.profiles.set(accountId, updated);
    this.emitChanged(updated, "demographics");
    return updated;
  }

  /** Set a preference value (creates or replaces). */
  setPreference(accountId: AccountId, key: string, value: unknown, scope?: "platform" | ProgramId): HealthProfile {
    const p = this.getOrCreate(accountId);
    const now = getClock().iso();
    const others = p.preferences.filter((x) => x.key !== key || x.scope !== scope);
    const updated: HealthProfile = {
      ...p,
      preferences: [...others, { key, value, scope, updatedAt: now }],
      updatedAt: now,
    };
    this.profiles.set(accountId, updated);
    this.emitChanged(updated, "preference");
    return updated;
  }

  /** Get all preferences for a profile. */
  getPreferences(accountId: AccountId): readonly ProfilePreference[] {
    return this.getOrCreate(accountId).preferences;
  }

  /** Register a device. Returns the device entry. */
  registerDevice(accountId: AccountId, device: Omit<ProfileDevice, "id" | "registeredAt">): ProfileDevice {
    const p = this.getOrCreate(accountId);
    const now = getClock().iso();
    const full: ProfileDevice = {
      ...device,
      id: generateId("dev_"),
      registeredAt: now,
    };
    const updated: HealthProfile = {
      ...p,
      devices: [...p.devices, full],
      updatedAt: now,
    };
    this.profiles.set(accountId, updated);
    this.emitChanged(updated, "device");
    return full;
  }

  /** List devices (optionally excluding revoked). */
  listDevices(accountId: AccountId, includeRevoked = false): readonly ProfileDevice[] {
    const devices = this.getOrCreate(accountId).devices;
    return includeRevoked ? devices : devices.filter((d) => !d.revoked);
  }

  /** Revoke a device. */
  revokeDevice(accountId: AccountId, deviceId: string, reason?: string): HealthProfile {
    const p = this.getOrCreate(accountId);
    const now = getClock().iso();
    const devices = p.devices.map((d) =>
      d.id === deviceId
        ? { ...d, revoked: true, revokedAt: now, revokedReason: reason }
        : d,
    );
    const updated: HealthProfile = { ...p, devices, updatedAt: now };
    this.profiles.set(accountId, updated);
    this.emitChanged(updated, "device_revoked");
    return updated;
  }

  /** Install a program on the profile. */
  addProgram(accountId: AccountId, programId: ProgramId, opts?: { version?: string; configuration?: Record<string, unknown> }): HealthProfile {
    const p = this.getOrCreate(accountId);
    const now = getClock().iso();
    const others = p.programs.filter((x) => x.programId !== programId);
    const entry: ProfileProgram = {
      programId,
      installedAt: now,
      status: "active",
      version: opts?.version,
      configuration: opts?.configuration,
    };
    const updated: HealthProfile = {
      ...p,
      programs: [...others, entry],
      updatedAt: now,
    };
    this.profiles.set(accountId, updated);
    this.emitChanged(updated, "program_added");
    return updated;
  }

  /** Remove (uninstall) a program from the profile. */
  removeProgram(accountId: AccountId, programId: ProgramId): HealthProfile {
    const p = this.getOrCreate(accountId);
    const now = getClock().iso();
    const programs = p.programs.map((x) =>
      x.programId === programId ? { ...x, status: "uninstalled" as const } : x,
    );
    const updated: HealthProfile = { ...p, programs, updatedAt: now };
    this.profiles.set(accountId, updated);
    this.emitChanged(updated, "program_removed");
    return updated;
  }

  /** List installed programs (optionally active-only). */
  listPrograms(accountId: AccountId, activeOnly = false): readonly ProfileProgram[] {
    const programs = this.getOrCreate(accountId).programs;
    return activeOnly ? programs.filter((x) => x.status === "active") : programs;
  }

  /**
   * Set a program-scoped custom attribute. Programs store arbitrary profile
   * data here (e.g. "fitness_level": "intermediate"). The key is namespaced
   * by the caller (typically `${programId}:${attr}`) and the programId is
   * recorded for scoping.
   */
  setCustomAttribute(accountId: AccountId, key: string, value: unknown, programId?: ProgramId): HealthProfile {
    if (!key || !/^[a-zA-Z0-9_:.\-]+$/.test(key)) {
      throw new HealthError({
        code: "eks.health.profile.bad_attribute_key",
        category: "schema_invalid",
        message: `Custom attribute key '${key}' is invalid.`,
      });
    }
    const p = this.getOrCreate(accountId);
    const now = getClock().iso();
    const attrs: Record<string, ProfileCustomAttribute> = { ...p.customAttributes };
    attrs[key] = { value, programId, updatedAt: now };
    const updated: HealthProfile = { ...p, customAttributes: attrs, updatedAt: now };
    this.profiles.set(accountId, updated);
    this.emitChanged(updated, "custom_attribute");
    return updated;
  }

  /** Get a single custom attribute. */
  getCustomAttribute(accountId: AccountId, key: string): ProfileCustomAttribute | undefined {
    return this.getOrCreate(accountId).customAttributes[key];
  }

  /** List custom attributes, optionally filtered by key prefix. */
  listCustomAttributes(accountId: AccountId, prefix?: string): ReadonlyArray<{ key: string; attr: ProfileCustomAttribute }> {
    const attrs = this.getOrCreate(accountId).customAttributes;
    const entries = Object.entries(attrs);
    const filtered = prefix ? entries.filter(([k]) => k.startsWith(prefix)) : entries;
    return filtered.map(([key, attr]) => ({ key, attr }));
  }

  /**
   * Snapshot: demographics + counts + measurement count + last measurement date.
   * Async because it pulls measurement stats from the measurements subsystem.
   */
  async snapshot(accountId: AccountId): Promise<ProfileSnapshot> {
    const p = this.getOrCreate(accountId);
    let measurementCount: number | undefined;
    let lastMeasurementAt: string | undefined;
    const api = await loadMeasurements();
    if (api) {
      try {
        const list = await resolveArray(api.listByProfile(p.id));
        measurementCount = list.length;
        if (list.length > 0) {
          const latest = list.reduce((b, m) => !b || Date.parse(m.timestamp) > Date.parse(b.timestamp) ? m : b);
          lastMeasurementAt = latest.timestamp;
        }
      } catch {
        // Best-effort; measurement stats simply omitted.
      }
    }
    return {
      accountId,
      profileId: p.id,
      demographics: p.demographics,
      preferenceCount: p.preferences.length,
      deviceCount: p.devices.length,
      activeDeviceCount: p.devices.filter((d) => !d.revoked).length,
      programCount: p.programs.length,
      activeProgramCount: p.programs.filter((x) => x.status === "active").length,
      customAttributeCount: Object.keys(p.customAttributes).length,
      measurementCount,
      lastMeasurementAt,
      snapshotAt: getClock().iso(),
    };
  }

  /**
   * Merge another profile into this one (for account consolidation).
   * Demographics are NOT overwritten if already set; preferences, devices,
   * programs, and custom attributes are unioned (other profile wins on
   * key conflicts). The other profile is marked deleted.
   */
  merge(accountId: AccountId, otherProfile: HealthProfile): HealthProfile {
    const target = this.getOrCreate(accountId);
    const now = getClock().iso();

    // Demographics: only fill in missing fields.
    const demographics: ProfileDemographics = { ...otherProfile.demographics, ...target.demographics };

    // Preferences: union by (key, scope); other wins on conflict.
    const prefMap = new Map<string, ProfilePreference>();
    for (const pref of target.preferences) prefMap.set(`${pref.key}::${pref.scope ?? ""}`, pref);
    for (const pref of otherProfile.preferences) prefMap.set(`${pref.key}::${pref.scope ?? ""}`, pref);

    // Devices: union by id; other wins on conflict.
    const deviceMap = new Map<string, ProfileDevice>();
    for (const d of target.devices) deviceMap.set(d.id, d);
    for (const d of otherProfile.devices) deviceMap.set(d.id, d);

    // Programs: union by programId; other wins on conflict.
    const programMap = new Map<ProgramId, ProfileProgram>();
    for (const pg of target.programs) programMap.set(pg.programId, pg);
    for (const pg of otherProfile.programs) programMap.set(pg.programId, pg);

    // Custom attributes: union by key; other wins on conflict.
    const attrs: Record<string, ProfileCustomAttribute> = { ...target.customAttributes };
    for (const [k, v] of Object.entries(otherProfile.customAttributes)) attrs[k] = v;

    const merged: HealthProfile = {
      ...target,
      demographics,
      preferences: [...prefMap.values()],
      devices: [...deviceMap.values()],
      programs: [...programMap.values()],
      customAttributes: attrs,
      updatedAt: now,
    };
    this.profiles.set(accountId, merged);

    // Mark the other profile deleted (audited).
    if (otherProfile.accountId !== accountId) {
      const other = this.profiles.get(otherProfile.accountId);
      if (other) {
        this.profiles.set(otherProfile.accountId, { ...other, deletedAt: now, updatedAt: now });
      }
    }

    this.emitChanged(merged, "merged");
    return merged;
  }

  /**
   * GDPR right to erasure. Marks the profile as deleted (audited) and
   * cascades the deletion to the participant's measurement timeline via the
   * timeline manager (best-effort — the timeline manager handles its own
   * data). Returns the audited tombstone.
   */
  delete(accountId: AccountId, reason: string): { accountId: AccountId; profileId: ProfileId; deletedAt: string; reason: string } {
    const p = this.profiles.get(accountId);
    if (!p) {
      throw new HealthError({
        code: "eks.health.profile.not_found",
        category: "not_found",
        message: `No profile for account ${accountId}.`,
        userMessage: "Profile not found.",
      });
    }
    const now = getClock().iso();
    const tombstoned: HealthProfile = { ...p, deletedAt: now, updatedAt: now };
    // Demographics, preferences, devices, programs, customAttributes are zeroed.
    tombstoned.demographics = {};
    tombstoned.preferences = [];
    tombstoned.devices = [];
    tombstoned.programs = [];
    tombstoned.customAttributes = {};
    this.profiles.set(accountId, tombstoned);

    void getEventBus().publish(
      buildEvent(
        "eks.health.profile.deleted",
        { profileId: p.id, accountId, reason, deletedAt: now },
        {},
        "domain",
      ),
    );

    return { accountId, profileId: p.id, deletedAt: now, reason };
  }

  // --- internals -----------------------------------------------------------

  private emitChanged(profile: HealthProfile, change: string): void {
    void getEventBus().publish(
      buildEvent(
        HEALTH_EVENTS.profileChanged,
        { profileId: profile.id, accountId: profile.accountId, change },
        {},
        "domain",
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _manager: ProfileManager | null = null;
export function getProfiles(): ProfileManager {
  if (!_manager) _manager = new ProfileManager();
  return _manager;
}
export function resetProfiles(): void {
  _manager = null;
}

export { HEALTH_EVENTS, asProfileId };
export type { ProfileId, AccountId, ProgramId };
