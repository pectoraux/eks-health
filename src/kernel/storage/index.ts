/**
 * Eks-Health Kernel — File / Object Storage Abstraction
 *
 * The platform's binary storage layer. Documents, medical evidence, images,
 * videos, program assets, avatars, extension packages, logs, and exports all
 * flow through this single abstraction. No specific storage backend is
 * hardcoded — providers register against a uniform `StorageProvider` interface.
 *
 * Capabilities:
 *  - Pluggable providers (S3, GCS, Azure Blob, MinIO, in-memory default)
 *  - Bucket registry with per-category policies (max size, allowed MIME types)
 *  - Storage classes (standard / infrequent / glacier) for tiering
 *  - ACLs (private / public-read / authenticated-read / tenant-read)
 *  - Signed URL issuance for time-limited access
 *  - BlobRef branded references that point at a (bucket, key) pair
 *
 * The default adapter is in-memory; production swaps in S3/GCS without
 * touching application code.
 */

import type { Brand, TenantId } from "../core";
import { ValidationError, NotFoundError, generateId, getClock } from "../core";

// ---------------------------------------------------------------------------
// Branded types
// ---------------------------------------------------------------------------

/** A stable, opaque reference to a stored blob. */
export type BlobRef = Brand<string, "BlobRef">;

/** A MIME type string, e.g. "application/pdf". */
export type MimeType = string;

export function asBlobRef(s: string): BlobRef {
  return s as BlobRef;
}

// ---------------------------------------------------------------------------
// Storage primitives
// ---------------------------------------------------------------------------

export type StorageClass = "standard" | "infrequent" | "glacier";

export type StorageAcl =
  | "private"
  | "public-read"
  | "authenticated-read"
  | "tenant-read";

/** A registered bucket. Category drives policy lookup. */
export interface StorageBucket {
  readonly name: string;
  readonly category: BucketCategory;
  readonly description?: string;
  readonly versioningEnabled?: boolean;
  readonly defaultStorageClass?: StorageClass;
  readonly defaultAcl?: StorageAcl;
  readonly tenantId?: TenantId;
  readonly createdAt: string;
}

/** A stored object including its bytes. */
export interface StorageObject {
  readonly bucket: string;
  readonly key: string;
  readonly body: Uint8Array;
  readonly contentType: MimeType;
  readonly contentLength: number;
  readonly storageClass: StorageClass;
  readonly metadata: Readonly<Record<string, string>>;
  readonly acl: StorageAcl;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly etag: string;
  readonly blobRef: BlobRef;
}

/** Stat response: object metadata without the (potentially large) body. */
export type ObjectStat = Omit<StorageObject, "body">;

export interface UploadRequest {
  readonly key: string;
  readonly body: Uint8Array | string;
  readonly contentType: MimeType;
  readonly storageClass?: StorageClass;
  readonly metadata?: Record<string, string>;
  readonly acl?: StorageAcl;
  readonly contentLength?: number; // override; computed from body otherwise
}

export interface UploadResult {
  readonly bucket: string;
  readonly key: string;
  readonly blobRef: BlobRef;
  readonly etag: string;
  readonly contentLength: number;
  readonly contentType: MimeType;
  readonly storageClass: StorageClass;
  readonly location: string;
  readonly createdAt: string;
}

export interface ListResult {
  readonly bucket: string;
  readonly prefix: string;
  readonly keys: readonly string[];
}

// ---------------------------------------------------------------------------
// Provider contract
// ---------------------------------------------------------------------------

export interface StorageProvider {
  readonly name: string;
  put(bucket: string, req: UploadRequest): Promise<UploadResult>;
  get(bucket: string, key: string): Promise<StorageObject | null>;
  delete(bucket: string, key: string): Promise<boolean>;
  stat(bucket: string, key: string): Promise<ObjectStat | null>;
  list(bucket: string, prefix?: string): Promise<readonly string[]>;
  signedUrl(bucket: string, key: string, ttlSeconds: number): Promise<string>;
}

// ---------------------------------------------------------------------------
// Bucket catalog & policies
// ---------------------------------------------------------------------------

export const BUCKETS = {
  documents: "documents",
  medicalEvidence: "medical-evidence",
  images: "images",
  videos: "videos",
  programAssets: "program-assets",
  avatars: "avatars",
  extensionPackages: "extension-packages",
  logs: "logs",
  exports: "exports",
} as const;

export type BucketCategory = keyof typeof BUCKETS;
export type BucketName = (typeof BUCKETS)[BucketCategory];

export interface BucketPolicy {
  readonly category: BucketCategory;
  readonly maxBytes: number;
  readonly allowedMimeTypes: readonly MimeType[] | "*";
  readonly defaultStorageClass: StorageClass;
  readonly defaultAcl: StorageAcl;
  readonly description: string;
}

const MB = 1024 * 1024;

export const BUCKET_POLICIES: Record<BucketCategory, BucketPolicy> = {
  documents: {
    category: "documents",
    maxBytes: 50 * MB,
    allowedMimeTypes: [
      "application/pdf",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.oasis.opendocument.text",
      "text/plain",
      "text/markdown",
      "application/rtf",
    ],
    defaultStorageClass: "standard",
    defaultAcl: "private",
    description: "User-uploaded documents (PDFs, Word, text).",
  },
  medicalEvidence: {
    category: "medicalEvidence",
    maxBytes: 100 * MB,
    allowedMimeTypes: [
      "application/pdf",
      "image/dicom",
      "image/png",
      "image/jpeg",
      "image/tiff",
    ],
    defaultStorageClass: "standard",
    defaultAcl: "private",
    description: "Clinical evidence, lab reports, scans (PHI).",
  },
  images: {
    category: "images",
    maxBytes: 25 * MB,
    allowedMimeTypes: [
      "image/png",
      "image/jpeg",
      "image/webp",
      "image/gif",
      "image/avif",
      "image/svg+xml",
    ],
    defaultStorageClass: "standard",
    defaultAcl: "public-read",
    description: "General-purpose images (article figures, hero, etc.).",
  },
  videos: {
    category: "videos",
    maxBytes: 500 * MB,
    allowedMimeTypes: ["video/mp4", "video/webm", "video/quicktime", "video/ogg"],
    defaultStorageClass: "standard",
    defaultAcl: "public-read",
    description: "Encrypted program / educational videos.",
  },
  programAssets: {
    category: "programAssets",
    maxBytes: 50 * MB,
    allowedMimeTypes: "*",
    defaultStorageClass: "standard",
    defaultAcl: "public-read",
    description: "Static assets bundled with health programs.",
  },
  avatars: {
    category: "avatars",
    maxBytes: 5 * MB,
    allowedMimeTypes: ["image/png", "image/jpeg", "image/webp"],
    defaultStorageClass: "standard",
    defaultAcl: "public-read",
    description: "User profile avatars.",
  },
  extensionPackages: {
    category: "extensionPackages",
    maxBytes: 100 * MB,
    allowedMimeTypes: [
      "application/zip",
      "application/gzip",
      "application/x-tar",
      "application/x-bzip2",
      "application/octet-stream",
    ],
    defaultStorageClass: "standard",
    defaultAcl: "private",
    description: "Signed extension / plugin packages.",
  },
  logs: {
    category: "logs",
    maxBytes: 1024 * MB,
    allowedMimeTypes: [
      "text/plain",
      "application/json",
      "application/x-ndjson",
      "application/octet-stream",
    ],
    defaultStorageClass: "infrequent",
    defaultAcl: "private",
    description: "Audit & operational logs (write-once, tiered).",
  },
  exports: {
    category: "exports",
    maxBytes: 500 * MB,
    allowedMimeTypes: [
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.ms-excel",
      "application/json",
      "text/csv",
      "application/zip",
    ],
    defaultStorageClass: "infrequent",
    defaultAcl: "private",
    description: "Generated exports & reports (TTL-evicted).",
  },
};

// ---------------------------------------------------------------------------
// In-memory provider (default adapter)
// ---------------------------------------------------------------------------

interface StoredRecord {
  readonly bucket: string;
  readonly key: string;
  readonly body: Uint8Array;
  readonly contentLength: number;
  readonly contentType: MimeType;
  readonly storageClass: StorageClass;
  readonly metadata: Record<string, string>;
  readonly acl: StorageAcl;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly etag: string;
  readonly blobRef: BlobRef;
}

function toBytes(body: Uint8Array | string): Uint8Array {
  if (typeof body === "string") {
    return new TextEncoder().encode(body);
  }
  return body;
}

function computeEtag(body: Uint8Array): string {
  // Lightweight FNV-1a hash for an etag-like identifier. Real providers
  // use MD5/SHA-256; this is sufficient for the in-memory adapter.
  let h = 0x811c9dc5;
  for (let i = 0; i < body.length; i++) {
    h ^= body[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `"${body.length.toString(16)}-${h.toString(16).padStart(8, "0")}"`;
}

export class InMemoryStorageProvider implements StorageProvider {
  readonly name = "in-memory";
  private readonly store = new Map<string, StoredRecord>();

  private keyOf(bucket: string, key: string): string {
    return `${bucket}::${key}`;
  }

  async put(bucket: string, req: UploadRequest): Promise<UploadResult> {
    const body = toBytes(req.body);
    const now = getClock().iso();
    const etag = computeEtag(body);
    const blobRef = asBlobRef(`blob://${bucket}/${req.key}`);
    const record: StoredRecord = {
      bucket,
      key: req.key,
      body,
      contentLength: body.length,
      contentType: req.contentType,
      storageClass: req.storageClass ?? "standard",
      metadata: { ...(req.metadata ?? {}) },
      acl: req.acl ?? "private",
      createdAt: now,
      updatedAt: now,
      etag,
      blobRef,
    };
    this.store.set(this.keyOf(bucket, req.key), record);
    return {
      bucket,
      key: req.key,
      blobRef,
      etag,
      contentLength: body.length,
      contentType: record.contentType,
      storageClass: record.storageClass,
      location: `mem://${bucket}/${req.key}`,
      createdAt: now,
    };
  }

  async get(bucket: string, key: string): Promise<StorageObject | null> {
    const rec = this.store.get(this.keyOf(bucket, key));
    if (!rec) return null;
    return { ...rec, body: rec.body.slice(), metadata: { ...rec.metadata } };
  }

  async delete(bucket: string, key: string): Promise<boolean> {
    return this.store.delete(this.keyOf(bucket, key));
  }

  async stat(bucket: string, key: string): Promise<ObjectStat | null> {
    const rec = this.store.get(this.keyOf(bucket, key));
    if (!rec) return null;
    const { body: _body, ...stat } = rec;
    void _body;
    return { ...stat, metadata: { ...stat.metadata } };
  }

  async list(bucket: string, prefix = ""): Promise<readonly string[]> {
    const out: string[] = [];
    const prefixKey = `${bucket}::${prefix}`;
    for (const k of this.store.keys()) {
      if (prefix === "") {
        if (k.startsWith(`${bucket}::`)) {
          out.push(k.slice(bucket.length + 2));
        }
      } else if (k.startsWith(prefixKey)) {
        out.push(k.slice(bucket.length + 2));
      }
    }
    return out.sort();
  }

  async signedUrl(bucket: string, key: string, ttlSeconds: number): Promise<string> {
    const exists = this.store.has(this.keyOf(bucket, key));
    if (!exists) {
      throw new NotFoundError(
        "eks.error.storage.object_not_found",
        `Object ${bucket}/${key} not found`,
        "The requested object does not exist.",
      );
    }
    const expires = getClock().epochMs() + ttlSeconds * 1000;
    const sig = generateId("sig_");
    return `mem://${bucket}/${key}?expires=${expires}&sig=${sig}`;
  }

  /** Test/maintenance hook. */
  clear(): void {
    this.store.clear();
  }

  size(): number {
    return this.store.size;
  }
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

export interface StorageStats {
  readonly registeredProviders: number;
  readonly registeredBuckets: number;
  readonly defaultProvider: string | null;
}

export class StorageManager {
  private readonly providers = new Map<string, StorageProvider>();
  private readonly buckets = new Map<string, StorageBucket>();
  private readonly categoryIndex = new Map<string, BucketCategory>();
  private defaultProvider: string | null = null;

  constructor() {
    // Register the default in-memory provider and make it the default.
    const mem = new InMemoryStorageProvider();
    this.providers.set(mem.name, mem);
    this.defaultProvider = mem.name;
    // Auto-register the well-known catalog.
    for (const category of Object.keys(BUCKETS) as BucketCategory[]) {
      const policy = BUCKET_POLICIES[category];
      const bucket: StorageBucket = {
        name: BUCKETS[category],
        category,
        description: policy.description,
        versioningEnabled: category === "medicalEvidence" || category === "logs",
        defaultStorageClass: policy.defaultStorageClass,
        defaultAcl: policy.defaultAcl,
        createdAt: getClock().iso(),
      };
      this.buckets.set(bucket.name, bucket);
      this.categoryIndex.set(bucket.name, category);
    }
  }

  registerProvider(name: string, provider: StorageProvider): void {
    this.providers.set(name, provider);
    if (this.defaultProvider === null) {
      this.defaultProvider = name;
    }
  }

  setDefault(name: string): void {
    if (!this.providers.has(name)) {
      throw new NotFoundError(
        "eks.error.storage.provider_not_found",
        `Storage provider '${name}' is not registered`,
        "Storage provider is not configured.",
      );
    }
    this.defaultProvider = name;
  }

  getDefault(): StorageProvider {
    if (!this.defaultProvider) {
      throw new NotFoundError(
        "eks.error.storage.no_default_provider",
        "No default storage provider is configured",
        "Storage is not configured.",
      );
    }
    const p = this.providers.get(this.defaultProvider);
    if (!p) {
      throw new NotFoundError(
        "eks.error.storage.provider_not_found",
        `Default storage provider '${this.defaultProvider}' is missing`,
        "Storage is not configured.",
      );
    }
    return p;
  }

  getProvider(name: string): StorageProvider | undefined {
    return this.providers.get(name);
  }

  listProviders(): readonly string[] {
    return [...this.providers.keys()];
  }

  registerBucket(bucket: StorageBucket): void {
    if (!BUCKET_POLICIES[bucket.category]) {
      throw new ValidationError(
        "eks.error.storage.unknown_bucket_category",
        `Unknown bucket category '${bucket.category}'`,
        "Invalid bucket configuration.",
      );
    }
    this.buckets.set(bucket.name, bucket);
    this.categoryIndex.set(bucket.name, bucket.category);
  }

  listBuckets(): readonly StorageBucket[] {
    return [...this.buckets.values()];
  }

  getBucket(name: string): StorageBucket | undefined {
    return this.buckets.get(name);
  }

  /** Resolve a bucket name to its policy. Throws if the bucket is unknown. */
  private resolvePolicy(bucket: string): BucketPolicy {
    const category = this.categoryIndex.get(bucket);
    if (!category) {
      throw new NotFoundError(
        "eks.error.storage.bucket_not_found",
        `Bucket '${bucket}' is not registered`,
        "Storage bucket is not configured.",
      );
    }
    return BUCKET_POLICIES[category];
  }

  /** Enforce a policy against an upload request. Throws ValidationError. */
  private enforcePolicy(bucket: string, req: UploadRequest, bodyBytes: number): void {
    const policy = this.resolvePolicy(bucket);
    if (bodyBytes > policy.maxBytes) {
      throw new ValidationError(
        "eks.error.storage.object_too_large",
        `Object size ${bodyBytes} bytes exceeds limit ${policy.maxBytes} for bucket '${bucket}'`,
        "The file you are uploading is too large.",
      );
    }
    if (policy.allowedMimeTypes !== "*") {
      const allowed = policy.allowedMimeTypes as readonly MimeType[];
      // Allow base type only (strip ;parameters).
      const baseType = req.contentType.split(";")[0].trim().toLowerCase();
      const ok = allowed.some(
        (m) => m.toLowerCase() === baseType || m.toLowerCase() === req.contentType.toLowerCase(),
      );
      if (!ok) {
        throw new ValidationError(
          "eks.error.storage.unsupported_mime_type",
          `MIME type '${req.contentType}' not permitted in bucket '${bucket}'`,
          "This file type is not allowed.",
        );
      }
    }
  }

  async put(bucket: string, req: UploadRequest): Promise<UploadResult> {
    const policy = this.resolvePolicy(bucket);
    const bodyBytes = req.contentLength ?? toBytes(req.body).length;
    this.enforcePolicy(bucket, req, bodyBytes);
    const provider = this.getDefault();
    // Apply bucket defaults if caller didn't override.
    const enriched: UploadRequest = {
      ...req,
      storageClass: req.storageClass ?? policy.defaultStorageClass,
      acl: req.acl ?? policy.defaultAcl,
      contentLength: bodyBytes,
    };
    return provider.put(bucket, enriched);
  }

  async get(bucket: string, key: string): Promise<StorageObject | null> {
    this.resolvePolicy(bucket);
    return this.getDefault().get(bucket, key);
  }

  async delete(bucket: string, key: string): Promise<boolean> {
    this.resolvePolicy(bucket);
    return this.getDefault().delete(bucket, key);
  }

  async stat(bucket: string, key: string): Promise<ObjectStat | null> {
    this.resolvePolicy(bucket);
    return this.getDefault().stat(bucket, key);
  }

  async list(bucket: string, prefix = ""): Promise<ListResult> {
    this.resolvePolicy(bucket);
    const keys = await this.getDefault().list(bucket, prefix);
    return { bucket, prefix, keys };
  }

  async signedUrl(bucket: string, key: string, ttlSeconds = 900): Promise<string> {
    this.resolvePolicy(bucket);
    return this.getDefault().signedUrl(bucket, key, ttlSeconds);
  }

  stats(): StorageStats {
    return {
      registeredProviders: this.providers.size,
      registeredBuckets: this.buckets.size,
      defaultProvider: this.defaultProvider,
    };
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _storage: StorageManager | null = null;

export function getStorage(): StorageManager {
  if (!_storage) _storage = new StorageManager();
  return _storage;
}

export function setStorage(mgr: StorageManager): void {
  _storage = mgr;
}

export function resetStorage(): void {
  _storage = null;
}
