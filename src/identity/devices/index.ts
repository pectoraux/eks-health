/**
 * Eks-Health Identity — Device Trust Platform
 *
 * Device registration, fingerprinting, risk scoring, trust management,
 * revocation, new-device alerts, suspicious-activity detection.
 */

import "server-only";
import {
  type AccountId,
  type DeviceId,
  IdentityError,
  IDENTITY_EVENTS,
  asDeviceId,
  type RiskAssessment,
} from "../core";
import { createHash } from "node:crypto";
import { getEventBus, buildEvent, generateId, getClock } from "@/kernel";

// ---------------------------------------------------------------------------
// Device
// ---------------------------------------------------------------------------

export type DeviceTrust = "untrusted" | "verified" | "trusted";

export interface DeviceFingerprint {
  readonly userAgent: string;
  readonly platform: string;
  readonly language: string;
  readonly screen: string;
  readonly timezone: string;
  readonly hash: string; // composite hash
}

export interface Device {
  readonly id: DeviceId;
  readonly accountId: AccountId;
  readonly label: string; // "MacBook Pro — Chrome"
  readonly fingerprint: DeviceFingerprint;
  readonly trust: DeviceTrust;
  readonly riskScore: number; // 0-100
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly lastIpAddress?: string;
  readonly lastLocation?: string;
  readonly revoked: boolean;
  readonly revokedReason?: string;
  readonly revokedAt?: string;
}

export interface RegisterDeviceInput {
  readonly accountId: AccountId;
  readonly label: string;
  readonly fingerprint: Omit<DeviceFingerprint, "hash">;
  readonly ipAddress?: string;
  readonly location?: string;
}

// ---------------------------------------------------------------------------
// Device manager
// ---------------------------------------------------------------------------

export class DeviceManager {
  private readonly devices = new Map<DeviceId, Device>();
  private readonly byAccount = new Map<AccountId, DeviceId[]>();
  private readonly byFingerprint = new Map<string, DeviceId>(); // composite hash -> device

  register(input: RegisterDeviceInput): Device {
    const hash = this.hashFingerprint(input.fingerprint);
    // If this fingerprint is already known for this account, return it.
    const existingId = this.byFingerprint.get(hash);
    if (existingId) {
      const existing = this.devices.get(existingId);
      if (existing && existing.accountId === input.accountId && !existing.revoked) {
        return this.touch(existing.id, input.ipAddress, input.location);
      }
    }
    const device: Device = {
      id: asDeviceId(generateId("dev_")),
      accountId: input.accountId,
      label: input.label,
      fingerprint: { ...input.fingerprint, hash },
      trust: "untrusted",
      riskScore: this.assessRiskScore(input),
      firstSeenAt: getClock().iso(),
      lastSeenAt: getClock().iso(),
      lastIpAddress: input.ipAddress,
      lastLocation: input.location,
      revoked: false,
    };
    this.devices.set(device.id, device);
    this.byFingerprint.set(hash, device.id);
    const list = this.byAccount.get(input.accountId) ?? [];
    this.byAccount.set(input.accountId, [...list, device.id]);

    // New device alert
    void getEventBus().publish(
      buildEvent(IDENTITY_EVENTS.deviceRegistered, { accountId: input.accountId, deviceId: device.id, label: device.label, ipAddress: input.ipAddress }, {}, "domain"),
    );
    if (device.riskScore >= 50) {
      void getEventBus().publish(
        buildEvent(IDENTITY_EVENTS.suspiciousActivity, { accountId: input.accountId, deviceId: device.id, reason: "high_risk_new_device", riskScore: device.riskScore }, {}, "domain"),
      );
    }
    return device;
  }

  /** Mark a device as trusted (after MFA or verification). */
  trust(deviceId: DeviceId, verified = true): Device {
    const device = this.devices.get(deviceId);
    if (!device) throw new IdentityError({ code: "eks.identity.device.not_found", category: "not_found", message: "Device not found." });
    const updated: Device = { ...device, trust: verified ? "trusted" : "verified", riskScore: Math.max(0, device.riskScore - 30) };
    this.devices.set(deviceId, updated);
    void getEventBus().publish(buildEvent(IDENTITY_EVENTS.deviceTrusted, { accountId: device.accountId, deviceId, trust: updated.trust }, {}, "domain"));
    return updated;
  }

  revoke(deviceId: DeviceId, reason: string): void {
    const device = this.devices.get(deviceId);
    if (!device) return;
    this.devices.set(deviceId, { ...device, revoked: true, revokedReason: reason, revokedAt: getClock().iso(), trust: "untrusted" });
    this.byFingerprint.delete(device.fingerprint.hash);
    void getEventBus().publish(buildEvent(IDENTITY_EVENTS.deviceRevoked, { accountId: device.accountId, deviceId, reason }, {}, "domain"));
  }

  get(deviceId: DeviceId): Device | undefined {
    return this.devices.get(deviceId);
  }

  listForAccount(accountId: AccountId): Device[] {
    return (this.byAccount.get(accountId) ?? [])
      .map((id) => this.devices.get(id))
      .filter((d): d is Device => !!d);
  }

  list(): Device[] {
    return [...this.devices.values()];
  }

  touch(deviceId: DeviceId, ipAddress?: string, location?: string): Device {
    const device = this.devices.get(deviceId);
    if (!device) throw new IdentityError({ code: "eks.identity.device.not_found", category: "not_found", message: "Device not found." });
    const updated: Device = { ...device, lastSeenAt: getClock().iso(), lastIpAddress: ipAddress ?? device.lastIpAddress, lastLocation: location ?? device.lastLocation };
    this.devices.set(deviceId, updated);
    return updated;
  }

  /** Build a risk assessment for a device/session context. */
  assessRisk(device: Device | undefined, ipAddress?: string): RiskAssessment {
    const factors: { label: string; weight: number; detail?: string }[] = [];
    let score = 0;
    if (!device) {
      score += 30;
      factors.push({ label: "unknown_device", weight: 30 });
    } else {
      if (device.revoked) {
        score += 80;
        factors.push({ label: "revoked_device", weight: 80, detail: "Device was previously revoked" });
      }
      if (device.trust === "untrusted") {
        score += 20;
        factors.push({ label: "untrusted_device", weight: 20 });
      }
      score += Math.round(device.riskScore * 0.3);
      factors.push({ label: "device_risk", weight: Math.round(device.riskScore * 0.3) });
    }
    if (ipAddress) {
      // Heuristic: a Tor exit or known-bad IP would add weight (real impl
      // calls a threat-intel adapter; here we apply a deterministic rule).
      if (ipAddress === "0.0.0.0" || ipAddress.startsWith("127.")) {
        factors.push({ label: "loopback_ip", weight: 5 });
        score += 5;
      }
    }
    score = Math.min(score, 100);
    const level: RiskAssessment["level"] = score >= 75 ? "critical" : score >= 50 ? "high" : score >= 25 ? "medium" : "low";
    return {
      score,
      level,
      factors,
      assessedAt: getClock().iso(),
      requiresMfa: level === "high" || level === "critical",
      requiresStepUp: level === "critical",
      recommendedAction: score >= 75 ? "deny" : score >= 50 ? "challenge" : score >= 25 ? "notify" : "allow",
    };
  }

  private assessRiskScore(input: RegisterDeviceInput): number {
    let score = 20; // new devices start at 20
    if (!input.location) score += 10;
    if (input.fingerprint.platform.toLowerCase().includes("bot")) score += 40;
    return Math.min(score, 100);
  }

  private hashFingerprint(fp: Omit<DeviceFingerprint, "hash">): string {
    return createHash("sha256").update(`${fp.userAgent}|${fp.platform}|${fp.language}|${fp.screen}|${fp.timezone}`).digest("hex");
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _mgr: DeviceManager | null = null;
export function getDevices(): DeviceManager {
  if (!_mgr) _mgr = new DeviceManager();
  return _mgr;
}
