/**
 * Eks-Health Identity Platform — Public API Barrel
 *
 * Import from `@/identity` (server-only). The identity platform builds on
 * the kernel and provides Zero-Trust identity, authorization, consent,
 * privacy, audit, and security monitoring.
 */

export * from "./core";
export * from "./accounts";
export * from "./auth";
export * from "./sessions";
// devices re-exports DeviceTrust which organizations also exports — re-export
// devices explicitly, then organizations as a namespace to avoid collision.
export * from "./devices";
export type {
  OrganizationType,
  Organization,
  OrgMembership,
  OrgInvitation,
  Team,
  Department,
  OrgNode,
  OrgRole,
  OrgStatus,
  DelegatedScope,
  DataClassification,
  CreateOrganizationInput,
  CreateTeamInput,
  CreateDepartmentInput,
  ListOrgsFilter,
  OrgTypeDescriptor,
  ORG_EVENTS,
} from "./organizations";
export { getOrganizations, resetOrganizations, ORG_TYPES } from "./organizations";
// roles & authorization both export `Permission` and `DeviceTrust`. roles
// (and devices) are canonical; re-export authorization explicitly minus the
// colliding names.
export * from "./roles";
export type {
  AuthorizationDecision,
  EvaluationContext,
  ConditionOperator,
  PolicyCondition,
  Policy,
  PermissionGrant,
  DelegationId,
  Delegation,
  AuthorizationResult,
  EvaluationLogEntry,
} from "./authorization";
export {
  asDelegationId,
  getAuthorization,
  setAuthorization,
  resetAuthorization,
  SENSITIVE_PERMISSIONS,
  POLICIES,
  AUTH_EVENTS,
} from "./authorization";
export * from "./consent";
export * from "./privacy";
export * from "./data-gateway";
export * from "./audit";
export * from "./policies";
export * from "./monitoring";
export * from "./compliance";

// Boot sequence
export { bootIdentity, identityInfo, identitySnapshot, seedIdentityDemoData } from "./boot";
