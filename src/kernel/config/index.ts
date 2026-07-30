/**
 * Eks-Health Kernel — Configuration Platform
 *
 * Centralized, hierarchical configuration with override layers:
 *   defaults < environment < country < organization < program < runtime
 *
 * Supports live reload (subscribers), schema validation, and audit.
 * The default adapter is in-memory; production swaps in etcd/Consul/AppConfig.
 */

import type { ConfigKey } from "../core";
import { asConfigKey } from "../core";
import { getEventBus, buildEvent } from "../events";

export type ConfigValue = string | number | boolean | string[] | null;

export interface ConfigSchemaField {
  readonly key: string;
  readonly type: "string" | "number" | "boolean" | "string[]";
  readonly required?: boolean;
  readonly default?: ConfigValue;
  readonly sensitive?: boolean;
  readonly description?: string;
}

export interface ConfigSchema {
  readonly namespace: string;
  readonly fields: ConfigSchemaField[];
}

export type ConfigOverrideScope =
  | { kind: "environment"; name: string }
  | { kind: "country"; code: string }
  | { kind: "organization"; id: string }
  | { kind: "program"; id: string }
  | { kind: "runtime"; reason: string };

export interface ConfigOverride {
  readonly scope: ConfigOverrideScope;
  readonly values: Record<string, ConfigValue>;
  readonly updatedAt: string;
  readonly updatedBy: string;
}

export type ConfigChangeListener = (key: string, value: ConfigValue | undefined) => void;

export class ConfigurationManager {
  private readonly schemas = new Map<string, ConfigSchema>();
  private readonly defaults = new Map<string, ConfigValue>();
  private readonly overrides: ConfigOverride[] = [];
  private readonly listeners = new Set<ConfigChangeListener>();
  private readonly audit: ConfigAuditEntry[] = [];

  registerSchema(schema: ConfigSchema): void {
    this.schemas.set(schema.namespace, schema);
    for (const f of schema.fields) {
      if (f.default !== undefined) {
        this.defaults.set(`${schema.namespace}.${f.key}`, f.default);
      }
    }
  }

  getSchema(namespace: string): ConfigSchema | undefined {
    return this.schemas.get(namespace);
  }

  listSchemas(): ConfigSchema[] {
    return [...this.schemas.values()];
  }

  setOverride(override: ConfigOverride): void {
    this.overrides.push(override);
    this.audit.push({
      action: "set_override",
      scope: override.scope,
      at: new Date().toISOString(),
      by: override.updatedBy,
    });
    // Notify listeners for affected keys
    for (const key of Object.keys(override.values)) {
      this.listeners.forEach((l) => l(key, override.values[key]));
    }
    // Emit domain event for live reload across services
    void getEventBus().publish(
      buildEvent("eks.kernel.config.changed", { key: Object.keys(override.values) }, {}, "system"),
    );
  }

  listOverrides(): ConfigOverride[] {
    return [...this.overrides];
  }

  /** Resolve a config key against the full override stack (most-specific wins). */
  resolve(key: string, context?: ResolveContext): ConfigValue | undefined {
    const parts = key.split(".");
    const namespace = parts[0];
    const schema = this.schemas.get(namespace);
    let result: ConfigValue | undefined = this.defaults.get(key);

    // Apply overrides in priority order (later = more specific)
    const ordered = this.orderOverrides(context);
    for (const ov of ordered) {
      if (ov.values[key] !== undefined) {
        result = ov.values[key];
      }
    }
    // Validate against schema if available
    if (schema) {
      const field = schema.fields.find((f) => `${schema.namespace}.${f.key}` === key);
      if (field?.required && result === undefined) {
        return field.default;
      }
    }
    return result;
  }

  private orderOverrides(context?: ResolveContext): ConfigOverride[] {
    if (!context) return [...this.overrides];
    const priority: Record<string, number> = {};
    const rank = (o: ConfigOverride): number => {
      switch (o.scope.kind) {
        case "environment":
          return 1;
        case "country":
          return o.scope.code === context.country ? 2 : 0;
        case "organization":
          return o.scope.id === context.organizationId ? 3 : 0;
        case "program":
          return o.scope.id === context.programId ? 4 : 0;
        case "runtime":
          return 5;
      }
    };
    return this.overrides
      .map((o) => ({ o, r: rank(o) }))
      .filter((x) => x.r > 0)
      .sort((a, b) => a.r - b.r)
      .map((x) => x.o);
  }

  onChange(listener: ConfigChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getAudit(): ConfigAuditEntry[] {
    return [...this.audit];
  }
}

export interface ResolveContext {
  readonly country?: string;
  readonly organizationId?: string;
  readonly programId?: string;
}

export interface ConfigAuditEntry {
  readonly action: string;
  readonly scope: ConfigOverrideScope;
  readonly at: string;
  readonly by: string;
}

let _mgr: ConfigurationManager | null = null;
export function getConfiguration(): ConfigurationManager {
  if (!_mgr) _mgr = new ConfigurationManager();
  return _mgr;
}

/** Helper: typed key builder. */
export function cfgKey(namespace: string, key: string): ConfigKey {
  return asConfigKey(`${namespace}.${key}`);
}
