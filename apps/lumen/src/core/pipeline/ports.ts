import type { Character } from "../character/profile";
import type { MemoryCandidate, MemoryRecord } from "../memory/engine";
import type { ModelProvider } from "../providers/types";
import type {
  ChatMessage,
  ContentMode,
  ConversationStyle,
  EmotionVector,
  RelationshipState,
  UserContext,
} from "../types";

// Ports: what the pipeline needs from the outside world. The Prisma
// implementation lives in src/server/store; tests use an in-memory one.

export interface ConversationRecord {
  id: string;
  userId: string;
  characterId: string;
  style: ConversationStyle;
  contentMode: ContentMode;
  summary: string;
  summarizedCount: number;
}

export interface MessageMeta {
  providerId?: string;
  model?: string;
  mode?: ContentMode;
  intent?: string;
  tokensIn?: number;
  tokensOut?: number;
  notices?: string[];
  /** Snapshot taken before this user turn, so regenerate/edit can roll back. */
  stateBefore?: { relationship: RelationshipState; emotions: EmotionVector | null };
  /** Memories created by this turn (deleted on regenerate/edit). */
  memoryIds?: string[];
  kind?: "opening" | "nudge" | "refusal" | "reply";
  [k: string]: unknown;
}

export interface StoredMessage extends ChatMessage {
  meta: MessageMeta;
}

export interface ChatStore {
  getUser(userId: string): Promise<UserContext | null>;
  getCharacter(characterId: string): Promise<Character | null>;
  getConversation(conversationId: string, userId: string): Promise<ConversationRecord | null>;
  updateConversation(conversationId: string, patch: Partial<Pick<ConversationRecord, "summary" | "summarizedCount" | "contentMode">>): Promise<void>;

  listMessages(conversationId: string, opts?: { limit?: number }): Promise<StoredMessage[]>;
  countMessages(conversationId: string): Promise<number>;
  getMessage(conversationId: string, messageId: string): Promise<StoredMessage | null>;
  addMessage(conversationId: string, msg: { role: ChatMessage["role"]; content: string; characterId?: string | null; meta?: MessageMeta }): Promise<StoredMessage>;
  updateMessage(messageId: string, patch: { content?: string; meta?: MessageMeta; edited?: boolean }): Promise<void>;
  deleteMessagesFrom(conversationId: string, messageId: string, inclusive: boolean): Promise<StoredMessage[]>;

  getRelationship(userId: string, characterId: string): Promise<RelationshipState | null>;
  saveRelationship(userId: string, characterId: string, state: RelationshipState): Promise<void>;
  getEmotions(userId: string, characterId: string): Promise<{ values: EmotionVector; updatedAt: Date } | null>;
  saveEmotions(userId: string, characterId: string, values: EmotionVector): Promise<void>;
}

export interface MemoryStore {
  /** Nearest neighbours by embedding (pgvector) for this user+character. */
  search(userId: string, characterId: string, embedding: number[], k: number): Promise<{ memory: MemoryRecord; similarity: number }[]>;
  /** High-importance long-term facts, always considered regardless of similarity. */
  coreFacts(userId: string, characterId: string, limit: number): Promise<MemoryRecord[]>;
  /** All memories for consolidation/forgetting passes. */
  list(userId: string, characterId: string): Promise<MemoryRecord[]>;
  insert(userId: string, characterId: string, conversationId: string | null, m: MemoryCandidate, embedding: number[]): Promise<string>;
  update(id: string, patch: Partial<MemoryCandidate> & { reinforcement?: number }, embedding?: number[]): Promise<void>;
  touch(ids: string[]): Promise<void>;
  remove(ids: string[]): Promise<void>;
}

export interface ProviderSource {
  list(): Promise<ModelProvider[]>;
}

export interface PlatformSettings {
  contentCeiling(): Promise<ContentMode>;
  routingFallback(): Promise<"downgrade" | "refuse">;
}
