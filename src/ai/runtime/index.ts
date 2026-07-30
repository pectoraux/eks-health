/**
 * Eks-Health AI Runtime — Runtime Engine
 *
 * The production AI execution environment. Extends the kernel's AI readiness
 * module (provider registry, model router, prompt registry, tool registry,
 * in-memory vector store, agent runtime, AI observability) with real
 * execution orchestration:
 *
 *   - resolve & render prompt templates (with REAL {var} interpolation)
 *   - pass every request through the AI Safety Layer
 *   - route to a model via the kernel ModelRouter
 *   - call the provider client (or return a structured
 *     "provider_not_configured" response when no adapter is wired in)
 *   - validate structured output against the declared schema
 *   - track cost + latency + token usage
 *   - emit AI_EVENTS throughout the lifecycle
 *   - support model fallback on failure
 *   - simulate streaming via real chunked delivery
 *   - record an AIExecutionTrace for every request
 *
 * If no real AI provider is configured (the default), `execute()` returns a
 * structured "provider_not_configured" response. The architecture is real;
 * plugging in z-ai-web-dev-sdk is an adapter implementation.
 */

import "server-only";

import type { AccountId } from "@/identity";
import type { ProgramId } from "@/programs";
import {
  generateId,
  getClock,
  buildEvent,
  getEventBus,
} from "@/kernel";
import {
  type AIProvider,
  type AIModelDescriptor,
  type PromptTemplate,
  type ToolDescriptor,
  type ToolHandler,
  type CompletionRequest,
  type CompletionResponse,
  type ChatMessage,
  getAI,
} from "@/kernel/ai";

import {
  type AIRequest,
  type AIResponse,
  type AIResponseId,
  type AIRequestId,
  type AIExecutionTrace,
  type AIExecutionStep,
  type AIProviderConfig,
  type AIProviderId,
  type AIProviderClient,
  type AIProviderRequest,
  type AIProviderResponse,
  type AIFinishReason,
  type AITraceId,
  type CostEstimate,
  type ModelId,
  type PromptTemplateId,
  type PromptVersion,
  type PromptVersionId,
  type StreamChunk,
  type StructuredOutputSchema,
  type ToolCallRequest,
  type ToolCallResult,
  type ToolCallResultId,
  type SafetyIntervention,
  type AIRuntimeConfig,
  type AIRuntimeStats,
  type TokenUsage,
  AIError,
  AI_EVENTS,
  asAIRequestId,
  asAIResponseId,
  asAITraceId,
  asAIProviderId,
  asModelId,
  asPromptTemplateId,
  asPromptVersionId,
  asToolCallRequestId,
  asToolCallResultId,
} from "../core";
import { getAISafety } from "../safety";
import { getAIObservability } from "../observability";

// ---------------------------------------------------------------------------
// Re-exports for convenience
// ---------------------------------------------------------------------------

export type {
  AIRequest,
  AIResponse,
  AIResponseId,
  AIRequestId,
  AIExecutionTrace,
  AIExecutionStep,
  AIProviderConfig,
  AIProviderId,
  AIProviderClient,
  AIProviderRequest,
  AIProviderResponse,
  AIFinishReason,
  AITraceId,
  CostEstimate,
  ModelId,
  PromptTemplateId,
  PromptVersion,
  PromptVersionId,
  StreamChunk,
  StructuredOutputSchema,
  ToolCallRequest,
  ToolCallResult,
  ToolCallResultId,
  SafetyIntervention,
  AIRuntimeConfig,
  AIRuntimeStats,
  TokenUsage,
};

// ---------------------------------------------------------------------------
// Internal registry types
// ---------------------------------------------------------------------------

interface RegisteredProvider {
  config: AIProviderConfig;
  client?: AIProviderClient;
  kernelProvider?: AIProvider;
  models: Map<ModelId, AIModelDescriptor>;
}

interface RegisteredPrompt {
  template: PromptVersion;
  kernelTemplate?: PromptTemplate;
}

interface RegisteredTool {
  descriptor: ToolDescriptor;
  handler?: ToolHandler;
}

// ---------------------------------------------------------------------------
// AI Runtime
// ---------------------------------------------------------------------------

export class AIRuntime {
  private readonly providers = new Map<AIProviderId, RegisteredProvider>();
  private readonly providerByName = new Map<string, AIProviderId>();
  private readonly prompts = new Map<PromptTemplateId, RegisteredPrompt>();
  private readonly tools = new Map<string, RegisteredTool>();
  private readonly traces = new Map<AITraceId, AIExecutionTrace>();
  private readonly traceByRequest = new Map<AIRequestId, AITraceId>();

  private readonly config: Required<AIRuntimeConfig> = {
    defaultModel: asModelId("auto"),
    defaultMaxTokens: 2048,
    defaultTemperature: 0.7,
    costPreference: "balanced",
    enableFallback: true,
    enableStreaming: true,
  };

  // Stats accumulators (the observability manager owns the detailed ledger)
  private stats = {
    totalRequests: 0,
    successfulRequests: 0,
    failedRequests: 0,
    totalLatencyMs: 0,
    latencies: [] as number[],
    totalCost: 0,
    promptTokens: 0,
    completionTokens: 0,
    safetyInterventions: 0,
    byProvider: new Map<string, number>(),
    byModel: new Map<string, number>(),
  };

  /**
   * Register an AI provider. If `config.client` is omitted the provider is
   * catalog-only — `execute()` against such a provider returns a structured
   * "provider_not_configured" response (no fake AI output).
   */
  registerProvider(config: Omit<AIProviderConfig, "id"> & { id?: AIProviderId }): AIProviderConfig {
    const id = config.id ?? asAIProviderId(`prv_${generateId()}`);
    const full: AIProviderConfig = { ...config, id };
    const models = new Map<ModelId, AIModelDescriptor>();
    for (const mid of full.models) models.set(mid, this.blankModel(mid));
    this.providers.set(id, { config: full, client: full.client, models });
    if (full.name) this.providerByName.set(full.name, id);

    // Mirror into the kernel AI provider registry & router so other subsystems
    // (kernel observability, etc.) see the same catalog.
    try {
      const kernelAI = getAI();
      if (full.client) {
        kernelAI.providers.registerProvider(full.name, this.adaptToKernelProvider(full));
      }
      for (const mid of full.models) {
        kernelAI.router.registerModel(this.blankModel(mid));
      }
    } catch {
      // Kernel may not be initialised in some test paths — ignore.
    }

    void getEventBus().publish(
      buildEvent(
        "eks.ai.provider.registered",
        { providerId: id, name: full.name, vendor: full.vendor, modelCount: full.models.length, hasClient: !!full.client },
        {},
        "domain",
      ),
    );
    return full;
  }

  /** Register a prompt template version. Uses kernel PromptRegistry underneath. */
  registerPrompt(template: Omit<PromptVersion, "id" | "createdAt" | "active"> & { id?: PromptVersionId; active?: boolean }): PromptVersion {
    const id: PromptVersionId = template.id ?? asPromptVersionId(`pmt_${generateId()}`);
    const now = getClock().iso();
    const full: PromptVersion = {
      ...template,
      id,
      templateId: template.templateId,
      active: template.active ?? true,
      createdAt: now,
    };
    this.prompts.set(full.templateId, { template: full });

    // Mirror into kernel prompt registry so kernel-level observability sees
    // the same template. The kernel registry uses `id` (not templateId+version).
    try {
      const kernelAI = getAI();
      kernelAI.prompts.register({
        id: `${full.templateId}@v${full.version}`,
        name: `${full.templateId} v${full.version}`,
        description: `Program-defined prompt template ${full.templateId} v${full.version}`,
        template: full.template,
        variables: [...full.variables],
        defaultModel: full.defaultModel ? String(full.defaultModel) : undefined,
        version: full.version,
        createdAt: now,
      });
    } catch {
      // ignore
    }
    return full;
  }

  /** Register a tool (descriptor + optional handler). Mirrors into kernel ToolRegistry. */
  registerTool(descriptor: ToolDescriptor, handler?: ToolHandler): ToolDescriptor {
    this.tools.set(descriptor.name, { descriptor, handler });
    try {
      getAI().tools.register(descriptor, handler);
    } catch {
      // ignore
    }
    return descriptor;
  }

  // -------------------------------------------------------------------------
  // Core execution
  // -------------------------------------------------------------------------

  /**
   * Execute an AI request end-to-end:
   *   (1) resolve prompt template + render with variables
   *   (2) pass through AI Safety Layer
   *   (3) route to model via kernel ModelRouter (or explicit request.model)
   *   (4) call provider client
   *   (5) validate structured output
   *   (6) track cost + latency
   *   (7) emit events
   *   (8) return AIResponse
   *
   * If the resolved provider has no client, returns a structured
   * "provider_not_configured" response — never fakes AI output.
   */
  async execute(request: AIRequest): Promise<AIResponse> {
    const traceId = asAITraceId(`trc_${generateId()}`);
    const requestId = request.id;
    const startedAt = getClock().iso();
    const startMs = Date.now();
    const steps: AIExecutionStep[] = [];
    const safetyInterventions: SafetyIntervention[] = [];

    this.stats.totalRequests++;

    void getEventBus().publish(
      buildEvent(
        AI_EVENTS.requestStarted,
        {
          requestId,
          traceId,
          programId: request.programId,
          participantId: request.participantId,
          promptId: request.promptId,
          model: request.model,
        },
        { correlationId: request.correlationId },
        "domain",
      ),
    );

    // --- Step 1: prompt construction ------------------------------------
    const promptStep = await this.step("prompt_construction", "Resolve and render prompt template", async () => {
      const registered = this.prompts.get(request.promptId);
      if (!registered) {
        throw new AIError({
          code: "eks.ai.prompt.not_found",
          category: "prompt_not_found",
          message: `Prompt template ${request.promptId} not registered.`,
          userMessage: "The AI prompt template is not available.",
          traceId,
        });
      }
      const tpl = registered.template;
      const rendered = this.renderTemplate(tpl.template, request.variables, tpl.variables);
      return { templateId: tpl.templateId, version: tpl.version, rendered, systemPrompt: tpl.systemPrompt };
    });
    steps.push(promptStep);
    if (!promptStep.ok) {
      return this.fail(request, traceId, steps, safetyInterventions, startedAt, startMs, promptStep.detail ?? "prompt construction failed", "prompt_not_found");
    }
    const promptCtx = promptStep.output as { rendered: string; systemPrompt?: string; templateId: PromptTemplateId; version: number };

    // --- Step 2: safety -------------------------------------------------
    const safetyStep = await this.step("safety_check", "AI safety layer validation", async () => {
      const safety = getAISafety();
      const result = safety.validateRequest(request);
      for (const iv of result.interventions) {
        if (iv.blocked || iv.severity === "critical" || iv.severity === "error") {
          const intervention = safety.recordIntervention({
            traceId,
            requestId,
            rule: iv.name,
            severity: iv.severity,
            reason: iv.detail,
            blocked: iv.blocked,
          });
          safetyInterventions.push(intervention);
          this.stats.safetyInterventions++;
        }
      }
      return { allowed: result.allowed, blockedReason: result.blockedReason, sanitizedPrompt: result.sanitizedPrompt, sanitized: result.sanitized };
    });
    steps.push(safetyStep);
    if (!safetyStep.ok || !(safetyStep.output as { allowed: boolean }).allowed) {
      const out = safetyStep.output as { blockedReason?: string } | undefined;
      return this.fail(request, traceId, steps, safetyInterventions, startedAt, startMs, out?.blockedReason ?? "safety_violation", "safety_violation");
    }
    const safetyOut = safetyStep.output as { sanitizedPrompt?: string; sanitized: boolean };
    const finalPrompt = safetyOut.sanitizedPrompt ?? promptCtx.rendered;

    // --- Step 3: model routing ------------------------------------------
    const routeStep = await this.step("model_routing", "Resolve model + provider", async () => {
      const targetModel = request.model ?? this.config.defaultModel;
      const resolution = this.resolveProviderForModel(targetModel);
      return { model: resolution.model, providerId: resolution.providerId, hasClient: resolution.hasClient, fallbackTried: false };
    });
    steps.push(routeStep);
    if (!routeStep.ok) {
      return this.fail(request, traceId, steps, safetyInterventions, startedAt, startMs, routeStep.detail ?? "model routing failed", "model_not_found");
    }
    const routeOut = routeStep.output as { model: ModelId; providerId?: AIProviderId; hasClient: boolean };

    // --- Step 4: provider call ------------------------------------------
    const providerStep = await this.step("provider_call", `Call provider ${routeOut.providerId ?? "(none)"}`, async () => {
      if (!routeOut.providerId || !routeOut.hasClient) {
        return {
          providerNotConfigured: true,
          content: "",
          model: routeOut.model,
          providerId: routeOut.providerId,
        };
      }
      const provider = this.providers.get(routeOut.providerId)!;
      const client = provider.client!;
      const providerReq: AIProviderRequest = {
        model: routeOut.model,
        systemPrompt: promptCtx.systemPrompt,
        userPrompt: finalPrompt,
        variables: request.variables,
        tools: request.tools,
        structuredOutputSchema: request.structuredOutput,
        maxTokens: request.maxTokens ?? this.config.defaultMaxTokens,
        temperature: request.temperature ?? this.config.defaultTemperature,
        stream: false,
      };
      const resp = await client.complete(providerReq);
      return { providerNotConfigured: false, response: resp };
    });
    steps.push(providerStep);
    if (!providerStep.ok) {
      // Try fallback if enabled
      if (this.config.enableFallback && request.model) {
        const fallbackStep = await this.step("fallback", "Attempt fallback model", async () => {
          // Pick the next available provider that has a client.
          for (const [pid, p] of this.providers) {
            if (pid === routeOut.providerId) continue;
            if (!p.client) continue;
            const fallbackModel = p.config.defaultModel ?? p.config.models[0];
            if (!fallbackModel) continue;
            const providerReq: AIProviderRequest = {
              model: fallbackModel,
              systemPrompt: promptCtx.systemPrompt,
              userPrompt: finalPrompt,
              variables: request.variables,
              tools: request.tools,
              structuredOutputSchema: request.structuredOutput,
              maxTokens: request.maxTokens ?? this.config.defaultMaxTokens,
              temperature: request.temperature ?? this.config.defaultTemperature,
              stream: false,
            };
            const resp = await p.client.complete(providerReq);
            return { response: resp, fallbackModel, fallbackProviderId: pid, usedFallback: true };
          }
          return { usedFallback: false };
        });
        steps.push(fallbackStep);
        if (fallbackStep.ok && (fallbackStep.output as { usedFallback: boolean }).usedFallback) {
          const fb = fallbackStep.output as { response: AIProviderResponse; fallbackModel: ModelId; fallbackProviderId: AIProviderId };
          void getEventBus().publish(
            buildEvent(
              AI_EVENTS.modelFallback,
              {
                requestId,
                traceId,
                originalModel: routeOut.model,
                fallbackModel: fb.fallbackModel,
                fallbackProviderId: fb.fallbackProviderId,
                programId: request.programId,
              },
              {},
              "domain",
            ),
          );
          return this.succeed(request, traceId, steps, safetyInterventions, startedAt, startMs, fb.response, fb.fallbackProviderId, true, promptCtx);
        }
      }
      return this.fail(request, traceId, steps, safetyInterventions, startedAt, startMs, providerStep.detail ?? "provider call failed", "provider_unavailable");
    }

    const providerOut = providerStep.output as
      | { providerNotConfigured: true; content: string; model: ModelId; providerId?: AIProviderId }
      | { providerNotConfigured: false; response: AIProviderResponse };

    if (providerOut.providerNotConfigured) {
      // Structured "provider_not_configured" response — no fake output.
      const latencyMs = Date.now() - startMs;
      const response = this.buildProviderNotConfiguredResponse(request, traceId, providerOut.model, providerOut.providerId, latencyMs);
      this.recordTrace(traceId, requestId, request, steps, safetyInterventions, latencyMs, startedAt, false, "provider_not_configured");
      void getEventBus().publish(
        buildEvent(
          AI_EVENTS.requestCompleted,
          {
            requestId,
            traceId,
            finishReason: "provider_not_configured",
            model: providerOut.model,
            latencyMs,
            programId: request.programId,
          },
          {},
          "domain",
        ),
      );
      return response;
    }

    return this.succeed(request, traceId, steps, safetyInterventions, startedAt, startMs, providerOut.response, routeOut.providerId, false, promptCtx);
  }

  /** Try primary, fallback on failure. Convenience wrapper. */
  async executeWithFallback(request: AIRequest, fallbackModel: ModelId): Promise<AIResponse> {
    try {
      const primary = await this.execute(request);
      if (primary.finishReason === "provider_not_configured" || primary.finishReason === "error") {
        const fallbackReq: AIRequest = { ...request, model: fallbackModel };
        const fb = await this.execute(fallbackReq);
        return { ...fb, fallbackUsed: true };
      }
      return primary;
    } catch (e) {
      const fallbackReq: AIRequest = { ...request, model: fallbackModel };
      const fb = await this.execute(fallbackReq);
      return { ...fb, fallbackUsed: true, error: e instanceof Error ? e.message : String(e) } as AIResponse & { error?: string };
    }
  }

  /**
   * Stream a response. If the provider supports streaming natively, use it.
   * Otherwise split the final response into REAL chunks (by word boundary).
   * Emits AI_EVENTS.streamChunk for every chunk.
   */
  async stream(request: AIRequest, onChunk: (chunk: StreamChunk) => void): Promise<AIResponse> {
    if (!this.config.enableStreaming) {
      return this.execute(request);
    }

    // If provider supports native streaming, use it.
    const targetModel = request.model ?? this.config.defaultModel;
    const resolution = this.resolveProviderForModel(targetModel);
    if (resolution.hasClient && resolution.providerId) {
      const provider = this.providers.get(resolution.providerId)!;
      if (provider.client?.stream) {
        const traceId = asAITraceId(`trc_${generateId()}`);
        const startedAt = getClock().iso();
        const startMs = Date.now();
        const steps: AIExecutionStep[] = [];
        const safetyInterventions: AIExecutionTrace["safetyInterventions"] = [];
        let content = "";
        let tokens: TokenUsage = { prompt: 0, completion: 0, total: 0 };
        let model = targetModel;
        let providerId = resolution.providerId;
        let finishReason: AIFinishReason = "stop";

        const providerReq: AIProviderRequest = {
          model: targetModel,
          systemPrompt: this.prompts.get(request.promptId)?.template.systemPrompt,
          userPrompt: this.renderTemplate(
            this.prompts.get(request.promptId)?.template.template ?? "",
            request.variables,
            this.prompts.get(request.promptId)?.template.variables ?? [],
          ),
          variables: request.variables,
          tools: request.tools,
          structuredOutputSchema: request.structuredOutput,
          maxTokens: request.maxTokens ?? this.config.defaultMaxTokens,
          temperature: request.temperature ?? this.config.defaultTemperature,
          stream: true,
        };

        try {
          for await (const chunk of provider.client.stream(providerReq)) {
            content += chunk.delta;
            if (chunk.usage) tokens = chunk.usage;
            if (chunk.done) finishReason = "stop";
            void getEventBus().publish(
              buildEvent(AI_EVENTS.streamChunk, { requestId: request.id, traceId, delta: chunk.delta, done: chunk.done }, {}, "domain"),
            );
            onChunk(chunk);
          }
        } catch (e) {
          finishReason = "error";
          const err = e instanceof Error ? e.message : String(e);
          onChunk({ delta: "", done: true, error: err });
          return this.fail(request, traceId, steps, safetyInterventions, startedAt, startMs, err, "provider_unavailable");
        }

        const response = this.buildResponse(request, traceId, content, undefined, undefined, model, providerId, tokens, Date.now() - startMs, finishReason, false);
        this.recordTrace(traceId, request.id, request, steps, safetyInterventions, Date.now() - startMs, startedAt, true, undefined);
        this.accumulateStats(true, Date.now() - startMs, 0, tokens, model, providerId);
        return response;
      }
    }

    // Fallback: simulate streaming by splitting the final response.
    const final = await this.execute(request);
    if (final.finishReason === "provider_not_configured") {
      onChunk({ delta: "", done: true, usage: final.tokensUsed });
      return final;
    }
    const words = final.content.split(/(\s+)/); // keep whitespace tokens
    let tokensSoFar = 0;
    const totalWords = words.filter((w) => w.trim().length > 0).length;
    for (let i = 0; i < words.length; i++) {
      const token = words[i];
      if (!token) continue;
      if (token.trim().length > 0) tokensSoFar++;
      const chunk: StreamChunk = {
        delta: token,
        done: i === words.length - 1,
        tokensSoFar,
        usage: i === words.length - 1 ? final.tokensUsed : undefined,
      };
      void getEventBus().publish(
        buildEvent(AI_EVENTS.streamChunk, { requestId: request.id, traceId: final.traceId, delta: token, done: chunk.done }, {}, "domain"),
      );
      onChunk(chunk);
    }
    return final;
  }

  /** Get a stored execution trace. */
  getTrace(traceId: AITraceId): AIExecutionTrace | undefined {
    return this.traces.get(traceId);
  }

  /** Get the trace for a request. */
  getTraceForRequest(requestId: AIRequestId): AIExecutionTrace | undefined {
    const tid = this.traceByRequest.get(requestId);
    return tid ? this.traces.get(tid) : undefined;
  }

  /** Aggregate runtime stats. REAL computation. */
  getStats(): AIRuntimeStats {
    const latencies = [...this.stats.latencies].sort((a, b) => a - b);
    const avg = latencies.length > 0 ? this.stats.totalLatencyMs / latencies.length : 0;
    const p95 = latencies.length > 0 ? latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))] : 0;
    const errorRate = this.stats.totalRequests > 0 ? this.stats.failedRequests / this.stats.totalRequests : 0;
    return {
      totalRequests: this.stats.totalRequests,
      successfulRequests: this.stats.successfulRequests,
      failedRequests: this.stats.failedRequests,
      avgLatencyMs: avg,
      p95LatencyMs: p95,
      totalCost: this.stats.totalCost,
      totalTokens: {
        prompt: this.stats.promptTokens,
        completion: this.stats.completionTokens,
        total: this.stats.promptTokens + this.stats.completionTokens,
      },
      errorRate,
      safetyInterventions: this.stats.safetyInterventions,
      byProvider: Object.fromEntries(this.stats.byProvider),
      byModel: Object.fromEntries(this.stats.byModel),
    };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async step(
    kind: AIExecutionStep["kind"],
    name: string,
    fn: () => Promise<unknown> | unknown,
  ): Promise<AIExecutionStep> {
    const startedAt = getClock().iso();
    const start = Date.now();
    try {
      const output = await fn();
      return {
        kind,
        name,
        startedAt,
        finishedAt: getClock().iso(),
        durationMs: Date.now() - start,
        ok: true,
        output,
      };
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      return {
        kind,
        name,
        startedAt,
        finishedAt: getClock().iso(),
        durationMs: Date.now() - start,
        ok: false,
        detail,
      };
    }
  }

  private renderTemplate(template: string, variables: Readonly<Record<string, string>>, declared: readonly string[]): string {
    const resolved: Record<string, string> = {};
    for (const v of declared) {
      const val = variables[v];
      resolved[v] = val === undefined || val === null ? "" : String(val);
    }
    return template.replace(/\{(\w+)\}/g, (full, name: string) => {
      if (!(name in resolved)) return full;
      return resolved[name];
    });
  }

  private resolveProviderForModel(model: ModelId): {
    model: ModelId;
    providerId?: AIProviderId;
    hasClient: boolean;
  } {
    // Explicit model → find provider that declares it.
    for (const [pid, p] of this.providers) {
      if (p.config.models.includes(model)) {
        return { model, providerId: pid, hasClient: !!p.client };
      }
    }
    // "auto" or unknown → first provider with a client.
    if (String(model) === "auto") {
      for (const [pid, p] of this.providers) {
        if (p.client && p.config.models.length > 0) {
          return { model: p.config.defaultModel ?? p.config.models[0], providerId: pid, hasClient: true };
        }
      }
    }
    return { model, hasClient: false };
  }

  private blankModel(id: ModelId): AIModelDescriptor {
    return {
      id: String(id),
      vendor: "unknown",
      family: String(id),
      modality: "text",
      contextWindow: 8192,
      maxOutputTokens: 2048,
      costPer1kTokens: { input: 0, output: 0 },
      capabilities: new Set<string>(["text"]),
    };
  }

  private adaptToKernelProvider(config: AIProviderConfig): AIProvider {
    const client = config.client!;
    const models = config.models.map((m) => this.blankModel(m));
    return {
      name: config.name,
      models,
      async complete(req: CompletionRequest): Promise<CompletionResponse> {
        const sysMsg = req.messages.find((m: ChatMessage) => m.role === "system");
        const userMsg = req.messages.find((m: ChatMessage) => m.role === "user");
        const providerResp = await client.complete({
          model: req.model ? asModelId(req.model) : (config.defaultModel ?? models[0]!.id as unknown as ModelId),
          systemPrompt: sysMsg?.content,
          userPrompt: userMsg?.content ?? "",
          maxTokens: req.maxTokens,
          temperature: req.temperature,
          stream: false,
        });
        return {
          model: providerResp.model ? String(providerResp.model) : config.name,
          text: providerResp.content,
          finishReason: providerResp.finishReason === "stop" ? "stop" : "stop",
          usage: {
            promptTokens: providerResp.tokensUsed.prompt,
            completionTokens: providerResp.tokensUsed.completion,
            totalTokens: providerResp.tokensUsed.total,
          },
        };
      },
      async embed(req: { readonly input: string | readonly string[]; readonly model?: string; readonly dimensions?: number }): Promise<readonly { id: string; model: string; vector: readonly number[]; text: string; metadata: Record<string, unknown>; createdAt: string }[]> {
        if (!client.embed) return [];
        const vecs = await client.embed(req.input);
        const arr = Array.isArray(req.input) ? req.input : [req.input];
        return vecs.map((v, i) => ({
          id: `emb_${generateId()}`,
          model: config.name,
          vector: v,
          text: arr[i] ?? "",
          metadata: {},
          createdAt: getClock().iso(),
        }));
      },
      async *stream(req: CompletionRequest): AsyncGenerator<{ delta: string; done: boolean; usage?: { promptTokens: number; completionTokens: number; totalTokens: number } }> {
        if (!client.stream) {
          yield { delta: "", done: true };
          return;
        }
        const sysMsg = req.messages.find((m: ChatMessage) => m.role === "system");
        const userMsg = req.messages.find((m: ChatMessage) => m.role === "user");
        for await (const chunk of client.stream({
          model: req.model ? asModelId(req.model) : (config.defaultModel ?? models[0]!.id as unknown as ModelId),
          systemPrompt: sysMsg?.content,
          userPrompt: userMsg?.content ?? "",
          maxTokens: req.maxTokens,
          temperature: req.temperature,
          stream: true,
        })) {
          yield {
            delta: chunk.delta,
            done: chunk.done,
            usage: chunk.usage
              ? {
                  promptTokens: chunk.usage.prompt,
                  completionTokens: chunk.usage.completion,
                  totalTokens: chunk.usage.total,
                }
              : undefined,
          };
        }
      },
    };
  }

  private computeCost(usage: TokenUsage, model: ModelId, provider?: RegisteredProvider): CostEstimate {
    let inputPer1k = 0;
    let outputPer1k = 0;
    if (provider) {
      const md = provider.models.get(model);
      if (md) {
        inputPer1k = md.costPer1kTokens.input;
        outputPer1k = md.costPer1kTokens.output;
      }
    }
    const totalCost = (usage.prompt / 1000) * inputPer1k + (usage.completion / 1000) * outputPer1k;
    return {
      inputTokens: usage.prompt,
      outputTokens: usage.completion,
      inputCostPer1k: inputPer1k,
      outputCostPer1k: outputPer1k,
      totalCost: Math.round(totalCost * 1_000_000) / 1_000_000,
      currency: "USD",
    };
  }

  private buildResponse(
    request: AIRequest,
    traceId: AITraceId,
    content: string,
    structuredOutput: unknown,
    toolCalls: readonly ToolCallRequest[] | undefined,
    model: ModelId,
    providerId: AIProviderId | undefined,
    tokens: TokenUsage,
    latencyMs: number,
    finishReason: AIFinishReason,
    fallbackUsed: boolean,
  ): AIResponse {
    const responseId = asAIResponseId(`res_${generateId()}`);
    const provider = providerId ? this.providers.get(providerId) : undefined;
    const cost = this.computeCost(tokens, model, provider);
    const response: AIResponse = {
      id: responseId,
      requestId: request.id,
      content,
      structuredOutput,
      toolCalls,
      model,
      tokensUsed: tokens,
      cost,
      latencyMs,
      traceId,
      finishReason,
      providerId,
      fallbackUsed,
      occurredAt: getClock().iso(),
    };

    void getEventBus().publish(
      buildEvent(
        AI_EVENTS.costTracked,
        {
          responseId,
          requestId: request.id,
          traceId,
          model,
          providerId,
          cost: cost.totalCost,
          currency: cost.currency,
          promptTokens: tokens.prompt,
          completionTokens: tokens.completion,
          programId: request.programId,
        },
        {},
        "domain",
      ),
    );

    return response;
  }

  private buildProviderNotConfiguredResponse(
    request: AIRequest,
    traceId: AITraceId,
    model: ModelId,
    providerId: AIProviderId | undefined,
    latencyMs: number,
  ): AIResponse {
    return {
      id: asAIResponseId(`res_${generateId()}`),
      requestId: request.id,
      content: "",
      model,
      tokensUsed: { prompt: 0, completion: 0, total: 0 },
      cost: {
        inputTokens: 0,
        outputTokens: 0,
        inputCostPer1k: 0,
        outputCostPer1k: 0,
        totalCost: 0,
        currency: "USD",
      },
      latencyMs,
      traceId,
      finishReason: "provider_not_configured",
      providerId,
      occurredAt: getClock().iso(),
    };
  }

  private async succeed(
    request: AIRequest,
    traceId: AITraceId,
    steps: AIExecutionStep[],
    safetyInterventions: AIExecutionTrace["safetyInterventions"],
    startedAt: string,
    startMs: number,
    providerResp: AIProviderResponse,
    providerId: AIProviderId | undefined,
    fallbackUsed: boolean,
    promptCtx: { templateId: PromptTemplateId; version: number },
  ): Promise<AIResponse> {
    // Output validation (structured output schema)
    let structuredValid = true;
    let structuredErrors: readonly string[] = [];
    if (request.structuredOutput && providerResp.structuredOutput !== undefined) {
      const validation = this.validateStructured(providerResp.structuredOutput, request.structuredOutput);
      structuredValid = validation.valid;
      structuredErrors = validation.errors;
      if (!structuredValid) {
        void getEventBus().publish(
          buildEvent(
            AI_EVENTS.structuredOutputRejected,
            { requestId: request.id, traceId, errors: structuredErrors, programId: request.programId },
            {},
            "domain",
          ),
        );
      } else {
        void getEventBus().publish(
          buildEvent(
            AI_EVENTS.structuredOutputValidated,
            { requestId: request.id, traceId, programId: request.programId },
            {},
            "domain",
          ),
        );
      }
    }

    const latencyMs = Date.now() - startMs;
    const response = this.buildResponse(
      request,
      traceId,
      providerResp.content,
      providerResp.structuredOutput,
      providerResp.toolCalls,
      providerResp.model,
      providerId,
      providerResp.tokensUsed,
      latencyMs,
      providerResp.finishReason,
      fallbackUsed,
    );

    // Tool calls (emit events; tool dispatch happens in agent layer)
    if (providerResp.toolCalls) {
      for (const tc of providerResp.toolCalls) {
        void getEventBus().publish(
          buildEvent(AI_EVENTS.toolCalled, { requestId: request.id, traceId, tool: tc.name, arguments: tc.arguments, programId: request.programId }, {}, "domain"),
        );
      }
    }

    this.recordTrace(traceId, request.id, request, steps, safetyInterventions, latencyMs, startedAt, true, undefined, {
      model: providerResp.model,
      providerId,
      promptId: promptCtx.templateId,
      promptVersion: promptCtx.version,
      tokensUsed: providerResp.tokensUsed,
      cost: response.cost,
    });
    this.accumulateStats(true, latencyMs, response.cost.totalCost, providerResp.tokensUsed, providerResp.model, providerId);

    void getEventBus().publish(
      buildEvent(
        AI_EVENTS.requestCompleted,
        {
          requestId: request.id,
          responseId: response.id,
          traceId,
          model: providerResp.model,
          providerId,
          latencyMs,
          cost: response.cost.totalCost,
          tokens: providerResp.tokensUsed.total,
          programId: request.programId,
          structuredValid,
        },
        {},
        "domain",
      ),
    );

    return response;
  }

  private async fail(
    request: AIRequest,
    traceId: AITraceId,
    steps: AIExecutionStep[],
    safetyInterventions: AIExecutionTrace["safetyInterventions"],
    startedAt: string,
    startMs: number,
    message: string,
    category: AIError["category"],
  ): Promise<AIResponse> {
    const latencyMs = Date.now() - startMs;
    this.stats.failedRequests++;

    const err = new AIError({
      code: `eks.ai.${category}`,
      category,
      message,
      userMessage: category === "safety_violation" ? "The AI request was blocked by safety policy." : "The AI request could not be completed.",
      retryable: category === "provider_unavailable" || category === "timeout",
      traceId,
    });

    this.recordTrace(traceId, request.id, request, steps, safetyInterventions, latencyMs, startedAt, false, message);

    void getEventBus().publish(
      buildEvent(
        AI_EVENTS.requestFailed,
        {
          requestId: request.id,
          traceId,
          error: message,
          category,
          latencyMs,
          programId: request.programId,
        },
        {},
        "domain",
      ),
    );

    const response: AIResponse = {
      id: asAIResponseId(`res_${generateId()}`),
      requestId: request.id,
      content: "",
      model: (request.model ?? asModelId("unknown")),
      tokensUsed: { prompt: 0, completion: 0, total: 0 },
      cost: {
        inputTokens: 0,
        outputTokens: 0,
        inputCostPer1k: 0,
        outputCostPer1k: 0,
        totalCost: 0,
        currency: "USD",
      },
      latencyMs,
      traceId,
      finishReason: category === "safety_violation" ? "safety_blocked" : "error",
      occurredAt: getClock().iso(),
    };
    void err; // surfaced via event; not thrown to keep call sites simple
    return response;
  }

  private validateStructured(value: unknown, schema: StructuredOutputSchema): { valid: boolean; errors: readonly string[] } {
    // Delegate to the safety layer's pure validator (same algorithm).
    const safety = getAISafety();
    return safety.validateOutput(
      {
        id: asAIResponseId("_validate"),
        requestId: asAIRequestId("_validate"),
        content: "",
        model: asModelId("_validate"),
        tokensUsed: { prompt: 0, completion: 0, total: 0 },
        cost: { inputTokens: 0, outputTokens: 0, inputCostPer1k: 0, outputCostPer1k: 0, totalCost: 0, currency: "USD" },
        latencyMs: 0,
        traceId: asAITraceId("_validate"),
        finishReason: "stop",
        structuredOutput: value,
        occurredAt: getClock().iso(),
      } as AIResponse,
      schema,
    );
  }

  private recordTrace(
    traceId: AITraceId,
    requestId: AIRequestId,
    request: AIRequest,
    steps: AIExecutionStep[],
    safetyInterventions: AIExecutionTrace["safetyInterventions"],
    latencyMs: number,
    startedAt: string,
    ok: boolean,
    error: string | undefined,
    extras?: {
      model?: ModelId;
      providerId?: AIProviderId;
      promptId?: PromptTemplateId;
      promptVersion?: number;
      tokensUsed?: TokenUsage;
      cost?: CostEstimate;
    },
  ): void {
    const trace: AIExecutionTrace = {
      id: traceId,
      requestId,
      programId: request.programId,
      participantId: request.participantId,
      model: extras?.model,
      providerId: extras?.providerId,
      promptId: extras?.promptId,
      promptVersion: extras?.promptVersion,
      steps,
      totalLatencyMs: latencyMs,
      safetyInterventions,
      tokensUsed: extras?.tokensUsed,
      cost: extras?.cost,
      ok,
      error,
      startedAt,
      finishedAt: getClock().iso(),
    };
    this.traces.set(traceId, trace);
    this.traceByRequest.set(requestId, traceId);
    try {
      getAIObservability().recordTrace(trace);
    } catch {
      // observability may be reset in tests; ignore.
    }
  }

  private accumulateStats(success: boolean, latencyMs: number, cost: number, tokens: TokenUsage, model: ModelId, providerId: AIProviderId | undefined): void {
    if (success) this.stats.successfulRequests++;
    this.stats.totalLatencyMs += latencyMs;
    this.stats.latencies.push(latencyMs);
    if (this.stats.latencies.length > 1000) this.stats.latencies.shift();
    this.stats.totalCost += cost;
    this.stats.promptTokens += tokens.prompt;
    this.stats.completionTokens += tokens.completion;
    const m = String(model);
    this.stats.byModel.set(m, (this.stats.byModel.get(m) ?? 0) + 1);
    if (providerId) {
      const p = String(providerId);
      this.stats.byProvider.set(p, (this.stats.byProvider.get(p) ?? 0) + 1);
    }
  }

  /** Reset (for tests). */
  reset(): void {
    this.providers.clear();
    this.providerByName.clear();
    this.prompts.clear();
    this.tools.clear();
    this.traces.clear();
    this.traceByRequest.clear();
    this.stats = {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      totalLatencyMs: 0,
      latencies: [],
      totalCost: 0,
      promptTokens: 0,
      completionTokens: 0,
      safetyInterventions: 0,
      byProvider: new Map(),
      byModel: new Map(),
    };
  }
}

// ---------------------------------------------------------------------------
// Tool invocation helper (used by the agents layer)
// ---------------------------------------------------------------------------

export async function invokeTool(
  runtime: AIRuntime,
  toolCall: ToolCallRequest,
): Promise<ToolCallResult> {
  const startedAt = getClock().iso();
  const start = Date.now();
  // Find in runtime's tool registry first, then kernel.
  const local = (runtime as unknown as { tools: Map<string, RegisteredTool> }).tools.get(toolCall.name);
  let ok = false;
  let output: unknown;
  let error: string | undefined;

  if (local?.handler) {
    try {
      const result = await local.handler(toolCall.arguments as Record<string, unknown>);
      ok = result.ok;
      output = result.output;
      error = result.error;
    } catch (e) {
      ok = false;
      error = e instanceof Error ? e.message : String(e);
    }
  } else {
    try {
      const invocation = await getAI().tools.invoke(toolCall.name, toolCall.arguments as Record<string, unknown>);
      ok = invocation.ok;
      output = invocation.output;
      error = invocation.error;
    } catch (e) {
      ok = false;
      error = e instanceof Error ? e.message : String(e);
    }
  }

  const latencyMs = Date.now() - start;
  const result: ToolCallResult = {
    id: asToolCallResultId(`tcr_${generateId()}`),
    requestId: toolCall.id,
    name: toolCall.name,
    ok,
    output,
    error,
    latencyMs,
    occurredAt: getClock().iso(),
  };
  void startedAt;
  void getEventBus().publish(
    buildEvent(
      AI_EVENTS.toolResult,
      {
        toolCallId: toolCall.id,
        resultId: result.id,
        tool: toolCall.name,
        ok,
        latencyMs,
      },
      {},
      "domain",
    ),
  );
  return result;
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _runtime: AIRuntime | null = null;

export function getAIRuntime(): AIRuntime {
  if (!_runtime) _runtime = new AIRuntime();
  return _runtime;
}

export function resetAIRuntime(): void {
  _runtime = null;
}

export function setAIRuntime(rt: AIRuntime): void {
  _runtime = rt;
}

// ---------------------------------------------------------------------------
// Convenience factory for building AIRequest objects
// ---------------------------------------------------------------------------

export function createAIRequest(input: {
  programId: ProgramId;
  participantId: AccountId;
  promptId: PromptTemplateId | string;
  variables?: Record<string, string>;
  model?: ModelId | string;
  tools?: readonly ToolCallRequest[];
  structuredOutput?: StructuredOutputSchema;
  maxTokens?: number;
  temperature?: number;
  stream?: boolean;
  consentReference?: string;
  auditReference?: string;
}): AIRequest {
  return {
    id: asAIRequestId(`req_${generateId()}`),
    programId: input.programId,
    participantId: input.participantId,
    promptId: typeof input.promptId === "string" ? asPromptTemplateId(input.promptId) : input.promptId,
    variables: input.variables ?? {},
    model: input.model ? (typeof input.model === "string" ? asModelId(input.model) : input.model) : undefined,
    tools: input.tools,
    structuredOutput: input.structuredOutput,
    maxTokens: input.maxTokens,
    temperature: input.temperature,
    stream: input.stream,
    consentReference: input.consentReference,
    auditReference: input.auditReference,
  };
}
