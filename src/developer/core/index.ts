/**
 * Eks-Health Developer Platform — Core Primitives
 *
 * Foundational types for the developer platform: CLI commands, simulator
 * scenarios, visual designer configs, workflow builder specs, debugger
 * sessions, inspector metrics, API explorer entries, docs, and sample
 * programs. Developers only implement their health methodology — the
 * platform provides everything else.
 */

import "server-only";
import type { Brand, CorrelationId, TraceId } from "@/kernel";
import type { ProgramId } from "@/programs";

// ---------------------------------------------------------------------------
// Branded developer identifiers
// ---------------------------------------------------------------------------

export type DevSessionId = Brand<string, "DevSessionId">;
export type SimulationId = Brand<string, "SimulationId">;
export type SimulationScenarioId = Brand<string, "SimulationScenarioId">;
export type DebugSessionId = Brand<string, "DebugSessionId">;
export type DesignerProjectId = Brand<string, "DesignerProjectId">;
export type WorkflowSpecId = Brand<string, "WorkflowSpecId">;
export type ApiExplorerSessionId = Brand<string, "ApiExplorerSessionId">;
export type DocsBuildId = Brand<string, "DocsBuildId">;
export type SampleProgramId = Brand<string, "SampleProgramId">;
export type CliInvocationId = Brand<string, "CliInvocationId">;

export function asDevSessionId(s: string): DevSessionId { return s as DevSessionId; }
export function asSimulationId(s: string): SimulationId { return s as SimulationId; }
export function asSimulationScenarioId(s: string): SimulationScenarioId { return s as SimulationScenarioId; }
export function asDebugSessionId(s: string): DebugSessionId { return s as DebugSessionId; }
export function asDesignerProjectId(s: string): DesignerProjectId { return s as DesignerProjectId; }
export function asWorkflowSpecId(s: string): WorkflowSpecId { return s as WorkflowSpecId; }
export function asApiExplorerSessionId(s: string): ApiExplorerSessionId { return s as ApiExplorerSessionId; }
export function asDocsBuildId(s: string): DocsBuildId { return s as DocsBuildId; }
export function asSampleProgramId(s: string): SampleProgramId { return s as SampleProgramId; }
export function asCliInvocationId(s: string): CliInvocationId { return s as CliInvocationId; }

// ---------------------------------------------------------------------------
// CLI command types
// ---------------------------------------------------------------------------

export type CliCommandName =
  | "new-program"
  | "dev"
  | "simulate"
  | "package"
  | "validate"
  | "test"
  | "publish"
  | "upgrade"
  | "rollback"
  | "logs"
  | "inspect"
  | "doctor"
  | "scaffold"
  | "docs"
  | "config"
  | "login"
  | "logout"
  | "whoami"
  | "certify"
  | "marketplace-preview";

export interface CliCommand {
  readonly name: CliCommandName;
  readonly description: string;
  readonly usage: string;
  readonly args: CliArg[];
  readonly options: CliOption[];
  readonly examples: string[];
  readonly category: "scaffolding" | "development" | "testing" | "packaging" | "deployment" | "diagnostics" | "auth";
}

export interface CliArg {
  readonly name: string;
  readonly description: string;
  readonly required: boolean;
  readonly defaultValue?: string;
}

export interface CliOption {
  readonly flag: string;
  readonly shortFlag?: string;
  readonly description: string;
  readonly type: "string" | "boolean" | "number";
  readonly defaultValue?: unknown;
}

export interface CliInvocation {
  readonly id: CliInvocationId;
  readonly command: CliCommandName;
  readonly args: Record<string, string>;
  readonly options: Record<string, unknown>;
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly exitCode?: number;
  readonly stdout: string[];
  readonly stderr: string[];
  readonly durationMs?: number;
}

// ---------------------------------------------------------------------------
// Simulator types
// ---------------------------------------------------------------------------

export type SimulationEntityType =
  | "participant"
  | "technician"
  | "organization"
  | "competition"
  | "measurement"
  | "leaderboard"
  | "reward"
  | "notification"
  | "ai_provider"
  | "payment_event"
  | "marketplace_event";

export interface SimulatedEntity {
  readonly id: string;
  readonly type: SimulationEntityType;
  readonly label: string;
  readonly properties: Record<string, unknown>;
  readonly createdAt: string;
}

export interface SimulationScenario {
  readonly id: SimulationScenarioId;
  readonly name: string;
  readonly description: string;
  readonly entities: SimulatedEntity[];
  readonly eventSequence: SimulationEvent[];
  readonly config: SimulationConfig;
  readonly createdAt: string;
}

export interface SimulationEvent {
  readonly id: string;
  readonly delayMs: number;
  readonly type: string;
  readonly payload: Record<string, unknown>;
  readonly description: string;
}

export interface SimulationConfig {
  readonly timeScale: number; // 1 = real-time, 10 = 10x speed
  readonly offlineMode: boolean;
  readonly networkFailureRate: number; // 0-1
  readonly seed: number; // deterministic seed
  readonly maxEntities: number;
}

export interface SimulationResult {
  readonly id: SimulationId;
  readonly scenarioId: SimulationScenarioId;
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly eventsFired: number;
  readonly errors: string[];
  readonly stateSnapshot: Record<string, unknown>;
  readonly durationMs?: number;
}

// ---------------------------------------------------------------------------
// Visual designer types
// ---------------------------------------------------------------------------

export type DesignerElementType =
  | "measurement_schema"
  | "mission_flow"
  | "competition_rule"
  | "score_formula"
  | "leaderboard"
  | "eligibility"
  | "reward_schedule"
  | "permission"
  | "consent_request"
  | "notification"
  | "ai_workflow"
  | "habit"
  | "goal";

export interface DesignerElement {
  readonly id: string;
  readonly type: DesignerElementType;
  readonly label: string;
  readonly config: Record<string, unknown>;
  readonly position: { x: number; y: number };
  readonly connections: string[]; // connected element IDs
}

export interface DesignerProject {
  readonly id: DesignerProjectId;
  readonly programId: ProgramId;
  readonly name: string;
  readonly elements: DesignerElement[];
  readonly canvas: { width: number; height: number };
  readonly createdAt: string;
  readonly updatedAt: string;
}

// ---------------------------------------------------------------------------
// AI Workflow builder types
// ---------------------------------------------------------------------------

export type WorkflowNodeKind =
  | "ai_prompt"
  | "tool_call"
  | "conditional"
  | "parallel"
  | "sequential"
  | "retrieval"
  | "memory_store"
  | "memory_retrieve"
  | "human_review"
  | "schedule"
  | "fallback_model"
  | "output"
  | "input";

export interface WorkflowNode {
  readonly id: string;
  readonly kind: WorkflowNodeKind;
  readonly label: string;
  readonly config: Record<string, unknown>;
  readonly position: { x: number; y: number };
}

export interface WorkflowEdge {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly label?: string;
  readonly condition?: string; // for conditional edges
}

export interface WorkflowSpec {
  readonly id: WorkflowSpecId;
  readonly programId: ProgramId;
  readonly name: string;
  readonly description: string;
  readonly nodes: WorkflowNode[];
  readonly edges: WorkflowEdge[];
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

// ---------------------------------------------------------------------------
// Debugger types
// ---------------------------------------------------------------------------

export type DebugEventType =
  | "event_published"
  | "api_call"
  | "permission_check"
  | "consent_check"
  | "measurement_recorded"
  | "competition_update"
  | "mission_generated"
  | "leaderboard_update"
  | "ai_execution"
  | "workflow_step"
  | "error"
  | "warning"
  | "performance";

export interface DebugEvent {
  readonly id: string;
  readonly type: DebugEventType;
  readonly timestamp: string;
  readonly source: string;
  readonly data: Record<string, unknown>;
  readonly durationMs?: number;
  readonly traceId?: string;
  readonly correlationId?: string;
}

export interface DebugSession {
  readonly id: DebugSessionId;
  readonly programId: ProgramId;
  readonly participantId?: string;
  readonly events: DebugEvent[];
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly filters: DebugFilter;
}

export interface DebugFilter {
  readonly types?: DebugEventType[];
  readonly sources?: string[];
  readonly from?: string;
  readonly to?: string;
  readonly traceId?: string;
  readonly correlationId?: string;
  readonly minDurationMs?: number;
}

// ---------------------------------------------------------------------------
// Inspector types
// ---------------------------------------------------------------------------

export interface ProgramInspection {
  readonly programId: ProgramId;
  readonly health: "healthy" | "degraded" | "unhealthy" | "crashed";
  readonly performance: {
    readonly avgResponseMs: number;
    readonly p95ResponseMs: number;
    readonly errorRate: number;
    readonly throughput: number;
  };
  readonly resourceUsage: {
    readonly memoryMb: number;
    readonly storageMb: number;
    readonly cpuPercent: number;
    readonly apiCallsPerMinute: number;
  };
  readonly apiUsage: { endpoint: string; calls: number; avgLatencyMs: number; errorRate: number }[];
  readonly permissions: { permission: string; granted: boolean; lastUsed?: string }[];
  readonly activeUsers: number;
  readonly installations: number;
  readonly crashes: { count: number; lastAt?: string };
  readonly warnings: { code: string; message: string; severity: "low" | "medium" | "high" }[];
  readonly securityIssues: { type: string; description: string; severity: "low" | "medium" | "high" | "critical" }[];
  readonly upgradeReadiness: { ready: boolean; blockers: string[] };
  readonly inspectedAt: string;
}

// ---------------------------------------------------------------------------
// API Explorer types
// ---------------------------------------------------------------------------

export interface ApiEndpoint {
  readonly id: string;
  readonly path: string;
  readonly method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  readonly description: string;
  readonly category: string;
  readonly authRequired: boolean;
  readonly consentRequired?: string;
  readonly requestSchema?: Record<string, unknown>;
  readonly responseSchema?: Record<string, unknown>;
  readonly exampleRequest?: Record<string, unknown>;
  readonly exampleResponse?: Record<string, unknown>;
  readonly sdkExample?: string;
  readonly version: string;
}

export interface ApiExplorerSession {
  readonly id: ApiExplorerSessionId;
  readonly endpointId: string;
  readonly requestBody?: Record<string, unknown>;
  readonly responseStatus?: number;
  readonly responseBody?: unknown;
  readonly executedAt?: string;
  readonly durationMs?: number;
}

// ---------------------------------------------------------------------------
// Docs types
// ---------------------------------------------------------------------------

export type DocType =
  | "api_reference"
  | "sdk_guide"
  | "event_catalog"
  | "manifest_reference"
  | "migration_guide"
  | "tutorial"
  | "architecture_diagram"
  | "developer_onboarding"
  | "quickstart"
  | "faq";

export interface DocPage {
  readonly id: string;
  readonly type: DocType;
  readonly title: string;
  readonly slug: string;
  readonly content: string; // markdown
  readonly category: string;
  readonly order: number;
  readonly generatedAt: string;
  readonly generatedFrom?: string; // source (manifest, schema, etc.)
}

export interface DocsBuild {
  readonly id: DocsBuildId;
  readonly programId?: ProgramId;
  readonly pages: DocPage[];
  readonly builtAt: string;
  readonly version: string;
}

// ---------------------------------------------------------------------------
// Sample program types
// ---------------------------------------------------------------------------

export interface SampleProgram {
  readonly id: SampleProgramId;
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly category: string;
  readonly manifestSnippet: Record<string, unknown>;
  readonly fileStructure: { path: string; content: string }[];
  readonly features: string[];
  readonly difficulty: "beginner" | "intermediate" | "advanced";
  readonly estimatedSetupMinutes: number;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type DeveloperErrorCategory =
  | "not_found"
  | "validation"
  | "state_conflict"
  | "simulation_failed"
  | "build_failed"
  | "certification_blocked"
  | "not_authorized"
  | "quota_exceeded";

export class DeveloperError extends Error {
  readonly code: string;
  readonly category: DeveloperErrorCategory;
  readonly retryable: boolean;
  readonly userMessage: string;
  readonly timestamp: string;
  readonly correlationId?: CorrelationId;
  readonly traceId?: TraceId;
  readonly metadata: Record<string, unknown>;

  constructor(opts: {
    code: string;
    category: DeveloperErrorCategory;
    message: string;
    userMessage?: string;
    retryable?: boolean;
    correlationId?: CorrelationId;
    traceId?: TraceId;
    metadata?: Record<string, unknown>;
    cause?: unknown;
  }) {
    super(opts.message);
    this.name = "DeveloperError";
    this.code = opts.code;
    this.category = opts.category;
    this.retryable = opts.retryable ?? false;
    this.userMessage = opts.userMessage ?? "A developer platform error occurred.";
    this.timestamp = new Date().toISOString();
    this.correlationId = opts.correlationId;
    this.traceId = opts.traceId;
    this.metadata = opts.metadata ?? {};
    if (opts.cause !== undefined) {
      (this as { cause?: unknown }).cause = opts.cause;
    }
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      category: this.category,
      retryable: this.retryable,
      userMessage: this.userMessage,
      message: this.message,
      timestamp: this.timestamp,
      correlationId: this.correlationId,
      traceId: this.traceId,
      metadata: this.metadata,
    };
  }
}

// ---------------------------------------------------------------------------
// Developer platform events
// ---------------------------------------------------------------------------

export const DEVELOPER_EVENTS = {
  cliInvoked: "eks.developer.cli.invoked",
  simulationStarted: "eks.developer.simulation.started",
  simulationCompleted: "eks.developer.simulation.completed",
  designerSaved: "eks.developer.designer.saved",
  workflowSpecSaved: "eks.developer.workflow.saved",
  debugSessionStarted: "eks.developer.debug.started",
  debugSessionEnded: "eks.developer.debug.ended",
  inspectionRun: "eks.developer.inspection.run",
  apiExplorerCalled: "eks.developer.api_explorer.called",
  docsBuilt: "eks.developer.docs.built",
  sampleProgramLoaded: "eks.developer.sample.loaded",
} as const;

export type DeveloperEventType = (typeof DEVELOPER_EVENTS)[keyof typeof DEVELOPER_EVENTS];

export { type ProgramId };
