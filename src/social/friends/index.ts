/**
 * Eks-Health Social Platform — Friends
 *
 * Friend requests, accept/decline, blocking, mutual-friend computation, and
 * friendship stats. Friendships are bidirectional: a request from A to B and
 * its acceptance creates a single accepted edge that both sides can traverse.
 */

import "server-only";
import {
  type FriendshipId,
  type AccountId,
  type Friendship,
  type FriendshipStatus,
  SocialError,
  asFriendshipId,
} from "../core";
import { getEventBus, buildEvent, generateId, getClock } from "@/kernel";
import { SOCIAL_EVENTS } from "../core";

// ---------------------------------------------------------------------------
// Friend manager
// ---------------------------------------------------------------------------

export class FriendManager {
  private readonly friendships = new Map<FriendshipId, Friendship>();
  /** Outbound edges: participantId → FriendshipId[] they initiated. */
  private readonly outgoing = new Map<AccountId, FriendshipId[]>();
  /** Inbound edges: friendId → FriendshipId[] targeting them. */
  private readonly incoming = new Map<AccountId, FriendshipId[]>();
  /** (a,b) → FriendshipId index for fast areFriends / lookup. */
  private readonly pairIndex = new Map<string, FriendshipId>();

  // -------------------------------------------------------------------------
  // Requests
  // -------------------------------------------------------------------------

  sendRequest(fromId: AccountId, toId: AccountId, message?: string): Friendship {
    if (fromId === toId) {
      throw new SocialError({
        code: "eks.social.friend.self_request",
        category: "validation",
        message: "Cannot send a friend request to yourself.",
        userMessage: "You cannot befriend yourself.",
      });
    }
    const key = pairKey(fromId, toId);
    const existing = this.pairIndex.get(key);
    if (existing) {
      const f = this.friendships.get(existing)!;
      if (f.status === "accepted") {
        throw new SocialError({
          code: "eks.social.friend.already_friends",
          category: "state_conflict",
          message: "These accounts are already friends.",
          userMessage: "You are already friends.",
          metadata: { friendshipId: f.id },
        });
      }
      if (f.status === "pending") {
        throw new SocialError({
          code: "eks.social.friend.request_pending",
          category: "state_conflict",
          message: "A pending request already exists between these accounts.",
          userMessage: "A friend request is already pending.",
          metadata: { friendshipId: f.id },
        });
      }
      if (f.status === "blocked") {
        throw new SocialError({
          code: "eks.social.friend.blocked",
          category: "state_conflict",
          message: "Cannot send request — one party has blocked the other.",
          userMessage: "This connection is blocked.",
        });
      }
    }

    const id = asFriendshipId(generateId("fr_"));
    const now = getClock().iso();
    const friendship: Friendship = {
      id,
      participantId: fromId,
      friendId: toId,
      status: "pending",
      requestedAt: now,
    };
    this.friendships.set(id, friendship);
    this.pairIndex.set(key, id);
    link(this.outgoing, fromId, id);
    link(this.incoming, toId, id);
    void getEventBus().publish(
      buildEvent(
        SOCIAL_EVENTS.friendRequestSent,
        { friendshipId: id, fromId, toId, message },
        {},
        "domain",
      ),
    );
    return friendship;
  }

  acceptRequest(friendshipId: FriendshipId): Friendship {
    const f = this.friendships.get(friendshipId);
    if (!f) {
      throw new SocialError({
        code: "eks.social.friend.not_found",
        category: "not_found",
        message: `Friendship ${friendshipId} not found.`,
      });
    }
    if (f.status !== "pending") {
      throw new SocialError({
        code: "eks.social.friend.not_pending",
        category: "state_conflict",
        message: `Friendship is in status '${f.status}', cannot accept.`,
        userMessage: "This request can no longer be accepted.",
      });
    }
    const now = getClock().iso();
    const updated: Friendship = { ...f, status: "accepted", acceptedAt: now };
    this.friendships.set(friendshipId, updated);
    void getEventBus().publish(
      buildEvent(
        SOCIAL_EVENTS.friendRequestAccepted,
        { friendshipId, fromId: f.participantId, toId: f.friendId, acceptedAt: now },
        {},
        "domain",
      ),
    );
    return updated;
  }

  declineRequest(friendshipId: FriendshipId): Friendship {
    const f = this.friendships.get(friendshipId);
    if (!f) {
      throw new SocialError({
        code: "eks.social.friend.not_found",
        category: "not_found",
        message: `Friendship ${friendshipId} not found.`,
      });
    }
    if (f.status !== "pending") {
      throw new SocialError({
        code: "eks.social.friend.not_pending",
        category: "state_conflict",
        message: `Friendship is in status '${f.status}', cannot decline.`,
      });
    }
    // Decline = remove the pending request entirely.
    this.friendships.delete(friendshipId);
    unlink(this.outgoing, f.participantId, friendshipId);
    unlink(this.incoming, f.friendId, friendshipId);
    this.pairIndex.delete(pairKey(f.participantId, f.friendId));
    void getEventBus().publish(
      buildEvent(
        SOCIAL_EVENTS.friendRequestDeclined,
        { friendshipId, fromId: f.participantId, toId: f.friendId },
        {},
        "domain",
      ),
    );
    return f;
  }

  // -------------------------------------------------------------------------
  // Blocking
  // -------------------------------------------------------------------------

  block(blockerId: AccountId, blockedId: AccountId): Friendship {
    if (blockerId === blockedId) {
      throw new SocialError({
        code: "eks.social.friend.self_block",
        category: "validation",
        message: "Cannot block yourself.",
      });
    }
    const key = pairKey(blockerId, blockedId);
    const existing = this.pairIndex.get(key);
    const now = getClock().iso();
    if (existing) {
      const f = this.friendships.get(existing)!;
      const updated: Friendship = { ...f, status: "blocked", acceptedAt: undefined };
      this.friendships.set(existing, updated);
      void getEventBus().publish(
        buildEvent(
          SOCIAL_EVENTS.friendBlocked,
          { friendshipId: existing, blockerId, blockedId },
          {},
          "domain",
        ),
      );
      return updated;
    }
    const id = asFriendshipId(generateId("fr_"));
    const friendship: Friendship = {
      id,
      participantId: blockerId,
      friendId: blockedId,
      status: "blocked",
      requestedAt: now,
    };
    this.friendships.set(id, friendship);
    this.pairIndex.set(key, id);
    link(this.outgoing, blockerId, id);
    link(this.incoming, blockedId, id);
    void getEventBus().publish(
      buildEvent(
        SOCIAL_EVENTS.friendBlocked,
        { friendshipId: id, blockerId, blockedId },
        {},
        "domain",
      ),
    );
    return friendship;
  }

  unblock(blockerId: AccountId, blockedId: AccountId): void {
    const key = pairKey(blockerId, blockedId);
    const id = this.pairIndex.get(key);
    if (!id) return;
    const f = this.friendships.get(id);
    if (!f || f.status !== "blocked") return;
    this.friendships.delete(id);
    unlink(this.outgoing, blockerId, id);
    unlink(this.incoming, blockedId, id);
    this.pairIndex.delete(key);
    void getEventBus().publish(
      buildEvent(
        SOCIAL_EVENTS.friendUnblocked,
        { friendshipId: id, blockerId, blockedId },
        {},
        "domain",
      ),
    );
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  listFriends(participantId: AccountId): Friendship[] {
    const out: Friendship[] = [];
    const seen = new Set<FriendshipId>();
    for (const id of this.outgoing.get(participantId) ?? []) {
      const f = this.friendships.get(id);
      if (f && f.status === "accepted") {
        out.push(f);
        seen.add(id);
      }
    }
    for (const id of this.incoming.get(participantId) ?? []) {
      if (seen.has(id)) continue;
      const f = this.friendships.get(id);
      if (f && f.status === "accepted") out.push(f);
    }
    return out;
  }

  listPending(participantId: AccountId, direction: "incoming" | "outgoing" | "both" = "both"): Friendship[] {
    const out: Friendship[] = [];
    const seen = new Set<FriendshipId>();
    const collect = (ids: FriendshipId[]): void => {
      for (const id of ids) {
        if (seen.has(id)) continue;
        const f = this.friendships.get(id);
        if (f && f.status === "pending") {
          out.push(f);
          seen.add(id);
        }
      }
    };
    if (direction === "incoming" || direction === "both") collect(this.incoming.get(participantId) ?? []);
    if (direction === "outgoing" || direction === "both") collect(this.outgoing.get(participantId) ?? []);
    return out;
  }

  listBlocked(participantId: AccountId): Friendship[] {
    const out: Friendship[] = [];
    for (const id of this.outgoing.get(participantId) ?? []) {
      const f = this.friendships.get(id);
      if (f && f.status === "blocked") out.push(f);
    }
    return out;
  }

  areFriends(a: AccountId, b: AccountId): boolean {
    const id = this.pairIndex.get(pairKey(a, b));
    if (!id) return false;
    const f = this.friendships.get(id);
    return Boolean(f && f.status === "accepted");
  }

  getMutualFriends(a: AccountId, b: AccountId): AccountId[] {
    const friendsOfA = new Set(
      this.listFriends(a).map((f) => (f.participantId === a ? f.friendId : f.participantId)),
    );
    const friendsOfB = this.listFriends(b).map((f) => (f.participantId === b ? f.friendId : f.participantId));
    const mutual: AccountId[] = [];
    const seen = new Set<AccountId>();
    for (const id of friendsOfB) {
      if (friendsOfA.has(id) && !seen.has(id)) {
        mutual.push(id);
        seen.add(id);
      }
    }
    return mutual;
  }

  getFriendship(id: FriendshipId): Friendship | undefined {
    return this.friendships.get(id);
  }

  getFriendshipBetween(a: AccountId, b: AccountId): Friendship | undefined {
    const id = this.pairIndex.get(pairKey(a, b));
    return id ? this.friendships.get(id) : undefined;
  }

  // -------------------------------------------------------------------------
  // Stats
  // -------------------------------------------------------------------------

  getStats(): {
    totalFriendships: number;
    accepted: number;
    pending: number;
    blocked: number;
    totalParticipants: number;
    avgFriendsPerParticipant: number;
  } {
    let accepted = 0;
    let pending = 0;
    let blocked = 0;
    const participants = new Set<AccountId>();
    for (const f of this.friendships.values()) {
      if (f.status === "accepted") accepted++;
      else if (f.status === "pending") pending++;
      else if (f.status === "blocked") blocked++;
      participants.add(f.participantId);
      participants.add(f.friendId);
    }
    return {
      totalFriendships: this.friendships.size,
      accepted,
      pending,
      blocked,
      totalParticipants: participants.size,
      avgFriendsPerParticipant: participants.size ? (accepted * 2) / participants.size : 0,
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pairKey(a: AccountId, b: AccountId): string {
  // Symmetric key so (a,b) and (b,a) resolve to the same record.
  return a < b ? `${a}::${b}` : `${b}::${a}`;
}

function link(map: Map<AccountId, FriendshipId[]>, id: AccountId, fid: FriendshipId): void {
  const list = map.get(id) ?? [];
  map.set(id, [...list, fid]);
}

function unlink(map: Map<AccountId, FriendshipId[]>, id: AccountId, fid: FriendshipId): void {
  const list = map.get(id);
  if (!list) return;
  map.set(id, list.filter((x) => x !== fid));
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _manager: FriendManager | null = null;
export function getFriends(): FriendManager {
  if (!_manager) _manager = new FriendManager();
  return _manager;
}
export function resetFriends(): void {
  _manager = null;
}

// Re-export for callers that want to enumerate statuses
export { type FriendshipStatus };
