/**
 * Eks-Health Platform API — GraphQL Engine
 *
 * A lightweight GraphQL-compatible query resolver. Since the platform cannot
 * install the `graphql` npm package (and doesn't need a full SDL parser for
 * its internal API surface), this engine implements the GraphQL execution
 * contract directly: typed resolvers registered against (type, field) pairs,
 * a JSON-based query shape (no SDL parsing), recursive field selection, and
 * the standard `data`/`errors` response envelope.
 *
 * What IS implemented here (real, working, no mocks):
 *   - A `GraphQLEngine` that registers resolvers for typed fields and
 *     resolves a `GraphQLQuery` into a nested `GraphQLResponse`.
 *   - Real recursive field-tree resolution: walks each top-level field,
 *     invokes the matching resolver, then descends into sub-selections
 *     (resolving `args`, `alias`, and nested fields).
 *   - Pre-registered resolvers that wire the GraphQL surface to the existing
 *     platform REST managers (platform info, accounts, programs, measurements,
 *     competitions, missions, organizations, marketplace, research). Each
 *     resolver is guarded so a missing subsystem degrades gracefully.
 *   - Execution stats: total queries, average latency, per-operation counts.
 *   - Schema introspection via `getSchema()`.
 *
 * What is NOT here:
 *   - No SDL parser. Queries are passed as plain `GraphQLQuery` objects.
 *   - No full GraphQL spec compliance (no fragments, no directives, no
 *     variables type-coercion beyond `as` casts). This is intentional — the
 *     platform's GraphQL surface is a thin façade over typed resolvers.
 */

import "server-only";
import type { Brand } from "@/kernel";
import { generateId, getClock, getEventBus, buildEvent } from "@/kernel";

// ---------------------------------------------------------------------------
// Branded identifiers & types
// ---------------------------------------------------------------------------

export type GraphQLQueryId = Brand<string, "GraphQLQueryId">;

export type GraphQLOperation = "query" | "mutation";

export interface GraphQLField {
  readonly name: string;
  readonly alias?: string;
  readonly args?: Readonly<Record<string, unknown>>;
  readonly fields?: readonly GraphQLField[];
}

export interface GraphQLQuery {
  readonly operation: GraphQLOperation;
  readonly fields: readonly GraphQLField[];
  readonly variables?: Readonly<Record<string, unknown>>;
  readonly operationName?: string;
}

export type GraphQLResolverFn = (
  args: Readonly<Record<string, unknown>>,
  context: GraphQLResolverContext,
) => unknown | Promise<unknown>;

export interface GraphQLResolverContext {
  readonly variables: Readonly<Record<string, unknown>>;
  readonly parent: unknown;
  readonly path: readonly string[];
}

export interface GraphQLResolver {
  readonly type: string; // "Query" | "Mutation" | a type name
  readonly field: string;
  readonly resolve: GraphQLResolverFn;
}

export interface GraphQLTypeField {
  readonly name: string;
  readonly type: string; // "Query" | "Mutation" | custom
  readonly args: readonly string[];
  readonly description?: string;
  readonly deprecationReason?: string;
}

export interface GraphQLSchema {
  readonly types: ReadonlyArray<{
    readonly name: string;
    readonly fields: readonly GraphQLTypeField[];
  }>;
  readonly resolvers: readonly GraphQLResolver[];
  readonly queryType: string;
  readonly mutationType: string;
}

export interface GraphQLError {
  readonly message: string;
  readonly path?: readonly string[];
  readonly code?: string;
}

export interface GraphQLResponse<T = unknown> {
  readonly data: Record<string, unknown> | null;
  readonly errors?: readonly GraphQLError[];
  readonly extensions?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

export interface GraphQLStats {
  readonly totalQueries: number;
  readonly totalErrors: number;
  readonly avgLatencyMs: number;
  readonly byOperation: Readonly<Record<GraphQLOperation, number>>;
  readonly registeredResolvers: number;
  readonly lastQueryAt?: string;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export const GRAPHQL_EVENTS = {
  queryExecuted: "eks.platform.graphql.query_executed",
  queryFailed: "eks.platform.graphql.query_failed",
  resolverRegistered: "eks.platform.graphql.resolver_registered",
} as const;

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

function resolverKey(type: string, field: string): string {
  return `${type}.${field}`;
}

export class GraphQLEngine {
  private readonly resolvers = new Map<string, GraphQLResolver>();
  private readonly typeFields = new Map<string, GraphQLTypeField[]>();
  private readonly stats = {
    totalQueries: 0,
    totalErrors: 0,
    totalLatencyMs: 0,
    byOperation: { query: 0, mutation: 0 } as Record<GraphQLOperation, number>,
  };
  private lastQueryAt: string | undefined;

  /**
   * Register a resolver for a (type, field) pair. Real registration: stores
   * the resolver in a Map keyed by `type.field`, tracks the field on the
   * owning type's field list for schema introspection, and emits
   * `resolverRegistered`.
   */
  registerResolver(
    type: string,
    field: string,
    resolve: GraphQLResolverFn,
    descriptor?: { readonly args?: readonly string[]; readonly description?: string },
  ): GraphQLResolver {
    const resolver: GraphQLResolver = { type, field, resolve };
    this.resolvers.set(resolverKey(type, field), resolver);

    const typeField: GraphQLTypeField = {
      name: field,
      type,
      args: descriptor?.args ?? [],
      description: descriptor?.description,
    };
    const existing = this.typeFields.get(type) ?? [];
    if (!existing.some((f) => f.name === field)) {
      this.typeFields.set(type, [...existing, typeField]);
    }

    void this.emit(GRAPHQL_EVENTS.resolverRegistered, {
      type,
      field,
      at: getClock().iso(),
    });
    return resolver;
  }

  /** Returns the registered resolvers + type field map for introspection. */
  getSchema(): GraphQLSchema {
    const types = [...this.typeFields.entries()].map(([name, fields]) => ({
      name,
      fields,
    }));
    return {
      types,
      resolvers: [...this.resolvers.values()],
      queryType: "Query",
      mutationType: "Mutation",
    };
  }

  listResolvers(): readonly GraphQLResolver[] {
    return [...this.resolvers.values()];
  }

  /**
   * Execute a `GraphQLQuery`. Real resolution: walks each top-level field,
   * invokes the matching resolver, recurses into sub-selections, and assembles
   * the nested `data` object. Errors are captured per-field (with path) and
   * surfaced in `errors`.
   */
  async execute(query: GraphQLQuery): Promise<GraphQLResponse> {
    const startedAt = Date.now();
    const errors: GraphQLError[] = [];
    const data: Record<string, unknown> = {};
    const rootType = query.operation === "mutation" ? "Mutation" : "Query";
    const variables = query.variables ?? {};

    this.stats.totalQueries++;
    this.stats.byOperation[query.operation]++;
    this.lastQueryAt = getClock().iso();

    for (const field of query.fields) {
      const path = [field.alias ?? field.name];
      try {
        const value = await this.resolveField(field, rootType, variables, undefined, path);
        data[field.alias ?? field.name] = value;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        errors.push({ message, path, code: "RESOLVER_ERROR" });
        data[field.alias ?? field.name] = null;
      }
    }

    const latencyMs = Date.now() - startedAt;
    this.stats.totalLatencyMs += latencyMs;
    if (errors.length > 0) this.stats.totalErrors++;

    void this.emit(
      errors.length > 0 ? GRAPHQL_EVENTS.queryFailed : GRAPHQL_EVENTS.queryExecuted,
      {
        operation: query.operation,
        operationName: query.operationName,
        fieldCount: query.fields.length,
        latencyMs,
        errorCount: errors.length,
        at: getClock().iso(),
      },
    );

    return {
      data: Object.keys(data).length > 0 || errors.length === 0 ? data : null,
      errors: errors.length > 0 ? errors : undefined,
      extensions: {
        latencyMs,
        executedAt: getClock().iso(),
      },
    };
  }

  private async resolveField(
    field: GraphQLField,
    parentType: string,
    variables: Readonly<Record<string, unknown>>,
    parent: unknown,
    path: readonly string[],
  ): Promise<unknown> {
    const resolver = this.resolvers.get(resolverKey(parentType, field.name));
    if (!resolver) {
      throw new Error(
        `No resolver registered for ${parentType}.${field.name}`,
      );
    }
    const args = this.substituteVariables(field.args ?? {}, variables);
    const ctx: GraphQLResolverContext = { variables, parent, path };
    const result = await resolver.resolve(args, ctx);

    // If the field has sub-selections AND the result is an object/array,
    // descend into the sub-fields. For arrays, map over each element.
    if (field.fields && field.fields.length > 0 && result !== null && result !== undefined) {
      if (Array.isArray(result)) {
        const out: unknown[] = [];
        for (let i = 0; i < result.length; i++) {
          const itemPath = [...path, String(i)];
          out.push(await this.resolveSelection(field.fields, parentType, variables, result[i], itemPath));
        }
        return out;
      }
      if (typeof result === "object") {
        return this.resolveSelection(field.fields, parentType, variables, result, path);
      }
    }
    return result;
  }

  private async resolveSelection(
    fields: readonly GraphQLField[],
    parentType: string,
    variables: Readonly<Record<string, unknown>>,
    parent: unknown,
    path: readonly string[],
  ): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    for (const sub of fields) {
      const subPath = [...path, sub.alias ?? sub.name];
      const resolver = this.resolvers.get(resolverKey(parentType, sub.name));
      if (!resolver && parent && typeof parent === "object") {
        const v = (parent as Record<string, unknown>)[sub.name];
        out[sub.alias ?? sub.name] = v;
        continue;
      }
      try {
        const v = await this.resolveField(sub, parentType, variables, parent, subPath);
        out[sub.alias ?? sub.name] = v;
      } catch {
        out[sub.alias ?? sub.name] = null;
      }
    }
    return out;
  }

  private substituteVariables(
    args: Readonly<Record<string, unknown>>,
    variables: Readonly<Record<string, unknown>>,
  ): Readonly<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args)) {
      out[k] = this.substituteValue(v, variables);
    }
    return out;
  }

  private substituteValue(
    value: unknown,
    variables: Readonly<Record<string, unknown>>,
  ): unknown {
    if (typeof value === "string" && value.startsWith("$")) {
      const varName = value.slice(1);
      return varName in variables ? variables[varName] : value;
    }
    if (Array.isArray(value)) {
      return value.map((v) => this.substituteValue(v, variables));
    }
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        out[k] = this.substituteValue(v, variables);
      }
      return out;
    }
    return value;
  }

  private async emit(type: string, payload: Record<string, unknown>): Promise<void> {
    try {
      const bus = getEventBus();
      await bus.publish(buildEvent(type, payload, { actor: { kind: "service", id: "graphql" } }, "integration"));
    } catch {
      // EventBus may not be booted in some environments; degrade silently.
    }
  }

  getStats(): GraphQLStats {
    return {
      totalQueries: this.stats.totalQueries,
      totalErrors: this.stats.totalErrors,
      avgLatencyMs: this.stats.totalQueries === 0 ? 0 : Math.round(this.stats.totalLatencyMs / this.stats.totalQueries),
      byOperation: { ...this.stats.byOperation },
      registeredResolvers: this.resolvers.size,
      lastQueryAt: this.lastQueryAt,
    };
  }
}

// ---------------------------------------------------------------------------
// Platform data accessors — guarded, lazy, no hard deps at module load time.
// Each helper lazy-imports the singleton for a subsystem and returns its
// data; on any failure (subsystem not booted, missing module, etc.) it
// resolves to undefined so the resolver degrades to null.
// ---------------------------------------------------------------------------

interface PlatformInfo {
  readonly name: string;
  readonly version: string;
  readonly region: string;
  readonly bootedAt: string;
  readonly subsystemCount: number;
}

function safeCall<T>(fn: () => T | Promise<T>): Promise<T | undefined> {
  return Promise.resolve()
    .then(() => fn())
    .catch(() => undefined);
}

async function getPlatformInfo(): Promise<PlatformInfo | undefined> {
  return safeCall(async () => {
    const mod = await import("@/kernel");
    const info = mod.kernelInfo();
    return {
      name: info.name,
      version: info.version,
      region: info.region,
      bootedAt: info.bootedAt,
      subsystemCount: info.subsystems.length,
    };
  });
}

async function getPlatformStats(): Promise<Record<string, unknown> | undefined> {
  return safeCall(async () => {
    const mod = await import("@/kernel");
    return mod.kernelSnapshot() as Record<string, unknown>;
  });
}

async function getAccountsList(limit: number) {
  return safeCall(async () => {
    const id = await import("@/identity");
    return id.getAccounts().list().slice(0, limit).map((a) => ({
      id: a.id,
      email: a.email,
      displayName: a.displayName,
      state: a.state,
      activePersona: a.activePersona,
      createdAt: a.createdAt,
    }));
  });
}

async function getAccount(id: string) {
  return safeCall(async () => {
    const idMod = await import("@/identity");
    return idMod.getAccounts().get(idMod.asAccountId(id));
  });
}

async function getProgramsList(limit: number) {
  return safeCall(async () => {
    const p = await import("@/programs");
    return p.getRegistry().list().slice(0, limit).map((pr) => ({
      id: pr.id,
      slug: pr.slug,
      name: pr.name,
      kind: pr.kind,
      state: pr.state,
      category: pr.category,
      developerId: pr.developerId,
      installedCount: pr.installedCount,
    }));
  });
}

async function getProgram(id: string) {
  return safeCall(async () => {
    const p = await import("@/programs");
    const pid = p.asProgramId(id);
    return p.getRegistry().get(pid);
  });
}

async function getMeasurementsList(limit: number) {
  return safeCall(async () => {
    const h = await import("@/health");
    return h.getMeasurements().list().slice(0, limit).map((m) => ({
      id: m.id,
      schemaId: m.schemaId,
      profileId: m.profileId,
      value: m.value,
      unitId: m.unitId,
      verificationState: m.verificationState,
      createdAt: m.createdAt,
    }));
  });
}

async function getCompetitionsList(limit: number) {
  return safeCall(async () => {
    const c = await import("@/competitions");
    return c.getCompetitions().list().slice(0, limit).map((co) => ({
      id: co.id,
      slug: co.slug,
      name: co.name,
      state: co.state,
      scope: co.scope,
      startsAt: co.startsAt,
      endsAt: co.endsAt,
      currentParticipants: co.currentParticipants,
    }));
  });
}

async function getMissionsList(limit: number) {
  return safeCall(async () => {
    const m = await import("@/missions");
    return m.getMissions().list().slice(0, limit).map((mi) => ({
      id: mi.id,
      title: mi.title,
      state: mi.state,
      category: mi.category,
      participantId: mi.participantId,
      programId: mi.programId,
    }));
  });
}

async function getOrganizationsList(limit: number) {
  return safeCall(async () => {
    const idMod = await import("@/identity");
    return idMod.getOrganizations().list().slice(0, limit).map((o) => ({
      id: o.id,
      slug: o.slug,
      name: o.name,
      type: o.type,
      status: o.status,
      dataClassification: o.dataClassification,
    }));
  });
}

async function getMarketplaceListings(limit: number) {
  return safeCall(async () => {
    const mp = await import("@/marketplace");
    return mp.getProfiles().list().slice(0, limit).map((l) => ({
      id: l.id,
      name: l.solution.name,
      tagline: l.solution.tagline,
      description: l.solution.description,
      category: l.solution.category,
      status: l.status,
      developerId: l.developerId,
      developerName: l.developerName,
      supportedCountries: l.supportedCountries,
      installCount: l.installCount,
    }));
  });
}

async function getResearchEvidence(limit: number) {
  return safeCall(async () => {
    const r = await import("@/research");
    return r.getEvidenceEngine().getTopEvidence(limit).map((e) => ({
      programId: e.programId,
      confidenceScore: e.confidenceScore,
      evidenceLevel: e.evidenceLevel,
      totalParticipants: e.totalParticipants,
      totalMeasurements: e.totalMeasurements,
      averageImprovement: e.averageImprovement,
      lastUpdated: e.lastUpdated,
    }));
  });
}

// ---------------------------------------------------------------------------
// Singleton + pre-registration
// ---------------------------------------------------------------------------

let _engine: GraphQLEngine | null = null;

export function getGraphQL(): GraphQLEngine {
  if (!_engine) {
    _engine = new GraphQLEngine();
    registerDefaultResolvers(_engine);
  }
  return _engine;
}

export function resetGraphQL(): void {
  _engine = null;
}

function registerDefaultResolvers(engine: GraphQLEngine): void {
  // ----- Query.platform -----
  engine.registerResolver("Query", "platform", async () => {
    const info = await getPlatformInfo();
    if (!info) return null;
    return {
      name: info.name,
      version: info.version,
      region: info.region,
      bootedAt: info.bootedAt,
      subsystemCount: info.subsystemCount,
    };
  }, { description: "Top-level platform identity & version info." });

  engine.registerResolver("Platform", "info", async () => {
    return (await getPlatformInfo()) ?? null;
  }, { description: "Detailed platform info." });

  engine.registerResolver("Query", "stats", async () => {
    return (await getPlatformStats()) ?? null;
  }, { description: "Whole-platform snapshot (kernel + all subsystems)." });

  engine.registerResolver("Platform", "stats", async () => {
    return (await getPlatformStats()) ?? null;
  });

  // ----- Query.accounts / account -----
  engine.registerResolver("Query", "accounts", async (args) => {
    const limit = typeof args.limit === "number" ? args.limit : 50;
    return (await getAccountsList(limit)) ?? [];
  }, { args: ["limit"], description: "List platform accounts." });

  engine.registerResolver("Query", "account", async (args) => {
    const id = String(args.id ?? "");
    if (!id) return null;
    return (await getAccount(id)) ?? null;
  }, { args: ["id"], description: "Fetch a single account by id." });

  // ----- Query.programs / program -----
  engine.registerResolver("Query", "programs", async (args) => {
    const limit = typeof args.limit === "number" ? args.limit : 50;
    return (await getProgramsList(limit)) ?? [];
  }, { args: ["limit"], description: "List published programs." });

  engine.registerResolver("Query", "program", async (args) => {
    const id = String(args.id ?? "");
    if (!id) return null;
    return (await getProgram(id)) ?? null;
  }, { args: ["id"], description: "Fetch a single program by id." });

  // ----- Query.measurements -----
  engine.registerResolver("Query", "measurements", async (args) => {
    const limit = typeof args.limit === "number" ? args.limit : 50;
    return (await getMeasurementsList(limit)) ?? [];
  }, { args: ["limit"], description: "List health measurements." });

  // ----- Query.competitions -----
  engine.registerResolver("Query", "competitions", async (args) => {
    const limit = typeof args.limit === "number" ? args.limit : 50;
    return (await getCompetitionsList(limit)) ?? [];
  }, { args: ["limit"], description: "List competitions." });

  // ----- Query.missions -----
  engine.registerResolver("Query", "missions", async (args) => {
    const limit = typeof args.limit === "number" ? args.limit : 50;
    return (await getMissionsList(limit)) ?? [];
  }, { args: ["limit"], description: "List participant missions." });

  // ----- Query.organizations -----
  engine.registerResolver("Query", "organizations", async (args) => {
    const limit = typeof args.limit === "number" ? args.limit : 50;
    return (await getOrganizationsList(limit)) ?? [];
  }, { args: ["limit"], description: "List organizations." });

  // ----- Query.marketplace / listings -----
  engine.registerResolver("Query", "marketplace", async (args) => {
    const limit = typeof args.limit === "number" ? args.limit : 50;
    return (await getMarketplaceListings(limit)) ?? [];
  }, { args: ["limit"], description: "List marketplace listings." });

  engine.registerResolver("Query", "listings", async (args) => {
    const limit = typeof args.limit === "number" ? args.limit : 50;
    return (await getMarketplaceListings(limit)) ?? [];
  }, { args: ["limit"], description: "Alias for marketplace listings." });

  // ----- Query.research / evidence -----
  engine.registerResolver("Query", "research", async (args) => {
    const limit = typeof args.limit === "number" ? args.limit : 10;
    return (await getResearchEvidence(limit)) ?? [];
  }, { args: ["limit"], description: "List top research evidence." });

  engine.registerResolver("Query", "evidence", async (args) => {
    const limit = typeof args.limit === "number" ? args.limit : 10;
    return (await getResearchEvidence(limit)) ?? [];
  }, { args: ["limit"], description: "Alias for research evidence." });

  // ----- Mutation.ping / echo -----
  engine.registerResolver("Mutation", "ping", async () => {
    return { ok: true, pong: true, at: getClock().iso() };
  }, { description: "Health-check mutation." });

  engine.registerResolver("Mutation", "echo", async (args) => {
    return { echoed: String(args.message ?? ""), at: getClock().iso() };
  }, { args: ["message"], description: "Echo mutation for testing." });
}

// ---------------------------------------------------------------------------
// Convenience helpers
// ---------------------------------------------------------------------------

export function buildQuery(
  operation: GraphQLOperation,
  fields: readonly GraphQLField[],
  variables?: Readonly<Record<string, unknown>>,
): GraphQLQuery {
  return { operation, fields, variables };
}

export function field(
  name: string,
  opts?: {
    readonly alias?: string;
    readonly args?: Readonly<Record<string, unknown>>;
    readonly fields?: readonly GraphQLField[];
  },
): GraphQLField {
  return {
    name,
    alias: opts?.alias,
    args: opts?.args,
    fields: opts?.fields,
  };
}

/** A unique id for a query (for tracing). Not a branded id in storage. */
export function generateGraphQLQueryId(): GraphQLQueryId {
  return `gql_${generateId()}` as GraphQLQueryId;
}
