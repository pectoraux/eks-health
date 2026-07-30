/**
 * Eks-Health Kernel — Service Registry & Platform Topology
 *
 * The canonical catalog of every service in the platform, their bounded
 * contexts, contracts, dependencies, ownership, and lifecycle state.
 *
 * This is the single source of truth for "what services exist". The gateway,
 * observability, and developer portal all read from here. New services are
 * added here — never by restructuring the kernel.
 */

import type { Protocol, ServiceContractEndpoint, LifecycleState, Region } from "../core";
import { getEventBus, buildEvent } from "../events";

// ---------------------------------------------------------------------------
// Service descriptor
// ---------------------------------------------------------------------------

export interface ServiceDescriptor {
  readonly id: string; // e.g. "identity"
  readonly name: string;
  readonly slug: string;
  readonly category: ServiceCategory;
  readonly summary: string;
  readonly boundedContext: string; // bounded context id
  readonly endpoints: ServiceContractEndpoint[];
  readonly dependencies: string[]; // other service ids
  readonly consumesEvents: string[]; // event type globs
  readonly producesEvents: string[];
  readonly owner: string;
  readonly state: LifecycleState;
  readonly regions: Region[];
  readonly sla: string; // e.g. "99.95%"
  readonly dataClassification: "public" | "internal" | "confidential" | "restricted";
  readonly extensibility: "core" | "standard" | "extension";
  readonly contractVersion: string;
  readonly openApiPath: string;
}

export type ServiceCategory =
  | "platform"
  | "identity"
  | "runtime"
  | "data"
  | "integration"
  | "ai"
  | "developer"
  | "marketplace"
  | "governance";

// ---------------------------------------------------------------------------
// Bounded Context (DDD)
// ---------------------------------------------------------------------------

export interface BoundedContext {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly ubiquitousLanguage: { term: string; definition: string }[];
  readonly aggregates: string[];
  readonly entities: string[];
  readonly valueObjects: string[];
  readonly domainEvents: string[];
  readonly domainServices: string[];
  readonly policies: string[];
  readonly owner: string;
  readonly sharedKernel?: string[];
  readonly antiCorruptionLayer?: string[];
}

// ---------------------------------------------------------------------------
// Event Catalog entry
// ---------------------------------------------------------------------------

export interface EventCatalogEntry {
  readonly type: string; // e.g. "eks.kernel.tenant.provisioned"
  readonly kind: "domain" | "integration" | "system" | "scheduled";
  readonly producer: string; // service id
  readonly consumers: string[];
  readonly schemaVersion: number;
  readonly payloadSchema: { field: string; type: string; required: boolean; description: string }[];
  readonly description: string;
  readonly retryable: boolean;
  readonly ordered: boolean;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export class ServiceRegistry {
  private readonly services = new Map<string, ServiceDescriptor>();
  private readonly contexts = new Map<string, BoundedContext>();
  private readonly events = new Map<string, EventCatalogEntry>();

  registerService(svc: ServiceDescriptor): void {
    this.services.set(svc.id, svc);
    void getEventBus().publish(
      buildEvent(
        "eks.kernel.system.service_registered",
        { serviceId: svc.id, name: svc.name },
        {},
        "system",
      ),
    );
  }

  registerContext(ctx: BoundedContext): void {
    this.contexts.set(ctx.id, ctx);
  }

  registerEvent(evt: EventCatalogEntry): void {
    this.events.set(evt.type, evt);
  }

  getService(id: string): ServiceDescriptor | undefined {
    return this.services.get(id);
  }
  listServices(): ServiceDescriptor[] {
    return [...this.services.values()];
  }
  servicesByCategory(cat: ServiceCategory): ServiceDescriptor[] {
    return this.listServices().filter((s) => s.category === cat);
  }

  getContext(id: string): BoundedContext | undefined {
    return this.contexts.get(id);
  }
  listContexts(): BoundedContext[] {
    return [...this.contexts.values()];
  }

  getEvent(type: string): EventCatalogEntry | undefined {
    return this.events.get(type);
  }
  listEvents(): EventCatalogEntry[] {
    return [...this.events.values()];
  }

  /** Build a directed dependency graph (for visualization). */
  dependencyGraph(): { nodes: { id: string; label: string; category: ServiceCategory }[]; edges: { from: string; to: string }[] } {
    const nodes = this.listServices().map((s) => ({ id: s.id, label: s.name, category: s.category }));
    const edges: { from: string; to: string }[] = [];
    for (const s of this.listServices()) {
      for (const dep of s.dependencies) {
        if (this.services.has(dep)) {
          edges.push({ from: s.id, to: dep });
        }
      }
    }
    return { nodes, edges };
  }

  /** Topology: services grouped by category with counts. */
  topology(): { category: ServiceCategory; count: number; services: string[] }[] {
    const cats: ServiceCategory[] = [
      "platform",
      "identity",
      "runtime",
      "data",
      "integration",
      "ai",
      "developer",
      "marketplace",
      "governance",
    ];
    return cats.map((c) => {
      const list = this.servicesByCategory(c);
      return { category: c, count: list.length, services: list.map((s) => s.id) };
    });
  }
}

let _registry: ServiceRegistry | null = null;
export function getRegistry(): ServiceRegistry {
  if (!_registry) {
    _registry = new ServiceRegistry();
    seedRegistry(_registry);
  }
  return _registry;
}

// ---------------------------------------------------------------------------
// Seed data — the platform's service topology, bounded contexts & event catalog
// ---------------------------------------------------------------------------

function seedRegistry(reg: ServiceRegistry): void {
  // ---- Bounded Contexts ----
  const contexts: BoundedContext[] = [
    {
      id: "kernel",
      name: "Platform Kernel",
      description:
        "The operating-system core: identity of services, event bus, configuration, feature flags, scheduling, observability. Owns no healthcare concepts.",
      ubiquitousLanguage: [
        { term: "Service", definition: "An independently deployable unit with a contract." },
        { term: "Event", definition: "An immutable, timestamped fact published to the bus." },
        { term: "Tenant", definition: "An isolated customer boundary (individual, org, government)." },
        { term: "Flag", definition: "A runtime-toggleable capability with rollout rules." },
      ],
      aggregates: ["Service", "EventStream", "Tenant", "Flag", "Config"],
      entities: ["Subscription", "Job", "Span", "Metric"],
      valueObjects: ["CorrelationId", "CausationId", "TraceId", "Timezone", "Locale"],
      domainEvents: ["eks.kernel.system.service_registered", "eks.kernel.tenant.provisioned", "eks.kernel.flag.toggled", "eks.kernel.config.changed"],
      domainServices: ["EventBus", "Scheduler", "HealthRegistry"],
      policies: ["IdempotencyByEventId", "OrderedByPartitionKey", "RetryWithBackoff", "DeadLetterAfterMaxRetries"],
      owner: "platform-team",
    },
    {
      id: "identity",
      name: "Identity & Access",
      description: "Authentication, authorization, service identity, credential lifecycle. NOT implemented in M1 — boundary reserved.",
      ubiquitousLanguage: [
        { term: "Principal", definition: "A user, service, or agent that can be authenticated." },
        { term: "Session", definition: "A time-bounded authenticated context." },
        { term: "Role", definition: "A named set of permissions." },
      ],
      aggregates: ["Principal", "Session", "Role"],
      entities: ["Credential", "ApiKey"],
      valueObjects: ["Permission", "Scope"],
      domainEvents: [],
      domainServices: [],
      policies: ["LeastPrivilege", "RotateCredentials"],
      owner: "identity-team",
    },
    {
      id: "tenancy",
      name: "Organizations & Tenancy",
      description: "Tenant provisioning, isolation, quotas, memberships, tiering.",
      ubiquitousLanguage: [
        { term: "Tenant", definition: "An isolated customer boundary." },
        { term: "Tier", definition: "A service level (free, growth, enterprise, government)." },
        { term: "Quota", definition: "Per-tenant resource limits." },
      ],
      aggregates: ["Tenant", "Membership", "Quota"],
      entities: ["Invitation"],
      valueObjects: ["TenantType", "IsolationLevel", "Tier"],
      domainEvents: ["eks.kernel.tenant.provisioned", "eks.kernel.tenant.suspended"],
      domainServices: ["TenantProvisioningService"],
      policies: ["EnforceIsolation", "EnforceQuota"],
      owner: "platform-team",
    },
    {
      id: "config",
      name: "Configuration & Flags",
      description: "Hierarchical configuration and feature flag management.",
      ubiquitousLanguage: [
        { term: "ConfigKey", definition: "A namespaced configuration identifier." },
        { term: "Override", definition: "A scoped value that supersedes defaults." },
        { term: "Flag", definition: "A runtime capability toggle with rollout rules." },
      ],
      aggregates: ["ConfigSchema", "Flag"],
      entities: ["Override", "Evaluation", "AuditEntry"],
      valueObjects: ["Scope", "Variant", "Rule"],
      domainEvents: ["eks.kernel.config.changed", "eks.kernel.flag.toggled"],
      domainServices: ["ConfigurationService", "FlagService"],
      policies: ["MostSpecificOverrideWins", "KillSwitchOverridesAll", "DependencyCheckBeforeEvaluate"],
      owner: "platform-team",
    },
    {
      id: "extension-runtime",
      name: "Extension Runtime",
      description: "Sandboxed execution environment for third-party Programs and plugins.",
      ubiquitousLanguage: [
        { term: "Extension", definition: "A third-party module loaded into the runtime." },
        { term: "Manifest", definition: "An extension's declared capabilities." },
        { term: "Capability", definition: "A permission-granted resource access." },
      ],
      aggregates: ["Extension", "Manifest"],
      entities: ["ExtensionInstance", "Hook"],
      valueObjects: ["Capability", "ExtensionVersion"],
      domainEvents: [],
      domainServices: [],
      policies: ["SandboxByDefault", "CapabilityBasedAccess"],
      owner: "runtime-team",
    },
    {
      id: "measurement",
      name: "Measurement",
      description: "Health measurement ingestion, normalization, validation. Reserved for future milestones.",
      ubiquitousLanguage: [
        { term: "Measurement", definition: "A single health observation." },
        { term: "Metric", definition: "A typed measurable quantity." },
      ],
      aggregates: [],
      entities: [],
      valueObjects: [],
      domainEvents: [],
      domainServices: [],
      policies: [],
      owner: "health-team",
      sharedKernel: ["kernel"],
    },
    {
      id: "competition",
      name: "Competition",
      description: "Competitions, leaderboards, streaks. Reserved for future milestones.",
      ubiquitousLanguage: [
        { term: "Competition", definition: "A time-bounded contest among participants." },
        { term: "Leaderboard", definition: "An ordered ranking of participants." },
      ],
      aggregates: [],
      entities: [],
      valueObjects: [],
      domainEvents: [],
      domainServices: [],
      policies: [],
      owner: "health-team",
    },
    {
      id: "marketplace",
      name: "Marketplace",
      description: "Listing, discovery, distribution, and monetization of Programs & extensions. Reserved.",
      ubiquitousLanguage: [
        { term: "Listing", definition: "A publishable marketplace entry." },
        { term: "Program", definition: "A health program product." },
      ],
      aggregates: [],
      entities: [],
      valueObjects: [],
      domainEvents: [],
      domainServices: [],
      policies: [],
      owner: "marketplace-team",
    },
    {
      id: "notification",
      name: "Notification",
      description: "Multi-channel notification delivery: email, SMS, push, in-app, webhook.",
      ubiquitousLanguage: [
        { term: "Channel", definition: "A delivery transport." },
        { term: "Template", definition: "A parameterized message body." },
        { term: "Preference", definition: "A user's per-channel opt-in." },
      ],
      aggregates: ["Notification", "Template"],
      entities: ["Log", "Preference"],
      valueObjects: ["Channel", "Recipient", "Status"],
      domainEvents: [],
      domainServices: ["NotificationService"],
      policies: ["RespectUserPreferences", "RetryFailedDelivery"],
      owner: "platform-team",
    },
    {
      id: "audit",
      name: "Audit & Compliance",
      description: "Immutable audit trails, compliance exports, data residency tracking.",
      ubiquitousLanguage: [
        { term: "AuditEntry", definition: "An immutable record of a security-relevant action." },
        { term: "Retention", definition: "A policy on how long records are kept." },
      ],
      aggregates: ["AuditEntry"],
      entities: [],
      valueObjects: ["RetentionPolicy"],
      domainEvents: [],
      domainServices: [],
      policies: ["AppendOnly", "TamperEvident"],
      owner: "governance-team",
    },
    {
      id: "research",
      name: "Research",
      description: "De-identified data export for research institutions. Reserved.",
      ubiquitousLanguage: [
        { term: "Cohort", definition: "A population matching research criteria." },
        { term: "Dataset", definition: "An exported de-identified research dataset." },
      ],
      aggregates: [],
      entities: [],
      valueObjects: [],
      domainEvents: [],
      domainServices: [],
      policies: [],
      owner: "research-team",
    },
    {
      id: "files",
      name: "Files & Storage",
      description: "Object storage abstraction across buckets and providers.",
      ubiquitousLanguage: [
        { term: "Bucket", definition: "A named storage container with a policy." },
        { term: "Blob", definition: "An immutable stored object." },
      ],
      aggregates: ["Bucket", "Blob"],
      entities: ["Upload"],
      valueObjects: ["StorageClass", "MimeType"],
      domainEvents: [],
      domainServices: ["StorageService"],
      policies: ["EnforceBucketPolicy", "EnforceAcl"],
      owner: "platform-team",
    },
  ];
  contexts.forEach((c) => reg.registerContext(c));

  // ---- Services ----
  const services: ServiceDescriptor[] = [
    svc("gateway", "API Gateway", "gateway", "platform", "Single entry point: REST, GraphQL, WebSocket, SSE, future gRPC. Versioning, rate limiting, compression, caching, auth hooks, tracing.", "kernel",
      [{ protocol: "rest", basePath: "/api", version: "v1" }, { protocol: "graphql", basePath: "/graphql", version: "v1" }, { protocol: "websocket", basePath: "/ws", version: "v1" }, { protocol: "sse", basePath: "/events", version: "v1" }],
      [], ["eks.kernel.system.*"], [], "platform-team", "active", ["af-west-1"], "99.99%", "public", "core", "v1", "/api/kernel/services"),
    svc("identity", "Identity Service", "identity", "identity", "Authentication, sessions, OAuth/OIDC, service identity. Contract reserved — implementation in a future milestone.", "identity",
      [{ protocol: "rest", basePath: "/api/identity", version: "v1" }],
      ["gateway"], [], [], "identity-team", "provisioning", [], "99.95%", "restricted", "core", "v1", "/api/identity/openapi.json"),
    svc("organizations", "Organizations Service", "organizations", "identity", "Tenant provisioning, memberships, tiers, quotas, isolation boundaries.", "tenancy",
      [{ protocol: "rest", basePath: "/api/organizations", version: "v1" }],
      ["gateway", "identity"], ["eks.kernel.tenant.*"], ["eks.kernel.tenant.provisioned", "eks.kernel.tenant.suspended"], "platform-team", "active", ["af-west-1"], "99.95%", "confidential", "core", "v1", "/api/kernel/services"),
    svc("config", "Configuration Service", "config", "platform", "Hierarchical configuration with environment/country/org/program/runtime overrides, live reload, schema validation.", "config",
      [{ protocol: "rest", basePath: "/api/kernel/config", version: "v1" }, { protocol: "sse", basePath: "/api/kernel/config/stream", version: "v1" }],
      ["gateway"], ["eks.kernel.config.changed"], ["eks.kernel.config.changed"], "platform-team", "active", ["af-west-1"], "99.99%", "internal", "core", "v1", "/api/kernel/config"),
    svc("flags", "Feature Flag Service", "flags", "platform", "Percentage/org/country/program/developer rollout, A/B experiments, kill switches, dependencies.", "config",
      [{ protocol: "rest", basePath: "/api/kernel/flags", version: "v1" }],
      ["gateway"], ["eks.kernel.flag.toggled"], ["eks.kernel.flag.toggled"], "platform-team", "active", ["af-west-1"], "99.99%", "internal", "core", "v1", "/api/kernel/flags"),
    svc("events", "Event Bus", "events", "platform", "Domain/integration/system/scheduled/delayed events. Pub-sub, idempotency, retries, DLQ, replay, ordering.", "kernel",
      [{ protocol: "rest", basePath: "/api/kernel/events", version: "v1" }, { protocol: "websocket", basePath: "/ws", version: "v1" }],
      ["gateway"], [], ["eks.kernel.system.*", "eks.kernel.tenant.*", "eks.kernel.flag.*", "eks.kernel.config.*", "eks.kernel.scheduler.*"], "platform-team", "active", ["af-west-1"], "99.99%", "internal", "core", "v1", "/api/kernel/events"),
    svc("scheduler", "Scheduler Service", "scheduler", "platform", "Distributed cron, one-time & recurring jobs, retry/backoff, distributed locking, priority queues.", "kernel",
      [{ protocol: "rest", basePath: "/api/kernel/scheduler", version: "v1" }],
      ["gateway", "events"], [], ["eks.kernel.scheduler.fired"], "platform-team", "active", ["af-west-1"], "99.95%", "internal", "core", "v1", "/api/kernel/scheduler"),
    svc("observability", "Observability Service", "observability", "platform", "Metrics, logs, distributed tracing, health checks, alerting. OpenTelemetry-compatible.", "kernel",
      [{ protocol: "rest", basePath: "/api/kernel/observability", version: "v1" }],
      ["gateway"], [], [], "platform-team", "active", ["af-west-1"], "99.95%", "internal", "core", "v1", "/api/kernel/observability"),
    svc("files", "Files Service", "files", "data", "Object storage abstraction across buckets & providers. Documents, images, videos, evidence, assets.", "files",
      [{ protocol: "rest", basePath: "/api/kernel/files", version: "v1" }],
      ["gateway", "events", "identity"], [], [], "platform-team", "active", ["af-west-1"], "99.9%", "confidential", "core", "v1", "/api/kernel/files"),
    svc("search", "Search Service", "search", "data", "Search across users, programs, measurements, research, docs, marketplace. Semantic & AI-ready.", "kernel",
      [{ protocol: "rest", basePath: "/api/kernel/search", version: "v1" }],
      ["gateway", "events"], [], [], "platform-team", "active", ["af-west-1"], "99.9%", "internal", "core", "v1", "/api/kernel/search"),
    svc("notification", "Notification Service", "notification", "integration", "Email, SMS, push, in-app, webhooks. Templates, scheduling, preferences, provider abstraction.", "notification",
      [{ protocol: "rest", basePath: "/api/kernel/notifications", version: "v1" }],
      ["gateway", "events", "identity"], [], [], "platform-team", "active", ["af-west-1"], "99.9%", "confidential", "core", "v1", "/api/kernel/notifications"),
    svc("audit", "Audit Service", "audit", "governance", "Immutable, tamper-evident audit trail of security-relevant actions. Compliance exports.", "audit",
      [{ protocol: "rest", basePath: "/api/audit", version: "v1" }],
      ["gateway", "events"], ["eks.kernel.*"], [], "governance-team", "active", ["af-west-1"], "99.99%", "restricted", "core", "v1", "/api/audit/openapi.json"),
    svc("policy", "Policy Service", "policy", "governance", "Centralized policy evaluation: data residency, consent, retention, access control.", "kernel",
      [{ protocol: "rest", basePath: "/api/policy", version: "v1" }],
      ["gateway", "identity"], [], [], "governance-team", "provisioning", [], "99.95%", "restricted", "core", "v1", "/api/policy/openapi.json"),
    svc("secrets", "Secrets Service", "secrets", "governance", "Secret storage, versioning, rotation, access grants. Encryption abstraction, HSM-ready.", "kernel",
      [{ protocol: "rest", basePath: "/api/kernel/security", version: "v1" }],
      ["gateway", "identity"], ["eks.kernel.security.*"], ["eks.kernel.security.secret_rotated", "eks.kernel.security.key_rotated"], "platform-team", "active", ["af-west-1"], "99.99%", "restricted", "core", "v1", "/api/kernel/security"),
    svc("telemetry", "Telemetry Service", "telemetry", "platform", "High-throughput telemetry ingestion pipeline feeding observability & analytics.", "kernel",
      [{ protocol: "rest", basePath: "/api/telemetry", version: "v1" }],
      ["gateway", "observability"], [], [], "platform-team", "active", ["af-west-1"], "99.9%", "internal", "core", "v1", "/api/telemetry/openapi.json"),
    svc("analytics", "Analytics Service", "analytics", "data", "Aggregated analytics, funnels, retention cohorts. Reads from event bus & telemetry.", "kernel",
      [{ protocol: "rest", basePath: "/api/analytics", version: "v1" }, { protocol: "graphql", basePath: "/graphql", version: "v1" }],
      ["gateway", "events", "telemetry"], ["eks.kernel.*"], [], "platform-team", "provisioning", [], "99.9%", "confidential", "core", "v1", "/api/analytics/openapi.json"),
    svc("ai", "AI Service", "ai", "ai", "Prompt execution, tool execution, agent runtime, model routing, vector stores, AI observability.", "kernel",
      [{ protocol: "rest", basePath: "/api/ai", version: "v1" }],
      ["gateway", "events", "identity"], [], [], "ai-team", "provisioning", [], "99.9%", "confidential", "core", "v1", "/api/ai/openapi.json"),
    svc("developer", "Developer Platform", "developer", "developer", "CLI, SDKs, code generation, OpenAPI generation, typed clients, contract testing, docs.", "kernel",
      [{ protocol: "rest", basePath: "/api/developer", version: "v1" }],
      ["gateway", "identity"], [], [], "developer-team", "provisioning", [], "99.9%", "internal", "standard", "v1", "/api/developer/openapi.json"),
    svc("extension-runtime", "Extension Runtime", "extension-runtime", "runtime", "Sandboxed execution for third-party Programs & plugins. Capability-based access.", "extension-runtime",
      [{ protocol: "rest", basePath: "/api/extensions", version: "v1" }],
      ["gateway", "identity", "files"], [], [], "runtime-team", "provisioning", [], "99.9%", "confidential", "core", "v1", "/api/extensions/openapi.json"),
    svc("marketplace", "Marketplace Service", "marketplace", "marketplace", "Listing, discovery, distribution & monetization of Programs & extensions.", "marketplace",
      [{ protocol: "rest", basePath: "/api/marketplace", version: "v1" }],
      ["gateway", "identity", "files", "search"], [], [], "marketplace-team", "provisioning", [], "99.9%", "public", "standard", "v1", "/api/marketplace/openapi.json"),
    svc("measurement", "Measurement Service", "measurement", "data", "Health measurement ingestion, normalization, validation. Reserved — future milestone.", "measurement",
      [{ protocol: "rest", basePath: "/api/measurements", version: "v1" }],
      ["gateway", "identity", "files"], [], [], "health-team", "provisioning", [], "99.9%", "restricted", "core", "v1", "/api/measurements/openapi.json"),
    svc("competition", "Competition Service", "competition", "integration", "Competitions, leaderboards, streaks. Reserved — future milestone.", "competition",
      [{ protocol: "rest", basePath: "/api/competitions", version: "v1" }],
      ["gateway", "identity", "events"], [], [], "health-team", "provisioning", [], "99.9%", "confidential", "standard", "v1", "/api/competitions/openapi.json"),
    svc("research", "Research Service", "research", "governance", "De-identified data export for research institutions. Reserved — future milestone.", "research",
      [{ protocol: "rest", basePath: "/api/research", version: "v1" }],
      ["gateway", "identity", "policy"], [], [], "research-team", "provisioning", [], "99.9%", "restricted", "standard", "v1", "/api/research/openapi.json"),
  ];
  services.forEach((s) => reg.registerService(s));

  // ---- Event Catalog ----
  const events: EventCatalogEntry[] = [
    ev("eks.kernel.system.platform_started", "system", "kernel", [], 1, "Emitted once when the platform kernel boots.", [{ field: "version", type: "string", required: true, description: "Kernel version" }, { field: "region", type: "string", required: false, description: "Boot region" }], false, false),
    ev("eks.kernel.system.service_registered", "system", "kernel", ["observability", "gateway"], 1, "Emitted when a service joins the registry.", [{ field: "serviceId", type: "string", required: true, description: "Service identifier" }, { field: "name", type: "string", required: true, description: "Human name" }], false, false),
    ev("eks.kernel.system.service_health_changed", "system", "observability", ["alerting", "audit"], 1, "Emitted when a service health state transitions.", [{ field: "serviceId", type: "string", required: true, description: "Service" }, { field: "from", type: "string", required: true, description: "Previous state" }, { field: "to", type: "string", required: true, description: "New state" }], true, false),
    ev("eks.kernel.tenant.provisioned", "system", "organizations", ["audit", "notification", "config"], 1, "Emitted when a new tenant is provisioned.", [{ field: "tenantId", type: "TenantId", required: true, description: "New tenant" }, { field: "type", type: "TenantType", required: true, description: "Tenant type" }, { field: "tier", type: "TenantTier", required: true, description: "Service tier" }], true, true),
    ev("eks.kernel.tenant.suspended", "system", "organizations", ["audit", "notification"], 1, "Emitted when a tenant is suspended.", [{ field: "tenantId", type: "TenantId", required: true, description: "Suspended tenant" }, { field: "reason", type: "string", required: true, description: "Suspension reason" }], true, true),
    ev("eks.kernel.flag.toggled", "system", "flags", ["observability", "audit"], 1, "Emitted when a flag's kill-switch state changes.", [{ field: "key", type: "string", required: true, description: "Flag key" }, { field: "enabled", type: "boolean", required: true, description: "New state" }], false, false),
    ev("eks.kernel.config.changed", "system", "config", ["observability"], 1, "Emitted when a config override is set — triggers live reload.", [{ field: "key", type: "string[]", required: true, description: "Affected keys" }], false, false),
    ev("eks.kernel.scheduler.fired", "scheduled", "scheduler", ["observability"], 1, "Emitted each time a scheduled job executes.", [{ field: "jobId", type: "JobId", required: true, description: "Job" }, { field: "handler", type: "string", required: true, description: "Handler name" }, { field: "attempt", type: "number", required: true, description: "Attempt number" }], true, false),
    ev("eks.kernel.security.secret_rotated", "system", "secrets", ["audit", "identity"], 1, "Emitted when a secret is rotated.", [{ field: "secretId", type: "SecretId", required: true, description: "Rotated secret" }, { field: "version", type: "number", required: true, description: "New version" }], true, true),
    ev("eks.kernel.security.key_rotated", "system", "secrets", ["audit"], 1, "Emitted when an encryption key is rotated.", [{ field: "keyId", type: "string", required: true, description: "Key descriptor id" }], true, true),
  ];
  events.forEach((e) => reg.registerEvent(e));
}

function svc(
  id: string, name: string, slug: string, category: ServiceCategory, summary: string,
  boundedContext: string, endpoints: ServiceContractEndpoint[], dependencies: string[],
  consumesEvents: string[], producesEvents: string[], owner: string, state: LifecycleState,
  regions: Region[], sla: string, dataClassification: ServiceDescriptor["dataClassification"],
  extensibility: ServiceDescriptor["extensibility"], contractVersion: string, openApiPath: string,
): ServiceDescriptor {
  return { id, name, slug, category, summary, boundedContext, endpoints, dependencies, consumesEvents, producesEvents, owner, state, regions, sla, dataClassification, extensibility, contractVersion, openApiPath };
}

function ev(
  type: string, kind: EventCatalogEntry["kind"], producer: string, consumers: string[],
  schemaVersion: number, description: string, payloadSchema: EventCatalogEntry["payloadSchema"],
  retryable: boolean, ordered: boolean,
): EventCatalogEntry {
  return { type, kind, producer, consumers, schemaVersion, description, payloadSchema, retryable, ordered };
}

// Re-export protocol type for convenience
export type { Protocol };
