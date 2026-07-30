/**
 * Eks-Health Research Platform — Privacy-Preserving Analytics
 *
 * K-anonymity, differential privacy readiness, pseudonymization, secure
 * query policies, noise injection, suppression of small populations.
 * No individual participant should be re-identifiable through research queries.
 */

import "server-only";
import { createHmac } from "node:crypto";
import { ResearchError } from "../core";

function require_privacy() { return { createHmac }; }

// ---------------------------------------------------------------------------
// Privacy configuration
// ---------------------------------------------------------------------------

export interface PrivacyConfig {
  readonly kAnonymityThreshold: number; // minimum group size (default 10)
  readonly noiseEpsilon: number; // differential privacy epsilon (default 1.0)
  readonly noiseDelta: number; // differential privacy delta (default 1e-5)
  readonly suppressionThreshold: number; // suppress groups smaller than this
  readonly enableNoiseInjection: boolean;
  readonly enableKAnonymity: boolean;
}

export const DEFAULT_PRIVACY_CONFIG: PrivacyConfig = {
  kAnonymityThreshold: 10,
  noiseEpsilon: 1.0,
  noiseDelta: 1e-5,
  suppressionThreshold: 5,
  enableNoiseInjection: true,
  enableKAnonymity: true,
};

// ---------------------------------------------------------------------------
// Privacy engine
// ---------------------------------------------------------------------------

export class PrivacyEngine {
  private config: PrivacyConfig = DEFAULT_PRIVACY_CONFIG;

  setConfig(config: Partial<PrivacyConfig>): void {
    this.config = { ...this.config, ...config };
  }

  getConfig(): PrivacyConfig {
    return this.config;
  }

  /** Enforce k-anonymity: suppress any group smaller than k. */
  enforceKAnonymity<T extends { count: number }>(groups: T[]): T[] {
    if (!this.config.enableKAnonymity) return groups;
    return groups.filter((g) => g.count >= this.config.kAnonymityThreshold);
  }

  /** Suppress small populations. */
  suppressSmallGroups<T extends { count: number }>(groups: T[]): T[] {
    return groups.filter((g) => g.count >= this.config.suppressionThreshold);
  }

  /** Inject Laplace noise for differential privacy. */
  injectNoise(value: number, sensitivity: number = 1): number {
    if (!this.config.enableNoiseInjection) return value;
    const scale = sensitivity / this.config.noiseEpsilon;
    const noise = laplaceNoise(scale);
    return Math.round((value + noise) * 100) / 100;
  }

  /** Pseudonymize an identifier using HMAC-SHA256. */
  pseudonymize(identifier: string, salt: string): string {
    const { createHmac } = require_privacy();
    return createHmac("sha256", salt).update(identifier).digest("hex").slice(0, 32);
  }

  /** Validate that a query result is privacy-safe. */
  validateQueryResult(result: { count: number; values?: unknown[] }): { safe: boolean; reason?: string } {
    if (result.count < this.config.suppressionThreshold) {
      return { safe: false, reason: `Result suppressed: only ${result.count} records (threshold: ${this.config.suppressionThreshold})` };
    }
    if (this.config.enableKAnonymity && result.count < this.config.kAnonymityThreshold) {
      return { safe: false, reason: `Result suppressed: k-anonymity violation (k=${this.config.kAnonymityThreshold}, actual=${result.count})` };
    }
    return { safe: true };
  }

  /** Apply privacy protections to a dataset of records. */
  protectDataset<T extends Record<string, unknown>>(records: T[], options: {
    pseudonymizeFields?: string[];
    suppressFields?: string[];
    salt?: string;
  }): T[] {
    let result = records;
    if (options.pseudonymizeFields && options.salt) {
      result = result.map((r) => {
        const protected_: Record<string, unknown> = { ...r };
        for (const f of options.pseudonymizeFields!) {
          if (protected_[f]) protected_[f] = this.pseudonymize(String(protected_[f]), options.salt!);
        }
        return protected_ as T;
      });
    }
    if (options.suppressFields) {
      result = result.map((r) => {
        const protected_: Record<string, unknown> = { ...r };
        for (const f of options.suppressFields!) {
          delete protected_[f];
        }
        return protected_ as T;
      });
    }
    return result;
  }

  /** Compute a safe aggregate (mean) with noise injection. */
  safeMean(values: number[]): { mean: number; sampleSize: number; noiseApplied: boolean } {
    if (values.length < this.config.suppressionThreshold) {
      throw new ResearchError({
        code: "eks.research.privacy.suppressed",
        category: "privacy_violation",
        message: `Cannot compute mean: only ${values.length} values (suppression threshold: ${this.config.suppressionThreshold})`,
        userMessage: "Not enough data to compute a privacy-safe result.",
      });
    }
    const rawMean = values.reduce((a, b) => a + b, 0) / values.length;
    const noisyMean = this.injectNoise(rawMean, 1);
    return { mean: noisyMean, sampleSize: values.length, noiseApplied: this.config.enableNoiseInjection };
  }

  /** Compute a safe count with noise injection. */
  safeCount(count: number): { count: number; noiseApplied: boolean } {
    if (count < this.config.suppressionThreshold) {
      throw new ResearchError({
        code: "eks.research.privacy.suppressed",
        category: "privacy_violation",
        message: `Count suppressed: only ${count} records`,
      });
    }
    return { count: Math.round(this.injectNoise(count, 1)), noiseApplied: this.config.enableNoiseInjection };
  }

  getStats() {
    return {
      config: this.config,
      kAnonymityThreshold: this.config.kAnonymityThreshold,
      suppressionThreshold: this.config.suppressionThreshold,
      noiseEnabled: this.config.enableNoiseInjection,
    };
  }
}

/** Laplace noise via inverse CDF method. */
function laplaceNoise(scale: number): number {
  const u = Math.random() - 0.5;
  return -scale * Math.sign(u) * Math.log(1 - 2 * Math.abs(u));
}

let _engine: PrivacyEngine | null = null;
export function getPrivacy(): PrivacyEngine {
  if (!_engine) _engine = new PrivacyEngine();
  return _engine;
}
