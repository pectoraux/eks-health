/**
 * Eks-Health Population Platform — Membership Engine
 *
 * Invitations, enrollment, departments, teams, roles, delegated administration,
 * temporary membership, multiple organizations, membership history.
 * Participants may belong to multiple organizations simultaneously.
 */

import "server-only";
import {
  type MembershipId,
  type PopulationOrgId,
  type AccountId,
  type MembershipRole,
  type MembershipStatus,
  type OrganizationMembership,
  PopulationError,
  asMembershipId,
} from "../core";
import { getEventBus, buildEvent, generateId, getClock } from "@/kernel";
import { POPULATION_EVENTS } from "../core";

export class MembershipEngine {
  private readonly memberships = new Map<MembershipId, OrganizationMembership>();
  private readonly byOrg = new Map<PopulationOrgId, MembershipId[]>();
  private readonly byAccount = new Map<AccountId, MembershipId[]>();

  invite(input: {
    orgId: PopulationOrgId;
    accountId: AccountId;
    role: MembershipRole;
    invitedBy: AccountId;
    department?: string;
    team?: string;
    temporary?: boolean;
    expiresAt?: string;
  }): OrganizationMembership {
    // Check for existing membership
    const existing = this.findByOrgAndAccount(input.orgId, input.accountId);
    if (existing && (existing.status === "active" || existing.status === "invited")) return existing;

    const membership: OrganizationMembership = {
      id: asMembershipId(generateId("mem_")),
      orgId: input.orgId,
      accountId: input.accountId,
      role: input.role,
      status: "invited",
      department: input.department,
      team: input.team,
      invitedBy: input.invitedBy,
      temporary: input.temporary,
      expiresAt: input.expiresAt,
      joinedAt: getClock().iso(),
      history: [{ action: "invited", at: getClock().iso(), by: input.invitedBy }],
    };
    this.memberships.set(membership.id, membership);
    this.indexBy(membership);
    void getEventBus().publish(buildEvent(POPULATION_EVENTS.memberInvited, { membershipId: membership.id, orgId: input.orgId, accountId: input.accountId }, {}, "domain"));
    return membership;
  }

  accept(membershipId: MembershipId): OrganizationMembership {
    const m = this.memberships.get(membershipId);
    if (!m) throw new PopulationError({ code: "eks.population.membership.not_found", category: "not_found", message: "Membership not found." });
    const updated: OrganizationMembership = {
      ...m, status: "active",
      history: [...m.history, { action: "accepted", at: getClock().iso() }],
    };
    this.memberships.set(membershipId, updated);
    void getEventBus().publish(buildEvent(POPULATION_EVENTS.memberJoined, { membershipId, orgId: m.orgId, accountId: m.accountId }, {}, "domain"));
    return updated;
  }

  leave(membershipId: MembershipId): OrganizationMembership {
    const m = this.memberships.get(membershipId);
    if (!m) throw new PopulationError({ code: "eks.population.membership.not_found", category: "not_found", message: "Not found." });
    const updated: OrganizationMembership = {
      ...m, status: "left", leftAt: getClock().iso(),
      history: [...m.history, { action: "left", at: getClock().iso() }],
    };
    this.memberships.set(membershipId, updated);
    void getEventBus().publish(buildEvent(POPULATION_EVENTS.memberLeft, { membershipId, orgId: m.orgId, accountId: m.accountId }, {}, "domain"));
    return updated;
  }

  remove(membershipId: MembershipId, by: AccountId): OrganizationMembership {
    const m = this.memberships.get(membershipId);
    if (!m) throw new PopulationError({ code: "eks.population.membership.not_found", category: "not_found", message: "Not found." });
    const updated: OrganizationMembership = {
      ...m, status: "removed", leftAt: getClock().iso(),
      history: [...m.history, { action: "removed", at: getClock().iso(), by }],
    };
    this.memberships.set(membershipId, updated);
    return updated;
  }

  updateRole(membershipId: MembershipId, role: MembershipRole, by: AccountId): OrganizationMembership {
    const m = this.memberships.get(membershipId);
    if (!m) throw new PopulationError({ code: "eks.population.membership.not_found", category: "not_found", message: "Not found." });
    const updated: OrganizationMembership = {
      ...m, role,
      history: [...m.history, { action: "role_changed", at: getClock().iso(), by }],
    };
    this.memberships.set(membershipId, updated);
    return updated;
  }

  get(id: MembershipId): OrganizationMembership | undefined {
    return this.memberships.get(id);
  }

  listByOrg(orgId: PopulationOrgId, activeOnly?: boolean): OrganizationMembership[] {
    const ids = this.byOrg.get(orgId) ?? [];
    let list = ids.map((id) => this.memberships.get(id)!).filter(Boolean);
    if (activeOnly) list = list.filter((m) => m.status === "active");
    return list;
  }

  listByAccount(accountId: AccountId, activeOnly?: boolean): OrganizationMembership[] {
    const ids = this.byAccount.get(accountId) ?? [];
    let list = ids.map((id) => this.memberships.get(id)!).filter(Boolean);
    if (activeOnly) list = list.filter((m) => m.status === "active");
    return list;
  }

  findByOrgAndAccount(orgId: PopulationOrgId, accountId: AccountId): OrganizationMembership | undefined {
    return this.listByOrg(orgId).find((m) => m.accountId === accountId);
  }

  isAdmin(accountId: AccountId, orgId: PopulationOrgId): boolean {
    const m = this.findByOrgAndAccount(orgId, accountId);
    return !!m && m.status === "active" && (m.role === "admin" || m.role === "manager");
  }

  getStats(): { total: number; active: number; invited: number; left: number; removed: number } {
    const list = [...this.memberships.values()];
    return {
      total: list.length,
      active: list.filter((m) => m.status === "active").length,
      invited: list.filter((m) => m.status === "invited").length,
      left: list.filter((m) => m.status === "left").length,
      removed: list.filter((m) => m.status === "removed").length,
    };
  }

  private indexBy(m: OrganizationMembership): void {
    const oList = this.byOrg.get(m.orgId) ?? [];
    this.byOrg.set(m.orgId, [...oList, m.id]);
    const aList = this.byAccount.get(m.accountId) ?? [];
    this.byAccount.set(m.accountId, [...aList, m.id]);
  }
}

let _engine: MembershipEngine | null = null;
export function getMemberships(): MembershipEngine {
  if (!_engine) _engine = new MembershipEngine();
  return _engine;
}
