/**
 * Eks-Health Program OS — Extension SDK
 *
 * The production SDK architecture: CLI command catalog, project scaffolding,
 * manifest generation, packaging, signing, contract validation, local runtime
 * config, documentation generation, upgrade simulation.
 *
 * This is the SDK CONTRACT + scaffolding logic that the platform uses to
 * validate, package, and document Programs. It is NOT a published npm package
 * — it is the server-side authority on what a valid Program project looks like.
 */

import "server-only";
import { createHash } from "node:crypto";
import {
  type ProgramId,
  type PackageId,
  type DeveloperId,
  type CapabilityId,
  type SemVer,
  type ResourceQuota,
  type PrivacyDeclaration,
  type AIUsageDeclaration,
  type ResourceDefinition,
  ProgramError,
  asPackageId,
  compareSemVer,
  semVerToString,
  parseSemVer,
} from "../core";
import type {
  ProgramManifest,
  ProgramDependency,
  CapabilityRequest,
  ManifestSignature,
  ManifestBuilderInput,
  SigningKeyPair,
} from "../manifests";
import {
  buildManifest,
  manifestFingerprint,
  signManifest,
  generateSigningKeyPair,
} from "../manifests";
import { CAPABILITIES, getCapability } from "../capabilities";
import { getEventBus, buildEvent, generateId, getClock } from "@/kernel";

// ---------------------------------------------------------------------------
// SDK types
// ---------------------------------------------------------------------------

export type SdkCommand =
  | "init"
  | "build"
  | "sign"
  | "test"
  | "package"
  | "publish"
  | "simulate"
  | "docs"
  | "upgrade-check";

export interface CliCommand {
  readonly id: SdkCommand;
  readonly name: string;
  readonly description: string;
  readonly usage: string;
  readonly args: readonly string[];
  readonly examples: readonly string[];
}

export interface CliResult {
  readonly command: SdkCommand;
  readonly ok: boolean;
  readonly message: string;
  readonly output?: unknown;
  readonly durationMs: number;
}

export interface ScaffoldInput {
  readonly templateId: string;
  readonly slug: string;
  readonly name: string;
  readonly developerId: string;
  readonly developerName: string;
  readonly developerEmail: string;
  readonly version?: string;
  readonly description?: string;
  readonly category?: string;
  readonly signingKey?: SigningKeyPair;
}

export interface ProjectFile {
  readonly path: string;
  readonly content: string;
}

export interface ProjectStructure {
  readonly rootPath: string;
  readonly files: ProjectFile[];
  readonly manifest: ProgramManifest;
  readonly templateId: string;
}

export interface ScaffoldResult {
  readonly template: ScaffoldTemplate;
  readonly manifest: ProgramManifest;
  readonly project: ProjectStructure;
}

export interface ScaffoldTemplate {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly kind: "program" | "extension";
  readonly defaultCategory: string;
  readonly defaultCapabilities: CapabilityRequest[];
  readonly defaultResourceLimits?: Partial<ResourceQuota>;
  readonly defaultPrivacy?: PrivacyDeclaration;
  readonly defaultAiUsage?: AIUsageDeclaration;
  readonly defaultDependencies?: ProgramDependency[];
  readonly defaultMeasurementDefinitions?: ResourceDefinition[];
}

export interface PackageFileEntry {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
}

export interface PackageOutput {
  readonly packageId: PackageId;
  readonly manifest: ProgramManifest;
  readonly fingerprint: string;
  readonly signature?: ManifestSignature;
  readonly files: PackageFileEntry[];
  readonly packagedAt: string;
  readonly totalBytes: number;
}

export interface LocalRuntimeConfig {
  readonly port: number;
  readonly hotReload: boolean;
  readonly mockPlatform: boolean;
  readonly logLevel: "debug" | "info" | "warn" | "error";
  readonly dataDir: string;
}

export interface ContractValidationResult {
  readonly valid: boolean;
  readonly errors: ContractIssue[];
  readonly warnings: ContractIssue[];
}

export interface ContractIssue {
  readonly field: string;
  readonly code: string;
  readonly message: string;
}

export interface UpgradeSimulation {
  readonly addedCapabilities: CapabilityId[];
  readonly removedCapabilities: CapabilityId[];
  readonly addedPermissions: string[];
  readonly removedPermissions: string[];
  readonly privacyChanges: string[];
  readonly aiUsageChanges: string[];
  readonly resourceLimitChanges: string[];
  readonly requiresReconsent: boolean;
  readonly isBreaking: boolean;
}

// ---------------------------------------------------------------------------
// Default templates
// ---------------------------------------------------------------------------

const DEFAULT_PRIVACY: PrivacyDeclaration = {
  dataCollected: [],
  dataUsage: "No personal data collected.",
  thirdPartySharing: false,
  retentionDays: 90,
  anonymizationApplied: true,
  residencyRegions: ["*"],
};

const TEMPLATES: ScaffoldTemplate[] = [
  {
    id: "blank-program",
    name: "Blank Program",
    description: "A minimal program with no capabilities. Good starting point.",
    kind: "program",
    defaultCategory: "utility",
    defaultCapabilities: [],
    defaultResourceLimits: {},
    defaultPrivacy: DEFAULT_PRIVACY,
    defaultAiUsage: { usesAI: false },
  },
  {
    id: "measurement-tracker",
    name: "Measurement Tracker",
    description: "Track a health measurement (e.g. steps, weight, blood pressure).",
    kind: "program",
    defaultCategory: "wellness",
    defaultCapabilities: [
      {
        capability: "measurement",
        reason: "Record and display the tracked measurement.",
        purposes: ["health-tracking"],
        scope: "self",
      },
      {
        capability: "notification",
        reason: "Remind the user to log measurements.",
        scope: "self",
      },
    ],
    defaultResourceLimits: { storageMb: 25 },
    defaultPrivacy: {
      dataCollected: ["measurement_value", "timestamp"],
      dataUsage: "Display trends to the user.",
      thirdPartySharing: false,
      retentionDays: 365,
      anonymizationApplied: true,
      residencyRegions: ["*"],
    },
    defaultAiUsage: { usesAI: false },
    defaultMeasurementDefinitions: [
      {
        id: "primary_metric",
        type: "measurement",
        name: "Primary Metric",
        description: "The main measurement tracked by this program.",
        schema: { type: "number", unit: "count" },
        unit: "count",
        privacyLevel: "confidential",
      },
    ],
  },
  {
    id: "competition-program",
    name: "Competition Program",
    description: "Run a health competition with leaderboards and missions.",
    kind: "program",
    defaultCategory: "engagement",
    defaultCapabilities: [
      {
        capability: "competition",
        reason: "Create and manage competitions.",
        purposes: ["engagement"],
        scope: "participant",
      },
      {
        capability: "leaderboard",
        reason: "Display competition rankings.",
        purposes: ["engagement"],
        scope: "cohort",
      },
      {
        capability: "mission",
        reason: "Define missions for participants.",
        scope: "participant",
      },
      {
        capability: "notification",
        reason: "Notify participants of competition updates.",
        scope: "participant",
      },
    ],
    defaultResourceLimits: { apiRequestsPerMinute: 120 },
    defaultPrivacy: {
      dataCollected: ["participant_id", "score"],
      dataUsage: "Compute competition rankings.",
      thirdPartySharing: false,
      retentionDays: 180,
      anonymizationApplied: true,
      residencyRegions: ["*"],
    },
    defaultAiUsage: { usesAI: false },
  },
  {
    id: "ai-assistant",
    name: "AI Assistant",
    description: "An AI-powered health assistant program.",
    kind: "program",
    defaultCategory: "ai",
    defaultCapabilities: [
      {
        capability: "ai",
        reason: "Generate health coaching responses.",
        purposes: ["health-coaching"],
        scope: "self",
      },
      {
        capability: "profile",
        reason: "Personalize AI responses with profile context.",
        purposes: ["personalization"],
        fields: ["age_range", "goals"],
        scope: "self",
      },
      {
        capability: "notification",
        reason: "Deliver AI-generated insights.",
        scope: "self",
      },
    ],
    defaultResourceLimits: { aiRequestsPerDay: 200 },
    defaultPrivacy: {
      dataCollected: ["conversation_history", "profile_context"],
      dataUsage: "Generate personalized health coaching.",
      thirdPartySharing: false,
      retentionDays: 30,
      anonymizationApplied: false,
      residencyRegions: ["*"],
    },
    defaultAiUsage: {
      usesAI: true,
      provider: "eks-ai",
      modelFamily: "glm",
      purpose: "Generate personalized health coaching responses.",
      trainingDataUsed: false,
      humanReadableExplanation:
        "This program uses AI to generate conversational health coaching. No data is used for training.",
    },
  },
  {
    id: "marketplace-extension",
    name: "Marketplace Extension",
    description: "An extension that augments the platform marketplace.",
    kind: "extension",
    defaultCategory: "marketplace",
    defaultCapabilities: [
      {
        capability: "search",
        reason: "Index marketplace listings.",
        scope: "all",
      },
      {
        capability: "storage",
        reason: "Cache extension metadata.",
        scope: "self",
      },
    ],
    defaultResourceLimits: { searchIndexingDocs: 5000 },
    defaultPrivacy: DEFAULT_PRIVACY,
    defaultAiUsage: { usesAI: false },
  },
];

const TEMPLATE_INDEX = new Map(TEMPLATES.map((t) => [t.id, t]));

// ---------------------------------------------------------------------------
// CLI command catalog
// ---------------------------------------------------------------------------

const CLI_COMMANDS: CliCommand[] = [
  {
    id: "init",
    name: "init",
    description: "Scaffold a new program project from a template.",
    usage: "eks init --template <template-id> --slug <slug>",
    args: ["--template", "--slug", "--name", "--developer-id"],
    examples: ["eks init --template measurement-tracker --slug my-tracker"],
  },
  {
    id: "build",
    name: "build",
    description: "Compile and validate the program manifest.",
    usage: "eks build",
    args: ["--manifest"],
    examples: ["eks build --manifest ./manifest.json"],
  },
  {
    id: "sign",
    name: "sign",
    description: "Cryptographically sign the program manifest.",
    usage: "eks sign --key <key-pem> --manifest <manifest.json>",
    args: ["--key", "--manifest", "--key-id"],
    examples: ["eks sign --key ./dev.pem --manifest ./manifest.json"],
  },
  {
    id: "test",
    name: "test",
    description: "Run the program's test suite (unit, contract, security).",
    usage: "eks test",
    args: ["--category", "--watch"],
    examples: ["eks test --category contract"],
  },
  {
    id: "package",
    name: "package",
    description: "Package the program into a deployable bundle.",
    usage: "eks package --project <path> --out <bundle.ekspkg>",
    args: ["--project", "--out", "--sign"],
    examples: ["eks package --project ./my-program --out ./bundle.ekspkg"],
  },
  {
    id: "publish",
    name: "publish",
    description: "Publish the packaged program to the platform.",
    usage: "eks publish --package <bundle.ekspkg>",
    args: ["--package", "--channel"],
    examples: ["eks publish --package ./bundle.ekspkg --channel beta"],
  },
  {
    id: "simulate",
    name: "simulate",
    description: "Simulate the program in a local runtime with mock platform.",
    usage: "eks simulate --project <path>",
    args: ["--project", "--port"],
    examples: ["eks simulate --project ./my-program --port 3001"],
  },
  {
    id: "docs",
    name: "docs",
    description: "Generate documentation from the manifest.",
    usage: "eks docs --manifest <manifest.json> --out <docs.md>",
    args: ["--manifest", "--out"],
    examples: ["eks docs --manifest ./manifest.json --out ./README.md"],
  },
  {
    id: "upgrade-check",
    name: "upgrade-check",
    description: "Check what changes an upgrade would introduce.",
    usage: "eks upgrade-check --current <current.json> --new <new.json>",
    args: ["--current", "--new"],
    examples: ["eks upgrade-check --current v1.json --new v2.json"],
  },
];

// ---------------------------------------------------------------------------
// SDK Manager
// ---------------------------------------------------------------------------

export class SdkManager {
  private readonly projects = new Map<string, ProjectStructure>();
  private readonly defaultRuntimeConfig: LocalRuntimeConfig = {
    port: 3001,
    hotReload: true,
    mockPlatform: true,
    logLevel: "info",
    dataDir: "./.eks-local",
  };

  // ---- Templates --------------------------------------------------------

  listTemplates(): readonly ScaffoldTemplate[] {
    return TEMPLATES;
  }

  getTemplate(id: string): ScaffoldTemplate | undefined {
    return TEMPLATE_INDEX.get(id);
  }

  // ---- Scaffolding ------------------------------------------------------

  scaffold(input: ScaffoldInput): ScaffoldResult {
    const template = TEMPLATE_INDEX.get(input.templateId);
    if (!template) {
      throw new ProgramError({
        code: "eks.program.sdk.unknown_template",
        category: "validation",
        message: `Unknown template: ${input.templateId}`,
        userMessage: "The requested scaffold template does not exist.",
      });
    }
    if (!/^[a-z0-9-]+$/.test(input.slug)) {
      throw new ProgramError({
        code: "eks.program.sdk.invalid_slug",
        category: "validation",
        message: "Slug must be lowercase kebab-case.",
        userMessage: "Program slug must be lowercase kebab-case.",
      });
    }

    const manifest = this.generateManifest({
      slug: input.slug,
      name: input.name,
      version: input.version ?? "1.0.0",
      description: input.description ?? template.description,
      category: input.category ?? template.defaultCategory,
      developerId: input.developerId,
      developerName: input.developerName,
      developerEmail: input.developerEmail,
      capabilities: template.defaultCapabilities,
      supportedCountries: ["*"],
      supportedLanguages: ["en"],
      dependencies: template.defaultDependencies,
      resourceLimits: template.defaultResourceLimits,
      privacy: template.defaultPrivacy,
      aiUsage: template.defaultAiUsage,
      measurementDefinitions: template.defaultMeasurementDefinitions,
    });

    const files = this.generateProjectFiles(template, manifest);
    const rootPath = `./${input.slug}`;
    const project: ProjectStructure = {
      rootPath,
      files,
      manifest,
      templateId: template.id,
    };
    this.projects.set(rootPath, project);

    void getEventBus().publish(
      buildEvent(
        "eks.program.sdk.scaffolded",
        { slug: input.slug, templateId: template.id, programId: manifest.id },
        {},
        "domain",
      ),
    );

    return { template, manifest, project };
  }

  generateManifest(input: ManifestBuilderInput): ProgramManifest {
    return buildManifest(input);
  }

  private generateProjectFiles(
    template: ScaffoldTemplate,
    manifest: ProgramManifest,
  ): ProjectFile[] {
    const files: ProjectFile[] = [];

    // manifest.json
    files.push({
      path: "manifest.json",
      content: JSON.stringify(manifest, null, 2),
    });

    // src/entry.ts — real, minimal program handler
    files.push({
      path: "src/entry.ts",
      content: this.generateEntryTs(manifest, template),
    });

    // src/index.ts — barrel
    files.push({
      path: "src/index.ts",
      content: `export { handler } from "./entry";\n`,
    });

    // README.md
    files.push({
      path: "README.md",
      content: this.generateReadme(manifest, template),
    });

    // test/contract.test.ts — real test file
    files.push({
      path: "test/contract.test.ts",
      content: this.generateTestFile(manifest),
    });

    // .eksprogramrc — local runtime config
    files.push({
      path: ".eksprogramrc.json",
      content: JSON.stringify(
        {
          programId: manifest.id,
          slug: manifest.slug,
          version: semVerToString(manifest.version),
          sdkVersion: semVerToString(manifest.sdkVersion),
          runtime: this.defaultRuntimeConfig,
        },
        null,
        2,
      ),
    });

    // tsconfig.json — minimal
    files.push({
      path: "tsconfig.json",
      content: JSON.stringify(
        {
          compilerOptions: {
            target: "ES2022",
            module: "esnext",
            moduleResolution: "bundler",
            strict: true,
            esModuleInterop: true,
            skipLibCheck: true,
            outDir: "./dist",
          },
          include: ["src"],
        },
        null,
        2,
      ),
    });

    return files;
  }

  private generateEntryTs(
    manifest: ProgramManifest,
    template: ScaffoldTemplate,
  ): string {
    const handlerMethods: string[] = [];

    if (manifest.capabilities.some((c) => c.capability === "measurement")) {
      handlerMethods.push(`  async onMeasurement(ctx, event) {
    // Called when a measurement is recorded for this program.
    ctx.log.info("Measurement received", { value: event.payload });
  }`);
    }
    if (manifest.capabilities.some((c) => c.capability === "competition")) {
      handlerMethods.push(`  async onCompetitionStart(ctx, event) {
    // Called when a competition starts.
    ctx.log.info("Competition started", { competitionId: event.competitionId });
  }`);
    }
    if (manifest.capabilities.some((c) => c.capability === "notification")) {
      handlerMethods.push(`  async onNotificationRequest(ctx, request) {
    // Called to send a notification.
    return { delivered: true };
  }`);
    }
    if (manifest.aiUsage?.usesAI) {
      handlerMethods.push(`  async onAiPrompt(ctx, prompt) {
    // Called to process an AI prompt.
    return { response: "AI response placeholder" };
  }`);
    }

    const methods =
      handlerMethods.length > 0
        ? handlerMethods.join("\n\n") + "\n"
        : `  async onEvent(ctx, event) {
    // Default event handler.
    ctx.log.info("Event received", { type: event.type });
  }
`;

    return `/**
 * ${manifest.name} — generated by @eks/program-sdk
 *
 * Template: ${template.id}
 * Version: ${semVerToString(manifest.version)}
 * SDK: ${semVerToString(manifest.sdkVersion)}
 *
 * This is a real, minimal program handler that the Eks-Health runtime
 * can execute. Implement the lifecycle methods below.
 */

import type { ProgramHandler, ProgramContext, ProgramEvent } from "@eks/program-sdk";

export const handler: ProgramHandler = {
${methods}};

export default handler;
`;
  }

  private generateReadme(
    manifest: ProgramManifest,
    template: ScaffoldTemplate,
  ): string {
    const capList =
      manifest.capabilities.length > 0
        ? manifest.capabilities
            .map((c) => `- **${c.capability}**: ${c.reason}`)
            .join("\n")
        : "- (none)";

    return `# ${manifest.name}

${manifest.description}

- **Program ID**: \`${manifest.id}\`
- **Slug**: \`${manifest.slug}\`
- **Version**: ${semVerToString(manifest.version)}
- **SDK Version**: ${semVerToString(manifest.sdkVersion)}
- **Category**: ${manifest.category}
- **Template**: ${template.name}

## Capabilities

${capList}

## Privacy

- **Data collected**: ${manifest.privacy.dataCollected.length > 0 ? manifest.privacy.dataCollected.join(", ") : "none"}
- **Data usage**: ${manifest.privacy.dataUsage}
- **Retention**: ${manifest.privacy.retentionDays} days
- **Anonymized**: ${manifest.privacy.anonymizationApplied}

## AI Usage

${
  manifest.aiUsage.usesAI
    ? `- **Purpose**: ${manifest.aiUsage.purpose}
- **Provider**: ${manifest.aiUsage.provider ?? "n/a"}
- **Model family**: ${manifest.aiUsage.modelFamily ?? "n/a"}
- **Explanation**: ${manifest.aiUsage.humanReadableExplanation ?? "n/a"}`
    : "This program does not use AI."
}

## Development

\`\`\`bash
eks build        # validate manifest
eks test         # run tests
eks package      # create bundle
eks publish      # publish to platform
\`\`\`
`;
  }

  private generateTestFile(manifest: ProgramManifest): string {
    return `/**
 * Contract tests for ${manifest.name}.
 *
 * Auto-generated by @eks/program-sdk.
 */
import { describe, it, expect } from "vitest";
import { validateManifest } from "@eks/program-sdk/testing";
import manifest from "../manifest.json";

describe("${manifest.slug} contract", () => {
  it("manifest is structurally valid", () => {
    const result = validateManifest(manifest);
    expect(result.valid).toBe(true);
  });

  it("declares at least one supported language", () => {
    expect(manifest.supportedLanguages.length).toBeGreaterThan(0);
  });

  it("has a privacy declaration", () => {
    expect(manifest.privacy).toBeDefined();
  });

  it("every capability has a reason", () => {
    for (const cap of manifest.capabilities) {
      expect(cap.reason).toBeTruthy();
    }
  });
});
`;
  }

  // ---- Packaging --------------------------------------------------------

  package(
    projectPath: string,
    manifest: ProgramManifest,
    signingKey?: SigningKeyPair,
  ): PackageOutput {
    const project = this.projects.get(projectPath);
    if (!project) {
      throw new ProgramError({
        code: "eks.program.sdk.project_not_found",
        category: "not_found",
        message: `Project not found at ${projectPath}. Call scaffold() first.`,
        userMessage: "Project not found.",
      });
    }

    const fileEntries: PackageFileEntry[] = project.files.map((f) => {
      const buf = Buffer.from(f.content, "utf-8");
      const sha256 = createHash("sha256").update(buf).digest("hex");
      return { path: f.path, sha256, size: buf.byteLength };
    });

    const totalBytes = fileEntries.reduce((sum, f) => sum + f.size, 0);
    const fingerprint = manifestFingerprint(manifest);

    let signature: ManifestSignature | undefined;
    if (signingKey) {
      const signed = signManifest(manifest, signingKey, "developer");
      signature = signed.signature;
    }

    const output: PackageOutput = {
      packageId: asPackageId(generateId("pkg_")),
      manifest,
      fingerprint,
      signature,
      files: fileEntries,
      packagedAt: getClock().iso(),
      totalBytes,
    };

    void getEventBus().publish(
      buildEvent(
        "eks.program.sdk.packaged",
        {
          packageId: output.packageId,
          programId: manifest.id,
          fileCount: fileEntries.length,
          totalBytes,
          signed: !!signature,
        },
        {},
        "domain",
      ),
    );

    return output;
  }

  /** Generate a developer signing keypair for use with package(). */
  generateSigningKey(keyId: string): SigningKeyPair {
    return generateSigningKeyPair(keyId);
  }

  // ---- Contract validation ---------------------------------------------

  validateContract(manifest: ProgramManifest): ContractValidationResult {
    const errors: ContractIssue[] = [];
    const warnings: ContractIssue[] = [];

    // Capabilities must exist in the catalog
    for (const c of manifest.capabilities) {
      const cap = getCapability(c.capability as CapabilityId);
      if (!cap) {
        errors.push({
          field: `capabilities.${c.capability}`,
          code: "unknown_capability",
          message: `Capability ${c.capability} is not in the platform catalog.`,
        });
      }
    }

    // Supported APIs must be a subset of known APIs
    const knownApis = new Set(["rest", "websocket", "webhook"]);
    for (const api of manifest.supportedApis) {
      if (!knownApis.has(api)) {
        errors.push({
          field: "supportedApis",
          code: "unknown_api",
          message: `API ${api} is not supported by the platform.`,
        });
      }
    }

    // Platform version compatibility
    const currentPlatform = parseSemVer("2.0.0");
    if (compareSemVer(manifest.minPlatformVersion, currentPlatform) > 0) {
      errors.push({
        field: "minPlatformVersion",
        code: "incompatible",
        message: `Program requires platform ${semVerToString(manifest.minPlatformVersion)} but current is ${semVerToString(currentPlatform)}.`,
      });
    }

    // SDK version
    const minSdk = parseSemVer("1.0.0");
    if (compareSemVer(manifest.sdkVersion, minSdk) < 0) {
      warnings.push({
        field: "sdkVersion",
        code: "prerelease_sdk",
        message: `SDK version ${semVerToString(manifest.sdkVersion)} is pre-release.`,
      });
    }

    // Dependency ranges must be parseable
    for (const d of manifest.dependencies) {
      if (!isValidRangeSyntax(d.versionRange)) {
        errors.push({
          field: `dependencies.${d.name}`,
          code: "invalid_range",
          message: `Invalid version range: ${d.versionRange}`,
        });
      }
    }

    return { valid: errors.length === 0, errors, warnings };
  }

  // ---- Documentation generation -----------------------------------------

  generateDocs(manifest: ProgramManifest): string {
    const lines: string[] = [];
    lines.push(`# ${manifest.name}`);
    lines.push("");
    lines.push(`> ${manifest.description}`);
    lines.push("");
    lines.push("## Identity");
    lines.push("");
    lines.push(`| Field | Value |`);
    lines.push(`| --- | --- |`);
    lines.push(`| Program ID | \`${manifest.id}\` |`);
    lines.push(`| Slug | \`${manifest.slug}\` |`);
    lines.push(`| Version | ${semVerToString(manifest.version)} |`);
    lines.push(`| SDK Version | ${semVerToString(manifest.sdkVersion)} |`);
    lines.push(`| Category | ${manifest.category} |`);
    lines.push(`| Kind | ${manifest.kind} |`);
    lines.push(`| Developer | ${manifest.developer.name} <${manifest.developer.email}> |`);
    lines.push("");

    lines.push("## Capabilities");
    lines.push("");
    if (manifest.capabilities.length === 0) {
      lines.push("This program requests no capabilities.");
    } else {
      lines.push("| Capability | Reason | Purposes | Scope |");
      lines.push("| --- | --- | --- | --- |");
      for (const c of manifest.capabilities) {
        const cap = getCapability(c.capability as CapabilityId);
        const sensitive = cap?.sensitive ? " (sensitive)" : "";
        lines.push(
          `| ${c.capability}${sensitive} | ${c.reason} | ${(c.purposes ?? []).join(", ") || "—"} | ${c.scope ?? "self"} |`,
        );
      }
    }
    lines.push("");

    lines.push("## Permissions");
    lines.push("");
    if (manifest.permissions.length === 0) {
      lines.push("No additional permissions requested.");
    } else {
      for (const p of manifest.permissions) {
        lines.push(`- \`${p}\``);
      }
    }
    lines.push("");

    lines.push("## Privacy");
    lines.push("");
    lines.push(`- **Data collected**: ${manifest.privacy.dataCollected.length > 0 ? manifest.privacy.dataCollected.join(", ") : "none"}`);
    lines.push(`- **Data usage**: ${manifest.privacy.dataUsage}`);
    lines.push(`- **Retention**: ${manifest.privacy.retentionDays} days`);
    lines.push(`- **Third-party sharing**: ${manifest.privacy.thirdPartySharing}`);
    lines.push(`- **Anonymization applied**: ${manifest.privacy.anonymizationApplied}`);
    lines.push(`- **Residency regions**: ${manifest.privacy.residencyRegions.join(", ")}`);
    lines.push("");

    lines.push("## AI Usage");
    lines.push("");
    if (manifest.aiUsage.usesAI) {
      lines.push(`- **Purpose**: ${manifest.aiUsage.purpose}`);
      lines.push(`- **Provider**: ${manifest.aiUsage.provider ?? "n/a"}`);
      lines.push(`- **Model family**: ${manifest.aiUsage.modelFamily ?? "n/a"}`);
      lines.push(`- **Training data used**: ${manifest.aiUsage.trainingDataUsed ?? false}`);
      lines.push(`- **Explanation**: ${manifest.aiUsage.humanReadableExplanation ?? "n/a"}`);
    } else {
      lines.push("This program does not use AI.");
    }
    lines.push("");

    lines.push("## Resources");
    lines.push("");
    const rl = manifest.resourceLimits;
    if (Object.keys(rl).length === 0) {
      lines.push("Default platform quotas apply.");
    } else {
      lines.push("| Resource | Limit |");
      lines.push("| --- | --- |");
      for (const [k, v] of Object.entries(rl)) {
        lines.push(`| ${k} | ${v} |`);
      }
    }
    lines.push("");

    lines.push("## Dependencies");
    lines.push("");
    if (manifest.dependencies.length === 0) {
      lines.push("No external dependencies.");
    } else {
      lines.push("| Name | Version | Type |");
      lines.push("| --- | --- | --- |");
      for (const d of manifest.dependencies) {
        lines.push(`| ${d.name} | ${d.versionRange} | ${d.type} |`);
      }
    }
    lines.push("");

    lines.push("## Supported APIs");
    lines.push("");
    for (const api of manifest.supportedApis) {
      lines.push(`- ${api}`);
    }
    lines.push("");

    return lines.join("\n");
  }

  // ---- Upgrade simulation ----------------------------------------------

  simulateUpgrade(
    currentManifest: ProgramManifest,
    newManifest: ProgramManifest,
  ): UpgradeSimulation {
    const currentCaps = new Set(currentManifest.capabilities.map((c) => c.capability));
    const newCaps = new Set(newManifest.capabilities.map((c) => c.capability));

    const addedCapabilities = [...newCaps].filter(
      (c) => !currentCaps.has(c),
    ) as CapabilityId[];
    const removedCapabilities = [...currentCaps].filter(
      (c) => !newCaps.has(c),
    ) as CapabilityId[];

    const currentPerms = new Set(currentManifest.permissions);
    const newPerms = new Set(newManifest.permissions);
    const addedPermissions = [...newPerms].filter((p) => !currentPerms.has(p));
    const removedPermissions = [...currentPerms].filter((p) => !newPerms.has(p));

    const privacyChanges: string[] = [];
    const cp = currentManifest.privacy;
    const np = newManifest.privacy;
    if (cp.dataUsage !== np.dataUsage) {
      privacyChanges.push(`dataUsage: "${cp.dataUsage}" → "${np.dataUsage}"`);
    }
    if (cp.retentionDays !== np.retentionDays) {
      privacyChanges.push(`retentionDays: ${cp.retentionDays} → ${np.retentionDays}`);
    }
    if (cp.thirdPartySharing !== np.thirdPartySharing) {
      privacyChanges.push(`thirdPartySharing: ${cp.thirdPartySharing} → ${np.thirdPartySharing}`);
    }
    if (cp.anonymizationApplied !== np.anonymizationApplied) {
      privacyChanges.push(`anonymizationApplied: ${cp.anonymizationApplied} → ${np.anonymizationApplied}`);
    }
    const addedData = np.dataCollected.filter(
      (d) => !cp.dataCollected.includes(d),
    );
    if (addedData.length > 0) {
      privacyChanges.push(`dataCollected added: ${addedData.join(", ")}`);
    }

    const aiUsageChanges: string[] = [];
    const ca = currentManifest.aiUsage;
    const na = newManifest.aiUsage;
    if (ca.usesAI !== na.usesAI) {
      aiUsageChanges.push(`usesAI: ${ca.usesAI} → ${na.usesAI}`);
    }
    if (ca.purpose !== na.purpose) {
      aiUsageChanges.push(`purpose: "${ca.purpose ?? "—"}" → "${na.purpose ?? "—"}"`);
    }
    if (ca.provider !== na.provider) {
      aiUsageChanges.push(`provider: ${ca.provider ?? "—"} → ${na.provider ?? "—"}`);
    }

    const resourceLimitChanges: string[] = [];
    const allResKeys = new Set([
      ...Object.keys(currentManifest.resourceLimits),
      ...Object.keys(newManifest.resourceLimits),
    ]);
    for (const k of allResKeys) {
      const cv = (currentManifest.resourceLimits as Record<string, unknown>)[k];
      const nv = (newManifest.resourceLimits as Record<string, unknown>)[k];
      if (cv !== nv) {
        resourceLimitChanges.push(`${k}: ${cv ?? "default"} → ${nv ?? "default"}`);
      }
    }

    // Determine if re-consent is required
    const sensitiveAdded = addedCapabilities.some((c) => {
      const cap = getCapability(c as CapabilityId);
      return cap?.requiresConsent ?? false;
    });
    const requiresReconsent =
      sensitiveAdded ||
      addedPermissions.length > 0 ||
      privacyChanges.length > 0 ||
      (na.usesAI && !ca.usesAI);

    const isBreaking =
      removedCapabilities.length > 0 ||
      removedPermissions.length > 0 ||
      compareSemVer(newManifest.version, currentManifest.version) < 0;

    return {
      addedCapabilities,
      removedCapabilities,
      addedPermissions,
      removedPermissions,
      privacyChanges,
      aiUsageChanges,
      resourceLimitChanges,
      requiresReconsent,
      isBreaking,
    };
  }

  // ---- CLI catalog ------------------------------------------------------

  listCliCommands(): readonly CliCommand[] {
    return CLI_COMMANDS;
  }

  // ---- Local runtime config --------------------------------------------

  getDefaultRuntimeConfig(): LocalRuntimeConfig {
    return { ...this.defaultRuntimeConfig };
  }

  // ---- Project access ---------------------------------------------------

  getProject(path: string): ProjectStructure | undefined {
    return this.projects.get(path);
  }

  listProjects(): ProjectStructure[] {
    return [...this.projects.values()];
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
// Capability catalog re-export
// ---------------------------------------------------------------------------

export { CAPABILITIES, getCapability };

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _sdk: SdkManager | null = null;
export function getSdk(): SdkManager {
  if (!_sdk) _sdk = new SdkManager();
  return _sdk;
}

export function resetSdk(): void {
  _sdk = null;
}

// ---------------------------------------------------------------------------
// Barrel re-exports
// ---------------------------------------------------------------------------

export type {
  ProgramId,
  PackageId,
  DeveloperId,
  SemVer,
  ResourceQuota,
} from "../core";
export type {
  ProgramManifest,
  ProgramDependency,
  CapabilityRequest,
  ManifestSignature,
  SigningKeyPair,
} from "../manifests";
