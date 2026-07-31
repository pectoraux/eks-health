/**
 * Eks-Health Social Platform — Invites
 *
 * Unified invite flow for friends, teams, and communities. Invites carry an
 * optional expiry; expired invites are filtered out of pending lists and can
 * be swept with `expireOld()`.
 */

import "server-only";
import {
  type InviteId,
  type AccountId,
  type TeamId,
  type CommunityId,
  type SocialInvite,
  type InviteType,
  type InviteStatus,
  SocialError,
  asInviteId,
} from "../core";
import { getEventBus, buildEvent, generateId, getClock } from "@/kernel";
import { SOCIAL_EVENTS } from "../core";

// ---------------------------------------------------------------------------
// Input shapes
// ---------------------------------------------------------------------------

export interface CreateInviteInput {
  readonly type: InviteType;
  readonly fromId: AccountId;
  readonly toId: AccountId;
  /** For team/community invites — the target team or community id. */
  readonly targetId?: string;
  readonly message?: string;
  /** Optional TTL in milliseconds. */
  readonly ttlMs?: number;
}

// ---------------------------------------------------------------------------
// Invite manager
// ---------------------------------------------------------------------------

export class InviteManager {
  private readonly invites = new Map<InviteId, SocialInvite>();
  private readonly byFrom = new Map<AccountId, InviteId[]>();
  private readonly byTo = new Map<AccountId, InviteId[]>();

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  create(input: CreateInviteInput): SocialInvite {
    if (input.fromId === input.toId) {
      throw new SocialError({
        code: "eks.social.invite.self_invite",
        category: "validation",
        message: "Cannot invite yourself.",
      });
    }
    if ((input.type === "team" || input.type === "community") && !input.targetId) {
      throw new SocialError({
        code: "eks.social.invite.missing_target",
        category: "validation",
        message: `Invites of type '${input.type}' require a targetId.`,
      });
    }
    const id = asInviteId(generateId("inv_"));
    const now = getClock().iso();
    const expiresAt = input.ttlMs
      ? new Date(Date.now() + input.ttlMs).toISOString()
      : undefined;
    const invite: SocialInvite = {
      id,
      type: input.type,
      fromId: input.fromId,
      toId: input.toId,
      targetId: input.targetId,
      message: input.message,
      status: "pending",
      createdAt: now,
      expiresAt,
    };
    this.invites.set(id, invite);
    link(this.byFrom, input.fromId, id);
    link(this.byTo, input.toId, id);
    void getEventBus().publish(
      buildEvent(
        SOCIAL_EVENTS.inviteCreated,
        { inviteId: id, type: input.type, fromId: input.fromId, toId: input.toId, targetId: input.targetId, expiresAt },
        {},
        "domain",
      ),
    );
    return invite;
  }

  accept(inviteId: InviteId): SocialInvite {
    const inv = this.invites.get(inviteId);
    if (!inv) {
      throw new SocialError({
        code: "eks.social.invite.not_found",
        category: "not_found",
        message: `Invite ${inviteId} not found.`,
      });
    }
    if (inv.status !== "pending") {
      throw new SocialError({
        code: "eks.social.invite.not_pending",
        category: "state_conflict",
        message: `Invite is in status '${inv.status}', cannot accept.`,
        userMessage: "This invite can no longer be accepted.",
      });
    }
    if (inv.expiresAt && new Date(inv.expiresAt).getTime() < Date.now()) {
      return this.expireOne(inviteId);
    }
    const updated: SocialInvite = { ...inv, status: "accepted" };
    this.invites.set(inviteId, updated);
    void getEventBus().publish(
      buildEvent(
        SOCIAL_EVENTS.inviteAccepted,
        { inviteId, type: inv.type, fromId: inv.fromId, toId: inv.toId, targetId: inv.targetId },
        {},
        "domain",
      ),
    );
    return updated;
  }

  decline(inviteId: InviteId): SocialInvite {
    const inv = this.invites.get(inviteId);
    if (!inv) {
      throw new SocialError({
        code: "eks.social.invite.not_found",
        category: "not_found",
        message: `Invite ${inviteId} not found.`,
      });
    }
    if (inv.status !== "pending") {
      throw new SocialError({
        code: "eks.social.invite.not_pending",
        category: "state_conflict",
        message: `Invite is in status '${inv.status}', cannot decline.`,
      });
    }
    const updated: SocialInvite = { ...inv, status: "declined" };
    this.invites.set(inviteId, updated);
    void getEventBus().publish(
      buildEvent(
        SOCIAL_EVENTS.inviteDeclined,
        { inviteId, type: inv.type, fromId: inv.fromId, toId: inv.toId },
        {},
        "domain",
      ),
    );
    return updated;
  }

  /** Sweep all expired pending invites, marking them as expired. */
  expireOld(now: number = Date.now()): number {
    let expired = 0;
    for (const [id, inv] of this.invites) {
      if (inv.status === "pending" && inv.expiresAt && new Date(inv.expiresAt).getTime() < now) {
        this.invites.set(id, { ...inv, status: "expired" });
        void getEventBus().publish(
          buildEvent(
            SOCIAL_EVENTS.inviteExpired,
            { inviteId: id, type: inv.type, fromId: inv.fromId, toId: inv.toId },
            {},
            "domain",
          ),
        );
        expired++;
      }
    }
    return expired;
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  getInvite(id: InviteId): SocialInvite | undefined {
    const inv = this.invites.get(id);
    if (!inv) return undefined;
    // Lazy expiration check
    if (inv.status === "pending" && inv.expiresAt && new Date(inv.expiresAt).getTime() < Date.now()) {
      const expired = { ...inv, status: "expired" as InviteStatus };
      this.invites.set(id, expired);
      return expired;
    }
    return inv;
  }

  listPending(accountId: AccountId, direction: "incoming" | "outgoing" = "incoming"): SocialInvite[] {
    const map = direction === "incoming" ? this.byTo : this.byFrom;
    const ids = map.get(accountId) ?? [];
    return ids
      .map((id) => this.getInvite(id)!)
      .filter((inv) => inv && inv.status === "pending");
  }

  listSent(fromId: AccountId): SocialInvite[] {
    const ids = this.byFrom.get(fromId) ?? [];
    return ids.map((id) => this.invites.get(id)!).filter(Boolean);
  }

  listReceived(toId: AccountId): SocialInvite[] {
    const ids = this.byTo.get(toId) ?? [];
    return ids.map((id) => this.invites.get(id)!).filter(Boolean);
  }

  // -------------------------------------------------------------------------
  // Stats
  // -------------------------------------------------------------------------

  getStats(): {
    totalInvites: number;
    pending: number;
    accepted: number;
    declined: number;
    expired: number;
    byType: Record<string, number>;
    acceptanceRate: number;
  } {
    const list = [...this.invites.values()];
    const byType: Record<string, number> = {};
    let pending = 0;
    let accepted = 0;
    let declined = 0;
    let expired = 0;
    for (const inv of list) {
      byType[inv.type] = (byType[inv.type] ?? 0) + 1;
      if (inv.status === "pending") pending++;
      else if (inv.status === "accepted") accepted++;
      else if (inv.status === "declined") declined++;
      else if (inv.status === "expired") expired++;
    }
    const resolved = accepted + declined;
    return {
      totalInvites: list.length,
      pending,
      accepted,
      declined,
      expired,
      byType,
      acceptanceRate: resolved ? accepted / resolved : 0,
    };
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private expireOne(inviteId: InviteId): SocialInvite {
    const inv = this.invites.get(inviteId)!;
    const updated: SocialInvite = { ...inv, status: "expired" };
    this.invites.set(inviteId, updated);
    void getEventBus().publish(
      buildEvent(
        SOCIAL_EVENTS.inviteExpired,
        { inviteId, type: inv.type, fromId: inv.fromId, toId: inv.toId },
        {},
        "domain",
      ),
    );
    return updated;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function link(map: Map<AccountId, InviteId[]>, id: AccountId, iid: InviteId): void {
  const list = map.get(id) ?? [];
  map.set(id, [...list, iid]);
}

// ---------------------------------------------------------------------------
// Convenience re-exports of branded types used by callers
// ---------------------------------------------------------------------------

// Re-export so callers can import { TeamId, CommunityId } from "@/social/invites"
// without reaching into core.
export { type TeamId, type CommunityId };

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _manager: InviteManager | null = null;
export function getInvites(): InviteManager {
  if (!_manager) _manager = new InviteManager();
  return _manager;
}
export function resetInvites(): void {
  _manager = null;
}
