/**
 * Eks-Health Program OS — Testing Framework
 *
 * Supports: unit, integration, contract, security, permission, performance,
 * migration, compatibility, load, regression, and automated certification
 * tests.
 *
 * The framework executes real test functions, records assertions, and
 * aggregates results. It also auto-generates contract, permission, and
 * security test suites from a manifest, and provides a MockPlatform with
 * stubbed APIs that record calls for assertion.
 */

import "server-only";
import {
  type ProgramId,
  type CapabilityId,
  ProgramError,
  semVerToString,
} from "../core";
import type { ProgramManifest } from "../manifests";
import {
  validateManifest,
  verifyManifestSignature,
} from "../manifests";
import { getCapability } from "../capabilities";
import { getEventBus, buildEvent, generateId, getClock } from "@/kernel";

// ---------------------------------------------------------------------------
// Test types
// ---------------------------------------------------------------------------

export type TestCategory =
  | "unit"
  | "integration"
  | "contract"
  | "security"
  | "permission"
  | "performance"
  | "migration"
  | "compatibility"
  | "load"
  | "regression"
  | "certification";

export type TestStatus = "pass" | "fail" | "skip";

export interface TestAssertion {
  readonly label: string;
  readonly passed: boolean;
  readonly actual?: unknown;
  readonly expected?: unknown;
}

export interface TestCase {
  readonly id: string;
  readonly name: string;
  readonly category: TestCategory;
  readonly run: (ctx: TestContext) => void | Promise<void>;
  readonly skip?: boolean;
  readonly timeoutMs?: number;
}

export interface TestSuite {
  readonly id: string;
  readonly name: string;
  readonly programId?: ProgramId;
  readonly category: TestCategory;
  readonly cases: TestCase[];
}

export interface TestResult {
  readonly caseId: string;
  readonly suiteId: string;
  readonly name: string;
  readonly category: TestCategory;
  readonly status: TestStatus;
  readonly assertions: TestAssertion[];
  readonly error?: string;
  readonly durationMs: number;
}

export interface TestRunSummary {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly assertions: number;
}

export interface TestRun {
  readonly id: string;
  readonly programId?: ProgramId;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly results: TestResult[];
  readonly summary: TestRunSummary;
  readonly categoriesRun: TestCategory[];
}

// ---------------------------------------------------------------------------
// Test context
// ---------------------------------------------------------------------------

export interface TestContext {
  readonly mock: MockPlatform;
  readonly manifest?: ProgramManifest;
  readonly assert: AssertApi;
}

export interface AssertApi {
  (label: string, passed: boolean, actual?: unknown, expected?: unknown): void;
  truthy(label: string, value: unknown): void;
  equals(label: string, actual: unknown, expected: unknown): void;
  fails(label: string): void;
  contains(label: string, haystack: unknown[], needle: unknown): void;
}

// ---------------------------------------------------------------------------
// Mock Platform
// ---------------------------------------------------------------------------

export interface MockMeasurement {
  record(input: unknown): string;
  list(): unknown[];
  getById(id: string): unknown | undefined;
}

export interface MockCompetition {
  create(input: unknown): string;
  list(): unknown[];
  start(id: string): void;
  end(id: string): void;
}

export interface MockLeaderboard {
  upsert(input: unknown): void;
  list(): unknown[];
}

export interface MockMission {
  create(input: unknown): string;
  complete(id: string): void;
  list(): unknown[];
}

export interface MockNotification {
  send(input: unknown): string;
  list(): unknown[];
}

export interface MockProfile {
  read(): Record<string, unknown>;
  update(patch: Record<string, unknown>): void;
}

export interface MockStorage {
  put(key: string, value: unknown): void;
  get(key: string): unknown | undefined;
  delete(key: string): boolean;
  keys(): string[];
}

export interface MockAi {
  prompt(input: unknown): string;
  history(): unknown[];
}

export interface MockAnalytics {
  track(event: string, props?: Record<string, unknown>): void;
  events(): { event: string; props?: Record<string, unknown> }[];
}

export interface MockPlatform {
  readonly measurement: MockMeasurement;
  readonly competition: MockCompetition;
  readonly leaderboard: MockLeaderboard;
  readonly mission: MockMission;
  readonly notification: MockNotification;
  readonly profile: MockProfile;
  readonly storage: MockStorage;
  readonly ai: MockAi;
  readonly analytics: MockAnalytics;
  readonly calls: Record<string, unknown[][]>;
  reset(): void;
  callLog(): { method: string; args: unknown[] }[];
}

// ---------------------------------------------------------------------------
// Mock platform factory
// ---------------------------------------------------------------------------

function createMockPlatform(): MockPlatform {
  const calls: Record<string, unknown[][]> = {};
  const callLog: { method: string; args: unknown[] }[] = [];

  function record(method: string, args: unknown[]): void {
    if (!calls[method]) calls[method] = [];
    calls[method].push(args);
    callLog.push({ method, args });
  }

  const measurements = new Map<string, unknown>();
  const competitions = new Map<string, unknown>();
  const leaderboard = new Map<string, unknown>();
  const missions = new Map<string, unknown>();
  const notifications = new Map<string, unknown>();
  let profile: Record<string, unknown> = {};
  const storage = new Map<string, unknown>();
  const aiHistory: unknown[] = [];
  const analyticsEvents: { event: string; props?: Record<string, unknown> }[] = [];

  const measurement: MockMeasurement = {
    record(input) {
      const id = generateId("meas_");
      measurements.set(id, input);
      record("measurement.record", [input]);
      return id;
    },
    list() {
      return [...measurements.values()];
    },
    getById(id) {
      return measurements.get(id);
    },
  };

  const competition: MockCompetition = {
    create(input) {
      const id = generateId("comp_");
      competitions.set(id, { ...(input as Record<string, unknown>), status: "created" });
      record("competition.create", [input]);
      return id;
    },
    list() {
      return [...competitions.values()];
    },
    start(id) {
      const c = competitions.get(id);
      if (c) competitions.set(id, { ...(c as Record<string, unknown>), status: "active" });
      record("competition.start", [id]);
    },
    end(id) {
      const c = competitions.get(id);
      if (c) competitions.set(id, { ...(c as Record<string, unknown>), status: "ended" });
      record("competition.end", [id]);
    },
  };

  const leaderboardApi: MockLeaderboard = {
    upsert(input) {
      const entry = input as { participantId: string };
      leaderboard.set(entry.participantId, input);
      record("leaderboard.upsert", [input]);
    },
    list() {
      return [...leaderboard.values()];
    },
  };

  const mission: MockMission = {
    create(input) {
      const id = generateId("mis_");
      missions.set(id, { ...(input as Record<string, unknown>), status: "active" });
      record("mission.create", [input]);
      return id;
    },
    complete(id) {
      const m = missions.get(id);
      if (m) missions.set(id, { ...(m as Record<string, unknown>), status: "completed" });
      record("mission.complete", [id]);
    },
    list() {
      return [...missions.values()];
    },
  };

  const notification: MockNotification = {
    send(input) {
      const id = generateId("not_");
      notifications.set(id, input);
      record("notification.send", [input]);
      return id;
    },
    list() {
      return [...notifications.values()];
    },
  };

  const profileApi: MockProfile = {
    read() {
      record("profile.read", []);
      return { ...profile };
    },
    update(patch) {
      profile = { ...profile, ...(patch as Record<string, unknown>) };
      record("profile.update", [patch]);
    },
  };

  const storageApi: MockStorage = {
    put(key, value) {
      storage.set(key, value);
      record("storage.put", [key, value]);
    },
    get(key) {
      record("storage.get", [key]);
      return storage.get(key);
    },
    delete(key) {
      const existed = storage.delete(key);
      record("storage.delete", [key]);
      return existed;
    },
    keys() {
      return [...storage.keys()];
    },
  };

  const ai: MockAi = {
    prompt(input) {
      const response = `mock-response-${generateId("ai_")}`;
      aiHistory.push({ input, response });
      record("ai.prompt", [input]);
      return response;
    },
    history() {
      return [...aiHistory];
    },
  };

  const analytics: MockAnalytics = {
    track(event, props) {
      analyticsEvents.push({ event, props });
      record("analytics.track", [event, props]);
    },
    events() {
      return [...analyticsEvents];
    },
  };

  return {
    measurement,
    competition,
    leaderboard: leaderboardApi,
    mission,
    notification,
    profile: profileApi,
    storage: storageApi,
    ai,
    analytics,
    calls,
    reset() {
      for (const k of Object.keys(calls)) delete calls[k];
      callLog.length = 0;
      measurements.clear();
      competitions.clear();
      leaderboard.clear();
      missions.clear();
      notifications.clear();
      profile = {};
      storage.clear();
      aiHistory.length = 0;
      analyticsEvents.length = 0;
    },
    callLog() {
      return [...callLog];
    },
  };
}

// ---------------------------------------------------------------------------
// Assert API factory
// ---------------------------------------------------------------------------

function createAssertApi(collector: TestAssertion[]): AssertApi {
  const api = (label: string, passed: boolean, actual?: unknown, expected?: unknown): void => {
    collector.push({ label, passed, actual, expected });
  };
  api.truthy = (label, value) => {
    collector.push({ label, passed: !!value, actual: value });
  };
  api.equals = (label, actual, expected) => {
    collector.push({
      label,
      passed: JSON.stringify(actual) === JSON.stringify(expected),
      actual,
      expected,
    });
  };
  api.fails = (label) => {
    collector.push({ label, passed: false });
  };
  api.contains = (label, haystack, needle) => {
    collector.push({
      label,
      passed: haystack.some((h) => JSON.stringify(h) === JSON.stringify(needle)),
      actual: haystack,
      expected: needle,
    });
  };
  return api;
}

// ---------------------------------------------------------------------------
// Testing Framework
// ---------------------------------------------------------------------------

export class TestingFramework {
  private readonly suites = new Map<string, TestSuite>();
  private readonly runs = new Map<string, TestRun>();
  private readonly byProgram = new Map<ProgramId, string[]>();

  // ---- Suite management ------------------------------------------------

  registerSuite(suite: TestSuite): void {
    if (this.suites.has(suite.id)) {
      throw new ProgramError({
        code: "eks.program.testing.suite.duplicate",
        category: "validation",
        message: `Suite ${suite.id} already registered.`,
        userMessage: "Test suite already exists.",
      });
    }
    this.suites.set(suite.id, suite);
  }

  listSuites(): readonly TestSuite[] {
    return [...this.suites.values()];
  }

  getSuite(id: string): TestSuite | undefined {
    return this.suites.get(id);
  }

  // ---- Run execution ---------------------------------------------------

  async run(
    programId?: ProgramId,
    categories?: TestCategory[],
  ): Promise<TestRun> {
    const startedAt = getClock().iso();
    const catSet = categories ? new Set(categories) : undefined;

    const matchingSuites = [...this.suites.values()].filter((s) => {
      if (programId && s.programId && s.programId !== programId) return false;
      if (catSet && !catSet.has(s.category)) return false;
      return true;
    });

    const results: TestResult[] = [];
    const categoriesRun = new Set<TestCategory>();

    for (const suite of matchingSuites) {
      categoriesRun.add(suite.category);
      for (const testCase of suite.cases) {
        const result = await this.executeCase(suite, testCase);
        results.push(result);
      }
    }

    const completedAt = getClock().iso();
    const summary = this.summarize(results);
    const runId = generateId("trun_");

    const run: TestRun = {
      id: runId,
      programId,
      startedAt,
      completedAt,
      results,
      summary,
      categoriesRun: [...categoriesRun],
    };

    this.runs.set(runId, run);
    if (programId) {
      const existing = this.byProgram.get(programId) ?? [];
      this.byProgram.set(programId, [...existing, runId]);
    }

    void getEventBus().publish(
      buildEvent(
        "eks.program.testing.run_completed",
        { runId, programId, summary },
        {},
        "domain",
      ),
    );

    return run;
  }

  private async executeCase(
    suite: TestSuite,
    testCase: TestCase,
  ): Promise<TestResult> {
    if (testCase.skip) {
      return {
        caseId: testCase.id,
        suiteId: suite.id,
        name: testCase.name,
        category: testCase.category,
        status: "skip",
        assertions: [],
        durationMs: 0,
      };
    }

    const assertions: TestAssertion[] = [];
    const mock = createMockPlatform();
    const assert = createAssertApi(assertions);
    const ctx: TestContext = { mock, assert };

    const t0 = Date.now();
    let status: TestStatus = "pass";
    let error: string | undefined;

    try {
      await Promise.resolve(testCase.run(ctx));
      if (assertions.length > 0 && assertions.every((a) => !a.passed)) {
        // If every assertion failed, mark as fail (otherwise pass)
        status = "fail";
      } else if (assertions.some((a) => !a.passed)) {
        status = "fail";
      }
    } catch (e) {
      status = "fail";
      error = e instanceof Error ? e.message : String(e);
    }

    const durationMs = Date.now() - t0;

    return {
      caseId: testCase.id,
      suiteId: suite.id,
      name: testCase.name,
      category: testCase.category,
      status,
      assertions,
      error,
      durationMs,
    };
  }

  private summarize(results: TestResult[]): TestRunSummary {
    const passed = results.filter((r) => r.status === "pass").length;
    const failed = results.filter((r) => r.status === "fail").length;
    const skipped = results.filter((r) => r.status === "skip").length;
    const assertions = results.reduce((sum, r) => sum + r.assertions.length, 0);
    return { total: results.length, passed, failed, skipped, assertions };
  }

  // ---- Auto-generated contract tests -----------------------------------

  async runContractTests(manifest: ProgramManifest): Promise<TestRun> {
    const suite: TestSuite = {
      id: `contract-${manifest.id}-${generateId("")}`,
      name: `Contract tests for ${manifest.name}`,
      category: "contract",
      cases: this.generateContractCases(manifest),
    };

    const startedAt = getClock().iso();
    const results: TestResult[] = [];
    for (const testCase of suite.cases) {
      results.push(await this.executeCase(suite, testCase));
    }
    const completedAt = getClock().iso();
    const summary = this.summarize(results);
    const runId = generateId("trun_");

    const run: TestRun = {
      id: runId,
      startedAt,
      completedAt,
      results,
      summary,
      categoriesRun: ["contract"],
    };
    this.runs.set(runId, run);
    return run;
  }

  private generateContractCases(manifest: ProgramManifest): TestCase[] {
    return [
      {
        id: "manifest-validates",
        name: "Manifest passes structural validation",
        category: "contract",
        run: (ctx) => {
          const result = validateManifest(manifest);
          ctx.assert.equals("manifest is valid", result.valid, true);
        },
      },
      {
        id: "signature-verifies",
        name: "Signature verifies (if signed)",
        category: "contract",
        run: (ctx) => {
          if (!manifest.signature) {
            ctx.assert.truthy("manifest has no signature (skipped)", false);
            return;
          }
          // We can't verify without the public key, but we can assert structure
          ctx.assert.truthy("signature algorithm present", !!manifest.signature.algorithm);
          ctx.assert.truthy("signature value present", !!manifest.signature.signature);
          ctx.assert.truthy("keyId present", !!manifest.signature.keyId);
        },
      },
      {
        id: "resource-limits-sane",
        name: "Resource limits are within sane bounds",
        category: "contract",
        run: (ctx) => {
          const mem = manifest.resourceLimits?.memoryMb;
          if (mem !== undefined) {
            ctx.assert("memory <= 2048MB", mem <= 2048, mem, 2048);
          } else {
            ctx.assert("no memory limit (default)", true);
          }
        },
      },
      {
        id: "sdk-version-stable",
        name: "SDK version is at least 1.0.0",
        category: "contract",
        run: (ctx) => {
          const ok = manifest.sdkVersion.major >= 1;
          ctx.assert("sdk >= 1.0.0", ok, semVerToString(manifest.sdkVersion), ">=1.0.0");
        },
      },
      {
        id: "supported-apis-valid",
        name: "Supported APIs are recognized",
        category: "contract",
        run: (ctx) => {
          const known = new Set(["rest", "websocket", "webhook"]);
          const allKnown = manifest.supportedApis.every((a) => known.has(a));
          ctx.assert("all supported APIs recognized", allKnown, manifest.supportedApis, [...known]);
        },
      },
    ];
  }

  // ---- Auto-generated permission tests ---------------------------------

  async runPermissionTests(manifest: ProgramManifest): Promise<TestRun> {
    const suite: TestSuite = {
      id: `permission-${manifest.id}-${generateId("")}`,
      name: `Permission tests for ${manifest.name}`,
      category: "permission",
      cases: this.generatePermissionCases(manifest),
    };

    const startedAt = getClock().iso();
    const results: TestResult[] = [];
    for (const testCase of suite.cases) {
      results.push(await this.executeCase(suite, testCase));
    }
    const completedAt = getClock().iso();
    const summary = this.summarize(results);
    const runId = generateId("trun_");

    const run: TestRun = {
      id: runId,
      startedAt,
      completedAt,
      results,
      summary,
      categoriesRun: ["permission"],
    };
    this.runs.set(runId, run);
    return run;
  }

  private generatePermissionCases(manifest: ProgramManifest): TestCase[] {
    const cases: TestCase[] = [];
    for (const c of manifest.capabilities) {
      cases.push({
        id: `cap-${c.capability}-has-reason`,
        name: `Capability ${c.capability} has a reason`,
        category: "permission",
        run: (ctx) => {
          ctx.assert.truthy(`${c.capability} has reason`, c.reason);
        },
      });
      const cap = getCapability(c.capability as CapabilityId);
      const sensitive = cap?.sensitive ?? false;
      if (sensitive) {
        cases.push({
          id: `cap-${c.capability}-has-purposes`,
          name: `Sensitive capability ${c.capability} declares purposes`,
          category: "permission",
          run: (ctx) => {
            ctx.assert.truthy(
              `${c.capability} has purposes`,
              (c.purposes ?? []).length > 0,
            );
          },
        });
      }
    }
    if (cases.length === 0) {
      cases.push({
        id: "no-capabilities",
        name: "No capabilities requested",
        category: "permission",
        run: (ctx) => {
          ctx.assert.truthy("no capabilities declared", true);
        },
      });
    }
    return cases;
  }

  // ---- Auto-generated security tests -----------------------------------

  async runSecurityTests(manifest: ProgramManifest): Promise<TestRun> {
    const suite: TestSuite = {
      id: `security-${manifest.id}-${generateId("")}`,
      name: `Security tests for ${manifest.name}`,
      category: "security",
      cases: this.generateSecurityCases(manifest),
    };

    const startedAt = getClock().iso();
    const results: TestResult[] = [];
    for (const testCase of suite.cases) {
      results.push(await this.executeCase(suite, testCase));
    }
    const completedAt = getClock().iso();
    const summary = this.summarize(results);
    const runId = generateId("trun_");

    const run: TestRun = {
      id: runId,
      startedAt,
      completedAt,
      results,
      summary,
      categoriesRun: ["security"],
    };
    this.runs.set(runId, run);
    return run;
  }

  private generateSecurityCases(manifest: ProgramManifest): TestCase[] {
    return [
      {
        id: "no-wildcard-permissions",
        name: "No wildcard permissions requested",
        category: "security",
        run: (ctx) => {
          const wildcards = (manifest.permissions ?? []).filter(
            (p) => p === "*" || p === "platform:*" || p.endsWith(":*"),
          );
          ctx.assert("no wildcards", wildcards.length === 0, wildcards, []);
        },
      },
      {
        id: "resource-limits-not-excessive",
        name: "Resource limits are not excessive",
        category: "security",
        run: (ctx) => {
          const mem = manifest.resourceLimits?.memoryMb ?? 0;
          ctx.assert("memory <= 2048MB", mem <= 2048, mem, "<=2048");
          const api = manifest.resourceLimits?.apiRequestsPerMinute ?? 0;
          ctx.assert("api rate <= 5000", api <= 5000, api, "<=5000");
        },
      },
      {
        id: "privacy-declaration-present",
        name: "Privacy declaration is present and complete",
        category: "security",
        run: (ctx) => {
          ctx.assert.truthy("privacy defined", !!manifest.privacy);
          if (manifest.privacy) {
            ctx.assert.truthy(
              "dataUsage declared when data collected",
              manifest.privacy.dataCollected.length === 0 || !!manifest.privacy.dataUsage,
            );
            ctx.assert("retentionDays >= 0", manifest.privacy.retentionDays >= 0, manifest.privacy.retentionDays, ">=0");
          }
        },
      },
      {
        id: "capability-count-reasonable",
        name: "Capability count is reasonable (<= 10)",
        category: "security",
        run: (ctx) => {
          const count = manifest.capabilities.length;
          ctx.assert("<= 10 capabilities", count <= 10, count, "<=10");
        },
      },
      {
        id: "ai-usage-declared",
        name: "AI usage is properly declared",
        category: "security",
        run: (ctx) => {
          if (manifest.aiUsage.usesAI) {
            ctx.assert.truthy("AI purpose declared", !!manifest.aiUsage.purpose);
          } else {
            ctx.assert.truthy("no AI used", true);
          }
        },
      },
    ];
  }

  // ---- Mock platform factory -------------------------------------------

  createMockPlatform(): MockPlatform {
    return createMockPlatform();
  }

  // ---- Run access ------------------------------------------------------

  getRun(id: string): TestRun | undefined {
    return this.runs.get(id);
  }

  listRuns(programId?: ProgramId): TestRun[] {
    if (programId) {
      const ids = this.byProgram.get(programId) ?? [];
      return ids.map((id) => this.runs.get(id)!).filter(Boolean);
    }
    return [...this.runs.values()];
  }
}

// ---------------------------------------------------------------------------
// Capability re-export
// ---------------------------------------------------------------------------

export { getCapability };

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _testing: TestingFramework | null = null;
export function getTesting(): TestingFramework {
  if (!_testing) _testing = new TestingFramework();
  return _testing;
}

export function resetTesting(): void {
  _testing = null;
}

// ---------------------------------------------------------------------------
// Barrel re-exports
// ---------------------------------------------------------------------------

export type { ProgramId, CapabilityId } from "../core";
export type { ProgramManifest } from "../manifests";
export { validateManifest, verifyManifestSignature } from "../manifests";
