/**
 * Eks-Health Identity — Security Policies
 *
 * Configurable security policies evaluated at every trust boundary: password
 * complexity, MFA enforcement, country/IP allow- and block-lists, geo-fencing,
 * rate limits, failed-login thresholds, session lifetimes, device trust
 * requirements, trusted-network requirements.
 *
 * Policies are scoped (global | org | tenant) and merge for evaluation: a
 * principal is checked against global + their org + their tenant policies.
 * A rule is violated if ANY applicable rule denies; remediation steps are
 * accumulated so the caller can challenge the user (e.g. enforce MFA, step-up
 * verification, force password reset).
 *
 * No external deps beyond node:crypto.
 */

import "server-only";
import { createHash } from "node:crypto";
import {
  type AccountId,
  type PolicyId,
  type Persona,
  type Principal,
  type RiskAssessment,
  IdentityError,
  IDENTITY_EVENTS,
  asPolicyId,
} from "../core";
import { getEventBus, buildEvent, generateId, getClock } from "@/kernel";

// ---------------------------------------------------------------------------
// Policy rule kinds & shapes
// ---------------------------------------------------------------------------

export type PolicyRuleKind =
  | "password_complexity"
  | "mfa_required"
  | "country_allowlist"
  | "country_blocklist"
  | "org_allowlist"
  | "ip_allowlist"
  | "ip_blocklist"
  | "geo_fence"
  | "rate_limit"
  | "failed_login_threshold"
  | "session_lifetime"
  | "max_sessions"
  | "device_trust_required"
  | "trusted_network_required";

export interface PasswordComplexityParams {
  readonly minLength: number;
  readonly minClasses: number; // 1-4 (lower, upper, digit, symbol)
  readonly forbidCommon: boolean; // reject top-N common passwords
  readonly forbidEmailSubstring: boolean;
  readonly historySize: number; // reject last N passwords (checked by caller)
}

export interface MfaRequiredParams {
  readonly personas: Persona[]; // personas that must use MFA
  readonly stepUpForSensitive: boolean;
}

export interface CountryListParams {
  readonly countries: string[]; // ISO-3166-1 alpha-2
}

export interface OrgAllowlistParams {
  readonly orgIds: string[];
}

export interface IpListParams {
  readonly cidrs: string[]; // CIDR notation, e.g. "10.0.0.0/8"
}

export interface GeoFenceParams {
  readonly allowedCountries: string[];
  readonly blockedCountries: string[];
  readonly allowedCidrs?: string[];
}

export interface RateLimitParams {
  readonly perMinute: number;
  readonly perHour: number;
  readonly perDay: number;
}

export interface FailedLoginThresholdParams {
  readonly max: number;
  readonly windowMinutes: number;
  readonly lockoutMinutes: number;
}

export interface SessionLifetimeParams {
  readonly maxAbsoluteSeconds: number;
  readonly maxIdleSeconds: number;
}

export interface MaxSessionsParams {
  readonly max: number;
}

export interface DeviceTrustRequiredParams {
  readonly minTrustLevel: "untrusted" | "known" | "trusted" | "managed";
}

export interface TrustedNetworkRequiredParams {
  readonly cidrs: string[];
}

export type PolicyRuleParams =
  | PasswordComplexityParams
  | MfaRequiredParams
  | CountryListParams
  | OrgAllowlistParams
  | IpListParams
  | GeoFenceParams
  | RateLimitParams
  | FailedLoginThresholdParams
  | SessionLifetimeParams
  | MaxSessionsParams
  | DeviceTrustRequiredParams
  | TrustedNetworkRequiredParams;

export interface PolicyRule {
  readonly kind: PolicyRuleKind;
  readonly params: PolicyRuleParams;
  readonly enforced: boolean; // false => advisory only (logged but not blocking)
  readonly message?: string;
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

export type PolicyScope = "global" | "org" | "tenant";

export interface SecurityPolicy {
  readonly id: PolicyId;
  readonly scope: PolicyScope;
  readonly scopeId?: string; // orgId / tenantId; undefined when scope=global
  readonly name: string;
  readonly description?: string;
  readonly rules: PolicyRule[];
  readonly enabled: boolean;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

export interface PolicyContext {
  readonly principal?: Principal;
  readonly accountId?: AccountId;
  readonly country?: string;
  readonly ip?: string;
  readonly orgId?: string;
  readonly tenantId?: string;
  readonly deviceTrustLevel?: "untrusted" | "known" | "trusted" | "managed";
  readonly failedLoginAttempts?: number;
  readonly sessionAgeSeconds?: number;
  readonly idleSeconds?: number;
  readonly sessionCount?: number;
  readonly persona?: Persona;
  readonly asn?: string;
  readonly isDatacenter?: boolean;
  readonly risk?: RiskAssessment;
}

export interface PolicyViolation {
  readonly ruleKind: PolicyRuleKind;
  readonly policyId: PolicyId;
  readonly policyName: string;
  readonly message: string;
  readonly remediation: string;
  readonly enforced: boolean;
}

export interface PolicyEvaluationResult {
  readonly allowed: boolean;
  readonly violatedRules: PolicyViolation[];
  readonly remediation: string[];
  readonly evaluatedPolicies: number;
}

// ---------------------------------------------------------------------------
// Password rules (default complexity)
// ---------------------------------------------------------------------------

export const PASSWORD_RULES: PasswordComplexityParams = {
  minLength: 12,
  minClasses: 3,
  forbidCommon: true,
  forbidEmailSubstring: true,
  historySize: 5,
};

/** Top common passwords — checked when `forbidCommon` is on. */
const COMMON_PASSWORDS: ReadonlySet<string> = new Set([
  "password", "password123", "12345678", "qwerty123", "abc123",
  "letmein", "welcome", "welcome1", "admin", "admin123",
  "iloveyou", "monkey", "dragon", "master", "football",
  "baseball", "sunshine", "princess", "superman", "trustno1",
  "passw0rd", "p@ssword", "p@ssw0rd", "changeme", "default",
]);

const CLASS_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/[a-z]/, "lowercase"],
  [/[A-Z]/, "uppercase"],
  [/[0-9]/, "digit"],
  [/[^a-zA-Z0-9]/, "symbol"],
];

export interface PasswordCheckResult {
  readonly valid: boolean;
  readonly violations: string[];
  readonly strength: "weak" | "fair" | "strong" | "very_strong";
  readonly score: number; // 0-100
}

/**
 * Validate a candidate password against the configured complexity rules.
 * Real logic: class counting, common-password lookup, email-substring check.
 */
export function checkPasswordAgainst(
  password: string,
  rules: PasswordComplexityParams,
  email?: string,
): PasswordCheckResult {
  const violations: string[] = [];
  if (password.length < rules.minLength) {
    violations.push(`Password must be at least ${rules.minLength} characters.`);
  }
  const classes = CLASS_PATTERNS.filter(([re]) => re.test(password));
  if (classes.length < rules.minClasses) {
    violations.push(
      `Password must contain at least ${rules.minClasses} of: lowercase, uppercase, digit, symbol.`,
    );
  }
  if (rules.forbidCommon && COMMON_PASSWORDS.has(password.toLowerCase())) {
    violations.push("Password is too common; choose something less predictable.");
  }
  if (
    rules.forbidEmailSubstring &&
    email &&
    password.toLowerCase().includes(email.toLowerCase().split("@")[0])
  ) {
    violations.push("Password must not contain your email username.");
  }
  // Strength score (real heuristic)
  let score = 0;
  score += Math.min(password.length, 24) * 2;
  score += classes.length * 10;
  if (password.length >= 16) score += 15;
  if (classes.length === 4) score += 15;
  if (COMMON_PASSWORDS.has(password.toLowerCase())) score = Math.min(score, 20);
  score = Math.max(0, Math.min(100, score));
  const strength: PasswordCheckResult["strength"] =
    score < 40 ? "weak" : score < 60 ? "fair" : score < 85 ? "strong" : "very_strong";
  return { valid: violations.length === 0, violations, strength, score };
}

// ---------------------------------------------------------------------------
// CIDR matching (real IPv4 + IPv6 prefix check)
// ---------------------------------------------------------------------------

function parseCidr(cidr: string): { bytes: number[]; prefix: number } | null {
  const [addr, prefixStr] = cidr.split("/");
  const prefix = prefixStr !== undefined ? parseInt(prefixStr, 10) : addr.includes(":") ? 128 : 32;
  if (Number.isNaN(prefix)) return null;
  const bytes = addr.includes(":")
    ? parseIpv6(addr)
    : parseIpv4(addr);
  if (!bytes) return null;
  return { bytes, prefix };
}

function parseIpv4(addr: string): number[] | null {
  const parts = addr.split(".");
  if (parts.length !== 4) return null;
  const bytes = parts.map((p) => parseInt(p, 10));
  if (bytes.some((b) => Number.isNaN(b) || b < 0 || b > 255)) return null;
  return bytes;
}

function parseIpv6(addr: string): number[] | null {
  // Minimal IPv6 parser — handles :: abbreviation
  const halves = addr.split("::");
  if (halves.length > 2) return null;
  const expand = (h: string): number[] => {
    if (!h) return [];
    const groups = h.split(":");
    return groups.flatMap((g) => {
      const n = parseInt(g, 16);
      if (Number.isNaN(n)) return [];
      return [(n >> 8) & 0xff, n & 0xff];
    });
  };
  const left = expand(halves[0]);
  if (halves.length === 1) {
    return left.length === 16 ? left : null;
  }
  const right = expand(halves[1]);
  const missing = 16 - left.length - right.length;
  if (missing < 0) return null;
  return [...left, ...new Array(missing).fill(0), ...right];
}

export function cidrContains(cidr: string, ip: string): boolean {
  const parsed = parseCidr(cidr);
  if (!parsed) return false;
  const ipBytes = ip.includes(":") ? parseIpv6(ip) : parseIpv4(ip);
  if (!ipBytes) return false;
  if (ipBytes.length !== parsed.bytes.length) return false;
  // Compare bit-by-bit up to prefix length
  let remaining = parsed.prefix;
  for (let i = 0; i < ipBytes.length && remaining > 0; i++) {
    const byteBits = Math.min(8, remaining);
    const mask = byteBits === 8 ? 0xff : (0xff << (8 - byteBits)) & 0xff;
    if ((ipBytes[i] & mask) !== (parsed.bytes[i] & mask)) return false;
    remaining -= 8;
  }
  return true;
}

function anyCidrContains(cidrs: readonly string[], ip: string | undefined): boolean {
  if (!ip) return false;
  return cidrs.some((c) => cidrContains(c, ip));
}

// ---------------------------------------------------------------------------
// Default global policy
// ---------------------------------------------------------------------------

export const DEFAULT_GLOBAL_POLICY: SecurityPolicy = {
  id: asPolicyId("pol_global_default"),
  scope: "global",
  name: "Default Global Security Policy",
  description:
    "Baseline security posture: 12-char passwords with 3 complexity classes, MFA for sensitive personas, geo & rate-limit defaults.",
  rules: [
    { kind: "password_complexity", params: PASSWORD_RULES, enforced: true, message: "Passwords must meet complexity rules." },
    { kind: "mfa_required", params: { personas: ["health_technician", "researcher", "org_admin", "platform_admin", "marketplace_reviewer", "support_agent"], stepUpForSensitive: true }, enforced: true, message: "MFA is required for sensitive personas." },
    { kind: "failed_login_threshold", params: { max: 5, windowMinutes: 15, lockoutMinutes: 15 }, enforced: true, message: "Account locks after 5 failed attempts in 15 minutes." },
    { kind: "session_lifetime", params: { maxAbsoluteSeconds: 30 * 24 * 60 * 60, maxIdleSeconds: 60 * 60 }, enforced: true, message: "Session capped at 30 days, 1 hour idle." },
    { kind: "max_sessions", params: { max: 10 }, enforced: true, message: "Maximum 10 concurrent sessions per account." },
    { kind: "country_blocklist", params: { countries: [] }, enforced: true, message: "No countries blocklisted by default." },
    { kind: "geo_fence", params: { allowedCountries: [], blockedCountries: [] }, enforced: false, message: "No geo-fence configured." },
    { kind: "rate_limit", params: { perMinute: 600, perHour: 10_000, perDay: 100_000 }, enforced: true, message: "API rate limit defaults." },
    { kind: "device_trust_required", params: { minTrustLevel: "known" }, enforced: false, message: "Devices must be at least 'known'." },
    { kind: "trusted_network_required", params: { cidrs: [] }, enforced: false, message: "No trusted-network requirement by default." },
  ],
  enabled: true,
  version: 1,
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
};

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export const POLICY_EVENTS = {
  violated: IDENTITY_EVENTS.policyViolated, // "eks.identity.policy.violated"
  changed: "eks.identity.policy.changed",
} as const;

// ---------------------------------------------------------------------------
// Rate limiter (simple in-memory counter per key)
// ---------------------------------------------------------------------------

interface RateBucket {
  readonly minute: number; // epoch minute
  readonly hour: number; // epoch hour
  readonly day: number; // epoch day
  countMinute: number;
  countHour: number;
  countDay: number;
}

// ---------------------------------------------------------------------------
// Security policy manager
// ---------------------------------------------------------------------------

const TRUST_LEVEL_RANK: Record<"untrusted" | "known" | "trusted" | "managed", number> = {
  untrusted: 0,
  known: 1,
  trusted: 2,
  managed: 3,
};

export class SecurityPolicyManager {
  private readonly policies = new Map<PolicyId, SecurityPolicy>();
  /** Index by `${scope}:${scopeId ?? "*"}` for fast scope lookup. */
  private readonly byScope = new Map<string, SecurityPolicy[]>();
  private readonly rateBuckets = new Map<string, RateBucket>();

  constructor() {
    // Auto-register the default global policy.
    this.setPolicy(DEFAULT_GLOBAL_POLICY);
  }

  /** Register or replace a policy at its scope. */
  setPolicy(policy: SecurityPolicy): SecurityPolicy {
    if (policy.scope !== "global" && !policy.scopeId) {
      throw new IdentityError({
        code: "eks.identity.policy.missing_scope_id",
        category: "validation",
        message: `Policy scope ${policy.scope} requires scopeId.`,
        userMessage: "Policy configuration is incomplete.",
      });
    }
    const stamped: SecurityPolicy = {
      ...policy,
      updatedAt: getClock().iso(),
      createdAt: policy.createdAt ?? getClock().iso(),
    };
    this.policies.set(stamped.id, stamped);
    const key = this.scopeKey(stamped.scope, stamped.scopeId);
    const list = (this.byScope.get(key) ?? []).filter((p) => p.id !== stamped.id);
    list.push(stamped);
    this.byScope.set(key, list);
    void getEventBus().publish(
      buildEvent(
        POLICY_EVENTS.changed,
        { policyId: stamped.id, name: stamped.name, scope: stamped.scope, scopeId: stamped.scopeId, version: stamped.version, ruleCount: stamped.rules.length },
        {},
        "domain",
      ),
    );
    return stamped;
  }

  getPolicy(id: PolicyId): SecurityPolicy | undefined {
    return this.policies.get(id);
  }

  listPolicies(scope?: PolicyScope): SecurityPolicy[] {
    const all = [...this.policies.values()];
    return scope ? all.filter((p) => p.scope === scope) : all;
  }

  /** List policies applicable to a context (global + org + tenant). */
  applicablePolicies(ctx: PolicyContext): SecurityPolicy[] {
    const out: SecurityPolicy[] = [];
    const global = this.byScope.get("global:*") ?? [];
    out.push(...global.filter((p) => p.enabled));
    if (ctx.orgId) {
      const org = this.byScope.get(`org:${ctx.orgId}`) ?? [];
      out.push(...org.filter((p) => p.enabled));
    }
    if (ctx.tenantId) {
      const tenant = this.byScope.get(`tenant:${ctx.tenantId}`) ?? [];
      out.push(...tenant.filter((p) => p.enabled));
    }
    return out;
  }

  /**
   * Evaluate every applicable policy rule against the context. Returns
   * allowed=false if ANY enforced rule is violated.
   */
  evaluate(ctx: PolicyContext): PolicyEvaluationResult {
    const policies = this.applicablePolicies(ctx);
    const violations: PolicyViolation[] = [];
    const remediation: string[] = [];
    for (const policy of policies) {
      for (const rule of policy.rules) {
        const v = this.evaluateRule(rule, policy, ctx);
        if (v) {
          violations.push(v);
          if (v.enforced) remediation.push(v.remediation);
        }
      }
    }
    const enforcedViolations = violations.filter((v) => v.enforced);
    const allowed = enforcedViolations.length === 0;
    if (!allowed) {
      void getEventBus().publish(
        buildEvent(
          POLICY_EVENTS.violated,
          {
            accountId: ctx.accountId,
            orgId: ctx.orgId,
            tenantId: ctx.tenantId,
            country: ctx.country,
            ip: ctx.ip,
            violatedRules: enforcedViolations.map((v) => v.ruleKind),
            remediation,
          },
          {},
          "domain",
        ),
      );
    }
    return { allowed, violatedRules: violations, remediation, evaluatedPolicies: policies.length };
  }

  private evaluateRule(rule: PolicyRule, policy: SecurityPolicy, ctx: PolicyContext): PolicyViolation | null {
    const enforced = rule.enforced;
    const base = {
      ruleKind: rule.kind,
      policyId: policy.id,
      policyName: policy.name,
      enforced,
    };
    switch (rule.kind) {
      case "password_complexity":
        return null; // checked via checkPassword(), not context evaluation
      case "mfa_required": {
        const p = rule.params as MfaRequiredParams;
        if (ctx.persona && p.personas.includes(ctx.persona) && ctx.risk && ctx.risk.requiresMfa) {
          return { ...base, message: `MFA required for persona ${ctx.persona}.`, remediation: "complete_mfa" };
        }
        return null;
      }
      case "country_allowlist": {
        const p = rule.params as CountryListParams;
        if (ctx.country && p.countries.length > 0 && !p.countries.includes(ctx.country)) {
          return { ...base, message: `Country ${ctx.country} is not in the allowlist.`, remediation: "use_allowed_country" };
        }
        return null;
      }
      case "country_blocklist": {
        const p = rule.params as CountryListParams;
        if (ctx.country && p.countries.includes(ctx.country)) {
          return { ...base, message: `Country ${ctx.country} is blocklisted.`, remediation: "use_different_country" };
        }
        return null;
      }
      case "org_allowlist": {
        const p = rule.params as OrgAllowlistParams;
        if (ctx.orgId && p.orgIds.length > 0 && !p.orgIds.includes(ctx.orgId)) {
          return { ...base, message: `Organization ${ctx.orgId} is not allowed.`, remediation: "join_allowed_org" };
        }
        return null;
      }
      case "ip_allowlist": {
        const p = rule.params as IpListParams;
        if (ctx.ip && p.cidrs.length > 0 && !anyCidrContains(p.cidrs, ctx.ip)) {
          return { ...base, message: `IP ${ctx.ip} is not in the allowlist.`, remediation: "use_allowed_network" };
        }
        return null;
      }
      case "ip_blocklist": {
        const p = rule.params as IpListParams;
        if (ctx.ip && anyCidrContains(p.cidrs, ctx.ip)) {
          return { ...base, message: `IP ${ctx.ip} is blocklisted.`, remediation: "use_different_network" };
        }
        return null;
      }
      case "geo_fence": {
        const p = rule.params as GeoFenceParams;
        if (ctx.country && p.blockedCountries.includes(ctx.country)) {
          return { ...base, message: `Geo-fence: country ${ctx.country} is blocked.`, remediation: "use_allowed_country" };
        }
        if (ctx.country && p.allowedCountries.length > 0 && !p.allowedCountries.includes(ctx.country)) {
          return { ...base, message: `Geo-fence: country ${ctx.country} is not allowed.`, remediation: "use_allowed_country" };
        }
        if (ctx.ip && p.allowedCidrs && p.allowedCidrs.length > 0 && !anyCidrContains(p.allowedCidrs, ctx.ip)) {
          return { ...base, message: `Geo-fence: IP ${ctx.ip} is outside the trusted network.`, remediation: "use_trusted_network" };
        }
        return null;
      }
      case "rate_limit":
        return null; // checked via checkRateLimit(), not context evaluation
      case "failed_login_threshold": {
        const p = rule.params as FailedLoginThresholdParams;
        if ((ctx.failedLoginAttempts ?? 0) >= p.max) {
          return { ...base, message: `Too many failed login attempts (${ctx.failedLoginAttempts}).`, remediation: "wait_or_reset_password" };
        }
        return null;
      }
      case "session_lifetime": {
        const p = rule.params as SessionLifetimeParams;
        if (ctx.sessionAgeSeconds !== undefined && ctx.sessionAgeSeconds > p.maxAbsoluteSeconds) {
          return { ...base, message: "Session exceeded maximum lifetime.", remediation: "reauthenticate" };
        }
        if (ctx.idleSeconds !== undefined && ctx.idleSeconds > p.maxIdleSeconds) {
          return { ...base, message: "Session idle too long.", remediation: "reauthenticate" };
        }
        return null;
      }
      case "max_sessions": {
        const p = rule.params as MaxSessionsParams;
        if (ctx.sessionCount !== undefined && ctx.sessionCount > p.max) {
          return { ...base, message: `Too many concurrent sessions (${ctx.sessionCount} > ${p.max}).`, remediation: "revoke_oldest_session" };
        }
        return null;
      }
      case "device_trust_required": {
        const p = rule.params as DeviceTrustRequiredParams;
        if (ctx.deviceTrustLevel && TRUST_LEVEL_RANK[ctx.deviceTrustLevel] < TRUST_LEVEL_RANK[p.minTrustLevel]) {
          return { ...base, message: `Device trust ${ctx.deviceTrustLevel} below required ${p.minTrustLevel}.`, remediation: "verify_device" };
        }
        return null;
      }
      case "trusted_network_required": {
        const p = rule.params as TrustedNetworkRequiredParams;
        if (ctx.ip && p.cidrs.length > 0 && !anyCidrContains(p.cidrs, ctx.ip)) {
          return { ...base, message: `IP ${ctx.ip} is not in a trusted network.`, remediation: "use_trusted_network" };
        }
        return null;
      }
      default:
        return null;
    }
  }

  /**
   * Validate a candidate password against the password_complexity rule of
   * the most specific applicable policy (org > tenant > global).
   */
  checkPassword(password: string, ctx?: { accountId?: AccountId; orgId?: string; tenantId?: string; email?: string }): PasswordCheckResult {
    const policies = this.applicablePolicies(ctx ?? {});
    // Find the password_complexity rule from the most-specific policy
    let rules: PasswordComplexityParams = PASSWORD_RULES;
    for (const p of policies) {
      const rule = p.rules.find((r) => r.kind === "password_complexity");
      if (rule) rules = rule.params as PasswordComplexityParams;
    }
    return checkPasswordAgainst(password, rules, ctx?.email);
  }

  /** Geo-fence check (country + ip). Returns violations only. */
  checkGeo(country: string | undefined, ip: string | undefined, ctx?: PolicyContext): PolicyViolation[] {
    const fullCtx: PolicyContext = { ...ctx, country, ip };
    const policies = this.applicablePolicies(fullCtx);
    const out: PolicyViolation[] = [];
    for (const policy of policies) {
      for (const rule of policy.rules) {
        if (
          rule.kind === "geo_fence" ||
          rule.kind === "country_allowlist" ||
          rule.kind === "country_blocklist" ||
          rule.kind === "ip_allowlist" ||
          rule.kind === "ip_blocklist" ||
          rule.kind === "trusted_network_required"
        ) {
          const v = this.evaluateRule(rule, policy, fullCtx);
          if (v) out.push(v);
        }
      }
    }
    return out;
  }

  /**
   * Real rate-limit check using a per-key counter with minute/hour/day
   * windows. Returns `{ allowed, remaining, retryAfterMs }`.
   */
  checkRateLimit(key: string, cost = 1): { allowed: boolean; remaining: number; retryAfterMs: number; limit: number } {
    // Find the most-specific rate_limit rule
    const policies = this.applicablePolicies({});
    let params: RateLimitParams = { perMinute: 600, perHour: 10_000, perDay: 100_000 };
    for (const p of policies) {
      const rule = p.rules.find((r) => r.kind === "rate_limit");
      if (rule) params = rule.params as RateLimitParams;
    }
    const now = Math.floor(Date.now() / 1000);
    const minute = Math.floor(now / 60);
    const hour = Math.floor(now / 3600);
    const day = Math.floor(now / 86400);
    let bucket = this.rateBuckets.get(key);
    if (!bucket || bucket.minute !== minute || bucket.hour !== hour || bucket.day !== day) {
      bucket = {
        minute, hour, day,
        countMinute: bucket && bucket.minute === minute ? bucket.countMinute : 0,
        countHour: bucket && bucket.hour === hour ? bucket.countHour : 0,
        countDay: bucket && bucket.day === day ? bucket.countDay : 0,
      };
    }
    const wouldMinute = bucket.countMinute + cost;
    const wouldHour = bucket.countHour + cost;
    const wouldDay = bucket.countDay + cost;
    if (wouldMinute > params.perMinute || wouldHour > params.perHour || wouldDay > params.perDay) {
      const retryAfterMs = (60 - (now % 60)) * 1000;
      const limit = Math.min(params.perMinute - bucket.countMinute, params.perHour - bucket.countHour, params.perDay - bucket.countDay);
      return { allowed: false, remaining: Math.max(0, limit), retryAfterMs, limit: params.perMinute };
    }
    bucket.countMinute = wouldMinute;
    bucket.countHour = wouldHour;
    bucket.countDay = wouldDay;
    this.rateBuckets.set(key, bucket);
    const remaining = Math.min(
      params.perMinute - bucket.countMinute,
      params.perHour - bucket.countHour,
      params.perDay - bucket.countDay,
    );
    return { allowed: true, remaining, retryAfterMs: 0, limit: params.perMinute };
  }

  /** Reset rate-limit buckets for a key (admin/testing). */
  resetRateLimit(key: string): void {
    this.rateBuckets.delete(key);
  }

  private scopeKey(scope: PolicyScope, scopeId?: string): string {
    return `${scope}:${scopeId ?? "*"}`;
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _mgr: SecurityPolicyManager | null = null;
export function getSecurityPolicies(): SecurityPolicyManager {
  if (!_mgr) _mgr = new SecurityPolicyManager();
  return _mgr;
}
export function setSecurityPolicies(m: SecurityPolicyManager): void {
  _mgr = m;
}
export function resetSecurityPolicies(): void {
  _mgr = null;
}

/** Convenience: stable hash of a policy for change-detection. */
export function policyFingerprint(policy: SecurityPolicy): string {
  return createHash("sha256").update(JSON.stringify({ id: policy.id, rules: policy.rules, version: policy.version }), "utf8").digest("hex").slice(0, 16);
}

export { IdentityError };
