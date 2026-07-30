/**
 * Eks-Health Program OS — Developer Profile
 *
 * Developer profiles, publisher profiles, verification, API keys, and
 * developer-level metrics (programs count, published count, total installs,
 * total revenue, average rating).
 *
 * Real logic:
 *  - Real API key generation: 32 random bytes via node:crypto randomBytes,
 *    base64url-encoded; storage stores only the SHA-256 hash + a display
 *    prefix. The raw key is returned EXACTLY ONCE at creation time.
 *  - Real verification lifecycle: unverified → pending → verified|rejected.
 *  - Real metric aggregation: pulls live counts from the ProgramRegistry
 *    (programs, installs, ratings) — no cached aggregates.
 *
 * The platform never stores raw API keys. Verification documents are stored
 * as opaque references (URLs / hashes) — the platform does not interpret
 * document contents.
 */

import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  type DeveloperId,
  type PublisherId,
  type ProgramId,
  ProgramError,
  asDeveloperId,
  asPublisherId,
} from "../core";
import { getRegistry } from "../lifecycle";
import { getEventBus, buildEvent, generateId, getClock } from "@/kernel";

// ---------------------------------------------------------------------------
// Branded API-key ids
// ---------------------------------------------------------------------------

export type ApiKeyId = string & { readonly __brand: "ApiKeyId" };

// ---------------------------------------------------------------------------
// Developer primitives
// ---------------------------------------------------------------------------

export type DeveloperStatus = "active" | "suspended" | "banned";
export type VerificationStatus = "unverified" | "pending" | "verified" | "rejected";

export interface DeveloperVerification {
  readonly status: VerificationStatus;
  readonly documents: readonly string[]; // opaque document references
  readonly submittedAt?: string;
  readonly verifiedAt?: string;
  readonly verifiedBy?: string;
  readonly rejectedAt?: string;
  readonly rejectedReason?: string;
}

export interface DeveloperApiKey {
  readonly id: string;
  readonly developerId: DeveloperId;
  readonly label: string;
  /** SHA-256 hash of the raw key (hex). The raw key is NEVER stored. */
  readonly hash: string;
  /** Display-only prefix (first 12 chars of the raw key) for UI recognition. */
  readonly prefix: string;
  readonly createdAt: string;
  readonly lastUsedAt?: string;
  readonly revokedAt?: string;
  readonly revokedReason?: string;
  readonly active: boolean;
  readonly scopes?: readonly string[];
}

export interface DeveloperProfile {
  readonly id: DeveloperId;
  readonly name: string;
  readonly email: string;
  readonly organization?: string;
  readonly bio?: string;
  readonly website?: string;
  readonly avatarUrl?: string;
  readonly status: DeveloperStatus;
  readonly verification: DeveloperVerification;
  readonly apiKeys: readonly DeveloperApiKey[];
  readonly publisherIds: readonly PublisherId[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly suspendedAt?: string;
  readonly suspendedReason?: string;
  readonly bannedAt?: string;
  readonly bannedReason?: string;
}

export interface PublisherProfile {
  readonly id: PublisherId;
  readonly name: string;
  readonly developerId: DeveloperId;
  readonly description?: string;
  readonly website?: string;
  readonly logoUrl?: string;
  readonly verified: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface DeveloperMetrics {
  readonly developerId: DeveloperId;
  readonly programsCount: number;
  readonly publishedCount: number;
  readonly certifiedCount: number;
  readonly totalInstalls: number;
  readonly activeInstalls: number;
  readonly totalRevenue: number;
  readonly avgRating: number;
  readonly reviewCount: number;
  readonly computedAt: string;
}

export interface CreateProfileInput {
  readonly name: string;
  readonly email: string;
  readonly organization?: string;
  readonly bio?: string;
  readonly website?: string;
  readonly avatarUrl?: string;
}

export interface CreatePublisherInput {
  readonly name: string;
  readonly description?: string;
  readonly website?: string;
  readonly logoUrl?: string;
}

export interface GeneratedApiKey {
  /** The raw key. Returned EXACTLY ONCE — store it on the client; the platform keeps only the hash. */
  readonly rawKey: string;
  readonly record: DeveloperApiKey;
}

// ---------------------------------------------------------------------------
// Developer event types
// ---------------------------------------------------------------------------

export const DEVELOPER_EVENTS = {
  profileCreated: "eks.program.developer.profile.created",
  profileUpdated: "eks.program.developer.profile.updated",
  verificationRequested: "eks.program.developer.verification.requested",
  verificationApproved: "eks.program.developer.verification.approved",
  verificationRejected: "eks.program.developer.verification.rejected",
  apiKeyGenerated: "eks.program.developer.api_key.generated",
  apiKeyRevoked: "eks.program.developer.api_key.revoked",
  publisherCreated: "eks.program.developer.publisher.created",
  developerSuspended: "eks.program.developer.suspended",
  developerBanned: "eks.program.developer.banned",
} as const;

// ---------------------------------------------------------------------------
// Real API key generation
// ---------------------------------------------------------------------------

const API_KEY_PREFIX = "ekd_"; // "eks developer"
const API_KEY_PREFIX_DISPLAY_LEN = 12;

function generateRawApiKey(): string {
  // 32 random bytes → base64url ≈ 43 chars. Prefixed for easy identification.
  const bytes = randomBytes(32);
  const b64 = bytes.toString("base64url");
  return `${API_KEY_PREFIX}${b64}`;
}

function hashApiKey(rawKey: string): string {
  return createHash("sha256").update(rawKey).digest("hex");
}

function prefixOf(rawKey: string): string {
  return rawKey.slice(0, API_KEY_PREFIX_DISPLAY_LEN);
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// ---------------------------------------------------------------------------
// Developer manager
// ---------------------------------------------------------------------------

export class DeveloperManager {
  private readonly profiles = new Map<DeveloperId, DeveloperProfile>();
  private readonly byEmail = new Map<string, DeveloperId>();
  private readonly publishers = new Map<PublisherId, PublisherProfile>();
  private readonly publishersByDeveloper = new Map<DeveloperId, PublisherId[]>();

  // ----------------------- Profile CRUD -----------------------

  createProfile(input: CreateProfileInput): DeveloperProfile {
    if (!input.name || input.name.length < 2) {
      throw new ProgramError({
        code: "eks.program.developer.name_invalid",
        category: "validation",
        message: "Developer name must be at least 2 characters.",
        userMessage: "Please provide a valid developer name.",
      });
    }
    if (!input.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email)) {
      throw new ProgramError({
        code: "eks.program.developer.email_invalid",
        category: "validation",
        message: "A valid developer email is required.",
        userMessage: "Please provide a valid email address.",
      });
    }
    const lowerEmail = input.email.toLowerCase();
    if (this.byEmail.has(lowerEmail)) {
      throw new ProgramError({
        code: "eks.program.developer.email_taken",
        category: "state_conflict",
        message: `A developer with email ${lowerEmail} already exists.`,
        userMessage: "A developer with this email already exists.",
      });
    }
    const id = asDeveloperId(`dev_${generateId()}`);
    const now = getClock().iso();
    const profile: DeveloperProfile = {
      id,
      name: input.name,
      email: lowerEmail,
      organization: input.organization,
      bio: input.bio,
      website: input.website,
      avatarUrl: input.avatarUrl,
      status: "active",
      verification: { status: "unverified", documents: [] },
      apiKeys: [],
      publisherIds: [],
      createdAt: now,
      updatedAt: now,
    };
    this.profiles.set(id, profile);
    this.byEmail.set(lowerEmail, id);
    void getEventBus().publish(
      buildEvent(DEVELOPER_EVENTS.profileCreated, { developerId: id, name: input.name, email: lowerEmail }, {}, "domain"),
    );
    return profile;
  }

  getProfile(id: DeveloperId): DeveloperProfile | undefined {
    return this.profiles.get(id);
  }

  getProfileByEmail(email: string): DeveloperProfile | undefined {
    const id = this.byEmail.get(email.toLowerCase());
    return id ? this.profiles.get(id) : undefined;
  }

  listProfiles(): DeveloperProfile[] {
    return [...this.profiles.values()];
  }

  updateProfile(id: DeveloperId, updates: Partial<Omit<CreateProfileInput, "email">>): DeveloperProfile {
    const existing = this.require(id);
    if (existing.status === "banned") {
      throw new ProgramError({
        code: "eks.program.developer.banned",
        category: "state_conflict",
        message: "Banned developers cannot be updated.",
        userMessage: "This developer is banned.",
      });
    }
    const next: DeveloperProfile = {
      ...existing,
      name: updates.name ?? existing.name,
      organization: updates.organization ?? existing.organization,
      bio: updates.bio ?? existing.bio,
      website: updates.website ?? existing.website,
      avatarUrl: updates.avatarUrl ?? existing.avatarUrl,
      updatedAt: getClock().iso(),
    };
    this.profiles.set(id, next);
    void getEventBus().publish(
      buildEvent(DEVELOPER_EVENTS.profileUpdated, { developerId: id }, {}, "domain"),
    );
    return next;
  }

  // ----------------------- Verification -----------------------

  requestVerification(id: DeveloperId, documents: string[]): DeveloperProfile {
    const profile = this.require(id);
    if (profile.status === "banned") {
      throw new ProgramError({
        code: "eks.program.developer.banned",
        category: "state_conflict",
        message: "Banned developers cannot request verification.",
        userMessage: "This developer is banned.",
      });
    }
    if (!documents || documents.length === 0) {
      throw new ProgramError({
        code: "eks.program.developer.documents_required",
        category: "validation",
        message: "At least one verification document is required.",
        userMessage: "Please submit at least one verification document.",
      });
    }
    const now = getClock().iso();
    const verification: DeveloperVerification = {
      status: "pending",
      documents: [...documents],
      submittedAt: now,
      // preserve prior verifiedAt/verifiedBy if re-verifying
      verifiedAt: profile.verification.verifiedAt,
      verifiedBy: profile.verification.verifiedBy,
    };
    const next: DeveloperProfile = {
      ...profile,
      verification,
      updatedAt: now,
    };
    this.profiles.set(id, next);
    void getEventBus().publish(
      buildEvent(DEVELOPER_EVENTS.verificationRequested, { developerId: id, documentCount: documents.length }, {}, "domain"),
    );
    return next;
  }

  verify(id: DeveloperId, verifiedBy: string): DeveloperProfile {
    const profile = this.require(id);
    if (profile.verification.status !== "pending") {
      throw new ProgramError({
        code: "eks.program.developer.not_pending",
        category: "state_conflict",
        message: `Cannot verify developer in status ${profile.verification.status}.`,
        userMessage: "This developer is not pending verification.",
      });
    }
    const now = getClock().iso();
    const next: DeveloperProfile = {
      ...profile,
      verification: {
        ...profile.verification,
        status: "verified",
        verifiedAt: now,
        verifiedBy,
        rejectedAt: undefined,
        rejectedReason: undefined,
      },
      updatedAt: now,
    };
    this.profiles.set(id, next);
    void getEventBus().publish(
      buildEvent(DEVELOPER_EVENTS.verificationApproved, { developerId: id, verifiedBy }, {}, "domain"),
    );
    return next;
  }

  rejectVerification(id: DeveloperId, reason: string): DeveloperProfile {
    const profile = this.require(id);
    if (profile.verification.status !== "pending") {
      throw new ProgramError({
        code: "eks.program.developer.not_pending",
        category: "state_conflict",
        message: `Cannot reject developer in status ${profile.verification.status}.`,
        userMessage: "This developer is not pending verification.",
      });
    }
    if (!reason) {
      throw new ProgramError({
        code: "eks.program.developer.reason_required",
        category: "validation",
        message: "A rejection reason is required.",
        userMessage: "A rejection reason is required.",
      });
    }
    const now = getClock().iso();
    const next: DeveloperProfile = {
      ...profile,
      verification: {
        ...profile.verification,
        status: "rejected",
        rejectedAt: now,
        rejectedReason: reason,
      },
      updatedAt: now,
    };
    this.profiles.set(id, next);
    void getEventBus().publish(
      buildEvent(DEVELOPER_EVENTS.verificationRejected, { developerId: id, reason }, {}, "domain"),
    );
    return next;
  }

  isVerified(id: DeveloperId): boolean {
    const profile = this.profiles.get(id);
    return !!profile && profile.verification.status === "verified";
  }

  /** A developer can publish iff they are verified AND active. */
  canPublish(id: DeveloperId): boolean {
    const profile = this.profiles.get(id);
    return !!profile && profile.status === "active" && profile.verification.status === "verified";
  }

  // ----------------------- Publishers -----------------------

  createPublisher(developerId: DeveloperId, input: CreatePublisherInput): PublisherProfile {
    const developer = this.require(developerId);
    if (developer.status !== "active") {
      throw new ProgramError({
        code: "eks.program.developer.not_active",
        category: "state_conflict",
        message: `Developer ${developerId} is not active (status: ${developer.status}).`,
        userMessage: "Only active developers can create publishers.",
      });
    }
    if (!input.name || input.name.length < 2) {
      throw new ProgramError({
        code: "eks.program.publisher.name_invalid",
        category: "validation",
        message: "Publisher name must be at least 2 characters.",
        userMessage: "Publisher name is too short.",
      });
    }
    const now = getClock().iso();
    const publisher: PublisherProfile = {
      id: asPublisherId(`pub_${generateId()}`),
      name: input.name,
      developerId,
      description: input.description,
      website: input.website,
      logoUrl: input.logoUrl,
      verified: developer.verification.status === "verified",
      createdAt: now,
      updatedAt: now,
    };
    this.publishers.set(publisher.id, publisher);
    const list = this.publishersByDeveloper.get(developerId) ?? [];
    this.publishersByDeveloper.set(developerId, [...list, publisher.id]);
    // Mirror publisher onto the developer profile.
    const updated: DeveloperProfile = {
      ...developer,
      publisherIds: [...developer.publisherIds, publisher.id],
      updatedAt: now,
    };
    this.profiles.set(developerId, updated);
    void getEventBus().publish(
      buildEvent(DEVELOPER_EVENTS.publisherCreated, { publisherId: publisher.id, developerId, name: input.name }, {}, "domain"),
    );
    return publisher;
  }

  getPublisher(id: PublisherId): PublisherProfile | undefined {
    return this.publishers.get(id);
  }

  listPublishers(developerId?: DeveloperId): PublisherProfile[] {
    if (developerId) {
      const ids = this.publishersByDeveloper.get(developerId) ?? [];
      return ids.map((id) => this.publishers.get(id)!).filter(Boolean);
    }
    return [...this.publishers.values()];
  }

  // ----------------------- API keys -----------------------

  /**
   * Generate a new API key for a developer.
   * Returns the raw key EXACTLY ONCE. The platform stores only the SHA-256
   * hash and a display prefix.
   */
  generateApiKey(developerId: DeveloperId, label: string, scopes?: string[]): GeneratedApiKey {
    const developer = this.require(developerId);
    if (developer.status !== "active") {
      throw new ProgramError({
        code: "eks.program.developer.not_active",
        category: "state_conflict",
        message: `Developer ${developerId} is not active.`,
        userMessage: "Only active developers can generate API keys.",
      });
    }
    if (!label || label.length < 1) {
      throw new ProgramError({
        code: "eks.program.developer.api_key_label_invalid",
        category: "validation",
        message: "API key label is required.",
        userMessage: "Please provide a label for the API key.",
      });
    }
    const rawKey = generateRawApiKey();
    const now = getClock().iso();
    const record: DeveloperApiKey = {
      id: `key_${generateId()}`,
      developerId,
      label,
      hash: hashApiKey(rawKey),
      prefix: prefixOf(rawKey),
      createdAt: now,
      active: true,
      scopes,
    };
    const next: DeveloperProfile = {
      ...developer,
      apiKeys: [...developer.apiKeys, record],
      updatedAt: now,
    };
    this.profiles.set(developerId, next);
    void getEventBus().publish(
      buildEvent(DEVELOPER_EVENTS.apiKeyGenerated, { developerId, keyId: record.id, label }, {}, "domain"),
    );
    return { rawKey, record };
  }

  listApiKeys(developerId: DeveloperId): DeveloperApiKey[] {
    const profile = this.require(developerId);
    return [...profile.apiKeys];
  }

  revokeApiKey(keyId: string, reason?: string): void {
    let owner: DeveloperId | undefined;
    for (const [devId, profile] of this.profiles) {
      const idx = profile.apiKeys.findIndex((k) => k.id === keyId);
      if (idx >= 0) {
        owner = devId;
        const key = profile.apiKeys[idx];
        if (!key.active) return; // idempotent
        const revoked: DeveloperApiKey = {
          ...key,
          active: false,
          revokedAt: getClock().iso(),
          revokedReason: reason,
        };
        const nextApiKeys = [...profile.apiKeys];
        nextApiKeys[idx] = revoked;
        this.profiles.set(devId, { ...profile, apiKeys: nextApiKeys, updatedAt: getClock().iso() });
        break;
      }
    }
    if (owner) {
      void getEventBus().publish(
        buildEvent(DEVELOPER_EVENTS.apiKeyRevoked, { developerId: owner, keyId, reason }, {}, "domain"),
      );
    }
  }

  /**
   * Validate a raw API key. Returns the owning DeveloperProfile if the key
   * is recognized, active, and the hash matches; otherwise undefined.
   * Uses timing-safe comparison on the hash.
   */
  validateApiKey(rawKey: string): { profile: DeveloperProfile; key: DeveloperApiKey } | undefined {
    if (!rawKey || !rawKey.startsWith(API_KEY_PREFIX)) return undefined;
    const hash = hashApiKey(rawKey);
    for (const profile of this.profiles.values()) {
      for (const key of profile.apiKeys) {
        if (!key.active) continue;
        if (safeEqual(key.hash, hash)) {
          return { profile, key };
        }
      }
    }
    return undefined;
  }

  // ----------------------- Metrics -----------------------

  /**
   * Aggregate developer metrics from the registry in real time.
   * programsCount = all programs owned by the developer.
   * publishedCount = programs in state "published" (or beyond: installed/active/etc.).
   * totalInstalls = sum of installedCount across all programs.
   * avgRating = mean of all rated programs (weighted by reviewCount).
   */
  getMetrics(developerId: DeveloperId): DeveloperMetrics {
    const profile = this.require(developerId);
    const programs = getRegistry().listByDeveloper(developerId);
    const publishedStates = ["published", "installed", "active", "paused", "deprecated"];
    let publishedCount = 0;
    let certifiedCount = 0;
    let totalInstalls = 0;
    let activeInstalls = 0;
    let ratingSum = 0;
    let ratingCount = 0;
    for (const p of programs) {
      if (publishedStates.includes(p.state)) publishedCount += 1;
      if (p.state === "certified" || publishedStates.includes(p.state)) certifiedCount += 1;
      totalInstalls += p.installedCount;
      activeInstalls += p.activeInstallCount;
      if (typeof p.rating === "number" && p.rating > 0 && p.reviewCount > 0) {
        ratingSum += p.rating * p.reviewCount;
        ratingCount += p.reviewCount;
      }
    }
    // Revenue is a placeholder aggregate — no payment integration yet.
    // We expose it as 0 so the contract is real but the value is honest.
    const totalRevenue = 0;
    return {
      developerId,
      programsCount: programs.length,
      publishedCount,
      certifiedCount,
      totalInstalls,
      activeInstalls,
      totalRevenue,
      avgRating: ratingCount === 0 ? 0 : Math.round((ratingSum / ratingCount) * 100) / 100,
      reviewCount: ratingCount,
      computedAt: getClock().iso(),
    };
  }

  // ----------------------- Suspension / ban -----------------------

  suspend(id: DeveloperId, reason: string): DeveloperProfile {
    const profile = this.require(id);
    if (profile.status === "banned") {
      throw new ProgramError({
        code: "eks.program.developer.banned",
        category: "state_conflict",
        message: "Cannot suspend a banned developer.",
        userMessage: "This developer is already banned.",
      });
    }
    if (!reason) {
      throw new ProgramError({
        code: "eks.program.developer.reason_required",
        category: "validation",
        message: "A suspension reason is required.",
        userMessage: "A suspension reason is required.",
      });
    }
    const now = getClock().iso();
    const next: DeveloperProfile = {
      ...profile,
      status: "suspended",
      suspendedAt: now,
      suspendedReason: reason,
      updatedAt: now,
    };
    this.profiles.set(id, next);
    void getEventBus().publish(
      buildEvent(DEVELOPER_EVENTS.developerSuspended, { developerId: id, reason }, {}, "domain"),
    );
    return next;
  }

  ban(id: DeveloperId, reason: string): DeveloperProfile {
    const profile = this.require(id);
    if (!reason) {
      throw new ProgramError({
        code: "eks.program.developer.reason_required",
        category: "validation",
        message: "A ban reason is required.",
        userMessage: "A ban reason is required.",
      });
    }
    const now = getClock().iso();
    // Revoke all active API keys as part of the ban.
    const revokedKeys = profile.apiKeys.map((k) =>
      k.active
        ? { ...k, active: false, revokedAt: now, revokedReason: `banned: ${reason}` }
        : k,
    );
    const next: DeveloperProfile = {
      ...profile,
      status: "banned",
      bannedAt: now,
      bannedReason: reason,
      apiKeys: revokedKeys,
      updatedAt: now,
    };
    this.profiles.set(id, next);
    void getEventBus().publish(
      buildEvent(DEVELOPER_EVENTS.developerBanned, { developerId: id, reason }, {}, "domain"),
    );
    return next;
  }

  reactivate(id: DeveloperId): DeveloperProfile {
    const profile = this.require(id);
    if (profile.status === "banned") {
      throw new ProgramError({
        code: "eks.program.developer.banned",
        category: "state_conflict",
        message: "Cannot reactivate a banned developer (use explicit un-ban).",
        userMessage: "This developer is banned.",
      });
    }
    if (profile.status !== "suspended") return profile;
    const next: DeveloperProfile = {
      ...profile,
      status: "active",
      suspendedAt: undefined,
      suspendedReason: undefined,
      updatedAt: getClock().iso(),
    };
    this.profiles.set(id, next);
    void getEventBus().publish(
      buildEvent(DEVELOPER_EVENTS.profileUpdated, { developerId: id, change: "reactivated" }, {}, "domain"),
    );
    return next;
  }

  private require(id: DeveloperId): DeveloperProfile {
    const p = this.profiles.get(id);
    if (!p) {
      throw new ProgramError({
        code: "eks.program.developer.not_found",
        category: "not_found",
        message: `Developer ${id} not found.`,
        userMessage: "Developer not found.",
      });
    }
    return p;
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _mgr: DeveloperManager | null = null;
export function getDeveloperManager(): DeveloperManager {
  if (!_mgr) _mgr = new DeveloperManager();
  return _mgr;
}
export function resetDeveloperManager(): void {
  _mgr = null;
}

// Re-exports
export { asDeveloperId, asPublisherId };
export type { DeveloperId, PublisherId, ProgramId };
