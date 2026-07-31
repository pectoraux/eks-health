/**
 * Eks-Health Social Platform — Messaging
 *
 * Conversations (direct, group, team, community) and messages. Messages are
 * append-only with per-recipient read receipts. Direct conversations between
 * two accounts are de-duplicated (one conversation per pair).
 */

import "server-only";
import {
  type MessageId,
  type ConversationId,
  type TeamId,
  type CommunityId,
  type AccountId,
  type Message,
  type Conversation,
  type MessageType,
  type ConversationType,
  SocialError,
  asMessageId,
  asConversationId,
} from "../core";
import { getEventBus, buildEvent, generateId, getClock } from "@/kernel";
import { SOCIAL_EVENTS } from "../core";

// ---------------------------------------------------------------------------
// Input shapes
// ---------------------------------------------------------------------------

export interface CreateConversationInput {
  readonly type: ConversationType;
  readonly participantIds: AccountId[];
  readonly teamId?: TeamId;
  readonly communityId?: CommunityId;
  readonly title?: string;
}

export interface SendMessageInput {
  readonly conversationId: ConversationId;
  readonly senderId: AccountId;
  readonly content: string;
  readonly type?: MessageType;
}

// ---------------------------------------------------------------------------
// Messaging manager
// ---------------------------------------------------------------------------

export class MessagingManager {
  private readonly conversations = new Map<ConversationId, Conversation>();
  private readonly messages = new Map<ConversationId, Message[]>();
  private readonly byParticipant = new Map<AccountId, ConversationId[]>();
  /** Direct-conversation de-duplication: sorted "a::b" → ConversationId. */
  private readonly directPairIndex = new Map<string, ConversationId>();

  // -------------------------------------------------------------------------
  // Conversations
  // -------------------------------------------------------------------------

  createConversation(input: CreateConversationInput): Conversation {
    if (input.participantIds.length < 2) {
      throw new SocialError({
        code: "eks.social.conversation.too_few_participants",
        category: "validation",
        message: "A conversation requires at least two participants.",
      });
    }
    if (input.type === "direct" && input.participantIds.length !== 2) {
      throw new SocialError({
        code: "eks.social.conversation.direct_size",
        category: "validation",
        message: "A direct conversation must have exactly two participants.",
      });
    }
    if (input.type === "direct") {
      const key = directKey(input.participantIds[0], input.participantIds[1]);
      const existing = this.directPairIndex.get(key);
      if (existing) return this.conversations.get(existing)!;
    }
    if (input.type === "team" && !input.teamId) {
      throw new SocialError({
        code: "eks.social.conversation.team_missing_ref",
        category: "validation",
        message: "A team conversation requires a teamId.",
      });
    }
    if (input.type === "community" && !input.communityId) {
      throw new SocialError({
        code: "eks.social.conversation.community_missing_ref",
        category: "validation",
        message: "A community conversation requires a communityId.",
      });
    }
    const id = asConversationId(generateId("cv_"));
    const now = getClock().iso();
    const convo: Conversation = {
      id,
      type: input.type,
      participantIds: [...new Set(input.participantIds)],
      lastMessageAt: now,
      createdAt: now,
      teamId: input.teamId,
      communityId: input.communityId,
      title: input.title,
    };
    this.conversations.set(id, convo);
    this.messages.set(id, []);
    for (const p of convo.participantIds) link(this.byParticipant, p, id);
    if (input.type === "direct") {
      this.directPairIndex.set(
        directKey(input.participantIds[0], input.participantIds[1]),
        id,
      );
    }
    void getEventBus().publish(
      buildEvent(
        SOCIAL_EVENTS.conversationCreated,
        { conversationId: id, type: input.type, participantCount: convo.participantIds.length, teamId: input.teamId, communityId: input.communityId },
        {},
        "domain",
      ),
    );
    return convo;
  }

  getConversation(id: ConversationId): Conversation | undefined {
    return this.conversations.get(id);
  }

  /** Return a participant's conversations, most-recently-active first. */
  getConversations(participantId: AccountId): Conversation[] {
    const ids = this.byParticipant.get(participantId) ?? [];
    return ids
      .map((id) => this.conversations.get(id)!)
      .filter(Boolean)
      .sort((a, b) => (a.lastMessageAt < b.lastMessageAt ? 1 : -1));
  }

  // -------------------------------------------------------------------------
  // Messages
  // -------------------------------------------------------------------------

  sendMessage(input: SendMessageInput): Message {
    const convo = this.conversations.get(input.conversationId);
    if (!convo) {
      throw new SocialError({
        code: "eks.social.conversation.not_found",
        category: "not_found",
        message: `Conversation ${input.conversationId} not found.`,
      });
    }
    if (!convo.participantIds.includes(input.senderId)) {
      throw new SocialError({
        code: "eks.social.message.not_participant",
        category: "forbidden",
        message: "Sender is not a participant in this conversation.",
        userMessage: "You are not part of this conversation.",
      });
    }
    if (!input.content.trim() && input.type !== "system") {
      throw new SocialError({
        code: "eks.social.message.empty",
        category: "validation",
        message: "Message content cannot be empty.",
      });
    }
    const now = getClock().iso();
    const msg: Message = {
      id: asMessageId(generateId("msg_")),
      conversationId: input.conversationId,
      senderId: input.senderId,
      content: input.content,
      type: input.type ?? "text",
      createdAt: now,
      readBy: [input.senderId],
    };
    const list = this.messages.get(input.conversationId) ?? [];
    this.messages.set(input.conversationId, [...list, msg]);
    const updated: Conversation = { ...convo, lastMessageAt: now };
    this.conversations.set(input.conversationId, updated);
    void getEventBus().publish(
      buildEvent(
        SOCIAL_EVENTS.messageSent,
        {
          messageId: msg.id,
          conversationId: input.conversationId,
          senderId: input.senderId,
          type: msg.type,
          createdAt: now,
        },
        {},
        "domain",
      ),
    );
    return msg;
  }

  getMessages(conversationId: ConversationId, opts?: { limit?: number; before?: string }): Message[] {
    const list = this.messages.get(conversationId) ?? [];
    let filtered = list;
    if (opts?.before) filtered = filtered.filter((m) => m.createdAt < opts.before!);
    filtered = [...filtered].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
    if (opts?.limit) filtered = filtered.slice(-opts.limit);
    return filtered;
  }

  markRead(conversationId: ConversationId, readerId: AccountId): Message[] {
    const convo = this.conversations.get(conversationId);
    if (!convo) {
      throw new SocialError({
        code: "eks.social.conversation.not_found",
        category: "not_found",
        message: `Conversation ${conversationId} not found.`,
      });
    }
    const list = this.messages.get(conversationId) ?? [];
    const updated = list.map((m) => {
      if (m.readBy.includes(readerId)) return m;
      return { ...m, readBy: [...m.readBy, readerId] };
    });
    this.messages.set(conversationId, updated);
    return updated;
  }

  getUnreadCount(participantId: AccountId): number {
    const ids = this.byParticipant.get(participantId) ?? [];
    let unread = 0;
    for (const id of ids) {
      const list = this.messages.get(id) ?? [];
      for (const m of list) {
        if (!m.readBy.includes(participantId)) unread++;
      }
    }
    return unread;
  }

  getUnreadCountByConversation(participantId: AccountId): Record<string, number> {
    const ids = this.byParticipant.get(participantId) ?? [];
    const out: Record<string, number> = {};
    for (const id of ids) {
      const list = this.messages.get(id) ?? [];
      let count = 0;
      for (const m of list) if (!m.readBy.includes(participantId)) count++;
      out[id] = count;
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Stats
  // -------------------------------------------------------------------------

  getStats(): {
    totalConversations: number;
    totalMessages: number;
    byType: Record<string, number>;
    avgMessagesPerConversation: number;
    activeConversationsLast24h: number;
  } {
    const list = [...this.conversations.values()];
    const byType: Record<string, number> = {};
    let totalMessages = 0;
    const cutoff = Date.now() - 86_400_000;
    let active24h = 0;
    for (const c of list) {
      byType[c.type] = (byType[c.type] ?? 0) + 1;
      const msgs = this.messages.get(c.id) ?? [];
      totalMessages += msgs.length;
      if (new Date(c.lastMessageAt).getTime() >= cutoff) active24h++;
    }
    return {
      totalConversations: list.length,
      totalMessages,
      byType,
      avgMessagesPerConversation: list.length ? totalMessages / list.length : 0,
      activeConversationsLast24h: active24h,
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function directKey(a: AccountId, b: AccountId): string {
  return a < b ? `${a}::${b}` : `${b}::${a}`;
}

function link(map: Map<AccountId, ConversationId[]>, id: AccountId, cid: ConversationId): void {
  const list = map.get(id) ?? [];
  if (!list.includes(cid)) map.set(id, [...list, cid]);
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _manager: MessagingManager | null = null;
export function getMessaging(): MessagingManager {
  if (!_manager) _manager = new MessagingManager();
  return _manager;
}
export function resetMessaging(): void {
  _manager = null;
}
