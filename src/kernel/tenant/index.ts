/**
 * Eks-Health Kernel — Multi-Tenancy Subsystem
 *
 * The platform is built multi-tenant from day one. Every record, event, and
 * metric is scoped to a tenant. This subsystem provisions tenants, manages
 * memberships, enforces quotas, and resolves isolation metadata so that
 * downstream services can enforce per-tenant boundaries.
 *
 * Capabilities:
 *  - Heterogeneous tenant types (individual, company, government, insurance,
 *    research, university, ngo) — and open to future types via string union.
 *  - Tiered plans (free / starter / growth / enterprise / government).
 *  - Per-tenant resource quotas with checkQuota enforcement.
 *  - Three isolation levels: shared, dedicated, airgapped.
 *  - Membership registry with extensible roles.
 *  - Lifecycle: provisioning → active → suspended → terminated.
 *  - Audit trail of every provisioning / quota / suspension event.
 *  - Emits `eks.kernel.tenant.provisioned` (and friends) on the event bus.
 */

import type { TenantId, UserId, LifecycleState } from "../core";
import { asTenantId, asUserId, getClock, KernelError } from "../core";
import { getEventBus, buildEvent } from "../events";

export type { TenantId, UserId } from "../core";

// ---------------------------------------------------------------------------
// Tenant taxonomy
// ---------------------------------------------------------------------------

/**
 * The kind of organization a tenant represents. The union is exhaustive for
 * the known types but is also open-ended — callers may pass any other string
 * (e.g. "funder") and it will round-trip through the registry.
 */
export type TenantType =
  | "individual"
  | "company"
  | "government"
  | "insurance"
  | "research"
  | "university"
  | "ngo"
  | (string & {}); // extensible without breaking exhaustiveness checks

/** Commercial / contractual tier of a tenant. Drives default quotas. */
export type TenantTier =
  | "free"
  | "starter"
  | "growth"
  | "enterprise"
  | "government";

/**
 * How strongly a tenant's data is isolated from others.
 *  - shared:      shared infrastructure, logical separation only
 *  - dedicated:   dedicated compute / DB schema
 *  - airgapped:   no network path to other tenants (regulatory)
 */
export type TenantIsolationLevel = "shared" | "dedicated" | "airgapped";

/**
 * Role a user holds within a tenant. Extensible — domain services may
 * introduce new roles without touching this kernel module.
 */
export type TenantRole =
  | "owner"
  | "admin"
  | "member"
  | "viewer"
  | "billing"
  | (string & {});

/** Resources that may be quota-governed for a tenant. */
export type QuotaResource =
  | "users"
  | "patients"
  | "storageMb"
  | "apiCallsPerMonth"
  | "programs"
  | "facilities"
  | (string & {});

// ---------------------------------------------------------------------------
// Tenant data shapes
// ---------------------------------------------------------------------------

export interface Tenant {
  readonly id: TenantId;
  readonly type: TenantType;
  readonly tier: TenantTier;
  readonly name: string;
  readonly slug: string;
  readonly isolationLevel: TenantIsolationLevel;
  readonly region: string;
  readonly ownerId: UserId;
  status: LifecycleState;
  readonly createdAt: string;
  updatedAt: string;
  suspendedAt?: string;
  suspendReason?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface TenantMembership {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly userId: UserId;
  role: TenantRole;
  readonly addedAt: string;
  addedBy?: UserId;
  status: "active" | "revoked";
  revokedAt?: string;
}

export interface TenantQuota {
  readonly tenantId: TenantId;
  /** Hard caps per resource. */
  limits: Record<string, number>;
  /** Current usage counters. */
  usage: Record<string, number>;
  updatedAt: string;
}

/** Resolution of isolation metadata — used by data-plane services. */
export interface TenantContext {
  readonly tenantId: TenantId;
  readonly isolationLevel: TenantIsolationLevel;
  readonly region: string;
  readonly status: LifecycleState;
  readonly tier: TenantTier;
  readonly dedicatedSchema?: string;
  readonly dedicatedKeyId?: string;
  readonly airgapped: boolean;
}

export interface TenantAuditEntry {
  readonly tenantId: TenantId;
  readonly action:
    | "provisioned"
    | "quota_set"
    | "membership_added"
    | "membership_revoked"
    | "suspended"
    | "reactivated"
    | "terminated";
  readonly at: string;
  readonly by?: string;
  readonly before?: unknown;
  readonly after?: unknown;
}

// ---------------------------------------------------------------------------
// Default quotas by tier
// ---------------------------------------------------------------------------

export const DEFAULT_TIER_QUOTAS: Record<TenantTier, Record<string, number>> = {
  free: { users: 5, patients: 100, storageMb: 512, apiCallsPerMonth: 10_000, programs: 1, facilities: 1 },
  starter: { users: 25, patients: 1_000, storageMb: 5_000, apiCallsPerMonth: 100_000, programs: 5, facilities: 3 },
  growth: { users: 100, patients: 10_000, storageMb: 50_000, apiCallsPerMonth: 1_000_000, programs: 25, facilities: 10 },
  enterprise: { users: 1_000, patients: 250_000, storageMb: 500_000, apiCallsPerMonth: 25_000_000, programs: 250, facilities: 100 },
  government: { users: 5_000, patients: 1_000_000, storageMb: 2_000_000, apiCallsPerMonth: 100_000_000, programs: 1_000, facilities: 500 },
};

// ---------------------------------------------------------------------------
// Tenant Manager
// ---------------------------------------------------------------------------

export class TenantManager {
  private readonly tenants = new Map<TenantId, Tenant>();
  private readonly memberships = new Map<TenantId, TenantMembership[]>();
  private readonly quotas = new Map<TenantId, TenantQuota>();
  private readonly audit: TenantAuditEntry[] = [];

  /**
   * Provision a new tenant. Generates an id when not supplied, applies the
   * tier's default quota, marks the owner as the first "owner" member, emits
   * `eks.kernel.tenant.provisioned`, and records an audit entry.
   */
  provision(input: {
    id?: TenantId;
    type: TenantType;
    tier: TenantTier;
    name: string;
    slug: string;
    isolationLevel: TenantIsolationLevel;
    region: string;
    ownerId: UserId;
    metadata?: Record<string, unknown>;
    actor?: string;
  }): Tenant {
    const now = getClock().iso();
    const id = input.id ?? asTenantId(`tnt_${slugify(input.slug)}_${shortId()}`);
    if (this.tenants.has(id)) {
      throw new KernelError({
        code: "eks.error.tenant.already_exists",
        category: "conflict",
        severity: "warn",
        retryable: false,
        developerMessage: `Tenant ${id} already exists`,
        userMessage: "A tenant with that identifier already exists.",
        metadata: { tenantId: id },
      });
    }
    const tenant: Tenant = {
      id,
      type: input.type,
      tier: input.tier,
      name: input.name,
      slug: input.slug,
      isolationLevel: input.isolationLevel,
      region: input.region,
      ownerId: input.ownerId,
      status: "active",
      createdAt: now,
      updatedAt: now,
      metadata: input.metadata,
    };
    this.tenants.set(id, tenant);

    // Default quota derived from the chosen tier.
    const limits = { ...DEFAULT_TIER_QUOTAS[input.tier] };
    this.quotas.set(id, {
      tenantId: id,
      limits,
      usage: {},
      updatedAt: now,
    });

    // Owner is auto-added as the first member.
    this.memberships.set(id, [
      {
        id: `mem_${shortId()}`,
        tenantId: id,
        userId: input.ownerId,
        role: "owner",
        addedAt: now,
        addedBy: input.ownerId,
        status: "active",
      },
    ]);

    this.audit.push({
      tenantId: id,
      action: "provisioned",
      at: now,
      by: input.actor ?? input.ownerId,
      after: { type: input.type, tier: input.tier, isolation: input.isolationLevel },
    });

    void getEventBus().publish(
      buildEvent(
        "eks.kernel.tenant.provisioned",
        {
          tenantId: id,
          type: input.type,
          tier: input.tier,
          name: input.name,
          isolationLevel: input.isolationLevel,
          region: input.region,
          ownerId: input.ownerId,
        },
        { tenantId: id, actor: { kind: "system", id: input.actor ?? "kernel" } },
        "system",
      ),
    );

    return tenant;
  }

  get(id: TenantId): Tenant | undefined {
    return this.tenants.get(id);
  }

  list(filter?: { type?: TenantType; tier?: TenantTier; status?: LifecycleState }): Tenant[] {
    const all = [...this.tenants.values()];
    if (!filter) return all;
    return all.filter(
      (t) =>
        (!filter.type || t.type === filter.type) &&
        (!filter.tier || t.tier === filter.tier) &&
        (!filter.status || t.status === filter.status),
    );
  }

  addMembership(
    tenantId: TenantId,
    userId: UserId,
    role: TenantRole,
    by?: UserId,
  ): TenantMembership {
    const tenant = this.require(tenantId);
    const list = this.memberships.get(tenantId) ?? [];
    const existing = list.find((m) => m.userId === userId && m.status === "active");
    if (existing) {
      throw new KernelError({
        code: "eks.error.tenant.member_exists",
        category: "conflict",
        severity: "warn",
        retryable: false,
        developerMessage: `User ${userId} is already a member of tenant ${tenantId}`,
        userMessage: "That user is already a member.",
        metadata: { tenantId, userId },
      });
    }
    const now = getClock().iso();
    const membership: TenantMembership = {
      id: `mem_${shortId()}`,
      tenantId,
      userId,
      role,
      addedAt: now,
      addedBy: by,
      status: "active",
    };
    list.push(membership);
    this.memberships.set(tenantId, list);
    tenant.updatedAt = now;
    this.audit.push({ tenantId, action: "membership_added", at: now, by, after: { userId, role } });
    return membership;
  }

  revokeMembership(tenantId: TenantId, userId: UserId, by?: UserId): void {
    const list = this.memberships.get(tenantId) ?? [];
    const m = list.find((x) => x.userId === userId && x.status === "active");
    if (!m) return;
    m.status = "revoked";
    m.revokedAt = getClock().iso();
    this.audit.push({
      tenantId,
      action: "membership_revoked",
      at: m.revokedAt,
      by,
      before: { role: m.role },
    });
  }

  listMembers(tenantId: TenantId, includeRevoked = false): TenantMembership[] {
    const list = this.memberships.get(tenantId) ?? [];
    return includeRevoked ? [...list] : list.filter((m) => m.status === "active");
  }

  setQuota(tenantId: TenantId, quota: Partial<Pick<TenantQuota, "limits" | "usage">>): TenantQuota {
    const current = this.quotas.get(tenantId);
    if (!current) {
      throw new KernelError({
        code: "eks.error.tenant.quota_not_found",
        category: "not_found",
        severity: "warn",
        retryable: false,
        developerMessage: `No quota record for tenant ${tenantId}`,
        userMessage: "Tenant quota is not initialized.",
        metadata: { tenantId },
      });
    }
    const before = { limits: { ...current.limits }, usage: { ...current.usage } };
    if (quota.limits) current.limits = { ...current.limits, ...quota.limits };
    if (quota.usage) current.usage = { ...current.usage, ...quota.usage };
    current.updatedAt = getClock().iso();
    this.audit.push({
      tenantId,
      action: "quota_set",
      at: current.updatedAt,
      before,
      after: { limits: current.limits, usage: current.usage },
    });
    return current;
  }

  getQuota(tenantId: TenantId): TenantQuota | undefined {
    return this.quotas.get(tenantId);
  }

  /**
   * Check whether `usage` additional units of `resource` would still fit
   * inside the tenant's hard cap. Returns true if it fits. Does NOT mutate
   * usage — call recordUsage() to commit.
   */
  checkQuota(tenantId: TenantId, resource: QuotaResource, usage: number): boolean {
    const quota = this.quotas.get(tenantId);
    if (!quota) return false;
    const limit = quota.limits[resource];
    if (limit === undefined) return true; // unbounded if not configured
    const current = quota.usage[resource] ?? 0;
    return current + usage <= limit;
  }

  /** Commit usage against a tenant. Refuses to exceed hard caps. */
  recordUsage(tenantId: TenantId, resource: QuotaResource, amount: number): boolean {
    const quota = this.quotas.get(tenantId);
    if (!quota) return false;
    if (!this.checkQuota(tenantId, resource, amount)) return false;
    quota.usage[resource] = (quota.usage[resource] ?? 0) + amount;
    quota.updatedAt = getClock().iso();
    return true;
  }

  suspend(tenantId: TenantId, reason: string, by?: string): Tenant {
    const tenant = this.require(tenantId);
    if (tenant.status === "terminated") {
      throw new KernelError({
        code: "eks.error.tenant.terminated",
        category: "conflict",
        severity: "warn",
        retryable: false,
        developerMessage: `Tenant ${tenantId} is terminated and cannot be suspended`,
        userMessage: "That tenant is already terminated.",
        metadata: { tenantId },
      });
    }
    const before = tenant.status;
    // LifecycleState has no "suspended" member; we map to "maintenance"
    // which the rest of the platform interprets as "no traffic allowed".
    tenant.status = "maintenance";
    tenant.suspendedAt = getClock().iso();
    tenant.suspendReason = reason;
    tenant.updatedAt = tenant.suspendedAt;
    this.audit.push({
      tenantId,
      action: "suspended",
      at: tenant.suspendedAt,
      by,
      before,
      after: { reason },
    });
    void getEventBus().publish(
      buildEvent(
        "eks.kernel.tenant.suspended",
        { tenantId, reason },
        { tenantId, actor: { kind: "system", id: by ?? "kernel" } },
        "system",
      ),
    );
    return tenant;
  }

  reactivate(tenantId: TenantId, by?: string): Tenant {
    const tenant = this.require(tenantId);
    if (tenant.status !== "maintenance") return tenant;
    const before = tenant.status;
    tenant.status = "active";
    tenant.suspendedAt = undefined;
    tenant.suspendReason = undefined;
    tenant.updatedAt = getClock().iso();
    this.audit.push({
      tenantId,
      action: "reactivated",
      at: tenant.updatedAt,
      by,
      before,
    });
    return tenant;
  }

  terminate(tenantId: TenantId, by?: string): Tenant {
    const tenant = this.require(tenantId);
    const before = tenant.status;
    tenant.status = "terminated";
    tenant.updatedAt = getClock().iso();
    this.audit.push({
      tenantId,
      action: "terminated",
      at: tenant.updatedAt,
      by,
      before,
    });
    return tenant;
  }

  /**
   * Resolve the isolation context for a tenant. Downstream services (DB
   * router, cache key builder, crypto key resolver) call this to decide
   * which physical resources a request may touch.
   */
  resolveTenantContext(tenantId: TenantId): TenantContext {
    const tenant = this.require(tenantId);
    const dedicatedSchema =
      tenant.isolationLevel === "dedicated" ? `tnt_${slugify(tenant.slug)}` : undefined;
    const dedicatedKeyId =
      tenant.isolationLevel !== "shared" ? `key_${tenant.id}` : undefined;
    return {
      tenantId: tenant.id,
      isolationLevel: tenant.isolationLevel,
      region: tenant.region,
      status: tenant.status,
      tier: tenant.tier,
      dedicatedSchema,
      dedicatedKeyId,
      airgapped: tenant.isolationLevel === "airgapped",
    };
  }

  getAudit(filter?: { tenantId?: TenantId; action?: TenantAuditEntry["action"] }): TenantAuditEntry[] {
    let entries = [...this.audit];
    if (filter?.tenantId) entries = entries.filter((e) => e.tenantId === filter.tenantId);
    if (filter?.action) entries = entries.filter((e) => e.action === filter.action);
    return entries;
  }

  private require(id: TenantId): Tenant {
    const t = this.tenants.get(id);
    if (!t) {
      throw new KernelError({
        code: "eks.error.tenant.not_found",
        category: "not_found",
        severity: "warn",
        retryable: false,
        developerMessage: `Tenant ${id} not found`,
        userMessage: "Tenant not found.",
        metadata: { tenantId: id },
      });
    }
    return t;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "tenant";
}

function shortId(): string {
  return Math.random().toString(36).slice(2, 10);
}

// ---------------------------------------------------------------------------
// Id helpers (typed)
// ---------------------------------------------------------------------------

export function tenantId(s: string): TenantId {
  return asTenantId(s);
}

export function userId(s: string): UserId {
  return asUserId(s);
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _mgr: TenantManager | null = null;
export function getTenants(): TenantManager {
  if (!_mgr) _mgr = new TenantManager();
  return _mgr;
}
export function setTenants(mgr: TenantManager): void {
  _mgr = mgr;
}

// ---------------------------------------------------------------------------
// Well-known tenant event types
// ---------------------------------------------------------------------------

export const TENANT_EVENTS = {
  provisioned: "eks.kernel.tenant.provisioned",
  suspended: "eks.kernel.tenant.suspended",
  quotaSet: "eks.kernel.tenant.quota_set",
  membershipChanged: "eks.kernel.tenant.membership_changed",
} as const;

export type TenantEventType = (typeof TENANT_EVENTS)[keyof typeof TENANT_EVENTS];
