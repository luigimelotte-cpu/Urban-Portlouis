import type { CharacterTraits } from "../character/profile";
import type { TurnSignals } from "../intent/detect";
import { EMOTIONS, clamp, type Emotion, type EmotionVector, type RelationshipState } from "../types";

// The emotional state is a vector, not a single label. It moves with inertia
// toward impulses from each turn and relaxes back toward a personality-defined
// baseline over time — so one message can colour the mood but can't rewrite
// who the character is.

const MAX_STEP = 0.22; // largest change of any emotion in a single turn
const HALF_LIFE_MIN = 120; // mood relaxes halfway to baseline in ~2h of silence

export function baselineFromTraits(t: CharacterTraits): EmotionVector {
  const n = (v: number) => v / 100;
  return {
    happy: 0.35 + 0.15 * n(t.affection),
    sad: 0.05,
    excited: 0.12 + 0.18 * n(t.playfulness),
    annoyed: 0.04,
    jealous: 0,
    affectionate: 0.08 + 0.3 * n(t.affection),
    playful: 0.08 + 0.45 * n(t.playfulness),
    shy: 0.35 * (1 - n(t.confidence)),
    confident: 0.12 + 0.5 * n(t.confidence),
    romantic: 0.04 + 0.28 * n(t.romance),
  };
}

export function neutralVector(): EmotionVector {
  return Object.fromEntries(EMOTIONS.map((e) => [e, 0])) as EmotionVector;
}

/**
 * Translate a turn's signals into emotional impulses, scaled by personality
 * and by where the relationship is (a flirt from a stranger lands differently
 * than one from a partner).
 */
export function appraise(
  s: TurnSignals,
  traits: CharacterTraits,
  rel: Pick<RelationshipState, "trust" | "attraction" | "comfort" | "stage">,
): Partial<EmotionVector> {
  const n = (v: number) => v / 100;
  const imp: Partial<Record<Emotion, number>> = {};
  const add = (e: Emotion, v: number) => (imp[e] = (imp[e] ?? 0) + v);
  const receptive = clamp((rel.trust + rel.comfort + rel.attraction) / 180, 0.1, 1);

  if (s.intents.includes("compliment")) {
    add("happy", 0.12);
    add("affectionate", 0.08);
    add("shy", 0.1 * (1 - n(traits.confidence)));
    add("confident", 0.05 * n(traits.confidence));
  }
  if (s.intents.includes("flirt") || s.intents.includes("romantic_advance")) {
    add("romantic", 0.14 * receptive * (0.5 + n(traits.romance)));
    add("playful", 0.08 * n(traits.playfulness));
    add("shy", 0.12 * (1 - n(traits.confidence)) * receptive);
    add("excited", 0.06 * receptive);
    if (receptive < 0.3) add("annoyed", 0.05);
  }
  if (s.intents.includes("affection")) {
    add("affectionate", 0.15);
    add("happy", 0.08);
  }
  if (s.intents.includes("insult")) {
    add("annoyed", 0.25);
    add("sad", 0.1);
    add("happy", -0.15);
    add("affectionate", -0.1);
    add("playful", -0.1);
  }
  if (s.intents.includes("apology")) {
    add("annoyed", -0.15);
    add("sad", -0.05);
    add("affectionate", 0.04);
  }
  if (s.intents.includes("humor")) {
    add("playful", 0.12);
    add("happy", 0.08);
  }
  if (s.intents.includes("share_personal")) {
    add("affectionate", 0.08);
    if (s.sentiment < 0) add("sad", 0.08);
  }
  if (s.intents.includes("ask_out") || s.intents.includes("ask_relationship")) {
    add("excited", 0.12 * receptive);
    add("romantic", 0.1 * receptive);
    add("shy", 0.08 * (1 - n(traits.confidence)));
  }
  if (s.rivalMention) {
    add("jealous", 0.25 * n(traits.jealousy) * (0.4 + n(rel.attraction)));
  }
  if (s.absenceHours > 24 && rel.stage !== "STRANGER") {
    add("sad", 0.06);
    add("excited", 0.08);
  }
  if (s.sentiment > 0.3) add("happy", 0.05);
  if (s.sentiment < -0.3) add("sad", 0.05);

  return imp;
}

export function updateEmotions(
  current: EmotionVector,
  impulses: Partial<EmotionVector>,
  baseline: EmotionVector,
  elapsedMinutes: number,
): EmotionVector {
  const relax = Math.pow(0.5, Math.max(0, elapsedMinutes) / HALF_LIFE_MIN);
  const next = {} as EmotionVector;
  for (const e of EMOTIONS) {
    const cur = current[e] ?? baseline[e];
    // 1) relax toward baseline for the time that passed, plus a small per-turn pull
    let v = baseline[e] + (cur - baseline[e]) * relax * 0.92;
    // 2) apply this turn's impulse, bounded
    v += clamp(impulses[e] ?? 0, -MAX_STEP, MAX_STEP);
    next[e] = round(clamp(v, 0, 1));
  }
  // Mutually-dampening pairs: strong annoyance mutes romance/playfulness, etc.
  if (next.annoyed > 0.5) {
    next.romantic = round(next.romantic * 0.7);
    next.playful = round(next.playful * 0.8);
  }
  if (next.confident > 0.6) next.shy = round(Math.min(next.shy, 0.4));
  return next;
}

export function dominantEmotions(v: EmotionVector, baseline: EmotionVector, n = 2): { emotion: Emotion; value: number }[] {
  // Rank by absolute level plus how far above baseline — "what's different
  // right now" matters more than the resting temperament.
  return EMOTIONS.map((e) => ({ emotion: e, value: v[e], score: v[e] + 1.5 * Math.max(0, v[e] - baseline[e]) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, n)
    .filter((x) => x.value > 0.12)
    .map(({ emotion, value }) => ({ emotion, value }));
}

const intensity = (v: number) => (v > 0.7 ? "strongly" : v > 0.45 ? "quite" : "a little");

export function describeEmotions(v: EmotionVector, baseline: EmotionVector): string {
  const dom = dominantEmotions(v, baseline, 3);
  if (!dom.length) return "You feel calm and even.";
  const parts = dom.map((d) => `${intensity(d.value)} ${d.emotion}`);
  const rising = dom.filter((d) => d.value - baseline[d.emotion] > 0.15).map((d) => d.emotion);
  return (
    `Right now you feel ${parts.join(", ")}.` +
    (rising.length ? ` (${rising.join(" and ")} — more than usual; let it show in tone, not by announcing it.)` : "")
  );
}

const round = (v: number) => Math.round(v * 1000) / 1000;
