/**
 * Eks-Health Universal Health Data Platform — Evidence Framework
 *
 * Measurements may require evidence: images, video, medical reports, lab
 * docs, machine output, sensor logs, digital signatures, certificates,
 * supporting documents. Programs determine required evidence; the platform
 * securely stores and verifies it.
 */

import "server-only";
import { createHash } from "node:crypto";
import {
  type EvidenceId,
  type EvidenceType,
  type AccountId,
  HealthError,
  asEvidenceId,
} from "../core";
import { getEventBus, buildEvent, generateId, getClock } from "@/kernel";
import { HEALTH_EVENTS } from "../core";

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

export interface Evidence {
  readonly id: EvidenceId;
  readonly type: EvidenceType;
  readonly measurementId?: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly storageKey: string;
  readonly hash: string; // SHA-256
  readonly uploadedBy: AccountId;
  readonly uploadedAt: string;
  readonly verified: boolean;
  readonly verifiedBy?: AccountId;
  readonly verifiedAt?: string;
  readonly metadata?: Record<string, unknown>;
  readonly description?: string;
}

export interface EvidenceUpload {
  readonly type: EvidenceType;
  readonly measurementId?: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly content: Buffer | string;
  readonly uploadedBy: AccountId;
  readonly description?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface EvidenceRequirement {
  readonly type: EvidenceType;
  readonly required: boolean;
  readonly minCount: number;
  readonly description?: string;
}

// ---------------------------------------------------------------------------
// Evidence manager
// ---------------------------------------------------------------------------

export class EvidenceManager {
  private readonly evidence = new Map<EvidenceId, Evidence>();
  private readonly byMeasurement = new Map<string, EvidenceId[]>();
  private readonly contentCache = new Map<EvidenceId, Buffer>(); // for integrity verification

  upload(input: EvidenceUpload): Evidence {
    const content = typeof input.content === "string" ? Buffer.from(input.content) : input.content;
    const hash = createHash("sha256").update(content).digest("hex");
    const storageKey = `evidence/${generateId("ev_")}/${input.filename}`;
    const evidence: Evidence = {
      id: asEvidenceId(generateId("evd_")),
      type: input.type,
      measurementId: input.measurementId,
      filename: input.filename,
      mimeType: input.mimeType,
      sizeBytes: content.length,
      storageKey,
      hash,
      uploadedBy: input.uploadedBy,
      uploadedAt: getClock().iso(),
      verified: false,
      description: input.description,
      metadata: input.metadata,
    };
    this.evidence.set(evidence.id, evidence);
    this.contentCache.set(evidence.id, content);
    if (input.measurementId) {
      const list = this.byMeasurement.get(input.measurementId) ?? [];
      this.byMeasurement.set(input.measurementId, [...list, evidence.id]);
    }
    void getEventBus().publish(buildEvent(HEALTH_EVENTS.evidenceUploaded, { evidenceId: evidence.id, type: input.type, measurementId: input.measurementId }, {}, "domain"));
    return evidence;
  }

  get(id: EvidenceId): Evidence | undefined {
    return this.evidence.get(id);
  }

  getContent(id: EvidenceId): Buffer | undefined {
    return this.contentCache.get(id);
  }

  list(measurementId?: string): Evidence[] {
    if (measurementId) {
      const ids = this.byMeasurement.get(measurementId) ?? [];
      return ids.map((id) => this.evidence.get(id)!).filter(Boolean);
    }
    return [...this.evidence.values()];
  }

  listByType(type: EvidenceType): Evidence[] {
    return [...this.evidence.values()].filter((e) => e.type === type);
  }

  verify(id: EvidenceId, verifiedBy: AccountId): Evidence {
    const e = this.evidence.get(id);
    if (!e) throw new HealthError({ code: "eks.health.evidence.not_found", category: "not_found", message: "Evidence not found." });
    const updated: Evidence = { ...e, verified: true, verifiedBy, verifiedAt: getClock().iso() };
    this.evidence.set(id, updated);
    void getEventBus().publish(buildEvent(HEALTH_EVENTS.evidenceVerified, { evidenceId: id, verifiedBy }, {}, "domain"));
    return updated;
  }

  /** Check that all required evidence is present and verified. */
  checkRequirements(measurementId: string, requirements: EvidenceRequirement[]): { satisfied: boolean; missing: EvidenceRequirement[]; unverified: Evidence[] } {
    const evidence = this.list(measurementId);
    const missing: EvidenceRequirement[] = [];
    const unverified: Evidence[] = [];
    for (const req of requirements) {
      if (!req.required) continue;
      const matching = evidence.filter((e) => e.type === req.type);
      if (matching.length < req.minCount) {
        missing.push(req);
        continue;
      }
      const unverifiedMatching = matching.filter((e) => !e.verified);
      if (unverifiedMatching.length > 0) {
        unverified.push(...unverifiedMatching);
      }
    }
    return { satisfied: missing.length === 0 && unverified.length === 0, missing, unverified };
  }

  getHash(id: EvidenceId): string | undefined {
    return this.evidence.get(id)?.hash;
  }

  /** Re-compute hash from stored content and compare — tamper detection. */
  verifyIntegrity(id: EvidenceId): boolean {
    const e = this.evidence.get(id);
    if (!e) return false;
    const content = this.contentCache.get(id);
    if (!content) return false;
    const recomputed = createHash("sha256").update(content).digest("hex");
    return recomputed === e.hash;
  }

  delete(id: EvidenceId): void {
    const e = this.evidence.get(id);
    if (!e) return;
    this.evidence.delete(id);
    this.contentCache.delete(id);
    if (e.measurementId) {
      const list = this.byMeasurement.get(e.measurementId) ?? [];
      this.byMeasurement.set(e.measurementId, list.filter((x) => x !== id));
    }
  }

  getStats(): { total: number; verified: number; byType: Record<string, number> } {
    const list = [...this.evidence.values()];
    const byType: Record<string, number> = {};
    let verified = 0;
    for (const e of list) {
      byType[e.type] = (byType[e.type] ?? 0) + 1;
      if (e.verified) verified++;
    }
    return { total: list.length, verified, byType };
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _mgr: EvidenceManager | null = null;
export function getEvidence(): EvidenceManager {
  if (!_mgr) _mgr = new EvidenceManager();
  return _mgr;
}
