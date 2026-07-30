/**
 * Eks-Health Identity — Organizations
 *
 * Organization support for the platform: hospitals, clinics, companies,
 * governments, universities, NGOs, insurance providers, research institutions.
 * Provides membership, invitations, teams, departments, hierarchical
 * organizations, and delegated administration.
 *
 * Security & integrity features:
 * - Invite tokens are random 32-byte values; only the SHA-256 hash is stored.
 *   Tokens are single-use and time-bound (default TTL 7 days).
 * - Hierarchy is cycle-detected: setting a parent that would create a cycle
 *   (direct or transitive) is rejected.
 * - Every mutating operation appends to a per-org audit trail.
 * - Suspension is reversible; termination is terminal.
 *
 * This module emits `eks.identity.org.*` events on the kernel event bus.
 */

import "server-only";
import { createHash, randomBytes } from "node:crypto";

import {
  type AccountId,
  type OrgId,
  type TeamId,
  IdentityError,
  asOrgId,
  asTeamId,
} from "../core";
import { getEventBus, buildEvent, getClock, generateId } from "@/kernel";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OrganizationType =
  | "hospital"
  | "clinic"
  | "company"
  | "government"
  | "university"
  | "ngo"
  | "insurance"
  | "research_institution";

export type DataClassification =
  | "public"
  | "internal"
  | "confidential"
  | "restricted"
  | "secret";

export type OrgRole =
  | "owner"
  | "admin"
  | "member"
  | "billing"
  | "auditor"
  | "delegate";

export type OrgStatus = "active" | "suspended" | "terminated";

export type DelegatedScopeKind =
  | "members"
  | "teams"
  | "billing"
  | "audit"
  | "policies"
  | "all";

export interface Organization {
  readonly id: OrgId;
  readonly type: OrganizationType;
  readonly name: string;
  readonly slug: string;
  readonly description?: string;
  readonly parentId?: OrgId;
  readonly dataClassification: DataClassification;
  readonly status: OrgStatus;
  readonly website?: string;
  readonly address?: string;
  readonly locale?: string;
  readonly metadata?: Record<string, unknown>;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly createdBy?: AccountId;
  readonly suspendedAt?: string;
  readonly suspendedReason?: string;
  readonly terminatedAt?: string;
}

export interface OrgMembership {
  readonly orgId: OrgId;
  readonly accountId: AccountId;
  readonly role: OrgRole;
  readonly title?: string;
  readonly departmentId?: string;
  readonly addedAt: string;
  readonly addedBy?: AccountId;
  readonly active: boolean;
  readonly removedAt?: string;
}

export interface OrgInvitation {
  readonly id: string;
  readonly orgId: OrgId;
  readonly email: string;
  readonly role: OrgRole;
  readonly invitedBy: AccountId;
  readonly tokenHash: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly consumed: boolean;
  readonly consumedAt?: string;
  readonly consumedBy?: AccountId;
  readonly revokedAt?: string;
}

export interface Team {
  readonly id: TeamId;
  readonly orgId: OrgId;
  readonly name: string;
  readonly description?: string;
  readonly departmentId?: string;
  readonly memberAccountIds: readonly AccountId[];
  readonly createdAt: string;
  readonly createdBy?: AccountId;
}

export interface Department {
  readonly id: string;
  readonly orgId: OrgId;
  readonly name: string;
  readonly description?: string;
  readonly parentId?: string; // sub-department within the org
  readonly headAccountId?: AccountId;
  readonly createdAt: string;
}

export interface OrgNode {
  readonly org: Organization;
  readonly children: readonly OrgNode[];
  readonly depth: number;
}

export interface DelegatedScope {
  readonly id: string;
  readonly orgId: OrgId;
  readonly delegateAccountId: AccountId;
  readonly scope: DelegatedScopeKind;
  readonly permissions: readonly string[];
  readonly validUntil?: string;
  readonly createdAt: string;
  readonly createdBy: AccountId;
  readonly revokedAt?: string;
}

export interface OrgAuditEntry {
  readonly id: string;
  readonly orgId: OrgId;
  readonly action: string;
  readonly actor?: AccountId;
  readonly at: string;
  readonly before?: Record<string, unknown>;
  readonly after?: Record<string, unknown>;
  readonly metadata?: Record<string, unknown>;
}

export interface CreateOrganizationInput {
  readonly type: OrganizationType;
  readonly name: string;
  readonly slug?: string;
  readonly description?: string;
  readonly parentId?: OrgId;
  readonly website?: string;
  readonly address?: string;
  readonly locale?: string;
  readonly metadata?: Record<string, unknown>;
  readonly createdBy?: AccountId;
  readonly dataClassification?: DataClassification; // override default
}

export interface CreateTeamInput {
  readonly name: string;
  readonly description?: string;
  readonly departmentId?: string;
  readonly createdBy?: AccountId;
}

export interface CreateDepartmentInput {
  readonly name: string;
  readonly description?: string;
  readonly parentId?: string;
  readonly headAccountId?: AccountId;
}

export interface ListOrgsFilter {
  readonly type?: OrganizationType;
  readonly status?: OrgStatus;
  readonly parentId?: OrgId;
  readonly rootOnly?: boolean;
  readonly dataClassification?: DataClassification;
}

// ---------------------------------------------------------------------------
// Org-type catalog
// ---------------------------------------------------------------------------

export interface OrgTypeDescriptor {
  readonly type: OrganizationType;
  readonly label: string;
  readonly description: string;
  readonly defaultDataClassification: DataClassification;
}

export const ORG_TYPES: readonly OrgTypeDescriptor[] = [
  {
    type: "hospital",
    label: "Hospital",
    description: "Healthcare facility providing clinical care to participants.",
    defaultDataClassification: "restricted",
  },
  {
    type: "clinic",
    label: "Clinic",
    description: "Outpatient care facility or community health clinic.",
    defaultDataClassification: "restricted",
  },
  {
    type: "company",
    label: "Company",
    description: "A corporate employer managing employee wellness programs.",
    defaultDataClassification: "confidential",
  },
  {
    type: "government",
    label: "Government",
    description: "Public-sector health authority or ministry of health.",
    defaultDataClassification: "restricted",
  },
  {
    type: "university",
    label: "University",
    description: "Academic institution conducting research and education.",
    defaultDataClassification: "confidential",
  },
  {
    type: "ngo",
    label: "Non-Governmental Organization",
    description: "Non-profit operating community health or relief programs.",
    defaultDataClassification: "internal",
  },
  {
    type: "insurance",
    label: "Insurance Provider",
    description: "Health insurer or payer integrating with care programs.",
    defaultDataClassification: "restricted",
  },
  {
    type: "research_institution",
    label: "Research Institution",
    description: "Research body requesting de-identified health data.",
    defaultDataClassification: "confidential",
  },
];

export function orgTypeDescriptor(type: OrganizationType): OrgTypeDescriptor {
  const d = ORG_TYPES.find((t) => t.type === type);
  if (!d) {
    throw new IdentityError({
      code: "eks.identity.org.unknown_type",
      category: "validation",
      message: `Unknown organization type: ${type}`,
    });
  }
  return d;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export const ORG_EVENTS = {
  created: "eks.identity.org.created",
  memberAdded: "eks.identity.org.member_added",
  memberRemoved: "eks.identity.org.member_removed",
  inviteIssued: "eks.identity.org.invite_issued",
  inviteAccepted: "eks.identity.org.invite_accepted",
  teamCreated: "eks.identity.org.team_created",
  delegated: "eks.identity.org.delegated",
} as const;

// ---------------------------------------------------------------------------
// Invite-token hashing (single-use, time-bound)
// ---------------------------------------------------------------------------

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function newInviteToken(): string {
  // 32 raw bytes -> base64url, ~43 chars
  return randomBytes(32).toString("base64url");
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

const MAX_HIERARCHY_DEPTH = 16;

export class OrganizationManager {
  private readonly orgs = new Map<OrgId, Organization>();
  private readonly bySlug = new Map<string, OrgId>();
  private readonly childrenIndex = new Map<OrgId, OrgId[]>();
  private readonly memberships = new Map<AccountId, OrgMembership[]>();
  private readonly membersByOrg = new Map<OrgId, AccountId[]>();
  private readonly invites = new Map<string, OrgInvitation>(); // keyed by tokenHash
  private readonly teams = new Map<TeamId, Team>();
  private readonly teamsByOrg = new Map<OrgId, TeamId[]>();
  private readonly departments = new Map<string, Department>();
  private readonly departmentsByOrg = new Map<OrgId, string[]>();
  private readonly delegations = new Map<OrgId, DelegatedScope[]>();
  private readonly audit = new Map<OrgId, OrgAuditEntry[]>();

  // ------------------------------------------------------------------ create

  create(input: CreateOrganizationInput): Organization {
    const descriptor = orgTypeDescriptor(input.type);
    const slug = (input.slug ?? slugify(input.name)).toLowerCase();
    if (!slug) {
      throw new IdentityError({
        code: "eks.identity.org.invalid_slug",
        category: "validation",
        message: "Organization slug cannot be empty.",
        userMessage: "Organization slug cannot be empty.",
      });
    }
    if (this.bySlug.has(slug)) {
      throw new IdentityError({
        code: "eks.identity.org.slug_taken",
        category: "conflict",
        message: `Slug '${slug}' already in use.`,
        userMessage: "This organization URL slug is already taken.",
      });
    }
    if (input.parentId) {
      const parent = this.orgs.get(input.parentId);
      if (!parent) {
        throw new IdentityError({
          code: "eks.identity.org.parent_not_found",
          category: "not_found",
          message: `Parent org ${input.parentId} does not exist.`,
        });
      }
      if (parent.status !== "active") {
        throw new IdentityError({
          code: "eks.identity.org.parent_inactive",
          category: "policy_violation",
          message: `Parent org ${input.parentId} is not active.`,
          userMessage: "The parent organization is not active.",
        });
      }
    }
    const now = getClock().iso();
    const org: Organization = {
      id: asOrgId(generateId("org_")),
      type: input.type,
      name: input.name,
      slug,
      description: input.description,
      parentId: input.parentId,
      dataClassification: input.dataClassification ?? descriptor.defaultDataClassification,
      status: "active",
      website: input.website,
      address: input.address,
      locale: input.locale,
      metadata: input.metadata,
      createdAt: now,
      updatedAt: now,
      createdBy: input.createdBy,
    };
    this.orgs.set(org.id, org);
    this.bySlug.set(slug, org.id);
    if (input.parentId) {
      this.attachChild(input.parentId, org.id);
    }
    this.recordAudit(org.id, "created", input.createdBy, undefined, { type: org.type, name: org.name });

    void getEventBus().publish(
      buildEvent(
        ORG_EVENTS.created,
        { orgId: org.id, type: org.type, name: org.name, slug, parentId: org.parentId },
        {},
        "domain",
      ),
    );
    return org;
  }

  get(id: OrgId): Organization | undefined {
    return this.orgs.get(id);
  }

  getBySlug(slug: string): Organization | undefined {
    const id = this.bySlug.get(slug.toLowerCase());
    return id ? this.orgs.get(id) : undefined;
  }

  list(filter?: ListOrgsFilter): Organization[] {
    const all = [...this.orgs.values()];
    if (!filter) return all;
    return all.filter((o) => {
      if (filter.type && o.type !== filter.type) return false;
      if (filter.status && o.status !== filter.status) return false;
      if (filter.parentId && o.parentId !== filter.parentId) return false;
      if (filter.rootOnly && o.parentId !== undefined) return false;
      if (filter.dataClassification && o.dataClassification !== filter.dataClassification) return false;
      return true;
    });
  }

  // --------------------------------------------------------------- membership

  addMember(orgId: OrgId, accountId: AccountId, role: OrgRole, opts?: { title?: string; departmentId?: string; addedBy?: AccountId }): OrgMembership {
    const org = this.requireOrg(orgId);
    this.requireActive(org);
    const existing = (this.memberships.get(accountId) ?? []).find((m) => m.orgId === orgId && m.active);
    if (existing) {
      throw new IdentityError({
        code: "eks.identity.org.already_member",
        category: "conflict",
        message: `Account ${accountId} is already a member of ${orgId}.`,
        userMessage: "This account is already a member of the organization.",
      });
    }
    if (role === "owner") {
      // Only one active owner per org
      const owners = (this.membersByOrg.get(orgId) ?? [])
        .map((id) => (this.memberships.get(id) ?? []).find((m) => m.orgId === orgId && m.active && m.role === "owner"))
        .filter((m): m is OrgMembership => !!m);
      if (owners.length > 0) {
        throw new IdentityError({
          code: "eks.identity.org.owner_exists",
          category: "conflict",
          message: `Org ${orgId} already has an owner.`,
          userMessage: "An organization can have only one owner.",
        });
      }
    }
    const now = getClock().iso();
    const membership: OrgMembership = {
      orgId,
      accountId,
      role,
      title: opts?.title,
      departmentId: opts?.departmentId,
      addedAt: now,
      addedBy: opts?.addedBy,
      active: true,
    };
    const list = this.memberships.get(accountId) ?? [];
    list.push(membership);
    this.memberships.set(accountId, list);
    const memberList = this.membersByOrg.get(orgId) ?? [];
    memberList.push(accountId);
    this.membersByOrg.set(orgId, memberList);
    this.recordAudit(orgId, "member_added", opts?.addedBy, undefined, { accountId, role });
    void getEventBus().publish(
      buildEvent(ORG_EVENTS.memberAdded, { orgId, accountId, role }, {}, "domain"),
    );
    return membership;
  }

  removeMember(orgId: OrgId, accountId: AccountId, removedBy?: AccountId, reason?: string): void {
    this.requireOrg(orgId);
    const list = this.memberships.get(accountId) ?? [];
    const idx = list.findIndex((m) => m.orgId === orgId && m.active);
    if (idx < 0) {
      throw new IdentityError({
        code: "eks.identity.org.not_member",
        category: "not_found",
        message: `Account ${accountId} is not an active member of ${orgId}.`,
      });
    }
    const removed = list[idx];
    const now = getClock().iso();
    list[idx] = { ...removed, active: false, removedAt: now };
    this.memberships.set(accountId, list);
    // Prune member index
    const memberList = (this.membersByOrg.get(orgId) ?? []).filter((id) => id !== accountId);
    if (memberList.length === 0) this.membersByOrg.delete(orgId);
    else this.membersByOrg.set(orgId, memberList);
    // Remove from any teams in this org
    for (const tid of this.teamsByOrg.get(orgId) ?? []) {
      const t = this.teams.get(tid);
      if (t && t.memberAccountIds.includes(accountId)) {
        this.teams.set(tid, { ...t, memberAccountIds: t.memberAccountIds.filter((a) => a !== accountId) });
      }
    }
    this.recordAudit(orgId, "member_removed", removedBy, { role: removed.role }, { accountId, reason });
    void getEventBus().publish(
      buildEvent(ORG_EVENTS.memberRemoved, { orgId, accountId, role: removed.role, reason }, {}, "domain"),
    );
  }

  listMembers(orgId: OrgId): OrgMembership[] {
    this.requireOrg(orgId);
    const ids = this.membersByOrg.get(orgId) ?? [];
    return ids
      .map((id) => (this.memberships.get(id) ?? []).find((m) => m.orgId === orgId && m.active))
      .filter((m): m is OrgMembership => !!m);
  }

  listMembershipsForAccount(accountId: AccountId): OrgMembership[] {
    return (this.memberships.get(accountId) ?? []).filter((m) => m.active);
  }

  // --------------------------------------------------------------- invitations

  invite(orgId: OrgId, email: string, role: OrgRole, invitedBy: AccountId): string {
    const org = this.requireOrg(orgId);
    this.requireActive(org);
    const normalized = email.toLowerCase().trim();
    if (!normalized.includes("@")) {
      throw new IdentityError({
        code: "eks.identity.org.invalid_invite_email",
        category: "validation",
        message: `Invalid invite email: ${email}`,
        userMessage: "Please enter a valid email address.",
      });
    }
    const raw = newInviteToken();
    const tokenHash = hashToken(raw);
    const now = getClock().iso();
    const invitation: OrgInvitation = {
      id: generateId("inv_"),
      orgId,
      email: normalized,
      role,
      invitedBy,
      tokenHash,
      createdAt: now,
      expiresAt: new Date(Date.now() + INVITE_TTL_MS).toISOString(),
      consumed: false,
    };
    this.invites.set(tokenHash, invitation);
    this.recordAudit(orgId, "invite_issued", invitedBy, undefined, { email: normalized, role });
    void getEventBus().publish(
      buildEvent(ORG_EVENTS.inviteIssued, { orgId, email: normalized, role, invitedBy, expiresAt: invitation.expiresAt }, {}, "domain"),
    );
    return raw; // returned ONCE; only the hash is stored
  }

  /** Accept an invite by raw token. Returns the resulting membership. */
  acceptInvite(rawToken: string, accountId: AccountId): OrgMembership {
    const tokenHash = hashToken(rawToken);
    const invite = this.invites.get(tokenHash);
    if (!invite) {
      throw new IdentityError({
        code: "eks.identity.org.invite_invalid",
        category: "not_found",
        message: "Unknown invite token.",
        userMessage: "This invite link is invalid.",
      });
    }
    if (invite.revokedAt) {
      throw new IdentityError({
        code: "eks.identity.org.invite_revoked",
        category: "permission_denied",
        message: "Invite has been revoked.",
        userMessage: "This invite is no longer valid.",
      });
    }
    if (invite.consumed) {
      throw new IdentityError({
        code: "eks.identity.org.invite_consumed",
        category: "conflict",
        message: "Invite already used.",
        userMessage: "This invite has already been used.",
      });
    }
    if (new Date(invite.expiresAt).getTime() < Date.now()) {
      throw new IdentityError({
        code: "eks.identity.org.invite_expired",
        category: "permission_denied",
        message: `Invite expired at ${invite.expiresAt}.`,
        userMessage: "This invite has expired. Request a new one.",
      });
    }
    const org = this.requireOrg(invite.orgId);
    if (org.status !== "active") {
      throw new IdentityError({
        code: "eks.identity.org.not_active",
        category: "policy_violation",
        message: `Org ${invite.orgId} is not active.`,
        userMessage: "This organization is not currently active.",
      });
    }
    // Consume the token (single-use)
    const now = getClock().iso();
    this.invites.set(tokenHash, { ...invite, consumed: true, consumedAt: now, consumedBy: accountId });
    this.recordAudit(invite.orgId, "invite_accepted", accountId, { email: invite.email }, { role: invite.role });
    void getEventBus().publish(
      buildEvent(ORG_EVENTS.inviteAccepted, { orgId: invite.orgId, accountId, role: invite.role, email: invite.email }, {}, "domain"),
    );
    return this.addMember(invite.orgId, accountId, invite.role, { addedBy: invite.invitedBy });
  }

  listInvites(orgId: OrgId): OrgInvitation[] {
    this.requireOrg(orgId);
    return [...this.invites.values()].filter((i) => i.orgId === orgId);
  }

  revokeInvite(orgId: OrgId, inviteId: string, revokedBy?: AccountId): void {
    this.requireOrg(orgId);
    for (const [hash, inv] of this.invites) {
      if (inv.id === inviteId && inv.orgId === orgId) {
        if (inv.consumed) {
          throw new IdentityError({
            code: "eks.identity.org.invite_already_consumed",
            category: "conflict",
            message: "Cannot revoke a consumed invite.",
          });
        }
        this.invites.set(hash, { ...inv, revokedAt: getClock().iso() });
        this.recordAudit(orgId, "invite_revoked", revokedBy, { email: inv.email }, undefined);
        return;
      }
    }
    throw new IdentityError({
      code: "eks.identity.org.invite_not_found",
      category: "not_found",
      message: `Invite ${inviteId} not found in org ${orgId}.`,
    });
  }

  // --------------------------------------------------------------- teams

  createTeam(orgId: OrgId, input: CreateTeamInput): Team {
    const org = this.requireOrg(orgId);
    this.requireActive(org);
    if (!input.name?.trim()) {
      throw new IdentityError({
        code: "eks.identity.org.team_name_required",
        category: "validation",
        message: "Team name is required.",
      });
    }
    if (input.departmentId) {
      const dept = this.departments.get(input.departmentId);
      if (!dept || dept.orgId !== orgId) {
        throw new IdentityError({
          code: "eks.identity.org.department_not_found",
          category: "not_found",
          message: `Department ${input.departmentId} not found in org ${orgId}.`,
        });
      }
    }
    const team: Team = {
      id: asTeamId(generateId("team_")),
      orgId,
      name: input.name,
      description: input.description,
      departmentId: input.departmentId,
      memberAccountIds: [],
      createdAt: getClock().iso(),
      createdBy: input.createdBy,
    };
    this.teams.set(team.id, team);
    const list = this.teamsByOrg.get(orgId) ?? [];
    list.push(team.id);
    this.teamsByOrg.set(orgId, list);
    this.recordAudit(orgId, "team_created", input.createdBy, undefined, { teamId: team.id, name: team.name });
    void getEventBus().publish(
      buildEvent(ORG_EVENTS.teamCreated, { orgId, teamId: team.id, name: team.name }, {}, "domain"),
    );
    return team;
  }

  getTeam(teamId: TeamId): Team | undefined {
    return this.teams.get(teamId);
  }

  listTeams(orgId: OrgId): Team[] {
    this.requireOrg(orgId);
    return (this.teamsByOrg.get(orgId) ?? []).map((id) => this.teams.get(id)!).filter(Boolean);
  }

  addTeamMember(teamId: TeamId, accountId: AccountId): Team {
    const team = this.teams.get(teamId);
    if (!team) {
      throw new IdentityError({
        code: "eks.identity.org.team_not_found",
        category: "not_found",
        message: `Team ${teamId} not found.`,
      });
    }
    // Membership check: must be a member of the org to join a team
    const isMember = (this.memberships.get(accountId) ?? []).some((m) => m.orgId === team.orgId && m.active);
    if (!isMember) {
      throw new IdentityError({
        code: "eks.identity.org.not_org_member",
        category: "permission_denied",
        message: `Account ${accountId} is not a member of org ${team.orgId}.`,
        userMessage: "Only organization members can join teams.",
      });
    }
    if (!team.memberAccountIds.includes(accountId)) {
      this.teams.set(teamId, {
        ...team,
        memberAccountIds: [...team.memberAccountIds, accountId],
      });
    }
    return this.teams.get(teamId)!;
  }

  removeTeamMember(teamId: TeamId, accountId: AccountId): Team {
    const team = this.teams.get(teamId);
    if (!team) {
      throw new IdentityError({
        code: "eks.identity.org.team_not_found",
        category: "not_found",
        message: `Team ${teamId} not found.`,
      });
    }
    this.teams.set(teamId, {
      ...team,
      memberAccountIds: team.memberAccountIds.filter((a) => a !== accountId),
    });
    return this.teams.get(teamId)!;
  }

  // --------------------------------------------------------------- departments

  createDepartment(orgId: OrgId, input: CreateDepartmentInput): Department {
    const org = this.requireOrg(orgId);
    this.requireActive(org);
    if (!input.name?.trim()) {
      throw new IdentityError({
        code: "eks.identity.org.dept_name_required",
        category: "validation",
        message: "Department name is required.",
      });
    }
    if (input.parentId) {
      const parent = this.departments.get(input.parentId);
      if (!parent || parent.orgId !== orgId) {
        throw new IdentityError({
          code: "eks.identity.org.parent_dept_not_found",
          category: "not_found",
          message: `Parent department ${input.parentId} not found in org ${orgId}.`,
        });
      }
    }
    const dept: Department = {
      id: generateId("dept_"),
      orgId,
      name: input.name,
      description: input.description,
      parentId: input.parentId,
      headAccountId: input.headAccountId,
      createdAt: getClock().iso(),
    };
    this.departments.set(dept.id, dept);
    const list = this.departmentsByOrg.get(orgId) ?? [];
    list.push(dept.id);
    this.departmentsByOrg.set(orgId, list);
    this.recordAudit(orgId, "department_created", undefined, undefined, { departmentId: dept.id, name: dept.name });
    return dept;
  }

  listDepartments(orgId: OrgId): Department[] {
    this.requireOrg(orgId);
    return (this.departmentsByOrg.get(orgId) ?? []).map((id) => this.departments.get(id)!).filter(Boolean);
  }

  // --------------------------------------------------------------- hierarchy

  setParent(orgId: OrgId, parentId: OrgId): Organization {
    const org = this.requireOrg(orgId);
    if (orgId === parentId) {
      throw new IdentityError({
        code: "eks.identity.org.self_parent",
        category: "validation",
        message: "An organization cannot be its own parent.",
      });
    }
    const parent = this.orgs.get(parentId);
    if (!parent) {
      throw new IdentityError({
        code: "eks.identity.org.parent_not_found",
        category: "not_found",
        message: `Parent org ${parentId} does not exist.`,
      });
    }
    if (parent.status !== "active") {
      throw new IdentityError({
        code: "eks.identity.org.parent_inactive",
        category: "policy_violation",
        message: `Parent org ${parentId} is not active.`,
      });
    }
    // Cycle detection: walk up parent chain from `parentId`; if we encounter
    // `orgId`, attaching would create a cycle. Also enforce a depth cap.
    let cursor: OrgId | undefined = parentId;
    const visited = new Set<string>();
    let depth = 0;
    while (cursor) {
      if (cursor === orgId) {
        throw new IdentityError({
          code: "eks.identity.org.circular_hierarchy",
          category: "validation",
          message: `Setting ${orgId}'s parent to ${parentId} would create a cycle.`,
          userMessage: "This parent assignment would create a circular hierarchy.",
        });
      }
      if (visited.has(cursor as string)) break; // defensive: pre-existing cycle
      visited.add(cursor as string);
      depth++;
      if (depth > MAX_HIERARCHY_DEPTH) {
        throw new IdentityError({
          code: "eks.identity.org.hierarchy_too_deep",
          category: "validation",
          message: `Hierarchy exceeds max depth of ${MAX_HIERARCHY_DEPTH}.`,
        });
      }
      cursor = this.orgs.get(cursor)?.parentId;
    }
    const oldParent = org.parentId;
    if (oldParent) this.detachChild(oldParent, orgId);
    this.attachChild(parentId, orgId);
    const updated: Organization = { ...org, parentId, updatedAt: getClock().iso() };
    this.orgs.set(orgId, updated);
    this.recordAudit(orgId, "set_parent", undefined, { parentId: oldParent }, { parentId });
    return updated;
  }

  getHierarchy(orgId: OrgId): OrgNode {
    this.requireOrg(orgId);
    return this.buildNode(orgId, 0, new Set<string>());
  }

  private buildNode(orgId: OrgId, depth: number, visited: Set<string>): OrgNode {
    const org = this.orgs.get(orgId);
    if (!org) {
      throw new IdentityError({
        code: "eks.identity.org.not_found",
        category: "not_found",
        message: `Org ${orgId} not found.`,
      });
    }
    if (visited.has(orgId as string)) {
      // Defensive: cycle in stored data; stop descent
      return { org, children: [], depth };
    }
    visited.add(orgId as string);
    const childIds = this.childrenIndex.get(orgId) ?? [];
    return {
      org,
      depth,
      children: childIds.map((cid) => this.buildNode(cid, depth + 1, visited)),
    };
  }

  private attachChild(parentId: OrgId, childId: OrgId): void {
    const list = this.childrenIndex.get(parentId) ?? [];
    if (!list.includes(childId)) list.push(childId);
    this.childrenIndex.set(parentId, list);
  }

  private detachChild(parentId: OrgId, childId: OrgId): void {
    const list = this.childrenIndex.get(parentId);
    if (!list) return;
    const next = list.filter((id) => id !== childId);
    if (next.length === 0) this.childrenIndex.delete(parentId);
    else this.childrenIndex.set(parentId, next);
  }

  // --------------------------------------------------------------- delegation

  delegate(
    orgId: OrgId,
    delegateAccountId: AccountId,
    scope: DelegatedScopeKind,
    createdBy: AccountId,
    opts?: { permissions?: string[]; validUntil?: string },
  ): DelegatedScope {
    const org = this.requireOrg(orgId);
    this.requireActive(org);
    // Delegate must be an admin or owner of the org
    const membership = (this.memberships.get(delegateAccountId) ?? []).find((m) => m.orgId === orgId && m.active);
    if (!membership) {
      throw new IdentityError({
        code: "eks.identity.org.delegate_not_member",
        category: "permission_denied",
        message: `Delegate ${delegateAccountId} is not a member of org ${orgId}.`,
      });
    }
    if (membership.role !== "admin" && membership.role !== "owner") {
      throw new IdentityError({
        code: "eks.identity.org.delegate_insufficient_role",
        category: "permission_denied",
        message: `Delegate must be admin or owner (got ${membership.role}).`,
        userMessage: "Only admins or owners can receive delegated authority.",
      });
    }
    const delegation: DelegatedScope = {
      id: generateId("dlg_"),
      orgId,
      delegateAccountId,
      scope,
      permissions: opts?.permissions ?? [],
      validUntil: opts?.validUntil,
      createdAt: getClock().iso(),
      createdBy,
    };
    const list = this.delegations.get(orgId) ?? [];
    list.push(delegation);
    this.delegations.set(orgId, list);
    // Promote member role to "delegate" if not already an owner
    // (after the guard above, membership.role is "admin" or "owner").
    if (membership.role !== "owner") {
      const acctList = this.memberships.get(delegateAccountId) ?? [];
      const idx = acctList.findIndex((m) => m.orgId === orgId && m.active);
      if (idx >= 0) {
        acctList[idx] = { ...acctList[idx], role: "delegate" };
        this.memberships.set(delegateAccountId, acctList);
      }
    }
    this.recordAudit(orgId, "delegated", createdBy, undefined, { delegateAccountId, scope, permissions: delegation.permissions });
    void getEventBus().publish(
      buildEvent(ORG_EVENTS.delegated, { orgId, delegateAccountId, scope, delegationId: delegation.id }, {}, "domain"),
    );
    return delegation;
  }

  listDelegations(orgId: OrgId): DelegatedScope[] {
    this.requireOrg(orgId);
    return (this.delegations.get(orgId) ?? []).filter((d) => !d.revokedAt);
  }

  revokeDelegation(orgId: OrgId, delegationId: string, revokedBy?: AccountId): void {
    const list = this.delegations.get(orgId) ?? [];
    const idx = list.findIndex((d) => d.id === delegationId);
    if (idx < 0) {
      throw new IdentityError({
        code: "eks.identity.org.delegation_not_found",
        category: "not_found",
        message: `Delegation ${delegationId} not found in org ${orgId}.`,
      });
    }
    list[idx] = { ...list[idx], revokedAt: getClock().iso() };
    this.delegations.set(orgId, list);
    this.recordAudit(orgId, "delegation_revoked", revokedBy, undefined, { delegationId });
  }

  // --------------------------------------------------------------- lifecycle

  suspend(orgId: OrgId, reason?: string, suspendedBy?: AccountId): Organization {
    const org = this.requireOrg(orgId);
    if (org.status === "terminated") {
      throw new IdentityError({
        code: "eks.identity.org.terminated",
        category: "policy_violation",
        message: `Org ${orgId} is terminated and cannot be suspended.`,
      });
    }
    const now = getClock().iso();
    const updated: Organization = {
      ...org,
      status: "suspended",
      suspendedAt: now,
      suspendedReason: reason,
      updatedAt: now,
    };
    this.orgs.set(orgId, updated);
    this.recordAudit(orgId, "suspended", suspendedBy, { status: org.status }, { status: "suspended", reason });
    return updated;
  }

  reactivate(orgId: OrgId, reactivatedBy?: AccountId): Organization {
    const org = this.requireOrg(orgId);
    if (org.status === "terminated") {
      throw new IdentityError({
        code: "eks.identity.org.terminated",
        category: "policy_violation",
        message: `Org ${orgId} is terminated and cannot be reactivated.`,
      });
    }
    const now = getClock().iso();
    const updated: Organization = {
      ...org,
      status: "active",
      suspendedAt: undefined,
      suspendedReason: undefined,
      updatedAt: now,
    };
    this.orgs.set(orgId, updated);
    this.recordAudit(orgId, "reactivated", reactivatedBy, { status: org.status }, { status: "active" });
    return updated;
  }

  terminate(orgId: OrgId, terminatedBy?: AccountId, reason?: string): Organization {
    const org = this.requireOrg(orgId);
    const now = getClock().iso();
    const updated: Organization = {
      ...org,
      status: "terminated",
      terminatedAt: now,
      updatedAt: now,
      metadata: { ...(org.metadata ?? {}), terminationReason: reason },
    };
    this.orgs.set(orgId, updated);
    // Revoke all open invites
    for (const [hash, inv] of this.invites) {
      if (inv.orgId === orgId && !inv.consumed && !inv.revokedAt) {
        this.invites.set(hash, { ...inv, revokedAt: now });
      }
    }
    // Revoke all delegations
    const dels = this.delegations.get(orgId) ?? [];
    for (let i = 0; i < dels.length; i++) {
      if (!dels[i].revokedAt) dels[i] = { ...dels[i], revokedAt: now };
    }
    this.delegations.set(orgId, dels);
    this.recordAudit(orgId, "terminated", terminatedBy, { status: org.status }, { status: "terminated", reason });
    return updated;
  }

  // --------------------------------------------------------------- audit

  getAudit(orgId: OrgId): OrgAuditEntry[] {
    this.requireOrg(orgId);
    return [...(this.audit.get(orgId) ?? [])];
  }

  private recordAudit(
    orgId: OrgId,
    action: string,
    actor: AccountId | undefined,
    before?: Record<string, unknown>,
    after?: Record<string, unknown>,
  ): void {
    const list = this.audit.get(orgId) ?? [];
    const entry: OrgAuditEntry = {
      id: generateId("aud_"),
      orgId,
      action,
      actor,
      at: getClock().iso(),
      before,
      after,
    };
    list.push(entry);
    this.audit.set(orgId, list);
  }

  // --------------------------------------------------------------- internals

  private requireOrg(orgId: OrgId): Organization {
    const org = this.orgs.get(orgId);
    if (!org) {
      throw new IdentityError({
        code: "eks.identity.org.not_found",
        category: "not_found",
        message: `Organization ${orgId} not found.`,
        userMessage: "Organization not found.",
      });
    }
    return org;
  }

  private requireActive(org: Organization): void {
    if (org.status !== "active") {
      throw new IdentityError({
        code: "eks.identity.org.not_active",
        category: "policy_violation",
        message: `Org ${org.id} is ${org.status}, not active.`,
        userMessage: "This organization is not currently active.",
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _mgr: OrganizationManager | null = null;
export function getOrganizations(): OrganizationManager {
  if (!_mgr) _mgr = new OrganizationManager();
  return _mgr;
}
export function resetOrganizations(): void {
  _mgr = null;
}
