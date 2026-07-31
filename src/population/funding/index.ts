/**
 * Eks-Health Population Platform — Funding Engine
 *
 * Organizations create funding policies (pay measurement fees, sponsor
 * technician visits, increase prize pools, fund AI coaching, fund
 * subscriptions, reward milestones). Funding logic produces payment
 * requests; a separate Payment Provider executes them. This engine NEVER
 * processes payments — it validates eligibility, tracks budgets against
 * per-participant and per-policy limits, and emits domain events that the
 * Payment Provider listens for.
 *
 * Real budget tracking: committed amounts (pending + approved + executed)
 * are checked against maxAmountPerParticipant and maxAmountTotal on every
 * request. Executed amounts are tracked separately as "spent". No mocks.
 *
 * Built on the population core (types, errors, events) and membership
 * (participant validation).
 */

import "server-only";
import {
  type FundingPolicyId,
  type FundingRequestId,
  type PopulationOrgId,
  type AccountId,
  type FundingTargetType,
  type FundingRequestStatus,
  type FundingPolicy,
  type FundingRequest,
  PopulationError,
  POPULATION_EVENTS,
  asFundingPolicyId,
  asFundingRequestId,
} from "../core";
import { getMemberships } from "../membership";
import { getEventBus, buildEvent, generateId, getClock } from "@/kernel";

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

export interface CreateFundingPolicyInput {
  readonly orgId: PopulationOrgId;
  readonly name: string;
  readonly description: string;
  readonly targetType: FundingTargetType;
  readonly maxAmountPerParticipant: number;
  readonly maxAmountTotal: number;
  readonly currency?: string;
  readonly eligibilityCriteria?: string[];
  readonly active?: boolean;
}

export interface CreateFundingRequestInput {
  readonly policyId: FundingPolicyId;
  readonly participantId: AccountId;
  readonly targetType: FundingTargetType;
  readonly amount: number;
  readonly purpose: string;
  readonly metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Budget utilization
// ---------------------------------------------------------------------------

export interface BudgetCategoryUtilization {
  readonly category: FundingTargetType;
  readonly allocated: number;
  readonly committed: number;
  readonly spent: number;
  readonly remaining: number;
  readonly currency: string;
  readonly policyCount: number;
}

export interface BudgetUtilization {
  readonly orgId: PopulationOrgId;
  readonly totalAllocated: number;
  readonly totalCommitted: number;
  readonly totalSpent: number;
  readonly totalRemaining: number;
  readonly currency: string;
  readonly byCategory: BudgetCategoryUtilization[];
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

export interface FundingStats {
  readonly totalPolicies: number;
  readonly activePolicies: number;
  readonly totalRequests: number;
  readonly requestsByStatus: Record<FundingRequestStatus, number>;
  readonly totalFunded: number; // sum of executed amounts
  readonly currency: string;
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

/** Request statuses that count toward "committed" budget. */
const COMMITTED_STATUSES: ReadonlySet<FundingRequestStatus> = new Set([
  "pending",
  "approved",
  "executed",
]);

export class FundingEngine {
  private readonly policies = new Map<FundingPolicyId, FundingPolicy>();
  private readonly requests = new Map<FundingRequestId, FundingRequest>();
  private readonly policiesByOrg = new Map<PopulationOrgId, FundingPolicyId[]>();
  private readonly requestsByPolicy = new Map<FundingPolicyId, FundingRequestId[]>();
  private readonly requestsByOrg = new Map<PopulationOrgId, FundingRequestId[]>();

  // -------------------------------------------------------------------------
  // Policies
  // -------------------------------------------------------------------------

  createPolicy(input: CreateFundingPolicyInput): FundingPolicy {
    if (!input.name || !input.name.trim()) {
      throw new PopulationError({
        code: "eks.population.funding.policy.missing_name",
        category: "validation",
        message: "Policy name is required.",
        userMessage: "A funding policy name is required.",
      });
    }
    if (!input.orgId) {
      throw new PopulationError({
        code: "eks.population.funding.policy.missing_org",
        category: "validation",
        message: "Organization is required.",
      });
    }
    if (input.maxAmountPerParticipant <= 0) {
      throw new PopulationError({
        code: "eks.population.funding.policy.invalid_per_participant",
        category: "validation",
        message: "maxAmountPerParticipant must be > 0.",
        userMessage: "Per-participant limit must be greater than zero.",
      });
    }
    if (input.maxAmountTotal <= 0) {
      throw new PopulationError({
        code: "eks.population.funding.policy.invalid_total",
        category: "validation",
        message: "maxAmountTotal must be > 0.",
        userMessage: "Total budget must be greater than zero.",
      });
    }
    if (input.maxAmountPerParticipant > input.maxAmountTotal) {
      throw new PopulationError({
        code: "eks.population.funding.policy.per_exceeds_total",
        category: "validation",
        message: "maxAmountPerParticipant cannot exceed maxAmountTotal.",
        userMessage: "Per-participant limit cannot exceed total budget.",
      });
    }

    const now = getClock().iso();
    const policy: FundingPolicy = {
      id: asFundingPolicyId(generateId("fp_")),
      orgId: input.orgId,
      name: input.name.trim(),
      description: input.description,
      targetType: input.targetType,
      maxAmountPerParticipant: input.maxAmountPerParticipant,
      maxAmountTotal: input.maxAmountTotal,
      currency: input.currency ?? "USD",
      eligibilityCriteria: input.eligibilityCriteria ?? [],
      active: input.active ?? true,
      createdAt: now,
    };
    this.policies.set(policy.id, policy);
    const list = this.policiesByOrg.get(input.orgId) ?? [];
    this.policiesByOrg.set(input.orgId, [...list, policy.id]);

    void getEventBus().publish(
      buildEvent(
        POPULATION_EVENTS.fundingPolicyCreated,
        {
          policyId: policy.id,
          orgId: policy.orgId,
          targetType: policy.targetType,
          maxAmountTotal: policy.maxAmountTotal,
          currency: policy.currency,
        },
        {},
        "domain",
      ),
    );
    return policy;
  }

  getPolicy(id: FundingPolicyId): FundingPolicy | undefined {
    return this.policies.get(id);
  }

  listPolicies(orgId?: PopulationOrgId): FundingPolicy[] {
    if (orgId) {
      const ids = this.policiesByOrg.get(orgId) ?? [];
      return ids
        .map((id) => this.policies.get(id))
        .filter((p): p is FundingPolicy => !!p);
    }
    return [...this.policies.values()];
  }

  listActivePolicies(orgId: PopulationOrgId): FundingPolicy[] {
    return this.listPolicies(orgId).filter((p) => p.active);
  }

  /** Activate or deactivate a policy. */
  setPolicyActive(id: FundingPolicyId, active: boolean): FundingPolicy {
    const policy = this.policies.get(id);
    if (!policy) {
      throw new PopulationError({
        code: "eks.population.funding.policy.not_found",
        category: "not_found",
        message: "Funding policy not found.",
      });
    }
    const updated: FundingPolicy = { ...policy, active };
    this.policies.set(id, updated);
    return updated;
  }

  // -------------------------------------------------------------------------
  // Requests
  // -------------------------------------------------------------------------

  request(input: CreateFundingRequestInput): FundingRequest {
    const policy = this.policies.get(input.policyId);
    if (!policy) {
      throw new PopulationError({
        code: "eks.population.funding.policy.not_found",
        category: "not_found",
        message: "Funding policy not found.",
        userMessage: "The funding policy does not exist.",
      });
    }
    if (!policy.active) {
      throw new PopulationError({
        code: "eks.population.funding.policy.inactive",
        category: "state_conflict",
        message: "Funding policy is not active.",
        userMessage: "This funding policy is no longer active.",
      });
    }
    if (input.targetType !== policy.targetType) {
      throw new PopulationError({
        code: "eks.population.funding.target_mismatch",
        category: "validation",
        message: `Request targetType '${input.targetType}' does not match policy targetType '${policy.targetType}'.`,
        userMessage: "This funding request does not match the policy's purpose.",
      });
    }
    if (input.amount <= 0) {
      throw new PopulationError({
        code: "eks.population.funding.invalid_amount",
        category: "validation",
        message: "Amount must be > 0.",
        userMessage: "Funding amount must be greater than zero.",
      });
    }

    // Validate participant is an active org member.
    let isMember = false;
    try {
      const membership = getMemberships().findByOrgAndAccount(
        policy.orgId,
        input.participantId,
      );
      isMember = !!membership && membership.status === "active";
    } catch {
      // Membership subsystem unavailable — fail closed.
      isMember = false;
    }
    if (!isMember) {
      throw new PopulationError({
        code: "eks.population.funding.not_member",
        category: "not_authorized",
        message: "Participant is not an active member of the funding organization.",
        userMessage: "Only active organization members can request funding.",
      });
    }

    // Per-participant limit check.
    const perParticipantCommitted = this.committedForParticipant(
      policy.id,
      input.participantId,
    );
    if (perParticipantCommitted + input.amount > policy.maxAmountPerParticipant) {
      throw new PopulationError({
        code: "eks.population.funding.per_participant_exceeded",
        category: "quota_exceeded",
        message: `Per-participant limit exceeded: ${perParticipantCommitted + input.amount} > ${policy.maxAmountPerParticipant}.`,
        userMessage: "This participant has reached their funding limit under this policy.",
      });
    }

    // Per-policy total limit check.
    const policyCommitted = this.committedForPolicy(policy.id);
    if (policyCommitted + input.amount > policy.maxAmountTotal) {
      throw new PopulationError({
        code: "eks.population.funding.total_exceeded",
        category: "funding_exhausted",
        message: `Policy total budget exceeded: ${policyCommitted + input.amount} > ${policy.maxAmountTotal}.`,
        userMessage: "This funding policy has exhausted its total budget.",
      });
    }

    const now = getClock().iso();
    const req: FundingRequest = {
      id: asFundingRequestId(generateId("fr_")),
      policyId: policy.id,
      orgId: policy.orgId,
      participantId: input.participantId,
      targetType: input.targetType,
      amount: input.amount,
      currency: policy.currency,
      status: "pending",
      purpose: input.purpose,
      createdAt: now,
      metadata: input.metadata,
    };
    this.requests.set(req.id, req);
    const byPolicy = this.requestsByPolicy.get(policy.id) ?? [];
    this.requestsByPolicy.set(policy.id, [...byPolicy, req.id]);
    const byOrg = this.requestsByOrg.get(policy.orgId) ?? [];
    this.requestsByOrg.set(policy.orgId, [...byOrg, req.id]);

    // Emits funding.requested — the Payment Provider listens for this event.
    // The Funding Engine itself does NOT process payment.
    void getEventBus().publish(
      buildEvent(
        POPULATION_EVENTS.fundingRequested,
        {
          requestId: req.id,
          policyId: policy.id,
          orgId: policy.orgId,
          participantId: input.participantId,
          amount: req.amount,
          currency: req.currency,
          targetType: req.targetType,
          purpose: req.purpose,
        },
        {},
        "domain",
      ),
    );
    return req;
  }

  approve(requestId: FundingRequestId, approvedBy: AccountId): FundingRequest {
    const req = this.requests.get(requestId);
    if (!req) {
      throw new PopulationError({
        code: "eks.population.funding.request.not_found",
        category: "not_found",
        message: "Funding request not found.",
      });
    }
    if (req.status !== "pending") {
      throw new PopulationError({
        code: "eks.population.funding.request.not_pending",
        category: "state_conflict",
        message: `Request is in status '${req.status}', cannot approve.`,
        userMessage: "Only pending requests can be approved.",
      });
    }
    const updated: FundingRequest = {
      ...req,
      status: "approved",
      approvedAt: getClock().iso(),
      approvedBy,
    };
    this.requests.set(requestId, updated);
    void getEventBus().publish(
      buildEvent(
        POPULATION_EVENTS.fundingApproved,
        {
          requestId,
          policyId: req.policyId,
          orgId: req.orgId,
          participantId: req.participantId,
          amount: req.amount,
          approvedBy,
        },
        {},
        "domain",
      ),
    );
    return updated;
  }

  execute(requestId: FundingRequestId): FundingRequest {
    const req = this.requests.get(requestId);
    if (!req) {
      throw new PopulationError({
        code: "eks.population.funding.request.not_found",
        category: "not_found",
        message: "Funding request not found.",
      });
    }
    if (req.status !== "approved") {
      throw new PopulationError({
        code: "eks.population.funding.request.not_approved",
        category: "state_conflict",
        message: `Request is in status '${req.status}', cannot execute.`,
        userMessage: "Only approved requests can be executed.",
      });
    }
    const now = getClock().iso();
    const updated: FundingRequest = {
      ...req,
      status: "executed",
      executedAt: now,
    };
    this.requests.set(requestId, updated);
    void getEventBus().publish(
      buildEvent(
        POPULATION_EVENTS.fundingExecuted,
        {
          requestId,
          policyId: req.policyId,
          orgId: req.orgId,
          participantId: req.participantId,
          amount: req.amount,
          executedAt: now,
        },
        {},
        "domain",
      ),
    );
    return updated;
  }

  reject(
    requestId: FundingRequestId,
    by: AccountId,
    reason?: string,
  ): FundingRequest {
    const req = this.requests.get(requestId);
    if (!req) {
      throw new PopulationError({
        code: "eks.population.funding.request.not_found",
        category: "not_found",
        message: "Funding request not found.",
      });
    }
    if (req.status !== "pending" && req.status !== "approved") {
      throw new PopulationError({
        code: "eks.population.funding.request.cannot_reject",
        category: "state_conflict",
        message: `Request is in status '${req.status}', cannot reject.`,
        userMessage: "This request can no longer be rejected.",
      });
    }
    const updated: FundingRequest = {
      ...req,
      status: "rejected",
      metadata: {
        ...(req.metadata ?? {}),
        rejectedBy: by,
        rejectedReason: reason,
        rejectedAt: getClock().iso(),
      },
    };
    this.requests.set(requestId, updated);
    return updated;
  }

  cancel(requestId: FundingRequestId, reason?: string): FundingRequest {
    const req = this.requests.get(requestId);
    if (!req) {
      throw new PopulationError({
        code: "eks.population.funding.request.not_found",
        category: "not_found",
        message: "Funding request not found.",
      });
    }
    if (req.status === "executed" || req.status === "cancelled") {
      throw new PopulationError({
        code: "eks.population.funding.request.cannot_cancel",
        category: "state_conflict",
        message: `Request is in status '${req.status}', cannot cancel.`,
        userMessage: "This request can no longer be cancelled.",
      });
    }
    const updated: FundingRequest = {
      ...req,
      status: "cancelled",
      metadata: {
        ...(req.metadata ?? {}),
        cancelledReason: reason,
        cancelledAt: getClock().iso(),
      },
    };
    this.requests.set(requestId, updated);
    return updated;
  }

  getRequest(requestId: FundingRequestId): FundingRequest | undefined {
    return this.requests.get(requestId);
  }

  listRequests(filter?: {
    policyId?: FundingPolicyId;
    orgId?: PopulationOrgId;
    participantId?: AccountId;
    status?: FundingRequestStatus;
  }): FundingRequest[] {
    let list = [...this.requests.values()];
    if (filter?.policyId) list = list.filter((r) => r.policyId === filter.policyId);
    if (filter?.orgId) list = list.filter((r) => r.orgId === filter.orgId);
    if (filter?.participantId) {
      list = list.filter((r) => r.participantId === filter.participantId);
    }
    if (filter?.status) list = list.filter((r) => r.status === filter.status);
    return list;
  }

  // -------------------------------------------------------------------------
  // Budget tracking
  // -------------------------------------------------------------------------

  getBudgetUtilization(orgId: PopulationOrgId): BudgetUtilization {
    const policies = this.listActivePolicies(orgId);
    const byCategoryMap = new Map<FundingTargetType, BudgetCategoryUtilization>();
    let totalAllocated = 0;
    let totalCommitted = 0;
    let totalSpent = 0;
    let currency = "USD";

    for (const p of policies) {
      currency = p.currency;
      const committed = this.committedForPolicy(p.id);
      const spent = this.executedForPolicy(p.id);
      const allocated = p.maxAmountTotal;
      const remaining = Math.max(0, allocated - committed);
      totalAllocated += allocated;
      totalCommitted += committed;
      totalSpent += spent;

      const existing = byCategoryMap.get(p.targetType);
      if (existing) {
        byCategoryMap.set(p.targetType, {
          category: p.targetType,
          allocated: existing.allocated + allocated,
          committed: existing.committed + committed,
          spent: existing.spent + spent,
          remaining: existing.remaining + remaining,
          currency: p.currency,
          policyCount: existing.policyCount + 1,
        });
      } else {
        byCategoryMap.set(p.targetType, {
          category: p.targetType,
          allocated,
          committed,
          spent,
          remaining,
          currency: p.currency,
          policyCount: 1,
        });
      }
    }

    return {
      orgId,
      totalAllocated,
      totalCommitted,
      totalSpent,
      totalRemaining: Math.max(0, totalAllocated - totalCommitted),
      currency,
      byCategory: [...byCategoryMap.values()],
    };
  }

  getStats(orgId?: PopulationOrgId): FundingStats {
    const policies = this.listPolicies(orgId);
    const requests = this.listRequests({ orgId });
    const byStatus: Record<FundingRequestStatus, number> = {
      pending: 0,
      approved: 0,
      rejected: 0,
      executed: 0,
      cancelled: 0,
    };
    let totalFunded = 0;
    let currency = "USD";
    for (const r of requests) {
      byStatus[r.status]++;
      if (r.status === "executed") totalFunded += r.amount;
      currency = r.currency;
    }
    if (policies.length > 0) currency = policies[0].currency;
    return {
      totalPolicies: policies.length,
      activePolicies: policies.filter((p) => p.active).length,
      totalRequests: requests.length,
      requestsByStatus: byStatus,
      totalFunded,
      currency,
    };
  }

  // -------------------------------------------------------------------------
  // Internal: budget computation (recomputed from the request store so the
  // numbers are always consistent with the source of truth).
  // -------------------------------------------------------------------------

  private committedForPolicy(policyId: FundingPolicyId): number {
    const ids = this.requestsByPolicy.get(policyId) ?? [];
    let sum = 0;
    for (const id of ids) {
      const r = this.requests.get(id);
      if (r && COMMITTED_STATUSES.has(r.status)) sum += r.amount;
    }
    return sum;
  }

  private executedForPolicy(policyId: FundingPolicyId): number {
    const ids = this.requestsByPolicy.get(policyId) ?? [];
    let sum = 0;
    for (const id of ids) {
      const r = this.requests.get(id);
      if (r && r.status === "executed") sum += r.amount;
    }
    return sum;
  }

  private committedForParticipant(
    policyId: FundingPolicyId,
    participantId: AccountId,
  ): number {
    const ids = this.requestsByPolicy.get(policyId) ?? [];
    let sum = 0;
    for (const id of ids) {
      const r = this.requests.get(id);
      if (
        r &&
        r.participantId === participantId &&
        COMMITTED_STATUSES.has(r.status)
      ) {
        sum += r.amount;
      }
    }
    return sum;
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _engine: FundingEngine | null = null;
export function getFunding(): FundingEngine {
  if (!_engine) _engine = new FundingEngine();
  return _engine;
}

// ---------------------------------------------------------------------------
// Barrel re-exports
// ---------------------------------------------------------------------------

export type {
  FundingPolicy,
  FundingRequest,
  FundingPolicyId,
  FundingRequestId,
  FundingTargetType,
  FundingRequestStatus,
} from "../core";
