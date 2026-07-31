/**
 * Eks-Health Social Platform — Communities
 *
 * Communities are larger, topically-grouped spaces (public, private, or
 * invite-only). Anyone can join a public community; private communities
 * require owner approval; invite-only communities require an invite.
 *
 * Pre-registers five canonical communities spanning weight loss, heart health,
 * sleep, mental wellness, and fitness.
 */

import "server-only";
import {
  type CommunityId,
  type AccountId,
  type Community,
  type CommunityType,
  SocialError,
  asCommunityId,
} from "../core";
import { getEventBus, buildEvent, generateId, getClock } from "@/kernel";
import { SOCIAL_EVENTS } from "../core";

// ---------------------------------------------------------------------------
// Input shapes
// ---------------------------------------------------------------------------

export interface CreateCommunityInput {
  readonly name: string;
  readonly description: string;
  readonly type: CommunityType;
  readonly ownerId: AccountId;
  readonly tags?: string[];
  readonly slug: string;
}

// ---------------------------------------------------------------------------
// Community manager
// ---------------------------------------------------------------------------

export class CommunityManager {
  private readonly communities = new Map<CommunityId, Community>();
  private readonly bySlug = new Map<string, CommunityId>();
  private readonly byOwner = new Map<AccountId, CommunityId[]>();
  /** Member roster per community. */
  private readonly members = new Map<CommunityId, Set<AccountId>>();
  /** Reverse index: which communities an account belongs to. */
  private readonly byMember = new Map<AccountId, CommunityId[]>();
  private readonly defaultsRegistered = false;

  constructor() {
    this.registerDefaults();
  }

  // -------------------------------------------------------------------------
  // CRUD
  // -------------------------------------------------------------------------

  create(input: CreateCommunityInput): Community {
    if (!input.name.trim()) {
      throw new SocialError({
        code: "eks.social.community.empty_name",
        category: "validation",
        message: "Community name cannot be empty.",
      });
    }
    if (this.bySlug.has(input.slug)) {
      throw new SocialError({
        code: "eks.social.community.duplicate_slug",
        category: "duplicate",
        message: `Community slug '${input.slug}' already exists.`,
        userMessage: "A community with this slug already exists.",
      });
    }
    const id = asCommunityId(generateId("cm_"));
    const now = getClock().iso();
    const community: Community = {
      id,
      name: input.name,
      description: input.description,
      type: input.type,
      memberCount: 1,
      ownerId: input.ownerId,
      tags: input.tags ?? [],
      createdAt: now,
    };
    this.communities.set(id, community);
    this.bySlug.set(input.slug, id);
    this.members.set(id, new Set<AccountId>([input.ownerId]));
    link(this.byOwner, input.ownerId, id);
    link(this.byMember, input.ownerId, id);
    void getEventBus().publish(
      buildEvent(
        SOCIAL_EVENTS.communityCreated,
        { communityId: id, slug: input.slug, name: input.name, type: input.type, ownerId: input.ownerId },
        {},
        "domain",
      ),
    );
    return community;
  }

  getCommunity(id: CommunityId): Community | undefined {
    return this.communities.get(id);
  }

  getCommunityBySlug(slug: string): Community | undefined {
    const id = this.bySlug.get(slug);
    return id ? this.communities.get(id) : undefined;
  }

  listCommunities(filter?: { ownerId?: AccountId; memberId?: AccountId; type?: CommunityType; tag?: string }): Community[] {
    if (filter?.ownerId) {
      return (this.byOwner.get(filter.ownerId) ?? []).map((id) => this.communities.get(id)!).filter(Boolean);
    }
    let list = [...this.communities.values()];
    if (filter?.type) list = list.filter((c) => c.type === filter.type);
    if (filter?.tag) list = list.filter((c) => c.tags.includes(filter.tag!));
    if (filter?.memberId) {
      const memberOf = new Set(this.byMember.get(filter.memberId) ?? []);
      list = list.filter((c) => memberOf.has(c.id));
    }
    return list;
  }

  search(query: string, opts?: { limit?: number; includePrivate?: boolean }): Community[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    let list = [...this.communities.values()];
    if (!opts?.includePrivate) list = list.filter((c) => c.type === "public");
    const scored = list
      .map((c) => {
        const name = c.name.toLowerCase();
        const desc = c.description.toLowerCase();
        let score = 0;
        if (name === q) score += 100;
        else if (name.includes(q)) score += 50;
        if (desc.includes(q)) score += 20;
        if (c.tags.some((t) => t.toLowerCase().includes(q))) score += 30;
        return { c, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);
    const limit = opts?.limit ?? 25;
    return scored.slice(0, limit).map((x) => x.c);
  }

  // -------------------------------------------------------------------------
  // Membership
  // -------------------------------------------------------------------------

  join(communityId: CommunityId, memberId: AccountId): Community {
    const c = this.communities.get(communityId);
    if (!c) {
      throw new SocialError({
        code: "eks.social.community.not_found",
        category: "not_found",
        message: `Community ${communityId} not found.`,
      });
    }
    if (c.type === "invite_only") {
      throw new SocialError({
        code: "eks.social.community.invite_only",
        category: "forbidden",
        message: "This community is invite-only.",
        userMessage: "You need an invite to join this community.",
      });
    }
    const roster = this.members.get(communityId) ?? new Set<AccountId>();
    if (roster.has(memberId)) {
      throw new SocialError({
        code: "eks.social.community.already_member",
        category: "already_member",
        message: "Account is already a member.",
        userMessage: "You are already a member of this community.",
      });
    }
    roster.add(memberId);
    this.members.set(communityId, roster);
    const updated: Community = { ...c, memberCount: roster.size };
    this.communities.set(communityId, updated);
    link(this.byMember, memberId, communityId);
    void getEventBus().publish(
      buildEvent(
        SOCIAL_EVENTS.communityJoined,
        { communityId, memberId, memberCount: roster.size },
        {},
        "domain",
      ),
    );
    return updated;
  }

  leave(communityId: CommunityId, memberId: AccountId): Community {
    const c = this.communities.get(communityId);
    if (!c) {
      throw new SocialError({
        code: "eks.social.community.not_found",
        category: "not_found",
        message: `Community ${communityId} not found.`,
      });
    }
    const roster = this.members.get(communityId);
    if (!roster || !roster.has(memberId)) {
      throw new SocialError({
        code: "eks.social.community.not_member",
        category: "not_member",
        message: "Account is not a member.",
      });
    }
    if (memberId === c.ownerId) {
      throw new SocialError({
        code: "eks.social.community.owner_leave",
        category: "state_conflict",
        message: "Owner cannot leave without transferring ownership.",
        userMessage: "Transfer ownership before leaving.",
      });
    }
    roster.delete(memberId);
    const updated: Community = { ...c, memberCount: roster.size };
    this.communities.set(communityId, updated);
    unlink(this.byMember, memberId, communityId);
    void getEventBus().publish(
      buildEvent(
        SOCIAL_EVENTS.communityLeft,
        { communityId, memberId, memberCount: roster.size },
        {},
        "domain",
      ),
    );
    return updated;
  }

  listMembers(communityId: CommunityId): AccountId[] {
    const roster = this.members.get(communityId);
    if (!roster) {
      throw new SocialError({
        code: "eks.social.community.not_found",
        category: "not_found",
        message: `Community ${communityId} not found.`,
      });
    }
    return [...roster];
  }

  isMember(communityId: CommunityId, accountId: AccountId): boolean {
    const roster = this.members.get(communityId);
    return Boolean(roster && roster.has(accountId));
  }

  // -------------------------------------------------------------------------
  // Stats
  // -------------------------------------------------------------------------

  getStats(): {
    totalCommunities: number;
    byType: Record<string, number>;
    totalMemberships: number;
    avgMembersPerCommunity: number;
    largestCommunitySize: number;
  } {
    const list = [...this.communities.values()];
    const byType: Record<string, number> = {};
    let totalMemberships = 0;
    let largest = 0;
    for (const c of list) {
      byType[c.type] = (byType[c.type] ?? 0) + 1;
      totalMemberships += c.memberCount;
      largest = Math.max(largest, c.memberCount);
    }
    return {
      totalCommunities: list.length,
      byType,
      totalMemberships,
      avgMembersPerCommunity: list.length ? totalMemberships / list.length : 0,
      largestCommunitySize: largest,
    };
  }

  // -------------------------------------------------------------------------
  // Default communities
  // -------------------------------------------------------------------------

  private registerDefaults(): void {
    if (this.defaultsRegistered) return;
    const systemOwner = "acc_system_community_owner" as AccountId;
    const defaults: CreateCommunityInput[] = [
      {
        slug: "weight-loss-warriors",
        name: "Weight Loss Warriors",
        description: "A supportive community for people on a weight-loss journey. Share progress, recipes, and encouragement.",
        type: "public",
        ownerId: systemOwner,
        tags: ["weight", "nutrition", "fitness"],
      },
      {
        slug: "heart-health-heroes",
        name: "Heart Health Heroes",
        description: "For anyone focused on cardiovascular health — blood pressure, cholesterol, heart-rate tracking.",
        type: "public",
        ownerId: systemOwner,
        tags: ["cardiovascular", "heart", "bp"],
      },
      {
        slug: "sleep-optimizers",
        name: "Sleep Optimizers",
        description: "Optimize your sleep for better recovery, mood, and metabolic health.",
        type: "public",
        ownerId: systemOwner,
        tags: ["sleep", "recovery", "circadian"],
      },
      {
        slug: "mental-wellness-supporters",
        name: "Mental Wellness Supporters",
        description: "A private space to discuss stress, mood, and mental wellness with peers.",
        type: "private",
        ownerId: systemOwner,
        tags: ["mental", "stress", "mood"],
      },
      {
        slug: "fitness-enthusiasts",
        name: "Fitness Enthusiasts",
        description: "An invite-only group for serious athletes training for events and competitions.",
        type: "invite_only",
        ownerId: systemOwner,
        tags: ["fitness", "training", "competition"],
      },
    ];
    for (const d of defaults) {
      try {
        this.create(d);
      } catch {
        // already registered — ignore on re-construction
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function link<K>(map: Map<K, CommunityId[]>, id: K, cid: CommunityId): void {
  const list = map.get(id) ?? [];
  if (!list.includes(cid)) map.set(id, [...list, cid]);
}

function unlink<K>(map: Map<K, CommunityId[]>, id: K, cid: CommunityId): void {
  const list = map.get(id);
  if (!list) return;
  map.set(id, list.filter((x) => x !== cid));
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _manager: CommunityManager | null = null;
export function getCommunities(): CommunityManager {
  if (!_manager) _manager = new CommunityManager();
  return _manager;
}
export function resetCommunities(): void {
  _manager = null;
}
