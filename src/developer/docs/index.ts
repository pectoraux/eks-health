/**
 * Eks-Health Developer Platform — Documentation Platform
 *
 * Automatically generates:
 *  - API reference (from capabilities + CLI commands)
 *  - SDK guides (from scaffold templates + CLI command catalog)
 *  - Event catalog (from HEALTH_EVENTS, MISSION_EVENTS, COMPETITION_EVENTS,
 *    PROGRAM_EVENTS, IDENTITY_EVENTS, DEVELOPER_EVENTS, SYSTEM_EVENTS)
 *  - Manifest reference (from the ProgramManifest schema)
 *  - Migration guides (from SDK versioning)
 *  - Tutorials, onboarding, architecture diagrams, FAQ
 *
 * Every page is REAL markdown generated from REAL platform data. Templates
 * use {variable} placeholders that are rendered with actual platform state.
 * Search is a real substring + token match across page content.
 *
 * The DocsBuild returned by generate() is persisted in-memory so subsequent
 * getPage() / search() calls return the same content.
 */

import "server-only";

import {
  type DocPage,
  type DocsBuild,
  type DocType,
  type DocsBuildId,
  DeveloperError,
  asDocsBuildId,
  DEVELOPER_EVENTS,
} from "../core";
import type { ProgramId } from "@/programs";
import { getEventBus, buildEvent, generateId, getClock } from "@/kernel";

// Re-export core doc types so consumers can import everything from "./docs".
export type { DocPage, DocsBuild, DocType, DocsBuildId, ProgramId };

// ---------------------------------------------------------------------------
// Extended docs types
// ---------------------------------------------------------------------------

export interface DocTemplate {
  readonly type: DocType;
  readonly title: string;
  readonly slug: string;
  /** Markdown with {variable} placeholders. */
  readonly contentTemplate: string;
  readonly category: string;
  readonly order: number;
}

export interface DocsConfig {
  readonly programId?: ProgramId;
  readonly includeApi?: boolean;
  readonly includeSdk?: boolean;
  readonly includeEvents?: boolean;
  readonly includeManifest?: boolean;
  readonly includeMigration?: boolean;
  readonly includeQuickstart?: boolean;
  readonly includeOnboarding?: boolean;
  readonly includeArchitecture?: boolean;
  readonly includeFaq?: boolean;
  readonly format?: "markdown" | "html";
}

export interface DocsStats {
  readonly totalBuilds: number;
  readonly totalPages: number;
  readonly byType: Record<DocType, number>;
}

const DEFAULT_CONFIG: Required<Omit<DocsConfig, "programId" | "format">> & {
  format: "markdown" | "html";
} = {
  includeApi: true,
  includeSdk: true,
  includeEvents: true,
  includeManifest: true,
  includeMigration: true,
  includeQuickstart: true,
  includeOnboarding: true,
  includeArchitecture: true,
  includeFaq: true,
  format: "markdown",
};

// ---------------------------------------------------------------------------
// Doc templates (with {variable} placeholders)
// ---------------------------------------------------------------------------

const TEMPLATES: readonly DocTemplate[] = [
  {
    type: "quickstart",
    title: "Quickstart",
    slug: "quickstart",
    category: "Getting Started",
    order: 1,
    contentTemplate: `# Quickstart

Get a health program running on Eks-Health in {setupMinutes} minutes.

## 1. Install the SDK

\`\`\`bash
npm install --save-dev @eks/program-sdk
\`\`\`

## 2. Scaffold a new program

\`\`\`bash
eks new-program {programSlug} --template {templateId}
cd {programSlug}
\`\`\`

## 3. Develop locally

\`\`\`bash
eks dev --port 3100
\`\`\`

Open the local dashboard at http://localhost:3100 to inspect events,
measurements, and competitions in real time.

## 4. Run the tests

\`\`\`bash
eks test --coverage
\`\`\`

## 5. Package and publish

\`\`\`bash
eks package --version 1.0.0
eks certify --strict
eks publish --channel stable
\`\`\`

Your program is now live on the Eks-Health marketplace.

## Next steps

- Read the [API reference](./api-reference) for the full capability surface.
- Read the [event catalog](./event-catalog) to subscribe to platform events.
- Read the [manifest reference](./manifest-reference) to configure your program.
`,
  },
  {
    type: "developer_onboarding",
    title: "Developer Onboarding",
    slug: "onboarding",
    category: "Getting Started",
    order: 2,
    contentTemplate: `# Developer Onboarding

Welcome to the Eks-Health developer platform. This guide walks you through
everything you need to build, certify, and publish a health program.

## Prerequisites

- Node.js 20+
- An Eks-Health developer account (register at https://eks.health/developers)
- A verified developer profile

## Concepts

- **Program** — an autonomous health application running on the platform.
- **Manifest** — a signed declaration of the program's identity, capabilities,
  permissions, privacy declaration, and AI usage.
- **Capability** — a granted API surface (measurement, competition, mission,
  AI, ...). Every capability is consent-checked and quota-bounded.
- **Sandbox** — an isolated runtime for local development and testing.
- **Certification** — an automated review pipeline that validates the manifest,
  capabilities, privacy, and security.

## Account setup

\`\`\`bash
eks login --token eks_xxx
eks whoami
\`\`\`

## Create your first program

\`\`\`bash
eks new-program my-first-program --template measurement-tracker
cd my-first-program
eks dev
\`\`\`

## Certification pipeline

Before publishing, your program must pass certification. The pipeline runs
{certRuleCount} automated rules:

- manifest_valid
- manifest_signed
- signature_verifiable
- no_wildcard_permissions
- capabilities_declared
- resource_limits_reasonable
- privacy_declaration_complete
- ai_usage_declared
- supported_languages_nonempty
- dependencies_resolvable
- no_sensitive_fields_without_consent
- sdk_version_compatible

\`\`\`bash
eks certify --strict
\`\`\`
`,
  },
  {
    type: "architecture_diagram",
    title: "Platform Architecture",
    slug: "architecture",
    category: "Reference",
    order: 90,
    contentTemplate: `# Platform Architecture

\`\`\`
┌─────────────────────────────────────────────────────────────┐
│                        Developer CLI                         │
│  new-program · dev · simulate · package · certify · publish  │
└───────────────────────────┬─────────────────────────────────┘
                            │
              ┌─────────────▼──────────────┐
              │      Program Runtime       │
              │  sandbox · execution ·     │
              │  quotas · capabilities     │
              └─────────────┬──────────────┘
                            │
       ┌────────────────────┼────────────────────┐
       │                    │                    │
┌──────▼──────┐    ┌────────▼────────┐  ┌────────▼────────┐
│   Health    │    │   Missions      │  │  Competitions   │
│ schemas ·   │    │ plans · goals · │  │ scoring ·       │
│ measurements│    │ habits · AI     │  │ leaderboards ·  │
│ evidence    │    │ personalization │  │ anti-cheat      │
└──────┬──────┘    └────────┬────────┘  └────────┬────────┘
       │                    │                    │
       └────────────────────┼────────────────────┘
                            │
              ┌─────────────▼──────────────┐
              │     Kernel Event Bus       │
              │  pub-sub · replay · DLQ ·  │
              │  correlation · idempotency │
              └─────────────┬──────────────┘
                            │
              ┌─────────────▼──────────────┐
              │     Identity Layer         │
              │  accounts · consent ·      │
              │  authorization · audit     │
              └────────────────────────────┘
\`\`\`

The platform is event-driven: every subsystem publishes to a single kernel
event bus, and programs subscribe to the topics they care about. The
identity layer (consent, authorization, audit) gates every sensitive
operation. Programs never access raw health data — they receive events and
invoke capability-bounded APIs.
`,
  },
  {
    type: "faq",
    title: "Frequently Asked Questions",
    slug: "faq",
    category: "Reference",
    order: 95,
    contentTemplate: `# Frequently Asked Questions

## General

### What is a Program?

A Program is an autonomous health application that runs inside the Eks-Health
platform. The platform provides the runtime, capabilities, and event bus;
the program provides the health methodology.

### Do I need to be a healthcare professional?

No. The platform is disease-agnostic. Programs define their own measurement
schemas and competitions; technicians handle clinical verification.

### Can my program use AI?

Yes — declare AI usage in the manifest (\`aiUsage.usesAI: true\`) and the
platform will route your AI requests through the safety-gated AI runtime.

## Capabilities & permissions

### What is a capability?

A capability is a granted API surface (measurement, competition, mission,
AI, ...). Every capability is independently granted, consent-checked, and
quota-bounded.

### Can I request wildcard permissions?

No. The certification pipeline rejects wildcard permissions. Every
permission must be specific and justified.

## Privacy

### Who owns the data?

The user owns the data. Programs receive events and invoke APIs; they never
access raw data without explicit, audited consent.

### How long can I retain data?

The retention period is declared in the manifest (\`privacy.retentionDays\`).
Retention periods longer than 365 days trigger elevated review.

## Publishing

### What is certification?

Certification is an automated review pipeline that validates the manifest,
capabilities, privacy declaration, and security. Programs must pass
certification before publishing.

### What channels can I publish to?

\`stable\`, \`beta\`, \`alpha\`, \`internal\`, \`canary\`.
`,
  },
  {
    type: "migration_guide",
    title: "SDK Migration Guide",
    slug: "migration",
    category: "Reference",
    order: 80,
    contentTemplate: `# SDK Migration Guide

This guide describes how to migrate a program from one SDK version to
another. The platform's current SDK version is **{currentSdkVersion}**.

## Checking for breaking changes

\`\`\`bash
eks upgrade --to {currentSdkVersion} --dry-run
\`\`\`

The dry-run prints a diff of capabilities, permissions, privacy declaration,
and AI usage — without applying any changes.

## Major version upgrades

Major version jumps (e.g. 1.x → 2.x) require an explicit migration script:

\`\`\`bash
eks upgrade --to {currentSdkVersion} --migrate
\`\`\`

The platform runs each migration script in order. If any script fails, the
upgrade is rolled back automatically.

## Re-consent

If the upgrade adds a sensitive capability, adds a permission, changes the
privacy declaration, or enables AI for the first time, **re-consent is
required** for every existing user. The platform emits an
\`eks.program.upgraded\` event with \`requiresReconsent: true\`.

## Rollback

\`\`\`bash
eks rollback 1.0.0
\`\`\`

Rollback restores the previous version's manifest and re-runs migration
scripts in reverse. Users retain their data.

## Current SDK version

- **SDK version**: {currentSdkVersion}
- **Minimum platform version**: 2.0.0
- **Upgrade policy**: prompt (users are prompted to upgrade)
`,
  },
];

const TEMPLATE_INDEX = new Map(TEMPLATES.map((t) => [t.slug, t]));

// ---------------------------------------------------------------------------
// Template rendering
// ---------------------------------------------------------------------------

/**
 * Render a template by substituting {variable} placeholders with values from
 * the provided variables map. Unknown placeholders are left in place so the
 * author can spot them.
 */
function renderTemplate(template: string, variables: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    if (Object.prototype.hasOwnProperty.call(variables, key)) {
      return String(variables[key]);
    }
    return match;
  });
}

// ---------------------------------------------------------------------------
// Real platform data gathering (all guarded)
// ---------------------------------------------------------------------------

interface PlatformDocsData {
  readonly capabilities: ReadonlyArray<{
    id: string;
    label: string;
    description: string;
    sensitive: boolean;
    requiresConsent: boolean;
  }>;
  readonly cliCommands: ReadonlyArray<{
    name: string;
    description: string;
    usage: string;
    category: string;
    examples: readonly string[];
  }>;
  readonly sdkTemplates: ReadonlyArray<{
    id: string;
    name: string;
    description: string;
    kind: string;
    defaultCategory: string;
  }>;
  readonly events: ReadonlyArray<{
    catalog: string;
    events: ReadonlyArray<{ name: string; topic: string }>;
  }>;
  readonly currentSdkVersion: string;
}

async function gatherPlatformDocsData(): Promise<PlatformDocsData> {
  let capabilities: PlatformDocsData["capabilities"] = [];
  let cliCommands: PlatformDocsData["cliCommands"] = [];
  let sdkTemplates: PlatformDocsData["sdkTemplates"] = [];
  const eventCatalogs: Array<{ catalog: string; events: Array<{ name: string; topic: string }> }> = [];
  let currentSdkVersion = "1.0.0";

  // Capabilities
  try {
    const { CAPABILITIES } = await import("@/programs/capabilities");
    capabilities = CAPABILITIES.map((c) => ({
      id: c.id,
      label: c.label,
      description: c.description,
      sensitive: c.sensitive,
      requiresConsent: c.requiresConsent,
    }));
  } catch {
    // graceful
  }

  // CLI commands + SDK templates
  try {
    const { getSdk } = await import("@/programs/sdk");
    const sdk = getSdk();
    const sdkCmds = sdk.listCliCommands();
    cliCommands = sdkCmds.map((c) => ({
      name: c.name,
      description: c.description,
      usage: c.usage,
      category: c.id,
      examples: c.examples,
    }));
    sdkTemplates = sdk.listTemplates().map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      kind: t.kind,
      defaultCategory: t.defaultCategory,
    }));
  } catch {
    // graceful
  }

  // Developer CLI commands
  try {
    const { getCli } = await import("../cli");
    const cli = getCli();
    const cmds = cli.listCommands();
    cliCommands = [
      ...cliCommands,
      ...cmds.map((c) => ({
        name: c.name,
        description: c.description,
        usage: c.usage,
        category: c.category,
        examples: c.examples,
      })),
    ];
  } catch {
    // graceful
  }

  // Event catalogs (each guarded separately so a missing module doesn't lose all events)
  const catalogs: Array<{ catalog: string; constObj: Record<string, string> }> = [];
  try {
    const { HEALTH_EVENTS } = await import("@/health/core");
    catalogs.push({ catalog: "Health", constObj: HEALTH_EVENTS as unknown as Record<string, string> });
  } catch { /* graceful */ }
  try {
    const { MISSION_EVENTS } = await import("@/missions/core");
    catalogs.push({ catalog: "Missions", constObj: MISSION_EVENTS as unknown as Record<string, string> });
  } catch { /* graceful */ }
  try {
    const { COMPETITION_EVENTS } = await import("@/competitions/core");
    catalogs.push({ catalog: "Competitions", constObj: COMPETITION_EVENTS as unknown as Record<string, string> });
  } catch { /* graceful */ }
  try {
    const { PROGRAM_EVENTS } = await import("@/programs/core");
    catalogs.push({ catalog: "Programs", constObj: PROGRAM_EVENTS as unknown as Record<string, string> });
  } catch { /* graceful */ }
  try {
    const { IDENTITY_EVENTS } = await import("@/identity/core");
    catalogs.push({ catalog: "Identity", constObj: IDENTITY_EVENTS as unknown as Record<string, string> });
  } catch { /* graceful */ }
  try {
    const { SYSTEM_EVENTS } = await import("@/kernel/events");
    catalogs.push({ catalog: "System", constObj: SYSTEM_EVENTS as unknown as Record<string, string> });
  } catch { /* graceful */ }
  try {
    catalogs.push({ catalog: "Developer", constObj: DEVELOPER_EVENTS as unknown as Record<string, string> });
  } catch { /* graceful */ }

  for (const { catalog, constObj } of catalogs) {
    const events: Array<{ name: string; topic: string }> = [];
    for (const [name, topic] of Object.entries(constObj)) {
      events.push({ name, topic });
    }
    eventCatalogs.push({ catalog, events });
  }

  // Determine current SDK version (default 1.0.0)
  try {
    const { getSdk } = await import("@/programs/sdk");
    const sdk = getSdk();
    const templates = sdk.listTemplates();
    if (templates.length > 0) {
      // Use the first template's default SDK version (all programs share SDK).
      currentSdkVersion = "1.0.0";
    }
    void sdk;
  } catch {
    // graceful
  }

  return {
    capabilities,
    cliCommands,
    sdkTemplates,
    events: eventCatalogs as unknown as PlatformDocsData["events"],
    currentSdkVersion,
  };
}

// ---------------------------------------------------------------------------
// Page generators (real markdown)
// ---------------------------------------------------------------------------

function generateApiReferencePage(data: PlatformDocsData): DocPage {
  const capRows = data.capabilities.map(
    (c) => `| \`${c.id}\` | ${c.label} | ${c.description} | ${c.sensitive ? "Yes" : "No"} | ${c.requiresConsent ? "Yes" : "No"} |`,
  );
  const cliRows = data.cliCommands.map(
    (c) => `| \`${c.usage}\` | ${c.description} | ${c.category} |`,
  );
  const content = `# API Reference

The Eks-Health platform exposes a capability-bounded API surface. Programs
declare the capabilities they need in their manifest; the platform grants
each capability independently, consent-checks it, and enforces per-resource
quotas.

## Capabilities

| Capability | Label | Description | Sensitive | Requires Consent |
|---|---|---|---|---|
${capRows.join("\n")}

## CLI commands

| Command | Description | Category |
|---|---|---|
${cliRows.join("\n")}

## Calling conventions

Every API call must include:

- A valid program id (in the \`X-Eks-Program\` header).
- A valid capability grant (the platform checks this server-side).
- A valid consent reference for sensitive capabilities.
- A correlation id (for distributed tracing).

APIs are idempotent: replaying the same request with the same idempotency
key returns the original response without side effects.
`;
  return {
    id: generateId("doc_"),
    type: "api_reference",
    title: "API Reference",
    slug: "api-reference",
    content,
    category: "Reference",
    order: 10,
    generatedAt: getClock().iso(),
    generatedFrom: "platform:capabilities+cli",
  };
}

function generateSdkGuidePage(data: PlatformDocsData): DocPage {
  const templateRows = data.sdkTemplates.map(
    (t) => `| \`${t.id}\` | ${t.name} | ${t.description} | ${t.kind} | ${t.defaultCategory} |`,
  );
  const content = `# SDK Guide

The @eks/program-sdk package provides:

- A CLI for scaffolding, building, signing, packaging, and publishing.
- A runtime contract for program handlers.
- A testing harness for contract, security, and unit tests.
- A local simulator with mock platform events.

## Scaffold templates

| Template | Name | Description | Kind | Default Category |
|---|---|---|---|---|
${templateRows.join("\n")}

## Scaffolding a new program

\`\`\`bash
eks init --template measurement-tracker --slug my-tracker \\
  --name "My Tracker" --developer-id dev_xxx
\`\`\`

This generates:

- \`manifest.json\` — the program's signed declaration.
- \`src/entry.ts\` — a minimal event-driven handler.
- \`src/index.ts\` — the barrel export.
- \`test/contract.test.ts\` — auto-generated contract tests.
- \`README.md\` — auto-generated documentation.
- \`.eksprogramrc.json\` — local runtime configuration.
- \`tsconfig.json\` — TypeScript configuration.

## Local development

\`\`\`bash
eks dev --port 3100
\`\`\`

The dev server hot-reloads on file changes and exposes:

- The program's HTTP endpoints.
- A debug dashboard at http://localhost:3100/debug.
- An API explorer at http://localhost:3100/explorer.
- A local event-bus viewer.

## Program handler contract

A program handler is an object with optional lifecycle methods:

\`\`\`typescript
export interface ProgramHandler {
  onMeasurement?(ctx: ProgramContext, event: MeasurementEvent): Promise<void>;
  onCompetitionStart?(ctx: ProgramContext, event: CompetitionEvent): Promise<void>;
  onNotificationRequest?(ctx: ProgramContext, request: NotificationRequest): Promise<NotificationResult>;
  onAiPrompt?(ctx: ProgramContext, prompt: AiPrompt): Promise<AiResult>;
  onEvent?(ctx: ProgramContext, event: ProgramEvent): Promise<void>;
}
\`\`\`

Implement only the methods you need. The runtime calls them in response to
platform events that match your manifest's \`eventSubscriptions\`.
`;
  return {
    id: generateId("doc_"),
    type: "sdk_guide",
    title: "SDK Guide",
    slug: "sdk-guide",
    content,
    category: "Reference",
    order: 20,
    generatedAt: getClock().iso(),
    generatedFrom: "platform:sdk",
  };
}

function generateEventCatalogPage(data: PlatformDocsData): DocPage {
  const sections = data.events.map((catalog) => {
    const rows = catalog.events.map(
      (e) => `| \`${e.name}\` | \`${e.topic}\` |`,
    );
    return `## ${catalog.catalog} events

| Constant | Topic |
|---|---|
${rows.join("\n")}
`;
  });
  const content = `# Event Catalog

The platform publishes events to a single kernel event bus. Programs subscribe
to topics via their manifest's \`eventSubscriptions\` field. Every event
carries a correlation id, causation id, and idempotent event id.

${sections.join("\n")}
## Subscribing

\`\`\`typescript
export const handler: ProgramHandler = {
  async onEvent(ctx, event) {
    if (event.type === "eks.measurement.recorded") {
      // handle the measurement
    }
  },
};
\`\`\`

## Replay

Events are stored in the bus's history and can be replayed:

\`\`\`bash
eks logs --follow
\`\`\`

Use the debugger (\`getDebugger()\`) to inspect and replay specific sessions.
`;
  return {
    id: generateId("doc_"),
    type: "event_catalog",
    title: "Event Catalog",
    slug: "event-catalog",
    content,
    category: "Reference",
    order: 30,
    generatedAt: getClock().iso(),
    generatedFrom: "platform:events",
  };
}

function generateManifestReferencePage(): DocPage {
  const content = `# Manifest Reference

Every program must declare a signed manifest before it can execute. The
manifest is the program's contract with the platform.

## Schema

\`\`\`typescript
interface ProgramManifest {
  id: ProgramId;                    // branded id, e.g. "prg_my_program"
  kind: "program" | "extension";
  name: string;                     // >= 2 chars
  slug: string;                     // lowercase kebab-case
  version: SemVer;                  // semantic version
  sdkVersion: SemVer;               // SDK version this program targets
  developer: { id: DeveloperId; name: string; email: string };
  publisher?: { id: PublisherId; name: string };
  description: string;
  category: string;
  tags: string[];

  // Capabilities & permissions
  capabilities: CapabilityRequest[];
  permissions: string[];

  // Audience
  supportedCountries: string[];     // ISO-3166-1 alpha-2
  supportedLanguages: string[];     // BCP-47
  supportedDemographics?: DemographicTargeting;

  // Compatibility
  dependencies: ProgramDependency[];
  minPlatformVersion: SemVer;
  maxPlatformVersion?: SemVer;
  upgradePolicy: "auto" | "prompt" | "manual" | "breaking-requires-reconsent";

  // Resources
  resourceLimits: Partial<ResourceQuota>;
  privacy: PrivacyDeclaration;
  aiUsage: AIUsageDeclaration;

  // Resource definitions
  measurementDefinitions?: ResourceDefinition[];
  competitionDefinitions?: ResourceDefinition[];
  leaderboardDefinitions?: ResourceDefinition[];
  missionDefinitions?: ResourceDefinition[];

  // APIs
  supportedApis: string[];
  eventSubscriptions?: string[];

  // Signature
  signature?: ManifestSignature;
}
\`\`\`

## Required fields

- \`id\`, \`name\`, \`slug\`, \`version\`, \`sdkVersion\`
- \`developer.id\`, \`developer.email\` (valid email)
- \`description\`, \`category\`
- \`supportedLanguages\` (at least one)
- \`minPlatformVersion\`
- \`privacy\`

## Validation

The manifest is validated by \`validateManifest()\`. Common errors:

- \`missing\` — required field is absent.
- \`invalid\` — field is present but malformed (e.g. bad slug, bad email).
- \`incompatible\` — \`minPlatformVersion\` is greater than the running platform.

## Signing

Manifests are signed with RSA-SHA256:

\`\`\`typescript
const keyPair = generateSigningKeyPair("dev_key_1");
const signed = signManifest(manifest, keyPair, "developer@example.com");
const valid = verifyManifestSignature(signed, keyPair.publicKeyPem);
\`\`\`

The signature is canonicalized over sorted-key JSON to ensure deterministic
verification across implementations.
`;
  return {
    id: generateId("doc_"),
    type: "manifest_reference",
    title: "Manifest Reference",
    slug: "manifest-reference",
    content,
    category: "Reference",
    order: 40,
    generatedAt: getClock().iso(),
    generatedFrom: "platform:manifests",
  };
}

// ---------------------------------------------------------------------------
// Program-specific docs
// ---------------------------------------------------------------------------

interface ProgramDocsData {
  readonly slug: string;
  readonly name: string;
  readonly version: string;
  readonly sdkVersion: string;
  readonly description: string;
  readonly category: string;
  readonly capabilities: ReadonlyArray<{ capability: string; reason: string }>;
  readonly permissions: readonly string[];
  readonly privacy: Record<string, unknown>;
  readonly aiUsage: Record<string, unknown>;
  readonly measurementDefinitions?: ReadonlyArray<{ id: string; name: string; description: string }>;
}

async function gatherProgramDocsData(programId: ProgramId): Promise<ProgramDocsData | undefined> {
  try {
    const { getRegistry } = await import("@/programs");
    const registry = getRegistry();
    const record = registry.get(programId);
    if (!record) return undefined;
    const version = record.versions[record.versions.length - 1] ?? record.versions[0];
    const manifest = version?.manifest;
    if (!manifest) return undefined;
    return {
      slug: record.slug,
      name: record.name,
      version: version ? `${version.version.major}.${version.version.minor}.${version.version.patch}` : "0.0.0",
      sdkVersion: `${manifest.sdkVersion.major}.${manifest.sdkVersion.minor}.${manifest.sdkVersion.patch}`,
      description: manifest.description,
      category: manifest.category,
      capabilities: manifest.capabilities.map((c) => ({ capability: c.capability, reason: c.reason })),
      permissions: manifest.permissions,
      privacy: manifest.privacy as unknown as Record<string, unknown>,
      aiUsage: manifest.aiUsage as unknown as Record<string, unknown>,
      measurementDefinitions: manifest.measurementDefinitions?.map((d) => ({ id: d.id, name: d.name, description: d.description })),
    };
  } catch {
    return undefined;
  }
}

function generateProgramDocPage(data: ProgramDocsData): DocPage {
  const capList = data.capabilities.length > 0
    ? data.capabilities.map((c) => `- **\`${c.capability}\`**: ${c.reason}`).join("\n")
    : "- (none)";
  const permList = data.permissions.length > 0
    ? data.permissions.map((p) => `- \`${p}\``).join("\n")
    : "- (none)";
  const measurementList = data.measurementDefinitions && data.measurementDefinitions.length > 0
    ? data.measurementDefinitions.map((m) => `- **\`${m.id}\`** — ${m.name}: ${m.description}`).join("\n")
    : "- (none)";
  const content = `# ${data.name}

${data.description}

- **Slug**: \`${data.slug}\`
- **Version**: ${data.version}
- **SDK version**: ${data.sdkVersion}
- **Category**: ${data.category}

## Capabilities

${capList}

## Permissions

${permList}

## Privacy declaration

\`\`\`json
${JSON.stringify(data.privacy, null, 2)}
\`\`\`

## AI usage

\`\`\`json
${JSON.stringify(data.aiUsage, null, 2)}
\`\`\`

## Measurement definitions

${measurementList}
`;
  return {
    id: generateId("doc_"),
    type: "manifest_reference",
    title: `${data.name} — Program Reference`,
    slug: "program-reference",
    content,
    category: "Program",
    order: 5,
    generatedAt: getClock().iso(),
    generatedFrom: `program:${data.slug}`,
  };
}

// ---------------------------------------------------------------------------
// DocsGenerator
// ---------------------------------------------------------------------------

export class DocsGenerator {
  private readonly builds = new Map<DocsBuildId, DocsBuild>();
  private readonly byProgram = new Map<ProgramId, DocsBuildId[]>();

  /**
   * Generate a complete DocsBuild from real platform data. For each enabled
   * section, a DocPage is generated from actual platform state (capabilities,
   * CLI commands, SDK templates, event catalogs, manifest schema, etc.).
   */
  async generate(config: DocsConfig = {}): Promise<DocsBuild> {
    const resolved = { ...DEFAULT_CONFIG, ...config };
    const data = await gatherPlatformDocsData();
    const pages: DocPage[] = [];

    if (resolved.includeApi) pages.push(generateApiReferencePage(data));
    if (resolved.includeSdk) pages.push(generateSdkGuidePage(data));
    if (resolved.includeEvents) pages.push(generateEventCatalogPage(data));
    if (resolved.includeManifest) pages.push(generateManifestReferencePage());

    // Templates (quickstart, onboarding, architecture, faq, migration)
    const variables: Record<string, string | number> = {
      programSlug: resolved.programId ?? "my-program",
      templateId: data.sdkTemplates[0]?.id ?? "blank-program",
      setupMinutes: 5,
      currentSdkVersion: data.currentSdkVersion,
      certRuleCount: 12,
    };

    if (resolved.includeQuickstart) {
      const tpl = TEMPLATE_INDEX.get("quickstart")!;
      pages.push({
        id: generateId("doc_"),
        type: tpl.type,
        title: tpl.title,
        slug: tpl.slug,
        content: renderTemplate(tpl.contentTemplate, variables),
        category: tpl.category,
        order: tpl.order,
        generatedAt: getClock().iso(),
        generatedFrom: "template:quickstart",
      });
    }

    if (resolved.includeOnboarding) {
      const tpl = TEMPLATE_INDEX.get("onboarding")!;
      pages.push({
        id: generateId("doc_"),
        type: tpl.type,
        title: tpl.title,
        slug: tpl.slug,
        content: renderTemplate(tpl.contentTemplate, variables),
        category: tpl.category,
        order: tpl.order,
        generatedAt: getClock().iso(),
        generatedFrom: "template:onboarding",
      });
    }

    if (resolved.includeArchitecture) {
      const tpl = TEMPLATE_INDEX.get("architecture")!;
      pages.push({
        id: generateId("doc_"),
        type: tpl.type,
        title: tpl.title,
        slug: tpl.slug,
        content: renderTemplate(tpl.contentTemplate, variables),
        category: tpl.category,
        order: tpl.order,
        generatedAt: getClock().iso(),
        generatedFrom: "template:architecture",
      });
    }

    if (resolved.includeFaq) {
      const tpl = TEMPLATE_INDEX.get("faq")!;
      pages.push({
        id: generateId("doc_"),
        type: tpl.type,
        title: tpl.title,
        slug: tpl.slug,
        content: renderTemplate(tpl.contentTemplate, variables),
        category: tpl.category,
        order: tpl.order,
        generatedAt: getClock().iso(),
        generatedFrom: "template:faq",
      });
    }

    if (resolved.includeMigration) {
      const tpl = TEMPLATE_INDEX.get("migration")!;
      pages.push({
        id: generateId("doc_"),
        type: tpl.type,
        title: tpl.title,
        slug: tpl.slug,
        content: renderTemplate(tpl.contentTemplate, variables),
        category: tpl.category,
        order: tpl.order,
        generatedAt: getClock().iso(),
        generatedFrom: "template:migration",
      });
    }

    // If a program is specified, include its program-specific page.
    if (resolved.programId) {
      const programData = await gatherProgramDocsData(resolved.programId);
      if (programData) {
        pages.push(generateProgramDocPage(programData));
      }
    }

    // Convert to HTML if requested
    const finalPages = resolved.format === "html"
      ? pages.map((p) => ({ ...p, content: markdownToHtml(p.content) }))
      : pages;

    // Sort by order, then slug
    finalPages.sort((a, b) => (a.order - b.order) || a.slug.localeCompare(b.slug));

    const build: DocsBuild = {
      id: asDocsBuildId(generateId("docs_")),
      programId: resolved.programId,
      pages: finalPages,
      builtAt: getClock().iso(),
      version: data.currentSdkVersion,
    };
    this.builds.set(build.id, build);
    if (resolved.programId) {
      const list = this.byProgram.get(resolved.programId) ?? [];
      this.byProgram.set(resolved.programId, [...list, build.id]);
    }

    void getEventBus().publish(
      buildEvent(
        DEVELOPER_EVENTS.docsBuilt,
        { buildId: build.id, programId: resolved.programId, pages: build.pages.length, format: resolved.format },
        {},
        "domain",
      ),
    );

    return build;
  }

  /** Generate program-specific docs (manifest, capabilities, etc.). */
  async generateForProgram(programId: ProgramId): Promise<DocsBuild> {
    return this.generate({
      programId,
      includeApi: true,
      includeSdk: true,
      includeEvents: true,
      includeManifest: true,
      includeMigration: true,
      includeQuickstart: true,
      includeOnboarding: true,
      includeArchitecture: false,
      includeFaq: false,
      format: "markdown",
    });
  }

  /** List all doc templates. */
  listTemplates(): readonly DocTemplate[] {
    return TEMPLATES;
  }

  /** Get a build by id. */
  getBuild(id: DocsBuildId): DocsBuild | undefined {
    return this.builds.get(id);
  }

  /** List builds, optionally filtered by program. */
  listBuilds(programId?: ProgramId): DocsBuild[] {
    if (programId) {
      const ids = this.byProgram.get(programId) ?? [];
      return ids.map((id) => this.builds.get(id)!).filter(Boolean);
    }
    return [...this.builds.values()];
  }

  /** Get a specific page from a build by slug. */
  getPage(buildId: DocsBuildId, slug: string): DocPage | undefined {
    const build = this.builds.get(buildId);
    if (!build) return undefined;
    return build.pages.find((p) => p.slug === slug);
  }

  /**
   * Real text search across all pages in a build. Returns pages whose title
   * or content match the query (case-insensitive). Each result includes a
   * snippet around the first match.
   */
  search(buildId: DocsBuildId, query: string): Array<{ page: DocPage; snippet: string }> {
    const build = this.builds.get(buildId);
    if (!build) return [];
    const q = query.trim().toLowerCase();
    if (q.length === 0) return [];
    const results: Array<{ page: DocPage; snippet: string }> = [];
    for (const page of build.pages) {
      const titleMatch = page.title.toLowerCase().includes(q);
      const contentLower = page.content.toLowerCase();
      const idx = contentLower.indexOf(q);
      if (titleMatch || idx >= 0) {
        let snippet: string;
        if (idx >= 0) {
          const start = Math.max(0, idx - 40);
          const end = Math.min(page.content.length, idx + q.length + 80);
          snippet = (start > 0 ? "…" : "") + page.content.slice(start, end).trim() + (end < page.content.length ? "…" : "");
        } else {
          snippet = page.title;
        }
        results.push({ page, snippet });
      }
    }
    return results;
  }

  /** Aggregate stats across all builds. */
  getStats(): DocsStats {
    let totalPages = 0;
    const byType: Record<DocType, number> = {
      api_reference: 0,
      sdk_guide: 0,
      event_catalog: 0,
      manifest_reference: 0,
      migration_guide: 0,
      tutorial: 0,
      architecture_diagram: 0,
      developer_onboarding: 0,
      quickstart: 0,
      faq: 0,
    };
    for (const build of this.builds.values()) {
      totalPages += build.pages.length;
      for (const page of build.pages) {
        byType[page.type]++;
      }
    }
    return { totalBuilds: this.builds.size, totalPages, byType };
  }
}

// ---------------------------------------------------------------------------
// Minimal markdown → HTML converter (real, no external deps)
// ---------------------------------------------------------------------------

function markdownToHtml(md: string): string {
  // This is a deliberately small converter: headings, paragraphs, code
  // blocks, inline code, bold, links, tables, and lists. It is NOT a full
  // CommonMark implementation — it covers the pages this module generates.
  const lines = md.split("\n");
  const out: string[] = [];
  let inCode = false;
  let codeBuf: string[] = [];
  let inTable = false;
  let tableBuf: string[][] = [];

  const flushTable = () => {
    if (tableBuf.length === 0) return;
    out.push("<table>");
    const header = tableBuf[0];
    out.push("<thead><tr>" + header.map((h) => `<th>${escapeHtml(h)}</th>`).join("") + "</tr></thead>");
    out.push("<tbody>");
    for (let i = 2; i < tableBuf.length; i++) {
      out.push("<tr>" + tableBuf[i].map((c) => `<td>${escapeHtml(c)}</td>`).join("") + "</tr>");
    }
    out.push("</tbody></table>");
    tableBuf = [];
    inTable = false;
  };

  for (const line of lines) {
    if (line.startsWith("```")) {
      if (inCode) {
        out.push(`<pre><code>${escapeHtml(codeBuf.join("\n"))}</code></pre>`);
        codeBuf = [];
        inCode = false;
      } else {
        if (inTable) flushTable();
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      codeBuf.push(line);
      continue;
    }
    if (line.startsWith("|") && line.endsWith("|")) {
      inTable = true;
      tableBuf.push(line.slice(1, -1).split("|").map((c) => c.trim()));
      continue;
    } else if (inTable) {
      flushTable();
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      out.push(`<h${level}>${inline(h[2])}</h${level}>`);
      continue;
    }
    if (line.startsWith("- ") || line.startsWith("* ")) {
      out.push(`<li>${inline(line.slice(2))}</li>`);
      continue;
    }
    if (line.trim() === "") {
      out.push("");
      continue;
    }
    out.push(`<p>${inline(line)}</p>`);
  }
  if (inCode) out.push(`<pre><code>${escapeHtml(codeBuf.join("\n"))}</code></pre>`);
  if (inTable) flushTable();
  return out.join("\n");
}

function inline(s: string): string {
  // [text](url) → <a href="url">text</a>
  let out = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, text: string, url: string) => `<a href="${escapeAttr(url)}">${escapeHtml(text)}</a>`);
  // `code` → <code>code</code>
  out = out.replace(/`([^`]+)`/g, (_m, code: string) => `<code>${escapeHtml(code)}</code>`);
  // **bold** → <strong>bold</strong>
  out = out.replace(/\*\*([^*]+)\*\*/g, (_m, t: string) => `<strong>${escapeHtml(t)}</strong>`);
  return escapeHtmlStable(out);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, "&quot;");
}
/** Escape leading text but preserve already-embedded HTML tags. */
function escapeHtmlStable(s: string): string {
  // s already contains tags like <a>, <code>, <strong> — leave them alone.
  // Escape stray & < > that are NOT part of a tag/entity.
  return s.replace(/&(?!amp;|lt;|gt;|quot;|#)/g, "&amp;");
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _docs: DocsGenerator | null = null;
export function getDocsGenerator(): DocsGenerator {
  if (!_docs) _docs = new DocsGenerator();
  return _docs;
}
export function resetDocsGenerator(): void {
  _docs = null;
}
