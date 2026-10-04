import { CharacterInputSchema, type CharacterInput } from "@/core/character/profile";
import { validateCharacterForPolicy } from "@/core/content/policy";
import { ChatPipeline } from "@/core/pipeline/chat-pipeline";
import { initialRelationship } from "@/core/relationship/engine";
import { baselineFromTraits } from "@/core/emotion/engine";
import type { ContentMode, ConversationStyle } from "@/core/types";
import { prisma } from "./db";
import { getEmbedder } from "./embedder";
import { dbPlatformSettings, dbProviderSource } from "./providers";
import { prismaChatStore, prismaMemoryStore, readSettings, toCharacter, toMessage } from "./store";

export function getPipeline() {
  return new ChatPipeline({
    store: prismaChatStore,
    memory: prismaMemoryStore,
    providers: dbProviderSource,
    embedder: getEmbedder(),
    settings: dbPlatformSettings,
  });
}

export class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly details?: unknown) {
    super(message);
  }
}

// ─── Characters (public zone) ───────────────────────────────────────────────

/** Characters a user can see: public ones + their own. Never someone else's private ones. */
export async function listVisibleCharacters(userId: string | null, opts: { q?: string; tag?: string } = {}) {
  const rows = await prisma.character.findMany({
    where: {
      AND: [
        { OR: [{ visibility: "PUBLIC" }, ...(userId ? [{ creatorId: userId }] : [])] },
        opts.tag ? { tags: { has: opts.tag } } : {},
        opts.q ? { OR: [{ name: { contains: opts.q, mode: "insensitive" } }, { tagline: { contains: opts.q, mode: "insensitive" } }] } : {},
      ],
    },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  return rows.map(toCharacter);
}

export async function getVisibleCharacter(id: string, userId: string | null) {
  const c = await prisma.character.findUnique({ where: { id } });
  if (!c) return null;
  if (c.visibility === "PRIVATE" && c.creatorId !== userId) return null;
  return toCharacter(c);
}

export function validateCharacterInput(raw: unknown): CharacterInput {
  const parsed = CharacterInputSchema.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, "Invalid character", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
  const problems = validateCharacterForPolicy(parsed.data);
  if (problems.length) throw new HttpError(400, "Character violates content policy", problems);
  return parsed.data;
}

export async function createCharacter(userId: string, raw: unknown) {
  const input = validateCharacterInput(raw);
  const c = await prisma.character.create({
    data: { ...characterData(input), creatorId: userId },
  });
  return toCharacter(c);
}

export async function updateCharacter(userId: string, id: string, raw: unknown) {
  const existing = await prisma.character.findUnique({ where: { id } });
  if (!existing || existing.creatorId !== userId) throw new HttpError(404, "Character not found");
  const input = validateCharacterInput(raw);
  const c = await prisma.character.update({ where: { id }, data: characterData(input) });
  return toCharacter(c);
}

export async function deleteCharacter(userId: string, id: string) {
  const existing = await prisma.character.findUnique({ where: { id } });
  if (!existing || existing.creatorId !== userId) throw new HttpError(404, "Character not found");
  await prisma.character.delete({ where: { id } });
}

function characterData(input: CharacterInput) {
  return {
    name: input.name,
    age: input.age,
    gender: input.gender,
    tagline: input.tagline,
    tags: input.tags,
    avatarUrl: input.avatarUrl ?? null,
    visibility: input.visibility,
    maxContentMode: input.maxContentMode,
    profile: input.profile as object,
  };
}

// ─── Conversations (private zone) ───────────────────────────────────────────

export async function createConversation(userId: string, characterId: string, opts: { style?: ConversationStyle; contentMode?: ContentMode } = {}) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user?.ageVerifiedAt) throw new HttpError(403, "Age verification required");
  const character = await getVisibleCharacter(characterId, userId);
  if (!character) throw new HttpError(404, "Character not found");
  const settings = readSettings(user.settings);

  const conv = await prisma.conversation.create({
    data: {
      userId,
      characterId,
      style: opts.style ?? settings.defaultStyle ?? character.profile.defaultStyle,
      contentMode: opts.contentMode ?? settings.requestedContentMode,
      title: character.name,
    },
  });

  // Relationship & emotion are per (user, character): create on first contact only.
  const rel = await prismaChatStore.getRelationship(userId, characterId);
  if (!rel) await prismaChatStore.saveRelationship(userId, characterId, initialRelationship(character.profile.initialRelationship));
  const emo = await prismaChatStore.getEmotions(userId, characterId);
  if (!emo) await prismaChatStore.saveEmotions(userId, characterId, baselineFromTraits(character.profile.traits));

  // Opening message: the character speaks first (only on a first meeting —
  // later conversations open with a proactive nudge instead).
  const opening = character.profile.openingMessage?.trim();
  const isFirstEver = !rel || rel.turnCount === 0;
  if (opening && isFirstEver) {
    await prismaChatStore.addMessage(conv.id, { role: "character", content: opening, characterId, meta: { kind: "opening" } });
  }
  return conv;
}

export async function getConversationForUser(id: string, userId: string) {
  const conv = await prisma.conversation.findFirst({ where: { id, userId }, include: { character: true } });
  if (!conv) return null;
  const messages = await prismaChatStore.listMessages(id, { limit: 200 });
  return { conversation: conv, character: toCharacter(conv.character), messages };
}

export async function exportConversation(id: string, userId: string) {
  const conv = await prisma.conversation.findFirst({
    where: { id, userId },
    include: { character: { select: { name: true } }, messages: { orderBy: { createdAt: "asc" } } },
  });
  if (!conv) throw new HttpError(404, "Conversation not found");
  return {
    exportedAt: new Date().toISOString(),
    conversation: { id: conv.id, character: conv.character.name, style: conv.style, contentMode: conv.contentMode, createdAt: conv.createdAt },
    messages: conv.messages.map((m) => {
      const msg = toMessage(m);
      return { role: msg.role, content: msg.content, createdAt: msg.createdAt, edited: !!m.editedAt };
    }),
  };
}

export async function exportAllUserData(userId: string) {
  const [user, conversations, memories, relationships] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { id: true, displayName: true, createdAt: true, settings: true, adultOptIn: true } }),
    prisma.conversation.findMany({ where: { userId }, include: { messages: { orderBy: { createdAt: "asc" } }, character: { select: { name: true } } } }),
    prisma.memory.findMany({ where: { userId }, select: { characterId: true, kind: true, category: true, content: true, importance: true, timestamp: true } }),
    prisma.relationshipState.findMany({ where: { userId } }),
  ]);
  return { exportedAt: new Date().toISOString(), user, conversations, memories, relationships };
}

/** Reset relationship + mood with a character (keeps memories and chats). */
export async function resetRelationship(userId: string, characterId: string) {
  const character = await prisma.character.findUnique({ where: { id: characterId } });
  if (!character) throw new HttpError(404, "Character not found");
  const c = toCharacter(character);
  await prismaChatStore.saveRelationship(userId, characterId, initialRelationship(c.profile.initialRelationship));
  await prismaChatStore.saveEmotions(userId, characterId, baselineFromTraits(c.profile.traits));
}

export async function resetCharacterMemory(userId: string, characterId: string) {
  await prisma.memory.deleteMany({ where: { userId, characterId } });
}

export async function deleteAllUserData(userId: string) {
  // Cascades: conversations → messages, memories, relationship, emotions.
  // Characters the user created are kept only if public; private ones go.
  await prisma.character.deleteMany({ where: { creatorId: userId, visibility: { not: "PUBLIC" } } });
  await prisma.user.delete({ where: { id: userId } });
}
