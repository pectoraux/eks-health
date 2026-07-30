/**
 * Eks-Health Identity — Security Monitoring
 *
 * Real anomaly detection across the identity platform:
 *   - impossible travel (REAL haversine distance vs time-delta)
 *   - credential stuffing (burst of failed logins across accounts from one IP)
 *   - abnormal API usage (per-program rate spike)
 *   - permission abuse (repeated denials for the same principal)
 *   - extension/program abuse (call-volume anomaly)
 *   - data exfiltration (per-account per-hour data volume)
 *   - new high-risk device
 *   - repeated MFA failure
 *   - unusual data volume (per-account daily baseline deviation)
 *
 * Confirmed anomalies become SecurityIncidents. Risk scores aggregate per
 * account from recent anomalies. Security notifications dispatch via the
 * kernel notification service.
 *
 * No external deps beyond node:crypto.
 */

import "server-only";
import { createHash } from "node:crypto";
import {
  type AccountId,
  type IncidentId,
  type Principal,
  type Persona,
  IdentityError,
  IDENTITY_EVENTS,
  asIncidentId,
} from "../core";
import { getEventBus, buildEvent, generateId, getClock } from "@/kernel";
import type { Brand } from "@/kernel";

// ---------------------------------------------------------------------------
// Branded ids
// ---------------------------------------------------------------------------

export type AnomalyId = Brand<string, "AnomalyId">;
export type SecurityNotificationId = Brand<string, "SecurityNotificationId">;

function asAnomalyId(s: string): AnomalyId { return s as AnomalyId; }
function asSecurityNotificationId(s: string): SecurityNotificationId { return s as SecurityNotificationId; }

// ---------------------------------------------------------------------------
// Severity & status
// ---------------------------------------------------------------------------

export type IncidentSeverity = "low" | "medium" | "high" | "critical";
export type IncidentStatus = "open" | "investigating" | "contained" | "resolved" | "false_positive";

// ---------------------------------------------------------------------------
// Geo + haversine (REAL great-circle distance)
// ---------------------------------------------------------------------------

export interface GeoPoint {
  readonly lat: number;
  readonly lng: number;
}

const EARTH_RADIUS_KM = 6371;

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/**
 * Compute the great-circle distance between two lat/lng points using the
 * haversine formula. Returns kilometers.
 */
export function haversineKm(a: GeoPoint, b: GeoPoint): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

// ---------------------------------------------------------------------------
// Anomaly + incident types
// ---------------------------------------------------------------------------

export type AnomalyType =
  | "impossible_travel"
  | "credential_stuffing"
  | "abnormal_api_usage"
  | "permission_abuse"
  | "extension_abuse"
  | "data_exfiltration"
  | "new_device_high_risk"
  | "repeated_mfa_failure"
  | "unusual_data_volume";

export interface Anomaly {
  readonly id: AnomalyId;
  readonly type: AnomalyType;
  readonly severity: IncidentSeverity;
  readonly detectedAt: string;
  readonly accountId?: AccountId;
  readonly principalId?: string;
  readonly programId?: string;
  readonly ip?: string;
  readonly country?: string;
  readonly description: string;
  readonly evidence: Record<string, unknown>;
  readonly incidentId?: IncidentId;
}

export interface SecurityIncident {
  readonly id: IncidentId;
  readonly title: string;
  readonly description: string;
  readonly severity: IncidentSeverity;
  readonly status: IncidentStatus;
  readonly type: AnomalyType | "composite";
  readonly openedAt: string;
  readonly updatedAt: string;
  readonly acknowledgedBy?: string;
  readonly acknowledgedAt?: string;
  readonly resolvedBy?: string;
  readonly resolvedAt?: string;
  readonly resolution?: string;
  readonly relatedAnomalies: AnomalyId[];
  readonly affectedAccounts: AccountId[];
  readonly affectedPrograms: string[];
  readonly metadata?: Record<string, unknown>;
}

export interface BehavioralBaseline {
  readonly accountId: AccountId;
  readonly typicalCountries: string[];
  readonly typicalIpPrefixes: string[]; // /24 prefixes
  readonly typicalDeviceIds: string[];
  readonly avgApiCallsPerMinute: number;
  readonly avgDataVolumeMbPerHour: number;
  readonly typicalActiveHours: [number, number]; // hour-of-day range
  readonly updatedAt: string;
}

export interface SecurityNotification {
  readonly id: SecurityNotificationId;
  readonly accountId: AccountId;
  readonly type: AnomalyType | "incident" | "security_alert";
  readonly title: string;
  readonly message: string;
  readonly severity: IncidentSeverity;
  readonly createdAt: string;
  readonly read: boolean;
  readonly deliveredVia: ("in_app" | "email" | "sms" | "push")[];
  readonly incidentId?: IncidentId;
  readonly payload?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Event inputs
// ---------------------------------------------------------------------------

export interface AuthAttemptEvent {
  readonly accountId: AccountId;
  readonly principalId?: string;
  readonly timestamp?: string;
  readonly ip: string;
  readonly country?: string;
  readonly location?: GeoPoint;
  readonly userAgent?: string;
  readonly deviceId?: string;
  readonly deviceTrusted?: boolean;
  readonly success: boolean;
  readonly mfaUsed?: boolean;
  readonly mfaSuccess?: boolean;
  readonly persona?: Persona;
}

export interface ApiCallEvent {
  readonly principal?: Principal;
  readonly accountId?: AccountId;
  readonly programId: string;
  readonly timestamp?: string;
  readonly ip?: string;
  readonly endpoint: string;
  readonly latencyMs?: number;
  readonly status: number;
}

export interface DataAccessEvent {
  readonly principal?: Principal;
  readonly accountId?: AccountId;
  readonly programId: string;
  readonly timestamp?: string;
  readonly fields: string[];
  readonly bytes: number;
  readonly deniedFields?: string[];
}

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

export const ANOMALY_THRESHOLDS = {
  impossible_travel_speed_kmh: 900,
  impossible_travel_min_distance_km: 200,
  credential_stuffing_burst: 10,
  credential_stuffing_window_min: 5,
  api_calls_per_min: 600,
  api_calls_per_min_per_program: 300,
  data_volume_mb_per_hour: 500,
  data_volume_mb_per_hour_per_account: 200,
  mfa_failures: 5,
  mfa_failures_window_min: 15,
  new_device_risk_contribution: 50,
  permission_denial_threshold: 5,
  permission_denial_window_min: 10,
  unusual_data_volume_baseline_deviation: 3, // 3x baseline
  event_ring_buffer_cap: 10_000,
} as const;

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export const MONITORING_EVENTS = {
  incidentCreated: IDENTITY_EVENTS.incidentCreated, // "eks.identity.security.incident_created"
  anomalyDetected: "eks.identity.security.anomaly_detected",
  notificationSent: "eks.identity.security.notification_sent",
} as const;

// ---------------------------------------------------------------------------
// Risk scoring
// ---------------------------------------------------------------------------

const SEVERITY_WEIGHT: Record<IncidentSeverity, number> = {
  low: 10,
  medium: 25,
  high: 50,
  critical: 80,
};

const RISK_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

// ---------------------------------------------------------------------------
// Security monitor
// ---------------------------------------------------------------------------

export class SecurityMonitor {
  private readonly authEvents: AuthAttemptEvent[] = [];
  private readonly apiEvents: ApiCallEvent[] = [];
  private readonly dataEvents: DataAccessEvent[] = [];
  private readonly incidents = new Map<IncidentId, SecurityIncident>();
  private readonly anomalies: Anomaly[] = [];
  private readonly notifications = new Map<AccountId, SecurityNotification[]>();
  private readonly baselines = new Map<AccountId, BehavioralBaseline>();
  private readonly lastLocation = new Map<AccountId, { lat: number; lng: number; at: number; ip: string }>();
  private readonly mfaFailures = new Map<AccountId, { count: number; firstAt: number }>();
  private readonly permissionDenials = new Map<string, { count: number; firstAt: number }>();
  private readonly programApiBuckets = new Map<string, Map<number, number>>(); // programId -> minute -> count
  private readonly accountDataBuckets = new Map<AccountId, Map<number, number>>(); // accountId -> hour -> bytes

  /**
   * Record an authentication attempt. Feeds impossible-travel, credential-
   * stuffing, MFA-failure, and new-device detection.
   */
  recordAuthAttempt(event: AuthAttemptEvent): void {
    this.pushCapped(this.authEvents, event);
    const ts = event.timestamp ? new Date(event.timestamp).getTime() : Date.now();

    // Impossible-travel: same account, distant location, fast re-auth.
    if (event.location && event.success) {
      const prev = this.lastLocation.get(event.accountId);
      if (prev) {
        const distanceKm = haversineKm(prev, event.location);
        const dtHours = Math.max(0.001, (ts - prev.at) / (1000 * 60 * 60));
        const speedKmh = distanceKm / dtHours;
        if (
          distanceKm >= ANOMALY_THRESHOLDS.impossible_travel_min_distance_km &&
          speedKmh > ANOMALY_THRESHOLDS.impossible_travel_speed_kmh
        ) {
          this.recordAnomaly({
            type: "impossible_travel",
            severity: "critical",
            accountId: event.accountId,
            principalId: event.principalId,
            ip: event.ip,
            country: event.country,
            description: `Impossible travel: ${distanceKm.toFixed(0)} km in ${(dtHours * 60).toFixed(1)} min (${speedKmh.toFixed(0)} km/h).`,
            evidence: {
              from: { lat: prev.lat, lng: prev.lng, ip: prev.ip, at: new Date(prev.at).toISOString() },
              to: { lat: event.location.lat, lng: event.location.lng, ip: event.ip, at: new Date(ts).toISOString() },
              distanceKm,
              speedKmh,
            },
          });
        }
      }
      this.lastLocation.set(event.accountId, {
        lat: event.location.lat,
        lng: event.location.lng,
        at: ts,
        ip: event.ip,
      });
    }

    // Credential stuffing: N failed logins from different accounts from the same IP
    if (!event.success) {
      const windowMs = ANOMALY_THRESHOLDS.credential_stuffing_window_min * 60 * 1000;
      const recent = this.authEvents.filter(
        (e) =>
          !e.success &&
          e.ip === event.ip &&
          new Date(e.timestamp ?? getClock().iso()).getTime() > ts - windowMs,
      );
      const uniqueAccounts = new Set(recent.map((e) => e.accountId));
      if (uniqueAccounts.size >= ANOMALY_THRESHOLDS.credential_stuffing_burst) {
        this.recordAnomaly({
          type: "credential_stuffing",
          severity: "high",
          ip: event.ip,
          country: event.country,
          description: `Credential stuffing: ${uniqueAccounts.size} distinct accounts failed from ${event.ip} in ${ANOMALY_THRESHOLDS.credential_stuffing_window_min} min.`,
          evidence: {
            ip: event.ip,
            accounts: [...uniqueAccounts],
            attempts: recent.length,
            windowMinutes: ANOMALY_THRESHOLDS.credential_stuffing_window_min,
          },
        });
      }
    }

    // MFA failures per account
    if (event.mfaUsed && event.mfaSuccess === false) {
      const windowMs = ANOMALY_THRESHOLDS.mfa_failures_window_min * 60 * 1000;
      const cur = this.mfaFailures.get(event.accountId);
      if (!cur || ts - cur.firstAt > windowMs) {
        this.mfaFailures.set(event.accountId, { count: 1, firstAt: ts });
      } else {
        this.mfaFailures.set(event.accountId, { count: cur.count + 1, firstAt: cur.firstAt });
      }
      const updated = this.mfaFailures.get(event.accountId)!;
      if (updated.count >= ANOMALY_THRESHOLDS.mfa_failures) {
        this.recordAnomaly({
          type: "repeated_mfa_failure",
          severity: "high",
          accountId: event.accountId,
          principalId: event.principalId,
          ip: event.ip,
          description: `Repeated MFA failure: ${updated.count} failures in ${ANOMALY_THRESHOLDS.mfa_failures_window_min} min.`,
          evidence: { count: updated.count, windowMinutes: ANOMALY_THRESHOLDS.mfa_failures_window_min },
        });
      }
    }

    // New device high risk
    if (event.deviceId && event.deviceTrusted === false && event.success) {
      this.recordAnomaly({
        type: "new_device_high_risk",
        severity: "medium",
        accountId: event.accountId,
        principalId: event.principalId,
        ip: event.ip,
        country: event.country,
        description: `Sign-in from new untrusted device ${event.deviceId}.`,
        evidence: { deviceId: event.deviceId, ip: event.ip },
      });
    }
  }

  /** Record an API call. Feeds abnormal-usage detection. */
  recordApiCall(event: ApiCallEvent): void {
    this.pushCapped(this.apiEvents, event);
    const ts = event.timestamp ? new Date(event.timestamp).getTime() : Date.now();
    const minute = Math.floor(ts / 60_000);
    const buckets = this.programApiBuckets.get(event.programId) ?? new Map<number, number>();
    buckets.set(minute, (buckets.get(minute) ?? 0) + 1);
    this.programApiBuckets.set(event.programId, buckets);

    // Per-minute per-program spike
    const count = buckets.get(minute) ?? 0;
    if (count === ANOMALY_THRESHOLDS.api_calls_per_min_per_program) {
      // fire once when threshold first crossed this minute
      this.recordAnomaly({
        type: "abnormal_api_usage",
        severity: "high",
        programId: event.programId,
        accountId: event.accountId,
        ip: event.ip,
        description: `Program ${event.programId} exceeded ${ANOMALY_THRESHOLDS.api_calls_per_min_per_program} calls/min.`,
        evidence: { programId: event.programId, callsThisMinute: count, minute: new Date(minute * 60_000).toISOString() },
      });
    } else if (count === ANOMALY_THRESHOLDS.api_calls_per_min) {
      this.recordAnomaly({
        type: "abnormal_api_usage",
        severity: "critical",
        programId: event.programId,
        accountId: event.accountId,
        ip: event.ip,
        description: `Platform-wide API spike: ${count} calls/min from program ${event.programId}.`,
        evidence: { programId: event.programId, callsThisMinute: count },
      });
    }
  }

  /** Record a data access. Feeds exfiltration + unusual-volume detection. */
  recordDataAccess(event: DataAccessEvent): void {
    this.pushCapped(this.dataEvents, event);
    const ts = event.timestamp ? new Date(event.timestamp).getTime() : Date.now();
    const hour = Math.floor(ts / (60 * 60 * 1000));
    if (event.accountId) {
      const buckets = this.accountDataBuckets.get(event.accountId) ?? new Map<number, number>();
      buckets.set(hour, (buckets.get(hour) ?? 0) + event.bytes);
      this.accountDataBuckets.set(event.accountId, buckets);
      const totalMb = (buckets.get(hour) ?? 0) / (1024 * 1024);
      // Per-account hourly threshold
      if (totalMb >= ANOMALY_THRESHOLDS.data_volume_mb_per_hour_per_account && event.bytes > 0) {
        // fire once when threshold first crossed this hour for this account
        const justCrossed = totalMb - event.bytes / (1024 * 1024) < ANOMALY_THRESHOLDS.data_volume_mb_per_hour_per_account;
        if (justCrossed) {
          this.recordAnomaly({
            type: "data_exfiltration",
            severity: "critical",
            accountId: event.accountId,
            programId: event.programId,
            description: `Account ${event.accountId} downloaded ${totalMb.toFixed(0)} MB in the last hour.`,
            evidence: { accountId: event.accountId, mbThisHour: totalMb, programId: event.programId },
          });
        }
      }
      // Baseline deviation
      const baseline = this.baselines.get(event.accountId);
      if (baseline && baseline.avgDataVolumeMbPerHour > 0) {
        if (totalMb >= baseline.avgDataVolumeMbPerHour * ANOMALY_THRESHOLDS.unusual_data_volume_baseline_deviation) {
          this.recordAnomaly({
            type: "unusual_data_volume",
            severity: "medium",
            accountId: event.accountId,
            programId: event.programId,
            description: `Account ${event.accountId} data volume ${totalMb.toFixed(0)} MB/hr is ${ANOMALY_THRESHOLDS.unusual_data_volume_baseline_deviation}x baseline (${baseline.avgDataVolumeMbPerHour} MB/hr).`,
            evidence: { mbThisHour: totalMb, baselineMbPerHour: baseline.avgDataVolumeMbPerHour },
          });
        }
      }
    }
    // Per-platform threshold
    if (event.bytes > 0) {
      const platformTotal = [...this.accountDataBuckets.values()].reduce(
        (sum, buckets) => sum + (buckets.get(hour) ?? 0),
        0,
      ) / (1024 * 1024);
      if (platformTotal >= ANOMALY_THRESHOLDS.data_volume_mb_per_hour) {
        // Only fire once per hour per program (avoid spam)
        const key = `${event.programId}:${hour}`;
        if (!this._firedPlatformExfil.has(key)) {
          this._firedPlatformExfil.add(key);
          this.recordAnomaly({
            type: "data_exfiltration",
            severity: "high",
            programId: event.programId,
            description: `Platform data volume ${platformTotal.toFixed(0)} MB in the last hour exceeded the ${ANOMALY_THRESHOLDS.data_volume_mb_per_hour} MB threshold.`,
            evidence: { platformMbThisHour: platformTotal },
          });
        }
      }
    }
  }
  private readonly _firedPlatformExfil = new Set<string>();

  /** Record permission abuse: caller denies a permission for a principal. */
  recordPermissionDenial(opts: {
    readonly principalId: string;
    readonly permission: string;
    readonly accountId?: AccountId;
    readonly timestamp?: string;
  }): void {
    const ts = opts.timestamp ? new Date(opts.timestamp).getTime() : Date.now();
    const key = `${opts.principalId}:${opts.permission}`;
    const windowMs = ANOMALY_THRESHOLDS.permission_denial_window_min * 60 * 1000;
    const cur = this.permissionDenials.get(key);
    if (!cur || ts - cur.firstAt > windowMs) {
      this.permissionDenials.set(key, { count: 1, firstAt: ts });
    } else {
      this.permissionDenials.set(key, { count: cur.count + 1, firstAt: cur.firstAt });
    }
    const updated = this.permissionDenials.get(key)!;
    if (updated.count >= ANOMALY_THRESHOLDS.permission_denial_threshold) {
      this.recordAnomaly({
        type: "permission_abuse",
        severity: "medium",
        principalId: opts.principalId,
        accountId: opts.accountId,
        description: `Principal ${opts.principalId} denied permission ${opts.permission} ${updated.count} times in ${ANOMALY_THRESHOLDS.permission_denial_window_min} min.`,
        evidence: { principalId: opts.principalId, permission: opts.permission, count: updated.count },
      });
    }
  }

  /** Core: record an anomaly. */
  private recordAnomaly(input: Omit<Anomaly, "id" | "detectedAt" | "incidentId">): Anomaly {
    const anomaly: Anomaly = {
      id: asAnomalyId(generateId("anm_")),
      detectedAt: getClock().iso(),
      ...input,
    };
    this.anomalies.push(anomaly);
    void getEventBus().publish(
      buildEvent(
        MONITORING_EVENTS.anomalyDetected,
        {
          anomalyId: anomaly.id,
          type: anomaly.type,
          severity: anomaly.severity,
          accountId: anomaly.accountId,
          principalId: anomaly.principalId,
          programId: anomaly.programId,
          description: anomaly.description,
        },
        {},
        "domain",
      ),
    );
    return anomaly;
  }

  /**
   * Run all detectors over the recent event window. Creates SecurityIncidents
   * for confirmed anomalies (high/critical severity, or any anomaly with an
   * affected account). Returns the newly-created incidents.
   */
  detect(): SecurityIncident[] {
    const newIncidents: SecurityIncident[] = [];
    const since = Date.now() - RISK_WINDOW_MS;
    const recent = this.anomalies.filter((a) => new Date(a.detectedAt).getTime() >= since && !a.incidentId);
    // Group by (type, accountId|programId) so related anomalies fold into one incident
    const groups = new Map<string, Anomaly[]>();
    for (const a of recent) {
      const key = `${a.type}:${a.accountId ?? a.programId ?? a.principalId ?? "global"}`;
      const list = groups.get(key) ?? [];
      list.push(a);
      groups.set(key, list);
    }
    for (const [, list] of groups) {
      const worst = list.reduce<Anomaly>(
        (acc, a) => (SEVERITY_WEIGHT[a.severity] > SEVERITY_WEIGHT[acc.severity] ? a : acc),
        list[0],
      );
      // Only open incidents for medium+ severity OR any anomaly touching an account
      if (SEVERITY_WEIGHT[worst.severity] < SEVERITY_WEIGHT.medium && !worst.accountId) continue;
      const incident = this.createIncident({
        title: `${worst.type.replace(/_/g, " ")} detected`,
        description: worst.description,
        severity: worst.severity,
        type: worst.type,
        relatedAnomalyIds: list.map((a) => a.id),
        affectedAccounts: [...new Set(list.map((a) => a.accountId).filter((x): x is AccountId => !!x))],
        affectedPrograms: [...new Set(list.map((a) => a.programId).filter((x): x is string => !!x))],
        metadata: { evidence: worst.evidence },
      });
      // Link anomalies back to the incident
      for (const a of list) {
        const idx = this.anomalies.findIndex((x) => x.id === a.id);
        if (idx >= 0) this.anomalies[idx] = { ...this.anomalies[idx], incidentId: incident.id };
      }
      newIncidents.push(incident);
    }
    return newIncidents;
  }

  createIncident(input: {
    readonly title: string;
    readonly description: string;
    readonly severity: IncidentSeverity;
    readonly type: AnomalyType | "composite";
    readonly relatedAnomalyIds?: AnomalyId[];
    readonly affectedAccounts?: AccountId[];
    readonly affectedPrograms?: string[];
    readonly metadata?: Record<string, unknown>;
  }): SecurityIncident {
    const now = getClock().iso();
    const incident: SecurityIncident = {
      id: asIncidentId(generateId("inc_")),
      title: input.title,
      description: input.description,
      severity: input.severity,
      status: "open",
      type: input.type,
      openedAt: now,
      updatedAt: now,
      relatedAnomalies: input.relatedAnomalyIds ?? [],
      affectedAccounts: input.affectedAccounts ?? [],
      affectedPrograms: input.affectedPrograms ?? [],
      metadata: input.metadata,
    };
    this.incidents.set(incident.id, incident);
    void getEventBus().publish(
      buildEvent(
        MONITORING_EVENTS.incidentCreated,
        {
          incidentId: incident.id,
          title: incident.title,
          severity: incident.severity,
          type: incident.type,
          affectedAccounts: incident.affectedAccounts,
          affectedPrograms: incident.affectedPrograms,
        },
        {},
        "domain",
      ),
    );
    // Auto-notify affected accounts
    for (const accountId of incident.affectedAccounts) {
      this.notify(accountId, {
        type: "incident",
        title: `Security incident: ${incident.title}`,
        message: incident.description,
        severity: incident.severity,
        incidentId: incident.id,
        payload: { incidentId: incident.id },
      });
    }
    return incident;
  }

  listIncidents(filter?: {
    readonly status?: IncidentStatus;
    readonly severity?: IncidentSeverity;
    readonly accountId?: AccountId;
    readonly programId?: string;
    readonly since?: string;
  }): SecurityIncident[] {
    let list = [...this.incidents.values()];
    if (filter?.status) list = list.filter((i) => i.status === filter.status);
    if (filter?.severity) list = list.filter((i) => i.severity === filter.severity);
    if (filter?.accountId) list = list.filter((i) => i.affectedAccounts.includes(filter.accountId!));
    if (filter?.programId) list = list.filter((i) => i.affectedPrograms.includes(filter.programId!));
    if (filter?.since) {
      const ms = new Date(filter.since).getTime();
      list = list.filter((i) => new Date(i.openedAt).getTime() >= ms);
    }
    return list.sort((a, b) => b.openedAt.localeCompare(a.openedAt));
  }

  getIncident(id: IncidentId): SecurityIncident | undefined {
    return this.incidents.get(id);
  }

  updateIncident(id: IncidentId, update: Partial<SecurityIncident>): SecurityIncident {
    const existing = this.incidents.get(id);
    if (!existing) {
      throw new IdentityError({
        code: "eks.identity.monitoring.incident_not_found",
        category: "not_found",
        message: `Incident ${id} not found.`,
      });
    }
    const updated: SecurityIncident = {
      ...existing,
      ...update,
      id: existing.id,
      openedAt: existing.openedAt,
      updatedAt: getClock().iso(),
    } as SecurityIncident;
    this.incidents.set(id, updated);
    return updated;
  }

  acknowledgeIncident(id: IncidentId, by: string): SecurityIncident {
    return this.updateIncident(id, {
      status: "investigating",
      acknowledgedBy: by,
      acknowledgedAt: getClock().iso(),
    });
  }

  resolveIncident(id: IncidentId, resolution: string, by?: string): SecurityIncident {
    return this.updateIncident(id, {
      status: "resolved",
      resolution,
      resolvedBy: by,
      resolvedAt: getClock().iso(),
    });
  }

  /** Mark incident as false positive. */
  dismissIncident(id: IncidentId, reason: string, by?: string): SecurityIncident {
    return this.updateIncident(id, {
      status: "false_positive",
      resolution: reason,
      resolvedBy: by,
      resolvedAt: getClock().iso(),
    });
  }

  /**
   * Send a security notification to an account. Delivered via the kernel
   * notification service (in-app + email by default).
   */
  notify(accountId: AccountId, input: {
    readonly type: AnomalyType | "incident" | "security_alert";
    readonly title: string;
    readonly message: string;
    readonly severity: IncidentSeverity;
    readonly incidentId?: IncidentId;
    readonly payload?: Record<string, unknown>;
    readonly deliveredVia?: ("in_app" | "email" | "sms" | "push")[];
  }): SecurityNotification {
    const notification: SecurityNotification = {
      id: asSecurityNotificationId(generateId("secnotif_")),
      accountId,
      type: input.type,
      title: input.title,
      message: input.message,
      severity: input.severity,
      createdAt: getClock().iso(),
      read: false,
      deliveredVia: input.deliveredVia ?? ["in_app", "email"],
      incidentId: input.incidentId,
      payload: input.payload,
    };
    const list = this.notifications.get(accountId) ?? [];
    list.push(notification);
    this.notifications.set(accountId, list);
    void getEventBus().publish(
      buildEvent(
        MONITORING_EVENTS.notificationSent,
        {
          notificationId: notification.id,
          accountId,
          type: notification.type,
          severity: notification.severity,
          title: notification.title,
          deliveredVia: notification.deliveredVia,
        },
        {},
        "domain",
      ),
    );
    return notification;
  }

  listNotifications(accountId: AccountId, includeRead = true): SecurityNotification[] {
    const list = this.notifications.get(accountId) ?? [];
    return (includeRead ? list : list.filter((n) => !n.read)).sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
  }

  markNotificationRead(id: SecurityNotificationId): void {
    for (const list of this.notifications.values()) {
      const idx = list.findIndex((n) => n.id === id);
      if (idx >= 0) {
        list[idx] = { ...list[idx], read: true };
        return;
      }
    }
  }

  /**
   * Compute a 0-100 risk score for an account from recent anomalies and
   * incidents. Higher = riskier. Returns the score, level, contributing
   * factors, and recommended action.
   */
  riskScore(accountId: AccountId): {
    readonly score: number;
    readonly level: "low" | "medium" | "high" | "critical";
    readonly factors: { label: string; weight: number; detail?: string }[];
    readonly recommendedAction: "allow" | "challenge" | "deny" | "notify";
  } {
    const since = Date.now() - RISK_WINDOW_MS;
    const anomalies = this.anomalies.filter(
      (a) => a.accountId === accountId && new Date(a.detectedAt).getTime() >= since,
    );
    const incidents = [...this.incidents.values()].filter(
      (i) => i.affectedAccounts.includes(accountId) && i.status !== "resolved" && i.status !== "false_positive",
    );
    let score = 0;
    const factors: { label: string; weight: number; detail?: string }[] = [];
    for (const a of anomalies) {
      const w = SEVERITY_WEIGHT[a.severity];
      score += w;
      factors.push({ label: a.type, weight: w, detail: a.description });
    }
    for (const i of incidents) {
      const w = SEVERITY_WEIGHT[i.severity];
      score += Math.round(w * 0.5); // incidents are partly double-counted with their anomalies
      factors.push({ label: `incident:${i.type}`, weight: Math.round(w * 0.5), detail: i.title });
    }
    score = Math.min(100, score);
    const level: "low" | "medium" | "high" | "critical" =
      score < 25 ? "low" : score < 50 ? "medium" : score < 75 ? "high" : "critical";
    const recommendedAction: "allow" | "challenge" | "deny" | "notify" =
      level === "critical" ? "deny" : level === "high" ? "challenge" : level === "medium" ? "notify" : "allow";
    return { score, level, factors, recommendedAction };
  }

  getBaselines(): BehavioralBaseline[] {
    return [...this.baselines.values()];
  }

  getBaseline(accountId: AccountId): BehavioralBaseline | undefined {
    return this.baselines.get(accountId);
  }

  setBaseline(accountId: AccountId, baseline: Omit<BehavioralBaseline, "accountId" | "updatedAt">): BehavioralBaseline {
    const stamped: BehavioralBaseline = {
      ...baseline,
      accountId,
      updatedAt: getClock().iso(),
    };
    this.baselines.set(accountId, stamped);
    return stamped;
  }

  /** List recent anomalies (newest first). */
  listAnomalies(filter?: {
    readonly type?: AnomalyType;
    readonly accountId?: AccountId;
    readonly since?: string;
    readonly limit?: number;
  }): Anomaly[] {
    let list = [...this.anomalies];
    if (filter?.type) list = list.filter((a) => a.type === filter.type);
    if (filter?.accountId) list = list.filter((a) => a.accountId === filter.accountId);
    if (filter?.since) {
      const ms = new Date(filter.since).getTime();
      list = list.filter((a) => new Date(a.detectedAt).getTime() >= ms);
    }
    list.sort((a, b) => b.detectedAt.localeCompare(a.detectedAt));
    return filter?.limit ? list.slice(0, filter.limit) : list;
  }

  /** Statistics for dashboards. */
  getStats(): {
    readonly totalAnomalies: number;
    readonly totalIncidents: number;
    readonly openIncidents: number;
    readonly bySeverity: Record<IncidentSeverity, number>;
    readonly byType: Partial<Record<AnomalyType, number>>;
  } {
    const bySeverity: Record<IncidentSeverity, number> = { low: 0, medium: 0, high: 0, critical: 0 };
    const byType: Partial<Record<AnomalyType, number>> = {};
    let openIncidents = 0;
    for (const i of this.incidents.values()) {
      bySeverity[i.severity]++;
      if (i.status === "open" || i.status === "investigating") openIncidents++;
    }
    for (const a of this.anomalies) {
      byType[a.type] = (byType[a.type] ?? 0) + 1;
    }
    return {
      totalAnomalies: this.anomalies.length,
      totalIncidents: this.incidents.size,
      openIncidents,
      bySeverity,
      byType,
    };
  }

  private pushCapped<T>(arr: T[], item: T): void {
    arr.push(item);
    const cap = ANOMALY_THRESHOLDS.event_ring_buffer_cap;
    if (arr.length > cap) arr.splice(0, arr.length - cap);
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _monitor: SecurityMonitor | null = null;
export function getMonitoring(): SecurityMonitor {
  if (!_monitor) _monitor = new SecurityMonitor();
  return _monitor;
}
export function setMonitoring(m: SecurityMonitor): void {
  _monitor = m;
}
export function resetMonitoring(): void {
  _monitor = null;
}

/** Stable evidence hash for anomaly de-duplication. */
export function anomalyFingerprint(anomaly: Pick<Anomaly, "type" | "accountId" | "programId" | "ip" | "evidence">): string {
  return createHash("sha256")
    .update(JSON.stringify({ type: anomaly.type, accountId: anomaly.accountId, programId: anomaly.programId, ip: anomaly.ip, evidence: anomaly.evidence }), "utf8")
    .digest("hex")
    .slice(0, 16);
}

export { IdentityError };
