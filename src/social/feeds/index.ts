/**
 * Eks-Health Social Platform — Activity Feeds
 *
 * Personal, team, community, and global feeds. Each participant has a
 * personalized feed assembled from their own posts + their friends' posts +
 * posts in communities they belong to. Posts can be liked and commented on.
 */

import "server-only";
import {
  type FeedId,
  type FeedPostId,
  type AccountId,
  type CommunityId,
  type Feed,
  type FeedPost,
  type FeedPostType,
  type FeedPostComment,
  SocialError,
  asFeedId,
  asFeedPostId,
} from "../core";
import { getEventBus, buildEvent, generateId, getClock } from "@/kernel";
import { SOCIAL_EVENTS } from "../core";
import { getFriends } from "../friends";
import { getCommunities } from "../communities";

// ---------------------------------------------------------------------------
// Input shapes
// ---------------------------------------------------------------------------

export interface CreateFeedPostInput {
  readonly authorId: AccountId;
  readonly type: FeedPostType;
  readonly content: string;
  /** Optional reference id (achievement id, competition id, etc.). */
  readonly referenceId?: string;
}

export interface CommentOnPostInput {
  readonly postId: FeedPostId;
  readonly authorId: AccountId;
  readonly content: string;
}

// ---------------------------------------------------------------------------
// Feed manager
// ---------------------------------------------------------------------------

export class FeedManager {
  private readonly feeds = new Map<FeedId, Feed>();
  private readonly posts = new Map<FeedPostId, FeedPost>();
  private readonly postsByFeed = new Map<FeedId, FeedPostId[]>();
  private readonly personalFeedByOwner = new Map<AccountId, FeedId>();
  private readonly globalFeedId: FeedId;

  constructor() {
    // Materialize the global feed once.
    const id = asFeedId(generateId("fd_"));
    const now = getClock().iso();
    this.globalFeedId = id;
    this.feeds.set(id, {
      id,
      ownerId: "" as AccountId,
      type: "global",
      createdAt: now,
    });
    this.postsByFeed.set(id, []);
  }

  // -------------------------------------------------------------------------
  // Feeds
  // -------------------------------------------------------------------------

  /** Get (creating if needed) a participant's personal feed. */
  getFeed(participantId: AccountId): Feed {
    const existing = this.personalFeedByOwner.get(participantId);
    if (existing) return this.feeds.get(existing)!;
    const id = asFeedId(generateId("fd_"));
    const feed: Feed = {
      id,
      ownerId: participantId,
      type: "personal",
      createdAt: getClock().iso(),
    };
    this.feeds.set(id, feed);
    this.postsByFeed.set(id, []);
    this.personalFeedByOwner.set(participantId, id);
    return feed;
  }

  getGlobalFeed(): Feed {
    return this.feeds.get(this.globalFeedId)!;
  }

  /**
   * Personalized feed for a participant: their own posts + friends' posts +
   * posts from communities they belong to. Deduplicated, most-recent first.
   */
  getPersonalizedFeed(participantId: AccountId, opts?: { limit?: number; before?: string }): FeedPost[] {
    const friends = getFriends().listFriends(participantId);
    const friendIds = new Set<AccountId>([
      participantId,
      ...friends.map((f) => (f.participantId === participantId ? f.friendId : f.participantId)),
    ]);
    const memberCommunities = getCommunities().listCommunities({ memberId: participantId });
    // We don't yet track community-scoped feed ownership here; instead we
    // include every post whose author is a friend or the participant, plus
    // any post authored by a co-member of the participant's communities.
    const communityMembers = new Set<AccountId>();
    for (const c of memberCommunities) {
      for (const m of getCommunities().listMembers(c.id)) communityMembers.add(m);
    }
    const eligible = new Set<AccountId>([...friendIds, ...communityMembers]);
    let list = [...this.posts.values()];
    if (opts?.before) list = list.filter((p) => p.createdAt < opts.before!);
    list = list.filter((p) => eligible.has(p.authorId));
    list.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return opts?.limit ? list.slice(0, opts.limit) : list;
  }

  /** All posts in a given feed (personal, team, community, or global). */
  getFeedPosts(feedId: FeedId, opts?: { limit?: number; before?: string }): FeedPost[] {
    const ids = this.postsByFeed.get(feedId) ?? [];
    let list = ids.map((id) => this.posts.get(id)!).filter(Boolean);
    if (opts?.before) list = list.filter((p) => p.createdAt < opts.before!);
    list.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return opts?.limit ? list.slice(0, opts.limit) : list;
  }

  /** Convenience alias for getFeedPosts(globalFeedId). */
  getGlobalFeedPosts(opts?: { limit?: number; before?: string }): FeedPost[] {
    return this.getFeedPosts(this.globalFeedId, opts);
  }

  /** Return the latest posts across all of a community's members. */
  getCommunityFeed(communityId: CommunityId, opts?: { limit?: number }): FeedPost[] {
    // Resolve community members and surface their recent posts.
    const members = new Set<AccountId>(getCommunities().listMembers(communityId));
    if (members.size === 0) return [];
    let list = [...this.posts.values()].filter((p) => members.has(p.authorId));
    list.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return opts?.limit ? list.slice(0, opts.limit) : list;
  }

  // -------------------------------------------------------------------------
  // Posting
  // -------------------------------------------------------------------------

  postToFeed(input: CreateFeedPostInput, opts?: { feedId?: FeedId; global?: boolean }): FeedPost {
    if (!input.content.trim()) {
      throw new SocialError({
        code: "eks.social.feed.empty_post",
        category: "validation",
        message: "Post content cannot be empty.",
      });
    }
    const feed = opts?.feedId
      ? this.feeds.get(opts.feedId)
      : opts?.global
        ? this.getGlobalFeed()
        : this.getFeed(input.authorId);
    if (!feed) {
      throw new SocialError({
        code: "eks.social.feed.not_found",
        category: "not_found",
        message: `Feed ${opts?.feedId} not found.`,
      });
    }
    const id = asFeedPostId(generateId("fp_"));
    const now = getClock().iso();
    const post: FeedPost = {
      id,
      feedId: feed.id,
      authorId: input.authorId,
      type: input.type,
      content: input.content,
      likes: 0,
      likedBy: [],
      comments: [],
      createdAt: now,
    };
    this.posts.set(id, post);
    const list = this.postsByFeed.get(feed.id) ?? [];
    this.postsByFeed.set(feed.id, [...list, id]);
    void getEventBus().publish(
      buildEvent(
        SOCIAL_EVENTS.feedPostCreated,
        { postId: id, feedId: feed.id, authorId: input.authorId, type: input.type, referenceId: input.referenceId },
        {},
        "domain",
      ),
    );
    return post;
  }

  /** Post to the global feed (visible to everyone). */
  postToGlobalFeed(input: CreateFeedPostInput): FeedPost {
    return this.postToFeed(input, { global: true });
  }

  likePost(postId: FeedPostId, accountId: AccountId): FeedPost {
    const p = this.posts.get(postId);
    if (!p) {
      throw new SocialError({
        code: "eks.social.feed.post_not_found",
        category: "not_found",
        message: `Post ${postId} not found.`,
      });
    }
    if (p.likedBy.includes(accountId)) return p;
    const updated: FeedPost = {
      ...p,
      likes: p.likes + 1,
      likedBy: [...p.likedBy, accountId],
    };
    this.posts.set(postId, updated);
    void getEventBus().publish(
      buildEvent(
        SOCIAL_EVENTS.feedPostLiked,
        { postId, accountId, likes: updated.likes },
        {},
        "domain",
      ),
    );
    return updated;
  }

  unlikePost(postId: FeedPostId, accountId: AccountId): FeedPost {
    const p = this.posts.get(postId);
    if (!p) {
      throw new SocialError({
        code: "eks.social.feed.post_not_found",
        category: "not_found",
        message: `Post ${postId} not found.`,
      });
    }
    if (!p.likedBy.includes(accountId)) return p;
    const updated: FeedPost = {
      ...p,
      likes: Math.max(0, p.likes - 1),
      likedBy: p.likedBy.filter((a) => a !== accountId),
    };
    this.posts.set(postId, updated);
    return updated;
  }

  commentOnPost(input: CommentOnPostInput): FeedPost {
    const p = this.posts.get(input.postId);
    if (!p) {
      throw new SocialError({
        code: "eks.social.feed.post_not_found",
        category: "not_found",
        message: `Post ${input.postId} not found.`,
      });
    }
    if (!input.content.trim()) {
      throw new SocialError({
        code: "eks.social.feed.empty_comment",
        category: "validation",
        message: "Comment content cannot be empty.",
      });
    }
    const comment: FeedPostComment = {
      id: generateId("cmt_"),
      authorId: input.authorId,
      content: input.content,
      createdAt: getClock().iso(),
    };
    const updated: FeedPost = { ...p, comments: [...p.comments, comment] };
    this.posts.set(input.postId, updated);
    void getEventBus().publish(
      buildEvent(
        SOCIAL_EVENTS.feedPostCommented,
        { postId: input.postId, commentId: comment.id, authorId: input.authorId },
        {},
        "domain",
      ),
    );
    return updated;
  }

  getPost(id: FeedPostId): FeedPost | undefined {
    return this.posts.get(id);
  }

  // -------------------------------------------------------------------------
  // Stats
  // -------------------------------------------------------------------------

  getStats(): {
    totalFeeds: number;
    totalPosts: number;
    totalLikes: number;
    totalComments: number;
    byType: Record<string, number>;
    avgLikesPerPost: number;
    avgCommentsPerPost: number;
  } {
    const list = [...this.posts.values()];
    const byType: Record<string, number> = {};
    let totalLikes = 0;
    let totalComments = 0;
    for (const p of list) {
      byType[p.type] = (byType[p.type] ?? 0) + 1;
      totalLikes += p.likes;
      totalComments += p.comments.length;
    }
    return {
      totalFeeds: this.feeds.size,
      totalPosts: list.length,
      totalLikes,
      totalComments,
      byType,
      avgLikesPerPost: list.length ? totalLikes / list.length : 0,
      avgCommentsPerPost: list.length ? totalComments / list.length : 0,
    };
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _manager: FeedManager | null = null;
export function getFeeds(): FeedManager {
  if (!_manager) _manager = new FeedManager();
  return _manager;
}
export function resetFeeds(): void {
  _manager = null;
}
