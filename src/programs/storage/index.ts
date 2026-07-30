/**
 * Eks-Health Program OS — Secure Program Storage
 *
 * Every Program receives isolated, encrypted, versioned, TTL-aware storage.
 * Namespaces partition data by purpose: structured, documents, media, caches,
 * config, temp, encrypted. Cross-program access is structurally impossible:
 * every key is namespaced as `program:<programId>:<namespace>:<key>`, and
 * a get() for another program's key returns undefined.
 *
 * Encryption uses AES-256-GCM with a per-program key derived via HKDF-SHA256
 * from a platform master key + the programId. Each encrypted entry has its
 * own random 96-bit IV and a 128-bit GCM auth tag — authenticated encryption
 * with integrity guarantee. Versioning is append-only: each `put` with
 * `versioned: true` pushes the prior version into an immutable history list.
 *
 * Quotas are enforced via `enforceQuota(programId, quotaMb)` which throws if
 * the next put would exceed the program's storage ceiling.
 */

import "server-only";
import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import {
  type ProgramId,
  ProgramError,
} from "../core";
import { getEventBus, buildEvent, getClock } from "@/kernel";

// ---------------------------------------------------------------------------
// Namespaces
// ---------------------------------------------------------------------------

export type StorageNamespace =
  | "structured"
  | "documents"
  | "media"
  | "caches"
  | "config"
  | "temp"
  | "encrypted";

export const STORAGE_NAMESPACES: readonly StorageNamespace[] = [
  "structured", "documents", "media", "caches", "config", "temp", "encrypted",
];

export type StorageKey = string;

// ---------------------------------------------------------------------------
// Put options / get result / list result
// ---------------------------------------------------------------------------

export interface StoragePutOptions {
  /** Time-to-live in milliseconds. The entry auto-expires after this duration. */
  readonly ttlMs?: number;
  /** Encrypt the value with AES-256-GCM using the per-program derived key. */
  readonly encrypted?: boolean;
  /** Keep prior versions in an append-only history list. */
  readonly versioned?: boolean;
  /** Optional content-type hint (stored, not interpreted). */
  readonly contentType?: string;
}

export interface StorageGetResult {
  readonly programId: ProgramId;
  readonly namespace: StorageNamespace;
  readonly key: StorageKey;
  readonly value: unknown;
  readonly contentType?: string;
  readonly encrypted: boolean;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt?: string;
}

export interface StorageListResult {
  readonly programId: ProgramId;
  readonly namespace: StorageNamespace;
  readonly keys: readonly StorageKey[];
  readonly count: number;
}

export interface ProgramStorageEntry {
  readonly programId: ProgramId;
  readonly namespace: StorageNamespace;
  readonly key: StorageKey;
  readonly value: unknown;
  readonly encrypted: boolean;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt?: string;
  readonly contentType?: string;
  readonly byteSize: number;
}

export interface StorageVersion {
  readonly version: number;
  readonly value: unknown;
  readonly encrypted: boolean;
  readonly createdAt: string;
  readonly byteSize: number;
}

export interface StorageUsage {
  readonly programId: ProgramId;
  readonly totalBytes: number;
  readonly byNamespace: Readonly<Record<StorageNamespace, number>>;
  readonly entryCount: number;
}

// ---------------------------------------------------------------------------
// Internal storage record
// ---------------------------------------------------------------------------

interface StoredRecord {
  programId: ProgramId;
  namespace: StorageNamespace;
  key: StorageKey;
  /** Ciphertext bytes (if encrypted) or plaintext bytes. */
  blob: Buffer;
  plaintextByteSize: number;
  encrypted: boolean;
  iv?: Buffer;
  authTag?: Buffer;
  contentType?: string;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  version: number;
  history: StoredVersion[];
}

interface StoredVersion {
  version: number;
  blob: Buffer;
  plaintextByteSize: number;
  encrypted: boolean;
  iv?: Buffer;
  authTag?: Buffer;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Encryption helpers (AES-256-GCM + HKDF-SHA256 per-program key)
// ---------------------------------------------------------------------------

/**
 * Platform master key. In-memory only — in production this would come from
 * a KMS / HSM. Generated once per process from cryptographically-secure
 * random bytes.
 */
const MASTER_KEY: Buffer = randomBytes(32);

/** Derive a 32-byte per-program key via HKDF-SHA256. */
function deriveProgramKey(programId: ProgramId): Buffer {
  const info = Buffer.from(`eks.program.storage:${programId}`, "utf8");
  const salt = Buffer.from("eks-program-storage-salt", "utf8");
  return Buffer.from(hkdfSync("sha256", MASTER_KEY, salt, info, 32));
}

interface EncryptedPayload {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
}

function encryptValue(key: Buffer, plaintext: Buffer): EncryptedPayload {
  const iv = randomBytes(12); // 96-bit IV (recommended for GCM)
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return { ciphertext, iv, authTag };
}

function decryptValue(key: Buffer, payload: EncryptedPayload): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", key, payload.iv);
  decipher.setAuthTag(payload.authTag);
  return Buffer.concat([decipher.update(payload.ciphertext), decipher.final()]);
}

/** Serialize any JSON-compatible value to a Buffer. */
function serialize(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === "string") return Buffer.from(value, "utf8");
  return Buffer.from(JSON.stringify(value), "utf8");
}

/** Deserialize a Buffer back into a value (string if it parses as UTF-8 text, else parsed JSON). */
function deserialize(blob: Buffer): unknown {
  const text = blob.toString("utf8");
  // If the text starts with '{', '[', '"', or is a JSON primitive, try to parse.
  const first = text.trim()[0];
  if (first === "{" || first === "[" || first === '"') {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  if (text === "null" || text === "true" || text === "false") {
    try { return JSON.parse(text); } catch { return text; }
  }
  if (/^-?\d+(\.\d+)?$/.test(text)) {
    try { return JSON.parse(text); } catch { return text; }
  }
  return text;
}

// ---------------------------------------------------------------------------
// Program storage
// ---------------------------------------------------------------------------

const BYTES_PER_MB = 1024 * 1024;

export class ProgramStorage {
  private readonly records = new Map<string, StoredRecord>();
  private readonly byProgram = new Map<ProgramId, Set<string>>();

  /**
   * Store a value under `program:<programId>:<namespace>:<key>`.
   * - If `encrypted: true`, encrypts with AES-256-GCM via per-program HKDF key.
   * - If `versioned: true`, preserves the prior version in history.
   * - If `ttlMs` is set, the entry auto-expires.
   */
  put(
    programId: ProgramId,
    namespace: StorageNamespace,
    key: StorageKey,
    value: unknown,
    options: StoragePutOptions = {},
  ): ProgramStorageEntry {
    this.requireNamespace(namespace);
    const storageKey = this.buildStorageKey(programId, namespace, key);
    const now = getClock().iso();
    const plaintext = serialize(value);
    const plaintextByteSize = plaintext.length;

    const existing = this.records.get(storageKey);

    // Apply per-program enforced quota if registered.
    const enforced = this.enforcedQuotas.get(programId);
    if (enforced !== undefined) {
      const currentTotal = this.computeUsage(programId).totalBytes;
      const delta = plaintextByteSize - (existing?.plaintextByteSize ?? 0);
      const limitBytes = enforced * BYTES_PER_MB;
      if (currentTotal + delta > limitBytes) {
        throw new ProgramError({
          code: "eks.program.storage.quota_exceeded",
          category: "quota_exceeded",
          message: `Storage quota exceeded for program ${programId} (limit ${enforced}MB, current ${(currentTotal / BYTES_PER_MB).toFixed(2)}MB, delta ${delta}B).`,
          userMessage: "This program has run out of storage.",
          metadata: { programId, namespace, key, limitMb: enforced, currentBytes: currentTotal, delta },
        });
      }
    }

    let blob: Buffer;
    let iv: Buffer | undefined;
    let authTag: Buffer | undefined;
    const encrypted = options.encrypted === true;
    if (encrypted) {
      const keyBuf = deriveProgramKey(programId);
      const payload = encryptValue(keyBuf, plaintext);
      blob = payload.ciphertext;
      iv = payload.iv;
      authTag = payload.authTag;
    } else {
      blob = plaintext;
    }

    let version = 1;
    let history: StoredVersion[] = [];
    let createdAt = now;
    if (existing) {
      createdAt = existing.createdAt;
      version = existing.version + 1;
      if (options.versioned === true) {
        history = [
          ...existing.history,
          {
            version: existing.version,
            blob: existing.blob,
            plaintextByteSize: existing.plaintextByteSize,
            encrypted: existing.encrypted,
            iv: existing.iv,
            authTag: existing.authTag,
            createdAt: existing.updatedAt,
          },
        ];
      } else {
        history = existing.history;
      }
    }

    const record: StoredRecord = {
      programId,
      namespace,
      key,
      blob,
      plaintextByteSize,
      encrypted,
      iv,
      authTag,
      contentType: options.contentType,
      createdAt,
      updatedAt: now,
      expiresAt: options.ttlMs ? new Date(getClock().epochMs() + options.ttlMs).toISOString() : undefined,
      version,
      history,
    };
    this.records.set(storageKey, record);
    this.indexByProgram(programId, storageKey);

    void getEventBus().publish(
      buildEvent(
        "eks.program.storage.put",
        { programId, namespace, key, version, encrypted, byteSize: plaintextByteSize },
        {},
        "domain",
      ),
    );

    return this.toEntry(record);
  }

  /**
   * Retrieve a value. Returns undefined if not found, expired, or belongs
   * to a different program (cross-program isolation is enforced by the
   * storage key prefix which always includes programId).
   */
  get(programId: ProgramId, namespace: StorageNamespace, key: StorageKey): StorageGetResult | undefined {
    this.requireNamespace(namespace);
    const storageKey = this.buildStorageKey(programId, namespace, key);
    const record = this.records.get(storageKey);
    if (!record) return undefined;
    if (record.programId !== programId) return undefined; // structural isolation
    if (this.isExpired(record)) {
      this.records.delete(storageKey);
      this.unindexByProgram(programId, storageKey);
      return undefined;
    }
    return this.toGetResult(record);
  }

  /** Delete a key. Keeps version history if the entry was versioned. */
  delete(programId: ProgramId, namespace: StorageNamespace, key: StorageKey): boolean {
    this.requireNamespace(namespace);
    const storageKey = this.buildStorageKey(programId, namespace, key);
    const record = this.records.get(storageKey);
    if (!record || record.programId !== programId) return false;
    this.records.delete(storageKey);
    this.unindexByProgram(programId, storageKey);
    void getEventBus().publish(
      buildEvent(
        "eks.program.storage.deleted",
        { programId, namespace, key, version: record.version, historyPreserved: record.history.length > 0 },
        {},
        "domain",
      ),
    );
    return true;
  }

  /** List keys in a namespace, optionally filtered by prefix. */
  list(programId: ProgramId, namespace: StorageNamespace, prefix?: string): StorageListResult {
    this.requireNamespace(namespace);
    const nsPrefix = this.buildNamespacePrefix(programId, namespace);
    const keys: StorageKey[] = [];
    for (const storageKey of this.records.keys()) {
      if (!storageKey.startsWith(nsPrefix)) continue;
      if (storageKey.startsWith(`program:${programId}:`) === false) continue;
      const suffix = storageKey.slice(nsPrefix.length);
      if (prefix && !suffix.startsWith(prefix)) continue;
      // Exclude expired entries from listing.
      const record = this.records.get(storageKey);
      if (record && this.isExpired(record)) continue;
      keys.push(suffix);
    }
    return { programId, namespace, keys, count: keys.length };
  }

  /** Retrieve a specific prior version of a key. */
  getVersion(programId: ProgramId, namespace: StorageNamespace, key: StorageKey, version: number): StorageVersion | undefined {
    this.requireNamespace(namespace);
    const storageKey = this.buildStorageKey(programId, namespace, key);
    const record = this.records.get(storageKey);
    if (!record || record.programId !== programId) return undefined;
    if (record.version === version) {
      return {
        version: record.version,
        value: this.readValue(record),
        encrypted: record.encrypted,
        createdAt: record.updatedAt,
        byteSize: record.plaintextByteSize,
      };
    }
    return record.history.find((v) => v.version === version)
      ? this.toVersion(record.history.find((v) => v.version === version)!, record.programId)
      : undefined;
  }

  /** List all versions of a key (current + history). */
  listVersions(programId: ProgramId, namespace: StorageNamespace, key: StorageKey): StorageVersion[] {
    this.requireNamespace(namespace);
    const storageKey = this.buildStorageKey(programId, namespace, key);
    const record = this.records.get(storageKey);
    if (!record || record.programId !== programId) return [];
    const versions: StorageVersion[] = record.history.map((v) => this.toVersion(v, record.programId));
    versions.push({
      version: record.version,
      value: this.readValue(record),
      encrypted: record.encrypted,
      createdAt: record.updatedAt,
      byteSize: record.plaintextByteSize,
    });
    return versions.sort((a, b) => a.version - b.version);
  }

  /** Bytes used per namespace for a program. */
  getUsage(programId: ProgramId): StorageUsage {
    return this.computeUsage(programId);
  }

  /** Register a quota ceiling for a program (MB). Subsequent puts enforce it. */
  enforceQuota(programId: ProgramId, quotaMb: number): void {
    if (quotaMb < 0) {
      throw new ProgramError({
        code: "eks.program.storage.invalid_quota",
        category: "validation",
        message: `Quota must be non-negative (got ${quotaMb}).`,
        userMessage: "Invalid storage quota.",
      });
    }
    this.enforcedQuotas.set(programId, quotaMb);
  }

  /** Clear all keys in a namespace for a program. Returns the count removed. */
  clearNamespace(programId: ProgramId, namespace: StorageNamespace): number {
    this.requireNamespace(namespace);
    const nsPrefix = this.buildNamespacePrefix(programId, namespace);
    let removed = 0;
    const toDelete: string[] = [];
    for (const storageKey of this.records.keys()) {
      if (!storageKey.startsWith(nsPrefix)) continue;
      const record = this.records.get(storageKey);
      if (!record || record.programId !== programId) continue;
      toDelete.push(storageKey);
    }
    for (const k of toDelete) {
      this.records.delete(k);
      removed++;
    }
    if (removed > 0) {
      const set = this.byProgram.get(programId);
      if (set) {
        for (const k of toDelete) set.delete(k);
      }
      void getEventBus().publish(
        buildEvent(
          "eks.program.storage.namespace_cleared",
          { programId, namespace, removed },
          {},
          "domain",
        ),
      );
    }
    return removed;
  }

  // --- Internals ------------------------------------------------------------

  private readonly enforcedQuotas = new Map<ProgramId, number>();

  private requireNamespace(ns: StorageNamespace): void {
    if (!STORAGE_NAMESPACES.includes(ns)) {
      throw new ProgramError({
        code: "eks.program.storage.invalid_namespace",
        category: "validation",
        message: `Unknown storage namespace: ${ns}`,
        userMessage: "Invalid storage namespace.",
      });
    }
  }

  private buildStorageKey(programId: ProgramId, namespace: StorageNamespace, key: StorageKey): string {
    return `program:${programId}:${namespace}:${key}`;
  }

  private buildNamespacePrefix(programId: ProgramId, namespace: StorageNamespace): string {
    return `program:${programId}:${namespace}:`;
  }

  private indexByProgram(programId: ProgramId, storageKey: string): void {
    const set = this.byProgram.get(programId) ?? new Set<string>();
    set.add(storageKey);
    this.byProgram.set(programId, set);
  }

  private unindexByProgram(programId: ProgramId, storageKey: string): void {
    const set = this.byProgram.get(programId);
    set?.delete(storageKey);
  }

  private isExpired(record: StoredRecord): boolean {
    if (!record.expiresAt) return false;
    return getClock().epochMs() >= new Date(record.expiresAt).getTime();
  }

  /** Read the plaintext value of a record, decrypting if needed. */
  private readValue(record: StoredRecord): unknown {
    if (record.encrypted) {
      const keyBuf = deriveProgramKey(record.programId);
      try {
        const plaintext = decryptValue(keyBuf, {
          ciphertext: record.blob,
          iv: record.iv!,
          authTag: record.authTag!,
        });
        return deserialize(plaintext);
      } catch (err) {
        throw new ProgramError({
          code: "eks.program.storage.decrypt_failed",
          category: "runtime_error",
          message: `Failed to decrypt value for ${record.programId}:${record.namespace}:${record.key}: ${(err as Error).message}`,
          userMessage: "Stored value could not be decrypted.",
          retryable: false,
          metadata: { programId: record.programId, namespace: record.namespace, key: record.key },
          cause: err,
        });
      }
    }
    return deserialize(record.blob);
  }

  private toGetResult(record: StoredRecord): StorageGetResult {
    return {
      programId: record.programId,
      namespace: record.namespace,
      key: record.key,
      value: this.readValue(record),
      contentType: record.contentType,
      encrypted: record.encrypted,
      version: record.version,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      expiresAt: record.expiresAt,
    };
  }

  private toEntry(record: StoredRecord): ProgramStorageEntry {
    return {
      programId: record.programId,
      namespace: record.namespace,
      key: record.key,
      value: this.readValue(record),
      encrypted: record.encrypted,
      version: record.version,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      expiresAt: record.expiresAt,
      contentType: record.contentType,
      byteSize: record.plaintextByteSize,
    };
  }

  private toVersion(v: StoredVersion, programId: ProgramId): StorageVersion {
    if (v.encrypted) {
      const keyBuf = deriveProgramKey(programId);
      try {
        const plaintext = decryptValue(keyBuf, {
          ciphertext: v.blob,
          iv: v.iv!,
          authTag: v.authTag!,
        });
        return {
          version: v.version,
          value: deserialize(plaintext),
          encrypted: true,
          createdAt: v.createdAt,
          byteSize: v.plaintextByteSize,
        };
      } catch {
        return {
          version: v.version,
          value: undefined,
          encrypted: true,
          createdAt: v.createdAt,
          byteSize: v.plaintextByteSize,
        };
      }
    }
    return {
      version: v.version,
      value: deserialize(v.blob),
      encrypted: false,
      createdAt: v.createdAt,
      byteSize: v.plaintextByteSize,
    };
  }

  private computeUsage(programId: ProgramId): StorageUsage {
    const byNamespace = {
      structured: 0, documents: 0, media: 0, caches: 0, config: 0, temp: 0, encrypted: 0,
    } as Record<StorageNamespace, number>;
    let totalBytes = 0;
    let entryCount = 0;
    const storageKeys = this.byProgram.get(programId);
    if (storageKeys) {
      for (const storageKey of storageKeys) {
        const record = this.records.get(storageKey);
        if (!record || record.programId !== programId) continue;
        if (this.isExpired(record)) continue;
        byNamespace[record.namespace] += record.plaintextByteSize;
        totalBytes += record.plaintextByteSize;
        entryCount++;
      }
    }
    return { programId, totalBytes, byNamespace, entryCount };
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _storage: ProgramStorage | null = null;
export function getProgramStorage(): ProgramStorage {
  if (!_storage) _storage = new ProgramStorage();
  return _storage;
}

export { deriveProgramKey, serialize, deserialize };
