/**
 * Eks-Health Identity Platform — Core Primitives
 *
 * Foundation types for identity, principals, personas, and the identity
 * error model. Builds on the kernel (branded ids, KernelError, events).
 *
 * Zero-trust principles are baked in: every identity decision is auditable,
 * every principal is explicitly typed, and nothing is granted by default.
 */

import type {
  Brand,
  TenantId,
  CorrelationId,
  TraceId,
  KernelError,
} from "@/kernel";
import { KernelError as KE } from "@/kernel";

// ---------------------------------------------------------------------------
// Branded identity identifiers
// ---------------------------------------------------------------------------

export type AccountId = Brand<string, "AccountId">;
export type PrincipalId = Brand<string, "PrincipalId">;
export type SessionId = Brand<string, "SessionId">;
export type DeviceId = Brand<string, "DeviceId">;
export type RoleId = Brand<string, "RoleId">;
export type OrgId = Brand<string, "OrgId">;
export type TeamId = Brand<string, "TeamId">;
export type ApiKeyId = Brand<string, "ApiKeyId">;
export type ServiceAccountId = Brand<string, "ServiceAccountId">;
export type ConsentId = Brand<string, "ConsentId">;
export type ConsentReceiptId = Brand<string, "ConsentReceiptId">;
export type GrantId = Brand<string, "GrantId">;
export type AuditEntryId = Brand<string, "AuditEntryId">;
export type PolicyId = Brand<string, "PolicyId">;
export type IncidentId = Brand<string, "IncidentId">;

// Identity generators
export function asAccountId(s: string): AccountId { return s as AccountId; }
export function asPrincipalId(s: string): PrincipalId { return s as PrincipalId; }
export function asSessionId(s: string): SessionId { return s as SessionId; }
export function asDeviceId(s: string): DeviceId { return s as DeviceId; }
export function asRoleId(s: string): RoleId { return s as RoleId; }
export function asOrgId(s: string): OrgId { return s as OrgId; }
export function asTeamId(s: string): TeamId { return s as TeamId; }
export function asApiKeyId(s: string): ApiKeyId { return s as ApiKeyId; }
export function asServiceAccountId(s: string): ServiceAccountId { return s as ServiceAccountId; }
export function asConsentId(s: string): ConsentId { return s as ConsentId; }
export function asConsentReceiptId(s: string): ConsentReceiptId { return s as ConsentReceiptId; }
export function asGrantId(s: string): GrantId { return s as GrantId; }
export function asAuditEntryId(s: string): AuditEntryId { return s as AuditEntryId; }
export function asPolicyId(s: string): PolicyId { return s as PolicyId; }
export function asIncidentId(s: string): IncidentId { return s as IncidentId; }

// ---------------------------------------------------------------------------
// Personas (user types)
// ---------------------------------------------------------------------------

/**
 * Personas are roles a single account can hold SIMULTANEOUSLY.
 * An account is one identity but may act as several personas and switch
 * between them without creating duplicate accounts.
 */
export type Persona =
  | "participant" // a person tracking their own health
  | "health_technician" // clinical staff collecting measurements
  | "developer" // builds programs/extensions
  | "researcher" // requests de-identified data
  | "org_admin" // manages an organization
  | "platform_admin" // operates the platform
  | "marketplace_reviewer" // reviews program listings
  | "support_agent"; // assists users

export const ALL_PERSONAS: readonly Persona[] = [
  "participant",
  "health_technician",
  "developer",
  "researcher",
  "org_admin",
  "platform_admin",
  "marketplace_reviewer",
  "support_agent",
];

export interface PersonaDescriptor {
  readonly persona: Persona;
  readonly label: string;
  readonly description: string;
  readonly defaultPermissions: string[];
  readonly sensitive: boolean; // requires elevated verification
}

// ---------------------------------------------------------------------------
// Principal — the unified identity of any actor (user, service, agent)
// ---------------------------------------------------------------------------

export type PrincipalKind = "user" | "service_account" | "api_key" | "system";

export interface Principal {
  readonly id: PrincipalId;
  readonly kind: PrincipalKind;
  readonly displayName: string;
  readonly accountId?: AccountId;
  readonly personas: Persona[];
  readonly activePersona?: Persona;
  readonly tenantId?: TenantId;
  readonly scopes: string[];
  readonly verified: boolean;
}

// ---------------------------------------------------------------------------
// Authentication result / factor types
// ---------------------------------------------------------------------------

export type AuthFactorType =
  | "password"
  | "totp"
  | "sms"
  | "email"
  | "passkey" // WebAuthn
  | "oauth"
  | "sso"
  | "hardware_key";

export type AuthStrength = "weak" | "single" | "multi" | "strong";

export interface AuthFactor {
  readonly id: string;
  readonly type: AuthFactorType;
  readonly label: string;
  readonly createdAt: string;
  readonly lastUsedAt?: string;
  readonly verified: boolean;
  readonly metadata?: Record<string, unknown>;
}

export interface AuthResult {
  readonly principal: Principal;
  readonly sessionId: SessionId;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: string;
  readonly strength: AuthStrength;
  readonly mfaRequired: boolean;
  readonly riskScore: number;
}

// ---------------------------------------------------------------------------
// Contact info (email/phone) with verification state
// ---------------------------------------------------------------------------

export interface ContactInfo {
  readonly type: "email" | "phone";
  readonly value: string;
  readonly verified: boolean;
  readonly verifiedAt?: string;
  readonly primary: boolean;
}

// ---------------------------------------------------------------------------
// Identity errors
// ---------------------------------------------------------------------------

export type IdentityErrorCategory =
  | "invalid_credentials"
  | "account_not_found"
  | "account_disabled"
  | "account_locked"
  | "mfa_required"
  | "mfa_failed"
  | "session_expired"
  | "session_revoked"
  | "device_untrusted"
  | "consent_required"
  | "consent_denied"
  | "permission_denied"
  | "rate_limited"
  | "policy_violation"
  | "verification_required"
  | "conflict"
  | "not_found"
  | "validation";

export class IdentityError extends Error {
  readonly code: string;
  readonly category: IdentityErrorCategory;
  readonly retryable: boolean;
  readonly userMessage: string;
  readonly timestamp: string;
  readonly correlationId?: CorrelationId;
  readonly traceId?: TraceId;
  readonly metadata: Record<string, unknown>;

  constructor(opts: {
    code: string;
    category: IdentityErrorCategory;
    message: string;
    userMessage?: string;
    retryable?: boolean;
    correlationId?: CorrelationId;
    traceId?: TraceId;
    metadata?: Record<string, unknown>;
    cause?: unknown;
  }) {
    super(opts.message);
    this.name = "IdentityError";
    this.code = opts.code;
    this.category = opts.category;
    this.retryable = opts.retryable ?? false;
    this.userMessage = opts.userMessage ?? "An identity error occurred.";
    this.timestamp = new Date().toISOString();
    this.correlationId = opts.correlationId;
    this.traceId = opts.traceId;
    this.metadata = opts.metadata ?? {};
    if (opts.cause !== undefined) {
      (this as { cause?: unknown }).cause = opts.cause;
    }
  }

  /** Convert to a KernelError for the unified platform error model. */
  toKernelError(): KernelError {
    const categoryMap: Record<IdentityErrorCategory, "validation" | "not_found" | "conflict" | "unauthorized" | "forbidden" | "rate_limited" | "internal"> = {
      invalid_credentials: "unauthorized",
      account_not_found: "not_found",
      account_disabled: "forbidden",
      account_locked: "forbidden",
      mfa_required: "unauthorized",
      mfa_failed: "unauthorized",
      session_expired: "unauthorized",
      session_revoked: "unauthorized",
      device_untrusted: "forbidden",
      consent_required: "forbidden",
      consent_denied: "forbidden",
      permission_denied: "forbidden",
      rate_limited: "rate_limited",
      policy_violation: "forbidden",
      verification_required: "forbidden",
      conflict: "conflict",
      not_found: "not_found",
      validation: "validation",
    };
    return new KE({
      code: this.code,
      category: categoryMap[this.category],
      severity: this.category === "rate_limited" ? "warn" : "error",
      retryable: this.retryable,
      userMessage: this.userMessage,
      developerMessage: this.message,
      metadata: this.metadata,
    }, { traceId: this.traceId, correlationId: this.correlationId });
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      category: this.category,
      retryable: this.retryable,
      userMessage: this.userMessage,
      timestamp: this.timestamp,
      correlationId: this.correlationId,
      traceId: this.traceId,
      metadata: this.metadata,
    };
  }
}

// ---------------------------------------------------------------------------
// Risk scoring
// ---------------------------------------------------------------------------

export interface RiskAssessment {
  readonly score: number; // 0 (safe) - 100 (critical)
  readonly level: "low" | "medium" | "high" | "critical";
  readonly factors: { label: string; weight: number; detail?: string }[];
  readonly assessedAt: string;
  readonly requiresMfa: boolean;
  readonly requiresStepUp: boolean;
  readonly recommendedAction: "allow" | "challenge" | "deny" | "notify";
}

// ---------------------------------------------------------------------------
// Identity event types (published to the kernel event bus)
// ---------------------------------------------------------------------------

export const IDENTITY_EVENTS = {
  accountRegistered: "eks.identity.account.registered",
  accountVerified: "eks.identity.account.verified",
  signedIn: "eks.identity.session.created",
  signedOut: "eks.identity.session.revoked",
  sessionRefreshed: "eks.identity.session.refreshed",
  mfaEnabled: "eks.identity.mfa.enabled",
  mfaChallenge: "eks.identity.mfa.challenge",
  passkeyRegistered: "eks.identity.passkey.registered",
  deviceRegistered: "eks.identity.device.registered",
  deviceTrusted: "eks.identity.device.trusted",
  deviceRevoked: "eks.identity.device.revoked",
  roleAssigned: "eks.identity.role.assigned",
  roleRevoked: "eks.identity.role.revoked",
  personaSwitched: "eks.identity.persona.switched",
  consentGranted: "eks.identity.consent.granted",
  consentRevoked: "eks.identity.consent.revoked",
  permissionGranted: "eks.identity.permission.granted",
  permissionDenied: "eks.identity.permission.denied",
  policyViolated: "eks.identity.policy.violated",
  dataAccessed: "eks.identity.data.accessed",
  accountLocked: "eks.identity.account.locked",
  suspiciousActivity: "eks.identity.security.suspicious_activity",
  incidentCreated: "eks.identity.security.incident_created",
  dataDeletionRequested: "eks.identity.privacy.deletion_requested",
  dataExportRequested: "eks.identity.privacy.export_requested",
} as const;

export type IdentityEventType = (typeof IDENTITY_EVENTS)[keyof typeof IDENTITY_EVENTS];
