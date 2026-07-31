/**
 * Eks-Health Population Platform — Organization Hierarchy
 *
 * Hierarchical organizations: Government → Ministry → Region → District →
 * Municipality → Community. Company → Business Unit → Department → Team →
 * Individual. Unlimited depth. Cycle-safe parent assignment.
 */

import "server-only";
import {
  type PopulationOrgId,
  type OrganizationType,
  type OrganizationTier,
  type PopulationOrganization,
  PopulationError,
  asPopulationOrgId,
} from "../core";
import { getEventBus, buildEvent, generateId, getClock } from "@/kernel";
import { POPULATION_EVENTS } from "../core";

const MAX_DEPTH = 20;

export class OrganizationHierarchy {
  private readonly orgs = new Map<PopulationOrgId, PopulationOrganization>();
  private readonly childrenIndex = new Map<PopulationOrgId, PopulationOrgId[]>();
  private readonly bySlug = new Map<string, PopulationOrgId>();

  create(input: {
    name: string;
    slug: string;
    type: OrganizationType;
    tier?: OrganizationTier;
    description?: string;
    parentId?: PopulationOrgId;
    country: string;
    region?: string;
    website?: string;
    contactEmail?: string;
    logoUrl?: string;
    metadata?: Record<string, unknown>;
  }): PopulationOrganization {
    if (this.bySlug.has(input.slug)) {
      throw new PopulationError({ code: "eks.population.org.duplicate_slug", category: "state_conflict", message: `Org slug '${input.slug}' exists.`, userMessage: "Organization slug already exists." });
    }
    if (input.parentId) {
      this.validateParent(input.parentId, null);
    }
    const now = getClock().iso();
    const org: PopulationOrganization = {
      id: asPopulationOrgId(generateId("poporg_")),
      name: input.name,
      slug: input.slug,
      type: input.type,
      tier: input.tier ?? "free",
      description: input.description,
      parentId: input.parentId,
      childrenIds: [],
      logoUrl: input.logoUrl,
      country: input.country,
      region: input.region,
      website: input.website,
      contactEmail: input.contactEmail,
      memberCount: 0,
      activeMemberCount: 0,
      status: "active",
      createdAt: now,
      updatedAt: now,
      metadata: input.metadata,
    };
    this.orgs.set(org.id, org);
    this.bySlug.set(input.slug, org.id);
    if (input.parentId) {
      const parent = this.orgs.get(input.parentId);
      if (parent) {
        this.orgs.set(input.parentId, { ...parent, childrenIds: [...parent.childrenIds, org.id], updatedAt: now });
      }
    }
    void getEventBus().publish(buildEvent(POPULATION_EVENTS.orgCreated, { orgId: org.id, slug: org.slug, type: org.type }, {}, "domain"));
    return org;
  }

  get(id: PopulationOrgId): PopulationOrganization | undefined {
    return this.orgs.get(id);
  }

  getBySlug(slug: string): PopulationOrganization | undefined {
    const id = this.bySlug.get(slug);
    return id ? this.orgs.get(id) : undefined;
  }

  list(filter?: { type?: OrganizationType; status?: string; parentId?: PopulationOrgId; country?: string }): PopulationOrganization[] {
    let l = [...this.orgs.values()];
    if (filter?.type) l = l.filter((o) => o.type === filter.type);
    if (filter?.status) l = l.filter((o) => o.status === filter.status);
    if (filter?.parentId) l = l.filter((o) => o.parentId === filter.parentId);
    if (filter?.country) l = l.filter((o) => o.country === filter.country);
    return l;
  }

  /** Get the full hierarchy tree from a root org. */
  getTree(rootId: PopulationOrgId, maxDepth = MAX_DEPTH): OrgTreeNode {
    const org = this.orgs.get(rootId);
    if (!org) throw new PopulationError({ code: "eks.population.org.not_found", category: "not_found", message: "Org not found." });
    return this.buildNode(org, 0, maxDepth);
  }

  /** Get all ancestors of an org (parent chain). */
  getAncestors(id: PopulationOrgId): PopulationOrganization[] {
    const ancestors: PopulationOrganization[] = [];
    let current = this.orgs.get(id);
    while (current?.parentId) {
      const parent = this.orgs.get(current.parentId);
      if (!parent) break;
      ancestors.push(parent);
      current = parent;
    }
    return ancestors;
  }

  /** Get all descendants of an org. */
  getDescendants(id: PopulationOrgId): PopulationOrganization[] {
    const result: PopulationOrganization[] = [];
    const collect = (orgId: PopulationOrgId) => {
      const children = (this.childrenIndex.get(orgId) ?? this.orgs.get(orgId)?.childrenIds ?? []);
      for (const childId of children) {
        const child = this.orgs.get(childId);
        if (child) {
          result.push(child);
          collect(childId);
        }
      }
    };
    collect(id);
    return result;
  }

  update(id: PopulationOrgId, updates: Partial<PopulationOrganization>): PopulationOrganization {
    const existing = this.orgs.get(id);
    if (!existing) throw new PopulationError({ code: "eks.population.org.not_found", category: "not_found", message: "Not found." });
    const updated = { ...existing, ...updates, id: existing.id, updatedAt: getClock().iso() };
    this.orgs.set(id, updated);
    return updated;
  }

  suspend(id: PopulationOrgId, _reason: string): PopulationOrganization {
    const updated = this.update(id, { status: "suspended" });
    void getEventBus().publish(buildEvent(POPULATION_EVENTS.orgSuspended, { orgId: id }, {}, "domain"));
    return updated;
  }

  incrementMemberCount(id: PopulationOrgId, active: boolean): void {
    const org = this.orgs.get(id);
    if (!org) return;
    this.orgs.set(id, { ...org, memberCount: org.memberCount + 1, activeMemberCount: active ? org.activeMemberCount + 1 : org.activeMemberCount, updatedAt: getClock().iso() });
  }

  decrementMemberCount(id: PopulationOrgId): void {
    const org = this.orgs.get(id);
    if (!org) return;
    this.orgs.set(id, { ...org, activeMemberCount: Math.max(0, org.activeMemberCount - 1), updatedAt: getClock().iso() });
  }

  getStats(): { total: number; byType: Record<string, number>; byTier: Record<string, number>; active: number; totalMembers: number } {
    const list = [...this.orgs.values()];
    const byType: Record<string, number> = {};
    const byTier: Record<string, number> = {};
    for (const o of list) {
      byType[o.type] = (byType[o.type] ?? 0) + 1;
      byTier[o.tier] = (byTier[o.tier] ?? 0) + 1;
    }
    return {
      total: list.length,
      byType, byTier,
      active: list.filter((o) => o.status === "active").length,
      totalMembers: list.reduce((a, o) => a + o.memberCount, 0),
    };
  }

  private buildNode(org: PopulationOrganization, depth: number, maxDepth: number): OrgTreeNode {
    const children = depth < maxDepth ? org.childrenIds.map((id) => {
      const child = this.orgs.get(id);
      return child ? this.buildNode(child, depth + 1, maxDepth) : null;
    }).filter(Boolean) as OrgTreeNode[] : [];
    return { org, children, depth };
  }

  private validateParent(parentId: PopulationOrgId, childId: PopulationOrgId | null): void {
    // Cycle detection: walk up the parent chain
    const visited = new Set<PopulationOrgId>();
    let current: PopulationOrgId | undefined = parentId;
    let depth = 0;
    while (current) {
      if (childId && current === childId) {
        throw new PopulationError({ code: "eks.population.org.cycle", category: "validation", message: "Cycle detected in org hierarchy.", userMessage: "Cannot set parent: would create a cycle." });
      }
      if (visited.has(current)) {
        throw new PopulationError({ code: "eks.population.org.cycle", category: "validation", message: "Cycle detected in existing hierarchy." });
      }
      visited.add(current);
      depth++;
      if (depth > MAX_DEPTH) {
        throw new PopulationError({ code: "eks.population.org.max_depth", category: "validation", message: `Max hierarchy depth (${MAX_DEPTH}) exceeded.` });
      }
      current = this.orgs.get(current)?.parentId;
    }
  }
}

export interface OrgTreeNode {
  readonly org: PopulationOrganization;
  readonly children: OrgTreeNode[];
  readonly depth: number;
}

let _mgr: OrganizationHierarchy | null = null;
export function getHierarchy(): OrganizationHierarchy {
  if (!_mgr) _mgr = new OrganizationHierarchy();
  return _mgr;
}
