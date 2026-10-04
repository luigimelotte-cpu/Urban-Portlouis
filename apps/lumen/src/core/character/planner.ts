import type { TurnSignals } from "../intent/detect";
import type { ConversationStyle, RelationshipState } from "../types";
import type { CharacterTraits } from "./profile";

// The turn planner turns personality numbers into concrete, *varying*
// instructions for this one reply. A seeded RNG keeps it reproducible per turn
// (useful for tests) while making consecutive replies differ in shape.

export interface TurnPlan {
  length: "one-liner" | "short" | "medium" | "long";
  bubbles: number;
  askQuestion: boolean;
  takeInitiative: boolean;
  callback: boolean;
  tease: boolean;
  goal?: string;
}

export function planTurn(input: {
  traits: CharacterTraits;
  style: ConversationStyle;
  signals: TurnSignals;
  relationship: Pick<RelationshipState, "stage" | "comfort">;
  goals: string[];
  hasMemories: boolean;
  seed: number;
}): TurnPlan {
  const rnd = mulberry32(input.seed);
  const n = (v: number) => v / 100;
  const { traits, style, signals } = input;

  // Length: mirror the user loosely, vary a lot, story mode runs longer.
  const r = rnd();
  let length: TurnPlan["length"];
  if (style === "STORY") length = r < 0.15 ? "medium" : "long";
  else if (signals.wordCount <= 4) length = r < 0.45 ? "one-liner" : r < 0.85 ? "short" : "medium";
  else if (signals.wordCount <= 25) length = r < 0.2 ? "one-liner" : r < 0.7 ? "short" : "medium";
  else length = r < 0.15 ? "short" : r < 0.75 ? "medium" : "long";

  const bubbles =
    style === "STORY" ? 1 : length === "one-liner" ? 1 : rnd() < 0.35 + 0.25 * n(traits.playfulness) ? (rnd() < 0.7 ? 2 : 3) : 1;

  const askQuestion = !signals.question && rnd() < 0.2 + 0.4 * n(traits.initiative);
  const takeInitiative = rnd() < 0.1 + 0.4 * n(traits.initiative) || signals.wordCount <= 2;
  const callback = input.hasMemories && rnd() < 0.3;
  const tease = rnd() < 0.08 + 0.45 * n(traits.playfulness) * (input.relationship.comfort > 25 ? 1 : 0.4);
  const goal = takeInitiative && input.goals.length ? input.goals[Math.floor(rnd() * input.goals.length)] : undefined;

  return { length, bubbles, askQuestion, takeInitiative, callback, tease, goal };
}

const LENGTH_TEXT: Record<TurnPlan["length"], string> = {
  "one-liner": "Keep this reply very short — a few words or one line.",
  short: "Keep this reply short: one to three sentences.",
  medium: "A medium reply: a short paragraph at most.",
  long: "You can take more space this time — a few paragraphs, vivid but not padded.",
};

export function describePlan(p: TurnPlan, style: ConversationStyle): string {
  const lines = [LENGTH_TEXT[p.length]];
  if (p.bubbles > 1 && style !== "STORY")
    lines.push(`Send it as ${p.bubbles} separate texts, separated by a line containing only "||".`);
  if (p.takeInitiative)
    lines.push(
      p.goal
        ? `Take initiative: move toward one of your goals ("${p.goal}") — propose, reveal, or steer.`
        : "Take initiative: bring up something yourself — a plan, something on your mind, a new topic.",
    );
  if (p.askQuestion) lines.push("End with a genuine question you actually want answered.");
  else lines.push("Don't end with a question this time.");
  if (p.callback) lines.push("If it fits naturally, call back to something you remember about them.");
  if (p.tease) lines.push("A bit of teasing would suit the moment.");
  return lines.join("\n");
}

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
