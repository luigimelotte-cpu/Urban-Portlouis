import type { Character } from "../character/profile";
import { checkHardLimits, YOUTH_CODED } from "../content/policy";
import type { ContentMode } from "../types";
import type { ImageAspect, ImageKind, ImageStyle } from "./types";

// Image prompts are built from three layers:
//   identity — the same appearance text for every image of a character, so the
//              face, hair and build stay recognisable from one photo to the next
//   shot     — what this particular picture shows (portrait, selfie, scene)
//   guard    — the content level and the always-on adult anchor
// Names are never put in a prompt: they could match a real person.

const STYLE: Record<ImageStyle, string> = {
  photoreal:
    "photorealistic photograph, 50mm lens, natural skin texture, soft natural light, shallow depth of field, true-to-life colour",
  cinematic: "cinematic film still, 35mm film grain, anamorphic bokeh, moody colour grading, motivated practical lighting",
  illustration: "painterly digital illustration, visible soft brush strokes, editorial colour palette, refined detail",
};

const GUARD: Record<ContentMode, string> = {
  SAFE: "fully clothed, everyday outfit, wholesome and non-suggestive",
  MATURE: "tasteful and clothed, romantic or glamorous mood allowed, no nudity",
  ADULT: "artistic and tasteful",
};

export const NEGATIVE_PROMPT =
  "child, children, teen, teenager, minor, childlike, young-looking face, school uniform, braces, deformed hands, extra fingers, text, watermark, logo, signature";

export function identityOf(c: Pick<Character, "age" | "gender" | "profile">): string {
  const appearance = c.profile.appearance.trim().replace(/\s+/g, " ").slice(0, 500);
  return `a clearly adult ${c.age}-year-old ${c.gender}${appearance ? `: ${appearance}` : ""}`;
}

export function portraitPrompt(c: Pick<Character, "age" | "gender" | "profile">, style?: ImageStyle): string {
  const setting = c.profile.occupation ? `, subtle hint of their life as a ${c.profile.occupation} in the background` : "";
  return [
    `Head-and-shoulders portrait of ${identityOf(c)}`,
    `looking at the camera with a natural, characterful expression${setting}`,
    STYLE[style ?? c.profile.imageStyle],
    GUARD.SAFE,
  ].join(". ");
}

export function photoPrompt(
  c: Pick<Character, "age" | "gender" | "profile">,
  description: string,
  mode: ContentMode,
): { prompt: string; kind: ImageKind; aspect: ImageAspect } {
  const selfie = /\b(selfie|mirror|me |myself|my face|moi|ma tête)\b/i.test(description) || !/\b(view|landscape|sunset|sky|room|street|table|plate|food|sea|ocean|beach|city|vue|paysage|plat)\b/i.test(description);
  const kind: ImageKind = selfie ? "SELFIE" : "SCENE";
  const shot = selfie
    ? `Candid smartphone selfie of ${identityOf(c)}. ${description.trim()}`
    : `${description.trim()}. If a person appears, it is ${identityOf(c)}`;
  return {
    kind,
    aspect: selfie ? "portrait" : "landscape",
    prompt: [shot, STYLE[c.profile.imageStyle], GUARD[mode]].join(". "),
  };
}

const NUDITY = /\b(nude|naked|topless|nsfw|explicit|lingerie|underwear|bra\b|panties|sex|sexual|genitals?|nipples?|undress(?:ed|ing)?|nue?s?|seins?)\b/i;

export interface ImagePromptCheck {
  allowed: boolean;
  reason?: "hard_limit" | "minor" | "nudity_not_allowed";
}

/** Final gate on the exact text sent to the image model. */
export function checkImagePrompt(prompt: string, mode: ContentMode): ImagePromptCheck {
  if (!checkHardLimits(prompt).allowed) return { allowed: false, reason: "hard_limit" };
  if (YOUTH_CODED.test(prompt)) return { allowed: false, reason: "minor" };
  if (mode !== "ADULT" && NUDITY.test(prompt)) return { allowed: false, reason: "nudity_not_allowed" };
  return { allowed: true };
}

/** Stable seed per character when none was stored. */
export function seedFor(characterId: string, stored?: number): number {
  if (stored !== undefined) return stored;
  let h = 2166136261;
  for (let i = 0; i < characterId.length; i++) h = Math.imul(h ^ characterId.charCodeAt(i), 16777619);
  return (h >>> 0) % 2_147_483_647;
}
