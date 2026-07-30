/**
 * Eks-Health Technician Network — Certified Measurement Device Framework
 *
 * Registration, calibration, certification, ownership, maintenance,
 * firmware versions, trust level, audit trail. Programs may require
 * specific device types and trust levels.
 *
 * Real calibration-expiry checking, real maintenance history, real
 * calibration-due sweep. No mocks.
 */

import "server-only";
import {
  type DeviceId,
  type DeviceTrustLevel,
  type AccountId,
  type OrgId,
  type TechnicianId,
  TechnicianError,
  asDeviceId,
} from "../core";
import { getEventBus, buildEvent, generateId, getClock } from "@/kernel";
import { TECHNICIAN_EVENTS } from "../core";

// ---------------------------------------------------------------------------
// Device types
// ---------------------------------------------------------------------------

export type DeviceType =
  | "blood_pressure_monitor"
  | "glucometer"
  | "scale"
  | "thermometer"
  | "pulse_oximeter"
  | "ecg_machine"
  | "spirometer"
  | "cholesterol_meter"
  | "hemoglobin_meter"
  | "body_composition_analyzer"
  | "vision_tester"
  | "audiometer"
  | (string & {});

export type DeviceStatus = "active" | "calibration_due" | "decertified" | "retired";

export interface DeviceCalibration {
  readonly calibratedAt: string;
  readonly calibratedBy: AccountId;
  readonly result: "pass" | "fail";
  /** Raw readings captured during calibration (e.g. reference vs observed). */
  readonly readings?: Record<string, number>;
  readonly expiresAt: string;
  readonly notes?: string;
}

export interface DeviceCertification {
  readonly certifiedAt: string;
  readonly certifiedBy: AccountId;
  readonly authority?: string;
  readonly certificateReference?: string;
  readonly expiresAt?: string;
}

export type DeviceMaintenanceType =
  | "calibration"
  | "repair"
  | "firmware_update"
  | "inspection"
  | "cleaning"
  | "battery_replacement";

export interface DeviceMaintenance {
  readonly at: string;
  readonly type: DeviceMaintenanceType;
  readonly performedBy: AccountId;
  readonly notes?: string;
  readonly cost?: number;
  readonly metadata?: Record<string, unknown>;
}

export interface DeviceOwnership {
  readonly ownerId: AccountId | OrgId;
  readonly ownerType: "account" | "organization";
  readonly since: string;
  readonly until?: string;
}

export interface MeasurementDevice {
  readonly id: DeviceId;
  readonly serialNumber: string;
  readonly model: string;
  readonly manufacturer: string;
  readonly firmwareVersion: string;
  readonly type: DeviceType;
  readonly trustLevel: DeviceTrustLevel;
  readonly ownerId: AccountId | OrgId;
  readonly ownerType: "account" | "organization";
  readonly assignedToTechnicianId?: TechnicianId;
  readonly registeredAt: string;
  readonly lastCalibratedAt?: string;
  readonly calibrationExpiresAt?: string;
  readonly certified: boolean;
  readonly certifiedAt?: string;
  readonly certifiedBy?: AccountId;
  readonly certification?: DeviceCertification;
  readonly maintenanceHistory: DeviceMaintenance[];
  readonly capabilities: string[];
  readonly status: DeviceStatus;
  readonly ownershipHistory: DeviceOwnership[];
  readonly metadata?: Record<string, unknown>;
}

export interface RegisterDeviceInput {
  readonly serialNumber: string;
  readonly model: string;
  readonly manufacturer: string;
  readonly firmwareVersion: string;
  readonly type: DeviceType;
  readonly ownerId: AccountId | OrgId;
  readonly ownerType?: "account" | "organization";
  readonly assignedToTechnicianId?: TechnicianId;
  readonly capabilities?: string[];
  readonly initialTrustLevel?: DeviceTrustLevel;
  readonly metadata?: Record<string, unknown>;
}

export interface ListDevicesFilter {
  readonly type?: DeviceType;
  readonly ownerId?: AccountId | OrgId;
  readonly assignedToTechnicianId?: TechnicianId;
  readonly trustLevel?: DeviceTrustLevel;
  readonly status?: DeviceStatus;
  readonly certified?: boolean;
}

// ---------------------------------------------------------------------------
// Device registry
// ---------------------------------------------------------------------------

export class DeviceRegistry {
  private readonly devices = new Map<DeviceId, MeasurementDevice>();
  private readonly bySerial = new Map<string, DeviceId>();
  private readonly byOwner = new Map<string, DeviceId[]>();
  private readonly byTechnician = new Map<TechnicianId, DeviceId[]>();
  private readonly byType = new Map<DeviceType, DeviceId[]>();

  register(input: RegisterDeviceInput): MeasurementDevice {
    if (!input.serialNumber || input.serialNumber.trim().length === 0) {
      throw new TechnicianError({
        code: "eks.technician.device.missing_serial",
        category: "validation",
        message: "Device serialNumber is required.",
        userMessage: "A serial number is required.",
      });
    }
    if (this.bySerial.has(input.serialNumber)) {
      throw new TechnicianError({
        code: "eks.technician.device.duplicate_serial",
        category: "state_conflict",
        message: `Device with serial ${input.serialNumber} already registered.`,
        userMessage: "This device is already registered.",
      });
    }
    const now = getClock().iso();
    const ownerType = input.ownerType ?? (typeof input.ownerId === "string" && input.ownerId.startsWith("org_") ? "organization" : "account");
    const device: MeasurementDevice = {
      id: asDeviceId(generateId("dev_")),
      serialNumber: input.serialNumber,
      model: input.model,
      manufacturer: input.manufacturer,
      firmwareVersion: input.firmwareVersion,
      type: input.type,
      trustLevel: input.initialTrustLevel ?? "registered",
      ownerId: input.ownerId,
      ownerType,
      assignedToTechnicianId: input.assignedToTechnicianId,
      registeredAt: now,
      certified: false,
      maintenanceHistory: [],
      capabilities: input.capabilities ?? [],
      status: "active",
      ownershipHistory: [{ ownerId: input.ownerId, ownerType, since: now }],
      metadata: input.metadata,
    };
    this.devices.set(device.id, device);
    this.bySerial.set(device.serialNumber, device.id);
    this.indexOwner(device);
    this.indexTechnician(device);
    this.indexType(device);
    void getEventBus().publish(
      buildEvent(
        TECHNICIAN_EVENTS.deviceRegistered,
        { deviceId: device.id, serialNumber: device.serialNumber, type: device.type, ownerId: device.ownerId },
        {},
        "domain",
      ),
    );
    return device;
  }

  get(id: DeviceId): MeasurementDevice | undefined {
    return this.devices.get(id);
  }

  getBySerial(serialNumber: string): MeasurementDevice | undefined {
    const id = this.bySerial.get(serialNumber);
    return id ? this.devices.get(id) : undefined;
  }

  list(filter?: ListDevicesFilter): MeasurementDevice[] {
    let list = [...this.devices.values()];
    if (filter?.type) list = list.filter((d) => d.type === filter.type);
    if (filter?.ownerId) list = list.filter((d) => d.ownerId === filter.ownerId);
    if (filter?.assignedToTechnicianId) list = list.filter((d) => d.assignedToTechnicianId === filter.assignedToTechnicianId);
    if (filter?.trustLevel) list = list.filter((d) => d.trustLevel === filter.trustLevel);
    if (filter?.status) list = list.filter((d) => d.status === filter.status);
    if (filter?.certified !== undefined) list = list.filter((d) => d.certified === filter.certified);
    return list;
  }

  calibrate(id: DeviceId, calibration: Omit<DeviceCalibration, "expiresAt"> & { expiresAt: string }): MeasurementDevice {
    const current = this.require(id);
    if (current.status === "retired") {
      throw new TechnicianError({
        code: "eks.technician.device.retired",
        category: "state_conflict",
        message: "Cannot calibrate a retired device.",
        userMessage: "This device has been retired.",
      });
    }
    const maintenanceEntry: DeviceMaintenance = {
      at: calibration.calibratedAt,
      type: "calibration",
      performedBy: calibration.calibratedBy,
      notes: calibration.notes ?? `Calibration ${calibration.result}`,
    };
    const newTrustLevel: DeviceTrustLevel = calibration.result === "pass" ? "calibrated" : current.trustLevel;
    const newStatus: DeviceStatus = calibration.result === "pass" ? "active" : "decertified";
    const updated: MeasurementDevice = {
      ...current,
      lastCalibratedAt: calibration.calibratedAt,
      calibrationExpiresAt: calibration.expiresAt,
      maintenanceHistory: [...current.maintenanceHistory, maintenanceEntry],
      trustLevel: newTrustLevel,
      status: newStatus,
    };
    this.devices.set(id, updated);
    return updated;
  }

  certify(id: DeviceId, certifiedBy: AccountId, opts?: { authority?: string; certificateReference?: string; expiresAt?: string }): MeasurementDevice {
    const current = this.require(id);
    if (current.status === "retired") {
      throw new TechnicianError({
        code: "eks.technician.device.retired",
        category: "state_conflict",
        message: "Cannot certify a retired device.",
        userMessage: "This device has been retired.",
      });
    }
    const now = getClock().iso();
    const certification: DeviceCertification = {
      certifiedAt: now,
      certifiedBy,
      authority: opts?.authority,
      certificateReference: opts?.certificateReference,
      expiresAt: opts?.expiresAt,
    };
    const updated: MeasurementDevice = {
      ...current,
      certified: true,
      certifiedAt: now,
      certifiedBy,
      certification,
      trustLevel: "certified",
      status: "active",
    };
    this.devices.set(id, updated);
    return updated;
  }

  recordMaintenance(id: DeviceId, maintenance: DeviceMaintenance): MeasurementDevice {
    const current = this.require(id);
    const updated: MeasurementDevice = {
      ...current,
      maintenanceHistory: [...current.maintenanceHistory, maintenance],
    };
    this.devices.set(id, updated);
    return updated;
  }

  updateFirmware(id: DeviceId, version: string, performedBy: AccountId): MeasurementDevice {
    const current = this.require(id);
    if (current.status === "retired") {
      throw new TechnicianError({
        code: "eks.technician.device.retired",
        category: "state_conflict",
        message: "Cannot update firmware on a retired device.",
      });
    }
    const now = getClock().iso();
    const updated: MeasurementDevice = {
      ...current,
      firmwareVersion: version,
      maintenanceHistory: [
        ...current.maintenanceHistory,
        { at: now, type: "firmware_update", performedBy, notes: `Firmware updated to ${version}` },
      ],
    };
    this.devices.set(id, updated);
    return updated;
  }

  transferOwnership(id: DeviceId, newOwnerId: AccountId | OrgId, newOwnerType?: "account" | "organization"): MeasurementDevice {
    const current = this.require(id);
    if (current.status === "retired") {
      throw new TechnicianError({
        code: "eks.technician.device.retired",
        category: "state_conflict",
        message: "Cannot transfer ownership of a retired device.",
      });
    }
    const now = getClock().iso();
    const ownerType = newOwnerType ?? (typeof newOwnerId === "string" && newOwnerId.startsWith("org_") ? "organization" : "account");
    // Close out the current ownership entry.
    const closedHistory = current.ownershipHistory.map((o, i) =>
      i === current.ownershipHistory.length - 1 && !o.until ? { ...o, until: now } : o,
    );
    const updated: MeasurementDevice = {
      ...current,
      ownerId: newOwnerId,
      ownerType,
      ownershipHistory: [...closedHistory, { ownerId: newOwnerId, ownerType, since: now }],
    };
    this.devices.set(id, updated);
    // Re-index owner (technician mapping unchanged).
    this.removeFromOwnerIndex(current);
    this.indexOwner(updated);
    return updated;
  }

  retire(id: DeviceId, retiredBy: AccountId, reason?: string): MeasurementDevice {
    const current = this.require(id);
    const now = getClock().iso();
    const updated: MeasurementDevice = {
      ...current,
      status: "retired",
      certified: false,
      maintenanceHistory: [
        ...current.maintenanceHistory,
        { at: now, type: "inspection", performedBy: retiredBy, notes: reason ? `Retired: ${reason}` : "Retired" },
      ],
    };
    this.devices.set(id, updated);
    return updated;
  }

  isCalibrationCurrent(id: DeviceId): boolean {
    const d = this.devices.get(id);
    if (!d) return false;
    if (!d.calibrationExpiresAt) return false;
    return Date.parse(d.calibrationExpiresAt) > getClock().epochMs();
  }

  isCertified(id: DeviceId): boolean {
    const d = this.devices.get(id);
    if (!d) return false;
    if (!d.certified) return false;
    if (d.certification?.expiresAt && Date.parse(d.certification.expiresAt) < getClock().epochMs()) {
      return false;
    }
    return true;
  }

  /**
   * Sweep all devices and mark any whose calibration has expired as
   * "calibration_due". Returns the list of devices whose status changed.
   * Called by the scheduler.
   */
  sweepCalibrationDue(): MeasurementDevice[] {
    const now = getClock().epochMs();
    const changed: MeasurementDevice[] = [];
    for (const [id, d] of this.devices) {
      if (d.status === "retired" || d.status === "decertified") continue;
      if (!d.calibrationExpiresAt) continue;
      if (Date.parse(d.calibrationExpiresAt) <= now && d.status !== "calibration_due") {
        const updated: MeasurementDevice = { ...d, status: "calibration_due" };
        this.devices.set(id, updated);
        changed.push(updated);
      }
    }
    return changed;
  }

  getDevicesForTechnician(technicianId: TechnicianId): MeasurementDevice[] {
    const ids = this.byTechnician.get(technicianId) ?? [];
    const set = new Set(ids);
    // Also include devices owned by the technician's account id.
    return [...this.devices.values()].filter((d) => set.has(d.id) || (d.ownerType === "account" && d.ownerId === (technicianId as unknown as AccountId)));
  }

  getStats(): {
    total: number;
    byStatus: Record<DeviceStatus, number>;
    byTrustLevel: Record<DeviceTrustLevel, number>;
    certifiedCount: number;
    calibrationDueCount: number;
    byType: Record<string, number>;
  } {
    const list = [...this.devices.values()];
    const byStatus: Record<DeviceStatus, number> = {
      active: 0,
      calibration_due: 0,
      decertified: 0,
      retired: 0,
    };
    const byTrustLevel: Record<DeviceTrustLevel, number> = {
      unverified: 0,
      registered: 0,
      calibrated: 0,
      certified: 0,
      clinical: 0,
      authoritative: 0,
    };
    const byType: Record<string, number> = {};
    for (const d of list) {
      byStatus[d.status]++;
      byTrustLevel[d.trustLevel]++;
      byType[d.type as string] = (byType[d.type as string] ?? 0) + 1;
    }
    return {
      total: list.length,
      byStatus,
      byTrustLevel,
      certifiedCount: list.filter((d) => d.certified).length,
      calibrationDueCount: list.filter((d) => d.status === "calibration_due").length,
      byType,
    };
  }

  // -------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------

  private require(id: DeviceId): MeasurementDevice {
    const d = this.devices.get(id);
    if (!d) {
      throw new TechnicianError({
        code: "eks.technician.device.not_found",
        category: "not_found",
        message: `Device ${id} not found.`,
        userMessage: "This device could not be found.",
      });
    }
    return d;
  }

  private indexOwner(d: MeasurementDevice): void {
    const list = this.byOwner.get(d.ownerId as string) ?? [];
    this.byOwner.set(d.ownerId as string, [...list, d.id]);
  }

  private removeFromOwnerIndex(d: MeasurementDevice): void {
    const list = this.byOwner.get(d.ownerId as string) ?? [];
    this.byOwner.set(d.ownerId as string, list.filter((id) => id !== d.id));
  }

  private indexTechnician(d: MeasurementDevice): void {
    if (!d.assignedToTechnicianId) return;
    const list = this.byTechnician.get(d.assignedToTechnicianId) ?? [];
    this.byTechnician.set(d.assignedToTechnicianId, [...list, d.id]);
  }

  private indexType(d: MeasurementDevice): void {
    const list = this.byType.get(d.type) ?? [];
    this.byType.set(d.type, [...list, d.id]);
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _devices: DeviceRegistry | null = null;
export function getDevices(): DeviceRegistry {
  if (!_devices) _devices = new DeviceRegistry();
  return _devices;
}
