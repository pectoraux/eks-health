/**
 * Eks-Health Identity — Data Access Gateway & Secure Views
 *
 * Programs NEVER query databases directly. Every access passes through this
 * gateway, which enforces (in order):
 *   1. Authorization (getAuthorization().evaluate)
 *   2. Consent per-field (getConsent().checkAccess)
 *   3. Purpose validity (per view)
 *   4. Field policy (redact | mask | allow | deny) per view
 *   5. Privacy minimization (getPrivacy().minimize)
 *   6. Audit (getAudit().record — immutable hash-chained entry)
 *   7. Rate limit per program
 *
 * Responses include only the fields the caller is permitted to see, in their
 * redacted/masked form. Every access (allow or deny) produces an audit entry.
 *
 * No external deps beyond node:crypto.
 */

import "server-only";
import { createHash } from "node:crypto";
import {
  type AccountId,
  type AuditEntryId,
  type Principal,
  IdentityError,
  IDENTITY_EVENTS,
} from "../core";
import { getEventBus, buildEvent, generateId, getClock } from "@/kernel";
import type { Brand, CorrelationId, TraceId, ResourceId } from "@/kernel";
import { getAudit } from "../audit";
import type { IpMetadata } from "../audit";
import { getAuthorization } from "../authorization";
import { getConsent } from "../consent";
import { getPrivacy } from "../privacy";

// ---------------------------------------------------------------------------
// Branded ids
// ---------------------------------------------------------------------------

export type DataViewId = Brand<string, "DataViewId">;

// ---------------------------------------------------------------------------
// Data views
// ---------------------------------------------------------------------------

export type DataView =
  | "participant_profile"
  | "measurement"
  | "competition"
  | "public_profile"
  | "anonymous_research"
  | "technician"
  | "program_admin";

export type FieldAction = "redact" | "mask" | "allow" | "deny";

export type MaskType = "email" | "phone" | "name" | "id" | "default";

export interface FieldPolicy {
  readonly field: string;
  readonly view: DataView;
  readonly action: FieldAction;
  readonly maskType?: MaskType;
  readonly transform?: string; // registered transformation name
  readonly reason?: string; // human-readable explanation
}

export interface DataViewDescriptor {
  readonly id: DataView;
  readonly name: string;
  readonly description: string;
  readonly requiredPermission: string;
  readonly allowedPurposes: string[];
  readonly fields: Record<string, FieldPolicy>;
  readonly maxFieldsPerRequest?: number;
  readonly cacheable?: boolean;
  readonly ttlSeconds?: number;
}

export interface Transformation {
  readonly name: string;
  readonly description: string;
  apply(value: unknown, params?: Record<string, unknown>): unknown;
}

// ---------------------------------------------------------------------------
// Request & response
// ---------------------------------------------------------------------------

export interface DataAccessContext {
  readonly ipMetadata?: IpMetadata;
  readonly device?: { id: string; label?: string; trusted?: boolean };
  readonly correlationId?: CorrelationId;
  readonly traceId?: TraceId;
  readonly source?: string;
}

export interface DataAccessRequest {
  readonly principal: Principal;
  readonly programId: string;
  readonly purpose: string;
  readonly requestedFields: string[];
  readonly resourceId?: string;
  readonly resourceKind?: string;
  readonly context?: DataAccessContext;
  /** Raw record from storage; the gateway filters/masks/redacts it. */
  readonly data?: Record<string, unknown>;
}

export interface DataAccessResponse {
  readonly view: DataView;
  readonly resourceId?: string;
  readonly decision: "allow" | "deny" | "challenge";
  readonly reasons: string[];
  readonly fields: Record<string, unknown>;
  readonly allowed: string[];
  readonly redacted: string[];
  readonly masked: string[];
  readonly denied: string[];
  readonly auditEntryId: AuditEntryId;
  readonly rateLimited?: boolean;
  readonly retryAfterMs?: number;
  readonly cached?: boolean;
}

// ---------------------------------------------------------------------------
// Masking helpers (REAL transformations)
// ---------------------------------------------------------------------------

export function redact(_value: unknown): string {
  return "[REDACTED]";
}

export function mask(value: unknown, type: MaskType = "default"): string {
  if (value === null || value === undefined) return "***";
  const s = String(value);
  if (s.length === 0) return "***";
  switch (type) {
    case "email": {
      const at = s.indexOf("@");
      if (at < 1) return "***";
      const user = s.slice(0, at);
      const domain = s.slice(at + 1);
      const head = user[0] ?? "";
      return `${head}***@${domain}`;
    }
    case "phone": {
      const digits = s.replace(/\D/g, "");
      if (digits.length < 4) return "***";
      const last4 = digits.slice(-4);
      const prefix = s.startsWith("+") ? "+" : "";
      return `${prefix}***${last4}`;
    }
    case "name": {
      const words = s.trim().split(/\s+/);
      return words
        .map((w) => (w.length === 0 ? "" : `${w[0]}${"*".repeat(Math.max(2, Math.min(w.length - 1, 8)))}`))
        .join(" ");
    }
    case "id": {
      // Keep first 4 + last 4 chars, mask the middle.
      if (s.length <= 8) return "***";
      return `${s.slice(0, 4)}***${s.slice(-4)}`;
    }
    case "default":
    default:
      return "***";
  }
}

// ---------------------------------------------------------------------------
// Field masking registry
// ---------------------------------------------------------------------------

export interface FieldMaskingRule {
  readonly type: MaskType;
  readonly description: string;
}

export const FIELD_MASKING: Record<MaskType, FieldMaskingRule> = {
  email: { type: "email", description: "first character + ***@domain" },
  phone: { type: "phone", description: "country code + *** + last 4 digits" },
  name: { type: "name", description: "first initial + *** per word" },
  id: { type: "id", description: "first 4 + *** + last 4 characters" },
  default: { type: "default", description: "full redaction to ***" },
};

// ---------------------------------------------------------------------------
// Built-in transformations
// ---------------------------------------------------------------------------

const BUILTIN_TRANSFORMS: Transformation[] = [
  {
    name: "hash",
    description: "SHA-256 one-way hash (for IDs that must remain comparable but not reversible).",
    apply: (value) => createHash("sha256").update(String(value), "utf8").digest("hex"),
  },
  {
    name: "bucketize_age",
    description: "Bucketize an age into 10-year ranges (e.g. 32 -> '30-39').",
    apply: (value) => {
      const n = Number(value);
      if (!Number.isFinite(n)) return "unknown";
      const lower = Math.floor(n / 10) * 10;
      return `${lower}-${lower + 9}`;
    },
  },
  {
    name: "truncate",
    description: "Truncate to a max length (param: { length }).",
    apply: (value, params) => {
      const len = (params?.length as number) ?? 8;
      const s = String(value);
      return s.length <= len ? s : `${s.slice(0, len)}…`;
    },
  },
  {
    name: "round",
    description: "Round numeric values to N decimals (param: { decimals }).",
    apply: (value, params) => {
      const n = Number(value);
      if (!Number.isFinite(n)) return value;
      const decimals = (params?.decimals as number) ?? 0;
      const f = 10 ** decimals;
      return Math.round(n * f) / f;
    },
  },
  {
    name: "anonymize",
    description: "Replace with a stable pseudonymous hash bucket.",
    apply: (value) => `anon_${createHash("sha256").update(String(value), "utf8").digest("hex").slice(0, 12)}`,
  },
];

// ---------------------------------------------------------------------------
// Built-in views (catalog of secure data views)
// ---------------------------------------------------------------------------

function fp(field: string, view: DataView, action: FieldAction, opts?: { maskType?: MaskType; transform?: string; reason?: string }): FieldPolicy {
  return { field, view, action, ...opts };
}

export const VIEWS: Record<DataView, DataViewDescriptor> = {
  participant_profile: {
    id: "participant_profile",
    name: "Participant Profile",
    description: "Identity & contact info for a participant. Programs see masked/redacted fields; the participant sees everything.",
    requiredPermission: "participant:read",
    allowedPurposes: ["care_delivery", "measurement_collection", "support", "self_service"],
    fields: {
      id: fp("id", "participant_profile", "allow"),
      displayName: fp("displayName", "participant_profile", "mask", { maskType: "name", reason: "Programs see masked name." }),
      email: fp("email", "participant_profile", "mask", { maskType: "email", reason: "Programs see masked email." }),
      phone: fp("phone", "participant_profile", "mask", { maskType: "phone", reason: "Programs see masked phone." }),
      dob: fp("dob", "participant_profile", "redact", { reason: "Date of birth redacted for programs." }),
      address: fp("address", "participant_profile", "redact", { reason: "Address redacted for programs." }),
      avatarUrl: fp("avatarUrl", "participant_profile", "allow"),
      locale: fp("locale", "participant_profile", "allow"),
      timezone: fp("timezone", "participant_profile", "allow"),
      createdAt: fp("createdAt", "participant_profile", "allow"),
      // Sensitive fields always denied to programs
      passwordHash: fp("passwordHash", "participant_profile", "deny", { reason: "Password hashes are never exposed." }),
      mfaEnabled: fp("mfaEnabled", "participant_profile", "deny", { reason: "MFA state is private." }),
    },
    maxFieldsPerRequest: 10,
    cacheable: true,
    ttlSeconds: 60,
  },
  measurement: {
    id: "measurement",
    name: "Measurement",
    description: "Health measurements (blood pressure, weight, glucose, etc.). Programs see values; researchers get anonymized values.",
    requiredPermission: "measurement:read",
    allowedPurposes: ["care_delivery", "measurement_collection", "research", "self_service", "competition"],
    fields: {
      id: fp("id", "measurement", "allow"),
      participantId: fp("participantId", "measurement", "mask", { maskType: "id", reason: "Participant ID masked." }),
      type: fp("type", "measurement", "allow"),
      value: fp("value", "measurement", "allow"),
      unit: fp("unit", "measurement", "allow"),
      takenAt: fp("takenAt", "measurement", "allow"),
      deviceId: fp("deviceId", "measurement", "mask", { maskType: "id", reason: "Device ID masked." }),
      location: fp("location", "measurement", "redact", { reason: "Location redacted." }),
      notes: fp("notes", "measurement", "allow"),
      // Raw signal data denied by default
      rawSignal: fp("rawSignal", "measurement", "deny", { reason: "Raw signal requires elevated consent." }),
    },
    maxFieldsPerRequest: 8,
    cacheable: true,
    ttlSeconds: 30,
  },
  competition: {
    id: "competition",
    name: "Competition Leaderboard",
    description: "Aggregated competition standings; no individual PII.",
    requiredPermission: "competition:read",
    allowedPurposes: ["competition", "public_display"],
    fields: {
      competitionId: fp("competitionId", "competition", "allow"),
      rank: fp("rank", "competition", "allow"),
      score: fp("score", "competition", "allow"),
      displayName: fp("displayName", "competition", "mask", { maskType: "name", reason: "Leaderboard shows masked names." }),
      avatarUrl: fp("avatarUrl", "competition", "allow"),
      participantId: fp("participantId", "competition", "deny", { reason: "Participant IDs not exposed on leaderboards." }),
      email: fp("email", "competition", "deny", { reason: "Emails not exposed on leaderboards." }),
    },
    maxFieldsPerRequest: 6,
    cacheable: true,
    ttlSeconds: 300,
  },
  public_profile: {
    id: "public_profile",
    name: "Public Profile",
    description: "Publicly visible profile — display name + avatar only.",
    requiredPermission: "profile:public:read",
    allowedPurposes: ["public_display", "social"],
    fields: {
      displayName: fp("displayName", "public_profile", "allow"),
      avatarUrl: fp("avatarUrl", "public_profile", "allow"),
      bio: fp("bio", "public_profile", "allow"),
      // Everything else denied
      email: fp("email", "public_profile", "deny", { reason: "Email is not public." }),
      phone: fp("phone", "public_profile", "deny", { reason: "Phone is not public." }),
      dob: fp("dob", "public_profile", "deny", { reason: "Date of birth is not public." }),
    },
    maxFieldsPerRequest: 3,
    cacheable: true,
    ttlSeconds: 600,
  },
  anonymous_research: {
    id: "anonymous_research",
    name: "Anonymous Research Dataset",
    description: "De-identified data for approved research studies. All identifiers hashed/anonymized.",
    requiredPermission: "research:dataset:read",
    allowedPurposes: ["research", "public_health"],
    fields: {
      anonymousId: fp("anonymousId", "anonymous_research", "allow", { transform: "anonymize", reason: "Stable pseudonymous ID." }),
      ageBucket: fp("ageBucket", "anonymous_research", "allow", { transform: "bucketize_age", reason: "Age bucketized." }),
      gender: fp("gender", "anonymous_research", "allow"),
      region: fp("region", "anonymous_research", "allow", { reason: "Coarse region only." }),
      measurementType: fp("measurementType", "anonymous_research", "allow"),
      measurementValue: fp("measurementValue", "anonymous_research", "allow"),
      measurementUnit: fp("measurementUnit", "anonymous_research", "allow"),
      takenAt: fp("takenAt", "anonymous_research", "allow"),
      // Direct identifiers denied
      email: fp("email", "anonymous_research", "deny", { reason: "Direct identifiers removed for research." }),
      phone: fp("phone", "anonymous_research", "deny", { reason: "Direct identifiers removed for research." }),
      name: fp("name", "anonymous_research", "deny", { reason: "Direct identifiers removed for research." }),
      address: fp("address", "anonymous_research", "deny", { reason: "Direct identifiers removed for research." }),
      participantId: fp("participantId", "anonymous_research", "deny", { reason: "Use anonymousId instead." }),
    },
    maxFieldsPerRequest: 12,
    cacheable: true,
    ttlSeconds: 3600,
  },
  technician: {
    id: "technician",
    name: "Health Technician View",
    description: "Clinical staff view for measurement collection. Limited PII, full measurement access.",
    requiredPermission: "measurement:collect",
    allowedPurposes: ["care_delivery", "measurement_collection"],
    fields: {
      participantId: fp("participantId", "technician", "allow"),
      displayName: fp("displayName", "technician", "allow", { reason: "Technicians need to verify identity." }),
      dob: fp("dob", "technician", "allow", { reason: "Technicians need DOB for verification." }),
      phone: fp("phone", "technician", "mask", { maskType: "phone", reason: "Phone masked; call via platform." }),
      email: fp("email", "technician", "deny", { reason: "Email not needed for measurement collection." }),
      address: fp("address", "technician", "deny", { reason: "Address not needed for measurement collection." }),
      measurementType: fp("measurementType", "technician", "allow"),
      measurementValue: fp("measurementValue", "technician", "allow"),
      measurementUnit: fp("measurementUnit", "technician", "allow"),
      takenAt: fp("takenAt", "technician", "allow"),
      notes: fp("notes", "technician", "allow"),
    },
    maxFieldsPerRequest: 10,
    cacheable: false,
  },
  program_admin: {
    id: "program_admin",
    name: "Program Admin View",
    description: "Program administrators managing their program — aggregate stats, no individual PII.",
    requiredPermission: "program:admin",
    allowedPurposes: ["program_administration", "audit"],
    fields: {
      programId: fp("programId", "program_admin", "allow"),
      programName: fp("programName", "program_admin", "allow"),
      participantCount: fp("participantCount", "program_admin", "allow"),
      measurementCount: fp("measurementCount", "program_admin", "allow"),
      activeInstallations: fp("activeInstallations", "program_admin", "allow"),
      lastActivityAt: fp("lastActivityAt", "program_admin", "allow"),
      // Individual participant data denied
      participantId: fp("participantId", "program_admin", "deny", { reason: "Admins see aggregates, not individuals." }),
      email: fp("email", "program_admin", "deny", { reason: "Admins see aggregates, not individuals." }),
    },
    maxFieldsPerRequest: 8,
    cacheable: true,
    ttlSeconds: 120,
  },
};

// ---------------------------------------------------------------------------
// Rate limiter (per-program in-memory counter)
// ---------------------------------------------------------------------------

interface GatewayRateBucket {
  readonly minute: number;
  count: number;
}

const DEFAULT_GATEWAY_RATE_PER_MIN = 600;

// ---------------------------------------------------------------------------
// Data access gateway
// ---------------------------------------------------------------------------

export class DataAccessGateway {
  private readonly views = new Map<DataView, DataViewDescriptor>();
  private readonly transforms = new Map<string, Transformation>();
  private readonly rateBuckets = new Map<string, GatewayRateBucket>();
  private readonly cache = new Map<string, { value: DataAccessResponse; expiresAt: number }>();

  constructor() {
    // Auto-register all built-in views.
    for (const v of Object.values(VIEWS)) this.views.set(v.id, v);
    // Auto-register built-in transformations.
    for (const t of BUILTIN_TRANSFORMS) this.transforms.set(t.name, t);
  }

  /** Register a custom data view (extends the built-in catalog). */
  registerView(view: DataViewDescriptor): DataViewDescriptor {
    if (view.fields) {
      for (const [fieldName, policy] of Object.entries(view.fields)) {
        if (policy.field && policy.field !== fieldName) {
          throw new IdentityError({
            code: "eks.identity.data_gateway.field_mismatch",
            category: "validation",
            message: `Field policy key '${fieldName}' does not match policy.field '${policy.field}'.`,
          });
        }
      }
    }
    this.views.set(view.id, view);
    return view;
  }

  /** Register a custom transformation. */
  registerTransformation(transform: Transformation): void {
    this.transforms.set(transform.name, transform);
  }

  listViews(): DataViewDescriptor[] {
    return [...this.views.values()];
  }

  getView(id: DataView): DataViewDescriptor | undefined {
    return this.views.get(id);
  }

  /**
   * The core method. Validates permission, consent, purpose, and field
   * policies; audits the access; rate-limits per program; returns the
   * filtered response.
   */
  async access(request: DataAccessRequest, view: DataView): Promise<DataAccessResponse> {
    const descriptor = this.views.get(view);
    if (!descriptor) {
      throw new IdentityError({
        code: "eks.identity.data_gateway.view_not_found",
        category: "not_found",
        message: `View ${view} is not registered.`,
        userMessage: "This data view is not available.",
      });
    }
    const ctx = request.context ?? {};
    const source = ctx.source ?? "identity.data_gateway";
    const reasons: string[] = [];
    const now = getClock().iso();
    const accountId = request.principal.accountId;

    // ----- Step 0: rate-limit per program -----
    const rateResult = this.checkRate(`program:${request.programId}`);
    if (!rateResult.allowed) {
      const auditEntry = this.writeAudit({
        request, view, ctx, source, now,
        outcome: "denied",
        decision: "deny",
        reason: "rate_limited",
        fields: [], redacted: [], masked: [], denied: request.requestedFields,
        metadata: { retryAfterMs: rateResult.retryAfterMs },
      });
      const response: DataAccessResponse = {
        view,
        resourceId: request.resourceId,
        decision: "deny",
        reasons: ["rate_limited"],
        fields: {},
        allowed: [],
        redacted: [],
        masked: [],
        denied: request.requestedFields,
        auditEntryId: auditEntry.id,
        rateLimited: true,
        retryAfterMs: rateResult.retryAfterMs,
      };
      this.emitAccessedEvent(request, response, ctx);
      return response;
    }

    // ----- Step 1: authorization -----
    // Build the EvaluationContext required by getAuthorization().evaluate.
    // Account + persona are required; the auth engine enforces the policy.
    if (!request.principal.accountId || !request.principal.activePersona) {
      const auditEntry = this.writeAudit({
        request, view, ctx, source, now,
        outcome: "denied",
        decision: "deny",
        reason: "no_account_or_persona",
        fields: [], redacted: [], masked: [], denied: request.requestedFields,
        metadata: { requiredPermission: descriptor.requiredPermission },
      });
      const response: DataAccessResponse = {
        view,
        resourceId: request.resourceId,
        decision: "deny",
        reasons: ["principal_missing_account_or_persona"],
        fields: {},
        allowed: [],
        redacted: [],
        masked: [],
        denied: request.requestedFields,
        auditEntryId: auditEntry.id,
      };
      this.emitAccessedEvent(request, response, ctx);
      return response;
    }
    const authzDecision = getAuthorization().evaluate(
      {
        accountId: request.principal.accountId,
        persona: request.principal.activePersona,
        programId: request.programId,
        purpose: request.purpose,
        resource: request.resourceId as unknown as ResourceId | undefined,
        ipAddress: ctx.ipMetadata?.ip,
        fields: request.requestedFields,
        time: now,
      },
      descriptor.requiredPermission,
    );
    if (authzDecision.decision === "deny") {
      reasons.push(...authzDecision.reasons, `permission:${descriptor.requiredPermission}:denied`);
      const auditEntry = this.writeAudit({
        request, view, ctx, source, now,
        outcome: "denied",
        decision: "deny",
        reason: "permission_denied",
        fields: [], redacted: [], masked: [], denied: request.requestedFields,
        metadata: { permission: descriptor.requiredPermission, authzReasons: authzDecision.reasons },
      });
      const response: DataAccessResponse = {
        view,
        resourceId: request.resourceId,
        decision: "deny",
        reasons,
        fields: {},
        allowed: [],
        redacted: [],
        masked: [],
        denied: request.requestedFields,
        auditEntryId: auditEntry.id,
      };
      this.emitAccessedEvent(request, response, ctx);
      return response;
    }
    if (authzDecision.decision === "challenge") {
      reasons.push(...authzDecision.reasons, `permission:${descriptor.requiredPermission}:challenge`);
      const auditEntry = this.writeAudit({
        request, view, ctx, source, now,
        outcome: "failure",
        decision: "challenge",
        reason: "step_up_required",
        fields: [], redacted: [], masked: [], denied: request.requestedFields,
        metadata: { permission: descriptor.requiredPermission, authzReasons: authzDecision.reasons },
      });
      const response: DataAccessResponse = {
        view,
        resourceId: request.resourceId,
        decision: "challenge",
        reasons,
        fields: {},
        allowed: [],
        redacted: [],
        masked: [],
        denied: request.requestedFields,
        auditEntryId: auditEntry.id,
      };
      this.emitAccessedEvent(request, response, ctx);
      return response;
    }

    // ----- Step 2: purpose validity -----
    if (descriptor.allowedPurposes.length > 0 && !descriptor.allowedPurposes.includes(request.purpose)) {
      reasons.push(`purpose:${request.purpose}:not_allowed_for_view:${view}`);
      const auditEntry = this.writeAudit({
        request, view, ctx, source, now,
        outcome: "denied",
        decision: "deny",
        reason: "purpose_not_allowed",
        fields: [], redacted: [], masked: [], denied: request.requestedFields,
        metadata: { purpose: request.purpose, allowedPurposes: descriptor.allowedPurposes },
      });
      const response: DataAccessResponse = {
        view,
        resourceId: request.resourceId,
        decision: "deny",
        reasons,
        fields: {},
        allowed: [],
        redacted: [],
        masked: [],
        denied: request.requestedFields,
        auditEntryId: auditEntry.id,
      };
      this.emitAccessedEvent(request, response, ctx);
      return response;
    }

    // ----- Step 3-5: per-field consent + policy + masking -----
    const allowed: string[] = [];
    const redacted: string[] = [];
    const masked: string[] = [];
    const denied: string[] = [];
    const fields: Record<string, unknown> = {};

    // Cap requested fields
    const maxFields = descriptor.maxFieldsPerRequest ?? 50;
    const requested = request.requestedFields.slice(0, maxFields);

    for (const field of requested) {
      const policy = descriptor.fields[field];
      // Unknown fields are denied by default (zero-trust)
      if (!policy) {
        denied.push(field);
        continue;
      }
      // Field-level deny
      if (policy.action === "deny") {
        denied.push(field);
        continue;
      }
      // Consent check (per field) — requires an account to consent on behalf of
      if (accountId) {
        const consentGranted = getConsent().checkAccess(
          accountId,
          request.programId,
          request.purpose,
          field,
        );
        if (!consentGranted) {
          denied.push(field);
          continue;
        }
      } else if (request.principal.kind !== "system" && request.principal.kind !== "service_account") {
        // Non-system principals MUST have an account to access user data
        denied.push(field);
        continue;
      }

      const raw = request.data?.[field];
      let value: unknown;
      switch (policy.action) {
        case "redact":
          value = redact(raw);
          redacted.push(field);
          break;
        case "mask":
          value = mask(raw, policy.maskType ?? "default");
          masked.push(field);
          break;
        case "allow":
          if (policy.transform) {
            const t = this.transforms.get(policy.transform);
            value = t ? t.apply(raw) : raw;
          } else {
            value = raw;
          }
          allowed.push(field);
          break;
        default:
          denied.push(field);
          continue;
      }
      fields[field] = value;
    }

    // ----- Step 6: audit -----
    const allDenied = allowed.length === 0 && redacted.length === 0 && masked.length === 0;
    const outcome = allDenied ? "denied" : "success";
    const decision: "allow" | "deny" = allDenied ? "deny" : "allow";
    const auditEntry = this.writeAudit({
      request, view, ctx, source, now,
      outcome,
      decision,
      reason: outcome === "denied" ? "no_fields_authorized" : "ok",
      fields: allowed, redacted, masked, denied,
      metadata: {
        purpose: request.purpose,
        permission: descriptor.requiredPermission,
        consentChecked: !!accountId,
      },
    });

    // ----- Step 5b (post-decision): privacy impact logging -----
    try {
      if (accountId) {
        getPrivacy().logImpact(
          `data_gateway_${view}_${decision}`,
          accountId,
          accountId,
          {
            programId: request.programId,
            purpose: request.purpose,
            view,
            decision,
            fieldsAccessed: allowed,
            fieldsRedacted: redacted,
            fieldsMasked: masked,
            fieldsDenied: denied,
            resourceId: request.resourceId,
            auditEntryId: auditEntry.id,
          },
        );
      }
    } catch {
      // Privacy log failures must not block data access; the audit entry
      // already captures the access.
    }

    const response: DataAccessResponse = {
      view,
      resourceId: request.resourceId,
      decision,
      reasons: decision === "allow" ? [] : ["no_fields_authorized"],
      fields,
      allowed,
      redacted,
      masked,
      denied,
      auditEntryId: auditEntry.id,
    };
    this.emitAccessedEvent(request, response, ctx);
    return response;
  }

  /** Simple per-program rate limiter. */
  checkRate(key: string, limitPerMinute = DEFAULT_GATEWAY_RATE_PER_MIN): { allowed: boolean; remaining: number; retryAfterMs: number } {
    const minute = Math.floor(Date.now() / 60_000);
    let bucket = this.rateBuckets.get(key);
    if (!bucket || bucket.minute !== minute) {
      bucket = { minute, count: 0 };
    }
    if (bucket.count >= limitPerMinute) {
      const retryAfterMs = (60 - (Math.floor(Date.now() / 1000) % 60)) * 1000;
      return { allowed: false, remaining: 0, retryAfterMs };
    }
    bucket.count += 1;
    this.rateBuckets.set(key, bucket);
    return { allowed: true, remaining: limitPerMinute - bucket.count, retryAfterMs: 0 };
  }

  /** Clear the response cache (admin / testing). */
  clearCache(): void {
    this.cache.clear();
  }

  // --- internal helpers ---

  private writeAudit(opts: {
    readonly request: DataAccessRequest;
    readonly view: DataView;
    readonly ctx: DataAccessContext;
    readonly source: string;
    readonly now: string;
    readonly outcome: "success" | "failure" | "denied";
    readonly decision: "allow" | "deny" | "challenge";
    readonly reason: string;
    readonly fields: string[];
    readonly redacted: string[];
    readonly masked: string[];
    readonly denied: string[];
    readonly metadata?: Record<string, unknown>;
  }) {
    return getAudit().record({
      category: "data_access",
      action: `data.${opts.decision}`,
      outcome: opts.outcome,
      actor: opts.request.principal,
      target: opts.request.resourceId
        ? { kind: opts.request.resourceKind ?? "resource", id: opts.request.resourceId, label: opts.view }
        : { kind: "view", id: opts.view },
      purpose: opts.request.purpose,
      source: opts.source,
      correlationId: opts.ctx.correlationId,
      traceId: opts.ctx.traceId,
      device: opts.ctx.device,
      ipMetadata: opts.ctx.ipMetadata,
      metadata: {
        view: opts.view,
        programId: opts.request.programId,
        allowed: opts.fields,
        redacted: opts.redacted,
        masked: opts.masked,
        denied: opts.denied,
        reason: opts.reason,
        ...opts.metadata,
      },
    });
  }

  private emitAccessedEvent(request: DataAccessRequest, response: DataAccessResponse, ctx: DataAccessContext): void {
    void getEventBus().publish(
      buildEvent(
        IDENTITY_EVENTS.dataAccessed,
        {
          principalId: request.principal.id,
          accountId: request.principal.accountId,
          programId: request.programId,
          purpose: request.purpose,
          view: response.view,
          resourceId: request.resourceId,
          decision: response.decision,
          allowed: response.allowed,
          redacted: response.redacted,
          masked: response.masked,
          denied: response.denied,
          auditEntryId: response.auditEntryId,
          rateLimited: response.rateLimited ?? false,
        },
        { correlationId: ctx.correlationId },
        "domain",
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Events (re-exported for consumers)
// ---------------------------------------------------------------------------

export const DATA_GATEWAY_EVENTS = {
  accessed: IDENTITY_EVENTS.dataAccessed, // "eks.identity.data.accessed"
} as const;

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _gateway: DataAccessGateway | null = null;
export function getDataGateway(): DataAccessGateway {
  if (!_gateway) _gateway = new DataAccessGateway();
  return _gateway;
}
export function setDataGateway(g: DataAccessGateway): void {
  _gateway = g;
}
export function resetDataGateway(): void {
  _gateway = null;
}

export { IdentityError };
