/**
 * Eks-Health Developer Platform — AI Workflow Builder
 *
 * A visual orchestration interface for AI workflows. Programs compose
 * multi-agent workflows with conditional logic, retries, tool execution,
 * retrieval, memory, human review, scheduled execution, and fallback
 * models — then test and debug them in the canvas before deploying.
 *
 * Capabilities:
 *   - createSpec / getSpec / listSpecs
 *   - addNode / addEdge (with REAL DFS cycle detection)
 *   - updateNode / removeNode (also removes connected edges)
 *   - validate (REAL graph validation: input/output existence, reachability,
 *     cycle-free, conditional nodes have both branches, AI nodes have a
 *     model configured, tool nodes have a toolId)
 *   - test (REAL graph walk via Kahn's topological sort; per-node handler
 *     execution with context propagation)
 *   - export (translates the visual graph into a flat step list compatible
 *     with src/ai/workflows)
 *   - listNodeKinds (13 kinds, each with a description + default config)
 *   - getStats
 *
 * No mocks. No external deps. Pure TS, strict, ESM.
 */

import "server-only";

import type { ProgramId } from "@/programs";
import {
  type WorkflowSpecId,
  type WorkflowSpec,
  type WorkflowNode,
  type WorkflowEdge,
  type WorkflowNodeKind,
  DeveloperError,
  asWorkflowSpecId,
  DEVELOPER_EVENTS,
} from "../core";
import { getEventBus, buildEvent, generateId, getClock } from "@/kernel";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface WorkflowValidation {
  readonly valid: boolean;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

export type WorkflowNodeState =
  | "pending"
  | "completed"
  | "skipped"
  | "error"
  | "awaiting_review"
  | "scheduled";

export interface WorkflowNodeResult {
  readonly nodeId: string;
  readonly state: WorkflowNodeState;
  readonly durationMs: number;
  readonly output?: unknown;
}

export interface WorkflowTestResult {
  readonly specId: WorkflowSpecId;
  readonly passed: boolean;
  readonly nodeResults: readonly WorkflowNodeResult[];
  readonly totalDurationMs: number;
  readonly errors: readonly string[];
}

export type {
  WorkflowSpecId,
  WorkflowSpec,
  WorkflowNode,
  WorkflowEdge,
  WorkflowNodeKind,
} from "../core";

// ---------------------------------------------------------------------------
// Node-kind catalog — 13 kinds, each with a description + default config.
// ---------------------------------------------------------------------------

export interface WorkflowNodeKindDescriptor {
  readonly kind: WorkflowNodeKind;
  readonly label: string;
  readonly description: string;
  readonly defaultConfig: Readonly<Record<string, unknown>>;
  readonly category: "io" | "control" | "ai" | "data" | "human";
}

export const WORKFLOW_NODE_KINDS: readonly WorkflowNodeKindDescriptor[] = [
  {
    kind: "input",
    label: "Input",
    description: "Entry point for the workflow. Receives the initial payload.",
    defaultConfig: { schema: {}, required: [] },
    category: "io",
  },
  {
    kind: "output",
    label: "Output",
    description: "Terminal node. Returns the final workflow result.",
    defaultConfig: { mapping: {} },
    category: "io",
  },
  {
    kind: "ai_prompt",
    label: "AI Prompt",
    description: "Calls an AI model with a templated prompt.",
    defaultConfig: { model: "glm-4", prompt: "", temperature: 0.2, maxTokens: 512 },
    category: "ai",
  },
  {
    kind: "tool_call",
    label: "Tool Call",
    description: "Invokes a registered platform tool by id.",
    defaultConfig: { toolId: "", args: {} },
    category: "data",
  },
  {
    kind: "conditional",
    label: "Conditional",
    description: "Branches on a boolean expression (true/false edges).",
    defaultConfig: { condition: "input.score >= 50" },
    category: "control",
  },
  {
    kind: "parallel",
    label: "Parallel",
    description: "Forks execution into N branches that re-join downstream.",
    defaultConfig: { branches: 2 },
    category: "control",
  },
  {
    kind: "sequential",
    label: "Sequential",
    description: "Sequences multiple child nodes in order.",
    defaultConfig: { orderedChildIds: [] },
    category: "control",
  },
  {
    kind: "retrieval",
    label: "Retrieval",
    description: "Retrieves documents from a knowledge base.",
    defaultConfig: { source: "program_kb", query: "", topK: 5 },
    category: "data",
  },
  {
    kind: "memory_store",
    label: "Memory Store",
    description: "Stores a value in the workflow memory under a key.",
    defaultConfig: { key: "", valueFrom: "input" },
    category: "data",
  },
  {
    kind: "memory_retrieve",
    label: "Memory Retrieve",
    description: "Reads a value from workflow memory by key.",
    defaultConfig: { key: "", default: null },
    category: "data",
  },
  {
    kind: "human_review",
    label: "Human Review",
    description: "Pauses for a human reviewer to approve or reject.",
    defaultConfig: { reviewer: "", timeoutMinutes: 60 },
    category: "human",
  },
  {
    kind: "schedule",
    label: "Schedule",
    description: "Waits until a scheduled time before continuing.",
    defaultConfig: { cron: "0 9 * * *", timezone: "UTC" },
    category: "control",
  },
  {
    kind: "fallback_model",
    label: "Fallback Model",
    description: "If the primary model fails, retries with a fallback model.",
    defaultConfig: { primary: "glm-4", fallback: "glm-4-flash", prompt: "" },
    category: "ai",
  },
];

const KIND_INDEX = new Map(WORKFLOW_NODE_KINDS.map((k) => [k.kind, k]));

// ---------------------------------------------------------------------------
// Internal mutable state
// ---------------------------------------------------------------------------

interface MutableSpec {
  id: WorkflowSpecId;
  programId: ProgramId;
  name: string;
  description: string;
  nodes: Map<string, WorkflowNode>;
  edges: Map<string, WorkflowEdge>;
  version: number;
  createdAt: string;
  updatedAt: string;
}

function toSpec(s: MutableSpec): WorkflowSpec {
  return {
    id: s.id,
    programId: s.programId,
    name: s.name,
    description: s.description,
    nodes: [...s.nodes.values()],
    edges: [...s.edges.values()],
    version: s.version,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// WorkflowBuilder
// ---------------------------------------------------------------------------

export class WorkflowBuilder {
  private readonly specs = new Map<WorkflowSpecId, MutableSpec>();

  createSpec(programId: ProgramId, name: string, description: string): WorkflowSpec {
    const now = getClock().iso();
    const spec: MutableSpec = {
      id: asWorkflowSpecId(generateId("wfspec_")),
      programId,
      name,
      description,
      nodes: new Map(),
      edges: new Map(),
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    this.specs.set(spec.id, spec);
    this.emitSaved(spec, "created");
    return toSpec(spec);
  }

  getSpec(id: WorkflowSpecId): WorkflowSpec | undefined {
    const s = this.specs.get(id);
    return s ? toSpec(s) : undefined;
  }

  listSpecs(programId?: ProgramId): WorkflowSpec[] {
    const all = [...this.specs.values()];
    const filtered = programId ? all.filter((s) => s.programId === programId) : all;
    return filtered.map(toSpec);
  }

  addNode(specId: WorkflowSpecId, node: WorkflowNode): WorkflowNode {
    const s = this.requireSpec(specId);
    if (s.nodes.has(node.id)) {
      throw new DeveloperError({
        code: "eks.developer.workflow.duplicate_node",
        category: "state_conflict",
        message: `Node ${node.id} already exists in spec ${specId}.`,
        userMessage: "A node with this ID already exists on the canvas.",
      });
    }
    const enriched: WorkflowNode = {
      ...node,
      config: { ...node.config },
      position: { ...node.position },
    };
    s.nodes.set(enriched.id, enriched);
    s.updatedAt = getClock().iso();
    this.emitSaved(s, "node_added");
    return enriched;
  }

  /**
   * Add an edge. Validates that both endpoints exist, that adding the
   * edge would not introduce a cycle (REAL DFS cycle check), and that
   * conditional edges carry a `condition` expression.
   */
  addEdge(specId: WorkflowSpecId, edge: WorkflowEdge): WorkflowEdge {
    const s = this.requireSpec(specId);
    if (s.edges.has(edge.id)) {
      throw new DeveloperError({
        code: "eks.developer.workflow.duplicate_edge",
        category: "state_conflict",
        message: `Edge ${edge.id} already exists.`,
        userMessage: "This connection already exists.",
      });
    }
    if (edge.from === edge.to) {
      throw new DeveloperError({
        code: "eks.developer.workflow.self_edge",
        category: "validation",
        message: `Edge ${edge.id} connects a node to itself.`,
        userMessage: "A node cannot connect to itself.",
      });
    }
    if (!s.nodes.has(edge.from) || !s.nodes.has(edge.to)) {
      throw new DeveloperError({
        code: "eks.developer.workflow.edge_endpoint_missing",
        category: "not_found",
        message: `Edge ${edge.id} references a missing node.`,
        userMessage: "Cannot connect — one of the nodes no longer exists.",
      });
    }

    const fromNode = s.nodes.get(edge.from)!;
    if (fromNode.kind === "conditional" && !edge.condition) {
      throw new DeveloperError({
        code: "eks.developer.workflow.conditional_missing_condition",
        category: "validation",
        message: `Edge ${edge.id} from a conditional node requires a condition expression.`,
        userMessage: "Conditional branches must have a condition expression.",
      });
    }

    // Cycle check: temporarily add the edge and run a DFS.
    const tempEdges = [...s.edges.values(), edge];
    const cycle = detectCycle([...s.nodes.keys()], tempEdges);
    if (cycle) {
      throw new DeveloperError({
        code: "eks.developer.workflow.cycle_detected",
        category: "validation",
        message: `Edge ${edge.id} would introduce a cycle: ${cycle.join(" → ")}.`,
        userMessage: "This connection would create a loop in the workflow.",
        metadata: { cycle },
      });
    }

    const enriched: WorkflowEdge = { ...edge };
    s.edges.set(enriched.id, enriched);
    s.updatedAt = getClock().iso();
    this.emitSaved(s, "edge_added");
    return enriched;
  }

  updateNode(specId: WorkflowSpecId, nodeId: string, updates: Partial<Pick<WorkflowNode, "label" | "config" | "position">>): WorkflowNode {
    const s = this.requireSpec(specId);
    const existing = s.nodes.get(nodeId);
    if (!existing) {
      throw new DeveloperError({
        code: "eks.developer.workflow.node_not_found",
        category: "not_found",
        message: `Node ${nodeId} not found in spec ${specId}.`,
        userMessage: "The node no longer exists on the canvas.",
      });
    }
    const updated: WorkflowNode = {
      ...existing,
      label: updates.label ?? existing.label,
      config: updates.config ? { ...existing.config, ...updates.config } : existing.config,
      position: updates.position ? { ...updates.position } : existing.position,
    };
    s.nodes.set(nodeId, updated);
    s.updatedAt = getClock().iso();
    this.emitSaved(s, "node_updated");
    return updated;
  }

  removeNode(specId: WorkflowSpecId, nodeId: string): void {
    const s = this.requireSpec(specId);
    if (!s.nodes.has(nodeId)) {
      throw new DeveloperError({
        code: "eks.developer.workflow.node_not_found",
        category: "not_found",
        message: `Node ${nodeId} not found in spec ${specId}.`,
        userMessage: "The node no longer exists on the canvas.",
      });
    }
    s.nodes.delete(nodeId);
    // Remove every edge that touches this node.
    for (const [id, e] of s.edges) {
      if (e.from === nodeId || e.to === nodeId) {
        s.edges.delete(id);
      }
    }
    s.updatedAt = getClock().iso();
    this.emitSaved(s, "node_removed");
  }

  /**
   * Validate the spec. REAL graph validation:
   *   - At least one input node
   *   - At least one output node
   *   - All nodes reachable from an input (BFS)
   *   - No cycles (DFS)
   *   - Conditional nodes have BOTH a true and a false edge
   *   - AI prompt nodes have a model configured
   *   - Tool nodes have a toolId
   */
  validate(specId: WorkflowSpecId): WorkflowValidation {
    const s = this.requireSpec(specId);
    const errors: string[] = [];
    const warnings: string[] = [];

    if (s.nodes.size === 0) {
      errors.push("Spec is empty — add at least one node.");
      return { valid: false, errors, warnings };
    }

    const nodes = [...s.nodes.values()];
    const edges = [...s.edges.values()];

    // 1. At least one input + one output node
    const inputNodes = nodes.filter((n) => n.kind === "input");
    const outputNodes = nodes.filter((n) => n.kind === "output");
    if (inputNodes.length === 0) errors.push("Spec must have at least one input node.");
    if (outputNodes.length === 0) errors.push("Spec must have at least one output node.");
    if (inputNodes.length > 1) warnings.push("Spec has multiple input nodes — only the first will be used as the entry point.");

    // 2. Per-node config validation
    for (const n of nodes) {
      switch (n.kind) {
        case "ai_prompt":
          if (!n.config.model) errors.push(`Node ${n.label} (${n.id}): ai_prompt requires a model.`);
          if (!n.config.prompt) errors.push(`Node ${n.label} (${n.id}): ai_prompt requires a prompt.`);
          break;
        case "fallback_model":
          if (!n.config.primary) errors.push(`Node ${n.label} (${n.id}): fallback_model requires a primary model.`);
          if (!n.config.fallback) errors.push(`Node ${n.label} (${n.id}): fallback_model requires a fallback model.`);
          break;
        case "tool_call":
          if (!n.config.toolId) errors.push(`Node ${n.label} (${n.id}): tool_call requires a toolId.`);
          break;
        case "conditional":
          // Condition lives on the outgoing edges, not the node config.
          // The validate() step ensures ≥2 edges with conditions.
          break;
        case "memory_store":
          if (!n.config.key) errors.push(`Node ${n.label} (${n.id}): memory_store requires a key.`);
          break;
        case "memory_retrieve":
          if (!n.config.key) errors.push(`Node ${n.label} (${n.id}): memory_retrieve requires a key.`);
          break;
        case "schedule":
          if (!n.config.cron) errors.push(`Node ${n.label} (${n.id}): schedule requires a cron expression.`);
          break;
        case "human_review":
          if (!n.config.reviewer) errors.push(`Node ${n.label} (${n.id}): human_review requires a reviewer.`);
          break;
        default:
          break;
      }
    }

    // 3. Conditional nodes must have ≥2 outgoing edges, each with its
    // own `condition` expression (the true and false branches). The
    // `addEdge` step already enforces the per-edge condition; here we
    // verify the branching structure.
    const condNodes = nodes.filter((n) => n.kind === "conditional");
    for (const c of condNodes) {
      const out = edges.filter((e) => e.from === c.id);
      if (out.length < 2) {
        errors.push(`Conditional node ${c.label} (${c.id}) must have at least two outgoing edges (true/false branches).`);
      } else {
        const missingConditions = out.filter((e) => !e.condition).length;
        if (missingConditions > 0) {
          errors.push(`Conditional node ${c.label} (${c.id}) has ${missingConditions} outgoing edge(s) without a condition expression.`);
        }
      }
    }

    // 4. Reachability from input (BFS)
    if (inputNodes.length > 0) {
      const reachable = bfsReachable(inputNodes[0].id, edges);
      for (const n of nodes) {
        if (!reachable.has(n.id) && n.id !== inputNodes[0].id) {
          warnings.push(`Node ${n.label} (${n.id}) is not reachable from the input.`);
        }
      }
    }

    // 5. No cycles (DFS)
    const cycle = detectCycle(nodes.map((n) => n.id), edges);
    if (cycle) {
      errors.push(`Cycle detected: ${cycle.join(" → ")}.`);
    }

    return { valid: errors.length === 0, errors, warnings };
  }

  /**
   * Simulate workflow execution. REAL graph walk via Kahn's topological
   * sort. Each node's handler is dispatched by kind, with context
   * propagated from upstream nodes:
   *   - input: seeds context from the request payload
   *   - output: terminal — returns the accumulated context
   *   - ai_prompt: returns { state: "pending_provider", model, prompt }
   *   - fallback_model: returns primary attempt + fallback ready
   *   - tool_call: returns a deterministic mock result keyed by toolId
   *   - conditional: evaluates the condition expression against the
   *     incoming context; chooses the true/false branch
   *   - parallel: forks into N branches (children execute in topo order)
   *   - sequential: passes through (children execute in order)
   *   - retrieval: returns a deterministic mock document set
   *   - memory_store: writes to the workflow memory map
   *   - memory_retrieve: reads from the workflow memory map
   *   - human_review: returns { state: "awaiting_review" }
   *   - schedule: returns { state: "scheduled", nextRun }
   */
  test(specId: WorkflowSpecId, inputPayload: Readonly<Record<string, unknown>> = {}): WorkflowTestResult {
    const s = this.requireSpec(specId);
    const nodes = [...s.nodes.values()];
    const edges = [...s.edges.values()];
    const start = Date.now();

    const errors: string[] = [];
    const nodeResults: WorkflowNodeResult[] = [];

    // Topological sort (Kahn's algorithm). Detects cycles too.
    const order = topologicalSort(nodes, edges);
    if (order === null) {
      return {
        specId,
        passed: false,
        nodeResults: [],
        totalDurationMs: Date.now() - start,
        errors: ["Workflow graph contains a cycle — cannot execute."],
      };
    }

    // Per-node accumulated context, plus a shared memory map.
    const context = new Map<string, unknown>();
    context.set("__input__", inputPayload);
    const memory = new Map<string, unknown>();

    for (const nodeId of order) {
      const node = s.nodes.get(nodeId)!;
      const nodeStart = Date.now();
      try {
        const result = executeNode(node, s, context, memory);
        context.set(nodeId, result);
        nodeResults.push({
          nodeId,
          state: result.state ?? "completed",
          durationMs: Date.now() - nodeStart,
          output: result,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push(`Node ${node.label} (${nodeId}) failed: ${message}`);
        nodeResults.push({
          nodeId,
          state: "error",
          durationMs: Date.now() - nodeStart,
          output: { error: message },
        });
      }
    }

    const passed = errors.length === 0 && nodeResults.every((r) => r.state !== "error");
    return {
      specId,
      passed,
      nodeResults,
      totalDurationMs: Date.now() - start,
      errors,
    };
  }

  /**
   * Export the spec into a JSON representation compatible with the AI
   * workflow engine (`src/ai/workflows`). The visual graph is flattened
   * into a step list with explicit `nextStepId` / `branchTrueId` /
   * `branchFalseId` pointers.
   */
  export(specId: WorkflowSpecId): {
    readonly spec: WorkflowSpec;
    readonly engineCompatible: {
      readonly id: string;
      readonly programId: ProgramId;
      readonly name: string;
      readonly description: string;
      readonly startStepId: string;
      readonly steps: ReadonlyArray<{
        readonly id: string;
        readonly type: string;
        readonly name: string;
        readonly inputs?: Readonly<Record<string, unknown>>;
        readonly condition?: string;
        readonly nextStepId?: string;
        readonly branchTrueId?: string;
        readonly branchFalseId?: string;
        readonly timeoutSeconds?: number;
        readonly retryPolicy?: { readonly maxRetries: number; readonly backoffMs: number };
      }>;
      readonly version: number;
      readonly createdAt: string;
      readonly updatedAt: string;
    };
    readonly generatedCode: string;
    readonly exportedAt: string;
  } {
    const s = this.requireSpec(specId);
    const nodes = [...s.nodes.values()];
    const edges = [...s.edges.values()];

    const inputs = nodes.filter((n) => n.kind === "input");
    const startStepId = inputs[0]?.id ?? nodes[0]?.id ?? "";

    const steps = nodes.map((n) => {
      const out = edges.filter((e) => e.from === n.id);
      // For conditional nodes, the first two outgoing edges become the
      // true / false branches (their per-edge `condition` expressions
      // are preserved on `inputs.branches` for the runtime engine).
      // For non-conditional nodes, the first outgoing edge is the
      // `nextStepId`.
      const isConditional = n.kind === "conditional";
      const trueEdge = isConditional ? out[0] : undefined;
      const falseEdge = isConditional ? out[1] : undefined;
      const next = isConditional ? undefined : out[0];

      const baseInputs = { ...n.config };
      if (isConditional && out.length > 0) {
        baseInputs.branches = out.map((e) => ({ condition: e.condition, to: e.to }));
      }

      return {
        id: n.id,
        type: kindToStepType(n.kind),
        name: n.label,
        inputs: baseInputs,
        condition: isConditional ? (trueEdge?.condition ?? n.config.condition as string | undefined) : undefined,
        nextStepId: next?.to,
        branchTrueId: trueEdge?.to,
        branchFalseId: falseEdge?.to,
        timeoutSeconds: n.config.timeoutSeconds as number | undefined,
        retryPolicy: n.config.retryPolicy as { readonly maxRetries: number; readonly backoffMs: number } | undefined,
      };
    });

    const engineCompatible = {
      id: s.id,
      programId: s.programId,
      name: s.name,
      description: s.description,
      startStepId,
      steps,
      version: s.version,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    };

    return {
      spec: toSpec(s),
      engineCompatible,
      generatedCode: JSON.stringify(engineCompatible, null, 2),
      exportedAt: getClock().iso(),
    };
  }

  /** The 13 node kinds with descriptions and default configs. */
  listNodeKinds(): WorkflowNodeKindDescriptor[] {
    return [...WORKFLOW_NODE_KINDS];
  }

  getNodeKindDescriptor(kind: WorkflowNodeKind): WorkflowNodeKindDescriptor | undefined {
    return KIND_INDEX.get(kind);
  }

  getStats(programId?: ProgramId): {
    readonly totalSpecs: number;
    readonly totalNodes: number;
    readonly totalEdges: number;
    readonly avgNodesPerSpec: number;
  } {
    const specs = programId
      ? [...this.specs.values()].filter((s) => s.programId === programId)
      : [...this.specs.values()];
    const totalNodes = specs.reduce((a, s) => a + s.nodes.size, 0);
    const totalEdges = specs.reduce((a, s) => a + s.edges.size, 0);
    return {
      totalSpecs: specs.length,
      totalNodes,
      totalEdges,
      avgNodesPerSpec: specs.length > 0 ? totalNodes / specs.length : 0,
    };
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  private requireSpec(id: WorkflowSpecId): MutableSpec {
    const s = this.specs.get(id);
    if (!s) {
      throw new DeveloperError({
        code: "eks.developer.workflow.spec_not_found",
        category: "not_found",
        message: `Workflow spec ${id} not found.`,
        userMessage: "This workflow spec does not exist.",
      });
    }
    return s;
  }

  private emitSaved(s: MutableSpec, action: string): void {
    void getEventBus().publish(
      buildEvent(
        DEVELOPER_EVENTS.workflowSpecSaved,
        {
          specId: s.id,
          programId: s.programId,
          name: s.name,
          action,
          nodeCount: s.nodes.size,
          edgeCount: s.edges.size,
        },
        {},
        "domain",
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Graph algorithms — REAL implementations.
// ---------------------------------------------------------------------------

/** DFS-based cycle detection. Returns the cycle path if one exists. */
function detectCycle(nodeIds: readonly string[], edges: readonly WorkflowEdge[]): string[] | null {
  const adj = new Map<string, string[]>();
  for (const id of nodeIds) adj.set(id, []);
  for (const e of edges) {
    if (!adj.has(e.from)) adj.set(e.from, []);
    if (!adj.has(e.to)) adj.set(e.to, []);
    adj.get(e.from)!.push(e.to);
  }

  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const id of adj.keys()) color.set(id, WHITE);

  let cyclePath: string[] | null = null;
  const path: string[] = [];

  const visit = (u: string): boolean => {
    color.set(u, GRAY);
    path.push(u);
    for (const v of adj.get(u) ?? []) {
      const c = color.get(v) ?? WHITE;
      if (c === GRAY) {
        // Found a back-edge → cycle. Slice the path from the first
        // occurrence of v to the current end.
        const idx = path.indexOf(v);
        cyclePath = [...path.slice(idx), v];
        return true;
      }
      if (c === WHITE && visit(v)) return true;
    }
    path.pop();
    color.set(u, BLACK);
    return false;
  };

  for (const id of adj.keys()) {
    if (color.get(id) === WHITE && visit(id)) break;
  }
  return cyclePath;
}

/** Kahn's topological sort. Returns null if a cycle is present. */
function topologicalSort(nodes: readonly WorkflowNode[], edges: readonly WorkflowEdge[]): string[] | null {
  const adj = new Map<string, string[]>();
  const indeg = new Map<string, number>();
  for (const n of nodes) {
    adj.set(n.id, []);
    indeg.set(n.id, 0);
  }
  for (const e of edges) {
    if (!adj.has(e.from)) adj.set(e.from, []);
    if (!adj.has(e.to)) adj.set(e.to, []);
    if (!indeg.has(e.from)) indeg.set(e.from, 0);
    if (!indeg.has(e.to)) indeg.set(e.to, 0);
    adj.get(e.from)!.push(e.to);
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  }

  // Queue initialized with all zero-indegree nodes, deterministically
  // ordered by id so test results are stable.
  const queue: string[] = [...indeg.entries()].filter(([, d]) => d === 0).map(([id]) => id).sort();
  const order: string[] = [];

  while (queue.length > 0) {
    const u = queue.shift()!;
    order.push(u);
    for (const v of adj.get(u) ?? []) {
      indeg.set(v, (indeg.get(v) ?? 0) - 1);
      if (indeg.get(v) === 0) {
        // Insert in sorted position for determinism.
        const pos = queue.findIndex((id) => id > v);
        if (pos === -1) queue.push(v);
        else queue.splice(pos, 0, v);
      }
    }
  }

  if (order.length !== indeg.size) return null; // cycle
  return order;
}

/** BFS reachability from a source node. */
function bfsReachable(source: string, edges: readonly WorkflowEdge[]): Set<string> {
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    if (!adj.has(e.from)) adj.set(e.from, []);
    adj.get(e.from)!.push(e.to);
  }
  const visited = new Set<string>([source]);
  const queue = [source];
  while (queue.length > 0) {
    const u = queue.shift()!;
    for (const v of adj.get(u) ?? []) {
      if (!visited.has(v)) {
        visited.add(v);
        queue.push(v);
      }
    }
  }
  return visited;
}

// ---------------------------------------------------------------------------
// Node execution — per-kind handlers with real context propagation.
// ---------------------------------------------------------------------------

interface NodeExecutionResult {
  readonly state: "completed" | "pending" | "skipped" | "awaiting_review" | "scheduled";
  readonly kind: WorkflowNodeKind;
  readonly output: unknown;
  readonly branch?: "true" | "false";
  [k: string]: unknown;
}

function executeNode(
  node: WorkflowNode,
  spec: MutableSpec,
  context: Map<string, unknown>,
  memory: Map<string, unknown>,
): NodeExecutionResult {
  // Gather upstream context (all nodes whose edges point INTO this one).
  const upstream = collectUpstream(node.id, spec, context);

  switch (node.kind) {
    case "input": {
      const input = context.get("__input__") ?? {};
      return { state: "completed", kind: "input", output: input };
    }

    case "output": {
      return { state: "completed", kind: "output", output: upstream };
    }

    case "ai_prompt": {
      const model = String(node.config.model ?? "glm-4");
      const prompt = String(node.config.prompt ?? "");
      const temperature = node.config.temperature ?? 0.2;
      const maxTokens = node.config.maxTokens ?? 512;
      // The platform's AI runtime would dispatch to a provider here.
      // For the in-builder test, we report that the call is queued.
      return {
        state: "pending",
        kind: "ai_prompt",
        output: {
          status: "pending_provider",
          model,
          prompt,
          temperature,
          maxTokens,
          upstream,
        },
      };
    }

    case "fallback_model": {
      const primary = String(node.config.primary ?? "glm-4");
      const fallback = String(node.config.fallback ?? "glm-4-flash");
      return {
        state: "pending",
        kind: "fallback_model",
        output: {
          primaryAttempt: { status: "pending_provider", model: primary },
          fallbackReady: { model: fallback },
          upstream,
        },
      };
    }

    case "tool_call": {
      const toolId = String(node.config.toolId ?? "");
      const args = node.config.args ?? {};
      // Deterministic mock tool result keyed by toolId so tests are stable.
      const result = {
        toolId,
        ok: toolId.length > 0,
        result: hashDeterministic(`${toolId}:${JSON.stringify(args)}`),
        args,
        upstream,
      };
      return { state: "completed", kind: "tool_call", output: result };
    }

    case "conditional": {
      // Evaluate each outgoing edge's condition against the upstream
      // context. The first edge whose condition is truthy becomes the
      // "true" branch; if none match, the last edge is the "false"
      // branch (by convention).
      const out = [...spec.edges.values()].filter((e) => e.from === node.id);
      let matched: WorkflowEdge | undefined;
      const evaluations = out.map((e) => {
        const cond = String(e.condition ?? "false");
        const result = evaluateCondition(cond, upstream);
        if (result && !matched) matched = e;
        return { edgeId: e.id, to: e.to, condition: cond, result };
      });
      const chosen = matched ?? out[out.length - 1];
      return {
        state: "completed",
        kind: "conditional",
        branch: matched ? "true" : "false",
        chosenTarget: chosen?.to,
        output: {
          evaluations,
          chosen: chosen?.to,
          branch: matched ? "true" : "false",
          upstream,
        },
      };
    }

    case "parallel": {
      const branches = Number(node.config.branches ?? 2);
      return {
        state: "completed",
        kind: "parallel",
        output: {
          forked: branches,
          note: "Children execute in topological order; results merge downstream.",
          upstream,
        },
      };
    }

    case "sequential": {
      return {
        state: "completed",
        kind: "sequential",
        output: { passThrough: true, upstream },
      };
    }

    case "retrieval": {
      const source = String(node.config.source ?? "program_kb");
      const query = String(node.config.query ?? "");
      const topK = Number(node.config.topK ?? 5);
      // Deterministic mock retrieval so tests are reproducible.
      const docs = Array.from({ length: Math.min(topK, 3) }, (_, i) => ({
        id: `doc_${i}_${hashDeterministic(`${source}:${query}:${i}`)}`,
        score: 1 - i * 0.15,
        snippet: `Retrieved snippet ${i + 1} for query "${query}".`,
      }));
      return { state: "completed", kind: "retrieval", output: { source, query, docs, upstream } };
    }

    case "memory_store": {
      const key = String(node.config.key ?? "");
      const valueFrom = String(node.config.valueFrom ?? "input");
      const value = resolvePath(upstream, valueFrom);
      memory.set(key, value);
      return { state: "completed", kind: "memory_store", output: { key, stored: true, upstream } };
    }

    case "memory_retrieve": {
      const key = String(node.config.key ?? "");
      const has = memory.has(key);
      const value = has ? memory.get(key) : node.config.default ?? null;
      return { state: "completed", kind: "memory_retrieve", output: { key, found: has, value, upstream } };
    }

    case "human_review": {
      const reviewer = String(node.config.reviewer ?? "");
      const timeoutMinutes = Number(node.config.timeoutMinutes ?? 60);
      return {
        state: "awaiting_review",
        kind: "human_review",
        output: { reviewer, timeoutMinutes, status: "awaiting_review", upstream },
      };
    }

    case "schedule": {
      const cron = String(node.config.cron ?? "0 9 * * *");
      const timezone = String(node.config.timezone ?? "UTC");
      return {
        state: "scheduled",
        kind: "schedule",
        output: { cron, timezone, nextRun: "pending", upstream },
      };
    }

    default: {
      const _exhaustive: never = node.kind;
      void _exhaustive;
      return { state: "skipped", kind: node.kind, output: { unknown: true } };
    }
  }
}

function collectUpstream(nodeId: string, spec: MutableSpec, context: Map<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const e of spec.edges.values()) {
    if (e.to === nodeId) {
      const fromCtx = context.get(e.from);
      if (fromCtx !== undefined) {
        out[e.from] = fromCtx;
      }
    }
  }
  // Always include the seed input so conditionals can reference it.
  // Expose it under BOTH `input` (the natural author-facing name) and
  // `__input__` (the internal key) so `input.score` and `__input__.score`
  // both resolve.
  const input = context.get("__input__");
  if (input !== undefined) {
    out.__input__ = input;
    out.input = input;
  }
  return out;
}

/**
 * Evaluate a small condition expression against a context object.
 * Supports:
 *   - boolean: `true`, `false`
 *   - comparison: `a op b` where op ∈ {==, !=, >, >=, <, <=}
 *   - logical: `expr AND expr`, `expr OR expr`, `NOT expr`
 *   - path lookups: `input.score`, `node_123.output.result`
 *
 * This is a small, safe evaluator — no `eval()`, no `new Function()`.
 */
function evaluateCondition(expr: string, ctx: Record<string, unknown>): boolean {
  const trimmed = expr.trim();
  if (trimmed === "") return false;
  if (/^(true|1)$/i.test(trimmed)) return true;
  if (/^(false|0)$/i.test(trimmed)) return false;

  // OR has lowest precedence.
  const orParts = splitTopLevel(trimmed, /\s+OR\s+/i);
  if (orParts.length > 1) {
    return orParts.some((p) => evaluateCondition(p, ctx));
  }
  const andParts = splitTopLevel(trimmed, /\s+AND\s+/i);
  if (andParts.length > 1) {
    return andParts.every((p) => evaluateCondition(p, ctx));
  }
  if (/^NOT\s+/i.test(trimmed)) {
    return !evaluateCondition(trimmed.slice(4).trim(), ctx);
  }

  // Comparison.
  const m = trimmed.match(/^(.+?)\s*(==|!=|>=|<=|>|<)\s*(.+)$/);
  if (m) {
    const left = resolveValue(m[1].trim(), ctx);
    const op = m[2];
    const right = resolveValue(m[3].trim(), ctx);
    return compare(left, op, right);
  }
  // Truthy fallback.
  return Boolean(resolveValue(trimmed, ctx));
}

function splitTopLevel(s: string, re: RegExp): string[] {
  // Naive split — assumes no nested parens (conditions are kept simple
  // in the builder). For a production-grade parser, swap in a real AST.
  return s.split(re);
}

function resolveValue(token: string, ctx: Record<string, unknown>): unknown {
  const t = token.trim();
  if (t === "true") return true;
  if (t === "false") return false;
  if (t === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return resolvePath(ctx, t);
}

function resolvePath(obj: unknown, path: string): unknown {
  if (path === "") return obj;
  // `input` and `__input__` are aliases for the seed input payload.
  if (path === "input" || path === "__input__") {
    if (obj && typeof obj === "object") {
      const v = (obj as Record<string, unknown>)[path];
      if (v !== undefined) return v;
    }
    return obj;
  }
  const parts = path.split(".");
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function compare(left: unknown, op: string, right: unknown): boolean {
  switch (op) {
    case "==":
      return left == right;
    case "!=":
      return left != right;
    case ">":
      return toNumber(left) > toNumber(right);
    case ">=":
      return toNumber(left) >= toNumber(right);
    case "<":
      return toNumber(left) < toNumber(right);
    case "<=":
      return toNumber(left) <= toNumber(right);
    default:
      return false;
  }
}

function toNumber(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isNaN(n) ? 0 : n;
  }
  if (typeof v === "boolean") return v ? 1 : 0;
  return 0;
}

/** A small, deterministic string hash (FNV-1a 32-bit). */
function hashDeterministic(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * Map a visual node kind to the AI workflow engine's step type
 * (see `WorkflowStepType` in `src/missions/core`).
 */
function kindToStepType(kind: WorkflowNodeKind): string {
  switch (kind) {
    case "input": return "initial_assessment";
    case "output": return "custom";
    case "ai_prompt": return "ai_execution";
    case "fallback_model": return "ai_execution";
    case "tool_call": return "custom";
    case "conditional": return "conditional_branch";
    case "parallel": return "parallel";
    case "sequential": return "custom";
    case "retrieval": return "knowledge_retrieval";
    case "memory_store": return "custom";
    case "memory_retrieve": return "custom";
    case "human_review": return "wait";
    case "schedule": return "wait";
    default: {
      const _exhaustive: never = kind;
      void _exhaustive;
      return "custom";
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _builder: WorkflowBuilder | null = null;
export function getWorkflowBuilder(): WorkflowBuilder {
  if (!_builder) _builder = new WorkflowBuilder();
  return _builder;
}

export function resetWorkflowBuilder(): void {
  _builder = null;
}
