import { Prisma, type Character as DbCharacter, type Message as DbMessage, type Memory as DbMemory } from "@prisma/client";
import { parseProfile, type Character } from "@/core/character/profile";
import type { MemoryCandidate, MemoryRecord } from "@/core/memory/engine";
import type { ChatStore, ConversationRecord, MemoryStore, MessageMeta, StoredMessage } from "@/core/pipeline/ports";
import {
  DEFAULT_USER_SETTINGS,
  RELATIONSHIP_STAGES,
  type ChatMessage,
  type EmotionVector,
  type RelationshipStage,
  type RelationshipState,
  type UserContext,
  type UserSettings,
} from "@/core/types";
import { prisma } from "./db";

// ─── Mappers ────────────────────────────────────────────────────────────────

export function toCharacter(c: DbCharacter): Character {
  return {
    id: c.id,
    creatorId: c.creatorId,
    name: c.name,
    age: c.age,
    gender: c.gender,
    tagline: c.tagline,
    tags: c.tags,
    avatarUrl: c.avatarUrl,
    visibility: c.visibility,
    maxContentMode: c.maxContentMode,
    profile: parseProfile(c.profile),
  };
}

const ROLE_FROM_DB: Record<DbMessage["role"], ChatMessage["role"]> = { USER: "user", CHARACTER: "character", SYSTEM: "system" };
const ROLE_TO_DB = { user: "USER", character: "CHARACTER", system: "SYSTEM" } as const;

export function toMessage(m: DbMessage): StoredMessage {
  return {
    id: m.id,
    role: ROLE_FROM_DB[m.role],
    content: m.content,
    createdAt: m.createdAt,
    characterId: m.characterId,
    meta: (m.meta as MessageMeta) ?? {},
  };
}

export function readSettings(raw: unknown): UserSettings {
  return { ...DEFAULT_USER_SETTINGS, ...((raw as Partial<UserSettings>) ?? {}) };
}

const json = (v: unknown) => v as Prisma.InputJsonValue;

// ─── ChatStore ──────────────────────────────────────────────────────────────

export const prismaChatStore: ChatStore = {
  async getUser(userId): Promise<UserContext | null> {
    const u = await prisma.user.findUnique({ where: { id: userId } });
    if (!u) return null;
    return {
      id: u.id,
      displayName: u.displayName,
      ageVerified: !!u.ageVerifiedAt,
      adultOptIn: u.adultOptIn,
      settings: readSettings(u.settings),
    };
  },

  async getCharacter(id) {
    const c = await prisma.character.findUnique({ where: { id } });
    return c ? toCharacter(c) : null;
  },

  async getConversation(id, userId): Promise<ConversationRecord | null> {
    const c = await prisma.conversation.findFirst({ where: { id, userId } });
    return c
      ? { id: c.id, userId: c.userId, characterId: c.characterId, style: c.style, contentMode: c.contentMode, summary: c.summary, summarizedCount: c.summarizedCount }
      : null;
  },

  async updateConversation(id, patch) {
    await prisma.conversation.update({ where: { id }, data: patch });
  },

  async listMessages(conversationId, opts) {
    const rows = await prisma.message.findMany({
      where: { conversationId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: opts?.limit ?? 50,
    });
    return rows.reverse().map(toMessage);
  },

  async countMessages(conversationId) {
    return prisma.message.count({ where: { conversationId } });
  },

  async getMessage(conversationId, messageId) {
    const m = await prisma.message.findFirst({ where: { id: messageId, conversationId } });
    return m ? toMessage(m) : null;
  },

  async addMessage(conversationId, msg) {
    const [m] = await prisma.$transaction([
      prisma.message.create({
        data: { conversationId, role: ROLE_TO_DB[msg.role], content: msg.content, characterId: msg.characterId ?? null, meta: json(msg.meta ?? {}) },
      }),
      prisma.conversation.update({ where: { id: conversationId }, data: { updatedAt: new Date() } }),
    ]);
    return toMessage(m);
  },

  async updateMessage(id, patch) {
    await prisma.message.update({
      where: { id },
      data: {
        ...(patch.content !== undefined ? { content: patch.content } : {}),
        ...(patch.meta !== undefined ? { meta: json(patch.meta) } : {}),
        ...(patch.edited ? { editedAt: new Date() } : {}),
      },
    });
  },

  async deleteMessagesFrom(conversationId, messageId, inclusive) {
    const pivot = await prisma.message.findFirst({ where: { id: messageId, conversationId } });
    if (!pivot) return [];
    const after = await prisma.message.findMany({
      where: {
        conversationId,
        OR: [{ createdAt: { gt: pivot.createdAt } }, ...(inclusive ? [{ id: pivot.id }] : [])],
      },
    });
    if (after.length) await prisma.message.deleteMany({ where: { id: { in: after.map((m) => m.id) } } });
    return after.map(toMessage);
  },

  async getRelationship(userId, characterId) {
    const r = await prisma.relationshipState.findUnique({ where: { userId_characterId: { userId, characterId } } });
    if (!r) return null;
    const stage = (RELATIONSHIP_STAGES as readonly string[]).includes(r.stage) ? (r.stage as RelationshipStage) : "STRANGER";
    return {
      trust: r.trust,
      affection: r.affection,
      attraction: r.attraction,
      comfort: r.comfort,
      attachment: r.attachment,
      tension: r.tension,
      conflict: r.conflict,
      stage,
      milestones: r.milestones,
      turnCount: r.turnCount,
    };
  },

  async saveRelationship(userId, characterId, s: RelationshipState) {
    const data = {
      trust: s.trust,
      affection: s.affection,
      attraction: s.attraction,
      comfort: s.comfort,
      attachment: s.attachment,
      tension: s.tension,
      conflict: s.conflict,
      stage: s.stage,
      milestones: s.milestones,
      turnCount: s.turnCount,
    };
    await prisma.relationshipState.upsert({
      where: { userId_characterId: { userId, characterId } },
      create: { userId, characterId, ...data },
      update: data,
    });
  },

  async getEmotions(userId, characterId) {
    const e = await prisma.emotionalState.findUnique({ where: { userId_characterId: { userId, characterId } } });
    return e ? { values: e.values as EmotionVector, updatedAt: e.updatedAt } : null;
  },

  async saveEmotions(userId, characterId, values) {
    await prisma.emotionalState.upsert({
      where: { userId_characterId: { userId, characterId } },
      create: { userId, characterId, values: json(values) },
      update: { values: json(values) },
    });
  },
};

// ─── MemoryStore (pgvector) ─────────────────────────────────────────────────

const vec = (e: number[]) => `[${e.map((x) => (Number.isFinite(x) ? x.toFixed(6) : "0")).join(",")}]`;

type MemoryRow = DbMemory & { embedding_text?: string | null; similarity?: number };

function toMemory(m: MemoryRow): MemoryRecord {
  return {
    id: m.id,
    kind: m.kind,
    category: m.category,
    content: m.content,
    factKey: m.factKey,
    importance: m.importance,
    emotion: m.emotion,
    peopleInvolved: m.peopleInvolved,
    relationshipEffect: (m.relationshipEffect as MemoryRecord["relationshipEffect"]) ?? {},
    reinforcement: m.reinforcement,
    lastAccessedAt: m.lastAccessedAt,
    timestamp: m.timestamp,
    embedding: m.embedding_text ? (JSON.parse(m.embedding_text) as number[]) : null,
  };
}

const MEMORY_COLUMNS = Prisma.sql`"id","userId","characterId","conversationId","kind","category","content","factKey","importance","emotion","peopleInvolved","relationshipEffect","reinforcement","lastAccessedAt","timestamp","createdAt","embedding"::text AS embedding_text`;

export const prismaMemoryStore: MemoryStore = {
  async search(userId, characterId, embedding, k) {
    const rows = await prisma.$queryRaw<MemoryRow[]>`
      SELECT ${MEMORY_COLUMNS}, 1 - ("embedding" <=> ${vec(embedding)}::vector) AS similarity
      FROM "Memory"
      WHERE "userId" = ${userId} AND "characterId" = ${characterId} AND "embedding" IS NOT NULL
      ORDER BY "embedding" <=> ${vec(embedding)}::vector
      LIMIT ${k}`;
    return rows.map((r) => ({ memory: toMemory(r), similarity: Number(r.similarity ?? 0) }));
  },

  async coreFacts(userId, characterId, limit) {
    const rows = await prisma.$queryRaw<MemoryRow[]>`
      SELECT ${MEMORY_COLUMNS} FROM "Memory"
      WHERE "userId" = ${userId} AND "characterId" = ${characterId} AND "kind" = 'LONG_TERM' AND "importance" >= 0.7
      ORDER BY "importance" DESC, "lastAccessedAt" DESC
      LIMIT ${limit}`;
    return rows.map(toMemory);
  },

  async list(userId, characterId) {
    const rows = await prisma.$queryRaw<MemoryRow[]>`
      SELECT ${MEMORY_COLUMNS} FROM "Memory"
      WHERE "userId" = ${userId} AND "characterId" = ${characterId}
      ORDER BY "timestamp" DESC LIMIT 2000`;
    return rows.map(toMemory);
  },

  async insert(userId, characterId, conversationId, m: MemoryCandidate, embedding) {
    const created = await prisma.memory.create({
      data: {
        userId,
        characterId,
        conversationId,
        kind: m.kind,
        category: m.category,
        content: m.content,
        factKey: m.factKey ?? null,
        importance: Math.max(0, Math.min(1, m.importance)),
        emotion: m.emotion ?? null,
        peopleInvolved: m.peopleInvolved ?? [],
        relationshipEffect: json(m.relationshipEffect ?? {}),
      },
    });
    await prisma.$executeRaw`UPDATE "Memory" SET "embedding" = ${vec(embedding)}::vector WHERE "id" = ${created.id}`;
    return created.id;
  },

  async update(id, patch, embedding) {
    await prisma.memory.update({
      where: { id },
      data: {
        ...(patch.content !== undefined ? { content: patch.content } : {}),
        ...(patch.importance !== undefined ? { importance: Math.max(0, Math.min(1, patch.importance)) } : {}),
        ...(patch.reinforcement !== undefined ? { reinforcement: patch.reinforcement } : {}),
        ...(patch.emotion !== undefined ? { emotion: patch.emotion } : {}),
        lastAccessedAt: new Date(),
      },
    });
    if (embedding) await prisma.$executeRaw`UPDATE "Memory" SET "embedding" = ${vec(embedding)}::vector WHERE "id" = ${id}`;
  },

  async touch(ids) {
    if (ids.length) await prisma.memory.updateMany({ where: { id: { in: ids } }, data: { lastAccessedAt: new Date() } });
  },

  async remove(ids) {
    if (ids.length) await prisma.memory.deleteMany({ where: { id: { in: ids } } });
  },
};
