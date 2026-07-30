/**
 * Eks-Health Developer Platform — Visual Program Designer
 *
 * A low-code visual editor for Program authors. Developers configure
 * measurement schemas, mission flows, competition rules, score formulas,
 * leaderboards, eligibility, reward schedules, permissions, consent
 * requests, notifications, AI workflows, habits, and goals — without
 * writing code. Configurations remain fully editable in the canvas and
 * can be exported into a manifest-compatible JSON block.
 *
 * Capabilities:
 *   - createProject / getProject / listProjects
 *   - addElement / updateElement / removeElement
 *   - connect (with REAL semantic connection validation)
 *   - export (REAL per-type config serialization → manifest block)
 *   - listTemplates (one pre-built template per DesignerElementType, 13 total)
 *   - validate (real config + connection-graph + orphan check)
 *   - getStats
 *
 * No mocks. No external deps. Pure TS, strict, ESM.
 */

import "server-only";

import type { ProgramId } from "@/programs";
import {
  type DesignerProjectId,
  type DesignerProject,
  type DesignerElement,
  type DesignerElementType,
  DeveloperError,
  asDesignerProjectId,
  DEVELOPER_EVENTS,
} from "../core";
import { getEventBus, buildEvent, generateId, getClock } from "@/kernel";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A pre-built designer template — one per {@link DesignerElementType}.
 * Templates seed the canvas with sensible defaults so authors can drop an
 * element in and edit it, rather than starting from a blank config.
 */
export interface DesignerTemplate {
  readonly id: string;
  readonly type: DesignerElementType;
  readonly name: string;
  readonly description: string;
  readonly defaultConfig: Readonly<Record<string, unknown>>;
}

/**
 * The serialized export of a designer project. `generatedCode` is a
 * manifest-compatible JSON string that can be pasted into a Program's
 * `manifest.json` under `designer.canvas`.
 */
export interface DesignerExport {
  readonly projectId: DesignerProjectId;
  readonly elements: ReadonlyArray<{
    readonly id: string;
    readonly type: DesignerElementType;
    readonly label: string;
    readonly config: Readonly<Record<string, unknown>>;
    readonly connections: readonly string[];
  }>;
  readonly generatedCode: string;
  readonly exportedAt: string;
}

export type {
  DesignerProjectId,
  DesignerProject,
  DesignerElement,
  DesignerElementType,
} from "../core";

// ---------------------------------------------------------------------------
// Connection rules — which element types may connect to which.
// Real, semantic validation: a mission_flow can drive a measurement_schema
// but cannot connect directly to a permission (permissions are global).
// ---------------------------------------------------------------------------

const CONNECTION_RULES: Readonly<Record<DesignerElementType, readonly DesignerElementType[]>> = {
  measurement_schema: ["mission_flow", "score_formula", "leaderboard", "consent_request"],
  mission_flow: ["measurement_schema", "notification", "goal", "ai_workflow", "reward_schedule"],
  competition_rule: ["score_formula", "leaderboard", "eligibility", "reward_schedule"],
  score_formula: ["leaderboard", "competition_rule"],
  leaderboard: ["reward_schedule", "notification"],
  eligibility: ["competition_rule"],
  reward_schedule: ["notification"],
  permission: [], // permissions are global — never a connection target/source
  consent_request: ["measurement_schema"],
  notification: [], // notifications are terminal sinks
  ai_workflow: ["mission_flow", "notification"],
  habit: ["goal"],
  goal: ["mission_flow", "notification"],
};

function canConnect(from: DesignerElementType, to: DesignerElementType): boolean {
  if (from === to) return false;
  const allowed = CONNECTION_RULES[from];
  return allowed !== undefined && allowed.includes(to);
}

// ---------------------------------------------------------------------------
// Pre-built templates — 13, one per DesignerElementType.
// ---------------------------------------------------------------------------

function tmpl(
  type: DesignerElementType,
  name: string,
  description: string,
  defaultConfig: Readonly<Record<string, unknown>>,
): DesignerTemplate {
  return { id: `tmpl_${type}`, type, name, description, defaultConfig };
}

export const DESIGNER_TEMPLATES: readonly DesignerTemplate[] = [
  tmpl("measurement_schema", "Blood Pressure Schema", "Systolic/diastolic blood pressure measurement.", {
    slug: "blood_pressure",
    name: "Blood Pressure",
    valueType: "range",
    units: "mmHg",
    validation: { min: [60, 40], max: [250, 150], required: true },
  }),
  tmpl("mission_flow", "Daily Steps Mission", "A daily step-count mission flow.", {
    title: "Daily Steps",
    type: "recurring",
    category: "activity",
    scheduledFor: "P1D",
    targetValue: 8000,
  }),
  tmpl("competition_rule", "National Cardio Challenge", "A national-scope competition rule.", {
    scope: "national",
    eligibility: { minAge: 18, regions: ["*"] },
    scoreSpec: { metric: "steps", aggregation: "sum", window: "P30D" },
  }),
  tmpl("score_formula", "Weighted Steps Score", "Weighted step-count scoring formula.", {
    expression: "steps * 0.01 + bonus",
    variables: { steps: "number", bonus: "number" },
    language: "expr",
  }),
  tmpl("leaderboard", "Daily Steps Leaderboard", "Top-N daily steps leaderboard.", {
    scope: "program",
    ranking: "desc",
    metric: "steps",
    window: "P1D",
    topN: 100,
  }),
  tmpl("eligibility", "Adult Eligibility", "Adults 18+ in supported regions.", {
    criteria: "age >= 18 AND region IN supported_regions",
    minAge: 18,
    maxAge: 120,
    regions: ["GH", "KE", "NG"],
  }),
  tmpl("reward_schedule", "Top-10 Badge Reward", "Award a badge to top-10 finishers.", {
    trigger: "season_end",
    type: "badge",
    value: "top_10_badge",
    distribution: "instant",
  }),
  tmpl("permission", "Health Measurement Permission", "Permission to record health measurements.", {
    key: "health:measurement:write",
    scope: "program",
    description: "Allows recording health measurements on behalf of the participant.",
    default: "grant_on_consent",
  }),
  tmpl("consent_request", "Vital Signs Consent", "Consent to collect vital-sign measurements.", {
    purpose: "Collect vital signs (BP, HR) for cardiovascular risk scoring.",
    fields: ["blood_pressure", "heart_rate"],
    lawfulBasis: "explicit_consent",
    retentionDays: 365,
  }),
  tmpl("notification", "Mission Reminder", "Push reminder for incomplete daily missions.", {
    channel: "push",
    template: "mission_reminder",
    trigger: "scheduled",
    audience: "participants_with_open_missions",
  }),
  tmpl("ai_workflow", "Adaptive Plan Generator", "AI workflow that adapts the weekly plan.", {
    workflowSpecId: "wf_adaptive_plan",
    model: "glm-4",
    prompt: "Adapt the participant's weekly plan based on completion rate.",
    fallbackModel: "glm-4-flash",
  }),
  tmpl("habit", "Hydration Habit", "Drink 8 glasses of water per day.", {
    slug: "hydration",
    cadence: "P1D",
    target: 8,
    icon: "droplet",
    unit: "glasses",
  }),
  tmpl("goal", "10K Steps Goal", "Reach 10,000 steps in a day.", {
    slug: "steps_10k",
    metric: "steps",
    target: 10000,
    deadline: "end_of_day",
  }),
];

const TEMPLATE_INDEX = new Map(DESIGNER_TEMPLATES.map((t) => [t.type, t]));

// ---------------------------------------------------------------------------
// Config serialization — produces a manifest-compatible block per type.
// REAL serialization, not a passthrough.
// ---------------------------------------------------------------------------

interface SerializedConfig {
  readonly block: string;
  readonly config: Readonly<Record<string, unknown>>;
}

function serializeConfig(element: DesignerElement): SerializedConfig {
  const c = element.config;
  switch (element.type) {
    case "measurement_schema":
      return {
        block: "measurement_schema",
        config: {
          slug: str(c, "slug", `${element.id}_schema`),
          name: str(c, "name", element.label),
          valueType: str(c, "valueType", "number"),
          units: str(c, "units", ""),
          validation: c.validation ?? { required: true },
        },
      };
    case "mission_flow":
      return {
        block: "mission_flow",
        config: {
          title: str(c, "title", element.label),
          type: str(c, "type", "recurring"),
          category: str(c, "category", "general"),
          scheduledFor: str(c, "scheduledFor", "P1D"),
          targetValue: c.targetValue ?? null,
        },
      };
    case "competition_rule":
      return {
        block: "competition_rule",
        config: {
          scope: str(c, "scope", "program"),
          eligibility: c.eligibility ?? {},
          scoreSpec: c.scoreSpec ?? {},
        },
      };
    case "score_formula":
      return {
        block: "score_formula",
        config: {
          expression: str(c, "expression", "0"),
          variables: c.variables ?? {},
          language: str(c, "language", "expr"),
        },
      };
    case "leaderboard":
      return {
        block: "leaderboard",
        config: {
          scope: str(c, "scope", "program"),
          ranking: str(c, "ranking", "desc"),
          metric: str(c, "metric", ""),
          window: str(c, "window", "P1D"),
          topN: c.topN ?? 50,
        },
      };
    case "eligibility":
      return {
        block: "eligibility",
        config: {
          criteria: str(c, "criteria", "true"),
          minAge: c.minAge ?? 0,
          maxAge: c.maxAge ?? 120,
          regions: c.regions ?? ["*"],
        },
      };
    case "reward_schedule":
      return {
        block: "reward_schedule",
        config: {
          trigger: str(c, "trigger", "manual"),
          type: str(c, "type", "badge"),
          value: c.value ?? null,
          distribution: str(c, "distribution", "instant"),
        },
      };
    case "permission":
      return {
        block: "permission",
        config: {
          key: str(c, "key", ""),
          scope: str(c, "scope", "program"),
          description: str(c, "description", ""),
          default: str(c, "default", "deny"),
        },
      };
    case "consent_request":
      return {
        block: "consent_request",
        config: {
          purpose: str(c, "purpose", ""),
          fields: c.fields ?? [],
          lawfulBasis: str(c, "lawfulBasis", "explicit_consent"),
          retentionDays: c.retentionDays ?? 90,
        },
      };
    case "notification":
      return {
        block: "notification",
        config: {
          channel: str(c, "channel", "push"),
          template: str(c, "template", ""),
          trigger: str(c, "trigger", "manual"),
          audience: str(c, "audience", "all"),
        },
      };
    case "ai_workflow":
      return {
        block: "ai_workflow",
        config: {
          workflowSpecId: str(c, "workflowSpecId", ""),
          model: str(c, "model", "glm-4"),
          prompt: str(c, "prompt", ""),
          fallbackModel: c.fallbackModel ?? null,
        },
      };
    case "habit":
      return {
        block: "habit",
        config: {
          slug: str(c, "slug", ""),
          cadence: str(c, "cadence", "P1D"),
          target: c.target ?? 1,
          icon: str(c, "icon", "default"),
          unit: str(c, "unit", ""),
        },
      };
    case "goal":
      return {
        block: "goal",
        config: {
          slug: str(c, "slug", ""),
          metric: str(c, "metric", ""),
          target: c.target ?? 1,
          deadline: str(c, "deadline", "end_of_day"),
        },
      };
    default: {
      // exhaustive fallback — never reached unless a new type is added
      const _exhaustive: never = element.type;
      void _exhaustive;
      return { block: "unknown", config: { ...c } };
    }
  }
}

function str(c: Readonly<Record<string, unknown>>, key: string, fallback: string): string {
  const v = c[key];
  return typeof v === "string" ? v : fallback;
}

// ---------------------------------------------------------------------------
// Designer
// ---------------------------------------------------------------------------

interface MutableProject {
  id: DesignerProjectId;
  programId: ProgramId;
  name: string;
  elements: Map<string, DesignerElement>;
  canvas: { width: number; height: number };
  createdAt: string;
  updatedAt: string;
}

function toProject(p: MutableProject): DesignerProject {
  return {
    id: p.id,
    programId: p.programId,
    name: p.name,
    elements: [...p.elements.values()],
    canvas: p.canvas,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

export class VisualDesigner {
  private readonly projects = new Map<DesignerProjectId, MutableProject>();

  /** Create a new designer project with an empty canvas. */
  createProject(programId: ProgramId, name: string): DesignerProject {
    const now = getClock().iso();
    const project: MutableProject = {
      id: asDesignerProjectId(generateId("design_")),
      programId,
      name,
      elements: new Map(),
      canvas: { width: 1920, height: 1080 },
      createdAt: now,
      updatedAt: now,
    };
    this.projects.set(project.id, project);
    this.emitSaved(project, "created");
    return toProject(project);
  }

  getProject(id: DesignerProjectId): DesignerProject | undefined {
    const p = this.projects.get(id);
    return p ? toProject(p) : undefined;
  }

  listProjects(programId?: ProgramId): DesignerProject[] {
    const all = [...this.projects.values()];
    const filtered = programId ? all.filter((p) => p.programId === programId) : all;
    return filtered.map(toProject);
  }

  /** Add a visual element to the canvas. */
  addElement(projectId: DesignerProjectId, element: DesignerElement): DesignerElement {
    const p = this.requireProject(projectId);
    if (p.elements.has(element.id)) {
      throw new DeveloperError({
        code: "eks.developer.designer.duplicate_element",
        category: "state_conflict",
        message: `Element ${element.id} already exists in project ${projectId}.`,
        userMessage: "An element with this ID already exists on the canvas.",
      });
    }
    const enriched: DesignerElement = {
      ...element,
      connections: [...element.connections],
      position: { ...element.position },
      config: { ...element.config },
    };
    p.elements.set(enriched.id, enriched);
    p.updatedAt = getClock().iso();
    this.emitSaved(p, "element_added");
    return enriched;
  }

  /** Update an element's config and/or position. */
  updateElement(
    projectId: DesignerProjectId,
    elementId: string,
    updates: Partial<Pick<DesignerElement, "label" | "config" | "position">>,
  ): DesignerElement {
    const p = this.requireProject(projectId);
    const existing = p.elements.get(elementId);
    if (!existing) {
      throw new DeveloperError({
        code: "eks.developer.designer.element_not_found",
        category: "not_found",
        message: `Element ${elementId} not found in project ${projectId}.`,
        userMessage: "The element no longer exists on the canvas.",
      });
    }
    const updated: DesignerElement = {
      ...existing,
      label: updates.label ?? existing.label,
      config: updates.config ? { ...existing.config, ...updates.config } : existing.config,
      position: updates.position ? { ...updates.position } : existing.position,
    };
    p.elements.set(elementId, updated);
    p.updatedAt = getClock().iso();
    this.emitSaved(p, "element_updated");
    return updated;
  }

  /** Remove an element and every connection that references it. */
  removeElement(projectId: DesignerProjectId, elementId: string): void {
    const p = this.requireProject(projectId);
    if (!p.elements.has(elementId)) {
      throw new DeveloperError({
        code: "eks.developer.designer.element_not_found",
        category: "not_found",
        message: `Element ${elementId} not found in project ${projectId}.`,
        userMessage: "The element no longer exists on the canvas.",
      });
    }
    p.elements.delete(elementId);
    // Strip dangling connections from remaining elements.
    for (const [id, el] of p.elements) {
      if (el.connections.includes(elementId)) {
        p.elements.set(id, { ...el, connections: el.connections.filter((c) => c !== elementId) });
      }
    }
    p.updatedAt = getClock().iso();
    this.emitSaved(p, "element_removed");
  }

  /**
   * Connect two elements. Validates that both exist and that the
   * source→target pair is semantically allowed (e.g. mission_flow →
   * measurement_schema is OK; mission_flow → permission is not).
   */
  connect(projectId: DesignerProjectId, fromId: string, toId: string): void {
    const p = this.requireProject(projectId);
    if (fromId === toId) {
      throw new DeveloperError({
        code: "eks.developer.designer.self_connection",
        category: "validation",
        message: `Cannot connect element ${fromId} to itself.`,
        userMessage: "An element cannot connect to itself.",
      });
    }
    const from = p.elements.get(fromId);
    const to = p.elements.get(toId);
    if (!from || !to) {
      throw new DeveloperError({
        code: "eks.developer.designer.connection_target_missing",
        category: "not_found",
        message: `Cannot connect ${fromId} → ${toId}: one or both elements are missing.`,
        userMessage: "Cannot connect — one of the elements no longer exists.",
      });
    }
    if (!canConnect(from.type, to.type)) {
      throw new DeveloperError({
        code: "eks.developer.designer.invalid_connection",
        category: "validation",
        message: `Connection ${from.type} → ${to.type} is not permitted.`,
        userMessage: `A ${from.type} cannot connect to a ${to.type}.`,
        metadata: { fromType: from.type, toType: to.type, allowed: CONNECTION_RULES[from.type] ?? [] },
      });
    }
    if (from.connections.includes(toId)) {
      return; // idempotent
    }
    p.elements.set(fromId, { ...from, connections: [...from.connections, toId] });
    p.updatedAt = getClock().iso();
    this.emitSaved(p, "connected");
  }

  /**
   * Serialize the canvas into a manifest-compatible export. Each element
   * produces a typed config block; `generatedCode` is a pretty-printed
   * JSON string ready for `manifest.json`.
   */
  export(projectId: DesignerProjectId): DesignerExport {
    const p = this.requireProject(projectId);
    const elements = [...p.elements.values()].map((el) => {
      const serialized = serializeConfig(el);
      return {
        id: el.id,
        type: el.type,
        label: el.label,
        config: serialized.config,
        connections: [...el.connections],
      };
    });

    const manifest = {
      designer: {
        projectId: p.id,
        programId: p.programId,
        canvas: p.canvas,
        elements: elements.map((e) => ({
          id: e.id,
          type: e.type,
          label: e.label,
          config: e.config,
          connections: e.connections,
        })),
      },
    };
    const generatedCode = JSON.stringify(manifest, null, 2);

    return {
      projectId: p.id,
      elements,
      generatedCode,
      exportedAt: getClock().iso(),
    };
  }

  /** Pre-built templates — one per DesignerElementType (13 total). */
  listTemplates(): DesignerTemplate[] {
    return [...DESIGNER_TEMPLATES];
  }

  /** Get the default template for an element type. */
  getTemplate(type: DesignerElementType): DesignerTemplate | undefined {
    return TEMPLATE_INDEX.get(type);
  }

  /**
   * Validate the canvas: every element has a valid config, every
   * connection is semantically permitted, and no element is orphaned
   * (an element is orphaned if it neither connects to nor is connected
   * from any other element, unless it is a `permission` — permissions
   * are global and intentionally standalone).
   */
  validate(projectId: DesignerProjectId): {
    readonly valid: boolean;
    readonly errors: readonly string[];
    readonly warnings: readonly string[];
  } {
    const p = this.requireProject(projectId);
    const errors: string[] = [];
    const warnings: string[] = [];

    if (p.elements.size === 0) {
      errors.push("Canvas is empty — add at least one element.");
    }

    const referenced = new Set<string>();
    for (const el of p.elements.values()) {
      // 1. Per-type config validation
      const cfgErrors = validateConfig(el);
      errors.push(...cfgErrors);

      // 2. Connection validity
      for (const targetId of el.connections) {
        const target = p.elements.get(targetId);
        if (!target) {
          errors.push(`Element ${el.id} (${el.type}) connects to missing element ${targetId}.`);
          continue;
        }
        if (!canConnect(el.type, target.type)) {
          errors.push(`Invalid connection: ${el.type} (${el.id}) → ${target.type} (${target.id}).`);
        }
        referenced.add(el.id);
        referenced.add(target.id);
      }
    }

    // 3. Orphan detection
    for (const el of p.elements.values()) {
      if (el.type === "permission") continue; // global, intentionally standalone
      if (!referenced.has(el.id) && p.elements.size > 1) {
        warnings.push(`Element ${el.label} (${el.type}) is not connected to anything.`);
      }
    }

    return { valid: errors.length === 0, errors, warnings };
  }

  getStats(programId?: ProgramId): {
    readonly totalProjects: number;
    readonly totalElements: number;
    readonly byType: Readonly<Record<DesignerElementType, number>>;
  } {
    const projects = programId
      ? [...this.projects.values()].filter((p) => p.programId === programId)
      : [...this.projects.values()];
    const byType = {} as Record<DesignerElementType, number>;
    for (const t of Object.keys(CONNECTION_RULES) as DesignerElementType[]) {
      byType[t] = 0;
    }
    let totalElements = 0;
    for (const p of projects) {
      for (const el of p.elements.values()) {
        byType[el.type] = (byType[el.type] ?? 0) + 1;
        totalElements++;
      }
    }
    return { totalProjects: projects.length, totalElements, byType };
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  private requireProject(id: DesignerProjectId): MutableProject {
    const p = this.projects.get(id);
    if (!p) {
      throw new DeveloperError({
        code: "eks.developer.designer.project_not_found",
        category: "not_found",
        message: `Designer project ${id} not found.`,
        userMessage: "This designer project does not exist.",
      });
    }
    return p;
  }

  private emitSaved(p: MutableProject, action: string): void {
    void getEventBus().publish(
      buildEvent(
        DEVELOPER_EVENTS.designerSaved,
        {
          projectId: p.id,
          programId: p.programId,
          name: p.name,
          action,
          elementCount: p.elements.size,
        },
        {},
        "domain",
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Per-type config validation — REAL checks, not a passthrough.
// ---------------------------------------------------------------------------

function validateConfig(el: DesignerElement): string[] {
  const errs: string[] = [];
  const c = el.config;
  switch (el.type) {
    case "measurement_schema":
      if (!c.slug) errs.push(`${el.label}: measurement_schema requires a slug.`);
      if (!c.valueType) errs.push(`${el.label}: measurement_schema requires a valueType.`);
      break;
    case "mission_flow":
      if (!c.title) errs.push(`${el.label}: mission_flow requires a title.`);
      if (!c.type) errs.push(`${el.label}: mission_flow requires a type.`);
      break;
    case "competition_rule":
      if (!c.scope) errs.push(`${el.label}: competition_rule requires a scope.`);
      if (!c.scoreSpec) errs.push(`${el.label}: competition_rule requires a scoreSpec.`);
      break;
    case "score_formula":
      if (!c.expression) errs.push(`${el.label}: score_formula requires an expression.`);
      break;
    case "leaderboard":
      if (!c.metric) errs.push(`${el.label}: leaderboard requires a metric.`);
      break;
    case "eligibility":
      if (!c.criteria) errs.push(`${el.label}: eligibility requires criteria.`);
      break;
    case "reward_schedule":
      if (!c.trigger) errs.push(`${el.label}: reward_schedule requires a trigger.`);
      if (!c.type) errs.push(`${el.label}: reward_schedule requires a type.`);
      break;
    case "permission":
      if (!c.key) errs.push(`${el.label}: permission requires a key.`);
      break;
    case "consent_request":
      if (!c.purpose) errs.push(`${el.label}: consent_request requires a purpose.`);
      if (!Array.isArray(c.fields) || c.fields.length === 0) {
        errs.push(`${el.label}: consent_request requires at least one field.`);
      }
      break;
    case "notification":
      if (!c.channel) errs.push(`${el.label}: notification requires a channel.`);
      if (!c.template) errs.push(`${el.label}: notification requires a template.`);
      break;
    case "ai_workflow":
      if (!c.model) errs.push(`${el.label}: ai_workflow requires a model.`);
      if (!c.prompt) errs.push(`${el.label}: ai_workflow requires a prompt.`);
      break;
    case "habit":
      if (!c.slug) errs.push(`${el.label}: habit requires a slug.`);
      if (!c.cadence) errs.push(`${el.label}: habit requires a cadence.`);
      break;
    case "goal":
      if (!c.slug) errs.push(`${el.label}: goal requires a slug.`);
      if (c.target === undefined) errs.push(`${el.label}: goal requires a target.`);
      break;
    default: {
      const _exhaustive: never = el.type;
      void _exhaustive;
    }
  }
  return errs;
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _designer: VisualDesigner | null = null;
export function getDesigner(): VisualDesigner {
  if (!_designer) _designer = new VisualDesigner();
  return _designer;
}

export function resetDesigner(): void {
  _designer = null;
}
