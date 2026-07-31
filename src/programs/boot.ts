/**
 * Eks-Health Program OS — Boot Sequence
 *
 * Idempotently initializes the Program OS, seeds demo programs (generic
 * shells only — no disease-specific logic), and emits the platform_started
 * program event.
 */

import "server-only";
import { getEventBus, buildEvent, getClock, bootKernel } from "@/kernel";
import { bootIdentity } from "@/identity";
import { getRegistry } from "./lifecycle";
import { getCapabilities, listCapabilities } from "./capabilities";
import { getSandboxManager } from "./sandbox";
import { getQuotas } from "./quotas";
import { getProgramStorage } from "./storage";
import { getProgramEvents } from "./events";
import { getCertification } from "./certification";
import { getSdk } from "./sdk";
import { getTesting } from "./testing";
import { getDependencies } from "./dependencies";
import { getMarketplace } from "./marketplace";
import { getProgramObservability } from "./observability";
import { getDeveloperManager } from "./developer";
import { getExecutionManager } from "./execution";
import { PROGRAM_EVENTS, asProgramId, asDeveloperId, type ProgramId, type DeveloperId } from "./core";
import { buildManifest, generateSigningKeyPair, signManifest } from "./manifests";

export interface ProgramsInfo {
  readonly name: string;
  readonly version: string;
  readonly bootedAt: string;
  readonly subsystems: string[];
}

let _booted = false;
let _info: ProgramsInfo | null = null;

export function bootPrograms(): ProgramsInfo {
  if (_booted && _info) return _info;
  bootKernel();
  bootIdentity();

  getRegistry();
  getCapabilities();
  getSandboxManager();
  getQuotas();
  getProgramStorage();
  getProgramEvents();
  getCertification();
  getSdk();
  getTesting();
  getDependencies();
  getMarketplace();
  getProgramObservability();
  getDeveloperManager();
  getExecutionManager();

  _booted = true;
  _info = {
    name: "Eks-Health Program Operating System",
    version: "3.0.0-m3",
    bootedAt: getClock().iso(),
    subsystems: [
      "core", "manifests", "capabilities", "lifecycle", "sandbox", "quotas",
      "storage", "events", "certification", "sdk", "testing", "dependencies",
      "marketplace", "observability", "developer", "execution",
    ],
  };
  void getEventBus().publish(
    buildEvent(PROGRAM_EVENTS.created, { version: _info.version }, {}, "system"),
  );
  return _info;
}

export function programsInfo(): ProgramsInfo {
  if (!_info) {
    _info = {
      name: "Eks-Health Program Operating System",
      version: "3.0.0-m3",
      bootedAt: getClock().iso(),
      subsystems: [],
    };
  }
  return _info;
}

export function programsSnapshot() {
  ensureBooted();
  const registry = getRegistry();
  const caps = getCapabilities();
  const sandbox = getSandboxManager();
  const quotas = getQuotas();
  const cert = getCertification();
  const sdk = getSdk();
  const deps = getDependencies();
  const market = getMarketplace();
  const obs = getProgramObservability();
  const dev = getDeveloperManager();
  const exec = getExecutionManager();

  const programs = registry.list();
  return {
    info: programsInfo(),
    programs: programs.map((p) => ({
      id: p.id, slug: p.slug, name: p.name, kind: p.kind, category: p.category,
      state: p.state, developerId: p.developerId, versionCount: p.versions.length,
      currentVersionId: p.currentVersionId, installedCount: p.installedCount,
      activeInstallCount: p.activeInstallCount, rating: p.rating, reviewCount: p.reviewCount,
      createdAt: p.createdAt, updatedAt: p.updatedAt, publishedAt: p.publishedAt, forkedFrom: p.forkedFrom,
    })),
    versions: programs.flatMap((p) =>
      p.versions.map((v) => ({
        programId: p.id, programName: p.name, versionId: v.id,
        version: `${v.version.major}.${v.version.minor}.${v.version.patch}`,
        channel: v.channel, certified: v.certified, fingerprint: v.fingerprint.slice(0, 16),
        createdAt: v.createdAt,
      })),
    ),
    capabilities: {
      catalog: listCapabilities(),
      grants: caps.listGrants().map((g) => ({
        id: g.id, programId: g.programId, capability: g.capability,
        accountId: g.accountId, active: g.active, scope: g.scope,
      })),
    },
    sandbox: {
      sandboxes: sandbox.list().map((s) => ({ id: s.id, programId: s.programId, createdAt: s.createdAt })),
      violations: sandbox.getViolations().slice(-20),
    },
    quotas: programs.map((p) => ({ programId: p.id, quota: registry.getEffectiveQuota(p.id), usage: quotas.getUsage(p.id) })),
    certification: {
      rules: cert.listRules().map((r) => ({ id: r.id, category: r.category, severity: r.severity })),
      runs: cert.listRuns().slice(-10).map((r) => ({
        id: r.id, programId: r.programId, versionId: r.versionId, status: r.status,
      })),
    },
    sdk: {
      templates: sdk.listTemplates().map((t) => ({ id: t.id, name: t.name, description: t.description })),
      cliCommands: sdk.listCliCommands().map((c) => ({ id: c.id, name: c.name, description: c.description })),
    },
    dependencies: {
      libraries: deps.listLibraries().map((l) => ({ name: l.name, versions: l.versions.map((v) => `${v.version.major}.${v.version.minor}.${v.version.patch}`) })),
    },
    marketplace: {
      listings: market.listListings().map((l) => ({
        id: l.id, programId: l.programId, name: l.name, slug: l.slug,
        category: l.category, status: l.status, pricingModel: l.pricingModel,
        rating: l.rating?.value, reviewCount: l.rating?.count,
      })),
      categories: market.getCategories(),
      stats: market.getStats(),
    },
    observability: programs.map((p) => {
      const snap = obs.getDiagnosticSnapshot(p.id);
      return {
        programId: p.id, programName: p.name,
        health: snap.health?.status, errorCount: snap.metrics.errorCount,
        crashCount: snap.metrics.crashCount, avgLatencyMs: snap.metrics.avgLatencyMs,
        p95LatencyMs: snap.metrics.p95LatencyMs, installCount: snap.installCount,
      };
    }),
    developers: {
      profiles: dev.listProfiles().map((d) => ({
        id: d.id, name: d.name, email: d.email, verified: d.verification.status === "verified",
        status: d.status, metrics: dev.getMetrics(d.id),
      })),
    },
    execution: {
      stats: exec.getStats(),
      recentJobs: exec.listJobs().slice(-10).map((j) => ({
        id: j.id, programId: j.programId, status: j.status, priority: j.spec.priority,
      })),
    },
    auditLog: registry.getAuditLog().slice(-30),
  };
}

function ensureBooted() {
  if (!_booted) bootPrograms();
}

// ---------------------------------------------------------------------------
// Demo data seeding — generic program shells (NO disease-specific logic)
// ---------------------------------------------------------------------------

let _seeded = false;

export async function seedProgramDemoData(): Promise<{ programIds: ProgramId[]; developerId?: DeveloperId }> {
  if (_seeded) return { programIds: [] };
  ensureBooted();

  const devMgr = getDeveloperManager();
  const registry = getRegistry();
  const market = getMarketplace();
  const signingKey = generateSigningKeyPair("demo-key-1");
  const programIds: ProgramId[] = [];

  // Hydrate developer profiles from DB first; skip profile creation if already present.
  await devMgr.hydrateFromDb();

  let developerId: DeveloperId;
  try {
    const existing = devMgr.listProfiles().find((p) => p.email === "kwame@eks.health");
    if (existing) {
      developerId = existing.id;
    } else {
      const profile = devMgr.createProfile({
        name: "Demo Developer",
        email: "kwame@eks.health",
        organization: "Eks-Health Labs",
        bio: "Building preventive health programs on the Eks-Health platform.",
        website: "https://eks.health",
      });
      developerId = profile.id;
      devMgr.verify(profile.id, "platform-admin");
    }
  } catch {
    developerId = asDeveloperId("dev_demo_1");
  }

  const demoPrograms = [
    {
      slug: "cardio-care", name: "Cardio Care", version: "1.2.0",
      description: "A cardiovascular prevention program with daily check-ins and progress tracking.",
      category: "cardiovascular" as const,
      capabilities: ["measurement", "notification", "scheduling", "analytics", "event-subscription"],
      measurementDefs: [{ id: "resting_hr", type: "measurement" as const, name: "Resting Heart Rate", description: "Morning resting heart rate", schema: { type: "number", unit: "bpm" }, unit: "bpm", privacyLevel: "confidential" as const }],
    },
    {
      slug: "sleep-optimizer", name: "Sleep Optimizer", version: "2.0.0",
      description: "Sleep quality tracking with AI-powered insights and wind-down reminders.",
      category: "sleep" as const,
      capabilities: ["measurement", "notification", "ai", "analytics", "event-subscription"],
      measurementDefs: [{ id: "sleep_duration", type: "measurement" as const, name: "Sleep Duration", description: "Total sleep duration", schema: { type: "number", unit: "hours" }, unit: "hours", privacyLevel: "confidential" as const }],
    },
    {
      slug: "nutrition-planner", name: "Nutrition Planner", version: "1.0.0",
      description: "Personalized nutrition planning based on participant goals and preferences.",
      category: "nutrition" as const,
      capabilities: ["profile", "notification", "storage", "analytics"],
      measurementDefs: [],
    },
    {
      slug: "fit-streak", name: "FitStreak", version: "3.1.0",
      description: "Gamified fitness with competitions, missions, and leaderboards.",
      category: "fitness" as const,
      capabilities: ["measurement", "competition", "leaderboard", "mission", "reward", "notification", "event-subscription"],
      measurementDefs: [{ id: "steps", type: "measurement" as const, name: "Daily Steps", description: "Step count", schema: { type: "number", unit: "steps" }, unit: "steps", privacyLevel: "public" as const }],
    },
    {
      slug: "mindful-daily", name: "Mindful Daily", version: "1.4.0",
      description: "Daily mental wellness practices with mood tracking and guided sessions.",
      category: "mental-wellness" as const,
      capabilities: ["measurement", "notification", "scheduling", "media", "analytics"],
      measurementDefs: [{ id: "mood_score", type: "measurement" as const, name: "Mood Score", description: "Self-reported mood 1-10", schema: { type: "number", min: 1, max: 10 }, privacyLevel: "restricted" as const }],
    },
  ];

  for (const d of demoPrograms) {
    try {
      const manifest = buildManifest({
        slug: d.slug, name: d.name, version: d.version, description: d.description,
        category: d.category, developerId: developerId, developerName: "Demo Developer", developerEmail: "kwame@eks.health",
        capabilities: d.capabilities.map((c) => ({
          capability: c as never, reason: `Program requires ${c} capability to function.`,
          purposes: ["measurement", "profile"].includes(c) ? ["program_operation"] : undefined, scope: "self",
        })),
        supportedCountries: ["GH", "NG", "KE", "ZA"], supportedLanguages: ["en", "fr", "sw"],
        resourceLimits: d.capabilities.includes("ai") ? { aiRequestsPerDay: 200, memoryMb: 256 } : { memoryMb: 128 },
        privacy: {
          dataCollected: d.capabilities.includes("measurement") ? ["measurements", "timestamps"] : ["preferences"],
          dataUsage: "Used to provide personalized program recommendations and track progress.",
          thirdPartySharing: false, retentionDays: 365, anonymizationApplied: true, residencyRegions: ["af-west-1"],
        },
        aiUsage: d.capabilities.includes("ai") ? {
          usesAI: true, provider: "eks-ai", modelFamily: "glm", purpose: "Generate personalized sleep insights",
          trainingDataUsed: false, humanReadableExplanation: "AI analyzes sleep patterns to suggest improvements.",
        } : { usesAI: false },
        measurementDefinitions: d.measurementDefs,
        eventSubscriptions: d.capabilities.includes("event-subscription") ? [
          "eks.identity.account.registered", "eks.identity.consent.granted", "eks.identity.consent.revoked",
        ] : [],
      });
      const signed = signManifest(manifest, signingKey, "demo-developer");
      const record = registry.create(signed, developerId);
      registry.addVersion(record.id, signed, d.version.startsWith("2") || d.version.startsWith("3") ? "stable" : "beta", "Initial demo release.");
      const version = registry.get(record.id)!.versions[0];
      // Certification is async — run it and check result
      void getCertification().run(signed, version.id).then((run) => {
        if (run.status === "passed") {
          registry.transition(record.id, "in_review");
          registry.transition(record.id, "certified");
          registry.transition(record.id, "published");
          market.createListing(record.id, {
            tagline: d.description, description: d.description, category: d.category, tags: [d.category, "preventive"],
          });
        }
      });
      programIds.push(record.id);
    } catch {
      // ignore on re-seed
    }
  }

  _seeded = true;
  return { programIds, developerId };
}
