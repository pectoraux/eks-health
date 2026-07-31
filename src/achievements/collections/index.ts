/**
 * Eks-Health Achievement Engine — Collections
 *
 * Collections group related achievements and award a bonus XP reward when a
 * participant earns every achievement in the set. Pre-registers five
 * canonical collections spanning cardio, wellness, data, social, and full
 * completion.
 */

import "server-only";
import {
  type CollectionId,
  type AchievementId,
  type AccountId,
  type Collection,
  AchievementError,
  asCollectionId,
} from "../core";
import { getEventBus, buildEvent, generateId, getClock } from "@/kernel";
import { ACHIEVEMENT_EVENTS } from "../core";
import { getBadges } from "../badges";

// ---------------------------------------------------------------------------
// Input shapes
// ---------------------------------------------------------------------------

export interface CreateCollectionInput {
  readonly name: string;
  readonly description: string;
  readonly achievementIds: AchievementId[];
  readonly reward: number;
  readonly slug: string;
}

// ---------------------------------------------------------------------------
// Per-participant completion tracking (internal)
// ---------------------------------------------------------------------------

interface CollectionProgress {
  readonly participantId: AccountId;
  readonly collectionId: CollectionId;
  readonly earnedAchievementIds: AchievementId[];
  completedAt?: string;
  rewardAwardedAt?: string;
}

// ---------------------------------------------------------------------------
// Collection manager
// ---------------------------------------------------------------------------

export class CollectionManager {
  private readonly definitions = new Map<CollectionId, Collection>();
  private readonly bySlug = new Map<string, CollectionId>();
  private readonly progress = new Map<string, CollectionProgress>();
  private readonly byParticipant = new Map<AccountId, CollectionId[]>();
  private readonly defaultsRegistered = false;

  constructor() {
    this.registerDefaults();
  }

  // -------------------------------------------------------------------------
  // Definitions
  // -------------------------------------------------------------------------

  create(input: CreateCollectionInput): Collection {
    if (this.bySlug.has(input.slug)) {
      throw new AchievementError({
        code: "eks.achievement.collection.duplicate_slug",
        category: "duplicate",
        message: `Collection slug '${input.slug}' already exists.`,
        userMessage: "This collection already exists.",
        metadata: { slug: input.slug },
      });
    }
    if (input.achievementIds.length === 0) {
      throw new AchievementError({
        code: "eks.achievement.collection.empty",
        category: "validation",
        message: "A collection must contain at least one achievement.",
      });
    }
    if (input.reward < 0) {
      throw new AchievementError({
        code: "eks.achievement.collection.negative_reward",
        category: "validation",
        message: "Collection reward cannot be negative.",
      });
    }
    const id = asCollectionId(generateId("col_"));
    const collection: Collection = {
      id,
      name: input.name,
      description: input.description,
      achievementIds: [...input.achievementIds],
      reward: input.reward,
      completed: false,
    };
    this.definitions.set(id, collection);
    this.bySlug.set(input.slug, id);
    void getEventBus().publish(
      buildEvent(
        ACHIEVEMENT_EVENTS.collectionCreated,
        { collectionId: id, slug: input.slug, name: input.name, achievementCount: input.achievementIds.length, reward: input.reward },
        {},
        "domain",
      ),
    );
    return collection;
  }

  getCollection(id: CollectionId): Collection | undefined {
    return this.definitions.get(id);
  }

  getCollectionBySlug(slug: string): Collection | undefined {
    const id = this.bySlug.get(slug);
    return id ? this.definitions.get(id) : undefined;
  }

  listCollections(participantId?: AccountId): Collection[] {
    const list = [...this.definitions.values()];
    if (!participantId) return list;
    return list.map((c) => {
      const prog = this.progress.get(progressKey(participantId, c.id));
      if (prog?.completedAt) return { ...c, completed: true };
      return { ...c, completed: false };
    });
  }

  addAchievement(collectionId: CollectionId, achievementId: AchievementId): Collection {
    const c = this.definitions.get(collectionId);
    if (!c) {
      throw new AchievementError({
        code: "eks.achievement.collection.not_found",
        category: "not_found",
        message: `Collection ${collectionId} not found.`,
      });
    }
    if (c.achievementIds.includes(achievementId)) return c;
    const updated: Collection = { ...c, achievementIds: [...c.achievementIds, achievementId] };
    this.definitions.set(collectionId, updated);
    return updated;
  }

  // -------------------------------------------------------------------------
  // Completion
  // -------------------------------------------------------------------------

  /**
   * Re-evaluate a participant's completion status for a collection. Emits a
   * `collectionCompleted` event (and a `collectionRewardAwarded` event) the
   * first time the participant earns every achievement in the set.
   */
  checkCompletion(participantId: AccountId, collectionId: CollectionId): Collection {
    const c = this.definitions.get(collectionId);
    if (!c) {
      throw new AchievementError({
        code: "eks.achievement.collection.not_found",
        category: "not_found",
        message: `Collection ${collectionId} not found.`,
      });
    }
    const key = progressKey(participantId, collectionId);
    const prev = this.progress.get(key);
    if (prev?.completedAt) {
      return { ...c, completed: true };
    }

    const badges = getBadges();
    const earned: AchievementId[] = [];
    for (const aid of c.achievementIds) {
      if (badges.hasBadge(participantId, aid)) earned.push(aid);
    }
    const isComplete = earned.length === c.achievementIds.length;

    const updated: CollectionProgress = {
      participantId,
      collectionId,
      earnedAchievementIds: earned,
      completedAt: isComplete ? getClock().iso() : undefined,
    };
    this.progress.set(key, updated);
    const list = this.byParticipant.get(participantId) ?? [];
    if (!list.includes(collectionId)) {
      this.byParticipant.set(participantId, [...list, collectionId]);
    }

    if (isComplete) {
      void getEventBus().publish(
        buildEvent(
          ACHIEVEMENT_EVENTS.collectionCompleted,
          { participantId, collectionId, name: c.name, achievementCount: c.achievementIds.length },
          {},
          "domain",
        ),
      );
    }
    return { ...c, completed: isComplete };
  }

  /** Award the bonus XP reward for completing a collection (idempotent). */
  awardCollectionReward(participantId: AccountId, collectionId: CollectionId): { awarded: boolean; reward: number } {
    const c = this.definitions.get(collectionId);
    if (!c) {
      throw new AchievementError({
        code: "eks.achievement.collection.not_found",
        category: "not_found",
        message: `Collection ${collectionId} not found.`,
      });
    }
    const key = progressKey(participantId, collectionId);
    const prog = this.progress.get(key);
    if (!prog?.completedAt) {
      throw new AchievementError({
        code: "eks.achievement.collection.not_completed",
        category: "not_completed",
        message: "Collection is not yet completed by this participant.",
        userMessage: "Complete all achievements in this collection first.",
      });
    }
    if (prog.rewardAwardedAt) {
      return { awarded: false, reward: 0 };
    }
    const now = getClock().iso();
    this.progress.set(key, { ...prog, rewardAwardedAt: now });
    void getEventBus().publish(
      buildEvent(
        ACHIEVEMENT_EVENTS.collectionRewardAwarded,
        { participantId, collectionId, reward: c.reward, awardedAt: now },
        {},
        "domain",
      ),
    );
    return { awarded: true, reward: c.reward };
  }

  listCollectionsForParticipant(participantId: AccountId): Collection[] {
    return this.listCollections(participantId);
  }

  getProgress(participantId: AccountId, collectionId: CollectionId): { earned: number; total: number; completed: boolean } {
    const c = this.definitions.get(collectionId);
    if (!c) {
      throw new AchievementError({
        code: "eks.achievement.collection.not_found",
        category: "not_found",
        message: `Collection ${collectionId} not found.`,
      });
    }
    const prog = this.progress.get(progressKey(participantId, collectionId));
    return {
      earned: prog?.earnedAchievementIds.length ?? 0,
      total: c.achievementIds.length,
      completed: Boolean(prog?.completedAt),
    };
  }

  // -------------------------------------------------------------------------
  // Stats
  // -------------------------------------------------------------------------

  getStats(): {
    totalCollections: number;
    totalCompletions: number;
    totalRewardsAwarded: number;
    avgAchievementsPerCollection: number;
  } {
    const list = [...this.definitions.values()];
    let totalCompletions = 0;
    let totalRewardsAwarded = 0;
    let totalAchievements = 0;
    for (const c of list) totalAchievements += c.achievementIds.length;
    for (const p of this.progress.values()) {
      if (p.completedAt) totalCompletions++;
      if (p.rewardAwardedAt) totalRewardsAwarded++;
    }
    return {
      totalCollections: list.length,
      totalCompletions,
      totalRewardsAwarded,
      avgAchievementsPerCollection: list.length ? totalAchievements / list.length : 0,
    };
  }

  // -------------------------------------------------------------------------
  // Default collections
  // -------------------------------------------------------------------------

  private registerDefaults(): void {
    if (this.defaultsRegistered) return;
    // We resolve achievement ids by slug so the collections stay decoupled
    // from the exact id generation order.
    const badges = getBadges();
    const resolve = (slug: string): AchievementId => {
      const a = badges.getAchievementBySlug(slug);
      if (!a) {
        throw new AchievementError({
          code: "eks.achievement.collection.missing_preset",
          category: "not_found",
          message: `Default achievement '${slug}' is not registered.`,
        });
      }
      return a.id;
    };

    const defaults: CreateCollectionInput[] = [
      {
        slug: "cardio-master",
        name: "Cardio Master",
        description: "Master cardiovascular health tracking through measurements and competitions.",
        reward: 300,
        achievementIds: [
          resolve("first-measurement"),
          resolve("100-measurements"),
          resolve("first-competition"),
          resolve("competition-winner"),
        ],
      },
      {
        slug: "wellness-warrior",
        name: "Wellness Warrior",
        description: "Build consistent daily wellness habits.",
        reward: 250,
        achievementIds: [
          resolve("7-day-streak"),
          resolve("30-day-streak"),
          resolve("perfect-week"),
        ],
      },
      {
        slug: "data-scientist",
        name: "Data Scientist",
        description: "Become a prolific health-data contributor.",
        reward: 200,
        achievementIds: [
          resolve("first-measurement"),
          resolve("100-measurements"),
        ],
      },
      {
        slug: "social-butterfly",
        name: "Social Butterfly",
        description: "Engage with the community through competitions and programs.",
        reward: 150,
        achievementIds: [
          resolve("first-competition"),
          resolve("first-program-install"),
          resolve("5-programs-installed"),
        ],
      },
      {
        slug: "completionist",
        name: "Completionist",
        description: "Earn every achievement in the engine.",
        reward: 1000,
        achievementIds: [
          resolve("first-measurement"),
          resolve("7-day-streak"),
          resolve("30-day-streak"),
          resolve("first-competition"),
          resolve("competition-winner"),
          resolve("first-program-install"),
          resolve("5-programs-installed"),
          resolve("first-technician-visit"),
          resolve("100-measurements"),
          resolve("perfect-week"),
        ],
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

function progressKey(participantId: AccountId, collectionId: CollectionId): string {
  return `${participantId}::${collectionId}`;
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _manager: CollectionManager | null = null;
export function getCollections(): CollectionManager {
  if (!_manager) _manager = new CollectionManager();
  return _manager;
}
export function resetCollections(): void {
  _manager = null;
}
