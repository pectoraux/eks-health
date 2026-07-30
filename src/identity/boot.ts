/**
 * Eks-Health Identity Platform — Boot Sequence
 *
 * Idempotently initializes the identity platform: touches every singleton,
 * wires org→team role inheritance, seeds demo data for the console, and
 * emits the platform_started identity event.
 */

import "server-only";
import { getEventBus, buildEvent, getClock, bootKernel } from "@/kernel";
import { getAccounts, PERSONAS } from "./accounts";
import { getAuth } from "./auth";
import { getSessions } from "./sessions";
import { getDevices } from "./devices";
import { getOrganizations } from "./organizations";
import { getRoles } from "./roles";
import { getAuthorization } from "./authorization";
import { getConsent } from "./consent";
import { getPrivacy } from "./privacy";
import { getDataGateway } from "./data-gateway";
import { getAudit } from "./audit";
import { getSecurityPolicies } from "./policies";
import { getMonitoring } from "./monitoring";
import { getCompliance } from "./compliance";
import { IDENTITY_EVENTS, asAccountId, type AccountId } from "./core";

export interface IdentityInfo {
  readonly name: string;
  readonly version: string;
  readonly bootedAt: string;
  readonly subsystems: string[];
}

let _booted = false;
let _info: IdentityInfo | null = null;

export function bootIdentity(): IdentityInfo {
  if (_booted && _info) return _info;
  // Kernel must boot first
  bootKernel();

  // Touch every singleton so defaults initialize
  getAccounts();
  getAuth();
  getSessions();
  getDevices();
  getOrganizations();
  getRoles();
  getAuthorization();
  getConsent();
  getPrivacy();
  getDataGateway();
  getAudit();
  getSecurityPolicies();
  getMonitoring();
  getCompliance();

  _booted = true;
  _info = {
    name: "Eks-Health Identity Platform",
    version: "2.0.0-m2",
    bootedAt: getClock().iso(),
    subsystems: [
      "core", "accounts", "auth", "sessions", "devices", "organizations",
      "roles", "authorization", "consent", "privacy", "data-gateway",
      "audit", "policies", "monitoring", "compliance",
    ],
  };

  void getEventBus().publish(
    buildEvent(IDENTITY_EVENTS.accountVerified, { version: _info.version }, {}, "system"),
  );
  return _info;
}

export function identityInfo(): IdentityInfo {
  if (!_info) {
    _info = {
      name: "Eks-Health Identity Platform",
      version: "2.0.0-m2",
      bootedAt: getClock().iso(),
      subsystems: [],
    };
  }
  return _info;
}

/** Compact diagnostic snapshot for the console. */
export function identitySnapshot() {
  ensureBooted();
  const accounts = getAccounts();
  const auth = getAuth();
  const sessions = getSessions();
  const devices = getDevices();
  const orgs = getOrganizations();
  const roles = getRoles();
  const authz = getAuthorization();
  const consent = getConsent();
  const privacy = getPrivacy();
  const gateway = getDataGateway();
  const audit = getAudit();
  const policies = getSecurityPolicies();
  const monitoring = getMonitoring();
  const compliance = getCompliance();
  return {
    info: identityInfo(),
    accounts: accounts.list().map((a) => ({
      id: a.id, email: a.email, displayName: a.displayName, state: a.state,
      personas: a.personas, activePersona: a.activePersona, mfaEnabled: a.mfaEnabled,
      verified: a.contacts.some((c) => c.verified), createdAt: a.createdAt,
    })),
    personas: PERSONAS,
    authProviders: auth.listProviders(),
    sessions: { stats: sessions.getStats(), recent: sessions.list().slice(-20) },
    devices: { count: devices.list().length, recent: devices.list().slice(-20) },
    organizations: orgs.list(),
    roles: roles.listRoles(),
    assignments: roles.listAssignments({ activeOnly: true }),
    permissions: { count: 0, catalog: [] },
    policies: { count: 0, list: [] },
    consent: { count: 0, active: [] },
    privacy: { retentionPolicies: [], residencyRules: [], requests: [] },
    gateway: { views: gateway.listViews() },
    audit: { count: audit.countByCategory(), chainValid: audit.verifyChain().valid, recent: [] },
    monitoring: { incidents: monitoring.listIncidents(), riskScores: [] },
    compliance: { frameworks: compliance.listFrameworks() },
  };
}

function ensureBooted() {
  if (!_booted) bootIdentity();
}

// ---------------------------------------------------------------------------
// Demo data seeding — for the platform console (NOT production users)
// ---------------------------------------------------------------------------

let _seeded = false;

export function seedIdentityDemoData(): { accounts: AccountId[]; orgId?: string } {
  if (_seeded) return { accounts: [] };
  ensureBooted();

  const accounts = getAccounts();
  const orgs = getOrganizations();
  const roles = getRoles();
  const accountIds: AccountId[] = [];

  // Demo accounts across personas
  const demoAccounts = [
    { email: "ama@eks.health", name: "Ama Serwaa", persona: "participant" as const, password: "DemoPass123!" },
    { email: "kwame@eks.health", name: "Kwame Mensah", persona: "developer" as const, password: "DemoPass123!" },
    { email: "clinic@eks.health", name: "Dr. Adwoa Boateng", persona: "health_technician" as const, password: "DemoPass123!" },
    { email: "research@eks.health", name: "Prof. Yaw Asante", persona: "researcher" as const, password: "DemoPass123!" },
    { email: "admin@eks.health", name: "Platform Admin", persona: "platform_admin" as const, password: "DemoPass123!" },
  ];

  for (const d of demoAccounts) {
    try {
      const existing = accounts.getByEmail(d.email);
      const acc = existing ?? accounts.register({
        email: d.email,
        password: d.password,
        displayName: d.name,
        persona: d.persona,
        locale: "en-GH",
        timezone: "Africa/Accra",
      });
      // Auto-verify demo accounts
      if (acc.state === "unverified") {
        const token = accounts.issueVerificationToken(acc.id, acc.email, "email");
        accounts.verifyToken(token);
      }
      accountIds.push(acc.id);
    } catch {
      // ignore duplicates on re-seed
    }
  }

  // Demo organization
  let orgId: string | undefined;
  try {
    const existingOrgs = orgs.list();
    if (existingOrgs.length === 0) {
      const org = orgs.create({
        name: "Accra Preventive Health Clinic",
        type: "clinic",
        createdBy: accountIds[2] ?? accountIds[0],
      });
      orgId = org.id;
      // Add the technician as org admin
      if (accountIds[2]) {
        orgs.addMember(org.id, accountIds[2], "admin");
      }
      // Create a team and wire org→team inheritance
      const team = orgs.createTeam(org.id, { name: "Field Technicians", createdBy: accountIds[2] });
      roles.registerTeamOrg(team.id, org.id);
    }
  } catch {
    // ignore
  }

  // Assign roles to demo accounts
  for (let i = 0; i < accountIds.length; i++) {
    const accId = accountIds[i];
    const persona = demoAccounts[i].persona;
    const role = roles.getRoleByName(persona);
    if (role) {
      try {
        roles.assignRole(accId, role.id, { scope: "account" });
      } catch {
        // already assigned
      }
    }
  }

  _seeded = true;
  return { accounts: accountIds, orgId };
}
