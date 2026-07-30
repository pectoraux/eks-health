/**
 * Eks-Health Program OS — Manifests
 *
 * Every Program must declare a signed manifest before it can execute.
 * The manifest defines identity, version, developer, publisher, capabilities,
 * permissions, supported countries/languages/demographics, dependencies,
 * compatibility, resource limits, privacy declaration, AI usage declaration,
 * measurement/competition/leaderboard/mission definitions, SDK version,
 * and supported APIs.
 *
 * Programs cannot execute without a valid, signed manifest.
 */

import "server-only";
import { createHash, createSign, createVerify, generateKeyPairSync } from "node:crypto";
import {
  type ProgramId,
  type DeveloperId,
  type PublisherId,
  type SemVer,
  type CapabilityId,
  type ResourceQuota,
  type PrivacyDeclaration,
  type AIUsageDeclaration,
  type ResourceDefinition,
  type ReleaseChannel,
  ProgramError,
  asProgramId,
} from "../core";
import { parseSemVer, compareSemVer } from "../core";

// ---------------------------------------------------------------------------
// Manifest shape
// ---------------------------------------------------------------------------

export interface ProgramManifest {
  readonly id: ProgramId;
  readonly kind: "program" | "extension";
  readonly name: string;
  readonly slug: string;
  readonly version: SemVer;
  readonly sdkVersion: SemVer;
  readonly developer: { id: DeveloperId; name: string; email: string };
  readonly publisher?: { id: PublisherId; name: string };
  readonly description: string;
  readonly longDescription?: string;
  readonly iconUrl?: string;
  readonly category: string;
  readonly tags: string[];

  // Capabilities & permissions
  readonly capabilities: CapabilityRequest[];
  readonly permissions: string[];

  // Audience
  readonly supportedCountries: string[]; // ISO-3166-1 alpha-2
  readonly supportedLanguages: string[]; // BCP-47
  readonly supportedDemographics?: DemographicTargeting;

  // Dependencies & compatibility
  readonly dependencies: ProgramDependency[];
  readonly minPlatformVersion: SemVer;
  readonly maxPlatformVersion?: SemVer;
  readonly upgradePolicy: UpgradePolicy;

  // Resources
  readonly resourceLimits: Partial<ResourceQuota>;
  readonly privacy: PrivacyDeclaration;
  readonly aiUsage: AIUsageDeclaration;
  readonly paymentProviders?: string[];

  // Generic resource definitions (the platform stores these opaquely)
  readonly measurementDefinitions?: ResourceDefinition[];
  readonly competitionDefinitions?: ResourceDefinition[];
  readonly leaderboardDefinitions?: ResourceDefinition[];
  readonly missionDefinitions?: ResourceDefinition[];

  // APIs
  readonly supportedApis: string[]; // e.g. ["rest", "websocket"]
  readonly eventSubscriptions?: string[]; // platform event topics

  // Signature (filled by sign())
  readonly signature?: ManifestSignature;
}

export interface CapabilityRequest {
  readonly capability: CapabilityId;
  readonly reason: string; // human-readable justification
  readonly fields?: string[]; // for measurement/profile: which fields
  readonly purposes?: string[]; // PBAC purposes
  readonly scope?: "self" | "participant" | "cohort" | "all";
}

export interface DemographicTargeting {
  readonly minAge?: number;
  readonly maxAge?: number;
  readonly biologicalSex?: ("male" | "female" | "intersex" | "unspecified")[];
  readonly conditions?: string[]; // free-form; platform doesn't interpret
}

export interface ProgramDependency {
  readonly name: string;
  readonly versionRange: string; // semver range, e.g. "^1.2.0", ">=2.0.0 <3.0.0"
  readonly type: "sdk" | "library" | "program" | "capability";
  readonly optional?: boolean;
}

export type UpgradePolicy = "auto" | "prompt" | "manual" | "breaking-requires-reconsent";

export interface ManifestSignature {
  readonly algorithm: "rsa-sha256";
  readonly keyId: string;
  readonly signature: string; // base64
  readonly signedAt: string;
  readonly signedBy: string;
}

// ---------------------------------------------------------------------------
// Manifest validation
// ---------------------------------------------------------------------------

export interface ManifestValidationResult {
  readonly valid: boolean;
  readonly errors: ManifestValidationError[];
  readonly warnings: ManifestValidationWarning[];
}

export interface ManifestValidationError {
  readonly field: string;
  readonly code: string;
  readonly message: string;
}

export interface ManifestValidationWarning {
  readonly field: string;
  readonly message: string;
}

const PLATFORM_VERSION: SemVer = parseSemVer("2.0.0");

export function validateManifest(m: ProgramManifest): ManifestValidationResult {
  const errors: ManifestValidationError[] = [];
  const warnings: ManifestValidationWarning[] = [];

  // Required identity fields
  if (!m.id) errors.push({ field: "id", code: "missing", message: "Program id is required." });
  if (!m.name || m.name.length < 2) errors.push({ field: "name", code: "invalid", message: "Name must be at least 2 characters." });
  if (!m.slug || !/^[a-z0-9-]+$/.test(m.slug)) errors.push({ field: "slug", code: "invalid", message: "Slug must be lowercase kebab-case." });
  if (!m.version) errors.push({ field: "version", code: "missing", message: "Version is required." });
  if (!m.sdkVersion) errors.push({ field: "sdkVersion", code: "missing", message: "SDK version is required." });
  if (!m.developer?.id) errors.push({ field: "developer.id", code: "missing", message: "Developer id is required." });
  if (!m.developer?.email || !m.developer.email.includes("@")) errors.push({ field: "developer.email", code: "invalid", message: "Valid developer email required." });
  if (!m.description) errors.push({ field: "description", code: "missing", message: "Description is required." });
  if (!m.category) errors.push({ field: "category", code: "missing", message: "Category is required." });

  // Capabilities
  if (!m.capabilities || m.capabilities.length === 0) {
    warnings.push({ field: "capabilities", message: "No capabilities requested — program will have minimal access." });
  }
  for (const c of m.capabilities ?? []) {
    if (!c.reason) errors.push({ field: `capabilities.${c.capability}.reason`, code: "missing", message: `Capability ${c.capability} must declare a reason.` });
  }

  // Audience
  if (!m.supportedCountries || m.supportedCountries.length === 0) {
    warnings.push({ field: "supportedCountries", message: "No countries specified — program will be available globally." });
  }
  if (!m.supportedLanguages || m.supportedLanguages.length === 0) {
    errors.push({ field: "supportedLanguages", code: "missing", message: "At least one supported language is required." });
  }

  // Compatibility
  if (!m.minPlatformVersion) errors.push({ field: "minPlatformVersion", code: "missing", message: "Minimum platform version required." });
  if (m.maxPlatformVersion && compareSemVer(m.maxPlatformVersion, m.minPlatformVersion) < 0) {
    errors.push({ field: "maxPlatformVersion", code: "invalid", message: "Max platform version must be >= min platform version." });
  }
  if (compareSemVer(m.minPlatformVersion, PLATFORM_VERSION) > 0) {
    errors.push({ field: "minPlatformVersion", code: "incompatible", message: `Program requires platform ${semVerToString(m.minPlatformVersion)} but current is ${semVerToString(PLATFORM_VERSION)}.` });
  }

  // Privacy
  if (!m.privacy) errors.push({ field: "privacy", code: "missing", message: "Privacy declaration is required." });
  if (m.privacy?.dataCollected && m.privacy.dataCollected.length > 0 && !m.privacy.dataUsage) {
    errors.push({ field: "privacy.dataUsage", code: "missing", message: "Data usage must be declared when data is collected." });
  }
  if (m.privacy?.retentionDays === undefined || m.privacy.retentionDays < 0) {
    errors.push({ field: "privacy.retentionDays", code: "invalid", message: "Retention days must be >= 0." });
  }

  // AI usage
  if (m.aiUsage?.usesAI && !m.aiUsage.purpose) {
    errors.push({ field: "aiUsage.purpose", code: "missing", message: "AI purpose must be declared when AI is used." });
  }

  // Resource limits
  if (m.resourceLimits) {
    const q = m.resourceLimits;
    if (q.memoryMb !== undefined && q.memoryMb > 1024) {
      warnings.push({ field: "resourceLimits.memoryMb", message: "Memory > 1024MB requires elevated review." });
    }
    if (q.apiRequestsPerMinute !== undefined && q.apiRequestsPerMinute > 1000) {
      warnings.push({ field: "resourceLimits.apiRequestsPerMinute", message: "High API rate may require elevated review." });
    }
  }

  // Dependencies
  for (const d of m.dependencies ?? []) {
    if (!d.versionRange || !isValidVersionRange(d.versionRange)) {
      errors.push({ field: `dependencies.${d.name}`, code: "invalid_range", message: `Invalid version range: ${d.versionRange}` });
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

function semVerToString(v: SemVer): string {
  let s = `${v.major}.${v.minor}.${v.patch}`;
  if (v.prerelease) s += `-${v.prerelease}`;
  if (v.build) s += `+${v.build}`;
  return s;
}

function isValidVersionRange(range: string): boolean {
  // Simple validation: starts with ^, ~, >=, >, <=, <, or exact
  return /^(\^|~|>=|>|<=|<|=)?\d+\.\d+\.\d+/.test(range) || range === "*";
}

// ---------------------------------------------------------------------------
// Manifest signing (RSA-SHA256)
// ---------------------------------------------------------------------------

export interface SigningKeyPair {
  readonly keyId: string;
  readonly publicKeyPem: string;
  readonly privateKeyPem: string;
}

export function generateSigningKeyPair(keyId: string): SigningKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return { keyId, publicKeyPem: publicKey, privateKeyPem: privateKey };
}

/** Canonical JSON for deterministic signing (sorted keys, no whitespace). */
function canonicalManifestJson(m: ProgramManifest): string {
  const { signature: _sig, ...rest } = m;
  void _sig;
  return JSON.stringify(sortKeys(rest));
}

function sortKeys(obj: unknown): unknown {
  if (obj === null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(sortKeys);
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(obj as Record<string, unknown>).sort()) {
    sorted[k] = sortKeys((obj as Record<string, unknown>)[k]);
  }
  return sorted;
}

export function signManifest(manifest: ProgramManifest, keyPair: SigningKeyPair, signedBy: string): ProgramManifest {
  const canonical = canonicalManifestJson(manifest);
  const sign = createSign("RSA-SHA256");
  sign.update(canonical);
  sign.end();
  const signature = sign.sign(keyPair.privateKeyPem, "base64");
  const sig: ManifestSignature = {
    algorithm: "rsa-sha256",
    keyId: keyPair.keyId,
    signature,
    signedAt: new Date().toISOString(),
    signedBy,
  };
  return { ...manifest, signature: sig };
}

export function verifyManifestSignature(manifest: ProgramManifest, publicKeyPem: string): boolean {
  if (!manifest.signature) return false;
  const canonical = canonicalManifestJson(manifest);
  const verify = createVerify("RSA-SHA256");
  verify.update(canonical);
  verify.end();
  return verify.verify(publicKeyPem, manifest.signature.signature, "base64");
}

/** Fingerprint of a manifest (SHA-256 of canonical JSON) — for dedup & integrity. */
export function manifestFingerprint(m: ProgramManifest): string {
  return createHash("sha256").update(canonicalManifestJson(m)).digest("hex");
}

// ---------------------------------------------------------------------------
// Manifest builder helper
// ---------------------------------------------------------------------------

export interface ManifestBuilderInput {
  readonly slug: string;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly category: string;
  readonly developerId: string;
  readonly developerName: string;
  readonly developerEmail: string;
  readonly capabilities?: CapabilityRequest[];
  readonly supportedCountries?: string[];
  readonly supportedLanguages?: string[];
  readonly dependencies?: ProgramDependency[];
  readonly resourceLimits?: Partial<ResourceQuota>;
  readonly privacy?: PrivacyDeclaration;
  readonly aiUsage?: AIUsageDeclaration;
  readonly measurementDefinitions?: ResourceDefinition[];
  readonly eventSubscriptions?: string[];
}

export function buildManifest(input: ManifestBuilderInput): ProgramManifest {
  const manifest: ProgramManifest = {
    id: asProgramId(`prg_${input.slug.replace(/-/g, "_")}`),
    kind: "program",
    name: input.name,
    slug: input.slug,
    version: parseSemVer(input.version),
    sdkVersion: parseSemVer("1.0.0"),
    developer: {
      id: input.developerId as never,
      name: input.developerName,
      email: input.developerEmail,
    },
    description: input.description,
    category: input.category,
    tags: [],
    capabilities: input.capabilities ?? [],
    permissions: [],
    supportedCountries: input.supportedCountries ?? ["*"],
    supportedLanguages: input.supportedLanguages ?? ["en"],
    dependencies: input.dependencies ?? [],
    minPlatformVersion: parseSemVer("2.0.0"),
    upgradePolicy: "prompt",
    resourceLimits: input.resourceLimits ?? {},
    privacy: input.privacy ?? {
      dataCollected: [],
      dataUsage: "No data collected.",
      thirdPartySharing: false,
      retentionDays: 90,
      anonymizationApplied: true,
      residencyRegions: ["*"],
    },
    aiUsage: input.aiUsage ?? { usesAI: false },
    supportedApis: ["rest", "websocket"],
    eventSubscriptions: input.eventSubscriptions,
    measurementDefinitions: input.measurementDefinitions,
  };
  const validation = validateManifest(manifest);
  if (!validation.valid) {
    throw new ProgramError({
      code: "eks.program.manifest.invalid",
      category: "manifest_invalid",
      message: `Manifest invalid: ${validation.errors.map((e) => e.message).join("; ")}`,
      userMessage: "The program manifest failed validation.",
      metadata: { errors: validation.errors, warnings: validation.warnings },
    });
  }
  return manifest;
}

export type { ReleaseChannel };
