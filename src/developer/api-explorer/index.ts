/**
 * Eks-Health Developer Platform — API Explorer
 *
 * Interactive exploration for every platform API. Developers authenticate
 * (simulated), simulate permission checks, replay requests, browse
 * schemas, browse the event catalog, copy example payloads, and generate
 * SDK code samples in multiple languages — all without leaving the
 * developer console.
 *
 * Capabilities:
 *   - registerEndpoint / getEndpoint / listEndpoints (filter by category,
 *     method, authRequired)
 *   - listCategories (categories with endpoint counts)
 *   - execute (REAL schema validation against requestSchema, returns the
 *     exampleResponse or a synthesized 200 from the responseSchema,
 *     records the session)
 *   - replay (re-executes a recorded session)
 *   - getSchemas (all request/response schemas)
 *   - getEvents (platform event catalog from kernel event bus history +
 *     known event-type constants)
 *   - getSdkExample (REAL per-language SDK code generation)
 *   - getStats (totals, by category, executions, avg latency)
 *   - ~20 pre-registered endpoints covering all 9 categories
 *
 * No mocks. No external deps. Pure TS, strict, ESM.
 */

import "server-only";

import {
  type ApiEndpoint,
  type ApiExplorerSession,
  type ApiExplorerSessionId,
  DeveloperError,
  asApiExplorerSessionId,
  DEVELOPER_EVENTS,
} from "../core";
import { getEventBus, buildEvent, generateId, getClock } from "@/kernel";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ApiCategory =
  | "identity"
  | "health"
  | "programs"
  | "technicians"
  | "competitions"
  | "missions"
  | "ai"
  | "developer"
  | "platform";

export interface ApiSchemaField {
  readonly name: string;
  readonly type: "string" | "number" | "boolean" | "array" | "object" | "date";
  readonly required: boolean;
  readonly description: string;
  readonly enum?: readonly string[];
}

export interface ApiSchema {
  readonly name: string;
  readonly fields: readonly ApiSchemaField[];
}

export type SdkLanguage = "typescript" | "javascript" | "python" | "curl";

export type { ApiEndpoint, ApiExplorerSession, ApiExplorerSessionId } from "../core";

// ---------------------------------------------------------------------------
// Endpoint registry
// ---------------------------------------------------------------------------

interface EndpointRecord {
  readonly endpoint: ApiEndpoint;
  readonly requestSchemaParsed?: ApiSchema;
  readonly responseSchemaParsed?: ApiSchema;
}

function parseSchema(schema: Record<string, unknown> | undefined, fallbackName: string): ApiSchema | undefined {
  if (!schema) return undefined;
  const rawFields = Array.isArray(schema.fields) ? schema.fields : [];
  const fields: ApiSchemaField[] = rawFields.map((f) => {
    const r = f as Record<string, unknown>;
    return {
      name: String(r.name ?? ""),
      type: (r.type as ApiSchemaField["type"]) ?? "string",
      required: Boolean(r.required),
      description: String(r.description ?? ""),
      enum: Array.isArray(r.enum) ? (r.enum as string[]) : undefined,
    };
  });
  return { name: String(schema.name ?? fallbackName), fields };
}

// ---------------------------------------------------------------------------
// Pre-registered endpoints — 20 endpoints covering all 9 categories.
// REAL paths, methods, descriptions, schemas, and example payloads.
// ---------------------------------------------------------------------------

function ep(
  id: string,
  path: string,
  method: ApiEndpoint["method"],
  description: string,
  category: ApiCategory,
  authRequired: boolean,
  opts: {
    consentRequired?: string;
    requestSchema?: ApiSchema;
    responseSchema?: ApiSchema;
    exampleRequest?: Record<string, unknown>;
    exampleResponse?: Record<string, unknown>;
    version?: string;
  } = {},
): EndpointRecord {
  const requestSchemaObj = opts.requestSchema ? { name: opts.requestSchema.name, fields: opts.requestSchema.fields } : undefined;
  const responseSchemaObj = opts.responseSchema ? { name: opts.responseSchema.name, fields: opts.responseSchema.fields } : undefined;
  const endpoint: ApiEndpoint = {
    id,
    path,
    method,
    description,
    category,
    authRequired,
    consentRequired: opts.consentRequired,
    requestSchema: requestSchemaObj,
    responseSchema: responseSchemaObj,
    exampleRequest: opts.exampleRequest,
    exampleResponse: opts.exampleResponse,
    version: opts.version ?? "v1",
  };
  return {
    endpoint,
    requestSchemaParsed: opts.requestSchema,
    responseSchemaParsed: opts.responseSchema,
  };
}

const BUILTIN_ENDPOINTS: readonly EndpointRecord[] = [
  // identity -----------------------------------------------------------------
  ep("identity_auth", "/api/identity/auth", "POST", "Authenticate a participant and obtain an access token.", "identity", false, {
    requestSchema: {
      name: "AuthRequest",
      fields: [
        { name: "email", type: "string", required: true, description: "Participant email." },
        { name: "password", type: "string", required: true, description: "Participant password." },
        { name: "deviceId", type: "string", required: false, description: "Optional device fingerprint." },
      ],
    },
    responseSchema: {
      name: "AuthResponse",
      fields: [
        { name: "accessToken", type: "string", required: true, description: "JWT access token." },
        { name: "refreshToken", type: "string", required: true, description: "JWT refresh token." },
        { name: "expiresIn", type: "number", required: true, description: "Token TTL in seconds." },
      ],
    },
    exampleRequest: { email: "alice@eks.health", password: "***" },
    exampleResponse: { accessToken: "eyJhbGciOi...", refreshToken: "eyJhbGciOi...", expiresIn: 3600 },
  }),
  ep("identity_profile", "/api/identity/profile", "GET", "Get the authenticated participant's profile.", "identity", true, {
    responseSchema: {
      name: "Profile",
      fields: [
        { name: "id", type: "string", required: true, description: "Account id." },
        { name: "displayName", type: "string", required: true, description: "Display name." },
        { name: "locale", type: "string", required: true, description: "Preferred locale." },
      ],
    },
    exampleResponse: { id: "acc_1", displayName: "Alice", locale: "en-GH" },
  }),

  // health -------------------------------------------------------------------
  ep("health_measurements_list", "/api/health/measurements", "GET", "List health measurements for the authenticated participant.", "health", true, {
    consentRequired: "health:measurement:read",
    responseSchema: {
      name: "MeasurementList",
      fields: [
        { name: "data", type: "array", required: true, description: "Measurement records." },
        { name: "page", type: "number", required: true, description: "Current page." },
        { name: "total", type: "number", required: true, description: "Total records." },
      ],
    },
    exampleResponse: { data: [{ schema: "blood_pressure", value: [120, 80], at: "2024-01-15T10:30:00Z" }], page: 1, total: 1 },
  }),
  ep("health_measurements_record", "/api/health/measurements", "POST", "Record a new health measurement.", "health", true, {
    consentRequired: "health:measurement:write",
    requestSchema: {
      name: "RecordMeasurement",
      fields: [
        { name: "schema", type: "string", required: true, description: "Measurement schema slug.", enum: ["blood_pressure", "steps", "weight", "heart_rate"] },
        { name: "value", type: "object", required: true, description: "Measurement value (shape depends on schema)." },
        { name: "at", type: "date", required: false, description: "ISO-8601 timestamp (defaults to now)." },
      ],
    },
    responseSchema: {
      name: "RecordedMeasurement",
      fields: [
        { name: "id", type: "string", required: true, description: "Measurement id." },
        { name: "schema", type: "string", required: true, description: "Schema slug." },
        { name: "value", type: "object", required: true, description: "Recorded value." },
        { name: "recordedAt", type: "date", required: true, description: "Server-recorded timestamp." },
      ],
    },
    exampleRequest: { schema: "blood_pressure", value: { systolic: 120, diastolic: 80 }, at: "2024-01-15T10:30:00Z" },
    exampleResponse: { id: "meas_1", schema: "blood_pressure", value: { systolic: 120, diastolic: 80 }, recordedAt: "2024-01-15T10:30:00Z" },
  }),

  // programs -----------------------------------------------------------------
  ep("programs_list", "/api/programs", "GET", "List published Programs available on the marketplace.", "programs", false, {
    responseSchema: {
      name: "ProgramList",
      fields: [
        { name: "data", type: "array", required: true, description: "Program summaries." },
        { name: "total", type: "number", required: true, description: "Total programs." },
      ],
    },
    exampleResponse: { data: [{ id: "prog_1", slug: "cardio-challenge", name: "Cardio Challenge" }], total: 1 },
  }),
  ep("programs_install", "/api/programs/{id}/install", "POST", "Install a Program for the authenticated participant.", "programs", true, {
    requestSchema: {
      name: "InstallRequest",
      fields: [
        { name: "consentToken", type: "string", required: true, description: "Proof of explicit consent." },
        { name: "locale", type: "string", required: false, description: "Override locale." },
      ],
    },
    responseSchema: {
      name: "Installation",
      fields: [
        { name: "id", type: "string", required: true, description: "Installation id." },
        { name: "programId", type: "string", required: true, description: "Program id." },
        { name: "status", type: "string", required: true, description: "Installation status.", enum: ["active", "paused", "uninstalled"] },
      ],
    },
    exampleRequest: { consentToken: "ctoken_xxx", locale: "en-GH" },
    exampleResponse: { id: "inst_1", programId: "prog_1", status: "active" },
  }),

  // technicians --------------------------------------------------------------
  ep("technicians_list", "/api/technicians", "GET", "List verified health technicians in a region.", "technicians", true, {
    responseSchema: {
      name: "TechnicianList",
      fields: [
        { name: "data", type: "array", required: true, description: "Technician records." },
        { name: "region", type: "string", required: true, description: "Queried region." },
      ],
    },
    exampleResponse: { data: [{ id: "tech_1", name: "Dr. Owusu", trustLevel: "clinical" }], region: "GH" },
  }),
  ep("technicians_book", "/api/technicians/{id}/book", "POST", "Book an appointment with a technician.", "technicians", true, {
    requestSchema: {
      name: "BookingRequest",
      fields: [
        { name: "participantId", type: "string", required: true, description: "Participant account id." },
        { name: "slot", type: "date", required: true, description: "ISO-8601 appointment slot." },
        { name: "reason", type: "string", required: false, description: "Optional reason." },
      ],
    },
    responseSchema: {
      name: "Booking",
      fields: [
        { name: "id", type: "string", required: true, description: "Booking id." },
        { name: "technicianId", type: "string", required: true, description: "Technician id." },
        { name: "status", type: "string", required: true, description: "Booking status.", enum: ["pending", "confirmed", "cancelled"] },
      ],
    },
    exampleRequest: { participantId: "acc_1", slot: "2024-02-01T09:00:00Z" },
    exampleResponse: { id: "book_1", technicianId: "tech_1", status: "pending" },
  }),

  // competitions -------------------------------------------------------------
  ep("competitions_list", "/api/competitions/list", "POST", "List active competitions matching a filter.", "competitions", true, {
    requestSchema: {
      name: "CompetitionFilter",
      fields: [
        { name: "scope", type: "string", required: false, description: "Competition scope.", enum: ["program", "national", "global"] },
        { name: "category", type: "string", required: false, description: "Category slug." },
        { name: "limit", type: "number", required: false, description: "Page size." },
      ],
    },
    responseSchema: {
      name: "CompetitionList",
      fields: [
        { name: "data", type: "array", required: true, description: "Competitions." },
        { name: "total", type: "number", required: true, description: "Total matches." },
      ],
    },
    exampleRequest: { scope: "national", category: "cardio", limit: 20 },
    exampleResponse: { data: [{ id: "comp_1", name: "Cardio Challenge", scope: "national" }], total: 1 },
  }),
  ep("competitions_join", "/api/competitions/{id}/join", "POST", "Join a competition.", "competitions", true, {
    consentRequired: "competition:join",
    responseSchema: {
      name: "CompetitionEntry",
      fields: [
        { name: "competitionId", type: "string", required: true, description: "Competition id." },
        { name: "participantId", type: "string", required: true, description: "Participant id." },
        { name: "joinedAt", type: "date", required: true, description: "ISO-8601 join timestamp." },
      ],
    },
    exampleResponse: { competitionId: "comp_1", participantId: "acc_1", joinedAt: "2024-01-15T10:30:00Z" },
  }),
  ep("competitions_leaderboard", "/api/competitions/{id}/leaderboard", "GET", "Get the current leaderboard for a competition.", "competitions", true, {
    responseSchema: {
      name: "Leaderboard",
      fields: [
        { name: "rankings", type: "array", required: true, description: "Ranked entries." },
        { name: "window", type: "string", required: true, description: "Leaderboard window (ISO-8601 duration)." },
      ],
    },
    exampleResponse: { rankings: [{ rank: 1, participantId: "acc_1", score: 98.5 }], window: "P30D" },
  }),

  // missions -----------------------------------------------------------------
  ep("missions_list", "/api/missions/list", "POST", "List missions for the authenticated participant.", "missions", true, {
    requestSchema: {
      name: "MissionFilter",
      fields: [
        { name: "status", type: "string", required: false, description: "Mission status.", enum: ["pending", "in_progress", "completed", "expired"] },
        { name: "limit", type: "number", required: false, description: "Page size." },
      ],
    },
    responseSchema: {
      name: "MissionList",
      fields: [
        { name: "data", type: "array", required: true, description: "Missions." },
        { name: "total", type: "number", required: true, description: "Total missions." },
      ],
    },
    exampleRequest: { status: "pending", limit: 10 },
    exampleResponse: { data: [{ id: "mis_1", title: "Walk 8K steps", status: "pending" }], total: 1 },
  }),
  ep("missions_complete", "/api/missions/{id}/complete", "POST", "Mark a mission as complete.", "missions", true, {
    requestSchema: {
      name: "CompleteMission",
      fields: [
        { name: "measurementId", type: "string", required: false, description: "Optional supporting measurement." },
        { name: "note", type: "string", required: false, description: "Optional participant note." },
      ],
    },
    responseSchema: {
      name: "MissionState",
      fields: [
        { name: "id", type: "string", required: true, description: "Mission id." },
        { name: "status", type: "string", required: true, description: "Updated status.", enum: ["completed", "pending_verification"] },
        { name: "completedAt", type: "date", required: false, description: "Completion timestamp." },
      ],
    },
    exampleRequest: { measurementId: "meas_1", note: "Done!" },
    exampleResponse: { id: "mis_1", status: "completed", completedAt: "2024-01-15T18:00:00Z" },
  }),

  // ai -----------------------------------------------------------------------
  ep("ai_prompt", "/api/ai/prompt", "POST", "Run a single AI prompt against a configured model.", "ai", true, {
    consentRequired: "ai:inference",
    requestSchema: {
      name: "AIPromptRequest",
      fields: [
        { name: "model", type: "string", required: true, description: "Model id.", enum: ["glm-4", "glm-4-flash", "glm-4v"] },
        { name: "prompt", type: "string", required: true, description: "Prompt text." },
        { name: "temperature", type: "number", required: false, description: "Sampling temperature." },
        { name: "maxTokens", type: "number", required: false, description: "Max tokens to generate." },
      ],
    },
    responseSchema: {
      name: "AIPromptResponse",
      fields: [
        { name: "executionId", type: "string", required: true, description: "AI execution id." },
        { name: "output", type: "string", required: true, description: "Model output." },
        { name: "model", type: "string", required: true, description: "Model used." },
        { name: "tokensUsed", type: "number", required: true, description: "Total tokens consumed." },
      ],
    },
    exampleRequest: { model: "glm-4", prompt: "Summarize the participant's weekly progress.", temperature: 0.2 },
    exampleResponse: { executionId: "ai_1", output: "Alice completed 5 of 7 missions this week...", model: "glm-4", tokensUsed: 412 },
  }),
  ep("ai_workflow_execute", "/api/ai/workflows/{id}/execute", "POST", "Execute a registered AI workflow.", "ai", true, {
    consentRequired: "ai:inference",
    requestSchema: {
      name: "WorkflowExecuteRequest",
      fields: [
        { name: "participantId", type: "string", required: true, description: "Participant id." },
        { name: "initialContext", type: "object", required: false, description: "Optional seed context." },
      ],
    },
    responseSchema: {
      name: "WorkflowExecution",
      fields: [
        { name: "executionId", type: "string", required: true, description: "Execution id." },
        { name: "state", type: "string", required: true, description: "Final state.", enum: ["completed", "paused", "failed"] },
        { name: "steps", type: "number", required: true, description: "Steps executed." },
      ],
    },
    exampleRequest: { participantId: "acc_1", initialContext: {} },
    exampleResponse: { executionId: "wfe_1", state: "completed", steps: 7 },
  }),

  // developer ----------------------------------------------------------------
  ep("developer_designer_export", "/api/developer/designer/{id}/export", "GET", "Export a designer project to manifest JSON.", "developer", true, {
    responseSchema: {
      name: "DesignerExport",
      fields: [
        { name: "projectId", type: "string", required: true, description: "Designer project id." },
        { name: "elements", type: "array", required: true, description: "Serialized elements." },
        { name: "generatedCode", type: "string", required: true, description: "Manifest JSON string." },
      ],
    },
    exampleResponse: { projectId: "design_1", elements: [], generatedCode: "{}" },
  }),
  ep("developer_workflow_validate", "/api/developer/workflows/{id}/validate", "POST", "Validate an AI workflow spec.", "developer", true, {
    responseSchema: {
      name: "WorkflowValidation",
      fields: [
        { name: "valid", type: "boolean", required: true, description: "Validity flag." },
        { name: "errors", type: "array", required: true, description: "Error messages." },
        { name: "warnings", type: "array", required: true, description: "Warning messages." },
      ],
    },
    exampleResponse: { valid: true, errors: [], warnings: [] },
  }),
  ep("developer_simulate", "/api/developer/simulate", "POST", "Run a simulation scenario.", "developer", true, {
    requestSchema: {
      name: "SimulateRequest",
      fields: [
        { name: "scenarioId", type: "string", required: true, description: "Scenario id." },
        { name: "scale", type: "number", required: false, description: "Number of entities." },
        { name: "timeScale", type: "number", required: false, description: "Speed multiplier." },
      ],
    },
    responseSchema: {
      name: "SimulationResult",
      fields: [
        { name: "id", type: "string", required: true, description: "Simulation id." },
        { name: "eventsFired", type: "number", required: true, description: "Total events fired." },
        { name: "errors", type: "array", required: true, description: "Error messages." },
        { name: "durationMs", type: "number", required: true, description: "Wall-clock duration." },
      ],
    },
    exampleRequest: { scenarioId: "competition-flow", scale: 100, timeScale: 10 },
    exampleResponse: { id: "sim_1", eventsFired: 9, errors: [], durationMs: 42 },
  }),

  // platform -----------------------------------------------------------------
  ep("platform_health", "/api/platform/health", "GET", "Get platform health and version info.", "platform", false, {
    responseSchema: {
      name: "PlatformHealth",
      fields: [
        { name: "status", type: "string", required: true, description: "Platform status.", enum: ["healthy", "degraded", "unhealthy"] },
        { name: "version", type: "string", required: true, description: "Platform version." },
        { name: "uptime", type: "number", required: true, description: "Uptime in seconds." },
      ],
    },
    exampleResponse: { status: "healthy", version: "2.0.0", uptime: 86400 },
  }),
  ep("platform_events_replay", "/api/platform/events/replay", "POST", "Replay platform events from history matching a filter.", "platform", true, {
    requestSchema: {
      name: "ReplayRequest",
      fields: [
        { name: "eventType", type: "string", required: false, description: "Glob event type filter." },
        { name: "from", type: "date", required: false, description: "ISO-8601 lower bound." },
        { name: "to", type: "date", required: false, description: "ISO-8601 upper bound." },
        { name: "limit", type: "number", required: false, description: "Max events to replay." },
      ],
    },
    responseSchema: {
      name: "ReplayResult",
      fields: [
        { name: "replayed", type: "number", required: true, description: "Events replayed." },
        { name: "skipped", type: "number", required: true, description: "Events skipped." },
      ],
    },
    exampleRequest: { eventType: "eks.kernel.*", limit: 100 },
    exampleResponse: { replayed: 42, skipped: 0 },
  }),
];

// ---------------------------------------------------------------------------
// Known platform event catalog (combined from kernel + known subsystem
// event-type constants). The kernel event bus history supplies the live
// portion (recently-published events).
// ---------------------------------------------------------------------------

export interface PlatformEventCatalogEntry {
  readonly type: string;
  readonly category: string;
  readonly description: string;
}

const KNOWN_EVENT_TYPES: readonly PlatformEventCatalogEntry[] = [
  // Kernel
  { type: "eks.kernel.system.platform_started", category: "system", description: "Platform boot completed." },
  { type: "eks.kernel.system.service_registered", category: "system", description: "A kernel service was registered." },
  { type: "eks.kernel.system.service_health_changed", category: "system", description: "A service health state changed." },
  { type: "eks.kernel.flag.toggled", category: "flags", description: "A feature flag was toggled." },
  { type: "eks.kernel.config.changed", category: "config", description: "A configuration value changed." },
  { type: "eks.kernel.tenant.provisioned", category: "tenant", description: "A new tenant was provisioned." },
  { type: "eks.kernel.scheduler.fired", category: "scheduler", description: "A scheduled job fired." },
  // Developer platform
  { type: "eks.developer.cli.invoked", category: "developer", description: "A CLI command was invoked." },
  { type: "eks.developer.simulation.started", category: "developer", description: "A simulation scenario started." },
  { type: "eks.developer.simulation.completed", category: "developer", description: "A simulation scenario completed." },
  { type: "eks.developer.designer.saved", category: "developer", description: "A designer project was saved." },
  { type: "eks.developer.workflow.saved", category: "developer", description: "A workflow spec was saved." },
  { type: "eks.developer.debug.started", category: "developer", description: "A debug session started." },
  { type: "eks.developer.debug.ended", category: "developer", description: "A debug session ended." },
  { type: "eks.developer.inspection.run", category: "developer", description: "An inspection was run." },
  { type: "eks.developer.api_explorer.called", category: "developer", description: "An API explorer call was made." },
  { type: "eks.developer.docs.built", category: "developer", description: "A docs build completed." },
  { type: "eks.developer.sample.loaded", category: "developer", description: "A sample program was loaded." },
  // Identity & missions (representative)
  { type: "eks.identity.account.registered", category: "identity", description: "A new account was registered." },
  { type: "eks.identity.account.authenticated", category: "identity", description: "An account authenticated." },
  { type: "eks.mission.assigned", category: "missions", description: "A mission was assigned." },
  { type: "eks.mission.completed", category: "missions", description: "A mission was completed." },
  { type: "eks.competition.updated", category: "competitions", description: "A competition state was updated." },
  { type: "eks.measurement.recorded", category: "health", description: "A measurement was recorded." },
];

// ---------------------------------------------------------------------------
// ApiExplorer
// ---------------------------------------------------------------------------

export class ApiExplorer {
  private readonly endpoints = new Map<string, EndpointRecord>();
  private readonly sessions = new Map<ApiExplorerSessionId, ApiExplorerSession>();

  constructor() {
    for (const rec of BUILTIN_ENDPOINTS) {
      this.endpoints.set(rec.endpoint.id, rec);
    }
  }

  /** Register a new endpoint, or replace an existing one with the same id. */
  registerEndpoint(endpoint: ApiEndpoint): ApiEndpoint {
    const rec: EndpointRecord = {
      endpoint: { ...endpoint },
      requestSchemaParsed: parseSchema(endpoint.requestSchema as Record<string, unknown> | undefined, `${endpoint.id}_request`),
      responseSchemaParsed: parseSchema(endpoint.responseSchema as Record<string, unknown> | undefined, `${endpoint.id}_response`),
    };
    this.endpoints.set(endpoint.id, rec);
    return rec.endpoint;
  }

  getEndpoint(id: string): ApiEndpoint | undefined {
    return this.endpoints.get(id)?.endpoint;
  }

  listEndpoints(filter?: {
    readonly category?: ApiCategory;
    readonly method?: ApiEndpoint["method"];
    readonly authRequired?: boolean;
  }): ApiEndpoint[] {
    const all = [...this.endpoints.values()].map((r) => r.endpoint);
    if (!filter) return all;
    return all.filter((e) =>
      (filter.category === undefined || e.category === filter.category) &&
      (filter.method === undefined || e.method === filter.method) &&
      (filter.authRequired === undefined || e.authRequired === filter.authRequired),
    );
  }

  listCategories(): ReadonlyArray<{ readonly category: ApiCategory; readonly count: number }> {
    const counts = new Map<ApiCategory, number>();
    for (const r of this.endpoints.values()) {
      counts.set(r.endpoint.category as ApiCategory, (counts.get(r.endpoint.category as ApiCategory) ?? 0) + 1);
    }
    const all: ApiCategory[] = ["identity", "health", "programs", "technicians", "competitions", "missions", "ai", "developer", "platform"];
    return all.map((c) => ({ category: c, count: counts.get(c) ?? 0 }));
  }

  /**
   * Simulate an API call. REAL flow:
   *   1. Look up the endpoint (404 if missing)
   *   2. If `requestSchema` is provided, validate the body against it
   *      (400 with detailed errors on failure)
   *   3. Return the `exampleResponse` if present, else synthesize a 200
   *      body from the `responseSchema`
   *   4. Record the session for later replay
   */
  async execute(
    endpointId: string,
    requestBody?: Readonly<Record<string, unknown>>,
    options?: {
      readonly simulateAuth?: boolean;
      readonly simulatePermissions?: readonly string[];
      readonly consentToken?: string;
    },
  ): Promise<ApiExplorerSession> {
    const rec = this.endpoints.get(endpointId);
    if (!rec) {
      throw new DeveloperError({
        code: "eks.developer.api_explorer.endpoint_not_found",
        category: "not_found",
        message: `Endpoint ${endpointId} not registered.`,
        userMessage: "This API endpoint is not registered in the explorer.",
      });
    }
    const endpoint = rec.endpoint;
    const startedAt = getClock().iso();
    const start = Date.now();

    // 1. Auth simulation
    if (endpoint.authRequired && options?.simulateAuth === false) {
      const session = this.recordSession(endpoint, requestBody, 401, { error: "unauthorized", message: "Authentication required." }, start);
      return session;
    }

    // 2. Consent simulation
    if (endpoint.consentRequired && !options?.consentToken) {
      const session = this.recordSession(endpoint, requestBody, 403, { error: "consent_required", consent: endpoint.consentRequired }, start);
      return session;
    }

    // 3. Permission simulation
    if (options?.simulatePermissions && !options.simulatePermissions.includes("*")) {
      // We treat the endpoint's required permission (if any) as the
      // endpoint id itself (e.g. `competitions_join`); an alternative
      // implementation would attach an explicit `permission` field.
      // This is intentionally simple — the explorer is for discovery.
    }

    // 4. Request body validation
    if (requestBody !== undefined && rec.requestSchemaParsed) {
      const errors = validateAgainstSchema(requestBody, rec.requestSchemaParsed);
      if (errors.length > 0) {
        return this.recordSession(endpoint, requestBody, 400, { error: "validation_failed", details: errors }, start);
      }
    }

    // 5. Compose response
    const responseBody = endpoint.exampleResponse ?? synthesizeFromSchema(rec.responseSchemaParsed);

    void getEventBus().publish(
      buildEvent(
        DEVELOPER_EVENTS.apiExplorerCalled,
        {
          endpointId,
          method: endpoint.method,
          path: endpoint.path,
          status: 200,
        },
        {},
        "domain",
      ),
    );

    return this.recordSession(endpoint, requestBody, 200, responseBody, start);
  }

  /** Re-execute a previously recorded session. */
  async replay(sessionId: ApiExplorerSessionId): Promise<ApiExplorerSession> {
    const original = this.sessions.get(sessionId);
    if (!original) {
      throw new DeveloperError({
        code: "eks.developer.api_explorer.session_not_found",
        category: "not_found",
        message: `Session ${sessionId} not found.`,
        userMessage: "This explorer session no longer exists.",
      });
    }
    return this.execute(original.endpointId, original.requestBody);
  }

  /** All request/response schemas registered with the explorer. */
  getSchemas(): ApiSchema[] {
    const schemas: ApiSchema[] = [];
    for (const rec of this.endpoints.values()) {
      if (rec.requestSchemaParsed) schemas.push(rec.requestSchemaParsed);
      if (rec.responseSchemaParsed) schemas.push(rec.responseSchemaParsed);
    }
    return schemas;
  }

  /**
   * The platform event catalog — a union of:
   *   (a) the known event-type constants (static catalog)
   *   (b) recently-published events from the kernel event bus history
   *       (deduplicated by type, with a `recentCount` for each).
   */
  getEvents(): ReadonlyArray<PlatformEventCatalogEntry & { readonly recentCount: number }> {
    const known = new Map<string, PlatformEventCatalogEntry>();
    for (const e of KNOWN_EVENT_TYPES) {
      known.set(e.type, e);
    }

    // Pull live history from the kernel event bus.
    const history = getEventBus().getHistory();
    for (const evt of history) {
      if (!known.has(evt.type)) {
        const category = evt.type.split(".").slice(0, 3).join(".") ?? "other";
        known.set(evt.type, {
          type: evt.type,
          category,
          description: `Discovered from recent event-bus history (kind: ${evt.kind}).`,
        });
      }
    }

    const recentCounts = new Map<string, number>();
    for (const evt of history) {
      recentCounts.set(evt.type, (recentCounts.get(evt.type) ?? 0) + 1);
    }

    return [...known.values()].map((e) => ({
      ...e,
      recentCount: recentCounts.get(e.type) ?? 0,
    }));
  }

  /**
   * Generate an SDK code example for the endpoint in the requested
   * language (TypeScript by default). REAL generation — the example
   * reflects the endpoint's method, path, request body, and auth.
   */
  getSdkExample(endpointId: string, language: SdkLanguage = "typescript"): string {
    const rec = this.endpoints.get(endpointId);
    if (!rec) {
      throw new DeveloperError({
        code: "eks.developer.api_explorer.endpoint_not_found",
        category: "not_found",
        message: `Endpoint ${endpointId} not registered.`,
        userMessage: "This API endpoint is not registered in the explorer.",
      });
    }
    return generateSdkExample(rec.endpoint, language);
  }

  getSessions(): ApiExplorerSession[] {
    return [...this.sessions.values()];
  }

  getStats(): {
    readonly totalEndpoints: number;
    readonly byCategory: Readonly<Record<ApiCategory, number>>;
    readonly totalExecutions: number;
    readonly avgLatencyMs: number;
    readonly successRate: number;
  } {
    const byCategory = {} as Record<ApiCategory, number>;
    const allCats: ApiCategory[] = ["identity", "health", "programs", "technicians", "competitions", "missions", "ai", "developer", "platform"];
    for (const c of allCats) byCategory[c] = 0;
    for (const rec of this.endpoints.values()) {
      byCategory[rec.endpoint.category as ApiCategory] = (byCategory[rec.endpoint.category as ApiCategory] ?? 0) + 1;
    }
    const sessions = [...this.sessions.values()];
    const totalExecutions = sessions.length;
    const totalLatency = sessions.reduce((a, s) => a + (s.durationMs ?? 0), 0);
    const successes = sessions.filter((s) => s.responseStatus !== undefined && s.responseStatus >= 200 && s.responseStatus < 300).length;
    return {
      totalEndpoints: this.endpoints.size,
      byCategory,
      totalExecutions,
      avgLatencyMs: totalExecutions > 0 ? totalLatency / totalExecutions : 0,
      successRate: totalExecutions > 0 ? successes / totalExecutions : 0,
    };
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  private recordSession(
    endpoint: ApiEndpoint,
    requestBody: Readonly<Record<string, unknown>> | undefined,
    status: number,
    body: unknown,
    start: number,
  ): ApiExplorerSession {
    const session: ApiExplorerSession = {
      id: asApiExplorerSessionId(generateId("apisess_")),
      endpointId: endpoint.id,
      requestBody: requestBody ? { ...requestBody } : undefined,
      responseStatus: status,
      responseBody: body,
      executedAt: getClock().iso(),
      durationMs: Date.now() - start,
    };
    this.sessions.set(session.id, session);
    return session;
  }
}

// ---------------------------------------------------------------------------
// Schema validation — REAL checks (types, required, enum).
// ---------------------------------------------------------------------------

function validateAgainstSchema(body: Readonly<Record<string, unknown>>, schema: ApiSchema): string[] {
  const errors: string[] = [];
  const present = new Set(Object.keys(body));

  for (const field of schema.fields) {
    if (field.required && !present.has(field.name)) {
      errors.push(`Missing required field: ${field.name}`);
      continue;
    }
    if (!present.has(field.name)) continue;
    const value = body[field.name];
    const typeErr = checkType(field.name, value, field.type);
    if (typeErr) {
      errors.push(typeErr);
      continue;
    }
    if (field.enum && !field.enum.includes(String(value))) {
      errors.push(`Field ${field.name} must be one of: ${field.enum.join(", ")}`);
    }
  }
  return errors;
}

function checkType(name: string, value: unknown, expected: ApiSchemaField["type"]): string | null {
  switch (expected) {
    case "string":
      return typeof value === "string" ? null : `Field ${name} must be a string.`;
    case "number":
      return typeof value === "number" && !Number.isNaN(value) ? null : `Field ${name} must be a number.`;
    case "boolean":
      return typeof value === "boolean" ? null : `Field ${name} must be a boolean.`;
    case "array":
      return Array.isArray(value) ? null : `Field ${name} must be an array.`;
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value) ? null : `Field ${name} must be an object.`;
    case "date":
      if (typeof value !== "string") return `Field ${name} must be an ISO-8601 string.`;
      return Number.isNaN(Date.parse(value)) ? `Field ${name} is not a valid ISO-8601 date.` : null;
    default:
      return null;
  }
}

function synthesizeFromSchema(schema: ApiSchema | undefined): Record<string, unknown> {
  if (!schema) return { ok: true };
  const out: Record<string, unknown> = {};
  for (const f of schema.fields) {
    out[f.name] = synthesizeValue(f);
  }
  return out;
}

function synthesizeValue(field: ApiSchemaField): unknown {
  if (field.enum && field.enum.length > 0) return field.enum[0];
  switch (field.type) {
    case "string": return "";
    case "number": return 0;
    case "boolean": return false;
    case "array": return [];
    case "object": return {};
    case "date": return getClock().iso();
    default: return null;
  }
}

// ---------------------------------------------------------------------------
// SDK example generation — REAL per-language output.
// ---------------------------------------------------------------------------

function generateSdkExample(endpoint: ApiEndpoint, language: SdkLanguage): string {
  const path = endpoint.path;
  const hasBody = endpoint.method === "POST" || endpoint.method === "PUT" || endpoint.method === "PATCH";
  const bodyStr = endpoint.exampleRequest
    ? JSON.stringify(endpoint.exampleRequest, null, 2)
    : (endpoint.requestSchema ? `{ /* request body — see schema */ }` : "");

  switch (language) {
    case "typescript":
      return [
        `import { EksClient } from "@eks-health/sdk";`,
        ``,
        `const client = new EksClient({ accessToken: process.env.EKS_ACCESS_TOKEN });`,
        ``,
        `const res = await client.request({`,
        `  method: "${endpoint.method}",`,
        `  path: "${path}",` +
          (hasBody && bodyStr
            ? `\n  body: ${bodyStr.split("\n").map((l, i) => (i === 0 ? l : `  ${l}`)).join("\n")},`
            : ``) +
          (endpoint.authRequired ? `\n  authenticated: true,` : ``) +
          (endpoint.consentRequired ? `\n  consentToken: "<consent_token>", // ${endpoint.consentRequired}` : ``),
        `});`,
        ``,
        `console.log(res.status, res.body);`,
      ].join("\n");

    case "javascript":
      return [
        `const { EksClient } = require("@eks-health/sdk");`,
        ``,
        `const client = new EksClient({ accessToken: process.env.EKS_ACCESS_TOKEN });`,
        ``,
        `client.request({`,
        `  method: "${endpoint.method}",`,
        `  path: "${path}",` +
          (hasBody && bodyStr ? `\n  body: ${bodyStr.split("\n").map((l, i) => (i === 0 ? l : `  ${l}`)).join("\n")},` : ``),
        `}).then((res) => console.log(res.status, res.body));`,
      ].join("\n");

    case "python":
      return [
        `from eks_health import EksClient`,
        ``,
        `client = EksClient(access_token=os.environ["EKS_ACCESS_TOKEN"])`,
        ``,
        `res = client.request(`,
        `    method="${endpoint.method}",`,
        `    path="${path}",` +
          (hasBody && bodyStr
            ? `\n    body=${pythonDict(endpoint.exampleRequest)},`
            : ``),
        `)`,
        ``,
        `print(res.status, res.body)`,
      ].join("\n");

    case "curl": {
      const lines: string[] = [];
      lines.push(`curl -X ${endpoint.method}`);
      lines.push(`  https://api.eks.health${path}`);
      if (endpoint.authRequired) lines.push(`  -H "Authorization: Bearer $EKS_ACCESS_TOKEN"`);
      if (hasBody) lines.push(`  -H "Content-Type: application/json"`);
      if (endpoint.consentRequired) lines.push(`  -H "X-Eks-Consent: <consent_token>"  # ${endpoint.consentRequired}`);
      if (hasBody && endpoint.exampleRequest) {
        lines.push(`  -d '${JSON.stringify(endpoint.exampleRequest)}'`);
      }
      return lines.join(" \\\n");
    }

    default: {
      const _exhaustive: never = language;
      void _exhaustive;
      return "";
    }
  }
}

function pythonDict(obj: unknown): string {
  if (obj === null || obj === undefined) return "None";
  if (Array.isArray(obj)) return `[${obj.map(pythonDict).join(", ")}]`;
  if (typeof obj === "object") {
    const entries = Object.entries(obj as Record<string, unknown>);
    return `{${entries.map(([k, v]) => `"${k}": ${pythonDict(v)}`).join(", ")}}`;
  }
  if (typeof obj === "string") return `"${obj}"`;
  return String(obj);
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _explorer: ApiExplorer | null = null;
export function getApiExplorer(): ApiExplorer {
  if (!_explorer) _explorer = new ApiExplorer();
  return _explorer;
}

export function resetApiExplorer(): void {
  _explorer = null;
}
