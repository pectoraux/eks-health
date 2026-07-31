/**
 * Eks-Health Social Platform — Teams
 *
 * Teams are member-coordinated groups with a captain. Teams may be standalone
 * or anchored to an organization (createdOrgId). Captains can add/remove
 * members and transfer captaincy. Disbanding a team is permanent.
 */

import "server-only";
import {
  type TeamId,
  type AccountId,
  type OrgId,
  type Team,
  SocialError,
  asTeamId,
} from "../core";
import { getEventBus, buildEvent, generateId, getClock } from "@/kernel";
import { SOCIAL_EVENTS } from "../core";

// ---------------------------------------------------------------------------
// Input shapes
// ---------------------------------------------------------------------------

export interface CreateTeamInput {
  readonly name: string;
  readonly description: string;
  readonly captainId: AccountId;
  readonly memberIds?: AccountId[];
  readonly createdOrgId?: OrgId;
}

// ---------------------------------------------------------------------------
// Team manager
// ---------------------------------------------------------------------------

export class TeamManager {
  private readonly teams = new Map<TeamId, Team>();
  private readonly byCaptain = new Map<AccountId, TeamId[]>();
  private readonly byParticipant = new Map<AccountId, TeamId[]>();
  private readonly byOrg = new Map<OrgId, TeamId[]>();
  private readonly disbanded = new Set<TeamId>();

  create(input: CreateTeamInput): Team {
    if (!input.name.trim()) {
      throw new SocialError({
        code: "eks.social.team.empty_name",
        category: "validation",
        message: "Team name cannot be empty.",
      });
    }
    const id = asTeamId(generateId("tm_"));
    const now = getClock().iso();
    const members = new Set<AccountId>([input.captainId, ...(input.memberIds ?? [])]);
    const team: Team = {
      id,
      name: input.name,
      description: input.description,
      captainId: input.captainId,
      memberIds: [...members],
      createdOrgId: input.createdOrgId,
      createdAt: now,
    };
    this.teams.set(id, team);
    link(this.byCaptain, input.captainId, id);
    for (const m of members) link(this.byParticipant, m, id);
    if (input.createdOrgId) link(this.byOrg, input.createdOrgId, id);
    void getEventBus().publish(
      buildEvent(
        SOCIAL_EVENTS.teamCreated,
        { teamId: id, name: input.name, captainId: input.captainId, memberCount: team.memberIds.length, createdOrgId: input.createdOrgId },
        {},
        "domain",
      ),
    );
    return team;
  }

  getTeam(id: TeamId): Team | undefined {
    return this.teams.get(id);
  }

  listTeams(filter?: { captainId?: AccountId; memberId?: AccountId; orgId?: OrgId }): Team[] {
    if (filter?.captainId) {
      return (this.byCaptain.get(filter.captainId) ?? []).map((id) => this.teams.get(id)!).filter(Boolean);
    }
    if (filter?.memberId) {
      return (this.byParticipant.get(filter.memberId) ?? []).map((id) => this.teams.get(id)!).filter(Boolean);
    }
    if (filter?.orgId) {
      return (this.byOrg.get(filter.orgId) ?? []).map((id) => this.teams.get(id)!).filter(Boolean);
    }
    return [...this.teams.values()];
  }

  listMembers(teamId: TeamId): AccountId[] {
    const t = this.teams.get(teamId);
    if (!t) {
      throw new SocialError({
        code: "eks.social.team.not_found",
        category: "not_found",
        message: `Team ${teamId} not found.`,
      });
    }
    return [...t.memberIds];
  }

  addMember(teamId: TeamId, memberId: AccountId, by?: AccountId): Team {
    const t = this.teams.get(teamId);
    if (!t) {
      throw new SocialError({
        code: "eks.social.team.not_found",
        category: "not_found",
        message: `Team ${teamId} not found.`,
      });
    }
    if (by && by !== t.captainId) {
      throw new SocialError({
        code: "eks.social.team.not_captain",
        category: "forbidden",
        message: "Only the captain can add members.",
        userMessage: "Only the team captain can add members.",
      });
    }
    if (t.memberIds.includes(memberId)) {
      throw new SocialError({
        code: "eks.social.team.already_member",
        category: "already_member",
        message: "Account is already a team member.",
        userMessage: "This account is already on the team.",
      });
    }
    const updated: Team = { ...t, memberIds: [...t.memberIds, memberId] };
    this.teams.set(teamId, updated);
    link(this.byParticipant, memberId, teamId);
    void getEventBus().publish(
      buildEvent(
        SOCIAL_EVENTS.teamJoined,
        { teamId, memberId, addedBy: by },
        {},
        "domain",
      ),
    );
    return updated;
  }

  removeMember(teamId: TeamId, memberId: AccountId, by?: AccountId): Team {
    const t = this.teams.get(teamId);
    if (!t) {
      throw new SocialError({
        code: "eks.social.team.not_found",
        category: "not_found",
        message: `Team ${teamId} not found.`,
      });
    }
    if (by && by !== t.captainId && by !== memberId) {
      throw new SocialError({
        code: "eks.social.team.not_captain",
        category: "forbidden",
        message: "Only the captain (or the member themselves) can remove a member.",
      });
    }
    if (!t.memberIds.includes(memberId)) {
      throw new SocialError({
        code: "eks.social.team.not_member",
        category: "not_member",
        message: "Account is not a team member.",
      });
    }
    if (memberId === t.captainId) {
      throw new SocialError({
        code: "eks.social.team.captain_leave",
        category: "state_conflict",
        message: "Captain cannot leave without transferring captaincy or disbanding.",
        userMessage: "Transfer captaincy or disband the team first.",
      });
    }
    const updated: Team = { ...t, memberIds: t.memberIds.filter((m) => m !== memberId) };
    this.teams.set(teamId, updated);
    unlink(this.byParticipant, memberId, teamId);
    void getEventBus().publish(
      buildEvent(
        SOCIAL_EVENTS.teamLeft,
        { teamId, memberId, removedBy: by },
        {},
        "domain",
      ),
    );
    return updated;
  }

  join(teamId: TeamId, memberId: AccountId): Team {
    return this.addMember(teamId, memberId);
  }

  leave(teamId: TeamId, memberId: AccountId): Team {
    return this.removeMember(teamId, memberId);
  }

  setCaptain(teamId: TeamId, newCaptainId: AccountId, by: AccountId): Team {
    const t = this.teams.get(teamId);
    if (!t) {
      throw new SocialError({
        code: "eks.social.team.not_found",
        category: "not_found",
        message: `Team ${teamId} not found.`,
      });
    }
    if (by !== t.captainId) {
      throw new SocialError({
        code: "eks.social.team.not_captain",
        category: "forbidden",
        message: "Only the current captain can transfer captaincy.",
      });
    }
    if (!t.memberIds.includes(newCaptainId)) {
      throw new SocialError({
        code: "eks.social.team.not_member",
        category: "not_member",
        message: "New captain must already be a team member.",
      });
    }
    const updated: Team = { ...t, captainId: newCaptainId };
    this.teams.set(teamId, updated);
    unlink(this.byCaptain, t.captainId, teamId);
    link(this.byCaptain, newCaptainId, teamId);
    return updated;
  }

  disband(teamId: TeamId, by: AccountId): void {
    const t = this.teams.get(teamId);
    if (!t) {
      throw new SocialError({
        code: "eks.social.team.not_found",
        category: "not_found",
        message: `Team ${teamId} not found.`,
      });
    }
    if (by !== t.captainId) {
      throw new SocialError({
        code: "eks.social.team.not_captain",
        category: "forbidden",
        message: "Only the captain can disband the team.",
      });
    }
    for (const m of t.memberIds) unlink(this.byParticipant, m, teamId);
    unlink(this.byCaptain, t.captainId, teamId);
    if (t.createdOrgId) unlink(this.byOrg, t.createdOrgId, teamId);
    this.teams.delete(teamId);
    this.disbanded.add(teamId);
    void getEventBus().publish(
      buildEvent(
        SOCIAL_EVENTS.teamDisbanded,
        { teamId, captainId: t.captainId, formerMemberCount: t.memberIds.length },
        {},
        "domain",
      ),
    );
  }

  isMember(teamId: TeamId, accountId: AccountId): boolean {
    const t = this.teams.get(teamId);
    return Boolean(t && t.memberIds.includes(accountId));
  }

  // -------------------------------------------------------------------------
  // Stats
  // -------------------------------------------------------------------------

  getStats(): {
    totalTeams: number;
    activeTeams: number;
    disbanded: number;
    totalMemberships: number;
    avgMembersPerTeam: number;
    largestTeamSize: number;
  } {
    const list = [...this.teams.values()];
    let totalMemberships = 0;
    let largest = 0;
    for (const t of list) {
      totalMemberships += t.memberIds.length;
      largest = Math.max(largest, t.memberIds.length);
    }
    return {
      totalTeams: list.length + this.disbanded.size,
      activeTeams: list.length,
      disbanded: this.disbanded.size,
      totalMemberships,
      avgMembersPerTeam: list.length ? totalMemberships / list.length : 0,
      largestTeamSize: largest,
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function link<K>(map: Map<K, TeamId[]>, id: K, tid: TeamId): void {
  const list = map.get(id) ?? [];
  if (!list.includes(tid)) map.set(id, [...list, tid]);
}

function unlink<K>(map: Map<K, TeamId[]>, id: K, tid: TeamId): void {
  const list = map.get(id);
  if (!list) return;
  map.set(id, list.filter((x) => x !== tid));
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _manager: TeamManager | null = null;
export function getTeams(): TeamManager {
  if (!_manager) _manager = new TeamManager();
  return _manager;
}
export function resetTeams(): void {
  _manager = null;
}
