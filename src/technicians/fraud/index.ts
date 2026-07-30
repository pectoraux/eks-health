/**
 * Eks-Health Technician Network — Fraud Detection Foundation
 *
 * Infrastructure for fraud detection across the technician network:
 *   1. improbable_improvement — implausibly large measurement change
 *   2. duplicate_evidence      — same evidence hash on multiple measurements
 *   3. device_anomaly          — expired calibration or decertified device
 *   4. location_inconsistency  — technician/participant too far apart
 *   5. frequency_abuse         — too many verifications in a window
 *   6. suspicious_verification_pattern — few distinct participants
 *   7. impossible_travel       — two distant verifications too close in time
 *
 * This milestone ships the framework and basic statistical checks — not
 * advanced AI. Real haversine distance, real mean/stddev for frequency,
 * real duplicate detection via a maintained evidence-hash index.
 */

import "server-only";
import {
  type FraudAlertId,
  type FraudAlertType,
  type FraudAlertSeverity,
  type TechnicianId,
  type AccountId,
  type MeasurementId,
  type SessionId,
  type DeviceId,
  type EvidenceId,
  TechnicianError,
  asFraudAlertId,
} from "../core";
import { getEventBus, buildEvent, generateId, getClock } from "@/kernel";
import { TECHNICIAN_EVENTS } from "../core";
import { type ProfileId, type SchemaId, getMeasurements } from "@/health";
import { getDevices } from "../devices";

// ---------------------------------------------------------------------------
// Fraud types
// ---------------------------------------------------------------------------

export type FraudAlertStatus =
  | "open"
  | "investigating"
  | "confirmed"
  | "false_positive"
  | "resolved";

export interface FraudSignal {
  readonly type: FraudAlertType;
  /** The observed value that triggered the signal (e.g. distance in km). */
  readonly value: number;
  /** The threshold the value was compared against. */
  readonly threshold: number;
  /** Confidence 0-1 that this signal indicates actual fraud. */
  readonly confidence: number;
  readonly detail: string;
}

export interface FraudRiskScore {
  readonly technicianId: TechnicianId;
  /** 0-100 */
  readonly score: number;
  readonly level: "low" | "medium" | "high" | "critical";
  readonly factors: FraudSignal[];
  readonly assessedAt: string;
}

export type FraudPattern =
  | "single_event"
  | "repeated"
  | "clustered"
  | "systemic";

export interface FraudAlert {
  readonly id: FraudAlertId;
  readonly type: FraudAlertType;
  readonly severity: FraudAlertSeverity;
  readonly technicianId?: TechnicianId;
  readonly participantId?: AccountId;
  readonly measurementId?: MeasurementId;
  readonly sessionId?: SessionId;
  readonly description: string;
  readonly detectedAt: string;
  readonly signals: FraudSignal[];
  readonly status: FraudAlertStatus;
  readonly pattern: FraudPattern;
  readonly resolvedAt?: string;
  readonly resolvedBy?: AccountId;
  readonly resolution?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface FraudDetector {
  readonly id: string;
  readonly type: FraudAlertType;
  readonly check: (ctx: FraudAnalysisContext) => FraudSignal[];
}

export interface LatLng {
  readonly lat: number;
  readonly lon: number;
  readonly label?: string;
}

export interface VerificationRecord {
  readonly at: string;
  readonly participantId?: AccountId;
  readonly location?: LatLng;
}

export interface FraudAnalysisContext {
  readonly technicianId: TechnicianId;
  readonly participantId?: AccountId;
  readonly measurementId?: MeasurementId;
  readonly sessionId?: SessionId;
  /** Numeric value of the current measurement (for improbable_improvement). */
  readonly value?: number;
  readonly unit?: string;
  /** Explicit prior value (used if fetching from store fails or is unavailable). */
  readonly previousValue?: number;
  /** Collected-at timestamp of the current measurement. */
  readonly collectedAt?: string;
  /** For fetching prior measurements from the health store. */
  readonly profileId?: ProfileId;
  readonly schemaId?: SchemaId;
  /** Evidence hashes attached to this measurement (for duplicate_evidence). */
  readonly evidenceHashes?: string[];
  readonly evidenceIds?: EvidenceId[];
  /** Device used to capture this measurement (for device_anomaly). */
  readonly deviceId?: DeviceId;
  /** Locations (for location_inconsistency + impossible_travel). */
  readonly technicianLocation?: LatLng;
  readonly participantLocation?: LatLng;
  /** Prior verifications by this technician (for impossible_travel). */
  readonly priorVerifications?: VerificationRecord[];
  /** Recent verifications by this technician (for frequency_abuse + collusion). */
  readonly recentVerifications?: VerificationRecord[];
}

export interface ListAlertsFilter {
  readonly status?: FraudAlertStatus;
  readonly severity?: FraudAlertSeverity;
  readonly type?: FraudAlertType;
  readonly technicianId?: TechnicianId;
  readonly measurementId?: MeasurementId;
  readonly sessionId?: SessionId;
}

export interface CreateAlertInput {
  readonly type: FraudAlertType;
  readonly severity: FraudAlertSeverity;
  readonly technicianId?: TechnicianId;
  readonly participantId?: AccountId;
  readonly measurementId?: MeasurementId;
  readonly sessionId?: SessionId;
  readonly description: string;
  readonly signals?: FraudSignal[];
  readonly pattern?: FraudPattern;
  readonly metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Tunable thresholds (constants so programs can override at the engine level)
// ---------------------------------------------------------------------------

export const FRAUD_THRESHOLDS = {
  /** Change-of-value percent (0-1) above which a measurement is "improbable". */
  IMPROBABLE_CHANGE_PCT: 0.5,
  /** Max distance (km) between technician and participant during a session. */
  LOCATION_MAX_KM: 100,
  /** Verifications in the window that trigger frequency_abuse. */
  FREQUENCY_WINDOW_HOURS: 1,
  FREQUENCY_MAX_IN_WINDOW: 10,
  /** Distinct-participant floor for the collusion check. */
  COLLUSION_MIN_DISTINCT: 3,
  COLLUSION_MIN_TOTAL: 10,
  /** Speed (km/h) above which travel between two verifications is "impossible". */
  IMPOSSIBLE_TRAVEL_KMH: 200,
  /** Confidence baseline for a single-signal alert. */
  SINGLE_SIGNAL_CONFIDENCE: 0.5,
} as const;

// ---------------------------------------------------------------------------
// Geometry helpers (real haversine)
// ---------------------------------------------------------------------------

const EARTH_RADIUS_KM = 6371;

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/**
 * Great-circle distance between two lat/lon points, in kilometres.
 * Uses the haversine formula.
 */
export function haversineKm(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const sinDLat = Math.sin(dLat / 2);
  const sinDLon = Math.sin(dLon / 2);
  const h =
    sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLon * sinDLon;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

// ---------------------------------------------------------------------------
// Statistics helpers
// ---------------------------------------------------------------------------

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

function stddev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const variance = xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(variance);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

// ---------------------------------------------------------------------------
// Default detectors
// ---------------------------------------------------------------------------

/**
 * 1. Improbable improvement — current value shows an implausibly large
 * change from the prior measurement (e.g. >50% weight loss in a day).
 * Fetches prior measurements via getMeasurements() (guarded by try/catch).
 */
function detectImprobableImprovement(ctx: FraudAnalysisContext): FraudSignal[] {
  if (ctx.value === undefined) return [];
  const currentValue = ctx.value;

  // Determine the previous value: explicit override first, else fetch from store.
  let previousValue: number | undefined = ctx.previousValue;
  let fetched = false;
  if (previousValue === undefined && ctx.profileId && ctx.schemaId) {
    try {
      const prior = getMeasurements().list({
        profileId: ctx.profileId,
        schemaId: ctx.schemaId,
        to: ctx.collectedAt ?? getClock().iso(),
        includeSuperseded: false,
        limit: 5,
      });
      // The most-recent prior measurement (excluding the current one).
      const priorMs = prior.filter(
        (m) => ctx.measurementId === undefined || m.id !== ctx.measurementId,
      );
      if (priorMs.length > 0) {
        // list() sorts newest first by collectedAt desc.
        const p = priorMs[0];
        const v = p.value;
        if (typeof v === "number") previousValue = v;
        else if (typeof v === "object" && v !== null && typeof (v as { value?: unknown }).value === "number") {
          previousValue = (v as { value: number }).value;
        }
        fetched = true;
      }
    } catch {
      // Health store unavailable — fall through.
    }
  }

  if (previousValue === undefined || previousValue === 0) return [];
  const changePct = Math.abs(currentValue - previousValue) / Math.abs(previousValue);
  if (changePct <= FRAUD_THRESHOLDS.IMPROBABLE_CHANGE_PCT) return [];

  // Confidence scales with the magnitude of the change.
  const confidence = clamp(changePct, 0, 1);
  return [
    {
      type: "improbable_improvement",
      value: changePct,
      threshold: FRAUD_THRESHOLDS.IMPROBABLE_CHANGE_PCT,
      confidence,
      detail: `Value changed ${(changePct * 100).toFixed(1)}% from ${previousValue} to ${currentValue}${fetched ? " (prior fetched)" : " (prior provided)"}`,
    },
  ];
}

/**
 * 2. Duplicate evidence — same evidence hash appears on multiple measurements.
 * The engine maintains an internal hash -> measurementId index.
 */
function makeDuplicateEvidenceDetector(
  hashIndex: Map<string, MeasurementId[]>,
): FraudDetector {
  return {
    id: "duplicate_evidence",
    type: "duplicate_evidence",
    check: (ctx: FraudAnalysisContext): FraudSignal[] => {
      if (!ctx.evidenceHashes || ctx.evidenceHashes.length === 0) return [];
      const signals: FraudSignal[] = [];
      for (const hash of ctx.evidenceHashes) {
        const existing = hashIndex.get(hash) ?? [];
        const others = existing.filter((mid) => mid !== ctx.measurementId);
        if (others.length > 0) {
          signals.push({
            type: "duplicate_evidence",
            value: others.length,
            threshold: 1,
            confidence: clamp(0.6 + others.length * 0.1, 0, 1),
            detail: `Evidence hash ${hash} already attached to measurement(s) ${others.join(", ")}`,
          });
        }
      }
      return signals;
    },
  };
}

/**
 * 3. Device anomaly — device calibration expired or device decertified.
 * Uses getDevices() from ../devices (guarded by try/catch).
 */
function detectDeviceAnomaly(ctx: FraudAnalysisContext): FraudSignal[] {
  if (!ctx.deviceId) return [];
  try {
    const devices = getDevices();
    const device = devices.get(ctx.deviceId);
    if (!device) return [];
    const signals: FraudSignal[] = [];
    if (!devices.isCalibrationCurrent(ctx.deviceId)) {
      signals.push({
        type: "device_anomaly",
        value: device.calibrationExpiresAt ? Date.parse(device.calibrationExpiresAt) : 0,
        threshold: Date.now(),
        confidence: 0.7,
        detail: `Device ${device.serialNumber} calibration is expired or missing`,
      });
    }
    if (device.status === "decertified") {
      signals.push({
        type: "device_anomaly",
        value: 1,
        threshold: 0,
        confidence: 0.9,
        detail: `Device ${device.serialNumber} is decertified`,
      });
    }
    if (device.trustLevel === "unverified") {
      signals.push({
        type: "device_anomaly",
        value: 0,
        threshold: 1,
        confidence: 0.4,
        detail: `Device ${device.serialNumber} trust level is "unverified"`,
      });
    }
    return signals;
  } catch {
    return [];
  }
}

/**
 * 4. Location inconsistency — technician and participant are impossibly
 * far apart for an in-person session.
 */
function detectLocationInconsistency(ctx: FraudAnalysisContext): FraudSignal[] {
  if (!ctx.technicianLocation || !ctx.participantLocation) return [];
  const distance = haversineKm(ctx.technicianLocation, ctx.participantLocation);
  if (distance <= FRAUD_THRESHOLDS.LOCATION_MAX_KM) return [];
  // Confidence scales with distance.
  const confidence = clamp(0.5 + (distance - FRAUD_THRESHOLDS.LOCATION_MAX_KM) / 1000, 0.5, 1);
  return [
    {
      type: "location_inconsistency",
      value: distance,
      threshold: FRAUD_THRESHOLDS.LOCATION_MAX_KM,
      confidence,
      detail: `Technician and participant are ${distance.toFixed(1)} km apart (max ${FRAUD_THRESHOLDS.LOCATION_MAX_KM} km)`,
    },
  ];
}

/**
 * 5. Frequency abuse — too many verifications in a short window. Uses real
 * mean + 3*stddev on the rolling count when there's enough history,
 * otherwise falls back to an absolute threshold.
 */
function detectFrequencyAbuse(ctx: FraudAnalysisContext): FraudSignal[] {
  const recent = ctx.recentVerifications ?? [];
  if (recent.length === 0) return [];
  const nowMs = ctx.collectedAt ? Date.parse(ctx.collectedAt) : getClock().epochMs();

  // Build per-hour counts across the recent history (last 24h).
  const hourlyBuckets = new Map<number, number>();
  for (const r of recent) {
    const t = Date.parse(r.at);
    if (!Number.isFinite(t)) continue;
    const hoursAgo = Math.floor((nowMs - t) / (60 * 60 * 1000));
    if (hoursAgo < 0 || hoursAgo >= 24) continue;
    hourlyBuckets.set(hoursAgo, (hourlyBuckets.get(hoursAgo) ?? 0) + 1);
  }
  const counts = [...hourlyBuckets.values()];
  const currentWindowCount = counts[0] ?? 0;

  let threshold: number = FRAUD_THRESHOLDS.FREQUENCY_MAX_IN_WINDOW;
  let detail = `Frequency ${currentWindowCount} in last ${FRAUD_THRESHOLDS.FREQUENCY_WINDOW_HOURS}h (absolute threshold ${threshold})`;
  if (counts.length >= 5) {
    const m = mean(counts);
    const sd = stddev(counts);
    const dynamicThreshold = m + 3 * sd;
    if (dynamicThreshold > threshold) {
      threshold = dynamicThreshold;
      detail = `Frequency ${currentWindowCount} exceeds mean+3σ (${m.toFixed(1)} + ${sd.toFixed(1)}*3 = ${dynamicThreshold.toFixed(1)})`;
    }
  }

  if (currentWindowCount <= threshold) return [];
  const overshoot = (currentWindowCount - threshold) / Math.max(1, threshold);
  return [
    {
      type: "frequency_abuse",
      value: currentWindowCount,
      threshold,
      confidence: clamp(0.5 + overshoot, 0.5, 1),
      detail,
    },
  ];
}

/**
 * 6. Suspicious verification pattern — technician only verifies
 * measurements from a small set of participants (potential collusion).
 */
function detectSuspiciousVerificationPattern(ctx: FraudAnalysisContext): FraudSignal[] {
  const recent = ctx.recentVerifications ?? [];
  if (recent.length < FRAUD_THRESHOLDS.COLLUSION_MIN_TOTAL) return [];
  const distinct = new Set<string>();
  for (const r of recent) {
    if (r.participantId) distinct.add(r.participantId as string);
  }
  if (distinct.size >= FRAUD_THRESHOLDS.COLLUSION_MIN_DISTINCT) return [];
  const ratio = distinct.size / recent.length;
  return [
    {
      type: "suspicious_verification_pattern",
      value: distinct.size,
      threshold: FRAUD_THRESHOLDS.COLLUSION_MIN_DISTINCT,
      // Confidence higher when ratio is very low.
      confidence: clamp(1 - ratio, 0.5, 1),
      detail: `Technician verified ${recent.length} measurements but only ${distinct.size} distinct participants`,
    },
  ];
}

/**
 * 7. Impossible travel — technician verified measurements at two distant
 * locations within an impossible timeframe.
 */
function detectImpossibleTravel(ctx: FraudAnalysisContext): FraudSignal[] {
  if (!ctx.technicianLocation || !ctx.priorVerifications || ctx.priorVerifications.length === 0) return [];
  const now = ctx.collectedAt ? Date.parse(ctx.collectedAt) : getClock().epochMs();
  const current = ctx.technicianLocation;
  const signals: FraudSignal[] = [];
  for (const prior of ctx.priorVerifications) {
    if (!prior.location) continue;
    const priorMs = Date.parse(prior.at);
    if (!Number.isFinite(priorMs)) continue;
    const dtMs = now - priorMs;
    if (dtMs <= 0) continue;
    const distance = haversineKm(prior.location, current);
    const hours = dtMs / (60 * 60 * 1000);
    if (hours < 0.01) continue;
    const requiredKmh = distance / hours;
    if (requiredKmh > FRAUD_THRESHOLDS.IMPOSSIBLE_TRAVEL_KMH) {
      signals.push({
        type: "impossible_travel",
        value: requiredKmh,
        threshold: FRAUD_THRESHOLDS.IMPOSSIBLE_TRAVEL_KMH,
        confidence: clamp(0.5 + (requiredKmh - FRAUD_THRESHOLDS.IMPOSSIBLE_TRAVEL_KMH) / 1000, 0.5, 1),
        detail: `Required travel speed ${requiredKmh.toFixed(0)} km/h between ${prior.location.label ?? "prior"} and ${current.label ?? "current"} over ${hours.toFixed(2)}h`,
      });
    }
  }
  return signals;
}

// ---------------------------------------------------------------------------
// Severity inference
// ---------------------------------------------------------------------------

function inferSeverity(signals: FraudSignal[]): FraudAlertSeverity {
  if (signals.length === 0) return "low";
  const maxConfidence = Math.max(...signals.map((s) => s.confidence));
  if (maxConfidence >= 0.9 || signals.length >= 4) return "critical";
  if (maxConfidence >= 0.75 || signals.length >= 3) return "high";
  if (maxConfidence >= 0.5) return "medium";
  return "low";
}

// ---------------------------------------------------------------------------
// Fraud detection engine
// ---------------------------------------------------------------------------

export class FraudDetectionEngine {
  private readonly detectors = new Map<string, FraudDetector>();
  private readonly alerts = new Map<FraudAlertId, FraudAlert>();
  private readonly byTechnician = new Map<TechnicianId, FraudAlertId[]>();
  private readonly byMeasurement = new Map<MeasurementId, FraudAlertId[]>();
  private readonly bySession = new Map<SessionId, FraudAlertId[]>();
  private readonly hashIndex = new Map<string, MeasurementId[]>();
  private readonly defaultDetectors: FraudDetector[];

  constructor() {
    this.defaultDetectors = [
      { id: "improbable_improvement", type: "improbable_improvement", check: detectImprobableImprovement },
      makeDuplicateEvidenceDetector(this.hashIndex),
      { id: "device_anomaly", type: "device_anomaly", check: detectDeviceAnomaly },
      { id: "location_inconsistency", type: "location_inconsistency", check: detectLocationInconsistency },
      { id: "frequency_abuse", type: "frequency_abuse", check: detectFrequencyAbuse },
      { id: "suspicious_verification_pattern", type: "suspicious_verification_pattern", check: detectSuspiciousVerificationPattern },
      { id: "impossible_travel", type: "impossible_travel", check: detectImpossibleTravel },
    ];
    for (const d of this.defaultDetectors) this.detectors.set(d.id, d);
  }

  registerDetector(detector: FraudDetector): void {
    this.detectors.set(detector.id, detector);
  }

  listDetectors(): FraudDetector[] {
    return [...this.detectors.values()];
  }

  /**
   * Run all detectors against the supplied context. Returns the aggregated
   * signals. Also updates the internal evidence-hash index when the context
   * carries evidence hashes (so subsequent duplicate_evidence checks can
   * detect duplicates).
   */
  analyze(ctx: FraudAnalysisContext): { signals: FraudSignal[]; wouldCreateAlert: boolean; severity: FraudAlertSeverity } {
    // Update the evidence-hash index before running detectors so the
    // duplicate detector can observe the new hashes too.
    if (ctx.evidenceHashes && ctx.measurementId) {
      for (const hash of ctx.evidenceHashes) {
        const existing = this.hashIndex.get(hash) ?? [];
        if (!existing.includes(ctx.measurementId)) {
          this.hashIndex.set(hash, [...existing, ctx.measurementId]);
        }
      }
    }

    const signals: FraudSignal[] = [];
    for (const detector of this.detectors.values()) {
      try {
        const produced = detector.check(ctx);
        for (const s of produced) signals.push(s);
      } catch {
        // A failing detector must not abort the whole analysis.
      }
    }
    const severity = inferSeverity(signals);
    return { signals, wouldCreateAlert: signals.length > 0, severity };
  }

  createAlert(input: CreateAlertInput): FraudAlert {
    const now = getClock().iso();
    const alert: FraudAlert = {
      id: asFraudAlertId(generateId("frd_")),
      type: input.type,
      severity: input.severity,
      technicianId: input.technicianId,
      participantId: input.participantId,
      measurementId: input.measurementId,
      sessionId: input.sessionId,
      description: input.description,
      detectedAt: now,
      signals: input.signals ?? [],
      status: "open",
      pattern: input.pattern ?? "single_event",
      metadata: input.metadata,
    };
    this.alerts.set(alert.id, alert);
    if (alert.technicianId) {
      const list = this.byTechnician.get(alert.technicianId) ?? [];
      this.byTechnician.set(alert.technicianId, [...list, alert.id]);
    }
    if (alert.measurementId) {
      const list = this.byMeasurement.get(alert.measurementId) ?? [];
      this.byMeasurement.set(alert.measurementId, [...list, alert.id]);
    }
    if (alert.sessionId) {
      const list = this.bySession.get(alert.sessionId) ?? [];
      this.bySession.set(alert.sessionId, [...list, alert.id]);
    }
    void getEventBus().publish(
      buildEvent(
        TECHNICIAN_EVENTS.fraudAlertCreated,
        { alertId: alert.id, type: alert.type, severity: alert.severity, technicianId: alert.technicianId, measurementId: alert.measurementId },
        {},
        "domain",
      ),
    );
    return alert;
  }

  getAlert(id: FraudAlertId): FraudAlert | undefined {
    return this.alerts.get(id);
  }

  listAlerts(filter?: ListAlertsFilter): FraudAlert[] {
    let list = [...this.alerts.values()];
    if (filter?.status) list = list.filter((a) => a.status === filter.status);
    if (filter?.severity) list = list.filter((a) => a.severity === filter.severity);
    if (filter?.type) list = list.filter((a) => a.type === filter.type);
    if (filter?.technicianId) list = list.filter((a) => a.technicianId === filter.technicianId);
    if (filter?.measurementId) list = list.filter((a) => a.measurementId === filter.measurementId);
    if (filter?.sessionId) list = list.filter((a) => a.sessionId === filter.sessionId);
    return list.sort((a, b) => b.detectedAt.localeCompare(a.detectedAt));
  }

  investigate(id: FraudAlertId, by: AccountId): FraudAlert {
    const current = this.require(id);
    if (current.status !== "open") {
      throw new TechnicianError({
        code: "eks.technician.fraud.not_open",
        category: "state_conflict",
        message: `Cannot investigate alert in status "${current.status}".`,
      });
    }
    const updated: FraudAlert = {
      ...current,
      status: "investigating",
      metadata: { ...current.metadata, investigatedBy: by, investigatedAt: getClock().iso() },
    };
    this.alerts.set(id, updated);
    return updated;
  }

  confirm(id: FraudAlertId, by: AccountId): FraudAlert {
    const current = this.require(id);
    if (current.status === "resolved" || current.status === "false_positive") {
      throw new TechnicianError({
        code: "eks.technician.fraud.already_resolved",
        category: "state_conflict",
        message: `Cannot confirm an alert already in status "${current.status}".`,
      });
    }
    const now = getClock().iso();
    const updated: FraudAlert = {
      ...current,
      status: "confirmed",
      resolvedAt: now,
      resolvedBy: by,
      resolution: "confirmed_fraud",
    };
    this.alerts.set(id, updated);
    return updated;
  }

  markFalsePositive(id: FraudAlertId, by: AccountId): FraudAlert {
    const current = this.require(id);
    const now = getClock().iso();
    const updated: FraudAlert = {
      ...current,
      status: "false_positive",
      resolvedAt: now,
      resolvedBy: by,
      resolution: "false_positive",
    };
    this.alerts.set(id, updated);
    return updated;
  }

  resolve(id: FraudAlertId, resolution: string, by: AccountId): FraudAlert {
    const current = this.require(id);
    const now = getClock().iso();
    const updated: FraudAlert = {
      ...current,
      status: "resolved",
      resolvedAt: now,
      resolvedBy: by,
      resolution,
    };
    this.alerts.set(id, updated);
    return updated;
  }

  /**
   * Compute a 0-100 fraud risk score for a technician based on open alerts
   * and their signals. Higher severity and more alerts increase the score.
   */
  riskScore(technicianId: TechnicianId): FraudRiskScore {
    const ids = this.byTechnician.get(technicianId) ?? [];
    const alerts = ids
      .map((id) => this.alerts.get(id)!)
      .filter(Boolean)
      .filter((a) => a.status === "open" || a.status === "investigating" || a.status === "confirmed");

    const severityWeights: Record<FraudAlertSeverity, number> = {
      low: 10,
      medium: 25,
      high: 50,
      critical: 80,
    };
    let score = 0;
    const factors: FraudSignal[] = [];
    for (const a of alerts) {
      score += severityWeights[a.severity];
      for (const s of a.signals) factors.push(s);
    }
    // Multiple alerts compound but cap at 100.
    score = Math.min(100, Math.round(score));

    let level: FraudRiskScore["level"];
    if (score >= 80) level = "critical";
    else if (score >= 50) level = "high";
    else if (score >= 25) level = "medium";
    else level = "low";

    return {
      technicianId,
      score,
      level,
      factors,
      assessedAt: getClock().iso(),
    };
  }

  getStats(): {
    total: number;
    byType: Record<FraudAlertType, number>;
    bySeverity: Record<FraudAlertSeverity, number>;
    byStatus: Record<FraudAlertStatus, number>;
    confirmationRate: number;
    falsePositiveRate: number;
  } {
    const list = [...this.alerts.values()];
    const byType = {} as Record<FraudAlertType, number>;
    const bySeverity = { low: 0, medium: 0, high: 0, critical: 0 } as Record<FraudAlertSeverity, number>;
    const byStatus = {
      open: 0,
      investigating: 0,
      confirmed: 0,
      false_positive: 0,
      resolved: 0,
    } as Record<FraudAlertStatus, number>;
    const typeKeys: FraudAlertType[] = [
      "improbable_improvement", "duplicate_evidence", "device_anomaly",
      "location_inconsistency", "technician_collusion", "identity_mismatch",
      "frequency_abuse", "suspicious_verification_pattern", "impossible_travel",
      "statistical_outlier",
    ];
    for (const t of typeKeys) byType[t] = 0;
    let resolved = 0;
    let confirmed = 0;
    let falsePos = 0;
    for (const a of list) {
      byType[a.type] = (byType[a.type] ?? 0) + 1;
      bySeverity[a.severity]++;
      byStatus[a.status]++;
      if (a.status === "resolved" || a.status === "confirmed" || a.status === "false_positive") resolved++;
      if (a.status === "confirmed") confirmed++;
      if (a.status === "false_positive") falsePos++;
    }
    return {
      total: list.length,
      byType,
      bySeverity,
      byStatus,
      confirmationRate: resolved > 0 ? confirmed / resolved : 0,
      falsePositiveRate: resolved > 0 ? falsePos / resolved : 0,
    };
  }

  // -------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------

  private require(id: FraudAlertId): FraudAlert {
    const a = this.alerts.get(id);
    if (!a) {
      throw new TechnicianError({
        code: "eks.technician.fraud.not_found",
        category: "not_found",
        message: `Fraud alert ${id} not found.`,
        userMessage: "This fraud alert could not be found.",
      });
    }
    return a;
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _fraud: FraudDetectionEngine | null = null;
export function getFraudDetection(): FraudDetectionEngine {
  if (!_fraud) _fraud = new FraudDetectionEngine();
  return _fraud;
}
