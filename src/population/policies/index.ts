/**
 * Eks-Health Population Platform — Organization Policies
 *
 * Configurable policies that govern organizational behavior without
 * hardcoding it: approved programs, required measurements, competition
 * participation, privacy defaults, funding limits, program budgets,
 * regional restrictions, compliance requirements. Each policy is a set of
 * declarative rules (`{ field, operator, value }`) evaluated against a
 * context object.
 *
 * Real rule evaluation (11 operators), real policy evaluation against a
 * context, real convenience accessors (isProgramApproved,
 * isMeasurementRequired, getPrivacyDefaults). Emits policy.updated on
 * every change. No mocks.
 *
 * Built on the population core (types, errors, events).
 */

import "server-only";
import {
  type OrgPolicyId,
  type PopulationOrgId,
  type ProgramId,
  type PolicyType,
  type OrganizationPolicy,
  PopulationError,
  POPULATION_EVENTS,
  asOrgPolicyId,
} from "../core";
import { getEventBus, buildEvent, generateId, getClock } from "@/kernel";

// ---------------------------------------------------------------------------
// Input / filter types
// ---------------------------------------------------------------------------

export interface PolicyRule {
  readonly field: string;
  readonly operator: PolicyOperator;
  readonly value: unknown;
}

export type PolicyOperator =
  | "eq"
  | "ne"
  | "in"
  | "not_in"
  | "gt"
  | "lt"
  | "gte"
  | "lte"
  | "exists"
  | "contains"
  | "not_contains";

export interface CreatePolicyInput {
  readonly orgId: PopulationOrgId;
  readonly type: PolicyType;
  readonly name: string;
  readonly description: string;
  readonly rules?: PolicyRule[];
  readonly enforce?: boolean;
  readonly active?: boolean;
}

export interface UpdatePolicyInput {
  readonly name?: string;
  readonly description?: string;
  readonly rules?: PolicyRule[];
  readonly enforce?: boolean;
  readonly active?: boolean;
}

export interface PolicyFilter {
  readonly orgId?: PopulationOrgId;
  readonly type?: PolicyType;
  readonly active?: boolean;
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

export interface PolicyViolation {
  readonly rule: PolicyRule;
  readonly reason: string;
}

export interface PolicyEvaluationResult {
  readonly policyId: OrgPolicyId;
  readonly policyName: string;
  readonly type: PolicyType;
  readonly enforce: boolean;
  readonly passed: boolean;
  readonly violations: PolicyViolation[];
}

export interface PolicyEvaluationContext {
  readonly [field: string]: unknown;
}

// ---------------------------------------------------------------------------
// Privacy defaults
// ---------------------------------------------------------------------------

export interface PrivacyDefaults {
  readonly defaultGrantTypes: string[];
  readonly defaultScopes: string[];
  readonly allowOrganizationalAccess: boolean;
  readonly suppressSmallGroups: boolean;
  readonly minGroupSize: number;
}

const DEFAULT_PRIVACY_DEFAULTS: PrivacyDefaults = {
  defaultGrantTypes: ["attendance_only"],
  defaultScopes: [],
  allowOrganizationalAccess: false,
  suppressSmallGroups: true,
  minGroupSize: 5,
};

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

export interface PolicyStats {
  readonly total: number;
  readonly active: number;
  readonly byType: Record<string, number>;
  readonly byTypeActive: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

export class PolicyManager {
  private readonly policies = new Map<OrgPolicyId, OrganizationPolicy>();
  private readonly byOrg = new Map<PopulationOrgId, OrgPolicyId[]>();
  private readonly byType = new Map<PolicyType, OrgPolicyId[]>();

  // -------------------------------------------------------------------------
  // CRUD
  // -------------------------------------------------------------------------

  create(input: CreatePolicyInput): OrganizationPolicy {
    if (!input.name || !input.name.trim()) {
      throw new PopulationError({
        code: "eks.population.policy.missing_name",
        category: "validation",
        message: "Policy name is required.",
        userMessage: "A policy name is required.",
      });
    }
    if (!input.orgId) {
      throw new PopulationError({
        code: "eks.population.policy.missing_org",
        category: "validation",
        message: "Organization is required.",
      });
    }
    // Validate operators early.
    for (const r of input.rules ?? []) {
      if (!isOperator(r.operator)) {
        throw new PopulationError({
          code: "eks.population.policy.invalid_operator",
          category: "validation",
          message: `Unknown operator '${r.operator}'.`,
          userMessage: `Rule operator '${r.operator}' is not supported.`,
        });
      }
    }
    const now = getClock().iso();
    const policy: OrganizationPolicy = {
      id: asOrgPolicyId(generateId("opol_")),
      orgId: input.orgId,
      type: input.type,
      name: input.name.trim(),
      description: input.description,
      rules: (input.rules ?? []) as OrganizationPolicy["rules"],
      enforce: input.enforce ?? true,
      active: input.active ?? true,
      createdAt: now,
      updatedAt: now,
    };
    this.store(policy);
    this.emitUpdated(policy, "created");
    return policy;
  }

  get(id: OrgPolicyId): OrganizationPolicy | undefined {
    return this.policies.get(id);
  }

  list(filter?: PolicyFilter): OrganizationPolicy[] {
    let l = [...this.policies.values()];
    if (filter?.orgId) l = l.filter((p) => p.orgId === filter.orgId);
    if (filter?.type) l = l.filter((p) => p.type === filter.type);
    if (filter?.active !== undefined) {
      l = l.filter((p) => p.active === filter.active);
    }
    return l;
  }

  update(id: OrgPolicyId, updates: UpdatePolicyInput): OrganizationPolicy {
    const existing = this.policies.get(id);
    if (!existing) {
      throw new PopulationError({
        code: "eks.population.policy.not_found",
        category: "not_found",
        message: "Policy not found.",
      });
    }
    if (updates.rules) {
      for (const r of updates.rules) {
        if (!isOperator(r.operator)) {
          throw new PopulationError({
            code: "eks.population.policy.invalid_operator",
            category: "validation",
            message: `Unknown operator '${r.operator}'.`,
          });
        }
      }
    }
    const updated: OrganizationPolicy = {
      ...existing,
      name: updates.name ?? existing.name,
      description: updates.description ?? existing.description,
      rules: updates.rules
        ? (updates.rules as OrganizationPolicy["rules"])
        : existing.rules,
      enforce: updates.enforce ?? existing.enforce,
      active: updates.active ?? existing.active,
      updatedAt: getClock().iso(),
    };
    this.store(updated);
    this.emitUpdated(updated, "updated");
    return updated;
  }

  deactivate(id: OrgPolicyId): OrganizationPolicy {
    return this.update(id, { active: false });
  }

  activate(id: OrgPolicyId): OrganizationPolicy {
    return this.update(id, { active: true });
  }

  // -------------------------------------------------------------------------
  // Evaluation
  // -------------------------------------------------------------------------

  evaluate(
    orgId: PopulationOrgId,
    context: PolicyEvaluationContext,
  ): PolicyEvaluationResult[] {
    const activePolicies = this.list({ orgId, active: true });
    const results: PolicyEvaluationResult[] = [];
    for (const policy of activePolicies) {
      const violations = this.evaluateRules(policy.rules, context);
      results.push({
        policyId: policy.id,
        policyName: policy.name,
        type: policy.type,
        enforce: policy.enforce,
        passed: violations.length === 0,
        violations,
      });
    }
    return results;
  }

  isProgramApproved(orgId: PopulationOrgId, programId: ProgramId): boolean {
    const policies = this.list({
      orgId,
      type: "approved_programs",
      active: true,
    });
    if (policies.length === 0) {
      // Open by default — no approval policy means all programs are allowed.
      return true;
    }
    // If any active approved_programs policy explicitly includes the program,
    // it is approved. (Allowlist semantics: once a policy exists, a program
    // must be in at least one policy's list.)
    for (const p of policies) {
      for (const r of p.rules) {
        if (isProgramField(r.field) && (r.operator === "in" || r.operator === "contains")) {
          if (Array.isArray(r.value) && r.value.includes(programId)) {
            return true;
          }
        }
      }
    }
    return false;
  }

  isMeasurementRequired(orgId: PopulationOrgId, schemaId: string): boolean {
    const policies = this.list({
      orgId,
      type: "required_measurements",
      active: true,
    });
    for (const p of policies) {
      for (const r of p.rules) {
        if (
          isSchemaField(r.field) &&
          (r.operator === "in" || r.operator === "contains")
        ) {
          if (Array.isArray(r.value) && r.value.includes(schemaId)) {
            return true;
          }
        }
      }
    }
    return false;
  }

  getPrivacyDefaults(orgId: PopulationOrgId): PrivacyDefaults {
    const policies = this.list({
      orgId,
      type: "privacy_defaults",
      active: true,
    });
    if (policies.length === 0) {
      return DEFAULT_PRIVACY_DEFAULTS;
    }
    // Merge rules from all active privacy_defaults policies (last-write-wins
    // for scalar fields, union for arrays).
    let grantTypes = DEFAULT_PRIVACY_DEFAULTS.defaultGrantTypes;
    let scopes = DEFAULT_PRIVACY_DEFAULTS.defaultScopes;
    let allowOrg = DEFAULT_PRIVACY_DEFAULTS.allowOrganizationalAccess;
    let suppress = DEFAULT_PRIVACY_DEFAULTS.suppressSmallGroups;
    let minGroup = DEFAULT_PRIVACY_DEFAULTS.minGroupSize;

    for (const p of policies) {
      for (const r of p.rules) {
        const f = r.field.toLowerCase();
        if (
          (f === "default_grant_types" || f === "granttypes" || f === "grant_types") &&
          Array.isArray(r.value)
        ) {
          grantTypes = r.value.map(String);
        } else if (
          (f === "default_scopes" || f === "scopes") &&
          Array.isArray(r.value)
        ) {
          scopes = r.value.map(String);
        } else if (
          f === "allow_organizational_access" ||
          f === "alloworganizationalaccess"
        ) {
          allowOrg = toBool(r.value);
        } else if (
          f === "suppress_small_groups" ||
          f === "suppresssmallgroups"
        ) {
          suppress = toBool(r.value);
        } else if (f === "min_group_size" || f === "mingroupsize") {
          minGroup = toNum(r.value, minGroup);
        }
      }
    }

    return {
      defaultGrantTypes: grantTypes,
      defaultScopes: scopes,
      allowOrganizationalAccess: allowOrg,
      suppressSmallGroups: suppress,
      minGroupSize: minGroup,
    };
  }

  // -------------------------------------------------------------------------
  // Stats
  // -------------------------------------------------------------------------

  getStats(): PolicyStats {
    const list = [...this.policies.values()];
    const byType: Record<string, number> = {};
    const byTypeActive: Record<string, number> = {};
    for (const p of list) {
      byType[p.type] = (byType[p.type] ?? 0) + 1;
      if (p.active) {
        byTypeActive[p.type] = (byTypeActive[p.type] ?? 0) + 1;
      }
    }
    return {
      total: list.length,
      active: list.filter((p) => p.active).length,
      byType,
      byTypeActive,
    };
  }

  // -------------------------------------------------------------------------
  // Internal: rule evaluation
  // -------------------------------------------------------------------------

  private evaluateRules(
    rules: OrganizationPolicy["rules"],
    context: PolicyEvaluationContext,
  ): PolicyViolation[] {
    const violations: PolicyViolation[] = [];
    for (const rule of rules) {
      const ok = evaluateRule(rule, context);
      if (!ok) {
        violations.push({
          rule: rule as PolicyRule,
          reason: `Field '${rule.field}' failed operator '${rule.operator}' against value ${JSON.stringify(rule.value)}.`,
        });
      }
    }
    return violations;
  }

  // -------------------------------------------------------------------------
  // Internal: indexing & events
  // -------------------------------------------------------------------------

  private store(policy: OrganizationPolicy): void {
    const old = this.policies.get(policy.id);
    if (old) {
      this.removeFromIndex(this.byOrg, old.orgId, old.id);
      this.removeFromIndex(this.byType, old.type, old.id);
    }
    this.policies.set(policy.id, policy);
    this.addToIndex(this.byOrg, policy.orgId, policy.id);
    this.addToIndex(this.byType, policy.type, policy.id);
  }

  private addToIndex<K>(
    idx: Map<K, OrgPolicyId[]>,
    key: K,
    id: OrgPolicyId,
  ): void {
    const arr = idx.get(key) ?? [];
    if (!arr.includes(id)) idx.set(key, [...arr, id]);
  }

  private removeFromIndex<K>(
    idx: Map<K, OrgPolicyId[]>,
    key: K,
    id: OrgPolicyId,
  ): void {
    const arr = idx.get(key);
    if (!arr) return;
    idx.set(
      key,
      arr.filter((x) => x !== id),
    );
  }

  private emitUpdated(policy: OrganizationPolicy, action: string): void {
    void getEventBus().publish(
      buildEvent(
        POPULATION_EVENTS.policyUpdated,
        {
          policyId: policy.id,
          orgId: policy.orgId,
          type: policy.type,
          name: policy.name,
          action,
          active: policy.active,
          enforce: policy.enforce,
        },
        {},
        "domain",
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Rule evaluation engine
// ---------------------------------------------------------------------------

const OPERATORS: ReadonlySet<PolicyOperator> = new Set<PolicyOperator>([
  "eq",
  "ne",
  "in",
  "not_in",
  "gt",
  "lt",
  "gte",
  "lte",
  "exists",
  "contains",
  "not_contains",
]);

function isOperator(s: string): s is PolicyOperator {
  return OPERATORS.has(s as PolicyOperator);
}

function evaluateRule(
  rule: OrganizationPolicy["rules"][number],
  context: PolicyEvaluationContext,
): boolean {
  const ctxVal = context[rule.field];
  switch (rule.operator) {
    case "eq":
      return ctxVal === rule.value;
    case "ne":
      return ctxVal !== rule.value;
    case "in":
      return Array.isArray(rule.value) && rule.value.includes(ctxVal);
    case "not_in":
      return Array.isArray(rule.value) && !rule.value.includes(ctxVal);
    case "gt":
      return typeof ctxVal === "number" && typeof rule.value === "number" && ctxVal > rule.value;
    case "lt":
      return typeof ctxVal === "number" && typeof rule.value === "number" && ctxVal < rule.value;
    case "gte":
      return typeof ctxVal === "number" && typeof rule.value === "number" && ctxVal >= rule.value;
    case "lte":
      return typeof ctxVal === "number" && typeof rule.value === "number" && ctxVal <= rule.value;
    case "exists":
      return ctxVal !== undefined && ctxVal !== null;
    case "contains":
      return Array.isArray(ctxVal) && ctxVal.includes(rule.value);
    case "not_contains":
      return Array.isArray(ctxVal) && !ctxVal.includes(rule.value);
    default:
      // Unknown operator: fail closed (treat as violation).
      return false;
  }
}

function isProgramField(field: string): boolean {
  const f = field.toLowerCase();
  return (
    f === "program_id" ||
    f === "programid" ||
    f === "programs" ||
    f === "program_ids" ||
    f === "programids"
  );
}

function isSchemaField(field: string): boolean {
  const f = field.toLowerCase();
  return (
    f === "schema_id" ||
    f === "schemaid" ||
    f === "schemas" ||
    f === "schema_ids" ||
    f === "schemaids"
  );
}

function toBool(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return v === "true" || v === "1";
  if (typeof v === "number") return v !== 0;
  return false;
}

function toNum(v: unknown, fallback: number): number {
  if (typeof v === "number" && !isNaN(v)) return v;
  if (typeof v === "string") {
    const n = parseInt(v, 10);
    if (!isNaN(n)) return n;
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _mgr: PolicyManager | null = null;
export function getPolicies(): PolicyManager {
  if (!_mgr) _mgr = new PolicyManager();
  return _mgr;
}

// ---------------------------------------------------------------------------
// Barrel re-exports
// ---------------------------------------------------------------------------

export type {
  OrganizationPolicy,
  OrgPolicyId,
  PolicyType,
} from "../core";
