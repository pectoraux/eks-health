/**
 * Eks-Health Kernel — Security Foundations
 *
 * The trust & cryptography substrate of the platform. This module deliberately
 * does NOT implement authentication — that is a higher-level concern layered
 * on top of the identity primitives exposed here. What it DOES provide is the
 * infrastructure every secure service needs:
 *
 *   - Trust zones & security boundaries (public → dmz → internal → restricted → secure)
 *   - Network segmentation with an allow-list model
 *   - Service identity registry (the foundation for mTLS / SPIFFE-like identity)
 *   - Secret management with immutable, append-only versioning
 *   - Key descriptors (metadata only — raw material is delegated to a provider)
 *   - Encryption provider abstraction (AES-256-GCM in-memory default;
 *     swappable for KMS / HSM / Vault Transit in production)
 *   - Certificate descriptors for future X.509 / SPIRE integration
 *   - A real, deterministic trust-zone traffic matrix
 *
 * Design principles:
 *   - Raw key material never leaves the EncryptionProvider.
 *   - Secret versions are append-only and immutable; rotation = new version.
 *   - The default InMemoryEncryptionProvider is REAL working AES-256-GCM
 *     (not a mock) — usable in dev, replaced by HSM/KMS in production.
 *   - Every rotation publishes `eks.kernel.security.secret_rotated` so audit,
 *     config, and downstream services can react.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import type { ServiceId } from "../core";
import { generateId, getClock } from "../core";
import { buildEvent, getEventBus } from "../events";

// ---------------------------------------------------------------------------
// Trust zones & boundaries
// ---------------------------------------------------------------------------

export type TrustZone = "public" | "dmz" | "internal" | "restricted" | "secure";

export interface SecurityBoundary {
  readonly zone: TrustZone;
  readonly name: string;
  readonly description: string;
  readonly ingressFrom: readonly TrustZone[];
  readonly egressTo: readonly TrustZone[];
  readonly requiresMtls: boolean;
  readonly requiresEncryptionAtRest: boolean;
  readonly requiresEncryptionInTransit: boolean;
  readonly auditLevel: "none" | "summary" | "full" | "paranoid";
}

/**
 * The canonical five-zone trust model for Eks-Health.
 *
 *   public     — internet-facing edge (CDN, WAF, public APIs)
 *   dmz        — screened subnet (ingress controllers, API gateway runtime)
 *   internal   — general services (application logic, async workers)
 *   restricted — PHI/PII handling services (health records, billing)
 *   secure     — crown-jewel systems (KMS proxies, HSM, signing keys, vaults)
 *
 * Traffic may flow inward (public → dmz → internal → restricted → secure) and
 * outward only between adjacent zones; lateral traffic within the same zone is
 * always permitted; non-adjacent inward hops are denied (e.g. public → secure
 * is denied even though both directions touch the chain).
 */
export const SECURITY_BOUNDARIES: readonly SecurityBoundary[] = [
  {
    zone: "public",
    name: "Public Edge",
    description: "Internet-facing edge. Untrusted input. No PHI ever traverses here.",
    ingressFrom: [],
    egressTo: ["dmz"],
    requiresMtls: false,
    requiresEncryptionAtRest: false,
    requiresEncryptionInTransit: true,
    auditLevel: "summary",
  },
  {
    zone: "dmz",
    name: "DMZ",
    description: "Screened subnet. Ingress controllers, API gateway runtime, WAF termination.",
    ingressFrom: ["public"],
    egressTo: ["internal"],
    requiresMtls: true,
    requiresEncryptionAtRest: true,
    requiresEncryptionInTransit: true,
    auditLevel: "full",
  },
  {
    zone: "internal",
    name: "Internal Services",
    description: "General application services, async workers, schedulers.",
    ingressFrom: ["dmz", "internal"],
    egressTo: ["internal", "restricted"],
    requiresMtls: true,
    requiresEncryptionAtRest: true,
    requiresEncryptionInTransit: true,
    auditLevel: "full",
  },
  {
    zone: "restricted",
    name: "Restricted (PHI/PII)",
    description: "Services that store or process protected health information.",
    ingressFrom: ["internal", "restricted"],
    egressTo: ["restricted", "secure"],
    requiresMtls: true,
    requiresEncryptionAtRest: true,
    requiresEncryptionInTransit: true,
    auditLevel: "paranoid",
  },
  {
    zone: "secure",
    name: "Secure Enclave",
    description: "Crown-jewel systems: KMS proxies, HSM gateways, signing services, vaults.",
    ingressFrom: ["restricted"],
    egressTo: ["secure"],
    requiresMtls: true,
    requiresEncryptionAtRest: true,
    requiresEncryptionInTransit: true,
    auditLevel: "paranoid",
  },
];

export interface NetworkSegment {
  readonly cidr: string;
  readonly zone: TrustZone;
  readonly allowList: readonly string[]; // CIDRs permitted to originate traffic into this segment
  readonly description?: string;
}

// ---------------------------------------------------------------------------
// Service identity
// ---------------------------------------------------------------------------

export interface ServiceIdentity {
  readonly id: ServiceId;
  readonly name: string;
  readonly zone: TrustZone;
  readonly credentials: ServiceCredentials;
  readonly permissions: readonly string[];
  readonly registeredAt: string;
}

export interface ServiceCredentials {
  /** SPIFFE-like URI, e.g. "spiffe://eks.health/svc/billing-api". */
  readonly spiffeId?: string;
  /** SHA-256 fingerprint of the service's leaf certificate (future mTLS). */
  readonly certFingerprint?: string;
  /** Long-lived API token reference (never the token itself). */
  readonly tokenRef?: SecretId;
  readonly issuedAt: string;
  readonly expiresAt?: string;
}

// ---------------------------------------------------------------------------
// Secrets (immutable, versioned, access-controlled)
// ---------------------------------------------------------------------------

export type SecretId = string & { readonly __brand: "SecretId" };

export function asSecretId(s: string): SecretId {
  return s as SecretId;
}

export function generateSecretId(): SecretId {
  return asSecretId(`sec_${generateId()}`);
}

export interface SecretVersion {
  readonly version: number;
  readonly value: string; // ciphertext when an EncryptionProvider is used
  readonly iv: string; // base64 initialization vector
  readonly authTag: string; // base64 GCM auth tag
  readonly createdAt: string;
  readonly createdBy: string;
  readonly meta: Readonly<Record<string, string>>;
}

export interface Secret {
  readonly id: SecretId;
  readonly name: string;
  readonly versions: readonly SecretVersion[];
  readonly allowedServices: ReadonlySet<ServiceId>;
  readonly createdAt: string;
  readonly rotatedAt?: string;
}

// ---------------------------------------------------------------------------
// Keys, certificates, encryption
// ---------------------------------------------------------------------------

export type KeyAlgorithm =
  | "AES-256-GCM"
  | "AES-256-CBC"
  | "RSA-2048"
  | "RSA-4096"
  | "ECDSA-P256"
  | "ECDSA-P384"
  | "Ed25519";

export type KeyPurpose =
  | "symmetric_encryption"
  | "asymmetric_signing"
  | "key_wrapping"
  | "tls"
  | "jwt"
  | "data_key";

export type RotationPolicy =
  | { kind: "manual" }
  | { kind: "interval"; days: number }
  | { kind: "usage"; maxUses: number };

export type KeyStatus = "active" | "rotating" | "retired" | "revoked" | "destroyed";

export interface KeyDescriptor {
  readonly id: string;
  readonly algorithm: KeyAlgorithm;
  readonly purpose: KeyPurpose;
  readonly rotationPolicy: RotationPolicy;
  readonly status: KeyStatus;
  readonly createdAt: string;
  readonly rotatedAt?: string;
  readonly expiresAt?: string;
  readonly hsmBacked: boolean;
  readonly description?: string;
}

export interface CertificateDescriptor {
  readonly id: string;
  readonly subject: string;
  readonly issuer: string;
  readonly serialNumber: string;
  readonly notBefore: string;
  readonly notAfter: string;
  readonly fingerprint: string;
  readonly keyUsage: readonly string[];
  readonly san: readonly string[]; // subject alternative names
  readonly autoRenew: boolean;
}

export interface EncryptedBlob {
  readonly ciphertext: string; // base64
  readonly iv: string; // base64
  readonly authTag: string; // base64
  readonly algorithm: KeyAlgorithm;
}

export interface EncryptionProvider {
  readonly name: string;
  /** Encrypt plaintext into an authenticated blob. */
  encrypt(plaintext: string, associatedData?: string): EncryptedBlob;
  /** Decrypt an encrypted blob. Throws if the auth tag fails verification. */
  decrypt(blob: EncryptedBlob, associatedData?: string): string;
  /**
   * Rotate the provider's root key. Returns the new key version identifier.
   * Old ciphertexts remain decryptable until `prune` is called.
   */
  rotate(): string;
  /** Forget old key versions older than the latest N. */
  prune(keepVersions: number): number;
}

/**
 * REAL working AES-256-GCM provider using Node's built-in `crypto`.
 *
 * - The master key is held in memory (32 random bytes).
 * - Each encryption uses a fresh random 12-byte IV.
 * - GCM auth tag (16 bytes) is captured per ciphertext.
 * - On rotation a new master key is generated and the old one is retained
 *   in a versioned ring buffer so existing ciphertexts remain decryptable.
 *
 * This is NOT a mock — it is genuine authenticated encryption suitable for
 * development and ephemeral environments. Production replaces this with
 * an HSM/KMS-backed implementation that never exposes the master key.
 */
export class InMemoryEncryptionProvider implements EncryptionProvider {
  readonly name = "in-memory-aes-256-gcm";
  private keyRing: { version: string; key: Buffer }[] = [];
  private currentVersion: string;

  constructor() {
    const key = randomBytes(32);
    this.currentVersion = `v${Date.now()}`;
    this.keyRing.push({ version: this.currentVersion, key });
  }

  encrypt(plaintext: string, associatedData?: string): EncryptedBlob {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.currentKey(), iv);
    if (associatedData) {
      cipher.setAAD(Buffer.from(associatedData, "utf8"));
    }
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return {
      ciphertext: ciphertext.toString("base64"),
      iv: iv.toString("base64"),
      authTag: authTag.toString("base64"),
      algorithm: "AES-256-GCM",
    };
  }

  decrypt(blob: EncryptedBlob, associatedData?: string): string {
    // Try the current key first, then fall back through the ring for ciphertexts
    // encrypted under older key versions.
    const iv = Buffer.from(blob.iv, "base64");
    const authTag = Buffer.from(blob.authTag, "base64");
    const ciphertext = Buffer.from(blob.ciphertext, "base64");
    let lastErr: unknown;
    for (let i = this.keyRing.length - 1; i >= 0; i--) {
      const { key } = this.keyRing[i];
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, iv);
        decipher.setAuthTag(authTag);
        if (associatedData) {
          decipher.setAAD(Buffer.from(associatedData, "utf8"));
        }
        const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
        return plain.toString("utf8");
      } catch (e) {
        lastErr = e;
      }
    }
    throw new Error(
      `InMemoryEncryptionProvider.decrypt: failed to authenticate ciphertext (${lastErr instanceof Error ? lastErr.message : String(lastErr)})`,
    );
  }

  rotate(): string {
    const newVersion = `v${Date.now()}`;
    this.keyRing.push({ version: newVersion, key: randomBytes(32) });
    this.currentVersion = newVersion;
    return newVersion;
  }

  prune(keepVersions: number): number {
    const removed = Math.max(0, this.keyRing.length - keepVersions);
    if (removed > 0) {
      // Always preserve the current version.
      this.keyRing = this.keyRing.slice(-keepVersions);
      if (!this.keyRing.some((k) => k.version === this.currentVersion)) {
        const last = this.keyRing[this.keyRing.length - 1];
        if (last) this.currentVersion = last.version;
      }
    }
    return removed;
  }

  currentKeyVersion(): string {
    return this.currentVersion;
  }

  private currentKey(): Buffer {
    const entry = this.keyRing.find((k) => k.version === this.currentVersion);
    if (!entry) throw new Error("InMemoryEncryptionProvider: no active key");
    return entry.key;
  }
}

// ---------------------------------------------------------------------------
// SecretManager — immutable, append-only, access-controlled
// ---------------------------------------------------------------------------

export interface PutSecretOptions {
  readonly createdBy?: string;
  readonly meta?: Record<string, string>;
  readonly encrypt?: boolean;
  readonly associatedData?: string;
}

export class SecretManager {
  private readonly secrets = new Map<SecretId, Secret>();
  private readonly byName = new Map<string, SecretId>();

  constructor(private readonly encryption: EncryptionProvider = new InMemoryEncryptionProvider()) {}

  put(name: string, value: string, opts: PutSecretOptions = {}): SecretId {
    // If a secret with this name already exists, rotate it (append a new version).
    const existingId = this.byName.get(name);
    if (existingId) {
      return this.rotate(existingId, value, opts);
    }
    const id = generateSecretId();
    const version = this.makeVersion(name, value, 1, opts);
    const secret: Secret = {
      id,
      name,
      versions: [version],
      allowedServices: new Set<ServiceId>(),
      createdAt: getClock().iso(),
    };
    this.secrets.set(id, secret);
    this.byName.set(name, id);
    return id;
  }

  /** Resolve the latest version's plaintext value. */
  get(id: SecretId): string | undefined {
    const secret = this.secrets.get(id);
    if (!secret) return undefined;
    const latest = secret.versions[secret.versions.length - 1];
    if (!latest) return undefined;
    return this.decryptVersion(latest, secret.name);
  }

  getVersion(id: SecretId, version: number): string | undefined {
    const secret = this.secrets.get(id);
    if (!secret) return undefined;
    const v = secret.versions.find((sv) => sv.version === version);
    if (!v) return undefined;
    return this.decryptVersion(v, secret.name);
  }

  /** Append a new version (immutable). Old versions remain available. */
  rotate(id: SecretId, newValue: string, opts: PutSecretOptions = {}): SecretId {
    const secret = this.secrets.get(id);
    if (!secret) {
      throw new Error(`SecretManager.rotate: secret ${id} not found`);
    }
    const nextVersionNumber = secret.versions.length + 1;
    const version = this.makeVersion(secret.name, newValue, nextVersionNumber, opts);
    const updated: Secret = {
      ...secret,
      versions: [...secret.versions, version],
      rotatedAt: getClock().iso(),
    };
    this.secrets.set(id, updated);

    void getEventBus().publish(
      buildEvent(
        "eks.kernel.security.secret_rotated",
        {
          secretId: id,
          secretName: secret.name,
          newVersion: nextVersionNumber,
          rotatedBy: opts.createdBy ?? "system",
        },
        { actor: { kind: "service", id: opts.createdBy ?? "system" } },
        "system",
      ),
    );
    return id;
  }

  list(): readonly Secret[] {
    return [...this.secrets.values()];
  }

  delete(id: SecretId): boolean {
    const secret = this.secrets.get(id);
    if (!secret) return false;
    this.byName.delete(secret.name);
    return this.secrets.delete(id);
  }

  grantAccess(id: SecretId, serviceId: ServiceId): void {
    const secret = this.secrets.get(id);
    if (!secret) throw new Error(`SecretManager.grantAccess: secret ${id} not found`);
    const next = new Set(secret.allowedServices);
    next.add(serviceId);
    this.secrets.set(id, { ...secret, allowedServices: next });
  }

  revokeAccess(id: SecretId, serviceId: ServiceId): void {
    const secret = this.secrets.get(id);
    if (!secret) return;
    const next = new Set(secret.allowedServices);
    next.delete(serviceId);
    this.secrets.set(id, { ...secret, allowedServices: next });
  }

  canAccess(id: SecretId, serviceId: ServiceId): boolean {
    const secret = this.secrets.get(id);
    if (!secret) return false;
    return secret.allowedServices.has(serviceId);
  }

  getDescriptor(id: SecretId): Secret | undefined {
    return this.secrets.get(id);
  }

  /**
   * Build an immutable secret version. By default the secret's name is used
   * as AES-GCM associated data — this binds every ciphertext to its secret
   * identity, defeating ciphertext-swap attacks. Callers may override the
   * AAD via `opts.associatedData` (set to `""` to disable AAD entirely).
   */
  private makeVersion(
    name: string,
    value: string,
    version: number,
    opts: PutSecretOptions,
  ): SecretVersion {
    const shouldEncrypt = opts.encrypt ?? true;
    const ad = opts.associatedData !== undefined ? opts.associatedData : name;
    if (shouldEncrypt) {
      const blob = this.encryption.encrypt(value, ad);
      return {
        version,
        value: blob.ciphertext,
        iv: blob.iv,
        authTag: blob.authTag,
        createdAt: getClock().iso(),
        createdBy: opts.createdBy ?? "system",
        meta: { ...opts.meta, encrypted: "true", algorithm: blob.algorithm },
      };
    }
    return {
      version,
      value,
      iv: "",
      authTag: "",
      createdAt: getClock().iso(),
      createdBy: opts.createdBy ?? "system",
      meta: { ...opts.meta, encrypted: "false" },
    };
  }

  private decryptVersion(v: SecretVersion, associatedData: string): string {
    if (v.meta.encrypted === "false" || !v.authTag) {
      return v.value;
    }
    return this.encryption.decrypt(
      {
        ciphertext: v.value,
        iv: v.iv,
        authTag: v.authTag,
        algorithm: "AES-256-GCM",
      },
      associatedData,
    );
  }
}

// ---------------------------------------------------------------------------
// KeyManager — descriptors only; raw material lives in the EncryptionProvider
// ---------------------------------------------------------------------------

export interface CreateKeyInput {
  readonly algorithm: KeyAlgorithm;
  readonly purpose: KeyPurpose;
  readonly rotationPolicy?: RotationPolicy;
  readonly hsmBacked?: boolean;
  readonly description?: string;
  readonly expiresInDays?: number;
}

export class KeyManager {
  private readonly keys = new Map<string, KeyDescriptor>();

  constructor(private readonly provider: EncryptionProvider) {}

  createKey(input: CreateKeyInput): KeyDescriptor {
    const id = `key_${generateId()}`;
    const now = getClock().iso();
    const descriptor: KeyDescriptor = {
      id,
      algorithm: input.algorithm,
      purpose: input.purpose,
      rotationPolicy: input.rotationPolicy ?? { kind: "manual" },
      status: "active",
      createdAt: now,
      expiresAt: input.expiresInDays
        ? new Date(Date.now() + input.expiresInDays * 86_400_000).toISOString()
        : undefined,
      hsmBacked: input.hsmBacked ?? false,
      description: input.description,
    };
    this.keys.set(id, descriptor);
    return descriptor;
  }

  getKey(id: string): KeyDescriptor | undefined {
    return this.keys.get(id);
  }

  /** Rotate the underlying provider's key material and mark the descriptor. */
  rotateKey(id: string): KeyDescriptor {
    const key = this.keys.get(id);
    if (!key) throw new Error(`KeyManager.rotateKey: key ${id} not found`);
    const providerVersion = this.provider.rotate();
    const updated: KeyDescriptor = {
      ...key,
      status: "active",
      rotatedAt: getClock().iso(),
      description: `${key.description ?? ""} [rotated to ${providerVersion}]`.trim(),
    };
    this.keys.set(id, updated);

    void getEventBus().publish(
      buildEvent(
        "eks.kernel.security.key_rotated",
        {
          keyId: id,
          providerKeyVersion: providerVersion,
          algorithm: key.algorithm,
          purpose: key.purpose,
        },
        { actor: { kind: "service", id: "system" } },
        "system",
      ),
    );
    return updated;
  }

  revokeKey(id: string): void {
    const key = this.keys.get(id);
    if (!key) return;
    this.keys.set(id, { ...key, status: "revoked" });
  }

  list(): readonly KeyDescriptor[] {
    return [...this.keys.values()];
  }
}

// ---------------------------------------------------------------------------
// ServiceIdentityRegistry
// ---------------------------------------------------------------------------

export interface RegisterIdentityInput {
  readonly id?: ServiceId;
  readonly name: string;
  readonly zone: TrustZone;
  readonly permissions?: string[];
  readonly spiffeId?: string;
  readonly certFingerprint?: string;
  readonly tokenRef?: SecretId;
  readonly expiresAt?: string;
}

export class ServiceIdentityRegistry {
  private readonly identities = new Map<ServiceId, ServiceIdentity>();

  register(input: RegisterIdentityInput): ServiceIdentity {
    const id = input.id ?? (`svc_${generateId()}` as ServiceId);
    if (this.identities.has(id)) {
      throw new Error(`ServiceIdentityRegistry.register: identity ${id} already exists`);
    }
    const identity: ServiceIdentity = {
      id,
      name: input.name,
      zone: input.zone,
      permissions: input.permissions ?? [],
      credentials: {
        spiffeId: input.spiffeId,
        certFingerprint: input.certFingerprint,
        tokenRef: input.tokenRef,
        issuedAt: getClock().iso(),
        expiresAt: input.expiresAt,
      },
      registeredAt: getClock().iso(),
    };
    this.identities.set(id, identity);
    return identity;
  }

  get(id: ServiceId): ServiceIdentity | undefined {
    return this.identities.get(id);
  }

  list(): readonly ServiceIdentity[] {
    return [...this.identities.values()];
  }

  byZone(zone: TrustZone): readonly ServiceIdentity[] {
    return this.list().filter((i) => i.zone === zone);
  }
}

// ---------------------------------------------------------------------------
// Trust-zone traffic policy
// ---------------------------------------------------------------------------

/**
 * Real, deterministic trust-zone traffic matrix.
 *
 * Rules:
 *   1. Same-zone traffic is always permitted (lateral east-west inside a zone).
 *   2. Inward traffic permitted only along the canonical chain:
 *        public → dmz → internal → restricted → secure
 *      i.e. a destination accepts traffic only from its declared `ingressFrom`.
 *   3. Outward traffic permitted only along the same chain:
 *        a source may send only to its declared `egressTo`.
 *   4. Any traffic touching `public` from inside (secure→public, internal→public,
 *      …) is denied — the public zone may originate but never receive.
 */
export type TrustZonePolicy = (source: TrustZone, destination: TrustZone) => boolean;

export const defaultTrustZonePolicy: TrustZonePolicy = (source, destination) => {
  if (source === destination) return true;
  const destBoundary = SECURITY_BOUNDARIES.find((b) => b.zone === destination);
  const srcBoundary = SECURITY_BOUNDARIES.find((b) => b.zone === source);
  if (!destBoundary || !srcBoundary) return false;
  // The destination must accept traffic from the source's zone.
  const ingressAllowed = destBoundary.ingressFrom.includes(source);
  // The source must be permitted to egress to the destination's zone.
  const egressAllowed = srcBoundary.egressTo.includes(destination);
  return ingressAllowed && egressAllowed;
};

// ---------------------------------------------------------------------------
// Network segmentation helper — simple CIDR membership check
// ---------------------------------------------------------------------------

export function cidrContains(cidr: string, ip: string): boolean {
  const [base, prefixStr] = cidr.split("/");
  if (!base || !prefixStr) return false;
  const prefix = Number.parseInt(prefixStr, 10);
  if (Number.isNaN(prefix) || prefix < 0 || prefix > 32) return false;
  const baseParts = base.split(".").map((p) => Number.parseInt(p, 10));
  const ipParts = ip.split(".").map((p) => Number.parseInt(p, 10));
  if (baseParts.length !== 4 || ipParts.length !== 4) return false;
  if (baseParts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return false;
  if (ipParts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return false;
  const baseNum = ((baseParts[0] << 24) >>> 0) + (baseParts[1] << 16) + (baseParts[2] << 8) + baseParts[3];
  const ipNum = ((ipParts[0] << 24) >>> 0) + (ipParts[1] << 16) + (ipParts[2] << 8) + ipParts[3];
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (baseNum & mask) === (ipNum & mask);
}

// ---------------------------------------------------------------------------
// Facade singleton
// ---------------------------------------------------------------------------

export interface SecurityFacade {
  readonly secrets: SecretManager;
  readonly keys: KeyManager;
  readonly identities: ServiceIdentityRegistry;
  readonly encryption: EncryptionProvider;
  readonly zones: {
    readonly boundaries: readonly SecurityBoundary[];
    readonly policy: TrustZonePolicy;
    isAllowed: (source: TrustZone, destination: TrustZone) => boolean;
  };
}

let _security: SecurityFacade | null = null;

export function getSecurity(): SecurityFacade {
  if (!_security) {
    const encryption = new InMemoryEncryptionProvider();
    _security = {
      encryption,
      secrets: new SecretManager(encryption),
      keys: new KeyManager(encryption),
      identities: new ServiceIdentityRegistry(),
      zones: {
        boundaries: SECURITY_BOUNDARIES,
        policy: defaultTrustZonePolicy,
        isAllowed: defaultTrustZonePolicy,
      },
    };
  }
  return _security;
}

export function resetSecurity(): void {
  _security = null;
}
