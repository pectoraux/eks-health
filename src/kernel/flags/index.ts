/**
 * Eks-Health Kernel — Feature Flag System
 *
 * Production feature management supporting:
 *  - boolean / percentage / multivariate flags
 *  - rollout by organization, country, program, developer
 *  - A/B experiments (variant assignment)
 *  - kill switches (instant global off)
 *  - dependency management (flag B requires flag A)
 *  - audit trail of every evaluation
 */

import type { FlagKey, TenantId, UserId } from "../core";
import { asFlagKey } from "../core";
import { getEventBus, buildEvent } from "../events";

export type FlagVariant = string;

export interface FlagRule {
  readonly kind: "organization" | "country" | "program" | "developer" | "percentage";
  readonly match: string; // org id, country code, program id, developer id, or "0-100"
  readonly variant: FlagVariant;
}

export interface FlagDefinition {
  readonly key: string;
  readonly description: string;
  readonly type: "boolean" | "percentage" | "multivariate";
  readonly defaultVariant: FlagVariant;
  readonly variants: FlagVariant[];
  readonly rules: FlagRule[];
  readonly killSwitch: boolean;
  readonly dependsOn?: string[]; // other flag keys that must be on
  readonly owner: string;
  readonly createdAt: string;
}

export interface EvaluationContext {
  readonly userId?: UserId;
  readonly tenantId?: TenantId;
  readonly organizationId?: string;
  readonly country?: string;
  readonly programId?: string;
  readonly developerId?: string;
}

export interface FlagEvaluation {
  readonly key: string;
  readonly variant: FlagVariant;
  readonly enabled: boolean;
  readonly reason: "kill_switch" | "rule_match" | "default" | "dependency_unmet";
  readonly matchedRule?: FlagRule;
  readonly evaluatedAt: string;
}

export interface FlagAuditEntry {
  readonly key: string;
  readonly action: "created" | "updated" | "toggled" | "killed";
  readonly at: string;
  readonly by: string;
  readonly before?: string;
  readonly after?: string;
}

export class FlagManager {
  private readonly flags = new Map<string, FlagDefinition>();
  private readonly audit: FlagAuditEntry[] = [];
  private readonly evaluations: FlagEvaluation[] = [];

  register(flag: FlagDefinition): void {
    this.flags.set(flag.key, flag);
    this.audit.push({
      key: flag.key,
      action: "created",
      at: new Date().toISOString(),
      by: flag.owner,
    });
  }

  list(): FlagDefinition[] {
    return [...this.flags.values()];
  }

  get(key: string): FlagDefinition | undefined {
    return this.flags.get(key);
  }

  toggle(key: string, enabled: boolean, by: string): void {
    const flag = this.flags.get(key);
    if (!flag) return;
    const updated: FlagDefinition = { ...flag, killSwitch: !enabled };
    this.flags.set(key, updated);
    this.audit.push({
      key,
      action: enabled ? "toggled" : "killed",
      at: new Date().toISOString(),
      by,
      before: flag.killSwitch ? "off" : "on",
      after: enabled ? "on" : "off",
    });
    void getEventBus().publish(
      buildEvent("eks.kernel.flag.toggled", { key, enabled }, {}, "system"),
    );
  }

  evaluate(key: string, ctx: EvaluationContext = {}): FlagEvaluation {
    const flag = this.flags.get(key);
    if (!flag) {
      return {
        key,
        variant: "off",
        enabled: false,
        reason: "default",
        evaluatedAt: new Date().toISOString(),
      };
    }
    // Kill switch wins
    if (flag.killSwitch) {
      return this.record({
        key,
        variant: "off",
        enabled: false,
        reason: "kill_switch",
        evaluatedAt: new Date().toISOString(),
      });
    }
    // Dependency check
    if (flag.dependsOn) {
      for (const dep of flag.dependsOn) {
        const depEval = this.evaluate(dep, ctx);
        if (!depEval.enabled) {
          return this.record({
            key,
            variant: flag.defaultVariant,
            enabled: false,
            reason: "dependency_unmet",
            evaluatedAt: new Date().toISOString(),
          });
        }
      }
    }
    // Rule evaluation (most specific first)
    const orderedRules = [...flag.rules].sort((a, b) => specificity(b) - specificity(a));
    for (const rule of orderedRules) {
      if (this.matches(rule, ctx)) {
        return this.record({
          key,
          variant: rule.variant,
          enabled: rule.variant !== "off",
          reason: "rule_match",
          matchedRule: rule,
          evaluatedAt: new Date().toISOString(),
        });
      }
    }
    // Percentage fallback (deterministic hash of userId)
    if (flag.type === "percentage" && ctx.userId) {
      const pct = this.hashPercent(ctx.userId + key);
      if (pct < 50) {
        return this.record({
          key,
          variant: "on",
          enabled: true,
          reason: "rule_match",
          matchedRule: { kind: "percentage", match: "0-50", variant: "on" },
          evaluatedAt: new Date().toISOString(),
        });
      }
    }
    return this.record({
      key,
      variant: flag.defaultVariant,
      enabled: flag.defaultVariant !== "off",
      reason: "default",
      evaluatedAt: new Date().toISOString(),
    });
  }

  private record(eval_: FlagEvaluation): FlagEvaluation {
    this.evaluations.push(eval_);
    return eval_;
  }

  private matches(rule: FlagRule, ctx: EvaluationContext): boolean {
    switch (rule.kind) {
      case "organization":
        return ctx.organizationId === rule.match;
      case "country":
        return ctx.country === rule.match;
      case "program":
        return ctx.programId === rule.match;
      case "developer":
        return ctx.developerId === rule.match;
      case "percentage":
        return false; // handled in evaluate()
    }
  }

  private hashPercent(input: string): number {
    let h = 0;
    for (let i = 0; i < input.length; i++) {
      h = (h * 31 + input.charCodeAt(i)) >>> 0;
    }
    return h % 100;
  }

  getAudit(): FlagAuditEntry[] {
    return [...this.audit];
  }

  getEvaluations(): FlagEvaluation[] {
    return [...this.evaluations].slice(-200);
  }
}

function specificity(rule: FlagRule): number {
  switch (rule.kind) {
    case "developer":
      return 5;
    case "program":
      return 4;
    case "organization":
      return 3;
    case "country":
      return 2;
    case "percentage":
      return 1;
  }
}

let _mgr: FlagManager | null = null;
export function getFlags(): FlagManager {
  if (!_mgr) _mgr = new FlagManager();
  return _mgr;
}

export function flagKey(key: string): FlagKey {
  return asFlagKey(key);
}
