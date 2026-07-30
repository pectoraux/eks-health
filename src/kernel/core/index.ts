/**
 * Eks-Health Platform Kernel — Core Primitives
 *
 * The foundational types and base classes that every kernel subsystem
 * extends. Nothing in here assumes anything about healthcare. This is
 * pure operating-system plumbing: identity, errors, events, time, ids.
 *
 * Design goals:
 *  - Branded types so domain identifiers never get confused.
 *  - A single unified error model with traceability built in.
 *  - A single event envelope that supports correlation/causation/idempotency.
 *  - A clock abstraction so the entire platform is testable.
 */

// ---------------------------------------------------------------------------
// Branded primitive types
// ---------------------------------------------------------------------------

/** Brand a nominal type onto a string. */
export type Brand<T, B extends string> = T & { readonly __brand: B };

export type TenantId = Brand<string, "TenantId">;
export type UserId = Brand<string, "UserId">;
export type ServiceId = Brand<string, "ServiceId">;
export type CorrelationId = Brand<string, "CorrelationId">;
export type CausationId = Brand<string, "CausationId">;
export type EventId = Brand<string, "EventId">;
export type RequestId = Brand<string, "RequestId">;
export type TraceId = Brand<string, "TraceId">;
export type FlagKey = Brand<string, "FlagKey">;
export type ConfigKey = Brand<string, "ConfigKey">;
export type ResourceId = Brand<string, "ResourceId">;

/** Safely cast a plain string into a branded id. */
export function asTenantId(s: string): TenantId {
  return s as TenantId;
}
export function asUserId(s: string): UserId {
  return s as UserId;
}
export function asServiceId(s: string): ServiceId {
  return s as ServiceId;
}
export function asCorrelationId(s: string): CorrelationId {
  return s as CorrelationId;
}
export function asCausationId(s: string): CausationId {
  return s as CausationId;
}
export function asEventId(s: string): EventId {
  return s as EventId;
}
export function asRequestId(s: string): RequestId {
  return s as RequestId;
}
export function asTraceId(s: string): TraceId {
  return s as TraceId;
}
export function asFlagKey(s: string): FlagKey {
  return s as FlagKey;
}
export function asConfigKey(s: string): ConfigKey {
  return s as ConfigKey;
}

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

/**
 * Generates a sortable, unique identifier (ULID-like).
 * Format: <milliseconds since epoch 36-padded> + <random 16 chars base36>.
 * Sortable lexicographically by creation time, collision-resistant.
 */
export function generateId(prefix = ""): string {
  const now = Date.now();
  const time = now.toString(36).padStart(9, "0");
  let rand = "";
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
  for (let i = 0; i < 16; i++) {
    rand += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return `${prefix}${time}${rand}`;
}

export function generateEventId(): EventId {
  return asEventId(`evt_${generateId()}`);
}
export function generateCorrelationId(): CorrelationId {
  return asCorrelationId(`cor_${generateId()}`);
}
export function generateCausationId(): CausationId {
  return asCausationId(`cau_${generateId()}`);
}
export function generateRequestId(): RequestId {
  return asRequestId(`req_${generateId()}`);
}
export function generateTraceId(): TraceId {
  return asTraceId(`trc_${generateId()}`);
}

// ---------------------------------------------------------------------------
// Clock abstraction
// ---------------------------------------------------------------------------

export interface Clock {
  now(): Date;
  epochMs(): number;
  iso(): string;
}

class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
  epochMs(): number {
    return Date.now();
  }
  iso(): string {
    return new Date().toISOString();
  }
}

let _clock: Clock = new SystemClock();

/** Replace the global clock (used in tests / deterministic replay). */
export function setClock(clock: Clock): void {
  _clock = clock;
}
export function getClock(): Clock {
  return _clock;
}
export function resetClock(): void {
  _clock = new SystemClock();
}

// ---------------------------------------------------------------------------
// Result type (functional error handling for application services)
// ---------------------------------------------------------------------------

export type Result<T, E = KernelError> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}
export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

// ---------------------------------------------------------------------------
// Severity, retryability, lifecycle
// ---------------------------------------------------------------------------

export type Severity = "debug" | "info" | "warn" | "error" | "critical";
export type LifecycleState =
  | "provisioning"
  | "active"
  | "degraded"
  | "maintenance"
  | "draining"
  | "terminated";
export type Region = string; // e.g. "us-east-1", "eu-west-2", "af-west-1"

// ---------------------------------------------------------------------------
// Unified Error Model — the single error contract for the whole platform
// ---------------------------------------------------------------------------

export type ErrorCategory =
  | "validation"
  | "not_found"
  | "conflict"
  | "unauthorized"
  | "forbidden"
  | "rate_limited"
  | "unavailable"
  | "internal"
  | "timeout"
  | "circuit_open"
  | "quota_exceeded"
  | "dependency_failure"
  | "data_integrity"
  | "configuration";

export interface KernelErrorInit {
  code: string; // e.g. "eks.error.tenant.not_found"
  category: ErrorCategory;
  severity: Severity;
  retryable: boolean;
  userMessage: string;
  developerMessage: string;
  cause?: unknown;
  metadata?: Record<string, unknown>;
  docUrl?: string;
}

/**
 * Every error raised anywhere in the platform MUST be (or be wrapped as) a
 * KernelError. It carries enough context for observability, support, and
 * automated retry decisions.
 */
export class KernelError extends Error {
  readonly code: string;
  readonly category: ErrorCategory;
  readonly severity: Severity;
  readonly retryable: boolean;
  readonly userMessage: string;
  readonly developerMessage: string;
  readonly metadata: Record<string, unknown>;
  readonly docUrl?: string;
  readonly timestamp: string;
  readonly traceId?: TraceId;
  readonly correlationId?: CorrelationId;

  constructor(init: KernelErrorInit, trace?: { traceId?: TraceId; correlationId?: CorrelationId }) {
    super(init.developerMessage);
    this.name = "KernelError";
    this.code = init.code;
    this.category = init.category;
    this.severity = init.severity;
    this.retryable = init.retryable;
    this.userMessage = init.userMessage;
    this.developerMessage = init.developerMessage;
    this.metadata = init.metadata ?? {};
    this.docUrl = init.docUrl;
    this.timestamp = getClock().iso();
    this.traceId = trace?.traceId;
    this.correlationId = trace?.correlationId;
    if (init.cause !== undefined) {
      (this as { cause?: unknown }).cause = init.cause;
    }
  }

  /** Serialize to a JSON-safe object for API responses & logs. */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      category: this.category,
      severity: this.severity,
      retryable: this.retryable,
      userMessage: this.userMessage,
      developerMessage: this.developerMessage,
      metadata: this.metadata,
      docUrl: this.docUrl,
      timestamp: this.timestamp,
      traceId: this.traceId,
      correlationId: this.correlationId,
    };
  }
}

/** Convenience constructors for the most common categories. */
export class ValidationError extends KernelError {
  constructor(code: string, developerMessage: string, userMessage = "The request was invalid.") {
    super({
      code,
      category: "validation",
      severity: "warn",
      retryable: false,
      developerMessage,
      userMessage,
    });
    this.name = "ValidationError";
  }
}
export class NotFoundError extends KernelError {
  constructor(code: string, developerMessage: string, userMessage = "Resource not found.") {
    super({
      code,
      category: "not_found",
      severity: "warn",
      retryable: false,
      developerMessage,
      userMessage,
    });
    this.name = "NotFoundError";
  }
}
export class ConflictError extends KernelError {
  constructor(code: string, developerMessage: string, userMessage = "Conflict with current state.") {
    super({
      code,
      category: "conflict",
      severity: "warn",
      retryable: false,
      developerMessage,
      userMessage,
    });
    this.name = "ConflictError";
  }
}
export class UnauthorizedError extends KernelError {
  constructor(code: string, developerMessage = "Authentication required.", userMessage = "Authentication required.") {
    super({
      code,
      category: "unauthorized",
      severity: "warn",
      retryable: false,
      developerMessage,
      userMessage,
    });
    this.name = "UnauthorizedError";
  }
}
export class RateLimitedError extends KernelError {
  constructor(code: string, developerMessage: string, userMessage = "Too many requests. Please slow down.") {
    super({
      code,
      category: "rate_limited",
      severity: "warn",
      retryable: true,
      developerMessage,
      userMessage,
    });
    this.name = "RateLimitedError";
  }
}
export class UnavailableError extends KernelError {
  constructor(code: string, developerMessage: string, userMessage = "Service temporarily unavailable.") {
    super({
      code,
      category: "unavailable",
      severity: "error",
      retryable: true,
      developerMessage,
      userMessage,
    });
    this.name = "UnavailableError";
  }
}

// ---------------------------------------------------------------------------
// Base Event Envelope
// ---------------------------------------------------------------------------

export type EventKind =
  | "domain" // within a bounded context
  | "integration" // across contexts/services
  | "system" // platform-level (health, scaling)
  | "scheduled" // produced by the scheduler
  | "delayed"; // produced after a delay

export interface BaseEvent<P = Record<string, unknown>> {
  readonly id: EventId;
  readonly kind: EventKind;
  readonly type: string; // e.g. "eks.kernel.tenant.created"
  readonly schemaVersion: number;
  readonly payload: P;
  readonly occurredAt: string; // ISO-8601 UTC
  readonly tenantId?: TenantId;
  readonly correlationId: CorrelationId;
  readonly causationId?: CausationId;
  readonly actor?: { kind: "user" | "service" | "system"; id: string };
  readonly region?: Region;
}

export interface EventEnvelopeMeta {
  readonly retryCount: number;
  readonly deliveredAt?: string;
  readonly deadLettered?: boolean;
}

// ---------------------------------------------------------------------------
// Service contract descriptor (used by the registry & gateway)
// ---------------------------------------------------------------------------

export type Protocol = "rest" | "graphql" | "websocket" | "sse" | "grpc";

export interface ServiceContractEndpoint {
  readonly protocol: Protocol;
  readonly basePath: string;
  readonly version: string;
  readonly openApiRef?: string;
}

export interface HealthStatus {
  readonly state: LifecycleState;
  readonly healthy: boolean;
  readonly checkedAt: string;
  readonly latencyMs?: number;
  readonly details?: Record<string, unknown>;
}
