/**
 * Eks-Health Population Platform — Organization Marketplace Catalogs
 *
 * Organizations curate approved Program catalogs. A catalog declares which
 * Programs are approved, required, or sponsored for that organization's
 * members. Participants remain free to install personal Programs unless the
 * organization has an enforceable policy that restricts installation —
 * enforced elsewhere via org policies, never here. This module is the
 * catalog of approval decisions itself.
 *
 * Catalog types (implicit, set by the catalog name + org type):
 *   - approved by employer
 *   - approved by Ministry of Health (government orgs)
 *   - approved by insurer (insurance_provider orgs)
 *   - approved by university (university orgs)
 *   - approved by NGO (ngo orgs)
 *
 * Built on all prior milestones. Pure TS, strict, ESM. No external deps.
 */

import "server-only";
import {
  type OrgCatalogId,
  type PopulationOrgId,
  type ProgramId,
  type OrgProgramCatalog,
  PopulationError,
  asOrgCatalogId,
  POPULATION_EVENTS,
} from "../core";
import { getEventBus, buildEvent, generateId, getClock } from "@/kernel";
import { getHierarchy } from "../hierarchy";

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

export class OrgCatalogManager {
  private readonly catalogs = new Map<OrgCatalogId, OrgProgramCatalog>();
  private readonly byOrg = new Map<PopulationOrgId, OrgCatalogId[]>();

  /** Create a new catalog for an org. */
  create(input: {
    orgId: PopulationOrgId;
    name: string;
    description: string;
  }): OrgProgramCatalog {
    const org = getHierarchy().get(input.orgId);
    if (!org) {
      throw new PopulationError({
        code: "eks.population.catalog.org_not_found",
        category: "not_found",
        message: `Organization ${input.orgId} not found.`,
        userMessage: "Organization not found.",
      });
    }
    if (!input.name.trim()) {
      throw new PopulationError({
        code: "eks.population.catalog.empty_name",
        category: "validation",
        message: "Catalog name is required.",
        userMessage: "A catalog name is required.",
      });
    }
    const now = getClock().iso();
    const catalog: OrgProgramCatalog = {
      id: asOrgCatalogId(generateId("cat_")),
      orgId: input.orgId,
      name: input.name.trim(),
      description: input.description,
      approvedProgramIds: [],
      requiredProgramIds: [],
      sponsoredProgramIds: [],
      createdAt: now,
      updatedAt: now,
    };
    this.catalogs.set(catalog.id, catalog);
    const list = this.byOrg.get(input.orgId) ?? [];
    this.byOrg.set(input.orgId, [...list, catalog.id]);
    void getEventBus().publish(
      buildEvent(POPULATION_EVENTS.catalogUpdated, { catalogId: catalog.id, orgId: input.orgId, action: "created" }, {}, "domain"),
    );
    return catalog;
  }

  get(id: OrgCatalogId): OrgProgramCatalog | undefined {
    return this.catalogs.get(id);
  }

  list(orgId?: PopulationOrgId): OrgProgramCatalog[] {
    if (orgId) {
      const ids = this.byOrg.get(orgId) ?? [];
      return ids.map((id) => this.catalogs.get(id)!).filter(Boolean);
    }
    return [...this.catalogs.values()];
  }

  /** Add a program to the approved list. Idempotent. */
  approveProgram(catalogId: OrgCatalogId, programId: ProgramId): OrgProgramCatalog {
    const cat = this.require(catalogId);
    if (cat.approvedProgramIds.includes(programId)) return cat;
    const updated: OrgProgramCatalog = {
      ...cat,
      approvedProgramIds: [...cat.approvedProgramIds, programId],
      updatedAt: getClock().iso(),
    };
    this.catalogs.set(catalogId, updated);
    this.emit(catalogId, "approved", programId);
    return updated;
  }

  /** Remove a program from approved (also drops it from required/sponsored). */
  removeProgram(catalogId: OrgCatalogId, programId: ProgramId): OrgProgramCatalog {
    const cat = this.require(catalogId);
    const updated: OrgProgramCatalog = {
      ...cat,
      approvedProgramIds: cat.approvedProgramIds.filter((p) => p !== programId),
      requiredProgramIds: cat.requiredProgramIds.filter((p) => p !== programId),
      sponsoredProgramIds: cat.sponsoredProgramIds.filter((p) => p !== programId),
      updatedAt: getClock().iso(),
    };
    this.catalogs.set(catalogId, updated);
    this.emit(catalogId, "removed", programId);
    return updated;
  }

  /** Mark a program as required (where legally appropriate). Auto-approves. */
  requireProgram(catalogId: OrgCatalogId, programId: ProgramId): OrgProgramCatalog {
    const cat = this.require(catalogId);
    const approved = cat.approvedProgramIds.includes(programId)
      ? cat.approvedProgramIds
      : [...cat.approvedProgramIds, programId];
    if (cat.requiredProgramIds.includes(programId)) {
      const updated = { ...cat, approvedProgramIds: approved, updatedAt: getClock().iso() };
      this.catalogs.set(catalogId, updated);
      return updated;
    }
    const updated: OrgProgramCatalog = {
      ...cat,
      approvedProgramIds: approved,
      requiredProgramIds: [...cat.requiredProgramIds, programId],
      updatedAt: getClock().iso(),
    };
    this.catalogs.set(catalogId, updated);
    this.emit(catalogId, "required", programId);
    return updated;
  }

  /** Mark a program as sponsored (org pays). Auto-approves. */
  sponsorProgram(catalogId: OrgCatalogId, programId: ProgramId): OrgProgramCatalog {
    const cat = this.require(catalogId);
    const approved = cat.approvedProgramIds.includes(programId)
      ? cat.approvedProgramIds
      : [...cat.approvedProgramIds, programId];
    if (cat.sponsoredProgramIds.includes(programId)) {
      const updated = { ...cat, approvedProgramIds: approved, updatedAt: getClock().iso() };
      this.catalogs.set(catalogId, updated);
      return updated;
    }
    const updated: OrgProgramCatalog = {
      ...cat,
      approvedProgramIds: approved,
      sponsoredProgramIds: [...cat.sponsoredProgramIds, programId],
      updatedAt: getClock().iso(),
    };
    this.catalogs.set(catalogId, updated);
    this.emit(catalogId, "sponsored", programId);
    return updated;
  }

  isApproved(catalogId: OrgCatalogId, programId: ProgramId): boolean {
    const cat = this.catalogs.get(catalogId);
    return !!cat && cat.approvedProgramIds.includes(programId);
  }

  isRequired(catalogId: OrgCatalogId, programId: ProgramId): boolean {
    const cat = this.catalogs.get(catalogId);
    return !!cat && cat.requiredProgramIds.includes(programId);
  }

  isSponsored(catalogId: OrgCatalogId, programId: ProgramId): boolean {
    const cat = this.catalogs.get(catalogId);
    return !!cat && cat.sponsoredProgramIds.includes(programId);
  }

  getApproved(catalogId: OrgCatalogId): ProgramId[] {
    return this.catalogs.get(catalogId)?.approvedProgramIds ?? [];
  }

  getRequired(catalogId: OrgCatalogId): ProgramId[] {
    return this.catalogs.get(catalogId)?.requiredProgramIds ?? [];
  }

  getSponsored(catalogId: OrgCatalogId): ProgramId[] {
    return this.catalogs.get(catalogId)?.sponsoredProgramIds ?? [];
  }

  getStats(): {
    totalCatalogs: number;
    totalApproved: number;
    totalRequired: number;
    totalSponsored: number;
    byOrg: Record<string, number>;
  } {
    const list = [...this.catalogs.values()];
    const byOrg: Record<string, number> = {};
    let totalApproved = 0;
    let totalRequired = 0;
    let totalSponsored = 0;
    for (const c of list) {
      byOrg[c.orgId as string] = (byOrg[c.orgId as string] ?? 0) + 1;
      totalApproved += c.approvedProgramIds.length;
      totalRequired += c.requiredProgramIds.length;
      totalSponsored += c.sponsoredProgramIds.length;
    }
    return {
      totalCatalogs: list.length,
      totalApproved,
      totalRequired,
      totalSponsored,
      byOrg,
    };
  }

  private require(id: OrgCatalogId): OrgProgramCatalog {
    const cat = this.catalogs.get(id);
    if (!cat) {
      throw new PopulationError({
        code: "eks.population.catalog.not_found",
        category: "not_found",
        message: `Catalog ${id} not found.`,
        userMessage: "Catalog not found.",
      });
    }
    return cat;
  }

  private emit(catalogId: OrgCatalogId, action: string, programId?: ProgramId): void {
    void getEventBus().publish(
      buildEvent(
        POPULATION_EVENTS.catalogUpdated,
        { catalogId, action, programId },
        {},
        "domain",
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _mgr: OrgCatalogManager | null = null;
export function getOrgCatalog(): OrgCatalogManager {
  if (!_mgr) _mgr = new OrgCatalogManager();
  return _mgr;
}
