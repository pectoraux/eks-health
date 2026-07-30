/**
 * Eks-Health Identity — Consent Engine
 *
 * First-class consent platform: granular, purpose-specific, field-level,
 * program-specific, org-specific, time-limited, renewable, expirable,
 * withdrawable, emergency-override framework, history, immutable receipts,
 * versioned.
 *
 * No data leaves the platform without an active, versioned, receipted
 * consent covering the specific purpose AND field being accessed.
 * Sensitive field categories (genetics, mental_health, etc.) cannot be
 * required by programs — they may only be requested as opt-in optional
 * fields, and the user must explicitly approve them.
 */

import "server-only";

import { createHash } from "node:crypto";

import {
  type AccountId,
  type ConsentId,
  type ConsentReceiptId,
  IdentityError,
  asConsentId,
  asConsentReceiptId,
} from "../core";
import { getEventBus, buildEvent, generateId, getClock } from "@/kernel";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ConsentStatus =
  | "pending"
  | "active"
  | "expired"
  | "withdrawn"
  | "revoked"
  | "superseded";

export type ConsentScopeKind = "purpose" | "field" | "program" | "org";

export interface ConsentScope {
  readonly kind: ConsentScopeKind;
  readonly value: string;
}

/**
 * What a program asks for. Programs declare:
 *   - purpose: the data-use purpose (e.g. "research_study_42", "appointment_reminders")
 *   - requestedFields: fields REQUIRED for the purpose (cannot include DENIED_BY_DEFAULT)
 *   - optionalFields: fields the user may OPT INTO (DENIED_BY_DEFAULT must go here)
 *   - deniedFields: fields the program expects to be denied (for transparency)
 */
export interface ConsentPurposeRequest {
  readonly purpose: string;
  readonly requestedFields: readonly string[];
  readonly optionalFields?: readonly string[];
  readonly deniedFields?: readonly string[];
  readonly description?: string;
}

export interface Consent {
  readonly id: ConsentId;
  readonly accountId: AccountId;
  readonly programId: string;
  readonly purpose: string;
  readonly description?: string;
  readonly requestedFields: readonly string[];
  readonly optionalFields: readonly string[];
  readonly deniedFields: readonly string[];
  readonly approvedFields: readonly string[];
  readonly userDeniedFields: readonly string[];
  readonly status: ConsentStatus;
  readonly version: number;
  readonly createdAt: string;
  readonly grantedAt?: string;
  readonly expiresAt?: string;
  readonly revokedAt?: string;
  readonly revokeReason?: string;
  readonly receiptId?: ConsentReceiptId;
}

export type ConsentChangeType =
  | "requested"
  | "granted"
  | "renewed"
  | "revoked"
  | "expired"
  | "modified"
  | "superseded";

export interface ConsentVersion {
  readonly version: number;
  readonly consentId: ConsentId;
  readonly changeType: ConsentChangeType;
  readonly timestamp: string;
  readonly actor: AccountId;
  readonly reason?: string;
  readonly snapshot: Consent;
}

export interface ConsentReceipt {
  readonly id: ConsentReceiptId;
  readonly consentId: ConsentId;
  readonly accountId: AccountId;
  readonly programId: string;
  readonly purpose: string;
  readonly approvedFields: readonly string[];
  readonly deniedFields: readonly string[];
  readonly grantedAt: string;
  readonly expiresAt: string;
  readonly actor: AccountId;
  readonly version: number;
  readonly hash: string; // SHA-256 over receipt contents (excludes the hash itself)
}

export interface EmergencyOverride {
  readonly id: string;
  readonly accountId: AccountId;
  readonly reason: string;
  readonly authorizedBy: AccountId;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly active: boolean;
  readonly revokedAt?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default consent duration: 90 days. */
export const DEFAULT_CONSENT_DURATION_MS = 90 * 24 * 60 * 60 * 1000;

/** Default emergency-override window: 24 hours. */
export const DEFAULT_EMERGENCY_OVERRIDE_MS = 24 * 60 * 60 * 1000;

/**
 * Sensitive field categories that programs CANNOT require — they may only
 * be requested as opt-in optional fields, and the user must explicitly
 * approve them at grant time.
 */
export const DENIED_BY_DEFAULT: ReadonlySet<string> = new Set<string>([
  "blood_pressure",
  "pregnancy_history",
  "mental_health",
  "prescriptions",
  "genetics",
  "hiv_status",
  "reproductive_health",
  "substance_use",
]);

export const CONSENT_EVENTS = {
  requested: "eks.identity.consent.requested",
  granted: "eks.identity.consent.granted",
  revoked: "eks.identity.consent.revoked",
  expired: "eks.identity.consent.expired",
  overridden: "eks.identity.consent.overridden",
} as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function computeReceiptHash(receipt: Omit<ConsentReceipt, "hash">): string {
  // Deterministic serialization — keys sorted, arrays in declared order.
  const payload = JSON.stringify({
    id: receipt.id,
    consentId: receipt.consentId,
    accountId: receipt.accountId,
    programId: receipt.programId,
    purpose: receipt.purpose,
    approvedFields: [...receipt.approvedFields].sort(),
    deniedFields: [...receipt.deniedFields].sort(),
    grantedAt: receipt.grantedAt,
    expiresAt: receipt.expiresAt,
    actor: receipt.actor,
    version: receipt.version,
  });
  return sha256(payload);
}

function assertFieldsValid(label: string, fields: readonly string[]): void {
  for (const f of fields) {
    if (typeof f !== "string" || f.length === 0) {
      throw new IdentityError({
        code: "eks.identity.consent.invalid_field",
        category: "validation",
        message: `Invalid field in ${label}: ${String(f)}`,
        userMessage: "One of the requested fields is invalid.",
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Consent manager
// ---------------------------------------------------------------------------

export class ConsentManager {
  private readonly consents = new Map<ConsentId, Consent>();
  private readonly byAccount = new Map<AccountId, Set<ConsentId>>();
  private readonly byAccountProgram = new Map<string, Set<ConsentId>>(); // `${accountId}::${programId}`
  private readonly receipts = new Map<ConsentReceiptId, ConsentReceipt>();
  private readonly versions = new Map<ConsentId, ConsentVersion[]>();
  private readonly overrides = new Map<string, EmergencyOverride>();
  private readonly overridesByAccount = new Map<AccountId, Set<string>>();

  // ----- Request -----------------------------------------------------------

  /**
   * A program requests consent for a purpose. Creates a pending Consent
   * (status="pending") and returns it so the UI can show the request to
   * the user.
   */
  requestConsent(
    accountId: AccountId,
    request: ConsentPurposeRequest,
    programId: string,
  ): Consent {
    if (!programId) {
      throw new IdentityError({
        code: "eks.identity.consent.invalid_program",
        category: "validation",
        message: "programId is required.",
        userMessage: "A program id is required.",
      });
    }
    if (!request.purpose) {
      throw new IdentityError({
        code: "eks.identity.consent.invalid_purpose",
        category: "validation",
        message: "purpose is required.",
        userMessage: "A purpose is required.",
      });
    }
    assertFieldsValid("requestedFields", [...request.requestedFields]);
    if (request.optionalFields) assertFieldsValid("optionalFields", [...request.optionalFields]);
    if (request.deniedFields) assertFieldsValid("deniedFields", [...request.deniedFields]);

    // DENIED_BY_DEFAULT fields cannot be required — they must be optional.
    const requiredSensitive = request.requestedFields.filter((f) =>
      DENIED_BY_DEFAULT.has(f),
    );
    if (requiredSensitive.length > 0) {
      throw new IdentityError({
        code: "eks.identity.consent.sensitive_required",
        category: "policy_violation",
        message: `Sensitive fields cannot be required: ${requiredSensitive.join(", ")}. Move them to optionalFields.`,
        userMessage:
          "Some requested fields are sensitive and cannot be required. They must be offered as opt-in.",
      });
    }

    const now = getClock().iso();
    const consent: Consent = {
      id: asConsentId(generateId("cns_")),
      accountId,
      programId,
      purpose: request.purpose,
      description: request.description,
      requestedFields: [...request.requestedFields],
      optionalFields: [...(request.optionalFields ?? [])],
      deniedFields: [...(request.deniedFields ?? [])],
      approvedFields: [],
      userDeniedFields: [],
      status: "pending",
      version: 0,
      createdAt: now,
    };
    this.consents.set(consent.id, consent);
    this.indexConsent(consent);
    this.recordVersion(consent, "requested", accountId, "Consent requested");

    void getEventBus().publish(
      buildEvent(
        CONSENT_EVENTS.requested,
        {
          consentId: consent.id,
          accountId,
          programId,
          purpose: request.purpose,
          requestedFields: consent.requestedFields,
          optionalFields: consent.optionalFields,
        },
        {},
        "domain",
      ),
    );
    return consent;
  }

  // ----- Grant -------------------------------------------------------------

  /**
   * User grants (or partially grants / denies) a pending consent request.
   * Activates the consent, issues a ConsentReceipt, records version 1.
   */
  grant(
    consentId: ConsentId,
    approvedFields: readonly string[],
    deniedFields: readonly string[],
    durationMs: number = DEFAULT_CONSENT_DURATION_MS,
    actor: AccountId | null = null,
  ): Consent {
    const c = this.consents.get(consentId);
    if (!c) {
      throw new IdentityError({
        code: "eks.identity.consent.not_found",
        category: "not_found",
        message: `Consent ${consentId} not found.`,
        userMessage: "This consent request no longer exists.",
      });
    }
    if (c.status !== "pending") {
      throw new IdentityError({
        code: "eks.identity.consent.not_pending",
        category: "conflict",
        message: `Consent ${consentId} is in status ${c.status}, not pending.`,
        userMessage: "This consent has already been resolved.",
      });
    }
    assertFieldsValid("approvedFields", [...approvedFields]);
    assertFieldsValid("deniedFields", [...deniedFields]);

    // Approved fields must be a subset of requestedFields ∪ optionalFields.
    const allowed = new Set<string>([...c.requestedFields, ...c.optionalFields]);
    const invalidApprovals = approvedFields.filter((f) => !allowed.has(f));
    if (invalidApprovals.length > 0) {
      throw new IdentityError({
        code: "eks.identity.consent.field_not_requestable",
        category: "validation",
        message: `Cannot approve fields not in the request: ${invalidApprovals.join(", ")}`,
        userMessage: "Some approved fields were not part of the request.",
      });
    }

    // The program's required fields must all be approved OR explicitly denied
    // by the user (denial of a required field means the program will not get
    // the data, which may make the purpose infeasible — but we let the user
    // decide and surface it to the program).
    const approvedSet = new Set(approvedFields);
    const missingRequired = c.requestedFields.filter((f) => !approvedSet.has(f));
    if (missingRequired.length > 0) {
      // Auto-mark missing required fields as user-denied for transparency.
      deniedFields = [...deniedFields, ...missingRequired];
    }

    const now = getClock().iso();
    const expiresAt = new Date(Date.now() + durationMs).toISOString();
    const actorId = actor ?? c.accountId;

    const updated: Consent = {
      ...c,
      approvedFields: [...approvedFields],
      userDeniedFields: [...new Set(deniedFields)],
      status: "active",
      version: 1,
      grantedAt: now,
      expiresAt,
    };

    // Issue receipt first so we can reference it from the consent.
    const receipt = this.issueReceipt(updated, actorId);
    const withReceipt: Consent = { ...updated, receiptId: receipt.id };
    this.consents.set(c.id, withReceipt);
    this.indexConsent(withReceipt);
    this.recordVersion(withReceipt, "granted", actorId, "Consent granted by user");

    void getEventBus().publish(
      buildEvent(
        CONSENT_EVENTS.granted,
        {
          consentId: withReceipt.id,
          accountId: withReceipt.accountId,
          programId: withReceipt.programId,
          purpose: withReceipt.purpose,
          approvedFields: withReceipt.approvedFields,
          expiresAt,
          receiptId: receipt.id,
        },
        {},
        "domain",
      ),
    );
    return withReceipt;
  }

  // ----- Revoke / Withdraw -------------------------------------------------

  /**
   * User withdraws consent. Future access under this consent is denied.
   * The consent is retained in the history (status="withdrawn"); the
   * receipt remains immutable.
   */
  revoke(consentId: ConsentId, reason: string, actor?: AccountId): Consent {
    const c = this.consents.get(consentId);
    if (!c) {
      throw new IdentityError({
        code: "eks.identity.consent.not_found",
        category: "not_found",
        message: `Consent ${consentId} not found.`,
      });
    }
    if (c.status === "withdrawn" || c.status === "revoked") {
      return c; // idempotent
    }
    const now = getClock().iso();
    const actorId = actor ?? c.accountId;
    const updated: Consent = {
      ...c,
      status: "withdrawn",
      revokedAt: now,
      revokeReason: reason,
      version: c.version + 1,
    };
    this.consents.set(c.id, updated);
    this.indexConsent(updated);
    this.recordVersion(updated, "revoked", actorId, reason);

    void getEventBus().publish(
      buildEvent(
        CONSENT_EVENTS.revoked,
        {
          consentId: updated.id,
          accountId: updated.accountId,
          programId: updated.programId,
          reason,
        },
        {},
        "domain",
      ),
    );
    return updated;
  }

  // ----- Renew --------------------------------------------------------------

  /**
   * Extend a consent's duration. Creates a new version and a new receipt
   * (the old receipt is retained as a historical record).
   */
  renew(consentId: ConsentId, durationMs: number, actor?: AccountId): Consent {
    const c = this.consents.get(consentId);
    if (!c) {
      throw new IdentityError({
        code: "eks.identity.consent.not_found",
        category: "not_found",
        message: `Consent ${consentId} not found.`,
      });
    }
    if (c.status !== "active") {
      throw new IdentityError({
        code: "eks.identity.consent.not_active",
        category: "conflict",
        message: `Cannot renew a consent in status ${c.status}.`,
        userMessage: "Only active consents can be renewed.",
      });
    }
    const now = getClock().iso();
    const actorId = actor ?? c.accountId;
    const newExpiresAt = new Date(Date.now() + durationMs).toISOString();
    const updated: Consent = {
      ...c,
      expiresAt: newExpiresAt,
      version: c.version + 1,
    };
    // Issue a new receipt for the renewed period.
    const receipt = this.issueReceipt(updated, actorId);
    const withReceipt: Consent = { ...updated, receiptId: receipt.id };
    this.consents.set(c.id, withReceipt);
    this.indexConsent(withReceipt);
    this.recordVersion(withReceipt, "renewed", actorId, `Renewed for ${durationMs}ms`);

    void getEventBus().publish(
      buildEvent(
        CONSENT_EVENTS.granted,
        {
          consentId: withReceipt.id,
          accountId: withReceipt.accountId,
          programId: withReceipt.programId,
          purpose: withReceipt.purpose,
          renewed: true,
          expiresAt: newExpiresAt,
          receiptId: receipt.id,
        },
        {},
        "domain",
      ),
    );
    return withReceipt;
  }

  // ----- Expire -------------------------------------------------------------

  /**
   * Sweep expired consents. Called by the scheduler. Returns the number
   * of consents transitioned to "expired".
   */
  expire(): number {
    const now = Date.now();
    let n = 0;
    for (const [id, c] of this.consents) {
      if (c.status !== "active") continue;
      if (!c.expiresAt) continue;
      if (new Date(c.expiresAt).getTime() <= now) {
        const updated: Consent = {
          ...c,
          status: "expired",
          version: c.version + 1,
        };
        this.consents.set(id, updated);
        this.indexConsent(updated);
        this.recordVersion(updated, "expired", c.accountId, "Consent expired");
        void getEventBus().publish(
          buildEvent(
            CONSENT_EVENTS.expired,
            {
              consentId: id,
              accountId: c.accountId,
              programId: c.programId,
              expiredAt: c.expiresAt,
            },
            {},
            "domain",
          ),
        );
        n++;
      }
    }
    return n;
  }

  // ----- Query --------------------------------------------------------------

  getActiveConsents(accountId: AccountId, programId?: string): readonly Consent[] {
    let ids: Set<ConsentId>;
    if (programId) {
      ids = this.byAccountProgram.get(`${accountId}::${programId}`) ?? new Set();
    } else {
      ids = this.byAccount.get(accountId) ?? new Set();
    }
    const now = Date.now();
    return [...ids]
      .map((id) => this.consents.get(id)!)
      .filter((c) => c && c.status === "active" && c.expiresAt && new Date(c.expiresAt).getTime() > now);
  }

  getConsent(id: ConsentId): Consent | undefined {
    return this.consents.get(id);
  }

  listConsents(accountId?: AccountId): readonly Consent[] {
    if (accountId) {
      const ids = this.byAccount.get(accountId) ?? new Set();
      return [...ids].map((id) => this.consents.get(id)!).filter(Boolean);
    }
    return [...this.consents.values()];
  }

  /**
   * The real data-gateway access check.
   * Returns true iff there is an active consent covering:
   *   - accountId
   *   - programId
   *   - purpose
   *   - field (field ∈ approvedFields)
   * OR an active emergency override exists for the account.
   */
  checkAccess(
    accountId: AccountId,
    programId: string,
    purpose: string,
    field?: string,
  ): boolean {
    // Emergency override short-circuits (heavily audited at creation).
    if (this.hasActiveOverride(accountId)) {
      return true;
    }
    const active = this.getActiveConsents(accountId, programId);
    for (const c of active) {
      if (c.purpose !== purpose) continue;
      if (field && !c.approvedFields.includes(field)) continue;
      return true;
    }
    return false;
  }

  // ----- History / Receipts -------------------------------------------------

  getHistory(accountId: AccountId): readonly ConsentVersion[] {
    const ids = this.byAccount.get(accountId) ?? new Set();
    const all: ConsentVersion[] = [];
    for (const id of ids) {
      const versions = this.versions.get(id);
      if (versions) all.push(...versions);
    }
    return all.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }

  getVersions(consentId: ConsentId): readonly ConsentVersion[] {
    return this.versions.get(consentId) ?? [];
  }

  getReceipt(receiptId: ConsentReceiptId): ConsentReceipt | undefined {
    return this.receipts.get(receiptId);
  }

  listReceipts(accountId?: AccountId): readonly ConsentReceipt[] {
    if (!accountId) return [...this.receipts.values()];
    return [...this.receipts.values()].filter((r) => r.accountId === accountId);
  }

  // ----- Emergency override -------------------------------------------------

  /**
   * Create a time-bound emergency override that bypasses consent for the
   * account. Used for medical emergencies (e.g. unconscious patient). The
   * override is heavily audited and expires automatically.
   */
  emergencyOverride(
    accountId: AccountId,
    reason: string,
    authorizedBy: AccountId,
    durationMs: number = DEFAULT_EMERGENCY_OVERRIDE_MS,
  ): EmergencyOverride {
    if (!reason) {
      throw new IdentityError({
        code: "eks.identity.consent.override_no_reason",
        category: "validation",
        message: "Emergency override requires a reason.",
        userMessage: "A reason is required for an emergency override.",
      });
    }
    const now = getClock().iso();
    const expiresAt = new Date(Date.now() + durationMs).toISOString();
    const override: EmergencyOverride = {
      id: generateId("eov_"),
      accountId,
      reason,
      authorizedBy,
      createdAt: now,
      expiresAt,
      active: true,
    };
    this.overrides.set(override.id, override);
    const set = this.overridesByAccount.get(accountId) ?? new Set();
    set.add(override.id);
    this.overridesByAccount.set(accountId, set);

    void getEventBus().publish(
      buildEvent(
        CONSENT_EVENTS.overridden,
        {
          overrideId: override.id,
          accountId,
          authorizedBy,
          reason,
          expiresAt,
        },
        {},
        "domain",
      ),
    );
    return override;
  }

  revokeOverride(overrideId: string): EmergencyOverride | undefined {
    const o = this.overrides.get(overrideId);
    if (!o) return undefined;
    const updated: EmergencyOverride = {
      ...o,
      active: false,
      revokedAt: getClock().iso(),
    };
    this.overrides.set(overrideId, updated);
    return updated;
  }

  listOverrides(accountId?: AccountId): readonly EmergencyOverride[] {
    if (!accountId) return [...this.overrides.values()];
    const set = this.overridesByAccount.get(accountId) ?? new Set();
    return [...set].map((id) => this.overrides.get(id)!).filter(Boolean);
  }

  hasActiveOverride(accountId: AccountId): boolean {
    const set = this.overridesByAccount.get(accountId);
    if (!set) return false;
    const now = Date.now();
    for (const id of set) {
      const o = this.overrides.get(id);
      if (o && o.active && new Date(o.expiresAt).getTime() > now) return true;
    }
    return false;
  }

  // ----- Internals ----------------------------------------------------------

  private indexConsent(c: Consent): void {
    let byAcct = this.byAccount.get(c.accountId);
    if (!byAcct) {
      byAcct = new Set();
      this.byAccount.set(c.accountId, byAcct);
    }
    byAcct.add(c.id);
    const key = `${c.accountId}::${c.programId}`;
    let byAcctProg = this.byAccountProgram.get(key);
    if (!byAcctProg) {
      byAcctProg = new Set();
      this.byAccountProgram.set(key, byAcctProg);
    }
    byAcctProg.add(c.id);
  }

  private recordVersion(
    consent: Consent,
    changeType: ConsentChangeType,
    actor: AccountId,
    reason?: string,
  ): void {
    const list = this.versions.get(consent.id) ?? [];
    const v: ConsentVersion = {
      version: consent.version,
      consentId: consent.id,
      changeType,
      timestamp: getClock().iso(),
      actor,
      reason,
      snapshot: consent,
    };
    list.push(v);
    this.versions.set(consent.id, list);
  }

  private issueReceipt(consent: Consent, actor: AccountId): ConsentReceipt {
    const id = asConsentReceiptId(generateId("rcp_"));
    const partial: Omit<ConsentReceipt, "hash"> = {
      id,
      consentId: consent.id,
      accountId: consent.accountId,
      programId: consent.programId,
      purpose: consent.purpose,
      approvedFields: [...consent.approvedFields],
      deniedFields: [...consent.userDeniedFields, ...consent.deniedFields],
      grantedAt: consent.grantedAt ?? getClock().iso(),
      expiresAt: consent.expiresAt ?? "",
      actor,
      version: consent.version,
    };
    const hash = computeReceiptHash(partial);
    const receipt: ConsentReceipt = { ...partial, hash };
    this.receipts.set(id, receipt);
    return receipt;
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _mgr: ConsentManager | null = null;
export function getConsent(): ConsentManager {
  if (!_mgr) _mgr = new ConsentManager();
  return _mgr;
}
export function setConsent(m: ConsentManager): void {
  _mgr = m;
}
export function resetConsent(): void {
  _mgr = null;
}
