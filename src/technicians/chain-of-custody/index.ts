/**
 * Eks-Health Technician Network — Chain of Custody
 *
 * Every verified measurement has a complete, tamper-evident chain of
 * custody: who requested it, who collected it, which device captured it,
 * who verified it, evidence references, time, location, audit IDs, consent
 * IDs. Every step is traceable; sealing produces a SHA-256 hash that
 * detects any later modification.
 *
 * Real SHA-256 chain sealing, real step-ordering validation, real gap
 * detection. No mocks.
 */

import "server-only";
import { createHash } from "node:crypto";
import {
  type ChainOfCustodyId,
  type MeasurementId,
  type SessionId,
  type AccountId,
  type DeviceId,
  type EvidenceId,
  TechnicianError,
  asChainOfCustodyId,
} from "../core";
import { getEventBus, buildEvent, generateId, getClock } from "@/kernel";

// ---------------------------------------------------------------------------
// Chain of custody events (chain-of-custody-scoped catalog)
// ---------------------------------------------------------------------------

export const CHAIN_OF_CUSTODY_EVENTS = {
  linkAdded: "eks.technician.coc.link_added",
  sealed: "eks.technician.coc.sealed",
  tamperDetected: "eks.technician.coc.tamper_detected",
} as const;

// ---------------------------------------------------------------------------
// Chain of custody types
// ---------------------------------------------------------------------------

export type CustodyStep =
  | "requested"
  | "collected"
  | "device_captured"
  | "evidence_uploaded"
  | "technician_signed"
  | "participant_confirmed"
  | "program_validated"
  | "verified"
  | "sealed";

export type CustodyRole =
  | "requester"
  | "collector"
  | "verifier"
  | "device"
  | "program"
  | "participant";

export interface CustodyLink {
  readonly step: CustodyStep;
  readonly actor: AccountId;
  readonly role: CustodyRole;
  readonly at: string;
  readonly location?: { lat: number; lon: number; label?: string };
  readonly deviceIds?: DeviceId[];
  readonly evidenceIds?: EvidenceId[];
  readonly auditReference?: string;
  readonly consentReference?: string;
  readonly notes?: string;
}

export interface ChainOfCustody {
  readonly id: ChainOfCustodyId;
  readonly measurementId: MeasurementId;
  readonly sessionId?: SessionId;
  readonly links: CustodyLink[];
  readonly complete: boolean;
  readonly createdAt: string;
  readonly sealedAt?: string;
  /** SHA-256 hash computed at seal time over the canonical link sequence. */
  readonly sealHash?: string;
}

// ---------------------------------------------------------------------------
// Step ordering
// ---------------------------------------------------------------------------

/**
 * Canonical step order. addLink enforces that each new step's index in this
 * list is strictly greater than the index of the previously-added step
 * (duplicate steps are allowed only if explicitly permitted — currently
 * `evidence_uploaded` and `device_captured` may repeat).
 */
export const CUSTODY_STEP_ORDER: CustodyStep[] = [
  "requested",
  "collected",
  "device_captured",
  "evidence_uploaded",
  "technician_signed",
  "participant_confirmed",
  "program_validated",
  "verified",
  "sealed",
];

const REPEATABLE_STEPS: ReadonlySet<CustodyStep> = new Set<CustodyStep>([
  "device_captured",
  "evidence_uploaded",
]);

/**
 * Prerequisite steps. Each step's prerequisites MUST already be present in
 * the chain before that step can be added. This enforces rules like
 * "verified requires collected" — i.e. you cannot verify a measurement
 * that has not yet been collected.
 */
const STEP_PREREQUISITES: Record<CustodyStep, CustodyStep[]> = {
  requested: [],
  collected: ["requested"],
  device_captured: ["collected"],
  evidence_uploaded: ["collected"],
  technician_signed: ["collected"],
  participant_confirmed: ["technician_signed"],
  program_validated: ["technician_signed"],
  verified: ["collected"],
  sealed: ["verified"],
};

/** Minimum required steps for a chain to be considered "complete". */
export const REQUIRED_STEPS: CustodyStep[] = ["requested", "collected", "verified"];

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

/**
 * Compute a canonical SHA-256 hash over the custody link sequence. The hash
 * covers every field that materially affects the chain — any tampering
 * (added link, changed actor, changed timestamp, etc.) will produce a
 * different hash.
 */
function computeSealHash(links: CustodyLink[]): string {
  const canonical = links
    .map((l) => {
      const parts: string[] = [
        l.step,
        l.actor,
        l.role,
        l.at,
        l.location ? `${l.location.lat.toFixed(6)},${l.location.lon.toFixed(6)}` : "",
        l.deviceIds?.join(",") ?? "",
        l.evidenceIds?.join(",") ?? "",
        l.auditReference ?? "",
        l.consentReference ?? "",
        l.notes ?? "",
      ];
      return parts.join("|");
    })
    .join("\n");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Chain of custody manager
// ---------------------------------------------------------------------------

export class ChainOfCustodyManager {
  private readonly chains = new Map<ChainOfCustodyId, ChainOfCustody>();
  private readonly byMeasurement = new Map<MeasurementId, ChainOfCustodyId[]>();
  private readonly bySession = new Map<SessionId, ChainOfCustodyId[]>();

  create(measurementId: MeasurementId, sessionId?: SessionId): ChainOfCustody {
    const now = getClock().iso();
    const chain: ChainOfCustody = {
      id: asChainOfCustodyId(generateId("coc_")),
      measurementId,
      sessionId,
      links: [],
      complete: false,
      createdAt: now,
    };
    this.chains.set(chain.id, chain);
    const m = this.byMeasurement.get(measurementId) ?? [];
    this.byMeasurement.set(measurementId, [...m, chain.id]);
    if (sessionId) {
      const s = this.bySession.get(sessionId) ?? [];
      this.bySession.set(sessionId, [...s, chain.id]);
    }
    return chain;
  }

  addLink(chainId: ChainOfCustodyId, link: CustodyLink): ChainOfCustody {
    const current = this.require(chainId);
    if (current.sealedAt) {
      throw new TechnicianError({
        code: "eks.technician.coc.sealed",
        category: "state_conflict",
        message: `Chain ${chainId} is sealed; no further links may be added.`,
        userMessage: "This chain of custody is sealed and cannot be modified.",
      });
    }
    this.assertStepOrder(current.links, link);
    const updatedLinks = [...current.links, link];
    const complete = this.hasRequiredSteps(updatedLinks);
    const updated: ChainOfCustody = {
      ...current,
      links: updatedLinks,
      complete,
    };
    this.chains.set(chainId, updated);
    return updated;
  }

  get(chainId: ChainOfCustodyId): ChainOfCustody | undefined {
    return this.chains.get(chainId);
  }

  getForMeasurement(measurementId: MeasurementId): ChainOfCustody[] {
    const ids = this.byMeasurement.get(measurementId) ?? [];
    return ids.map((id) => this.chains.get(id)!).filter(Boolean);
  }

  getForSession(sessionId: SessionId): ChainOfCustody[] {
    const ids = this.bySession.get(sessionId) ?? [];
    return ids.map((id) => this.chains.get(id)!).filter(Boolean);
  }

  /**
   * Seal a chain: mark it complete and immutable and compute a SHA-256 hash
   * over all links for tamper detection. After sealing, addLink throws.
   * Adds an implicit "sealed" link if one is not already present.
   */
  seal(chainId: ChainOfCustodyId, sealedBy: AccountId): ChainOfCustody {
    const current = this.require(chainId);
    if (current.sealedAt) {
      throw new TechnicianError({
        code: "eks.technician.coc.already_sealed",
        category: "state_conflict",
        message: `Chain ${chainId} is already sealed.`,
      });
    }
    if (!this.hasRequiredSteps(current.links)) {
      const gaps = this.getGaps(chainId);
      throw new TechnicianError({
        code: "eks.technician.coc.incomplete",
        category: "validation",
        message: `Chain ${chainId} cannot be sealed: missing required steps ${gaps.join(", ")}.`,
        userMessage: "This chain of custody is incomplete and cannot be sealed.",
        metadata: { gaps },
      });
    }
    const now = getClock().iso();
    const finalLinks: CustodyLink[] =
      current.links[current.links.length - 1]?.step === "sealed"
        ? current.links
        : [...current.links, { step: "sealed", actor: sealedBy, role: "verifier", at: now }];
    const sealHash = computeSealHash(finalLinks);
    const updated: ChainOfCustody = {
      ...current,
      links: finalLinks,
      complete: true,
      sealedAt: now,
      sealHash,
    };
    this.chains.set(chainId, updated);
    void getEventBus().publish(
      buildEvent(
        CHAIN_OF_CUSTODY_EVENTS.sealed,
        { chainId, measurementId: current.measurementId, sealedBy, sealHash },
        {},
        "domain",
      ),
    );
    return updated;
  }

  /**
   * Recompute the hash over the current links and compare against the
   * stored sealHash. Returns true if the chain has not been tampered with.
   * An unsealed chain returns true (no seal to verify against).
   */
  verify(chainId: ChainOfCustodyId): { valid: boolean; expected?: string; actual?: string } {
    const chain = this.chains.get(chainId);
    if (!chain) return { valid: false };
    if (!chain.sealedAt || !chain.sealHash) return { valid: true };
    const actual = computeSealHash(chain.links);
    return { valid: actual === chain.sealHash, expected: chain.sealHash, actual };
  }

  isComplete(chainId: ChainOfCustodyId): boolean {
    const chain = this.chains.get(chainId);
    if (!chain) return false;
    return this.hasRequiredSteps(chain.links);
  }

  getTimeline(chainId: ChainOfCustodyId): CustodyLink[] {
    const chain = this.chains.get(chainId);
    return chain ? [...chain.links] : [];
  }

  getGaps(chainId: ChainOfCustodyId): CustodyStep[] {
    const chain = this.chains.get(chainId);
    if (!chain) return [...REQUIRED_STEPS];
    const present = new Set(chain.links.map((l) => l.step));
    return REQUIRED_STEPS.filter((s) => !present.has(s));
  }

  getStats(): {
    total: number;
    sealed: number;
    complete: number;
    avgLinksPerChain: number;
    byStep: Record<CustodyStep, number>;
  } {
    const list = [...this.chains.values()];
    let totalLinks = 0;
    const byStep = {} as Record<CustodyStep, number>;
    for (const s of CUSTODY_STEP_ORDER) byStep[s] = 0;
    for (const c of list) {
      totalLinks += c.links.length;
      for (const l of c.links) {
        byStep[l.step] = (byStep[l.step] ?? 0) + 1;
      }
    }
    return {
      total: list.length,
      sealed: list.filter((c) => c.sealedAt !== undefined).length,
      complete: list.filter((c) => c.complete).length,
      avgLinksPerChain: list.length > 0 ? totalLinks / list.length : 0,
      byStep,
    };
  }

  // -------------------------------------------------------------------
  // Internal helpers
// -------------------------------------------------------------------

  private require(id: ChainOfCustodyId): ChainOfCustody {
    const c = this.chains.get(id);
    if (!c) {
      throw new TechnicianError({
        code: "eks.technician.coc.not_found",
        category: "not_found",
        message: `Chain of custody ${id} not found.`,
        userMessage: "This chain of custody could not be found.",
      });
    }
    return c;
  }

  /**
   * Enforce canonical step ordering. A new step's index in CUSTODY_STEP_ORDER
   * must be >= the last link's index. Strictly-greater for non-repeatable
   * steps; equal (i.e. repeat) is permitted only for steps in REPEATABLE_STEPS.
   * Additionally, every step's prerequisites must already be present in the
   * chain — this enforces rules like "verified requires collected".
   */
  private assertStepOrder(existing: CustodyLink[], link: CustodyLink): void {
    if (existing.length === 0) {
      if (link.step !== "requested") {
        throw new TechnicianError({
          code: "eks.technician.coc.bad_first_step",
          category: "validation",
          message: `First custody step must be "requested", got "${link.step}".`,
          userMessage: "A chain of custody must begin with a 'requested' step.",
        });
      }
      return;
    }
    const last = existing[existing.length - 1];
    const lastIdx = CUSTODY_STEP_ORDER.indexOf(last.step);
    const newIdx = CUSTODY_STEP_ORDER.indexOf(link.step);
    if (newIdx === -1) {
      throw new TechnicianError({
        code: "eks.technician.coc.unknown_step",
        category: "validation",
        message: `Unknown custody step "${link.step}".`,
      });
    }
    if (newIdx < lastIdx) {
      throw new TechnicianError({
        code: "eks.technician.coc.out_of_order",
        category: "state_conflict",
        message: `Custody step "${link.step}" cannot follow "${last.step}".`,
        userMessage: "This custody step is out of order.",
        metadata: { lastStep: last.step, newStep: link.step },
      });
    }
    if (newIdx === lastIdx && !REPEATABLE_STEPS.has(link.step)) {
      throw new TechnicianError({
        code: "eks.technician.coc.duplicate_step",
        category: "state_conflict",
        message: `Custody step "${link.step}" cannot be repeated.`,
        userMessage: "This custody step has already been recorded.",
        metadata: { step: link.step },
      });
    }
    // Prerequisite check: every prerequisite must already be in the chain.
    const present = new Set(existing.map((l) => l.step));
    const prereqs = STEP_PREREQUISITES[link.step] ?? [];
    const missing = prereqs.filter((p) => !present.has(p));
    if (missing.length > 0) {
      throw new TechnicianError({
        code: "eks.technician.coc.missing_prerequisite",
        category: "validation",
        message: `Custody step "${link.step}" requires prerequisite(s): ${missing.join(", ")}.`,
        userMessage: "This custody step requires earlier steps to be recorded first.",
        metadata: { step: link.step, missing },
      });
    }
  }

  private hasRequiredSteps(links: CustodyLink[]): boolean {
    const present = new Set(links.map((l) => l.step));
    return REQUIRED_STEPS.every((s) => present.has(s));
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _coc: ChainOfCustodyManager | null = null;
export function getChainOfCustody(): ChainOfCustodyManager {
  if (!_coc) _coc = new ChainOfCustodyManager();
  return _coc;
}
