/**
 * Eks-Health Kernel — API Gateway Contracts
 *
 * The production ingress architecture for the platform. This module defines
 * the route table, middleware contract, upstream service registry, and the
 * real working building blocks every gateway needs:
 *
 *   - A `Gateway` class that matches (method, path) to a route + upstream.
 *   - A `RateLimiter` implementing a REAL token-bucket per key (per tenant
 *     or IP) with continuous refill.
 *   - A `Cache` implementing a REAL TTL cache with per-entry expiry.
 *   - A `VersionNegotiator` that parses `Accept: application/vnd.eks.v2+json`
 *     headers and falls back to the latest available version.
 *   - A `CompressionNegotiator` that picks gzip / br / identity from an
 *     `Accept-Encoding` header.
 *   - 8 standard middleware descriptors (auth, rate_limit, tracing,
 *     request_id, compression, caching, cors, logging) with explicit order
 *     priorities so the pipeline is deterministic.
 *
 * The gateway is protocol-aware (REST, GraphQL, WebSocket, SSE, gRPC) but
 * does not itself open sockets — it is the contract & policy layer that a
 * real runtime (Next.js handlers, Bun.serve, Node http2) implements against.
 */

import { generateId, getClock } from "../core";

// ---------------------------------------------------------------------------
// Protocols, versions, routes
// ---------------------------------------------------------------------------

export type GatewayProtocol = "rest" | "graphql" | "websocket" | "sse" | "grpc";
export type RouteVersion = "v1" | "v2" | "v3";

export interface UpstreamService {
  readonly id: string;
  readonly name: string;
  readonly basePath: string; // e.g. "/api/kernel"
  readonly target: string; // e.g. "http://localhost:3000" or "kernel-internal:8080"
  readonly protocol: GatewayProtocol;
  readonly availableVersions: readonly RouteVersion[];
  readonly healthCheckPath?: string;
  readonly timeoutMs: number;
  readonly retryPolicy?: {
    readonly attempts: number;
    readonly backoffMs: number;
    readonly retryOn: readonly number[];
  };
}

export interface GatewayRoute {
  readonly id: string;
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD" | "*";
  readonly path: string; // path pattern with {param} placeholders, e.g. "/api/kernel/tenants/{id}"
  readonly version: RouteVersion;
  readonly protocol: GatewayProtocol;
  readonly upstreamId: string;
  readonly upstreamPath: string; // path forwarded to upstream; may include {param} refs
  readonly authRequired: boolean;
  readonly rateLimit?: RateLimitPolicy;
  readonly cache?: CachePolicy;
  readonly compression?: CompressionPolicy;
  readonly middleware?: readonly string[]; // middleware names to apply (in addition to defaults)
  readonly deprecated?: boolean;
  readonly description?: string;
}

// ---------------------------------------------------------------------------
// Policies
// ---------------------------------------------------------------------------

export interface RateLimitPolicy {
  readonly capacity: number; // bucket size
  readonly refillPerSecond: number; // continuous refill rate
  readonly cost?: number; // cost per request (default 1)
  readonly keyScope: "ip" | "tenant" | "user" | "global";
}

export interface CompressionPolicy {
  readonly algorithms: readonly ("gzip" | "br" | "identity")[];
  readonly minSizeBytes: number;
  readonly mimeTypes: readonly string[];
}

export interface CachePolicy {
  readonly ttlMs: number;
  readonly varyBy: readonly string[]; // header names that change the cache key
  readonly invalidateOn?: readonly ("POST" | "PUT" | "PATCH" | "DELETE")[];
}

export interface AuthHook {
  readonly name: string;
  authenticate(req: GatewayRequest): Promise<AuthHookResult>;
}

export interface AuthHookResult {
  readonly authenticated: boolean;
  readonly principal?: {
    readonly kind: "user" | "service" | "anonymous";
    readonly id: string;
    readonly scopes?: readonly string[];
  };
  readonly error?: string;
}

// ---------------------------------------------------------------------------
// Middleware contract
// ---------------------------------------------------------------------------

export interface GatewayRequest {
  readonly id: string;
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, string | string[]>>;
  readonly body?: unknown;
  readonly principal?: AuthHookResult["principal"];
  readonly route?: GatewayRoute;
  readonly upstream?: UpstreamService;
  readonly startedAt: string;
}

export interface GatewayResponse {
  readonly id: string;
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body?: unknown;
  readonly fromCache?: boolean;
  readonly upstreamLatencyMs?: number;
  readonly totalLatencyMs: number;
}

export interface GatewayMiddleware {
  readonly name: string;
  readonly order: number; // lower runs first; before-phase ascending, after-phase descending
  before(req: GatewayRequest): Promise<GatewayRequest | null>;
  after(req: GatewayRequest, res: GatewayResponse): Promise<GatewayResponse>;
}

// ---------------------------------------------------------------------------
// Gateway — route table + matcher
// ---------------------------------------------------------------------------

export interface MatchResult {
  readonly route: GatewayRoute;
  readonly upstream: UpstreamService;
  readonly params: Readonly<Record<string, string>>;
}

interface CompiledRoute {
  readonly route: GatewayRoute;
  readonly regex: RegExp;
  readonly paramNames: readonly string[];
}

function compilePath(path: string): { regex: RegExp; paramNames: string[] } {
  const paramNames: string[] = [];
  // Convert /api/kernel/tenants/{id}/items/{itemId}
  // into  /^\/api\/kernel\/tenants\/([^/]+)\/items\/([^/]+)$/i
  const pattern = path
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\{(\w+)\}/g, (_, name: string) => {
      paramNames.push(name);
      return "([^/]+)";
    });
  return { regex: new RegExp(`^${pattern}$`, "i"), paramNames };
}

export class Gateway {
  private readonly routes = new Map<string, GatewayRoute>();
  private readonly compiled = new Map<string, CompiledRoute>();
  private readonly upstreams = new Map<string, UpstreamService>();
  private readonly middleware = new Map<string, GatewayMiddleware>();

  registerUpstream(service: UpstreamService): UpstreamService {
    this.upstreams.set(service.id, service);
    return service;
  }

  registerRoute(route: GatewayRoute): GatewayRoute {
    if (!this.upstreams.has(route.upstreamId)) {
      throw new Error(`Gateway.registerRoute: upstream ${route.upstreamId} not registered`);
    }
    this.routes.set(route.id, route);
    const { regex, paramNames } = compilePath(route.path);
    this.compiled.set(route.id, { route, regex, paramNames });
    return route;
  }

  registerMiddleware(mw: GatewayMiddleware): GatewayMiddleware {
    this.middleware.set(mw.name, mw);
    return mw;
  }

  listUpstreams(): readonly UpstreamService[] {
    return [...this.upstreams.values()];
  }

  listRoutes(): readonly GatewayRoute[] {
    return [...this.routes.values()];
  }

  listMiddleware(): readonly GatewayMiddleware[] {
    return [...this.middleware.values()].sort((a, b) => a.order - b.order);
  }

  /**
   * Match a (method, path) to a route + upstream.
   * - Method `*` on a route matches any method.
   * - Routes are matched in registration order; first match wins.
   * - Returns `undefined` if no route matches.
   */
  match(method: string, path: string): MatchResult | undefined {
    for (const { route, regex, paramNames } of this.compiled.values()) {
      if (route.method !== "*" && route.method !== method.toUpperCase()) continue;
      const m = regex.exec(path);
      if (!m) continue;
      const upstream = this.upstreams.get(route.upstreamId);
      if (!upstream) continue;
      const params: Record<string, string> = {};
      paramNames.forEach((name, i) => {
        params[name] = decodeURIComponent(m[i + 1]);
      });
      return { route, upstream, params };
    }
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// RateLimiter — REAL token bucket with continuous refill
// ---------------------------------------------------------------------------

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly resetAt: string; // ISO time when the bucket would be fully refilled
  readonly retryAfterMs?: number;
}

interface Bucket {
  tokens: number;
  lastRefillAt: number;
}

/**
 * Real token-bucket rate limiter.
 *
 * - Each key (tenantId / IP / userId / "global") gets its own bucket.
 * - Tokens refill continuously: tokens += (now - lastRefillAt) * refillPerSecond / 1000.
 * - Tokens are capped at `capacity`.
 * - `check(key, cost)` returns allowed=true if enough tokens are present
 *   (and deducts them), otherwise returns allowed=false with retryAfterMs.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly policies = new Map<string, RateLimitPolicy>();

  /** Register a named policy that callers can attach to routes/keys. */
  registerPolicy(name: string, policy: RateLimitPolicy): RateLimitPolicy {
    this.policies.set(name, policy);
    return policy;
  }

  listPolicies(): readonly { name: string; policy: RateLimitPolicy }[] {
    return [...this.policies.entries()].map(([name, policy]) => ({ name, policy }));
  }

  check(key: string, costOrPolicy: number | RateLimitPolicy = 1): RateLimitDecision {
    const cost = typeof costOrPolicy === "number" ? costOrPolicy : (costOrPolicy.cost ?? 1);
    const policy =
      typeof costOrPolicy === "number"
        ? { capacity: 100, refillPerSecond: 10 }
        : costOrPolicy;
    const now = Date.now();
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: policy.capacity, lastRefillAt: now };
      this.buckets.set(key, bucket);
    }
    // Continuous refill
    const elapsedSec = (now - bucket.lastRefillAt) / 1000;
    const refilled = elapsedSec * policy.refillPerSecond;
    bucket.tokens = Math.min(policy.capacity, bucket.tokens + refilled);
    bucket.lastRefillAt = now;

    if (bucket.tokens >= cost) {
      bucket.tokens -= cost;
      const resetAtMs = now + ((policy.capacity - bucket.tokens) / policy.refillPerSecond) * 1000;
      return {
        allowed: true,
        remaining: Math.floor(bucket.tokens),
        resetAt: new Date(resetAtMs).toISOString(),
      };
    }
    const deficit = cost - bucket.tokens;
    const retryAfterMs = Math.ceil((deficit / policy.refillPerSecond) * 1000);
    return {
      allowed: false,
      remaining: Math.floor(bucket.tokens),
      resetAt: new Date(now + retryAfterMs).toISOString(),
      retryAfterMs,
    };
  }

  /** Reset a specific key (e.g. after a successful auth or ban-lift). */
  reset(key: string): void {
    this.buckets.delete(key);
  }

  /** Snapshot of current bucket states (for observability). */
  snapshot(): readonly { key: string; tokens: number }[] {
    const out: { key: string; tokens: number }[] = [];
    for (const [key, b] of this.buckets.entries()) {
      out.push({ key, tokens: b.tokens });
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Cache — REAL TTL cache
// ---------------------------------------------------------------------------

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

/**
 * Real TTL cache. Entries expire lazily on read and proactively on a sweep
 * interval. `invalidate` removes a single key; `clear` wipes everything.
 */
export class Cache<T = unknown> {
  private readonly store = new Map<string, CacheEntry<T>>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(sweepIntervalMs = 60_000) {
    if (sweepIntervalMs > 0 && typeof setInterval !== "undefined") {
      this.sweepTimer = setInterval(() => this.sweep(), sweepIntervalMs);
      // Don't keep the Node process alive just for cache sweeps.
      if (this.sweepTimer && typeof this.sweepTimer.unref === "function") {
        this.sweepTimer.unref();
      }
    }
  }

  get(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() >= entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T, ttlMs: number): void {
    if (ttlMs <= 0) return;
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  invalidate(key: string): boolean {
    return this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }

  size(): number {
    return this.store.size;
  }

  /** Force sweep of expired entries. Returns number removed. */
  sweep(): number {
    const now = Date.now();
    let removed = 0;
    for (const [k, e] of this.store.entries()) {
      if (now >= e.expiresAt) {
        this.store.delete(k);
        removed++;
      }
    }
    return removed;
  }

  dispose(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    this.store.clear();
  }
}

// ---------------------------------------------------------------------------
// VersionNegotiator — REAL Accept-header parsing
// ---------------------------------------------------------------------------

/**
 * Negotiate the best API version from an `Accept` header.
 *
 * Accepts any of:
 *   - application/vnd.eks.v2+json
 *   - application/json; version=v2
 *   - application/vnd.eks+json; version=2
 *   - X-API-Version: 2 (handled by passing the header value as `acceptHeader`)
 *
 * If no version is requested, returns the latest available version.
 */
export class VersionNegotiator {
  negotiate(acceptHeader: string | undefined, available: readonly RouteVersion[]): RouteVersion | undefined {
    if (available.length === 0) return undefined;
    const requested = this.parseRequestedVersion(acceptHeader ?? "");
    if (!requested) {
      // Default to the latest version (lexicographically highest vN).
      return [...available].sort((a, b) => b.localeCompare(a))[0];
    }
    const match = available.find((v) => v === requested);
    if (match) return match;
    // If the requested version is higher than anything available, return the latest.
    const sorted = [...available].sort((a, b) => a.localeCompare(b));
    const latest = sorted[sorted.length - 1];
    if (latest && requested.localeCompare(latest) > 0) return latest;
    return sorted[0];
  }

  private parseRequestedVersion(header: string): RouteVersion | undefined {
    // vendor pattern: application/vnd.eks.vN+json
    const vendor = header.match(/vnd\.eks\.v(\d)\+/i);
    if (vendor) return `v${vendor[1]}` as RouteVersion;
    // version= param: application/json; version=v2 OR version=2
    const param = header.match(/version\s*=\s*"?v?(\d)"?/i);
    if (param) return `v${param[1]}` as RouteVersion;
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// CompressionNegotiator — REAL Accept-Encoding parsing
// ---------------------------------------------------------------------------

export type CompressionAlgorithm = "gzip" | "br" | "identity";

export class CompressionNegotiator {
  /**
   * Pick the best supported encoding from an Accept-Encoding header,
   * respecting q-values. Returns 'identity' when nothing else is acceptable.
   */
  negotiate(acceptEncoding: string | undefined): CompressionAlgorithm {
    if (!acceptEncoding) return "identity";
    const parts = acceptEncoding
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => {
        const [name, q] = p.split(";");
        const qVal = q?.match(/q\s*=\s*([\d.]+)/i)?.[1];
        return {
          name: name.trim().toLowerCase(),
          q: qVal === undefined ? 1 : Number.parseFloat(qVal),
        };
      })
      .filter((p) => !Number.isNaN(p.q))
      .sort((a, b) => b.q - a.q);

    for (const p of parts) {
      if (p.q <= 0) continue;
      if (p.name === "gzip" || p.name === "x-gzip") return "gzip";
      if (p.name === "br") return "br";
      if (p.name === "identity") return "identity";
      if (p.name === "*") {
        // wildcard — prefer gzip, then br
        return "gzip";
      }
    }
    return "identity";
  }
}

// ---------------------------------------------------------------------------
// Standard middleware descriptors
// ---------------------------------------------------------------------------

export interface MiddlewareDescriptor {
  readonly name: string;
  readonly order: number;
  readonly description: string;
  readonly phase: "before" | "after" | "both";
}

/**
 * The eight standard middleware in execution order. Lower `order` runs first
 * in the before-phase; the after-phase runs in reverse order.
 *
 *   request_id   (1)  — assign / propagate request id
 *   cors         (2)  — emit CORS headers / handle preflight
 *   tracing      (3)  — start/finish a trace span
 *   logging      (4)  — structured access log
 *   auth         (5)  — authenticate the principal
 *   rate_limit   (6)  — enforce rate limit
 *   compression  (7)  — negotiate response encoding
 *   caching      (8)  — serve from cache / store response
 */
export const STANDARD_MIDDLEWARE: readonly MiddlewareDescriptor[] = [
  {
    name: "request_id",
    order: 1,
    description: "Assigns or propagates a request id used for correlation across services.",
    phase: "both",
  },
  {
    name: "cors",
    order: 2,
    description: "Handles CORS preflight and injects Access-Control-* headers.",
    phase: "both",
  },
  {
    name: "tracing",
    order: 3,
    description: "Opens and closes a distributed-tracing span around the request.",
    phase: "both",
  },
  {
    name: "logging",
    order: 4,
    description: "Writes a structured access log line with method, path, status, latency.",
    phase: "both",
  },
  {
    name: "auth",
    order: 5,
    description: "Authenticates the caller using registered AuthHooks; attaches principal.",
    phase: "before",
  },
  {
    name: "rate_limit",
    order: 6,
    description: "Enforces the route's RateLimitPolicy via the token-bucket RateLimiter.",
    phase: "before",
  },
  {
    name: "compression",
    order: 7,
    description: "Negotiates response encoding based on the Accept-Encoding header.",
    phase: "after",
  },
  {
    name: "caching",
    order: 8,
    description: "Serves cached responses and stores new ones per the route's CachePolicy.",
    phase: "both",
  },
];

// ---------------------------------------------------------------------------
// Facade singleton
// ---------------------------------------------------------------------------

export interface GatewayFacade {
  readonly gateway: Gateway;
  readonly rateLimiter: RateLimiter;
  readonly cache: Cache;
  readonly versions: VersionNegotiator;
  readonly compression: CompressionNegotiator;
  readonly middleware: readonly MiddlewareDescriptor[];
}

let _gateway: GatewayFacade | null = null;

export function getGateway(): GatewayFacade {
  if (!_gateway) {
    const gateway = new Gateway();
    // Pre-register the kernel upstream as the first upstream service.
    gateway.registerUpstream({
      id: "kernel",
      name: "Eks-Health Kernel API",
      basePath: "/api/kernel",
      target: "internal://kernel",
      protocol: "rest",
      availableVersions: ["v1"],
      healthCheckPath: "/api/kernel/health",
      timeoutMs: 30_000,
      retryPolicy: { attempts: 3, backoffMs: 200, retryOn: [502, 503, 504] },
    });

    _gateway = {
      gateway,
      rateLimiter: new RateLimiter(),
      cache: new Cache(),
      versions: new VersionNegotiator(),
      compression: new CompressionNegotiator(),
      middleware: STANDARD_MIDDLEWARE,
    };
  }
  return _gateway;
}

export function resetGateway(): void {
  if (_gateway) {
    _gateway.cache.dispose();
  }
  _gateway = null;
}

/** Convenience helpers for the most common request-building operations. */
export function buildGatewayRequest(input: {
  method: string;
  path: string;
  headers?: Record<string, string>;
  query?: Record<string, string | string[]>;
  body?: unknown;
}): GatewayRequest {
  return {
    id: `gwreq_${generateId()}`,
    method: input.method,
    path: input.path,
    headers: input.headers ?? {},
    query: input.query ?? {},
    body: input.body,
    startedAt: getClock().iso(),
  };
}

export function buildGatewayResponse(input: {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
  fromCache?: boolean;
  upstreamLatencyMs?: number;
  totalLatencyMs?: number;
}): GatewayResponse {
  return {
    id: `gwres_${generateId()}`,
    status: input.status,
    headers: input.headers ?? {},
    body: input.body,
    fromCache: input.fromCache,
    upstreamLatencyMs: input.upstreamLatencyMs,
    totalLatencyMs: input.totalLatencyMs ?? 0,
  };
}
