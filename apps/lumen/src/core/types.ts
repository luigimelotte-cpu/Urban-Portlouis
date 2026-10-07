// Shared domain types. Everything in src/core is framework-free: no Next.js, no
// Prisma. That keeps the engines testable in isolation and reusable from a
// future mobile backend, voice gateway or worker process.

export const CONTENT_MODES = ["SAFE", "MATURE", "ADULT"] as const;
export type ContentMode = (typeof CONTENT_MODES)[number];

export const CONVERSATION_STYLES = ["CHAT", "ROLEPLAY", "STORY"] as const;
export type ConversationStyle = (typeof CONVERSATION_STYLES)[number];

export const EMOTIONS = [
  "happy",
  "sad",
  "excited",
  "annoyed",
  "jealous",
  "affectionate",
  "playful",
  "shy",
  "confident",
  "romantic",
] as const;
export type Emotion = (typeof EMOTIONS)[number];
export type EmotionVector = Record<Emotion, number>; // each 0..1

export const RELATIONSHIP_VARS = [
  "trust",
  "affection",
  "attraction",
  "comfort",
  "attachment",
  "tension",
  "conflict",
] as const;
export type RelationshipVar = (typeof RELATIONSHIP_VARS)[number];
export type RelationshipVars = Record<RelationshipVar, number>; // each 0..100

export const RELATIONSHIP_STAGES = [
  "STRANGER",
  "ACQUAINTANCE",
  "FRIEND",
  "CLOSE_FRIEND",
  "ATTRACTION",
  "DATING",
  "RELATIONSHIP",
] as const;
export type RelationshipStage = (typeof RELATIONSHIP_STAGES)[number];

export interface RelationshipState extends RelationshipVars {
  stage: RelationshipStage;
  milestones: string[];
  turnCount: number;
}

export type ChatRole = "user" | "character" | "system";

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: Date;
  characterId?: string | null;
}

export interface UserSettings {
  preferredProviderId?: string | null;
  defaultStyle: ConversationStyle;
  memoryEnabled: boolean;
  imagesEnabled: boolean;
  requestedContentMode: ContentMode;
}

export const DEFAULT_USER_SETTINGS: UserSettings = {
  preferredProviderId: null,
  defaultStyle: "ROLEPLAY",
  memoryEnabled: true,
  imagesEnabled: true,
  requestedContentMode: "SAFE",
};

export interface UserContext {
  id: string;
  displayName?: string | null;
  ageVerified: boolean;
  adultOptIn: boolean;
  settings: UserSettings;
}

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
