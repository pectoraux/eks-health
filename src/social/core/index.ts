/**
 * Eks-Health Social Platform — Core Primitives
 *
 * Foundational types for the social platform: friendships, teams, communities,
 * messaging, invites, and activity feeds. The platform is a generic social
 * graph — it knows nothing about healthcare. It builds on the kernel (branded
 * ids, events, clock) and identity (accounts) only.
 */

import "server-only";
import type {
  Brand,
  TenantId,
  CorrelationId,
  TraceId,
} from "@/kernel";
import type { AccountId, OrgId } from "@/identity";

// ---------------------------------------------------------------------------
// Branded social identifiers
// ---------------------------------------------------------------------------

export type FriendshipId = Brand<string, "FriendshipId">;
export type TeamId = Brand<string, "TeamId">;
export type CommunityId = Brand<string, "CommunityId">;
export type MessageId = Brand<string, "MessageId">;
export type ConversationId = Brand<string, "ConversationId">;
export type InviteId = Brand<string, "InviteId">;
export type FeedId = Brand<string, "FeedId">;
export type FeedPostId = Brand<string, "FeedPostId">;

export function asFriendshipId(s: string): FriendshipId { return s as FriendshipId; }
export function asTeamId(s: string): TeamId { return s as TeamId; }
export function asCommunityId(s: string): CommunityId { return s as CommunityId; }
export function asMessageId(s: string): MessageId { return s as MessageId; }
export function asConversationId(s: string): ConversationId { return s as ConversationId; }
export function asInviteId(s: string): InviteId { return s as InviteId; }
export function asFeedId(s: string): FeedId { return s as FeedId; }
export function asFeedPostId(s: string): FeedPostId { return s as FeedPostId; }

// ---------------------------------------------------------------------------
// Friendship
// ---------------------------------------------------------------------------

export type FriendshipStatus = "pending" | "accepted" | "blocked";

export interface Friendship {
  readonly id: FriendshipId;
  readonly participantId: AccountId;
  readonly friendId: AccountId;
  readonly status: FriendshipStatus;
  readonly requestedAt: string;
  readonly acceptedAt?: string;
}

// ---------------------------------------------------------------------------
// Team
// ---------------------------------------------------------------------------

export interface Team {
  readonly id: TeamId;
  readonly name: string;
  readonly description: string;
  readonly captainId: AccountId;
  readonly memberIds: AccountId[];
  readonly createdOrgId?: OrgId;
  readonly createdAt: string;
}

// ---------------------------------------------------------------------------
// Community
// ---------------------------------------------------------------------------

export type CommunityType = "public" | "private" | "invite_only";

export interface Community {
  readonly id: CommunityId;
  readonly name: string;
  readonly description: string;
  readonly type: CommunityType;
  readonly memberCount: number;
  readonly ownerId: AccountId;
  readonly tags: string[];
  readonly createdAt: string;
}

// ---------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------

export type MessageType = "text" | "system" | "achievement" | "competition";
export type ConversationType = "direct" | "group" | "team" | "community";

export interface Message {
  readonly id: MessageId;
  readonly conversationId: ConversationId;
  readonly senderId: AccountId;
  readonly content: string;
  readonly type: MessageType;
  readonly createdAt: string;
  readonly readBy: AccountId[];
}

export interface Conversation {
  readonly id: ConversationId;
  readonly type: ConversationType;
  readonly participantIds: AccountId[];
  readonly lastMessageAt: string;
  readonly createdAt: string;
  /** Optional link to the team/community this conversation belongs to. */
  readonly teamId?: TeamId;
  readonly communityId?: CommunityId;
  readonly title?: string;
}

// ---------------------------------------------------------------------------
// Invites
// ---------------------------------------------------------------------------

export type InviteType = "friend" | "team" | "community";
export type InviteStatus = "pending" | "accepted" | "declined" | "expired";

export interface SocialInvite {
  readonly id: InviteId;
  readonly type: InviteType;
  readonly fromId: AccountId;
  readonly toId: AccountId;
  readonly targetId?: string;
  readonly message?: string;
  readonly status: InviteStatus;
  readonly createdAt: string;
  readonly expiresAt?: string;
}

// ---------------------------------------------------------------------------
// Feeds
// ---------------------------------------------------------------------------

export type FeedPostType =
  | "achievement"
  | "measurement"
  | "competition"
  | "mission"
  | "program_install"
  | "level_up"
  | "custom";

export interface Feed {
  readonly id: FeedId;
  readonly ownerId: AccountId;
  readonly type: "personal" | "team" | "community" | "global";
  readonly createdAt: string;
}

export interface FeedPostComment {
  readonly id: string;
  readonly authorId: AccountId;
  readonly content: string;
  readonly createdAt: string;
}

export interface FeedPost {
  readonly id: FeedPostId;
  readonly feedId: FeedId;
  readonly authorId: AccountId;
  readonly type: FeedPostType;
  readonly content: string;
  readonly likes: number;
  readonly likedBy: AccountId[];
  readonly comments: FeedPostComment[];
  readonly createdAt: string;
}

// ---------------------------------------------------------------------------
// Error model
// ---------------------------------------------------------------------------

export type SocialErrorCategory =
  | "not_found"
  | "state_conflict"
  | "validation"
  | "forbidden"
  | "already_member"
  | "not_member"
  | "duplicate"
  | "quota_exceeded";

export class SocialError extends Error {
  readonly code: string;
  readonly category: SocialErrorCategory;
  readonly retryable: boolean;
  readonly userMessage: string;
  readonly timestamp: string;
  readonly correlationId?: CorrelationId;
  readonly traceId?: TraceId;
  readonly metadata: Record<string, unknown>;

  constructor(opts: {
    code: string;
    category: SocialErrorCategory;
    message: string;
    userMessage?: string;
    retryable?: boolean;
    correlationId?: CorrelationId;
    traceId?: TraceId;
    metadata?: Record<string, unknown>;
    cause?: unknown;
  }) {
    super(opts.message);
    this.name = "SocialError";
    this.code = opts.code;
    this.category = opts.category;
    this.retryable = opts.retryable ?? false;
    this.userMessage = opts.userMessage ?? "A social platform error occurred.";
    this.timestamp = new Date().toISOString();
    this.correlationId = opts.correlationId;
    this.traceId = opts.traceId;
    this.metadata = opts.metadata ?? {};
    if (opts.cause !== undefined) {
      (this as { cause?: unknown }).cause = opts.cause;
    }
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      category: this.category,
      retryable: this.retryable,
      userMessage: this.userMessage,
      message: this.message,
      timestamp: this.timestamp,
      correlationId: this.correlationId,
      traceId: this.traceId,
      metadata: this.metadata,
    };
  }
}

// ---------------------------------------------------------------------------
// Social event types (published to the kernel event bus)
// ---------------------------------------------------------------------------

export const SOCIAL_EVENTS = {
  friendRequestSent: "eks.social.friend.request_sent",
  friendRequestAccepted: "eks.social.friend.request_accepted",
  friendRequestDeclined: "eks.social.friend.request_declined",
  friendBlocked: "eks.social.friend.blocked",
  friendUnblocked: "eks.social.friend.unblocked",
  teamCreated: "eks.social.team.created",
  teamJoined: "eks.social.team.joined",
  teamLeft: "eks.social.team.left",
  teamDisbanded: "eks.social.team.disbanded",
  communityCreated: "eks.social.community.created",
  communityJoined: "eks.social.community.joined",
  communityLeft: "eks.social.community.left",
  conversationCreated: "eks.social.conversation.created",
  messageSent: "eks.social.message.sent",
  feedPostCreated: "eks.social.feed.post_created",
  feedPostLiked: "eks.social.feed.post_liked",
  feedPostCommented: "eks.social.feed.post_commented",
  inviteCreated: "eks.social.invite.created",
  inviteAccepted: "eks.social.invite.accepted",
  inviteDeclined: "eks.social.invite.declined",
  inviteExpired: "eks.social.invite.expired",
} as const;

export type SocialEventType =
  (typeof SOCIAL_EVENTS)[keyof typeof SOCIAL_EVENTS];

// ---------------------------------------------------------------------------
// Re-export externally-relevant branded/identity types for convenience
// ---------------------------------------------------------------------------

export { type TenantId, type AccountId, type OrgId };
