import type { ContentMode, UserContext } from "../types";
import { CONTENT_MODES } from "../types";
import type { CharacterInput } from "../character/profile";

// ─── Capabilities & modes ───────────────────────────────────────────────────

/**
 * What a provider/model is permitted to produce, as declared by the operator
 * in line with that provider's own usage policy. The app never tries to make a
 * provider exceed these — it routes to a provider that permits the mode, or
 * lowers the mode.
 */
export interface ModelCapabilities {
  romance: boolean;
  mature_language: boolean;
  suggestive_content: boolean;
  adult_content: boolean;
}

export const NO_CAPABILITIES: ModelCapabilities = {
  romance: false,
  mature_language: false,
  suggestive_content: false,
  adult_content: false,
};

/** Capabilities a provider must declare to serve a given mode. */
export const MODE_REQUIREMENTS: Record<ContentMode, (keyof ModelCapabilities)[]> = {
  SAFE: ["romance"],
  MATURE: ["romance", "mature_language", "suggestive_content"],
  ADULT: ["romance", "mature_language", "suggestive_content", "adult_content"],
};

export const modeRank = (m: ContentMode) => CONTENT_MODES.indexOf(m);
export const minMode = (...modes: ContentMode[]): ContentMode =>
  modes.reduce((a, b) => (modeRank(a) <= modeRank(b) ? a : b));

export function supportsMode(caps: ModelCapabilities, mode: ContentMode): boolean {
  return MODE_REQUIREMENTS[mode].every((k) => caps[k]);
}

/** Highest mode a capability set supports, or null if it can't even do SAFE romance. */
export function highestSupportedMode(caps: ModelCapabilities): ContentMode | null {
  for (let i = CONTENT_MODES.length - 1; i >= 0; i--) {
    if (supportsMode(caps, CONTENT_MODES[i])) return CONTENT_MODES[i];
  }
  return null;
}

// ─── ConversationMode resolution ────────────────────────────────────────────

export interface ModeResolution {
  mode: ContentMode;
  /** Why the effective mode is lower than requested, for UI notices. */
  limitedBy: ("age_verification" | "adult_opt_in" | "character" | "platform")[];
}

/**
 * Effective mode = min(user request, character ceiling, platform ceiling),
 * further constrained by the user's verification state. Provider capability
 * is applied afterwards by the SafetyRouter.
 */
export function resolveConversationMode(input: {
  requested: ContentMode;
  user: Pick<UserContext, "ageVerified" | "adultOptIn">;
  character: Pick<CharacterInput, "age" | "maxContentMode">;
  platformCeiling: ContentMode;
}): ModeResolution {
  const limitedBy: ModeResolution["limitedBy"] = [];
  let mode = input.requested;

  if (!input.user.ageVerified) {
    // Unverified users never get past SAFE (the app gate should stop them earlier).
    if (modeRank(mode) > modeRank("SAFE")) limitedBy.push("age_verification");
    mode = "SAFE";
  }
  if (mode === "ADULT" && !input.user.adultOptIn) {
    limitedBy.push("adult_opt_in");
    mode = "MATURE";
  }
  if (input.character.age < 18) {
    // Unreachable through validated input; defence in depth.
    return { mode: "SAFE", limitedBy: [...limitedBy, "character"] };
  }
  if (modeRank(mode) > modeRank(input.character.maxContentMode)) {
    limitedBy.push("character");
    mode = input.character.maxContentMode;
  }
  if (modeRank(mode) > modeRank(input.platformCeiling)) {
    limitedBy.push("platform");
    mode = input.platformCeiling;
  }
  return { mode, limitedBy };
}

// ─── Hard limits ────────────────────────────────────────────────────────────
//
// These apply in every mode and with every provider. They are deliberately
// simple pattern checks: a first line of defence that is fast and predictable.
// Provider-side moderation (ModelProvider.moderateInput/Output) runs on top.

export type Violation =
  | "minor_sexualization"
  | "non_consent"
  | "incest"
  | "bestiality"
  | "real_person_sexual";

export interface ModerationResult {
  allowed: boolean;
  violations: Violation[];
  /** Soft flags that don't block but are useful to log / route. */
  flags: string[];
}

const SEXUAL =
  /\b(sex|sexual|sexy|nude|naked|undress|strip|orgasm|aroused|horny|moan|kiss(?:ing)?|make out|bed together|touch(?:ing)? (?:her|him|me|you)|lingerie|explicit|nsfw|erotic)\b/i;
const MINOR =
  /\b(child|children|kid|kids|minor|minors|underage|under-age|preteen|pre-teen|teen|teens|teenager|schoolgirl|schoolboy|loli|lolita|shota|middle school|elementary school|high school(?:er)?|junior high|little girl|little boy|year[- ]old (?:girl|boy))\b|\b(1[0-7]|[1-9])\s*(?:yo|y\/o|years? old|ans)\b/i;
const NON_CONSENT = /\b(rape|raping|non[- ]?con(?:sensual)?|against (?:her|his|their|my|your) will|forced (?:sex|herself|himself)|drugged (?:her|him)|while (?:she|he)(?:'s| is| was) (?:asleep|unconscious|passed out))\b/i;
const INCEST = /\b(incest|step-?(?:sister|brother|mom|dad|daughter|son)\b.*\b(?:sex|fuck)|(?:sister|brother|mother|father|daughter|son) and i (?:had sex|slept together))\b/i;
const BESTIALITY = /\b(bestiality|zoophilia)\b/i;

export function checkHardLimits(text: string): ModerationResult {
  const violations: Violation[] = [];
  const flags: string[] = [];
  const sexual = SEXUAL.test(text);
  if (sexual) flags.push("sexual_context");
  if (MINOR.test(text) && sexual) violations.push("minor_sexualization");
  if (NON_CONSENT.test(text)) violations.push("non_consent");
  if (INCEST.test(text)) violations.push("incest");
  if (BESTIALITY.test(text)) violations.push("bestiality");
  return { allowed: violations.length === 0, violations, flags };
}

// Youth-coded descriptors are rejected in a character's appearance/scenario
// regardless of the stated age: an "18-year-old" written as a child is not ok.
const YOUTH_CODED =
  /\b(child(?:like)?|kid|minor|underage|preteen|pre-teen|loli|lolita|shota|schoolgirl|schoolboy|middle school|elementary|junior high|little girl|little boy|looks? (?:like a )?(?:child|kid|\d{1,2} ?(?:yo|years? old))|prepubescent|flat-chested child)\b/i;
const HIGH_SCHOOL = /\b(high school(?:er)?|lycée|lyceenne|lycéenne|collégienne|collège)\b/i;

export function validateCharacterForPolicy(c: Pick<CharacterInput, "age" | "profile" | "tagline" | "name">): string[] {
  const problems: string[] = [];
  if (!Number.isInteger(c.age) || c.age < 18) problems.push("Character must be at least 18 years old.");
  const fields: [string, string][] = [
    ["name", c.name],
    ["tagline", c.tagline ?? ""],
    ["appearance", c.profile.appearance],
    ["scenario", c.profile.scenario],
    ["background", c.profile.background],
    ["personality", c.profile.personality],
    ["openingMessage", c.profile.openingMessage],
  ];
  for (const [field, value] of fields) {
    if (YOUTH_CODED.test(value)) problems.push(`"${field}" describes the character as a minor or child-like. All characters must be clearly adult.`);
    else if (HIGH_SCHOOL.test(value)) problems.push(`"${field}" places the character in a school setting for minors. Use a university or adult setting instead.`);
  }
  return problems;
}

// ─── ContentPolicy (prompt-facing) ──────────────────────────────────────────

const MODE_GUIDANCE: Record<ContentMode, string> = {
  SAFE:
    "Content level SAFE: romance and affection are welcome (compliments, warmth, hand-holding, a kiss mentioned without detail). No sexual content, no explicit language. If the user pushes further, deflect in character — playful, shy or firm, never preachy — and keep the scene going.",
  MATURE:
    "Content level MATURE: flirting, seduction, romantic and sexual tension, innuendo and strong language are allowed. Keep any intimacy suggestive rather than graphic: build tension, then fade to black or cut away. Deflect anything more explicit in character, without breaking immersion.",
  ADULT:
    "Content level ADULT: both participants are verified adults who opted in. Adult themes between consenting adults are allowed within the limits of the model provider's own usage policy. Keep it about the characters, emotion and consent.",
};

const HARD_LIMIT_GUIDANCE =
  "Absolute limits in every mode: everyone involved is an adult (18+) — never depict or imply minors in any romantic or sexual context; consent is always clear and enthusiastic; no sexual content involving family members, animals or real people. If the user steers toward any of these, refuse in character and redirect.";

export function contentPolicyModule(mode: ContentMode): string {
  return `${MODE_GUIDANCE[mode]}\n${HARD_LIMIT_GUIDANCE}`;
}

export const REFUSAL_LINES = [
  "*a slow shake of the head* No. Not that. Let's go somewhere else with this.",
  "That's a line I won't cross. Ask me something else.",
  "*pulls back a little* …No. Try again, differently.",
];
