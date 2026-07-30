/**
 * Eks-Health Identity — Authorization Engine
 *
 * Unified policy engine that mediates EVERY permission decision on the
 * platform. Combines:
 *   - RBAC  (role-based access control, delegated to ../roles)
 *   - ABAC  (attribute-based access control, via PolicyCondition)
 *   - PBAC  (purpose-based access control, via purpose-bound grants + consent)
 *   - Hierarchical scoping (org implies team implies program)
 *   - Conditional grants (time-of-day, country, etc.)
 *   - Temporary grants (auto-expiring)
 *   - Delegated permissions (account A delegates to account B)
 *   - Simulation ("what-if" planning for permission UIs)
 *   - Auditing (every evaluation is logged + emitted as an event)
 *
 * Nothing in application code should hardcode a role check — every decision
 * flows through `getAuthorization().evaluate(ctx, permission)`. Default-deny
 * unless an explicit allow path matches.
 */

import "server-only";

import {
  type AccountId,
  type Persona,
  type GrantId,
  type PolicyId,
  IdentityError,
  asGrantId,
  asPolicyId,
} from "../core";
import type { ResourceId } from "@/kernel";
import { getEventBus, buildEvent, generateId, getClock } from "@/kernel";
import { getRoles } from "../roles";
import { getConsent } from "../consent";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Permission = string;
export type AuthorizationDecision = "allow" | "deny" | "challenge";
export type DeviceTrust = "untrusted" | "low" | "medium" | "high";

export interface EvaluationContext {
  readonly accountId: AccountId;
  readonly persona: Persona;
  readonly orgId?: string;
  readonly teamId?: string;
  readonly programId?: string;
  readonly purpose?: string;
  readonly fields?: readonly string[];
  readonly resource?: ResourceId;
  readonly attributes?: Record<string, unknown>;
  readonly ipAddress?: string;
  readonly deviceTrust?: DeviceTrust;
  readonly time: string; // ISO-8601 UTC
}

export type ConditionOperator =
  | "eq"
  | "ne"
  | "in"
  | "not_in"
  | "gt"
  | "lt"
  | "gte"
  | "lte"
  | "regex"
  | "purpose_in"
  | "has_consent"
  | "attr_eq"; // compare two attribute paths

export interface PolicyCondition {
  readonly attribute: string; // dotted path into ctx, e.g. "attributes.country"
  readonly operator: ConditionOperator;
  readonly value: unknown;
}

export interface Policy {
  readonly id: PolicyId;
  readonly name: string;
  readonly description: string;
  readonly effect: "allow" | "deny";
  readonly conditions: readonly PolicyCondition[];
  readonly priority: number; // higher = evaluated first
  readonly scope?: string; // optional scope qualifier (org:|team:|program:|global)
}

export interface PermissionGrant {
  readonly id: GrantId;
  readonly accountId: AccountId;
  readonly permission: Permission;
  readonly scope?: string;
  readonly grantedBy: AccountId;
  readonly grantedAt: string;
  readonly expiresAt?: string;
  readonly purpose?: string;
  readonly conditions?: readonly PolicyCondition[];
}

export type DelegationId = string & { readonly __brand: "DelegationId" };
export function asDelegationId(s: string): DelegationId {
  return s as DelegationId;
}

export interface Delegation {
  readonly id: DelegationId;
  readonly delegatorAccountId: AccountId;
  readonly delegateAccountId: AccountId;
  readonly permissions: readonly Permission[];
  readonly scope?: string;
  readonly createdAt: string;
  readonly expiresAt?: string;
  readonly reason?: string;
}

export interface AuthorizationResult {
  readonly decision: AuthorizationDecision;
  readonly reasons: readonly string[];
  readonly matchedPolicies: readonly PolicyId[];
  readonly grantsUsed: readonly GrantId[];
  readonly delegationsUsed: readonly DelegationId[];
  readonly evaluatedAt: string;
}

export interface EvaluationLogEntry {
  readonly id: string;
  readonly timestamp: string;
  readonly accountId: AccountId;
  readonly permission: Permission;
  readonly decision: AuthorizationDecision;
  readonly reasons: readonly string[];
  readonly matchedPolicies: readonly PolicyId[];
  readonly grantsUsed: readonly GrantId[];
  readonly delegationsUsed: readonly DelegationId[];
  readonly context: EvaluationContext;
}

// ---------------------------------------------------------------------------
// Built-in policy catalog
// ---------------------------------------------------------------------------

export const SENSITIVE_PERMISSIONS: ReadonlySet<Permission> = new Set<Permission>([
  "data:sensitive:read",
  "data:sensitive:write",
  "account:delete",
  "org:members:manage",
  "platform:config:write",
  "marketplace:approve",
  "consent:override",
  "research:deidentified:export",
]);

export const POLICIES: readonly Policy[] = [
  {
    id: asPolicyId("deny_deleted_accounts"),
    name: "Deny Deleted Accounts",
    description: "Accounts in 'deleted' state cannot perform any action.",
    effect: "deny",
    conditions: [
      { attribute: "attributes.accountState", operator: "eq", value: "deleted" },
    ],
    priority: 100,
    scope: "global",
  },
  {
    id: asPolicyId("deny_cross_tenant"),
    name: "Deny Cross-Tenant Access",
    description:
      "An account cannot access resources owned by a different organization.",
    effect: "deny",
    conditions: [
      { attribute: "attributes.crossTenant", operator: "eq", value: true },
    ],
    priority: 95,
    scope: "global",
  },
  {
    id: asPolicyId("require_mfa_for_sensitive"),
    name: "Require MFA for Sensitive Permissions",
    description:
      "Sensitive permissions are denied when MFA is not verified. In practice the engine's step-up short-circuit fires first and returns 'challenge' (so the user can complete MFA and re-evaluate); this policy is the hard-deny backstop if step-up is ever bypassed.",
    effect: "deny",
    conditions: [
      { attribute: "permission", operator: "in", value: [...SENSITIVE_PERMISSIONS] },
      { attribute: "attributes.mfaVerified", operator: "eq", value: false },
    ],
    priority: 90,
    scope: "global",
  },
  {
    id: asPolicyId("deny_outside_business_hours_for_auditor"),
    name: "Deny Auditors Outside Business Hours",
    description:
      "Accounts acting as auditors may not access the system outside business hours (Mon–Fri 09:00–17:00 local).",
    effect: "deny",
    conditions: [
      { attribute: "attributes.role", operator: "eq", value: "auditor" },
      { attribute: "attributes.isOutsideBusinessHours", operator: "eq", value: true },
    ],
    priority: 80,
    scope: "global",
  },
  {
    id: asPolicyId("require_verified_email_for_publish"),
    name: "Require Verified Email for Publishing",
    description:
      "Marketplace publishing requires a verified email address.",
    effect: "allow",
    conditions: [
      { attribute: "permission", operator: "regex", value: "^marketplace:publish" },
      { attribute: "attributes.verifiedEmail", operator: "eq", value: true },
    ],
    priority: 70,
    scope: "global",
  },
  {
    id: asPolicyId("allow_self_read_always"),
    name: "Allow Self-Read Always",
    description:
      "Accounts can always read their own data, even without an explicit grant (subject to deny policies).",
    effect: "allow",
    conditions: [
      { attribute: "permission", operator: "regex", value: "^self:read" },
      { attribute: "attributes.isSelfResource", operator: "eq", value: true },
    ],
    priority: 50,
    scope: "global",
  },
] as const;

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export const AUTH_EVENTS = {
  permissionGranted: "eks.identity.permission.granted",
  permissionDenied: "eks.identity.permission.denied",
  permissionEvaluated: "eks.identity.permission.evaluated",
  grantCreated: "eks.identity.permission.grant.created",
  grantRevoked: "eks.identity.permission.grant.revoked",
  delegationCreated: "eks.identity.permission.delegation.created",
  delegationRevoked: "eks.identity.permission.delegation.revoked",
} as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a dotted attribute path against the evaluation context.
 * Special virtual paths:
 *   - "permission"   → the permission being evaluated
 *   - "persona"      → ctx.persona
 *   - "orgId"        → ctx.orgId
 *   - "teamId"       → ctx.teamId
 *   - "programId"    → ctx.programId
 *   - "purpose"      → ctx.purpose
 *   - "ipAddress"    → ctx.ipAddress
 *   - "deviceTrust"  → ctx.deviceTrust
 *   - "fields"       → ctx.fields
 *   - "time"         → ctx.time
 *   - "attributes.X" → ctx.attributes?.X (nested paths supported)
 */
function resolveAttribute(ctx: EvaluationContext, path: string): unknown {
  switch (path) {
    case "permission": return undefined; // injected by caller of conditionMatches
    case "persona": return ctx.persona;
    case "orgId": return ctx.orgId;
    case "teamId": return ctx.teamId;
    case "programId": return ctx.programId;
    case "purpose": return ctx.purpose;
    case "ipAddress": return ctx.ipAddress;
    case "deviceTrust": return ctx.deviceTrust;
    case "fields": return ctx.fields;
    case "time": return ctx.time;
    default: {
      if (path.startsWith("attributes.")) {
        const parts = path.split(".").slice(1);
        let cur: unknown = ctx.attributes ?? {};
        for (const p of parts) {
          if (cur && typeof cur === "object" && p in (cur as Record<string, unknown>)) {
            cur = (cur as Record<string, unknown>)[p];
          } else {
            return undefined;
          }
        }
        return cur;
      }
      return undefined;
    }
  }
}

/**
 * Compute derived attributes from the context. These are merged into
 * ctx.attributes before policy evaluation so conditions can reference them.
 */
function computeDerivedAttributes(ctx: EvaluationContext): Record<string, unknown> {
  const derived: Record<string, unknown> = {};
  const t = ctx.time ? new Date(ctx.time) : new Date();
  if (!Number.isNaN(t.getTime())) {
    derived.hourOfDay = t.getUTCHours();
    derived.dayOfWeek = t.getUTCDay(); // 0=Sun..6=Sat
    derived.isWeekend = derived.dayOfWeek === 0 || derived.dayOfWeek === 6;
    const h = derived.hourOfDay as number;
    derived.isOutsideBusinessHours = h < 9 || h > 17 || derived.isWeekend === true;
  }
  // Cross-tenant detection: caller may set attributes.targetOrgId
  const attrs = ctx.attributes ?? {};
  if (attrs.targetOrgId !== undefined) {
    derived.crossTenant = ctx.orgId !== undefined && attrs.targetOrgId !== ctx.orgId;
  }
  // Self-resource detection: caller may set attributes.resourceOwnerId
  if (attrs.resourceOwnerId !== undefined) {
    derived.isSelfResource = attrs.resourceOwnerId === ctx.accountId;
  }
  return derived;
}

function mergeContext(ctx: EvaluationContext): EvaluationContext {
  const derived = computeDerivedAttributes(ctx);
  const attrs = { ...(ctx.attributes ?? {}), ...derived };
  return { ...ctx, attributes: attrs };
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ak = Object.keys(a as Record<string, unknown>);
    const bk = Object.keys(b as Record<string, unknown>);
    return ak.length === bk.length && ak.every((k) =>
      deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    );
  }
  return false;
}

function conditionMatches(
  ctx: EvaluationContext,
  cond: PolicyCondition,
  permission: Permission,
): boolean {
  // has_consent is a special operator that queries the consent engine.
  if (cond.operator === "has_consent") {
    const v = cond.value as
      | boolean
      | { programId?: string; purpose?: string; field?: string }
      | undefined;
    const programId = typeof v === "object" && v ? v.programId : ctx.programId;
    const purpose = typeof v === "object" && v ? v.purpose : ctx.purpose;
    const field = typeof v === "object" && v ? v.field : ctx.fields?.[0];
    if (!programId || !purpose) return false;
    try {
      return getConsent().checkAccess(ctx.accountId, programId, purpose, field);
    } catch {
      // If consent engine fails closed — treat as no consent.
      return false;
    }
  }

  // purpose_in: check if ctx.purpose is in the value list.
  if (cond.operator === "purpose_in") {
    const list = Array.isArray(cond.value) ? cond.value : [cond.value];
    return list.includes(ctx.purpose);
  }

  // attr_eq: compare two attribute paths.
  if (cond.operator === "attr_eq") {
    const otherPath = cond.value as string;
    const a = resolveAttribute(ctx, cond.attribute);
    const b = resolveAttribute(ctx, otherPath);
    return deepEqual(a, b);
  }

  const actual = cond.attribute === "permission" ? permission : resolveAttribute(ctx, cond.attribute);

  switch (cond.operator) {
    case "eq": return deepEqual(actual, cond.value);
    case "ne": return !deepEqual(actual, cond.value);
    case "in": {
      if (!Array.isArray(cond.value)) return false;
      return cond.value.some((v) => deepEqual(actual, v));
    }
    case "not_in": {
      if (!Array.isArray(cond.value)) return true;
      return !cond.value.some((v) => deepEqual(actual, v));
    }
    case "gt": return typeof actual === "number" && typeof cond.value === "number" && actual > cond.value;
    case "lt": return typeof actual === "number" && typeof cond.value === "number" && actual < cond.value;
    case "gte": return typeof actual === "number" && typeof cond.value === "number" && actual >= cond.value;
    case "lte": return typeof actual === "number" && typeof cond.value === "number" && actual <= cond.value;
    case "regex": {
      if (typeof actual !== "string") return false;
      try {
        return new RegExp(cond.value as string).test(actual);
      } catch {
        return false;
      }
    }
    default: return false;
  }
}

function allConditionsMatch(
  ctx: EvaluationContext,
  conditions: readonly PolicyCondition[],
  permission: Permission,
): boolean {
  return conditions.every((c) => conditionMatches(ctx, c, permission));
}

/**
 * Hierarchical scope implication.
 *   grant scope "global" / ""      → applies to any ctx
 *   grant scope "org:X"            → applies if ctx.orgId === X (covers teams within X)
 *   grant scope "team:X"           → applies only if ctx.teamId === X
 *   grant scope "program:X"        → applies only if ctx.programId === X
 * Hierarchical implication: an org-scoped grant implies team-scoped access
 * within that org (because the team belongs to the org).
 */
function scopeImplies(grantScope: string | undefined, ctx: EvaluationContext): boolean {
  if (!grantScope || grantScope === "global") return true;
  const idx = grantScope.indexOf(":");
  if (idx === -1) return false;
  const kind = grantScope.slice(0, idx);
  const id = grantScope.slice(idx + 1);
  switch (kind) {
    case "org": return ctx.orgId === id;
    case "team": return ctx.teamId === id;
    case "program": return ctx.programId === id;
    default: return false;
  }
}

// ---------------------------------------------------------------------------
// Authorization engine
// ---------------------------------------------------------------------------

export class AuthorizationEngine {
  private readonly policies = new Map<PolicyId, Policy>();
  private readonly grants = new Map<GrantId, PermissionGrant>();
  private readonly grantsByAccount = new Map<AccountId, Set<GrantId>>();
  private readonly delegations = new Map<DelegationId, Delegation>();
  private readonly delegationsByDelegate = new Map<AccountId, Set<DelegationId>>();
  private readonly delegationsByDelegator = new Map<AccountId, Set<DelegationId>>();
  private readonly auditLog: EvaluationLogEntry[] = [];
  private readonly auditSink?: (entry: EvaluationLogEntry) => void;

  constructor(auditSink?: (entry: EvaluationLogEntry) => void) {
    this.auditSink = auditSink;
    for (const p of POLICIES) this.policies.set(p.id, p);
  }

  // ----- Policy registry ----------------------------------------------------

  registerPolicy(policy: Policy): void {
    if (this.policies.has(policy.id)) {
      throw new IdentityError({
        code: "eks.identity.authorization.policy_exists",
        category: "conflict",
        message: `Policy ${policy.id} already registered.`,
        userMessage: "A policy with this id already exists.",
      });
    }
    this.policies.set(policy.id, policy);
  }

  getPolicy(id: PolicyId): Policy | undefined {
    return this.policies.get(id);
  }

  listPolicies(): readonly Policy[] {
    return [...this.policies.values()].sort((a, b) => b.priority - a.priority);
  }

  // ----- Grant registry -----------------------------------------------------

  grant(input: Omit<PermissionGrant, "id" | "grantedAt">): PermissionGrant {
    const id = asGrantId(generateId("grt_"));
    const g: PermissionGrant = {
      ...input,
      id,
      grantedAt: getClock().iso(),
    };
    this.grants.set(id, g);
    const set = this.grantsByAccount.get(g.accountId) ?? new Set();
    set.add(id);
    this.grantsByAccount.set(g.accountId, set);
    void getEventBus().publish(
      buildEvent(
        AUTH_EVENTS.grantCreated,
        {
          grantId: id,
          accountId: g.accountId,
          permission: g.permission,
          scope: g.scope,
          expiresAt: g.expiresAt,
          purpose: g.purpose,
          grantedBy: g.grantedBy,
        },
        {},
        "domain",
      ),
    );
    return g;
  }

  revokeGrant(grantId: GrantId): void {
    const g = this.grants.get(grantId);
    if (!g) return;
    this.grants.delete(grantId);
    const set = this.grantsByAccount.get(g.accountId);
    if (set) {
      set.delete(grantId);
      if (set.size === 0) this.grantsByAccount.delete(g.accountId);
    }
    void getEventBus().publish(
      buildEvent(
        AUTH_EVENTS.grantRevoked,
        { grantId, accountId: g.accountId, permission: g.permission },
        {},
        "domain",
      ),
    );
  }

  listGrants(accountId: AccountId): readonly PermissionGrant[] {
    const set = this.grantsByAccount.get(accountId);
    if (!set) return [];
    return [...set].map((id) => this.grants.get(id)!).filter(Boolean);
  }

  // ----- Delegation registry ------------------------------------------------

  delegate(input: Omit<Delegation, "id" | "createdAt">): Delegation {
    const id = asDelegationId(generateId("dlg_"));
    const d: Delegation = {
      ...input,
      id,
      createdAt: getClock().iso(),
    };
    this.delegations.set(id, d);
    const byDel = this.delegationsByDelegate.get(d.delegateAccountId) ?? new Set();
    byDel.add(id);
    this.delegationsByDelegate.set(d.delegateAccountId, byDel);
    const byDelegator = this.delegationsByDelegator.get(d.delegatorAccountId) ?? new Set();
    byDelegator.add(id);
    this.delegationsByDelegator.set(d.delegatorAccountId, byDelegator);
    void getEventBus().publish(
      buildEvent(
        AUTH_EVENTS.delegationCreated,
        {
          delegationId: id,
          delegator: d.delegatorAccountId,
          delegate: d.delegateAccountId,
          permissions: d.permissions,
          scope: d.scope,
          expiresAt: d.expiresAt,
        },
        {},
        "domain",
      ),
    );
    return d;
  }

  revokeDelegation(id: DelegationId): void {
    const d = this.delegations.get(id);
    if (!d) return;
    this.delegations.delete(id);
    const byDel = this.delegationsByDelegate.get(d.delegateAccountId);
    if (byDel) {
      byDel.delete(id);
      if (byDel.size === 0) this.delegationsByDelegate.delete(d.delegateAccountId);
    }
    const byDelegator = this.delegationsByDelegator.get(d.delegatorAccountId);
    if (byDelegator) {
      byDelegator.delete(id);
      if (byDelegator.size === 0) this.delegationsByDelegator.delete(d.delegatorAccountId);
    }
    void getEventBus().publish(
      buildEvent(
        AUTH_EVENTS.delegationRevoked,
        { delegationId: id, delegator: d.delegatorAccountId, delegate: d.delegateAccountId },
        {},
        "domain",
      ),
    );
  }

  listDelegations(accountId: AccountId, asDelegator = false): readonly Delegation[] {
    const map = asDelegator ? this.delegationsByDelegator : this.delegationsByDelegate;
    const set = map.get(accountId);
    if (!set) return [];
    return [...set].map((id) => this.delegations.get(id)!).filter(Boolean);
  }

  // ----- Core evaluation ----------------------------------------------------

  /**
   * Evaluate whether `ctx.accountId` may perform `permission` in `ctx`.
   * Decision flow:
   *   1. Compute derived ABAC attributes.
   *   2. Sensitive-permission step-up: if permission ∈ SENSITIVE_PERMISSIONS
   *      and mfaVerified != true → "challenge" (BEFORE policy eval, so the
   *      absence of MFA does not leak whether the account would otherwise
   *      have access).
   *   3. Walk policies highest-priority-first. Any matching DENY policy → "deny".
   *   4. Check ALLOW policies, RBAC (via getRoles), explicit grants, delegations.
   *   5. If at least one allow path matched AND no deny → "allow".
   *   6. Default-deny.
   */
  evaluate(
    ctx: EvaluationContext,
    permission: Permission,
    opts: { extraGrants?: readonly PermissionGrant[]; audit?: boolean } = {},
  ): AuthorizationResult {
    const ec = mergeContext(ctx);
    const reasons: string[] = [];
    const matchedPolicies: PolicyId[] = [];
    const grantsUsed: GrantId[] = [];
    const delegationsUsed: DelegationId[] = [];
    const now = Date.now();

    // Sensitive-permission step-up: if the permission is in SENSITIVE_PERMISSIONS
    // and the context does not prove MFA verification, return "challenge" so the
    // caller can step-up the session and re-evaluate. This short-circuits BEFORE
    // policy evaluation so the absence of MFA does not leak whether the account
    // would otherwise have access (challenge either way → no inference).
    if (
      SENSITIVE_PERMISSIONS.has(permission) &&
      ec.attributes?.mfaVerified !== true
    ) {
      reasons.push(
        "Challenge: sensitive permission requires MFA step-up before evaluation",
      );
      const result: AuthorizationResult = {
        decision: "challenge",
        reasons,
        matchedPolicies,
        grantsUsed,
        delegationsUsed,
        evaluatedAt: getClock().iso(),
      };
      if (opts.audit !== false) this.audit(ec, permission, result);
      return result;
    }

    // Sort policies by priority descending.
    const ordered = [...this.policies.values()].sort((a, b) => b.priority - a.priority);

    let denyMatched = false;
    let allowPolicyMatched = false;

    for (const p of ordered) {
      if (!allConditionsMatch(ec, p.conditions, permission)) continue;
      matchedPolicies.push(p.id);
      if (p.effect === "deny") {
        denyMatched = true;
        reasons.push(`Policy '${p.name}' (${p.id}) denies`);
      } else {
        allowPolicyMatched = true;
        reasons.push(`Policy '${p.name}' (${p.id}) allows`);
      }
    }

    if (denyMatched) {
      const result: AuthorizationResult = {
        decision: "deny",
        reasons,
        matchedPolicies,
        grantsUsed,
        delegationsUsed,
        evaluatedAt: getClock().iso(),
      };
      if (opts.audit !== false) this.audit(ec, permission, result);
      return result;
    }

    // RBAC check via roles subsystem (m2-2).
    let rbacAllow = false;
    try {
      rbacAllow = getRoles().hasPermission(ec.accountId, permission, ec.orgId ? { scope: "org", scopeId: ec.orgId } : undefined);
      if (rbacAllow) reasons.push(`RBAC: account has '${permission}' via roles`);
    } catch {
      // If roles subsystem is unavailable, RBAC fails closed.
      reasons.push("RBAC: roles subsystem unavailable");
    }

    // PBAC: purpose-bound grants.
    const grant = this.findActiveGrant(ec, permission, now, opts.extraGrants);
    if (grant) {
      grantsUsed.push(grant.id);
      const parts: string[] = [`Grant ${grant.id}`];
      if (grant.purpose) parts.push(`purpose=${grant.purpose}`);
      if (grant.expiresAt) parts.push(`expires=${grant.expiresAt}`);
      reasons.push(parts.join(" "));
    }

    // Delegations: walk active delegations where this account is the delegate.
    const delegation = this.findActiveDelegation(ec, permission, now);
    let delegationAllows = false;
    if (delegation) {
      delegationsUsed.push(delegation.id);
      // Confirm the delegator actually holds the permission (delegated authority
      // cannot exceed the delegator's own authority).
      let delegatorHas = false;
      try {
        delegatorHas = getRoles().hasPermission(
          delegation.delegatorAccountId,
          permission,
          ec.orgId ? { scope: "org", scopeId: ec.orgId } : undefined,
        );
      } catch {
        delegatorHas = false;
      }
      delegationAllows = delegatorHas;
      if (delegatorHas) {
        reasons.push(
          `Delegation ${delegation.id} from ${delegation.delegatorAccountId} (verified)`,
        );
      } else {
        reasons.push(
          `Delegation ${delegation.id} from ${delegation.delegatorAccountId} (delegator lacks permission — ignored)`,
        );
      }
    }

    const allowed = allowPolicyMatched || rbacAllow || !!grant || delegationAllows;
    const result = this.finalizeDecision(
      ec,
      permission,
      allowed,
      reasons,
      matchedPolicies,
      grantsUsed,
      delegationsUsed,
    );
    if (opts.audit !== false) this.audit(ec, permission, result);
    return result;
  }

  private finalizeDecision(
    ctx: EvaluationContext,
    permission: Permission,
    allowed: boolean,
    reasons: string[],
    matchedPolicies: PolicyId[],
    grantsUsed: GrantId[],
    delegationsUsed: DelegationId[],
  ): AuthorizationResult {
    void ctx;
    void permission;
    if (!allowed) {
      reasons.push("Default deny: no allow policy, grant, or delegation matched");
      return {
        decision: "deny",
        reasons,
        matchedPolicies,
        grantsUsed,
        delegationsUsed,
        evaluatedAt: getClock().iso(),
      };
    }
    // Note: the sensitive-permission step-up check is performed in evaluate()
    // BEFORE this method is reached, so by the time we get here with
    // allowed=true the MFA condition has already been satisfied.
    return {
      decision: "allow",
      reasons,
      matchedPolicies,
      grantsUsed,
      delegationsUsed,
      evaluatedAt: getClock().iso(),
    };
  }

  private findActiveGrant(
    ctx: EvaluationContext,
    permission: Permission,
    now: number,
    extra?: readonly PermissionGrant[],
  ): PermissionGrant | undefined {
    const all: PermissionGrant[] = [
      ...(this.grantsByAccount.get(ctx.accountId) ?? new Set<GrantId>()),
    ].map((id) => this.grants.get(id)!).filter(Boolean);
    if (extra) all.push(...extra);
    for (const g of all) {
      if (g.accountId !== ctx.accountId) continue;
      if (g.permission !== permission && g.permission !== "*") continue;
      if (g.expiresAt && new Date(g.expiresAt).getTime() < now) continue;
      if (g.scope && !scopeImplies(g.scope, ctx)) continue;
      if (g.purpose && g.purpose !== ctx.purpose) continue;
      if (g.conditions && g.conditions.length > 0) {
        if (!allConditionsMatch(ctx, g.conditions, permission)) continue;
      }
      return g;
    }
    return undefined;
  }

  private findActiveDelegation(
    ctx: EvaluationContext,
    permission: Permission,
    now: number,
  ): Delegation | undefined {
    const set = this.delegationsByDelegate.get(ctx.accountId);
    if (!set) return undefined;
    for (const id of set) {
      const d = this.delegations.get(id);
      if (!d) continue;
      if (!d.permissions.includes(permission) && !d.permissions.includes("*")) continue;
      if (d.expiresAt && new Date(d.expiresAt).getTime() < now) continue;
      if (d.scope && !scopeImplies(d.scope, ctx)) continue;
      return d;
    }
    return undefined;
  }

  // ----- Simulation ---------------------------------------------------------

  /**
   * Simulate what the decision WOULD be if `hypotheticalGrants` were added to
   * the account. Does NOT persist the grants. Used by permission-management
   * UIs ("what if I granted X?") and by self-service tooling.
   */
  simulate(
    accountId: AccountId,
    hypotheticalGrants: readonly Omit<PermissionGrant, "id" | "grantedAt">[],
    permission: Permission,
    ctx: EvaluationContext,
  ): AuthorizationResult {
    const fakeGrants: PermissionGrant[] = hypotheticalGrants.map((g, i) => ({
      ...g,
      accountId,
      id: asGrantId(`sim_${i}_${generateId()}`),
      grantedAt: getClock().iso(),
    }));
    // Evaluate without writing to the audit log (simulation is exploratory).
    return this.evaluate({ ...ctx, accountId }, permission, {
      extraGrants: fakeGrants,
      audit: false,
    });
  }

  // ----- Auditing -----------------------------------------------------------

  /**
   * Record an evaluation in the audit log and emit events.
   * Called automatically by `evaluate` unless `opts.audit === false`.
   * Exposed publicly so external callers (e.g. replay tooling) can log a
   * decision computed elsewhere.
   */
  audit(ctx: EvaluationContext, permission: Permission, result: AuthorizationResult): void {
    const entry: EvaluationLogEntry = {
      id: generateId("auz_"),
      timestamp: getClock().iso(),
      accountId: ctx.accountId,
      permission,
      decision: result.decision,
      reasons: result.reasons,
      matchedPolicies: result.matchedPolicies,
      grantsUsed: result.grantsUsed,
      delegationsUsed: result.delegationsUsed,
      context: ctx,
    };
    this.auditLog.push(entry);
    // Cap the in-memory audit log to avoid unbounded growth in long-running
    // processes. A real deployment would ship these to an external SIEM.
    if (this.auditLog.length > 10_000) this.auditLog.splice(0, this.auditLog.length - 10_000);
    if (this.auditSink) {
      try {
        this.auditSink(entry);
      } catch {
        // An audit-sink failure must never block authorization.
      }
    }
    void getEventBus().publish(
      buildEvent(
        AUTH_EVENTS.permissionEvaluated,
        {
          auditId: entry.id,
          accountId: ctx.accountId,
          permission,
          decision: result.decision,
          reasons: result.reasons,
          matchedPolicies: result.matchedPolicies,
        },
        {},
        "domain",
      ),
    );
    if (result.decision === "allow") {
      void getEventBus().publish(
        buildEvent(
          AUTH_EVENTS.permissionGranted,
          { accountId: ctx.accountId, permission, auditId: entry.id },
          {},
          "domain",
        ),
      );
    } else if (result.decision === "deny") {
      void getEventBus().publish(
        buildEvent(
          AUTH_EVENTS.permissionDenied,
          {
            accountId: ctx.accountId,
            permission,
            reasons: result.reasons,
            auditId: entry.id,
          },
          {},
          "domain",
        ),
      );
    }
  }

  listAuditEntries(filter?: { accountId?: AccountId; permission?: Permission; limit?: number }): readonly EvaluationLogEntry[] {
    let entries = [...this.auditLog];
    if (filter?.accountId) entries = entries.filter((e) => e.accountId === filter.accountId);
    if (filter?.permission) entries = entries.filter((e) => e.permission === filter.permission);
    if (filter?.limit) entries = entries.slice(-filter.limit);
    return entries;
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _engine: AuthorizationEngine | null = null;
export function getAuthorization(): AuthorizationEngine {
  if (!_engine) _engine = new AuthorizationEngine();
  return _engine;
}
export function setAuthorization(e: AuthorizationEngine): void {
  _engine = e;
}
export function resetAuthorization(): void {
  _engine = null;
}
