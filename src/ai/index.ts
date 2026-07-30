/**
 * Eks-Health AI Runtime — Public API Barrel
 *
 * Import everything from `@/ai` (server-only). The AI runtime is the safe,
 * observable, cost-tracked execution environment for all AI workloads on
 * the platform. The platform itself knows only generic AI concepts
 * (requests, prompts, providers, models, tools, agents, workflows,
 * observability) — never domain-specific coaching logic.
 *
 * Modules:
 *   - core/           Foundational types (AIRequest, AIResponse, AIError,
 *                     AI_EVENTS, etc.)
 *   - safety/         AI Safety Layer (PII detection, prompt-injection,
 *                     consent gating, output validation)
 *   - runtime/        AI Runtime Engine (provider routing, prompt
 *                     rendering, cost tracking, fallback, streaming)
 *   - agents/         Program AI Agents (multi-turn orchestration, memory,
 *                     tool dispatch)
 *   - workflows/      Workflow Engine (step graph validation, dispatch,
 *                     pause/resume/replay)
 *   - observability/  AI Observability (metrics, cost reports, percentile
 *                     computation, dashboards)
 */

export * from "./core";
export * from "./safety";
export * from "./runtime";
export * from "./agents";
export * from "./workflows";
export * from "./observability";
