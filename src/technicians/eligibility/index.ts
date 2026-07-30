/**
 * Eks-Health Technician Network — Eligibility Rules Engine
 *
 * Programs define eligibility policies as rule sets. Each rule is composed of
 * typed conditions evaluated against the technician's profile, certifications,
 * accreditation, organization memberships, reputation, and program-defined
 * custom attributes. Nothing is hardcoded — every requirement is expressed as
 * a (field, operator, value) tuple and evaluated generically.
 *
 * The engine performs REAL evaluation: it queries the live TechnicianRegistry,
 * CertificationRegistry, and AccreditationRegistry, and (when available) the
 * reputation subsystem. No mock results.
 */

import "server-only";
import { createHash } from "node:crypto";
import {
  type EligibilityRuleId,
  type EligibilityResultId,
  type TechnicianId,
  type ProgramId,
  type OrgId,
  TechnicianError,
  asEligibilityRuleId,
} from "../core";
import { getEventBus, buildEvent, generateId, getClock } from "@/kernel";
import { getTechnicians, type TechnicianProfile, type OrgAffiliation } from "../profiles";
import { getCertifications } from "../certifications";
import { getAccreditation } from "../accreditation";

// `asEligibilityResultId` is not yet exported by the core barrel — define a
// local cast helper. (The branded type itself IS exported from ../core.)
function asEligibilityResultId(s: string): EligibilityResultId {
  return s as EligibilityResultId;
}

// ---------------------------------------------------------------------------
// Condition model
// ---------------------------------------------------------------------------

export type RuleOperator =
  | "eq"
  | "ne"
  | "in"
  | "not_in"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "exists"
  | "regex";

export type RuleField =
  | "certification"
  | "skill"
  | "region"
  | "reputation"
  | "accreditation"
  | "organization_membership"
  | "equipment"
  | "language"
  | "program_support"
  | "certification_level"
  | "certification_recency"
  | "category"
  | "status"
  | "custom";

export interface RuleCondition {
  readonly field: RuleField;
  readonly operator: RuleOperator;
  readonly value: unknown;
  /** Optional scope qualifier — e.g. accreditation scope, cert category. */
  readonly scope?: string;
  /** Human-readable explanation shown in evaluation results. */
  readonly description?: string;
}

export type RuleLogic = "and" | "or";

export interface EligibilityRule {
  readonly id: EligibilityRuleId;
  readonly programId: ProgramId;
  readonly name: string;
  readonly description: string;
  readonly conditions: RuleCondition[];
  readonly logic: RuleLogic;
  /** Higher priority rules are evaluated first. */
  readonly priority: number;
  /**
   * If true, failing this rule marks the result "ineligible" immediately
   * (hard gate). If false, failure is "conditional" (soft gate).
   */
  readonly hardGate: boolean;
  readonly createdAt: string;
}

export type DefaultDecision = "allow" | "deny";

export interface EligibilityPolicy {
  readonly programId: ProgramId;
  readonly rules: EligibilityRule[];
  readonly defaultDecision: DefaultDecision;
  readonly version: string;
  readonly updatedAt: string;
}

export type EligibilityDecision = "eligible" | "ineligible" | "conditional";

export interface EligibilityCheck {
  readonly ruleId: EligibilityRuleId;
  readonly ruleName: string;
  readonly condition: RuleCondition;
  readonly passed: boolean;
  readonly detail: string;
  readonly evaluatedAt: string;
}

export interface EligibilityResult {
  readonly id: EligibilityResultId;
  readonly technicianId: TechnicianId;
  readonly programId: ProgramId;
  readonly decision: EligibilityDecision;
  readonly evaluatedAt: string;
  readonly checks: EligibilityCheck[];
  readonly failedConditions: RuleCondition[];
  readonly passedRuleCount: number;
  readonly totalRuleCount: number;
  readonly fingerprint: string; // SHA-256 of the evaluation, for audit
}

export interface RegisterPolicyInput {
  readonly programId: ProgramId;
  readonly defaultDecision?: DefaultDecision;
  readonly version?: string;
  readonly rules: Array<Omit<EligibilityRule, "id" | "programId" | "createdAt">>;
}

// ---------------------------------------------------------------------------
// Reputation provider hook
// ---------------------------------------------------------------------------

/**
 * A reputation resolver returns a 0-100 reputation score for a technician.
 * The reputation subsystem (m5-3) registers itself at boot via
 * `setReputationResolver`. If absent, the engine computes a deterministic
 * proxy from the technician profile fields.
 */
export type ReputationResolver = (technicianId: TechnicianId) => number | undefined;

let _reputationResolver: ReputationResolver | null = null;

/**
 * Register the canonical reputation resolver. Called by the reputation
 * subsystem when it boots. Idempotent.
 */
export function setReputationResolver(resolver: ReputationResolver | null): void {
  _reputationResolver = resolver;
}

// ---------------------------------------------------------------------------
// Evaluation context
// ---------------------------------------------------------------------------

interface EvaluationContext {
  readonly profile: TechnicianProfile;
  readonly programId: ProgramId;
  /** Reputation score 0-100, resolved from reputation module or profile fields. */
  readonly reputationScore: number;
  /** Active certification slugs. */
  readonly activeCertSlugs: Set<string>;
  /** Active certification levels by slug. */
  readonly certLevels: Map<string, string>;
  /** Newest active cert grant timestamp (epoch ms), or 0 if none. */
  readonly newestCertAt: number;
  /** Active accreditation scopes issued by authorities trusted by the program. */
  readonly trustedAccreditationScopes: Set<string>;
  /** Org memberships (orgId set), excluding expired affiliations. */
  readonly orgMemberships: Set<OrgId>;
}

interface FieldResolution {
  /** The actual values present for this field on the technician. */
  readonly present: unknown[];
  /** Detail string for audit output. */
  readonly detail: string;
  /** Whether the field is conceptually "met" (used for `exists`). */
  readonly exists: boolean;
}

// ---------------------------------------------------------------------------
// Eligibility engine
// ---------------------------------------------------------------------------

export class EligibilityEngine {
  private readonly policies = new Map<ProgramId, EligibilityPolicy>();
  private readonly rulesById = new Map<EligibilityRuleId, EligibilityRule>();
  private readonly results = new Map<EligibilityResultId, EligibilityResult>();
  private readonly resultsByTechnician = new Map<TechnicianId, EligibilityResultId[]>();
  private readonly resultsByProgram = new Map<ProgramId, EligibilityResultId[]>();

  /**
   * Register an eligibility policy for a program. Replaces any prior policy
   * for the same program (versioned).
   */
  registerPolicy(input: RegisterPolicyInput): EligibilityPolicy {
    const now = getClock().iso();
    const rules: EligibilityRule[] = input.rules.map((r) => ({
      ...r,
      id: asEligibilityRuleId(generateId("eligrule_")),
      programId: input.programId,
      createdAt: now,
    }));
    for (const rule of rules) this.rulesById.set(rule.id, rule);
    const policy: EligibilityPolicy = {
      programId: input.programId,
      rules,
      defaultDecision: input.defaultDecision ?? "deny",
      version: input.version ?? `v${now.replace(/[-:T.Z]/g, "").slice(0, 14)}`,
      updatedAt: now,
    };
    this.policies.set(input.programId, policy);
    return policy;
  }

  getPolicy(programId: ProgramId): EligibilityPolicy | undefined {
    return this.policies.get(programId);
  }

  getRule(ruleId: EligibilityRuleId): EligibilityRule | undefined {
    return this.rulesById.get(ruleId);
  }

  listPolicies(): EligibilityPolicy[] {
    return [...this.policies.values()];
  }

  getResult(resultId: EligibilityResultId): EligibilityResult | undefined {
    return this.results.get(resultId);
  }

  listResults(filter?: {
    technicianId?: TechnicianId;
    programId?: ProgramId;
    decision?: EligibilityDecision;
  }): EligibilityResult[] {
    let ids: EligibilityResultId[] = [];
    if (filter?.technicianId) {
      ids = this.resultsByTechnician.get(filter.technicianId) ?? [];
    } else if (filter?.programId) {
      ids = this.resultsByProgram.get(filter.programId) ?? [];
    } else {
      ids = [...this.results.keys()];
    }
    let list = ids.map((id) => this.results.get(id)!).filter(Boolean);
    if (filter?.programId && !filter?.technicianId) {
      list = list.filter((r) => r.programId === filter.programId);
    }
    if (filter?.decision) list = list.filter((r) => r.decision === filter.decision);
    return list;
  }

  /**
   * Evaluate a technician against the program's registered policy. REAL
   * evaluation against profile, certifications, accreditation, reputation.
   */
  evaluate(technicianId: TechnicianId, programId: ProgramId): EligibilityResult {
    const policy = this.policies.get(programId);
    if (!policy) {
      throw new TechnicianError({
        code: "eks.technician.eligibility.policy_not_found",
        category: "not_found",
        message: `No eligibility policy registered for program.`,
        userMessage: "This program has not published an eligibility policy yet.",
        metadata: { programId },
      });
    }
    return this.evaluateWithPolicy(technicianId, programId, policy);
  }

  /** Evaluate multiple technicians against a program's policy. */
  evaluateBatch(
    technicianIds: TechnicianId[],
    programId: ProgramId,
  ): EligibilityResult[] {
    return technicianIds.map((id) => this.evaluate(id, programId));
  }

  /**
   * Evaluate a technician against a hypothetical (unregistered) policy —
   * used for what-if planning ("what if we add this rule?").
   */
  simulate(
    technicianId: TechnicianId,
    policy: EligibilityPolicy,
  ): EligibilityResult {
    return this.evaluateWithPolicy(technicianId, policy.programId, policy);
  }

  // -------------------------------------------------------------------------
  // Internal: real evaluation
  // -------------------------------------------------------------------------

  private evaluateWithPolicy(
    technicianId: TechnicianId,
    programId: ProgramId,
    policy: EligibilityPolicy,
  ): EligibilityResult {
    const profile = getTechnicians().get(technicianId);
    if (!profile) {
      throw new TechnicianError({
        code: "eks.technician.eligibility.technician_not_found",
        category: "not_found",
        message: "Technician profile not found.",
        metadata: { technicianId },
      });
    }

    const ctx = this.buildContext(profile, programId);
    const now = getClock().iso();
    const allChecks: EligibilityCheck[] = [];
    const failedConditions: RuleCondition[] = [];
    const sortedRules = [...policy.rules].sort((a, b) => b.priority - a.priority);

    let hardGateFailed = false;
    let allRulesPassed = true;
    let passedRuleCount = 0;

    for (const rule of sortedRules) {
      const checks = rule.conditions.map((cond) => {
        const res = this.evaluateCondition(ctx, cond, programId);
        const check: EligibilityCheck = {
          ruleId: rule.id,
          ruleName: rule.name,
          condition: cond,
          passed: res.passed,
          detail: res.detail,
          evaluatedAt: now,
        };
        if (!res.passed) {
          failedConditions.push(cond);
        }
        return check;
      });
      allChecks.push(...checks);

      const rulePassed =
        rule.logic === "and"
          ? checks.every((c) => c.passed)
          : checks.length === 0 || checks.some((c) => c.passed);

      if (rulePassed) {
        passedRuleCount++;
      } else {
        allRulesPassed = false;
        if (rule.hardGate) hardGateFailed = true;
      }
    }

    let decision: EligibilityDecision;
    if (allRulesPassed) {
      decision = "eligible";
    } else if (hardGateFailed) {
      decision = "ineligible";
    } else {
      decision = "conditional";
    }

    // Default decision applies when no rules exist.
    if (policy.rules.length === 0) {
      decision = policy.defaultDecision === "allow" ? "eligible" : "ineligible";
    }

    const result: EligibilityResult = {
      id: asEligibilityResultId(generateId("eligres_")),
      technicianId,
      programId,
      decision,
      evaluatedAt: now,
      checks: allChecks,
      failedConditions,
      passedRuleCount,
      totalRuleCount: policy.rules.length,
      fingerprint: this.fingerprint({
        technicianId,
        programId,
        decision,
        checks: allChecks,
        policyVersion: policy.version,
      }),
    };

    this.results.set(result.id, result);
    const tList = this.resultsByTechnician.get(technicianId) ?? [];
    this.resultsByTechnician.set(technicianId, [...tList, result.id]);
    const pList = this.resultsByProgram.get(programId) ?? [];
    this.resultsByProgram.set(programId, [...pList, result.id]);

    void getEventBus().publish(
      buildEvent(
        "eks.technician.eligibility.evaluated",
        {
          resultId: result.id,
          technicianId,
          programId,
          decision,
          passedRuleCount,
          totalRuleCount: policy.rules.length,
          fingerprint: result.fingerprint,
        },
        {},
        "domain",
      ),
    );
    return result;
  }

  /**
   * Build the evaluation context from the technician's real registries.
   * Reputation is resolved via the registered resolver if available; otherwise
   * a deterministic profile-based proxy is used.
   */
  private buildContext(profile: TechnicianProfile, programId: ProgramId): EvaluationContext {
    const certRegistry = getCertifications();
    const activeCerts = certRegistry.listForTechnician(profile.id, true);
    const activeCertSlugs = new Set<string>();
    const certLevels = new Map<string, string>();
    let newestCertAt = 0;
    for (const cert of activeCerts) {
      const type = certRegistry.getType(cert.typeId);
      if (!type) continue;
      activeCertSlugs.add(type.slug);
      certLevels.set(type.slug, cert.level);
      const grantedMs = new Date(cert.grantedAt).getTime();
      if (Number.isFinite(grantedMs) && grantedMs > newestCertAt) {
        newestCertAt = grantedMs;
      }
    }

    const accredRegistry = getAccreditation();
    const trustedAccreditationScopes = new Set<string>();
    for (const acc of accredRegistry.listForTechnician(profile.id)) {
      if (acc.status !== "active") continue;
      const authority = accredRegistry.getAuthority(acc.authorityId);
      if (!authority?.trustedByPrograms.includes(programId)) continue;
      trustedAccreditationScopes.add(acc.scope);
    }

    const orgMemberships = new Set<OrgId>();
    for (const aff of profile.affiliatedOrganizations as OrgAffiliation[]) {
      if (!aff.until || new Date(aff.until).getTime() > Date.now()) {
        orgMemberships.add(aff.orgId);
      }
    }

    const reputationScore = this.resolveReputation(profile);

    return {
      profile,
      programId,
      reputationScore,
      activeCertSlugs,
      certLevels,
      newestCertAt,
      trustedAccreditationScopes,
      orgMemberships,
    };
  }

  /**
   * Resolve the technician's reputation score (0-100). Uses the registered
   * reputation resolver (provided by the reputation subsystem built in m5-3)
   * when available; otherwise falls back to a deterministic computation from
   * profile fields. Guarded so a faulty resolver never breaks evaluation.
   */
  private resolveReputation(profile: TechnicianProfile): number {
    if (_reputationResolver) {
      try {
        const score = _reputationResolver(profile.id);
        if (typeof score === "number" && Number.isFinite(score)) {
          return Math.round(Math.min(100, Math.max(0, score)));
        }
      } catch {
        // fall through to profile-based computation
      }
    }
    const rating = typeof profile.rating === "number" ? profile.rating : 0; // 0-5
    const ratingPct = Math.min(100, Math.max(0, (rating / 5) * 100));
    const total = profile.totalSessions;
    const verified = profile.verifiedSessions;
    const disputed = profile.disputedSessions;
    const completionRate = total > 0 ? verified / total : 0;
    const disputeRate = total > 0 ? disputed / total : 0;
    const reputation =
      ratingPct * 0.5 +
      completionRate * 100 * 0.35 +
      Math.max(0, 100 - disputeRate * 100) * 0.15;
    return Math.round(Math.min(100, Math.max(0, reputation)));
  }

  /** Resolve a field's present values on the technician. */
  private resolveField(ctx: EvaluationContext, cond: RuleCondition): FieldResolution {
    const p = ctx.profile;
    switch (cond.field) {
      case "certification": {
        const slugs = [...ctx.activeCertSlugs];
        return {
          present: slugs,
          exists: slugs.length > 0,
          detail: `Active certifications: ${slugs.join(", ") || "(none)"}`,
        };
      }
      case "skill":
        return {
          present: p.skills,
          exists: p.skills.length > 0,
          detail: `Skills: ${p.skills.join(", ") || "(none)"}`,
        };
      case "region":
        return {
          present: p.regionsServed,
          exists: p.regionsServed.length > 0,
          detail: `Regions served: ${p.regionsServed.join(", ") || "(none)"}`,
        };
      case "reputation":
        return {
          present: [ctx.reputationScore],
          exists: ctx.reputationScore > 0,
          detail: `Reputation score: ${ctx.reputationScore}/100`,
        };
      case "accreditation": {
        const scopes = [...ctx.trustedAccreditationScopes];
        return {
          present: scopes,
          exists: scopes.length > 0,
          detail: `Trusted accreditation scopes: ${scopes.join(", ") || "(none)"}`,
        };
      }
      case "organization_membership": {
        const orgs = [...ctx.orgMemberships];
        return {
          present: orgs,
          exists: orgs.length > 0,
          detail: `Org memberships: ${orgs.join(", ") || "(none)"}`,
        };
      }
      case "equipment":
        return {
          present: p.equipment,
          exists: p.equipment.length > 0,
          detail: `Equipment: ${p.equipment.join(", ") || "(none)"}`,
        };
      case "language":
        return {
          present: p.languages,
          exists: p.languages.length > 0,
          detail: `Languages: ${p.languages.join(", ") || "(none)"}`,
        };
      case "program_support":
        return {
          present: p.supportedPrograms,
          exists: p.supportedPrograms.length > 0,
          detail: `Supported programs: ${p.supportedPrograms.join(", ") || "(none)"}`,
        };
      case "certification_level": {
        const levels = [...ctx.certLevels.values()];
        return {
          present: levels,
          exists: levels.length > 0,
          detail: `Active cert levels: ${levels.join(", ") || "(none)"}`,
        };
      }
      case "certification_recency": {
        const days =
          ctx.newestCertAt > 0
            ? Math.floor((Date.now() - ctx.newestCertAt) / 86_400_000)
            : Number.POSITIVE_INFINITY;
        return {
          present: [days],
          exists: ctx.newestCertAt > 0,
          detail: `Most recent certification granted ${Number.isFinite(days) ? `${days} days ago` : "(never)"}`,
        };
      }
      case "category":
        return { present: [p.category], exists: true, detail: `Category: ${p.category}` };
      case "status":
        return { present: [p.status], exists: true, detail: `Status: ${p.status}` };
      case "custom": {
        const key = (cond.scope as string | undefined) ?? "value";
        const value = p.customAttributes[key];
        return {
          present: value === undefined ? [] : [value],
          exists: value !== undefined,
          detail: `Custom attribute "${key}": ${JSON.stringify(value) ?? "undefined"}`,
        };
      }
      default:
        return { present: [], exists: false, detail: `Unknown field: ${cond.field}` };
    }
  }

  /** Evaluate a single condition against the resolved context. */
  private evaluateCondition(
    ctx: EvaluationContext,
    cond: RuleCondition,
    programId: ProgramId,
  ): { passed: boolean; detail: string } {
    // For accreditation & certification, semantic shortcuts consult the live
    // registries directly.
    if (cond.field === "certification") {
      const slug = String(cond.value);
      const has = getCertifications().hasValidCert(ctx.profile.id, slug);
      let passed: boolean;
      switch (cond.operator) {
        case "exists":
          passed = ctx.activeCertSlugs.size > 0;
          break;
        case "eq":
          passed = has;
          break;
        case "ne":
          passed = !has;
          break;
        case "in":
          passed = (cond.value as unknown[]).some((v) =>
            getCertifications().hasValidCert(ctx.profile.id, String(v)),
          );
          break;
        case "not_in":
          passed = !(cond.value as unknown[]).some((v) =>
            getCertifications().hasValidCert(ctx.profile.id, String(v)),
          );
          break;
        default:
          passed = false;
      }
      return {
        passed,
        detail: `${passed ? "Holds" : "Missing"} valid "${slug}" certification (${cond.operator})`,
      };
    }

    if (cond.field === "accreditation") {
      const scope = cond.scope;
      const accredited = getAccreditation().isAccreditedByTrustedAuthority(
        ctx.profile.id,
        programId,
        scope,
      );
      const passed =
        cond.operator === "exists" || cond.operator === "eq"
          ? accredited
          : cond.operator === "ne"
            ? !accredited
            : false;
      return {
        passed,
        detail: `${passed ? "Accredited" : "Not accredited"} by a trusted authority${scope ? ` for scope "${scope}"` : ""}`,
      };
    }

    if (cond.field === "certification_level") {
      const requiredLevel = String(cond.value);
      const order = ["basic", "intermediate", "advanced", "expert", "master"];
      const requiredIdx = order.indexOf(requiredLevel);
      if (requiredIdx < 0) {
        return { passed: false, detail: `Unknown certification level: ${requiredLevel}` };
      }
      const res = this.resolveField(ctx, cond);
      const presentIndices = res.present.map((lvl) => order.indexOf(String(lvl)));
      const bestIdx = presentIndices.length > 0 ? Math.max(...presentIndices) : -1;
      let passed = false;
      switch (cond.operator) {
        case "eq": passed = bestIdx === requiredIdx; break;
        case "ne": passed = bestIdx !== requiredIdx; break;
        case "gte": passed = bestIdx >= requiredIdx; break;
        case "gt": passed = bestIdx > requiredIdx; break;
        case "lte": passed = bestIdx !== -1 && bestIdx <= requiredIdx; break;
        case "lt": passed = bestIdx !== -1 && bestIdx < requiredIdx; break;
        case "exists": passed = bestIdx !== -1; break;
        default: passed = false;
      }
      return {
        passed,
        detail: `Best active level: ${bestIdx >= 0 ? order[bestIdx] : "(none)"} (required: ${requiredLevel} via ${cond.operator})`,
      };
    }

    if (cond.field === "certification_recency") {
      const res = this.resolveField(ctx, cond);
      const days = Number(res.present[0]);
      const threshold = Number(cond.value);
      let passed = false;
      switch (cond.operator) {
        case "lte": passed = Number.isFinite(days) && days <= threshold; break;
        case "lt": passed = Number.isFinite(days) && days < threshold; break;
        case "gte": passed = Number.isFinite(days) && days >= threshold; break;
        case "gt": passed = Number.isFinite(days) && days > threshold; break;
        case "exists": passed = Number.isFinite(days); break;
        default: passed = false;
      }
      return { passed, detail: `${res.detail} (operator: ${cond.operator}, threshold: ${threshold} days)` };
    }

    // Generic field evaluation
    const res = this.resolveField(ctx, cond);
    const actual = res.present;
    const expected = cond.value;

    let passed = false;
    switch (cond.operator) {
      case "exists":
        passed = res.exists;
        break;
      case "eq":
        passed = actual.some((v) => deepEqual(v, expected));
        break;
      case "ne":
        passed = !actual.some((v) => deepEqual(v, expected));
        break;
      case "in": {
        const expectedArr = Array.isArray(expected) ? expected : [expected];
        passed = actual.some((v) => expectedArr.some((e) => deepEqual(v, e)));
        break;
      }
      case "not_in": {
        const expectedArr = Array.isArray(expected) ? expected : [expected];
        passed = !actual.some((v) => expectedArr.some((e) => deepEqual(v, e)));
        break;
      }
      case "gt":
      case "gte":
      case "lt":
      case "lte":
        passed = actual.some((v) => {
          const n = typeof v === "number" ? v : Number(v);
          const e = typeof expected === "number" ? expected : Number(expected);
          if (!Number.isFinite(n) || !Number.isFinite(e)) return false;
          switch (cond.operator) {
            case "gt": return n > e;
            case "gte": return n >= e;
            case "lt": return n < e;
            case "lte": return n <= e;
            default: return false;
          }
        });
        break;
      case "regex": {
        const pattern = String(expected);
        let regex: RegExp;
        try {
          regex = new RegExp(pattern);
        } catch {
          return { passed: false, detail: `Invalid regex: ${pattern}` };
        }
        passed = actual.some((v) => regex.test(String(v)));
        break;
      }
      default:
        passed = false;
    }

    return {
      passed,
      detail: `${res.detail} → ${cond.operator} ${JSON.stringify(expected)} ⇒ ${passed ? "PASS" : "FAIL"}`,
    };
  }

  /** Compute a deterministic SHA-256 fingerprint for an evaluation. */
  private fingerprint(input: {
    technicianId: TechnicianId;
    programId: ProgramId;
    decision: EligibilityDecision;
    checks: EligibilityCheck[];
    policyVersion: string;
  }): string {
    const payload = JSON.stringify({
      t: input.technicianId,
      p: input.programId,
      d: input.decision,
      v: input.policyVersion,
      c: input.checks.map((c) => ({
        r: c.ruleId,
        f: c.condition.field,
        o: c.condition.operator,
        v: c.condition.value,
        s: c.condition.scope,
        p: c.passed,
      })),
    });
    return createHash("sha256").update(payload).digest("hex");
  }

  /** Pre-register a sample eligibility policy for the demo program. */
  registerSamplePolicy(): void {
    if (this.getPolicy(DEMO_PROGRAM_ID)) return;
    this.registerPolicy({
      programId: DEMO_PROGRAM_ID,
      defaultDecision: "deny",
      version: "demo-1.0.0",
      rules: [
        {
          name: "Licensed Nurse certification",
          description: "Technician must hold an active Licensed Nurse certification.",
          conditions: [
            {
              field: "certification",
              operator: "eq",
              value: "licensed_nurse",
              description: "Has valid 'licensed_nurse' certification",
            },
          ],
          logic: "and",
          priority: 100,
          hardGate: true,
        },
        {
          name: "Blood Pressure Training",
          description: "Technician must have blood pressure measurement skill.",
          conditions: [
            {
              field: "skill",
              operator: "eq",
              value: "blood_pressure",
              description: "Has 'blood_pressure' skill",
            },
          ],
          logic: "and",
          priority: 90,
          hardGate: true,
        },
        {
          name: "Operating in Ghana",
          description: "Technician must serve the Ghana region.",
          conditions: [
            {
              field: "region",
              operator: "eq",
              value: "GH",
              description: "Serves Ghana (GH)",
            },
          ],
          logic: "and",
          priority: 80,
          hardGate: true,
        },
        {
          name: "Reputation above 95%",
          description: "Technician reputation must be at least 95/100.",
          conditions: [
            {
              field: "reputation",
              operator: "gte",
              value: 95,
              description: "Reputation score >= 95",
            },
          ],
          logic: "and",
          priority: 70,
          hardGate: false,
        },
        {
          name: "Certified within last 2 years",
          description: "Most recent active certification was granted within 730 days.",
          conditions: [
            {
              field: "certification_recency",
              operator: "lte",
              value: 730,
              description: "Most recent certification <= 730 days ago",
            },
          ],
          logic: "and",
          priority: 60,
          hardGate: false,
        },
        {
          name: "Trusted accreditation",
          description: "Technician should be accredited by an authority trusted by the demo program.",
          conditions: [
            {
              field: "accreditation",
              operator: "exists",
              value: null,
              scope: "preventive_health",
              description: "Has active accreditation by a program-trusted authority",
            },
          ],
          logic: "and",
          priority: 50,
          hardGate: false,
        },
      ],
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (typeof a === "object") {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return String(a) === String(b);
}

// ---------------------------------------------------------------------------
// Demo program id (sample; programs register their own)
// ---------------------------------------------------------------------------

export const DEMO_PROGRAM_ID = "demo_preventive_health_v1" as ProgramId;

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _engine: EligibilityEngine | null = null;

export function getEligibility(): EligibilityEngine {
  if (!_engine) {
    _engine = new EligibilityEngine();
    _engine.registerSamplePolicy();
  }
  return _engine;
}

/** Test-only: replace the singleton. */
export function setEligibility(engine: EligibilityEngine | null): void {
  _engine = engine;
}
