/**
 * Eks-Health Kernel — Boot Sequence
 *
 * Idempotently initializes the platform: registers schemas, flags, configs,
 * health checks, seeds the service registry, and emits the platform_started
 * event. Safe to call multiple times.
 */

import { getEventBus, buildEvent } from "./events";
import { getConfiguration, cfgKey } from "./config";
import { getFlags } from "./flags";
import { getTenants } from "./tenant";
import { getI18n } from "./i18n";
import { getStorage } from "./storage";
import { getSearch } from "./search";
import { getNotifications } from "./notification";
import { getScheduler } from "./scheduler";
import { getObservability } from "./observability";
import { getSecurity } from "./security";
import { getAI } from "./ai";
import { getGateway } from "./gateway";
import { getRegistry } from "./registry";
import { getClock } from "./core";

export interface KernelInfo {
  readonly name: string;
  readonly version: string;
  readonly bootedAt: string;
  readonly region: string;
  readonly subsystems: string[];
}

let _booted = false;
let _info: KernelInfo | null = null;

export function bootKernel(): KernelInfo {
  if (_booted && _info) return _info;

  // Touch every singleton so their default adapters & catalogs initialize.
  getEventBus();
  getConfiguration();
  getFlags();
  getTenants();
  getI18n();
  getStorage();
  getSearch();
  getNotifications();
  getScheduler();
  getObservability();
  getSecurity();
  getAI();
  getGateway();
  getRegistry();

  // Seed platform-level configuration schema
  const config = getConfiguration();
  config.registerSchema({
    namespace: "eks",
    fields: [
      { key: "platform.name", type: "string", default: "Eks-Health", description: "Platform display name" },
      { key: "platform.region", type: "string", default: "af-west-1", description: "Default region" },
      { key: "platform.timezone", type: "string", default: "UTC", description: "Default timezone" },
      { key: "platform.locale", type: "string", default: "en-US", description: "Default locale" },
      { key: "limits.maxTenantsPerOrg", type: "number", default: 1000, description: "Tenant limit" },
      { key: "limits.eventsRetentionDays", type: "number", default: 90, description: "Event history retention" },
      { key: "features.aiEnabled", type: "boolean", default: false, description: "Global AI gate" },
    ],
  });

  // Seed feature flags
  const flags = getFlags();
  if (flags.list().length === 0) {
    const now = getClock().iso();
    flags.register({ key: "eks.flag.kernel.console", description: "Platform Kernel Console visibility", type: "boolean", defaultVariant: "on", variants: ["on", "off"], rules: [], killSwitch: false, owner: "platform-team", createdAt: now });
    flags.register({ key: "eks.flag.marketplace.open", description: "Marketplace public access", type: "boolean", defaultVariant: "off", variants: ["on", "off"], rules: [{ kind: "organization", match: "org_beta", variant: "on" }], killSwitch: false, owner: "marketplace-team", createdAt: now });
    flags.register({ key: "eks.flag.ai.agents", description: "AI agent runtime", type: "boolean", defaultVariant: "off", variants: ["on", "off"], rules: [{ kind: "developer", match: "dev_1", variant: "on" }], killSwitch: true, dependsOn: ["eks.flag.kernel.console"], owner: "ai-team", createdAt: now });
    flags.register({ key: "eks.flag.measurements.ingest", description: "Measurement ingestion pipeline", type: "percentage", defaultVariant: "off", variants: ["on", "off"], rules: [], killSwitch: true, owner: "health-team", createdAt: now });
    flags.register({ key: "eks.flag.extensions.sandbox", description: "Third-party extension sandbox", type: "boolean", defaultVariant: "on", variants: ["on", "off"], rules: [{ kind: "country", match: "GH", variant: "on" }], killSwitch: false, owner: "runtime-team", createdAt: now });
    flags.register({ key: "eks.flag.notifications.webhooks", description: "Webhook notification channel", type: "boolean", defaultVariant: "on", variants: ["on", "off"], rules: [], killSwitch: false, owner: "platform-team", createdAt: now });
    flags.register({ key: "eks.flag.research.exports", description: "De-identified research exports", type: "boolean", defaultVariant: "off", variants: ["on", "off"], rules: [{ kind: "organization", match: "org_research", variant: "on" }], killSwitch: true, owner: "research-team", createdAt: now });
  }

  // Emit platform_started
  void getEventBus().publish(
    buildEvent("eks.kernel.system.platform_started", { version: kernelInfo().version, region: "af-west-1" }, {}, "system"),
  );

  _booted = true;
  _info = {
    name: "Eks-Health Platform Kernel",
    version: "1.0.0-m1",
    bootedAt: getClock().iso(),
    region: "af-west-1",
    subsystems: [
      "core", "events", "config", "flags", "tenant", "time", "i18n",
      "storage", "search", "notification", "scheduler", "observability",
      "security", "ai", "gateway", "registry",
    ],
  };
  return _info;
}

export function kernelInfo(): KernelInfo {
  if (!_info) {
    _info = {
      name: "Eks-Health Platform Kernel",
      version: "1.0.0-m1",
      bootedAt: getClock().iso(),
      region: "af-west-1",
      subsystems: [],
    };
  }
  return _info;
}

/** A compact diagnostic snapshot of the whole kernel for the console. */
export function kernelSnapshot() {
  const bus = getEventBus();
  const flags = getFlags();
  const config = getConfiguration();
  const scheduler = getScheduler();
  const obs = getObservability();
  const registry = getRegistry();
  const tenants = getTenants();
  const security = getSecurity();
  const gateway = getGateway();
  return {
    info: kernelInfo(),
    eventBus: bus.getStats(),
    events: { history: bus.getHistory().slice(-50), deadLetters: bus.getDeadLetters() },
    flags: { definitions: flags.list(), recentEvaluations: flags.getEvaluations().slice(-50), audit: flags.getAudit() },
    config: { schemas: config.listSchemas(), overrides: config.listOverrides(), audit: config.getAudit() },
    scheduler: { stats: scheduler.getStats(), jobs: scheduler.listJobs(), deadLetter: scheduler.getDeadLetterQueue() },
    observability: obs.snapshot(),
    services: registry.listServices(),
    contexts: registry.listContexts(),
    eventCatalog: registry.listEvents(),
    topology: registry.topology(),
    graph: registry.dependencyGraph(),
    tenants: tenants.list(),
    tenantAudit: tenants.getAudit(),
    security: {
      zones: security.zones.boundaries,
      secrets: security.secrets.list(),
      keys: security.keys.list(),
      identities: security.identities.list(),
    },
    gateway: {
      routes: gateway.gateway.listRoutes(),
      upstreams: gateway.gateway.listUpstreams(),
    },
  };
}
