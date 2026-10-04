import { z } from "zod";
import { extractJsonObject } from "../memory/extractor";
import type { ModelProvider } from "../providers/types";
import { CharacterProfileSchema, TraitsSchema, type CharacterInput, type CharacterTraits } from "./profile";

// "Describe this character in your own words" → structured CharacterInput.
// Uses a utility LLM when one is available; otherwise a heuristic parser that
// still gets name, age, gender, job, interests and trait sliders right for
// most plain descriptions. The result is a *draft* the user reviews.

export interface StructuredDraft {
  input: CharacterInput;
  warnings: string[];
  source: "llm" | "heuristic";
}

const DraftSchema = z.object({
  name: z.string().min(1).max(60),
  age: z.number().int().nullable().optional(),
  gender: z.string().max(40).default("woman"),
  tagline: z.string().max(160).default(""),
  tags: z.array(z.string().max(30)).max(12).default([]),
  profile: CharacterProfileSchema.partial().default({}),
});

export function structurePrompt(): string {
  return [
    "Turn the user's free-text character description into a JSON character sheet.",
    "Return one JSON object with keys: name, age (integer, must be 18 or older, null if not stated), gender, tagline (one catchy line), tags (3-6 short lowercase tags),",
    "profile: { appearance, personality, background, occupation, interests[], likes[], dislikes[], speechStyle, relationshipStyle, flirtingStyle, humorStyle, emotionalTraits[], boundaries, scenario, initialRelationship (STRANGER|ACQUAINTANCE|FRIEND|CLOSE_FRIEND|ATTRACTION|DATING|RELATIONSHIP), characterGoals[], exampleLines[] (3 lines in the character's voice), openingMessage (first message to the user, in character, may include *actions*), defaultStyle (CHAT|ROLEPLAY|STORY),",
    "traits: { initiative, jealousy, affection, confidence, playfulness, romance } each 0-100 }.",
    "Fill gaps with choices consistent with the description. All characters are adults; never describe anyone as a minor or child-like.",
  ].join("\n");
}

export async function structureCharacter(description: string, utility?: ModelProvider | null): Promise<StructuredDraft> {
  if (utility) {
    try {
      const res = await utility.generateResponse({
        system: structurePrompt(),
        messages: [{ role: "user", content: description.slice(0, 6000) }],
        json: true,
        maxOutputTokens: 2000,
        temperature: 0.7,
      });
      const json = extractJsonObject(res.text);
      const parsed = json ? DraftSchema.safeParse(json) : null;
      if (parsed?.success) return finalize(parsed.data, "llm", description);
    } catch {
      // fall through to heuristics
    }
  }
  return heuristicStructure(description);
}

function finalize(d: z.infer<typeof DraftSchema>, source: StructuredDraft["source"], description: string): StructuredDraft {
  const warnings: string[] = [];
  let age = d.age ?? null;
  if (age === null) {
    age = 25;
    warnings.push("No age was given — set to 25. Adjust it if needed (must be 18+).");
  } else if (age < 18) {
    warnings.push("Characters must be adults. The age was raised to 18 — please revise the description.");
    age = 18;
  }
  const profile = CharacterProfileSchema.parse({ ...d.profile });
  if (!profile.personality) profile.personality = description.slice(0, 600);
  return {
    source,
    warnings,
    input: {
      name: d.name,
      age,
      gender: d.gender,
      tagline: d.tagline,
      tags: d.tags.map((t) => t.toLowerCase()),
      visibility: "PRIVATE",
      maxContentMode: "MATURE",
      avatarUrl: null,
      profile,
    },
  };
}

// ─── Heuristic fallback ─────────────────────────────────────────────────────

const TRAIT_WORDS: [RegExp, Partial<CharacterTraits>][] = [
  [/\b(shy|timid|awkward|insecure|timide|réservée?|maladroite?)\b/i, { confidence: 25, initiative: 35 }],
  [/\b(confident|bold|assertive|dominant|sûre? d'elle|sûr de lui|audacieuse?|directe?)\b/i, { confidence: 85, initiative: 75 }],
  [/\b(playful|teasing|mischievous|funny|witty|sarcastic|joueuse?|taquine?|drôle|espiègle|sarcastique)\b/i, { playfulness: 82 }],
  [/\b(serious|stoic|calm|sérieuse?|calme|stoïque)\b/i, { playfulness: 25 }],
  [/\b(jealous|possessive|jalouse?|possessive?)\b/i, { jealousy: 80 }],
  [/\b(romantic|hopeless romantic|romantique|passionnée?)\b/i, { romance: 85 }],
  [/\b(cold|distant|aloof|tsundere|froide?|distante?)\b/i, { affection: 25, romance: 30 }],
  [/\b(warm|sweet|caring|affectionate|kind|douce?|chaleureuse?|attentionnée?|gentille?|affectueuse?)\b/i, { affection: 82 }],
  [/\b(flirty|flirtatious|seductive|charmeuse?|séductrice|séducteur|dragueuse?)\b/i, { romance: 75, initiative: 70, playfulness: 70 }],
  [/\b(spontaneous|adventurous|impulsive|spontanée?|aventurière|aventurier|impulsive?)\b/i, { initiative: 85 }],
];

const GENDER: [RegExp, string][] = [
  [/\b(she|her|woman|girl|female|elle|femme|fille)\b/i, "woman"],
  [/\b(he|him|man|guy|male|il|homme|mec|garçon)\b/i, "man"],
  [/\b(they|them|non-binary|nonbinary|non-binaire|iel)\b/i, "non-binary"],
];

export function heuristicStructure(description: string): StructuredDraft {
  const d = description.trim();
  const name =
    /\b(?:named|called|name is|s'appelle|nommée?|prénom(?:mée)?)\s+([A-ZÀ-Ý][\p{L}'-]+)/u.exec(d)?.[1] ??
    /^([A-ZÀ-Ý][\p{L}'-]+)\b(?:,| is| est)/u.exec(d)?.[1] ??
    "Unnamed";
  const ageMatch = /\b(\d{2,3})(?:\s*|-)(?:years?[- ]old|yo|y\/o|ans)\b/i.exec(d) ?? /\b(?:aged?|âgée? de)\s+(\d{2,3})\b/i.exec(d);
  const age = ageMatch ? Number(ageMatch[1]) : null;

  let gender = "woman";
  let best = Infinity;
  for (const [re, g] of GENDER) {
    const m = re.exec(d);
    if (m && m.index < best) {
      best = m.index;
      gender = g;
    }
  }

  const occupation =
    /\b(?:works? as an?|is an?|she's an?|he's an?|they're an?|travaille comme|est une?)\s+(?:\d{2,3}[- ]?(?:years?[- ]old|yo|ans)\s+)?([\p{L}-]+(?:\s(?!in\b|at\b|from\b|who\b|with\b|à\b|de\b|qui\b)[\p{L}-]+)?)/iu.exec(d)?.[1] ?? "";

  const traits: CharacterTraits = TraitsSchema.parse({});
  for (const [re, t] of TRAIT_WORDS) if (re.test(d)) Object.assign(traits, t);

  const interests = (/\b(?:loves?|enjoys?|into|passionate about|adore|aime|passionnée? (?:de|par))\s+([^.!?]+)/iu.exec(d)?.[1] ?? "")
    .split(/,|\band\b|\bet\b/)
    .map((s) => s.trim())
    .filter((s) => s && s.length < 40)
    .slice(0, 6);

  const sentences = d.split(/(?<=[.!?])\s+/);
  const appearance = sentences.filter((s) => /\b(hair|eyes|tall|short|wears|tattoo|freckles|cheveux|yeux|grande?|porte|tatouage)\b/i.test(s)).join(" ");
  const scenario = sentences.filter((s) => /\b(you|your|vous|tu|toi|ton|ta)\b/i.test(s)).join(" ");

  const tags = [
    traits.romance >= 70 && "romance",
    traits.playfulness >= 70 && "playful",
    traits.confidence <= 35 && "shy",
    traits.confidence >= 75 && "confident",
    traits.jealousy >= 70 && "jealous",
    occupation && occupation.split(" ")[0].toLowerCase(),
  ].filter(Boolean) as string[];

  return finalize(
    {
      name,
      age,
      gender,
      tagline: sentences[0]?.slice(0, 160) ?? "",
      tags,
      profile: {
        personality: d.slice(0, 1500),
        appearance,
        occupation,
        interests,
        scenario,
        traits,
        openingMessage: "",
      },
    },
    "heuristic",
    d,
  );
}
