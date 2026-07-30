/**
 * Eks-Health AI Runtime — Core Primitives
 *
 * Foundational types for the AI execution environment. The platform knows
 * about generic AI execution concepts (requests, responses, providers,
 * prompts, structured outputs, tools, memory, retrieval, streaming,
 * observability, cost tracking, versioning, fallback). It does NOT know
 * what "nutrition advice", "sleep coaching", or "exercise plan" mean —
 * Programs define those. The platform provides the safe, observable,
 * cost-tracked runtime.
 *
 * No provider is hardcoded. Multiple providers, model routing, prompt
 * templates, structured outputs, tool calling, memory abstraction,
 * retrieval, streaming, observability, rate limiting, cost tracking,
 * versioning, fallback models, and future local models all conform to
 * the contracts declared here.
 *
 * Built on the kernel (events, ids, errors), the kernel AI readiness
 * module (provider registry, model router, prompt registry, tool
 * registry, in-memory vector store), identity (accounts, consent),
 * programs (capabilities), and missions (workflow definitions).
 */

import "server-only";

import type { Brand, CorrelationId, TraceId } from "@/kernel";
import type { AccountId } from "@/identity";
import type { ProgramId } from "@/programs";

// ---------------------------------------------------------------------------
// Branded AI identifiers
// ---------------------------------------------------------------------------

export type AIRequestId = Brand<string, "AIRequestId">;
export type AIResponseId = Brand<string, "AIResponseId">;
export type AITraceId = Brand<string, "AITraceId">;
export type AIProviderId = Brand<string, "AIProviderId">;
export type ModelId = Brand<string, "ModelId">;
export type PromptTemplateId = Brand<string, "PromptTemplateId">;
export type PromptVersionId = Brand<string, "PromptVersionId">;
export type ToolCallRequestId = Brand<string, "ToolCallRequestId">;
export type ToolCallResultId = Brand<string, "ToolCallResultId">;
export type MemoryEntryId = Brand<string, "MemoryEntryId">;
export type CostReportId = Brand<string, "CostReportId">;

export function asAIRequestId(s: string): AIRequestId { return s as AIRequestId; }
export function asAIResponseId(s: string): AIResponseId { return s as AIResponseId; }
export function asAITraceId(s: string): AITraceId { return s as AITraceId; }
export function asAIProviderId(s: string): AIProviderId { return s as AIProviderId; }
export function asModelId(s: string): ModelId { return s as ModelId; }
export function asPromptTemplateId(s: string): PromptTemplateId { return s as PromptTemplateId; }
export function asPromptVersionId(s: string): PromptVersionId { return s as PromptVersionId; }
export function asToolCallRequestId(s: string): ToolCallRequestId { return s as ToolCallRequestId; }
export function asToolCallResultId(s: string): ToolCallResultId { return s as ToolCallResultId; }
export function asMemoryEntryId(s: string): MemoryEntryId { return s as MemoryEntryId; }
export function asCostReportId(s: string): CostReportId { return s as CostReportId; }

// ---------------------------------------------------------------------------
// Provider & model configuration
// ---------------------------------------------------------------------------

/**
 * A registered AI provider. The `client` field is intentionally optional —
 * the platform supports provider descriptors (catalog entries) without a
 * live client. A real adapter (e.g. z-ai-web-dev-sdk) supplies `client`.
 */
export interface AIProviderConfig {
  readonly id: AIProviderId;
  readonly name: string;
  readonly vendor: string; // "openai" | "anthropic" | "zai" | "self-hosted"
  readonly models: readonly ModelId[];
  readonly client?: AIProviderClient;
  readonly defaultModel?: ModelId;
  readonly rateLimitPerMinute?: number;
  readonly costPreference?: "cheapest" | "balanced" | "highest_quality";
  readonly capabilities?: ReadonlySet<string>;
  readonly metadata?: Record<string, unknown>;
}

/**
 * The contract a pluggable provider adapter must implement. When `client`
 * is absent on a registered provider, the runtime returns a structured
 * "provider_not_configured" response rather than faking AI output.
 */
export interface AIProviderClient {
  readonly name: string;
  complete(req: AIProviderRequest): Promise<AIProviderResponse>;
  stream?(req: AIProviderRequest): AsyncIterable<StreamChunk>;
  embed?(input: string | readonly string[]): Promise<readonly number[][]>;
}

/** Internal request shape handed to a provider client. */
export interface AIProviderRequest {
  readonly model: ModelId;
  readonly systemPrompt?: string;
  readonly userPrompt: string;
  readonly variables?: Readonly<Record<string, string>>;
  readonly tools?: readonly ToolCallRequest[];
  readonly structuredOutputSchema?: StructuredOutputSchema;
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly stream?: boolean;
}

/** Internal response shape returned by a provider client. */
export interface AIProviderResponse {
  readonly content: string;
  readonly structuredOutput?: unknown;
  readonly toolCalls?: readonly ToolCallRequest[];
  readonly tokensUsed: TokenUsage;
  readonly finishReason: AIFinishReason;
  readonly model: ModelId;
  readonly providerId: AIProviderId;
  readonly latencyMs: number;
}

// ---------------------------------------------------------------------------
// Request & response
// ---------------------------------------------------------------------------

export type AIFinishReason =
  | "stop"
  | "length"
  | "tool_call"
  | "content_filter"
  | "safety_blocked"
  | "provider_not_configured"
  | "error";

export interface TokenUsage {
  readonly prompt: number;
  readonly completion: number;
  readonly total: number;
}

/**
 * The canonical AI request. Programs construct one of these to invoke the
 * AI runtime. The runtime resolves the prompt template, runs safety,
 * routes the model, calls the provider, validates output, tracks cost,
 * and emits events.
 */
export interface AIRequest {
  readonly id: AIRequestId;
  readonly programId: ProgramId;
  readonly participantId: AccountId;
  readonly promptId: PromptTemplateId;
  readonly variables: Readonly<Record<string, string>>;
  readonly model?: ModelId;
  readonly tools?: readonly ToolCallRequest[];
  readonly structuredOutput?: StructuredOutputSchema;
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly stream?: boolean;
  readonly consentReference?: string;
  readonly auditReference?: string;
  readonly correlationId?: CorrelationId;
  readonly traceId?: TraceId;
}

/** The canonical AI response. */
export interface AIResponse {
  readonly id: AIResponseId;
  readonly requestId: AIRequestId;
  readonly content: string;
  readonly structuredOutput?: unknown;
  readonly toolCalls?: readonly ToolCallRequest[];
  readonly model: ModelId;
  readonly tokensUsed: TokenUsage;
  readonly cost: CostEstimate;
  readonly latencyMs: number;
  readonly traceId: AITraceId;
  readonly finishReason: AIFinishReason;
  readonly providerId?: AIProviderId;
  readonly fallbackUsed?: boolean;
  readonly occurredAt: string;
}

// ---------------------------------------------------------------------------
// Prompt versioning
// ---------------------------------------------------------------------------

export interface PromptVersion {
  readonly id: PromptVersionId;
  readonly templateId: PromptTemplateId;
  readonly version: number;
  readonly template: string; // contains {var} placeholders
  readonly variables: readonly string[];
  readonly systemPrompt?: string;
  readonly defaultModel?: ModelId;
  readonly structuredOutputSchema?: StructuredOutputSchema;
  readonly changelog?: string;
  readonly active: boolean;
  readonly createdAt: string;
  readonly deprecatedAt?: string;
}

// ---------------------------------------------------------------------------
// Structured output
// ---------------------------------------------------------------------------

/**
 * A minimal JSON-schema-ish descriptor used to validate structured AI
 * output. Supports `type`, `properties`, `required`, `items`, and `enum`.
 * Sufficient for runtime validation without pulling a JSON-schema lib.
 */
export interface StructuredOutputSchema {
  readonly type: "object" | "array" | "string" | "number" | "boolean" | "integer";
  readonly properties?: Readonly<Record<string, StructuredOutputSchema>>;
  readonly items?: StructuredOutputSchema;
  readonly required?: readonly string[];
  readonly enum?: readonly (string | number)[];
  readonly description?: string;
}

export interface StructuredOutput {
  readonly schema: StructuredOutputSchema;
  readonly value: unknown;
  readonly valid: boolean;
  readonly errors: readonly string[];
  readonly validatedAt: string;
}

// ---------------------------------------------------------------------------
// Tool calling
// ---------------------------------------------------------------------------

export interface ToolCallRequest {
  readonly id: ToolCallRequestId;
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly reason?: string;
}

export interface ToolCallResult {
  readonly id: ToolCallResultId;
  readonly requestId: ToolCallRequestId;
  readonly name: string;
  readonly ok: boolean;
  readonly output?: unknown;
  readonly error?: string;
  readonly latencyMs: number;
  readonly occurredAt: string;
}

// ---------------------------------------------------------------------------
// Memory & retrieval
// ---------------------------------------------------------------------------

export type MemoryRole = "user" | "assistant" | "system" | "tool";

export interface MemoryEntry {
  readonly id: MemoryEntryId;
  readonly role: MemoryRole;
  readonly content: string;
  readonly tokensUsed?: number;
  readonly at: string;
  readonly metadata?: Record<string, unknown>;
}

export interface RetrievalQuery {
  readonly text: string;
  readonly topK?: number;
  readonly minScore?: number;
  readonly filter?: (entry: RetrievalResult) => boolean;
}

export interface RetrievalResult {
  readonly id: string;
  readonly text: string;
  readonly score: number;
  readonly metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

export interface StreamChunk {
  readonly delta: string;
  readonly done: boolean;
  readonly tokensSoFar?: number;
  readonly usage?: TokenUsage;
  readonly error?: string;
}

// ---------------------------------------------------------------------------
// Cost tracking
// ---------------------------------------------------------------------------

export interface CostEstimate {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly inputCostPer1k: number;
  readonly outputCostPer1k: number;
  readonly totalCost: number;
  readonly currency: string;
}

// ---------------------------------------------------------------------------
// Execution trace
// ---------------------------------------------------------------------------

export type AIExecutionStepKind =
  | "prompt_construction"
  | "safety_check"
  | "model_routing"
  | "provider_call"
  | "output_validation"
  | "tool_dispatch"
  | "fallback"
  | "response";

export interface AIExecutionStep {
  readonly kind: AIExecutionStepKind;
  readonly name: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly ok: boolean;
  readonly detail?: string;
  readonly output?: unknown;
}

export interface SafetyIntervention {
  readonly id: string;
  readonly traceId: AITraceId;
  readonly requestId: AIRequestId;
  readonly rule: string;
  readonly severity: "info" | "warn" | "error" | "critical";
  readonly reason: string;
  readonly blocked: boolean;
  readonly at: string;
}

export interface AIExecutionTrace {
  readonly id: AITraceId;
  readonly requestId: AIRequestId;
  readonly programId: ProgramId;
  readonly participantId: AccountId;
  readonly model?: ModelId;
  readonly providerId?: AIProviderId;
  readonly promptId?: PromptTemplateId;
  readonly promptVersion?: number;
  readonly steps: readonly AIExecutionStep[];
  readonly totalLatencyMs: number;
  readonly safetyInterventions: readonly SafetyIntervention[];
  readonly tokensUsed?: TokenUsage;
  readonly cost?: CostEstimate;
  readonly ok: boolean;
  readonly error?: string;
  readonly startedAt: string;
  readonly finishedAt: string;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type AIErrorCategory =
  | "provider_unavailable"
  | "safety_violation"
  | "rate_limited"
  | "invalid_output"
  | "timeout"
  | "quota_exceeded"
  | "validation"
  | "provider_not_configured"
  | "model_not_found"
  | "prompt_not_found"
  | "tool_failed";

export class AIError extends Error {
  readonly code: string;
  readonly category: AIErrorCategory;
  readonly retryable: boolean;
  readonly userMessage: string;
  readonly timestamp: string;
  readonly traceId?: AITraceId;
  readonly correlationId?: CorrelationId;
  readonly metadata: Record<string, unknown>;

  constructor(opts: {
    code: string;
    category: AIErrorCategory;
    message: string;
    userMessage?: string;
    retryable?: boolean;
    traceId?: AITraceId;
    correlationId?: CorrelationId;
    metadata?: Record<string, unknown>;
    cause?: unknown;
  }) {
    super(opts.message);
    this.name = "AIError";
    this.code = opts.code;
    this.category = opts.category;
    this.retryable = opts.retryable ?? false;
    this.userMessage = opts.userMessage ?? "An AI runtime error occurred.";
    this.timestamp = new Date().toISOString();
    this.traceId = opts.traceId;
    this.correlationId = opts.correlationId;
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
      traceId: this.traceId,
      correlationId: this.correlationId,
      metadata: this.metadata,
    };
  }
}

// ---------------------------------------------------------------------------
// AI events (published to the kernel event bus)
// ---------------------------------------------------------------------------

export const AI_EVENTS = {
  requestStarted: "eks.ai.request.started",
  requestCompleted: "eks.ai.request.completed",
  requestFailed: "eks.ai.request.failed",
  safetyIntervention: "eks.ai.safety.intervention",
  toolCalled: "eks.ai.tool.called",
  toolResult: "eks.ai.tool.result",
  modelFallback: "eks.ai.model.fallback",
  costTracked: "eks.ai.cost.tracked",
  streamChunk: "eks.ai.stream.chunk",
  structuredOutputValidated: "eks.ai.structured_output.validated",
  structuredOutputRejected: "eks.ai.structured_output.rejected",
  memoryStored: "eks.ai.memory.stored",
} as const;

export type AIEventType = (typeof AI_EVENTS)[keyof typeof AI_EVENTS];

// ---------------------------------------------------------------------------
// Stats & runtime configuration
// ---------------------------------------------------------------------------

export interface AIRuntimeStats {
  readonly totalRequests: number;
  readonly successfulRequests: number;
  readonly failedRequests: number;
  readonly avgLatencyMs: number;
  readonly p95LatencyMs: number;
  readonly totalCost: number;
  readonly totalTokens: TokenUsage;
  readonly errorRate: number;
  readonly safetyInterventions: number;
  readonly byProvider: Readonly<Record<string, number>>;
  readonly byModel: Readonly<Record<string, number>>;
}

export interface AIRuntimeConfig {
  readonly defaultModel?: ModelId;
  readonly defaultMaxTokens?: number;
  readonly defaultTemperature?: number;
  readonly costPreference?: "cheapest" | "balanced" | "highest_quality";
  readonly enableFallback?: boolean;
  readonly enableStreaming?: boolean;
}

// ---------------------------------------------------------------------------
// Re-exports for convenience
// ---------------------------------------------------------------------------

export type { ProgramId, AccountId, CorrelationId, TraceId };
