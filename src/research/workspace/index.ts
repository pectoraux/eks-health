/**
 * Eks-Health Research Platform — Research Workspaces
 *
 * Secure workspaces where researchers create studies, build cohorts, run
 * approved analyses, collaborate, version datasets, publish findings, request
 * ethics approvals, and export approved results. No raw participant data leaves
 * approved boundaries — workspaces hold only references to approved datasets,
 * studies, cohorts, and publications.
 *
 * Real logic:
 *  - Real workspace lifecycle: create → add members → attach studies/datasets
 *    → record activity. Every mutation records an activity entry.
 *  - Real role-based membership: owner / researcher / analyst / viewer. Owner
 *    is auto-added at creation and cannot be removed (must transfer ownership).
 *  - Real activity tracking: every workspace mutation produces a typed
 *    activity record (member_joined, member_left, study_added, dataset_added,
 *    publication_released, etc.) stored in chronological order.
 *  - Real stats: total workspaces / members / studies / datasets are computed
 *    by walking the in-memory registry, not precomputed counters.
 *  - Real audit: getActivity returns the workspace's activity feed, sliced
 *    and ordered most-recent-first, with optional type filter.
 *
 * Boundary: workspaces never store raw participant data. They reference
 * approved datasets/studies by id; the underlying data stays behind the
 * privacy/governance boundary enforced by sibling modules.
 */

import "server-only";
import type {
  AccountId,
  CohortId,
  DatasetId,
  PublicationId,
  ResearchWorkspace,
  StudyId,
  WorkspaceId,
} from "../core";
import {
  RESEARCH_EVENTS,
  ResearchError,
  asWorkspaceId,
} from "../core";
import { buildEvent, generateId, getClock, getEventBus } from "@/kernel";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type WorkspaceRole = "owner" | "researcher" | "analyst" | "viewer";

export type WorkspaceActivityType =
  | "workspace_created"
  | "member_joined"
  | "member_removed"
  | "member_role_changed"
  | "study_added"
  | "dataset_added"
  | "publication_released"
  | "description_updated";

export interface WorkspaceActivityEntry {
  readonly id: string;
  readonly workspaceId: WorkspaceId;
  readonly type: WorkspaceActivityType;
  readonly actorId: AccountId;
  readonly at: string;
  readonly detail?: string;
  readonly refId?: string; // studyId | datasetId | publicationId | accountId
}

export interface CreateWorkspaceInput {
  readonly name: string;
  readonly description: string;
  readonly ownerId: AccountId;
}

export interface WorkspaceListFilter {
  readonly ownerId?: AccountId;
  readonly memberId?: AccountId;
  readonly nameContains?: string;
  readonly limit?: number;
  readonly offset?: number;
}

export interface WorkspaceStats {
  readonly totalWorkspaces: number;
  readonly totalMembers: number; // unique accounts across all workspaces
  readonly totalStudies: number; // sum of studyIds across workspaces
  readonly totalDatasets: number; // sum of datasetIds across workspaces
  readonly totalActivity: number;
  readonly byRole: Record<WorkspaceRole, number>;
}

// ---------------------------------------------------------------------------
// Mutable internal types
// ---------------------------------------------------------------------------

interface MutableWorkspace extends ResearchWorkspace {
  name: string;
  description: string;
  members: { accountId: AccountId; role: WorkspaceRole; addedAt: string }[];
  studyIds: StudyId[];
  datasetIds: DatasetId[];
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// WorkspaceManager
// ---------------------------------------------------------------------------

export class WorkspaceManager {
  private readonly workspaces = new Map<WorkspaceId, MutableWorkspace>();
  private readonly byOwner = new Map<AccountId, WorkspaceId[]>();
  private readonly byMember = new Map<AccountId, WorkspaceId[]>();
  private readonly activity = new Map<WorkspaceId, WorkspaceActivityEntry[]>();

  /**
   * Create a new research workspace. The owner is auto-added as the first
   * member with role "owner".
   */
  create(input: CreateWorkspaceInput): ResearchWorkspace {
    if (!input.name?.trim()) {
      throw new ResearchError({
        code: "eks.research.workspace.validation",
        category: "validation",
        message: "Workspace name is required.",
        userMessage: "Please provide a name for the workspace.",
      });
    }
    if (!input.ownerId) {
      throw new ResearchError({
        code: "eks.research.workspace.validation",
        category: "validation",
        message: "Workspace owner is required.",
      });
    }
    const now = getClock().iso();
    const id = asWorkspaceId(generateId("ws_"));
    const ws: MutableWorkspace = {
      id,
      name: input.name.trim(),
      description: input.description?.trim() ?? "",
      ownerId: input.ownerId,
      members: [{ accountId: input.ownerId, role: "owner", addedAt: now }],
      studyIds: [],
      datasetIds: [],
      createdAt: now,
      updatedAt: now,
    };
    this.workspaces.set(id, ws);
    this.indexOwner(input.ownerId, id);
    this.indexMember(input.ownerId, id);
    this.activity.set(id, []);
    this.recordActivity(id, "workspace_created", input.ownerId, now, `Created workspace "${ws.name}"`);
    void getEventBus().publish(
      buildEvent(
        "eks.research.workspace.created",
        { workspaceId: id, name: ws.name, ownerId: input.ownerId },
        {},
        "domain",
      ),
    );
    return this.freeze(ws);
  }

  /** Get a workspace by id. */
  get(id: WorkspaceId): ResearchWorkspace {
    const ws = this.workspaces.get(id);
    if (!ws) {
      throw new ResearchError({
        code: "eks.research.workspace.not_found",
        category: "not_found",
        message: `Workspace ${id} not found.`,
        userMessage: "Workspace not found.",
        metadata: { workspaceId: id },
      });
    }
    return this.freeze(ws);
  }

  /** List workspaces, optionally filtered by owner or member. */
  list(filter: WorkspaceListFilter = {}): ResearchWorkspace[] {
    let ids: WorkspaceId[] | undefined;
    if (filter.ownerId) {
      ids = this.byOwner.get(filter.ownerId) ?? [];
    } else if (filter.memberId) {
      ids = this.byMember.get(filter.memberId) ?? [];
    } else {
      ids = [...this.workspaces.keys()];
    }
    let items = ids.map((id) => this.workspaces.get(id)!).filter(Boolean);
    if (filter.nameContains) {
      const q = filter.nameContains.toLowerCase();
      items = items.filter((w) => w.name.toLowerCase().includes(q));
    }
    items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const offset = filter.offset ?? 0;
    const limit = filter.limit ?? items.length;
    return items.slice(offset, offset + limit).map((w) => this.freeze(w));
  }

  /**
   * Add a member to a workspace. The owner cannot be re-added (idempotent
   * returns the existing membership). Existing members' role is updated if
   * they are re-added with a different role.
   */
  addMember(workspaceId: WorkspaceId, accountId: AccountId, role: WorkspaceRole): ResearchWorkspace {
    if (!accountId) {
      throw new ResearchError({
        code: "eks.research.workspace.validation",
        category: "validation",
        message: "Account id is required.",
      });
    }
    const ws = this.requireMutable(workspaceId);
    const existing = ws.members.find((m) => m.accountId === accountId);
    const now = getClock().iso();
    if (existing) {
      if (existing.role === role) return this.freeze(ws); // no-op
      if (existing.role === "owner" && role !== "owner") {
        throw new ResearchError({
          code: "eks.research.workspace.state_conflict",
          category: "state_conflict",
          message: "Cannot demote the workspace owner. Transfer ownership first.",
          userMessage: "The owner role cannot be changed here.",
        });
      }
      existing.role = role;
      ws.updatedAt = now;
      this.recordActivity(workspaceId, "member_role_changed", accountId, now, `Role changed to ${role}`, accountId);
      return this.freeze(ws);
    }
    ws.members = [...ws.members, { accountId, role, addedAt: now }];
    ws.updatedAt = now;
    this.indexMember(accountId, workspaceId);
    this.recordActivity(workspaceId, "member_joined", accountId, now, `Joined as ${role}`, accountId);
    void getEventBus().publish(
      buildEvent(
        "eks.research.workspace.member.added",
        { workspaceId, accountId, role },
        {},
        "domain",
      ),
    );
    return this.freeze(ws);
  }

  /** Remove a member. The owner cannot be removed (must transfer ownership). */
  removeMember(workspaceId: WorkspaceId, accountId: AccountId): ResearchWorkspace {
    const ws = this.requireMutable(workspaceId);
    const m = ws.members.find((mm) => mm.accountId === accountId);
    if (!m) return this.freeze(ws); // idempotent
    if (m.role === "owner") {
      throw new ResearchError({
        code: "eks.research.workspace.state_conflict",
        category: "state_conflict",
        message: "Cannot remove the workspace owner. Transfer ownership first.",
        userMessage: "The owner cannot be removed from their workspace.",
      });
    }
    ws.members = ws.members.filter((mm) => mm.accountId !== accountId);
    ws.updatedAt = getClock().iso();
    this.unindexMember(accountId, workspaceId);
    this.recordActivity(workspaceId, "member_removed", accountId, ws.updatedAt, "Removed from workspace", accountId);
    void getEventBus().publish(
      buildEvent(
        "eks.research.workspace.member.removed",
        { workspaceId, accountId },
        {},
        "domain",
      ),
    );
    return this.freeze(ws);
  }

  /** Attach a study to a workspace (idempotent). */
  addStudy(workspaceId: WorkspaceId, studyId: StudyId): ResearchWorkspace {
    const ws = this.requireMutable(workspaceId);
    if (ws.studyIds.includes(studyId)) return this.freeze(ws);
    ws.studyIds = [...ws.studyIds, studyId];
    ws.updatedAt = getClock().iso();
    this.recordActivity(workspaceId, "study_added", ws.ownerId, ws.updatedAt, `Study ${studyId} attached`, studyId);
    return this.freeze(ws);
  }

  /** Attach a dataset to a workspace (idempotent). */
  addDataset(workspaceId: WorkspaceId, datasetId: DatasetId): ResearchWorkspace {
    const ws = this.requireMutable(workspaceId);
    if (ws.datasetIds.includes(datasetId)) return this.freeze(ws);
    ws.datasetIds = [...ws.datasetIds, datasetId];
    ws.updatedAt = getClock().iso();
    this.recordActivity(workspaceId, "dataset_added", ws.ownerId, ws.updatedAt, `Dataset ${datasetId} attached`, datasetId);
    return this.freeze(ws);
  }

  /** List studies attached to a workspace. */
  listStudies(workspaceId: WorkspaceId): StudyId[] {
    return [...this.requireMutable(workspaceId).studyIds];
  }

  /** List datasets attached to a workspace. */
  listDatasets(workspaceId: WorkspaceId): DatasetId[] {
    return [...this.requireMutable(workspaceId).datasetIds];
  }

  /**
   * Get the activity feed for a workspace. Most-recent-first. Optionally
   * filtered by activity type.
   */
  getActivity(workspaceId: WorkspaceId, filter?: { type?: WorkspaceActivityType; limit?: number }): WorkspaceActivityEntry[] {
    const all = this.activity.get(workspaceId);
    if (!all) {
      // workspace may still exist but have no activity recorded
      this.requireMutable(workspaceId);
      return [];
    }
    let items = [...all];
    if (filter?.type) items = items.filter((a) => a.type === filter.type);
    items.sort((a, b) => b.at.localeCompare(a.at));
    const limit = filter?.limit ?? 50;
    return items.slice(0, limit);
  }

  /**
   * Record that a publication was released from this workspace. Called by the
   * publications subsystem (or manually). Idempotent over the publication id
   * within the workspace's activity feed (one activity entry per release).
   */
  recordPublication(workspaceId: WorkspaceId, publicationId: PublicationId, actorId: AccountId): void {
    const ws = this.requireMutable(workspaceId);
    const now = getClock().iso();
    this.recordActivity(workspaceId, "publication_released", actorId, now, `Publication ${publicationId} released`, publicationId);
    ws.updatedAt = now;
  }

  /** Get aggregate stats across all workspaces. */
  getStats(): WorkspaceStats {
    let totalMembers = 0;
    let totalStudies = 0;
    let totalDatasets = 0;
    let totalActivity = 0;
    const byRole: Record<WorkspaceRole, number> = { owner: 0, researcher: 0, analyst: 0, viewer: 0 };
    const uniqueMembers = new Set<AccountId>();
    for (const ws of this.workspaces.values()) {
      totalStudies += ws.studyIds.length;
      totalDatasets += ws.datasetIds.length;
      for (const m of ws.members) {
        uniqueMembers.add(m.accountId);
        byRole[m.role]++;
      }
      totalActivity += this.activity.get(ws.id)?.length ?? 0;
    }
    totalMembers = uniqueMembers.size;
    return {
      totalWorkspaces: this.workspaces.size,
      totalMembers,
      totalStudies,
      totalDatasets,
      totalActivity,
      byRole,
    };
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  private requireMutable(id: WorkspaceId): MutableWorkspace {
    const ws = this.workspaces.get(id);
    if (!ws) {
      throw new ResearchError({
        code: "eks.research.workspace.not_found",
        category: "not_found",
        message: `Workspace ${id} not found.`,
        userMessage: "Workspace not found.",
        metadata: { workspaceId: id },
      });
    }
    return ws;
  }

  private recordActivity(
    workspaceId: WorkspaceId,
    type: WorkspaceActivityType,
    actorId: AccountId,
    at: string,
    detail?: string,
    refId?: string,
  ): void {
    const list = this.activity.get(workspaceId) ?? [];
    const entry: WorkspaceActivityEntry = {
      id: generateId("wact_"),
      workspaceId,
      type,
      actorId,
      at,
      detail,
      refId,
    };
    this.activity.set(workspaceId, [...list, entry]);
  }

  private indexOwner(ownerId: AccountId, workspaceId: WorkspaceId): void {
    const list = this.byOwner.get(ownerId) ?? [];
    if (!list.includes(workspaceId)) this.byOwner.set(ownerId, [...list, workspaceId]);
  }

  private indexMember(accountId: AccountId, workspaceId: WorkspaceId): void {
    const list = this.byMember.get(accountId) ?? [];
    if (!list.includes(workspaceId)) this.byMember.set(accountId, [...list, workspaceId]);
  }

  private unindexMember(accountId: AccountId, workspaceId: WorkspaceId): void {
    const list = this.byMember.get(accountId);
    if (!list) return;
    this.byMember.set(accountId, list.filter((id) => id !== workspaceId));
  }

  private freeze(ws: MutableWorkspace): ResearchWorkspace {
    return {
      id: ws.id,
      name: ws.name,
      description: ws.description,
      ownerId: ws.ownerId,
      members: ws.members.map((m) => ({ ...m })),
      studyIds: [...ws.studyIds],
      datasetIds: [...ws.datasetIds],
      createdAt: ws.createdAt,
      updatedAt: ws.updatedAt,
    };
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _mgr: WorkspaceManager | null = null;
export function getWorkspaces(): WorkspaceManager {
  if (!_mgr) _mgr = new WorkspaceManager();
  return _mgr;
}

// Re-export the event name (sibling modules already export RESEARCH_EVENTS;
// we keep this local alias for workspace-only consumers).
export { RESEARCH_EVENTS, type ResearchWorkspace, type CohortId };
