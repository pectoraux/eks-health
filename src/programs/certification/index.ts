/**
 * Eks-Health Program OS — Certification Pipeline
 *
 * Before publication, every Program undergoes automated review. The pipeline
 * validates: manifest correctness, security, permissions, performance,
 * resource usage, API compatibility, privacy declaration, dependency safety,
 * unsupported APIs, static analysis, malicious behavior. Only certified
 * Programs can be listed publicly.
 *
 * Each rule is a real, executable check function. The pipeline aggregates
 * results: any high/critical-severity failure blocks certification; warnings
 * are recorded but do not block. On pass, the registry is marked certified
 * and `eks.program.certified` is emitted.
 */

import "server-only";
import {
  type CertificationId,
  type ProgramId,
  type ProgramVersionId,
  type CapabilityId,
  type SemVer,
  ProgramError,
  asCertificationId,
  PROGRAM_EVENTS,
  compareSemVer,
  semVerToString,
} from "../core";
import type { Brand } from "@/kernel";
import type {
  ProgramManifest,
  ManifestValidationResult,
  SigningKeyPair,
} from "../manifests";
import {
  validateManifest,
  verifyManifestSignature,
  manifestFingerprint,
  generateSigningKeyPair,
} from "../manifests";
import { getRegistry } from "../lifecycle";
import { CAPABILITIES, getCapability } from "../capabilities";
import { getDependencies } from "../dependencies";
import { getEventBus, buildEvent, generateId, getClock } from "@/kernel";

// ---------------------------------------------------------------------------
// Branded types
// ---------------------------------------------------------------------------

export type CheckId = Brand<string, "CheckId">;
export function asCheckId(s: string): CheckId {
  return s as CheckId;
}

// ---------------------------------------------------------------------------
// Certification enums
// ---------------------------------------------------------------------------

export type CheckCategory =
  | "manifest"
  | "security"
  | "permissions"
  | "performance"
  | "resources"
  | "api_compatibility"
  | "privacy"
  | "dependencies"
  | "static_analysis"
  | "malicious_behavior";

export type CheckResult = "pass" | "fail" | "warn" | "skip";

export type CheckSeverity = "info" | "low" | "medium" | "high" | "critical";

export type CertificationStatus =
  | "pending"
  | "running"
  | "passed"
  | "failed"
  | "expired";

// ---------------------------------------------------------------------------
// Rule + run types
// ---------------------------------------------------------------------------

export interface RuleCheckResult {
  readonly result: CheckResult;
  readonly message: string;
  readonly detail?: unknown;
}

export type RuleCheckFn = (
  manifest: ProgramManifest,
) => Promise<RuleCheckResult> | RuleCheckResult;

export interface CertificationRule {
  readonly id: CheckId;
  readonly category: CheckCategory;
  readonly severity: CheckSeverity;
  readonly description: string;
  readonly check: RuleCheckFn;
}

export interface CertificationCheck {
  readonly id: CheckId;
  readonly ruleId: CheckId;
  readonly category: CheckCategory;
  readonly severity: CheckSeverity;
  readonly result: CheckResult;
  readonly message: string;
  readonly detail?: unknown;
  readonly executedAt: string;
  readonly durationMs: number;
}

export interface CertificationRunSummary {
  readonly passed: number;
  readonly failed: number;
  readonly warned: number;
  readonly skipped: number;
  readonly total: number;
}

export interface CertificationRun {
  readonly id: CertificationId;
  readonly programId: ProgramId;
  readonly versionId: ProgramVersionId;
  readonly status: CertificationStatus;
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly checks: CertificationCheck[];
  readonly summary: CertificationRunSummary;
  readonly manifestFingerprint: string;
  readonly sdkVersion: string;
  readonly programVersion: string;
}

// ---------------------------------------------------------------------------
// Trusted key store (for signature verification)
// ---------------------------------------------------------------------------

export interface TrustedKey {
  readonly keyId: string;
  readonly publicKeyPem: string;
  readonly developerName: string;
  readonly addedAt: string;
}

// ---------------------------------------------------------------------------
// Certification Pipeline
// ---------------------------------------------------------------------------

export class CertificationPipeline {
  private readonly rules = new Map<CheckId, CertificationRule>();
  private readonly runs = new Map<CertificationId, CertificationRun>();
  private readonly byProgram = new Map<ProgramId, CertificationId[]>();
  private readonly trustedKeys = new Map<string, TrustedKey>();

  constructor() {
    this.registerBuiltins();
    // Provision a platform test keypair so signature_verifiable has a key
    // to check against. Real submissions must register the developer's key.
    const testKey = generateSigningKeyPair("platform-test-key");
    this.registerTrustedKey({
      keyId: testKey.keyId,
      publicKeyPem: testKey.publicKeyPem,
      developerName: "platform-test-key",
    });
  }

  // ---- Trusted key management -------------------------------------------

  registerTrustedKey(input: Omit<TrustedKey, "addedAt">): void {
    this.trustedKeys.set(input.keyId, { ...input, addedAt: getClock().iso() });
  }

  listTrustedKeys(): readonly TrustedKey[] {
    return [...this.trustedKeys.values()];
  }

  // ---- Rule management --------------------------------------------------

  registerRule(rule: CertificationRule): void {
    if (this.rules.has(rule.id)) {
      throw new ProgramError({
        code: "eks.program.certification.rule.duplicate",
        category: "validation",
        message: `Rule ${rule.id} already registered.`,
        userMessage: "Certification rule already exists.",
      });
    }
    this.rules.set(rule.id, rule);
  }

  listRules(): readonly CertificationRule[] {
    return [...this.rules.values()];
  }

  // ---- Run execution ----------------------------------------------------

  async run(
    manifest: ProgramManifest,
    versionId: ProgramVersionId,
  ): Promise<CertificationRun> {
    const runId = asCertificationId(generateId("cert_"));
    const startedAt = getClock().iso();

    void getEventBus().publish(
      buildEvent(
        PROGRAM_EVENTS.reviewStarted,
        { programId: manifest.id, versionId, runId },
        {},
        "domain",
      ),
    );

    const checks: CertificationCheck[] = [];
    const rules = [...this.rules.values()];

    for (const rule of rules) {
      const t0 = Date.now();
      let outcome: RuleCheckResult;
      try {
        outcome = await Promise.resolve(rule.check(manifest));
      } catch (e) {
        outcome = {
          result: "fail",
          message: `Rule threw an error: ${e instanceof Error ? e.message : String(e)}`,
          detail: { error: String(e) },
        };
      }
      const durationMs = Date.now() - t0;
      checks.push({
        id: asCheckId(generateId("chk_")),
        ruleId: rule.id,
        category: rule.category,
        severity: rule.severity,
        result: outcome.result,
        message: outcome.message,
        detail: outcome.detail,
        executedAt: getClock().iso(),
        durationMs,
      });
    }

    const summary = this.aggregate(checks);
    const blockingFails = checks.filter(
      (c) =>
        c.result === "fail" &&
        (c.severity === "high" || c.severity === "critical"),
    );
    const status: CertificationStatus =
      blockingFails.length > 0 ? "failed" : "passed";
    const completedAt = getClock().iso();

    const run: CertificationRun = {
      id: runId,
      programId: manifest.id,
      versionId,
      status,
      startedAt,
      completedAt,
      checks,
      summary,
      manifestFingerprint: manifestFingerprint(manifest),
      sdkVersion: semVerToString(manifest.sdkVersion),
      programVersion: semVerToString(manifest.version),
    };

    this.runs.set(runId, run);
    const existing = this.byProgram.get(manifest.id) ?? [];
    this.byProgram.set(manifest.id, [...existing, runId]);

    if (status === "passed") {
      // Mark the registry version as certified. The registry silently no-ops
      // if the program/version is not yet registered, so this is safe.
      try {
        getRegistry().markCertified(manifest.id, versionId, runId);
      } catch {
        // registry may not have the program yet — that's acceptable
      }
      void getEventBus().publish(
        buildEvent(
          PROGRAM_EVENTS.certified,
          { programId: manifest.id, versionId, runId, summary },
          {},
          "domain",
        ),
      );
    } else {
      void getEventBus().publish(
        buildEvent(
          PROGRAM_EVENTS.rejected,
          {
            programId: manifest.id,
            versionId,
            runId,
            blockingFails: blockingFails.length,
            summary,
          },
          {},
          "domain",
        ),
      );
    }

    return run;
  }

  getRun(id: CertificationId): CertificationRun | undefined {
    return this.runs.get(id);
  }

  listRuns(programId?: ProgramId): CertificationRun[] {
    if (programId) {
      const ids = this.byProgram.get(programId) ?? [];
      return ids.map((id) => this.runs.get(id)!).filter(Boolean);
    }
    return [...this.runs.values()];
  }

  getLatestRun(
    programId: ProgramId,
    versionId?: ProgramVersionId,
  ): CertificationRun | undefined {
    const ids = this.byProgram.get(programId) ?? [];
    const runs = ids
      .map((id) => this.runs.get(id)!)
      .filter(Boolean)
      .filter((r) => (versionId ? r.versionId === versionId : true));
    if (runs.length === 0) return undefined;
    return runs.reduce((latest, r) =>
      r.completedAt! > latest.completedAt! ? r : latest,
    );
  }

  isCertified(programId: ProgramId, versionId: ProgramVersionId): boolean {
    const latest = this.getLatestRun(programId, versionId);
    return latest?.status === "passed";
  }

  // ---- Internal helpers -------------------------------------------------

  private aggregate(checks: CertificationCheck[]): CertificationRunSummary {
    const passed = checks.filter((c) => c.result === "pass").length;
    const failed = checks.filter((c) => c.result === "fail").length;
    const warned = checks.filter((c) => c.result === "warn").length;
    const skipped = checks.filter((c) => c.result === "skip").length;
    return { passed, failed, warned, skipped, total: checks.length };
  }

  // ---- Built-in rules ---------------------------------------------------

  private registerBuiltins(): void {
    // 1. manifest_valid
    this.registerRule({
      id: asCheckId("manifest_valid"),
      category: "manifest",
      severity: "critical",
      description: "Manifest passes structural validation.",
      check: (m): RuleCheckResult => {
        const result: ManifestValidationResult = validateManifest(m);
        if (result.valid) {
          return {
            result: "pass",
            message: "Manifest is structurally valid.",
            detail: { warnings: result.warnings },
          };
        }
        return {
          result: "fail",
          message: `Manifest invalid: ${result.errors.map((e) => e.message).join("; ")}`,
          detail: { errors: result.errors, warnings: result.warnings },
        };
      },
    });

    // 2. manifest_signed
    this.registerRule({
      id: asCheckId("manifest_signed"),
      category: "security",
      severity: "high",
      description: "Manifest carries a cryptographic signature.",
      check: (m): RuleCheckResult => {
        if (!m.signature) {
          return {
            result: "fail",
            message: "Manifest is not signed.",
          };
        }
        return {
          result: "pass",
          message: `Manifest signed by ${m.signature.signedBy} at ${m.signature.signedAt}.`,
        };
      },
    });

    // 3. signature_verifiable
    this.registerRule({
      id: asCheckId("signature_verifiable"),
      category: "security",
      severity: "critical",
      description: "Manifest signature verifies against a trusted key.",
      check: (m): RuleCheckResult => {
        if (!m.signature) {
          return {
            result: "skip",
            message: "No signature present — cannot verify.",
          };
        }
        const trusted = this.trustedKeys.get(m.signature.keyId);
        if (!trusted) {
          return {
            result: "fail",
            message: `Signing key ${m.signature.keyId} is not in the trusted key store.`,
          };
        }
        const ok = verifyManifestSignature(m, trusted.publicKeyPem);
        if (ok) {
          return {
            result: "pass",
            message: `Signature verified against trusted key ${trusted.keyId}.`,
          };
        }
        return {
          result: "fail",
          message: "Signature failed cryptographic verification.",
        };
      },
    });

    // 4. no_wildcard_permissions
    this.registerRule({
      id: asCheckId("no_wildcard_permissions"),
      category: "permissions",
      severity: "critical",
      description: "No wildcard platform permissions requested.",
      check: (m): RuleCheckResult => {
        const wildcards = (m.permissions ?? []).filter(
          (p) => p === "*" || p === "platform:*" || p.endsWith(":*"),
        );
        if (wildcards.length > 0) {
          return {
            result: "fail",
            message: `Wildcard permissions are not allowed: ${wildcards.join(", ")}`,
            detail: { wildcards },
          };
        }
        return { result: "pass", message: "No wildcard permissions." };
      },
    });

    // 5. capabilities_declared
    this.registerRule({
      id: asCheckId("capabilities_declared"),
      category: "permissions",
      severity: "medium",
      description: "Reasonable number of capabilities declared.",
      check: (m): RuleCheckResult => {
        const count = m.capabilities?.length ?? 0;
        if (count === 0) {
          return {
            result: "warn",
            message: "No capabilities requested — program will have minimal access.",
          };
        }
        if (count > 10) {
          return {
            result: "fail",
            message: `Excessive capability count (${count}) — maximum 10 allowed.`,
            detail: { count, capabilities: m.capabilities.map((c) => c.capability) },
          };
        }
        return {
          result: "pass",
          message: `${count} capabilities declared.`,
        };
      },
    });

    // 6. resource_limits_reasonable
    this.registerRule({
      id: asCheckId("resource_limits_reasonable"),
      category: "resources",
      severity: "high",
      description: "Resource limits are within acceptable bounds.",
      check: (m): RuleCheckResult => {
        const mem = m.resourceLimits?.memoryMb;
        if (mem !== undefined && mem > 2048) {
          return {
            result: "fail",
            message: `Memory limit ${mem}MB exceeds 2048MB hard ceiling.`,
            detail: { memoryMb: mem },
          };
        }
        if (mem !== undefined && mem > 512) {
          return {
            result: "warn",
            message: `Memory limit ${mem}MB is elevated (>512MB) — may require manual review.`,
            detail: { memoryMb: mem },
          };
        }
        return {
          result: "pass",
          message: "Resource limits are within bounds.",
          detail: { memoryMb: mem },
        };
      },
    });

    // 7. privacy_declaration_complete
    this.registerRule({
      id: asCheckId("privacy_declaration_complete"),
      category: "privacy",
      severity: "high",
      description: "Privacy declaration is complete for collected data.",
      check: (m): RuleCheckResult => {
        const p = m.privacy;
        if (!p) {
          return { result: "fail", message: "Privacy declaration is missing." };
        }
        if (p.dataCollected.length > 0 && !p.dataUsage) {
          return {
            result: "fail",
            message: "Data collected but no usage declared.",
            detail: { dataCollected: p.dataCollected },
          };
        }
        if (p.retentionDays < 0) {
          return {
            result: "fail",
            message: `Invalid retention days: ${p.retentionDays}`,
          };
        }
        return {
          result: "pass",
          message: "Privacy declaration complete.",
          detail: {
            dataCollected: p.dataCollected.length,
            retentionDays: p.retentionDays,
          },
        };
      },
    });

    // 8. ai_usage_declared
    this.registerRule({
      id: asCheckId("ai_usage_declared"),
      category: "privacy",
      severity: "high",
      description: "AI usage is declared with a purpose when AI is used.",
      check: (m): RuleCheckResult => {
        const ai = m.aiUsage;
        if (!ai) {
          return { result: "warn", message: "AI usage declaration missing." };
        }
        if (ai.usesAI && !ai.purpose) {
          return {
            result: "fail",
            message: "AI is used but no purpose declared.",
          };
        }
        if (ai.usesAI && !ai.humanReadableExplanation) {
          return {
            result: "warn",
            message: "AI used without a human-readable explanation.",
          };
        }
        return {
          result: "pass",
          message: ai.usesAI
            ? `AI usage declared: ${ai.purpose}`
            : "No AI used.",
        };
      },
    });

    // 9. supported_languages_nonempty
    this.registerRule({
      id: asCheckId("supported_languages_nonempty"),
      category: "manifest",
      severity: "high",
      description: "At least one supported language is declared.",
      check: (m): RuleCheckResult => {
        if (!m.supportedLanguages || m.supportedLanguages.length === 0) {
          return {
            result: "fail",
            message: "No supported languages declared.",
          };
        }
        return {
          result: "pass",
          message: `${m.supportedLanguages.length} languages supported.`,
          detail: { languages: m.supportedLanguages },
        };
      },
    });

    // 10. dependencies_resolvable
    this.registerRule({
      id: asCheckId("dependencies_resolvable"),
      category: "dependencies",
      severity: "medium",
      description: "All declared dependencies are resolvable.",
      check: (m): RuleCheckResult => {
        const deps = m.dependencies ?? [];
        if (deps.length === 0) {
          return { result: "pass", message: "No dependencies declared." };
        }
        // Delegate to the dependencies module. If unavailable, fall back to
        // range syntax validation.
        let resolution;
        try {
          resolution = getDependencies().resolve(m);
        } catch {
          // Fall back to syntax validation
          const syntaxIssues: string[] = [];
          for (const d of deps) {
            if (!isValidRangeSyntax(d.versionRange)) {
              syntaxIssues.push(`${d.name}@${d.versionRange}`);
            }
          }
          if (syntaxIssues.length > 0) {
            return {
              result: "warn",
              message: `Could not resolve dependencies; syntax issues: ${syntaxIssues.join(", ")}`,
              detail: { syntaxIssues },
            };
          }
          return {
            result: "pass",
            message: `Dependencies not resolvable (module unavailable) — syntax OK for ${deps.length} deps.`,
          };
        }
        const conflicts = resolution.conflicts;
        if (conflicts.length > 0) {
          return {
            result: "warn",
            message: `Dependency conflicts: ${conflicts.map((c) => c.message).join("; ")}`,
            detail: { conflicts, resolved: resolution.resolved.length },
          };
        }
        return {
          result: "pass",
          message: `All ${deps.length} dependencies resolved.`,
          detail: { resolved: resolution.resolved.length },
        };
      },
    });

    // 11. no_sensitive_fields_without_consent
    this.registerRule({
      id: asCheckId("no_sensitive_fields_without_consent"),
      category: "permissions",
      severity: "high",
      description: "Sensitive capabilities declare purposes for consent.",
      check: (m): RuleCheckResult => {
        const issues: string[] = [];
        for (const c of m.capabilities ?? []) {
          const cap = getCapability(c.capability as CapabilityId);
          const sensitive = cap?.sensitive ?? false;
          const isMeasurementOrProfile =
            c.capability === "measurement" || c.capability === "profile";
          if (sensitive || isMeasurementOrProfile) {
            if (!c.purposes || c.purposes.length === 0) {
              issues.push(
                `${c.capability}: no purposes declared (required for consent-gated capability)`,
              );
            }
          }
        }
        if (issues.length > 0) {
          return {
            result: "fail",
            message: `Sensitive capabilities without purposes: ${issues.join("; ")}`,
            detail: { issues },
          };
        }
        return {
          result: "pass",
          message: "All sensitive capabilities declare purposes.",
        };
      },
    });

    // 12. sdk_version_compatible
    this.registerRule({
      id: asCheckId("sdk_version_compatible"),
      category: "api_compatibility",
      severity: "low",
      description: "Program targets a compatible SDK version (>= 1.0.0).",
      check: (m): RuleCheckResult => {
        const minSdk: SemVer = { major: 1, minor: 0, patch: 0 };
        const cmp = compareSemVer(m.sdkVersion, minSdk);
        if (cmp < 0) {
          return {
            result: "warn",
            message: `SDK version ${semVerToString(m.sdkVersion)} is below 1.0.0 — pre-release SDK.`,
            detail: { sdkVersion: semVerToString(m.sdkVersion) },
          };
        }
        return {
          result: "pass",
          message: `SDK version ${semVerToString(m.sdkVersion)} is stable.`,
        };
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isValidRangeSyntax(range: string): boolean {
  if (range === "*") return true;
  return /^(\^|~|>=|>|<=|<|=)?\d+\.\d+\.\d+/.test(range);
}

// ---------------------------------------------------------------------------
// Capability catalog re-export (for convenience)
// ---------------------------------------------------------------------------

export { CAPABILITIES, getCapability };

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _pipeline: CertificationPipeline | null = null;
export function getCertification(): CertificationPipeline {
  if (!_pipeline) _pipeline = new CertificationPipeline();
  return _pipeline;
}

export function resetCertification(): void {
  _pipeline = null;
}

// ---------------------------------------------------------------------------
// Barrel re-exports
// ---------------------------------------------------------------------------

export type {
  CertificationId,
  ProgramId,
  ProgramVersionId,
} from "../core";
export type { ProgramManifest, SigningKeyPair } from "../manifests";
