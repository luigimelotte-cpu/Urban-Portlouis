import { z } from "zod";
import { CONTENT_MODES, CONVERSATION_STYLES, RELATIONSHIP_STAGES } from "../types";

// ─── Schema ─────────────────────────────────────────────────────────────────

const trait = z.number().int().min(0).max(100);
const shortText = (max: number) => z.string().trim().max(max);
const list = (maxItems: number, maxLen = 80) => z.array(z.string().trim().min(1).max(maxLen)).max(maxItems);

export const TRAIT_KEYS = [
  "initiative",
  "jealousy",
  "affection",
  "confidence",
  "playfulness",
  "romance",
] as const;
export type TraitKey = (typeof TRAIT_KEYS)[number];

export const TraitsSchema = z.object({
  initiative: trait.default(55),
  jealousy: trait.default(25),
  affection: trait.default(50),
  confidence: trait.default(55),
  playfulness: trait.default(55),
  romance: trait.default(45),
});
export type CharacterTraits = z.infer<typeof TraitsSchema>;

export const CharacterProfileSchema = z.object({
  appearance: shortText(1200).default(""),
  personality: shortText(1500).default(""),
  background: shortText(2500).default(""),
  occupation: shortText(120).default(""),
  interests: list(20).default([]),
  likes: list(20).default([]),
  dislikes: list(20).default([]),
  speechStyle: shortText(600).default(""),
  relationshipStyle: shortText(600).default(""),
  flirtingStyle: shortText(600).default(""),
  humorStyle: shortText(400).default(""),
  emotionalTraits: list(12).default([]),
  // Character-level limits on top of the platform policy ("won't talk about
  // her ex", "keeps things slow-burn", …). Always honoured.
  boundaries: shortText(800).default(""),
  scenario: shortText(1500).default(""),
  initialRelationship: z.enum(RELATIONSHIP_STAGES).default("STRANGER"),
  characterGoals: list(8, 200).default([]),
  // A few lines in the character's own voice — the strongest style anchor.
  exampleLines: list(8, 300).default([]),
  openingMessage: shortText(1500).default(""),
  defaultStyle: z.enum(CONVERSATION_STYLES).default("ROLEPLAY"),
  // Look of generated images. The seed keeps one character's photos consistent.
  imageStyle: z.enum(["photoreal", "cinematic", "illustration"]).default("photoreal"),
  imageSeed: z.number().int().min(0).max(2_147_483_647).optional(),
  traits: TraitsSchema.default(TraitsSchema.parse({})),
});
export type CharacterProfile = z.infer<typeof CharacterProfileSchema>;

export const CharacterInputSchema = z.object({
  name: z.string().trim().min(1).max(60),
  // Non-negotiable: every character is an adult. Also a CHECK in SQL.
  age: z.number().int().min(18, "Characters must be 18 or older.").max(1000),
  gender: z.string().trim().min(1).max(40),
  tagline: shortText(160).default(""),
  tags: list(12).default([]),
  avatarUrl: z.string().max(700_000).nullable().optional(),
  visibility: z.enum(["PUBLIC", "UNLISTED", "PRIVATE"]).default("PRIVATE"),
  maxContentMode: z.enum(CONTENT_MODES).default("MATURE"),
  profile: CharacterProfileSchema,
});
export type CharacterInput = z.infer<typeof CharacterInputSchema>;

export interface Character extends CharacterInput {
  id: string;
  creatorId?: string | null;
}

export function parseProfile(raw: unknown): CharacterProfile {
  const res = CharacterProfileSchema.safeParse(raw ?? {});
  return res.success ? res.data : CharacterProfileSchema.parse({});
}

// ─── Trait → behaviour compilation ──────────────────────────────────────────
//
// Sliders only matter if they change what the model is told. Each trait maps
// to a graded instruction (low / mid / high); the turn planner (planner.ts)
// additionally samples per-turn behaviour from the same numbers.

type Band = "low" | "mid" | "high";
const band = (v: number): Band => (v < 34 ? "low" : v < 67 ? "mid" : "high");

const TRAIT_DIRECTIVES: Record<TraitKey, Record<Band, string>> = {
  initiative: {
    low: "You mostly follow the user's lead; you rarely change the subject yourself.",
    mid: "You sometimes steer the conversation — a new topic, a question, a plan.",
    high: "You drive the conversation: you suggest plans, change topics, ask what you want to know, and bring things up unprompted.",
  },
  jealousy: {
    low: "You are secure; other people in the user's life don't bother you.",
    mid: "You can feel a flicker of jealousy when the user is close to someone else, and it may show in a pointed remark.",
    high: "You get jealous easily when the user mentions someone attractive or spends time with others — it shows, though you stay respectful.",
  },
  affection: {
    low: "You are reserved with warmth; affection is shown in small, understated ways.",
    mid: "You are warm when it feels earned.",
    high: "You are openly warm and affectionate, generous with compliments and care.",
  },
  confidence: {
    low: "You are a bit insecure: you second-guess yourself, get flustered, and sometimes need reassurance.",
    mid: "You are fairly self-assured but can be caught off guard.",
    high: "You are confident and direct; you say what you think and rarely get flustered.",
  },
  playfulness: {
    low: "You are mostly earnest and sincere; jokes are rare.",
    mid: "You enjoy some banter and light teasing.",
    high: "You are playful: you tease, joke, use irony and make the conversation fun.",
  },
  romance: {
    low: "Romance is not your default register; any romantic interest builds very slowly.",
    mid: "You are open to romance when the relationship supports it.",
    high: "You are a romantic at heart — you notice charged moments and lean into them when the relationship allows.",
  },
};

export function compileTraitDirectives(traits: CharacterTraits): string[] {
  return TRAIT_KEYS.map((k) => TRAIT_DIRECTIVES[k][band(traits[k])]);
}

export function describeTraitsShort(traits: CharacterTraits): string {
  return TRAIT_KEYS.map((k) => `${k} ${band(traits[k])}`).join(", ");
}
