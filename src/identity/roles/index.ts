/**
 * Eks-Health Identity — Roles & Permissions (RBAC Catalog)
 *
 * The catalog of defined roles, permissions, and role-permission assignments.
 * This is the substrate the Authorization engine builds on — it answers
 * "what permissions does this account have?" via real union evaluation
 * with wildcard expansion and scope-aware inheritance (org → team).
 *
 * NOT the policy engine (see ../authorization) — this is the data + lookup.
 */

import "server-only";
import {
  type RoleId,
  type AccountId,
  type Persona,
  IdentityError,
  IDENTITY_EVENTS,
  asRoleId,
} from "../core";
import { getEventBus, buildEvent, generateId, getClock } from "@/kernel";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Permission = string;

export type PermissionCategory =
  | "identity"
  | "measurement"
  | "program"
  | "marketplace"
  | "org"
  | "platform"
  | "research"
  | "support"
  | "file"
  | "consent";

export type RoleScope = "account" | "org" | "team" | "program" | "global";

export interface PermissionDescriptor {
  readonly permission: Permission;
  readonly category: PermissionCategory;
  readonly label: string;
  readonly description: string;
  readonly sensitive: boolean;
}

export interface RoleDefinition {
  readonly id: RoleId;
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly scope: RoleScope;
  readonly permissions: Permission[];
  readonly sensitive: boolean;
  readonly systemRole: boolean;
}

export interface RoleAssignment {
  readonly id: string;
  readonly accountId: AccountId;
  readonly roleId: RoleId;
  readonly scope: RoleScope;
  readonly scopeId?: string;
  readonly assignedAt: string;
  readonly assignedBy?: string;
  readonly active: boolean;
  readonly revokedAt?: string;
  readonly revokeReason?: string;
  readonly expiresAt?: string;
}

export interface RoleAssignmentFilter {
  readonly accountId?: AccountId;
  readonly roleId?: RoleId;
  readonly scope?: RoleScope;
  readonly scopeId?: string;
  readonly activeOnly?: boolean;
}

export interface PermissionTarget {
  readonly scope: RoleScope;
  readonly scopeId?: string;
  readonly accountId?: AccountId;
}

export interface SimulationResult {
  readonly currentPermissions: Permission[];
  readonly simulatedPermissions: Permission[];
  readonly added: Permission[];
  readonly unchanged: Permission[];
}

export interface RoleCatalogEntry {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly scope: RoleScope;
  readonly permissions: Permission[];
  readonly sensitive: boolean;
  readonly systemRole: boolean;
}

// ---------------------------------------------------------------------------
// Permission catalog (35 permissions across 10 categories)
// ---------------------------------------------------------------------------

export const PERMISSIONS: readonly PermissionDescriptor[] = [
  // identity
  p("identity:account:read", "identity", "Read account", "View account profiles", false),
  p("identity:account:write", "identity", "Write account", "Modify account profiles", true),
  p("identity:account:delete", "identity", "Delete account", "Permanently delete accounts", true),
  p("identity:role:assign", "identity", "Assign roles", "Grant roles to accounts", true),
  p("identity:role:revoke", "identity", "Revoke roles", "Revoke role assignments", true),
  p("identity:session:revoke", "identity", "Revoke sessions", "Terminate user sessions", true),
  // measurement
  p("measurement:self:read", "measurement", "Read own measurements", "View your own health measurements", false),
  p("measurement:self:write", "measurement", "Write own measurements", "Record your own measurements", false),
  p("measurement:collect", "measurement", "Collect measurements", "Collect measurements on behalf of participants", true),
  p("measurement:participant:read", "measurement", "Read participant measurements", "View another participant's measurements", true),
  p("measurement:anonymized:read", "measurement", "Read anonymized measurements", "Access de-identified measurement datasets", true),
  // program
  p("program:install", "program", "Install programs", "Install health programs", false),
  p("program:uninstall", "program", "Uninstall programs", "Remove installed programs", false),
  p("program:configure", "program", "Configure programs", "Change program settings", true),
  p("program:develop", "program", "Develop programs", "Create and publish program definitions", false),
  // marketplace
  p("marketplace:publish", "marketplace", "Publish to marketplace", "List a program on the marketplace", false),
  p("marketplace:review", "marketplace", "Review listings", "Review marketplace submissions", true),
  p("marketplace:approve", "marketplace", "Approve listings", "Approve marketplace submissions", true),
  p("marketplace:reject", "marketplace", "Reject listings", "Reject marketplace submissions", true),
  // org
  p("org:manage", "org", "Manage organization", "Manage org settings", true),
  p("org:members:manage", "org", "Manage members", "Invite and remove org members", true),
  p("org:teams:manage", "org", "Manage teams", "Create and manage teams", true),
  p("org:billing:manage", "org", "Manage billing", "Manage org billing", true),
  p("org:audit:read", "org", "Read org audit", "View org audit trail", true),
  p("org:policy:manage", "org", "Manage org policy", "Configure org security policies", true),
  // platform
  p("platform:*", "platform", "Platform superuser", "Full platform access (all permissions)", true),
  p("platform:config:manage", "platform", "Manage platform config", "Configure platform-wide settings", true),
  p("platform:tenant:manage", "platform", "Manage tenants", "Provision and manage tenants", true),
  // research
  p("research:request", "research", "Request research data", "Submit research data access requests", true),
  p("research:dataset:read", "research", "Read datasets", "Access approved research datasets", true),
  p("research:cohort:manage", "research", "Manage cohorts", "Define and manage research cohorts", true),
  // support
  p("support:ticket:read", "support", "Read support tickets", "View support tickets", false),
  p("support:ticket:respond", "support", "Respond to tickets", "Reply to support tickets", false),
  // file
  p("file:read", "file", "Read files", "Read stored files", false),
  p("file:write", "file", "Write files", "Upload files", false),
  p("file:delete", "file", "Delete files", "Delete stored files", true),
  // consent
  p("consent:manage", "consent", "Manage consent", "Grant and revoke consent", false),
  p("consent:revoke", "consent", "Revoke consent", "Withdraw consent grants", false),
];

function p(permission: Permission, category: PermissionCategory, label: string, description: string, sensitive: boolean): PermissionDescriptor {
  return { permission, category, label, description, sensitive };
}

const PERMISSION_INDEX = new Map(PERMISSIONS.map((x) => [x.permission, x]));

// ---------------------------------------------------------------------------
// Role catalog (10 system roles)
// ---------------------------------------------------------------------------

export const ROLES: readonly RoleCatalogEntry[] = [
  role("platform_admin", "Platform Administrator", "Full platform access. Highest privilege.", "global", ["platform:*"], true),
  role("org_admin", "Organization Administrator", "Manages an organization, its members and policies.", "org", ["org:manage", "org:members:manage", "org:teams:manage", "org:billing:manage", "org:audit:read", "org:policy:manage"], true),
  role("developer", "Developer", "Builds Programs and extensions on the platform.", "account", ["program:develop", "program:install", "program:uninstall", "program:configure", "marketplace:publish", "file:read", "file:write"], false),
  role("researcher", "Researcher", "Requests access to de-identified data for approved studies.", "account", ["research:request", "research:dataset:read", "research:cohort:manage", "measurement:anonymized:read"], true),
  role("health_technician", "Health Technician", "Collects measurements on behalf of participants.", "account", ["measurement:collect", "measurement:participant:read", "support:ticket:respond"], true),
  role("support_agent", "Support Agent", "Assists users with account and access issues.", "account", ["support:ticket:read", "support:ticket:respond", "identity:account:read", "identity:session:revoke"], true),
  role("marketplace_reviewer", "Marketplace Reviewer", "Reviews and approves Program listings.", "account", ["marketplace:review", "marketplace:approve", "marketplace:reject", "program:install"], true),
  role("billing_admin", "Billing Administrator", "Manages org billing and subscriptions.", "org", ["org:billing:manage", "org:audit:read"], true),
  role("auditor", "Auditor", "Read-only access to audit trails.", "org", ["org:audit:read"], true),
  role("participant", "Participant", "An individual tracking their own preventive health.", "account", ["measurement:self:read", "measurement:self:write", "program:install", "program:uninstall", "consent:manage", "consent:revoke", "file:read", "file:write"], false),
];

function role(id: string, label: string, description: string, scope: RoleScope, permissions: Permission[], sensitive: boolean): RoleCatalogEntry {
  return { id, label, description, scope, permissions, sensitive, systemRole: true };
}

// ---------------------------------------------------------------------------
// Wildcard permission matching (REAL expansion)
// ---------------------------------------------------------------------------

export function permissionMatches(granted: Permission, requested: Permission): boolean {
  if (granted === "*") return true;
  if (granted === requested) return true;
  // namespace:* matches everything under namespace:
  if (granted.endsWith(":*")) {
    const prefix = granted.slice(0, -1); // "platform:"
    return requested.startsWith(prefix) || requested === granted.slice(0, -2);
  }
  return false;
}

export function permissionsInclude(granted: readonly Permission[], requested: Permission): boolean {
  return granted.some((g) => permissionMatches(g, requested));
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export const ROLE_EVENTS = {
  defined: "eks.identity.role.defined",
  assigned: "eks.identity.role.assigned",
  revoked: "eks.identity.role.revoked",
} as const;

// ---------------------------------------------------------------------------
// Role manager
// ---------------------------------------------------------------------------

interface DefineRoleInput {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly scope: RoleScope;
  readonly permissions: Permission[];
  readonly sensitive?: boolean;
}

interface AssignRoleInput {
  readonly scope: RoleScope;
  readonly scopeId?: string;
  readonly assignedBy?: string;
  readonly expiresAt?: string;
}

const MAX_HIERARCHY_DEPTH = 16;

export class RoleManager {
  private readonly roles = new Map<RoleId, RoleDefinition>();
  private readonly byName = new Map<string, RoleId>();
  private readonly assignments = new Map<string, RoleAssignment>();
  private readonly byAccount = new Map<AccountId, string[]>();
  private readonly teamOrg = new Map<string, string>(); // teamId -> orgId

  constructor() {
    // Auto-register all system roles
    for (const r of ROLES) {
      this.defineRole({
        name: r.id,
        label: r.label,
        description: r.description,
        scope: r.scope,
        permissions: r.permissions,
        sensitive: r.sensitive,
      });
    }
  }

  defineRole(input: DefineRoleInput): RoleDefinition {
    if (this.byName.has(input.name)) {
      throw new IdentityError({
        code: "eks.identity.role.duplicate_name",
        category: "conflict",
        message: `Role ${input.name} already defined.`,
        userMessage: "This role already exists.",
      });
    }
    // Validate permissions exist OR are wildcards
    for (const perm of input.permissions) {
      if (perm === "*" || perm.endsWith(":*")) continue;
      if (!PERMISSION_INDEX.has(perm)) {
        throw new IdentityError({
          code: "eks.identity.role.unknown_permission",
          category: "validation",
          message: `Unknown permission: ${perm}`,
          userMessage: `Unknown permission: ${perm}`,
        });
      }
    }
    const id = asRoleId(generateId("role_"));
    const def: RoleDefinition = {
      id,
      name: input.name,
      label: input.label,
      description: input.description,
      scope: input.scope,
      permissions: input.permissions,
      sensitive: input.sensitive ?? false,
      systemRole: false,
    };
    this.roles.set(id, def);
    this.byName.set(input.name, id);
    void getEventBus().publish(buildEvent(ROLE_EVENTS.defined, { roleId: id, name: input.name }, {}, "domain"));
    return def;
  }

  getRole(id: RoleId): RoleDefinition | undefined {
    return this.roles.get(id);
  }

  getRoleByName(name: string): RoleDefinition | undefined {
    const id = this.byName.get(name);
    return id ? this.roles.get(id) : undefined;
  }

  listRoles(): RoleDefinition[] {
    return [...this.roles.values()];
  }

  assignRole(accountId: AccountId, roleId: RoleId, opts: AssignRoleInput): RoleAssignment {
    const role = this.roles.get(roleId);
    if (!role) throw new IdentityError({ code: "eks.identity.role.not_found", category: "not_found", message: "Role not found." });
    // Validate scope/scopeId pairing
    if (opts.scope === "global" && opts.scopeId) {
      throw new IdentityError({ code: "eks.identity.role.invalid_scope", category: "validation", message: "Global scope takes no scopeId." });
    }
    if ((opts.scope === "org" || opts.scope === "team" || opts.scope === "program") && !opts.scopeId) {
      throw new IdentityError({ code: "eks.identity.role.invalid_scope", category: "validation", message: `${opts.scope} scope requires scopeId.` });
    }
    // Deduplicate: if an identical active assignment exists, return it
    const existing = (this.byAccount.get(accountId) ?? [])
      .map((id) => this.assignments.get(id)!)
      .filter((a) => a && a.roleId === roleId && a.scope === opts.scope && a.scopeId === opts.scopeId && a.active && !isExpired(a));
    if (existing.length > 0) return existing[0];

    const assignment: RoleAssignment = {
      id: generateId("asg_"),
      accountId,
      roleId,
      scope: opts.scope,
      scopeId: opts.scopeId,
      assignedAt: getClock().iso(),
      assignedBy: opts.assignedBy,
      active: true,
      expiresAt: opts.expiresAt,
    };
    this.assignments.set(assignment.id, assignment);
    const list = this.byAccount.get(accountId) ?? [];
    this.byAccount.set(accountId, [...list, assignment.id]);
    void getEventBus().publish(buildEvent(ROLE_EVENTS.assigned, { accountId, roleId, scope: opts.scope, scopeId: opts.scopeId }, {}, "domain"));
    void getEventBus().publish(buildEvent(IDENTITY_EVENTS.roleAssigned, { accountId, roleId: role.name }, {}, "domain"));
    return assignment;
  }

  revokeRole(assignmentId: string, revokedBy?: string, reason?: string): void {
    const a = this.assignments.get(assignmentId);
    if (!a) return;
    this.assignments.set(assignmentId, { ...a, active: false, revokedAt: getClock().iso(), revokeReason: reason });
    const role = this.roles.get(a.roleId);
    void getEventBus().publish(buildEvent(ROLE_EVENTS.revoked, { assignmentId, accountId: a.accountId, roleId: a.roleId }, {}, "domain"));
    void getEventBus().publish(buildEvent(IDENTITY_EVENTS.roleRevoked, { accountId: a.accountId, roleId: role?.name }, {}, "domain"));
  }

  listRolesFor(accountId: AccountId): RoleAssignment[] {
    return (this.byAccount.get(accountId) ?? [])
      .map((id) => this.assignments.get(id)!)
      .filter((a) => a && a.active && !isExpired(a));
  }

  listAssignments(filter?: RoleAssignmentFilter): RoleAssignment[] {
    let list = [...this.assignments.values()];
    if (filter) {
      if (filter.accountId) list = list.filter((a) => a.accountId === filter.accountId);
      if (filter.roleId) list = list.filter((a) => a.roleId === filter.roleId);
      if (filter.scope) list = list.filter((a) => a.scope === filter.scope);
      if (filter.scopeId) list = list.filter((a) => a.scopeId === filter.scopeId);
      if (filter.activeOnly) list = list.filter((a) => a.active && !isExpired(a));
    }
    return list;
  }

  /** Wired by the Organizations subsystem to enable org→team inheritance. */
  registerTeamOrg(teamId: string, orgId: string): void {
    this.teamOrg.set(teamId, orgId);
  }

  resolveTeamOrg(teamId: string): string | undefined {
    return this.teamOrg.get(teamId);
  }

  /** Union of all permissions from active, scope-matching roles. */
  getPermissions(accountId: AccountId, target?: PermissionTarget): Permission[] {
    const assignments = this.listRolesFor(accountId);
    const perms = new Set<Permission>();
    for (const a of assignments) {
      if (target && !this.scopeMatches(a, target)) continue;
      const role = this.roles.get(a.roleId);
      if (!role) continue;
      for (const p of role.permissions) perms.add(p);
    }
    return [...perms];
  }

  hasPermission(accountId: AccountId, permission: Permission, target?: PermissionTarget): boolean {
    return permissionsInclude(this.getPermissions(accountId, target), permission);
  }

  /** Permission simulation: what would change if a role were added? */
  simulate(accountId: AccountId, roleId: RoleId, target?: PermissionTarget): SimulationResult {
    const current = this.getPermissions(accountId, target);
    const role = this.roles.get(roleId);
    if (!role) {
      throw new IdentityError({ code: "eks.identity.role.not_found", category: "not_found", message: "Role not found." });
    }
    const simulatedSet = new Set(current);
    for (const p of role.permissions) simulatedSet.add(p);
    const simulated = [...simulatedSet];
    const added = simulated.filter((p) => !current.includes(p));
    const unchanged = current.filter((p) => simulated.includes(p));
    return { currentPermissions: current, simulatedPermissions: simulated, added, unchanged };
  }

  /** Scope matching with org→team inheritance. */
  private scopeMatches(a: RoleAssignment, target: PermissionTarget): boolean {
    // Global matches everything
    if (a.scope === "global") return true;
    // Account scope matches only same account
    if (a.scope === "account") return target.scope === "account" && target.accountId === a.accountId;
    if (a.scope === "org") {
      if (target.scope === "org") return target.scopeId === a.scopeId;
      // org implies team-in-same-org
      if (target.scope === "team") {
        const teamOrg = target.scopeId ? this.teamOrg.get(target.scopeId) : undefined;
        return teamOrg === a.scopeId;
      }
      return false;
    }
    if (a.scope === "team") return target.scope === "team" && target.scopeId === a.scopeId;
    if (a.scope === "program") return target.scope === "program" && target.scopeId === a.scopeId;
    return false;
  }
}

function isExpired(a: RoleAssignment): boolean {
  return a.expiresAt ? new Date(a.expiresAt).getTime() < Date.now() : false;
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _mgr: RoleManager | null = null;
export function getRoles(): RoleManager {
  if (!_mgr) _mgr = new RoleManager();
  return _mgr;
}
export function resetRoles(): void {
  _mgr = null;
}

export type { Persona };
