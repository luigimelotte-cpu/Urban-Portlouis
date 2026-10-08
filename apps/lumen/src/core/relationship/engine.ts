import type { CharacterTraits } from "../character/profile";
import type { TurnSignals } from "../intent/detect";
import {
  RELATIONSHIP_STAGES,
  RELATIONSHIP_VARS,
  clamp,
  type RelationshipStage,
  type RelationshipState,
  type RelationshipVars,
} from "../types";

// Seven independent variables drive the relationship. The stage is *derived*
// from them (with hysteresis and milestones), never set directly — so the
// path isn't a ladder: Acquaintance → Attraction can skip Friend, conflict can
// pull a couple back, and Dating requires an actual "yes" in the story.

export const MAX_DELTA_PER_TURN = 8;

const PRESETS: Record<RelationshipStage, RelationshipVars> = {
  STRANGER: { trust: 15, affection: 10, attraction: 10, comfort: 15, attachment: 0, tension: 10, conflict: 0 },
  ACQUAINTANCE: { trust: 30, affection: 25, attraction: 15, comfort: 30, attachment: 10, tension: 10, conflict: 0 },
  FRIEND: { trust: 50, affection: 45, attraction: 20, comfort: 50, attachment: 25, tension: 5, conflict: 0 },
  CLOSE_FRIEND: { trust: 68, affection: 60, attraction: 25, comfort: 68, attachment: 45, tension: 5, conflict: 0 },
  ATTRACTION: { trust: 45, affection: 45, attraction: 55, comfort: 40, attachment: 25, tension: 35, conflict: 0 },
  DATING: { trust: 55, affection: 60, attraction: 65, comfort: 55, attachment: 45, tension: 30, conflict: 0 },
  RELATIONSHIP: { trust: 75, affection: 78, attraction: 70, comfort: 75, attachment: 72, tension: 20, conflict: 0 },
};

const PRESET_MILESTONES: Partial<Record<RelationshipStage, string[]>> = {
  DATING: ["first_meeting", "dating_agreed"],
  RELATIONSHIP: ["first_meeting", "dating_agreed", "relationship_agreed"],
};

export function initialRelationship(stage: RelationshipStage): RelationshipState {
  return { ...PRESETS[stage], stage, milestones: PRESET_MILESTONES[stage] ?? [], turnCount: 0 };
}

// ─── Stage derivation ───────────────────────────────────────────────────────

type Req = (s: RelationshipState, m: number) => boolean; // m = margin (negative = relaxed)

const REQUIREMENTS: Record<RelationshipStage, Req> = {
  STRANGER: () => true,
  ACQUAINTANCE: (s, m) => s.turnCount >= 4 || s.comfort >= 25 + m,
  FRIEND: (s, m) => s.trust >= 40 + m && s.comfort >= 40 + m && s.affection >= 30 + m,
  CLOSE_FRIEND: (s, m) => s.trust >= 60 + m && s.comfort >= 60 + m && s.affection >= 50 + m && s.attachment >= 35 + m,
  ATTRACTION: (s, m) => s.attraction >= 45 + m && s.comfort >= 30 + m && s.conflict < 60 - m,
  DATING: (s, m) =>
    s.milestones.includes("dating_agreed") && s.attraction >= 45 + m && s.trust >= 35 + m && s.conflict < 70 - m,
  RELATIONSHIP: (s, m) =>
    s.milestones.includes("relationship_agreed") &&
    s.affection >= 60 + m &&
    s.trust >= 55 + m &&
    s.attachment >= 50 + m &&
    s.conflict < 75 - m,
};

const rank = (s: RelationshipStage) => RELATIONSHIP_STAGES.indexOf(s);
const HYSTERESIS = 10;

export function deriveStage(s: RelationshipState): RelationshipStage {
  const qualifying = RELATIONSHIP_STAGES.filter((st) => REQUIREMENTS[st](s, 0));
  const target = qualifying[qualifying.length - 1];
  const cur = s.stage;

  if (rank(target) > rank(cur)) {
    // Climb one *qualifying* step at a time (may skip non-qualifying stages,
    // e.g. ACQUAINTANCE → ATTRACTION without passing FRIEND).
    return qualifying.find((st) => rank(st) > rank(cur)) ?? target;
  }
  if (rank(target) < rank(cur)) {
    // Stay unless we've clearly fallen below the current stage's bar.
    return REQUIREMENTS[cur](s, -HYSTERESIS) ? cur : target;
  }
  return cur;
}

// ─── Readiness for romantic milestones ──────────────────────────────────────

export function datingReadiness(s: RelationshipVars, traits: CharacterTraits): number {
  // 0..1. Romantic characters say yes a little sooner; heavy conflict blocks it.
  const base = (s.attraction * 0.4 + s.trust * 0.25 + s.comfort * 0.2 + s.affection * 0.15) / 100;
  return clamp(base + (traits.romance - 50) / 400 - s.conflict / 150, 0, 1);
}

export function relationshipReadiness(s: RelationshipVars, traits: CharacterTraits): number {
  const base = (s.affection * 0.3 + s.trust * 0.3 + s.attachment * 0.25 + s.attraction * 0.15) / 100;
  return clamp(base + (traits.romance - 50) / 500 - s.conflict / 120, 0, 1);
}

export const DATING_THRESHOLD = 0.5;
export const RELATIONSHIP_THRESHOLD = 0.62;

// ─── Turn update ────────────────────────────────────────────────────────────

export interface RelationshipUpdate {
  state: RelationshipState;
  deltas: Partial<RelationshipVars>;
  stageChanged?: { from: RelationshipStage; to: RelationshipStage };
  newMilestones: string[];
  /** Turn-specific guidance for the prompt (e.g. how to answer being asked out). */
  directive?: string;
}

export function computeDeltas(
  s: TurnSignals,
  traits: CharacterTraits,
  state: RelationshipState,
): Partial<RelationshipVars> {
  const d: Partial<RelationshipVars> = {};
  const add = (k: keyof RelationshipVars, v: number) => (d[k] = (d[k] ?? 0) + v);
  const n = (v: number) => v / 100;
  const has = (i: TurnSignals["intents"][number]) => s.intents.includes(i);

  // Familiarity: just talking builds a little comfort and trust.
  add("comfort", 0.6);
  add("trust", 0.3);

  if (has("compliment")) {
    add("affection", 2);
    add("attraction", 1 + 1.5 * n(traits.romance));
  }
  if (has("flirt")) {
    const welcome = state.comfort >= 25 || state.attraction >= 30;
    if (welcome) {
      add("attraction", 2 + 1.5 * n(traits.romance));
      add("tension", 2.5);
    } else {
      // Too forward too early: a bit of discomfort, but some intrigue too.
      add("comfort", -1.5);
      add("attraction", 0.8);
      add("tension", 1.5);
    }
  }
  if (has("romantic_advance")) {
    const ready = datingReadiness(state, traits) >= 0.4;
    add("tension", 3);
    if (ready) {
      add("attraction", 3);
      add("affection", 2);
    } else {
      add("comfort", -2.5);
    }
  }
  if (has("affection")) {
    add("affection", 2.5);
    add("attachment", 1.5);
  }
  if (has("share_personal")) {
    add("trust", 2.5);
    add("attachment", 1.5);
    add("comfort", 1);
  }
  if (has("humor")) {
    add("comfort", 1.5);
    add("affection", 0.5);
  }
  if (has("question")) add("affection", 0.4);
  if (has("insult")) {
    add("conflict", 9);
    add("trust", -4);
    add("affection", -3);
    add("comfort", -3);
    add("tension", 3);
  }
  if (has("apology") && state.conflict > 0) {
    add("conflict", -10);
    add("trust", 1.5);
    add("tension", -2);
  }
  if (s.rivalMention && n(traits.jealousy) > 0.2 && state.attraction > 25) {
    add("tension", 1 + 4 * n(traits.jealousy));
  }
  if (s.absenceHours > 48) {
    add("attachment", state.attachment > 50 ? 1 : -1);
    if (state.attachment > 50) add("tension", 1.5);
  }

  // Natural drift: conflict cools, tension relaxes toward a low baseline.
  if (!has("insult")) add("conflict", -1.5);
  if (state.tension > 15 && !has("flirt") && !has("romantic_advance")) add("tension", -0.8);

  // Diminishing returns near the top, bounded per turn.
  for (const k of RELATIONSHIP_VARS) {
    let v = d[k];
    if (v === undefined) continue;
    if (v > 0) v *= 1 - state[k] / 130;
    d[k] = round(clamp(v, -MAX_DELTA_PER_TURN, MAX_DELTA_PER_TURN));
  }
  return d;
}

export function applyDeltas(state: RelationshipState, deltas: Partial<RelationshipVars>): RelationshipState {
  const next: RelationshipState = { ...state, milestones: [...state.milestones] };
  for (const k of RELATIONSHIP_VARS) {
    if (deltas[k] !== undefined) next[k] = round(clamp(state[k] + (deltas[k] as number), 0, 100));
  }
  return next;
}

export function updateRelationship(
  state: RelationshipState,
  signals: TurnSignals,
  traits: CharacterTraits,
  extraDeltas: Partial<RelationshipVars> = {},
): RelationshipUpdate {
  const deltas = computeDeltas(signals, traits, state);
  for (const k of RELATIONSHIP_VARS) {
    if (extraDeltas[k] !== undefined) {
      deltas[k] = round(clamp((deltas[k] ?? 0) + (extraDeltas[k] as number), -MAX_DELTA_PER_TURN, MAX_DELTA_PER_TURN));
    }
  }
  let next = applyDeltas(state, deltas);
  next.turnCount = state.turnCount + 1;

  const newMilestones: string[] = [];
  const mark = (m: string) => {
    if (!next.milestones.includes(m)) {
      next.milestones.push(m);
      newMilestones.push(m);
    }
  };
  if (state.turnCount === 0) mark("first_meeting");

  let directive: string | undefined;
  if (signals.intents.includes("ask_relationship") && !next.milestones.includes("relationship_agreed")) {
    if (next.milestones.includes("dating_agreed") && relationshipReadiness(next, traits) >= RELATIONSHIP_THRESHOLD) {
      mark("relationship_agreed");
      directive = "They just asked to make it official. You want this too — say yes, in your own way.";
    } else {
      directive =
        "They just asked to make it official. You're not there yet — answer honestly and in character (touched, hesitant, or teasing), without crushing them.";
    }
  } else if (signals.intents.includes("ask_out") && !next.milestones.includes("dating_agreed")) {
    if (datingReadiness(next, traits) >= DATING_THRESHOLD) {
      mark("dating_agreed");
      directive = "They just asked you out. You're into them — say yes, in your own way, and maybe set the terms.";
    } else {
      directive =
        "They just asked you out. It's too soon for you — deflect or set a condition in character, leaving the door open if you like them.";
    }
  }

  const stage = deriveStage(next);
  const stageChanged = stage !== state.stage ? { from: state.stage, to: stage } : undefined;
  next = { ...next, stage };
  return { state: next, deltas, stageChanged, newMilestones, directive };
}

// ─── Prompt summary ─────────────────────────────────────────────────────────

const STAGE_TEXT: Record<RelationshipStage, string> = {
  STRANGER: "You've only just met them.",
  ACQUAINTANCE: "You know them a little — friendly, still figuring them out.",
  FRIEND: "You're friends. You're relaxed around them.",
  CLOSE_FRIEND: "They're one of your closest people. You can be fully yourself.",
  ATTRACTION: "There's undeniable attraction between you, not yet acted on or named.",
  DATING: "You're dating — it's new, exciting, not fully defined.",
  RELATIONSHIP: "You're in a committed relationship with them.",
};

const VAR_TEXT: Record<keyof RelationshipVars, [low: string, high: string]> = {
  trust: ["you don't fully trust them yet", "you trust them deeply"],
  affection: ["you're not especially fond of them yet", "you're very fond of them"],
  attraction: ["you're not attracted to them (yet)", "you're strongly attracted to them"],
  comfort: ["you're a bit guarded around them", "you feel completely at ease with them"],
  attachment: ["you don't depend on them", "you'd really miss them if they left"],
  tension: ["things are relaxed", "there's charged tension between you"],
  conflict: ["", "you're still upset with them about something"],
};

/** Only the notable parts — keeps the context lean. */
export function summarizeRelationship(s: RelationshipState): string {
  const notes: string[] = [];
  for (const k of RELATIONSHIP_VARS) {
    const v = s[k];
    if (k === "conflict") {
      if (v >= 30) notes.push(VAR_TEXT.conflict[1]);
      continue;
    }
    if (v >= 65) notes.push(VAR_TEXT[k][1]);
    else if (v <= 15 && k !== "tension" && k !== "attachment") notes.push(VAR_TEXT[k][0]);
  }
  if (s.tension >= 45 && !notes.includes(VAR_TEXT.tension[1])) notes.push(VAR_TEXT.tension[1]);
  return `${STAGE_TEXT[s.stage]}${notes.length ? " " + capitalize(notes.join("; ")) + "." : ""}`;
}

export function relationshipVars(s: RelationshipState): RelationshipVars {
  return Object.fromEntries(RELATIONSHIP_VARS.map((k) => [k, s[k]])) as RelationshipVars;
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const round = (v: number) => Math.round(v * 100) / 100;
