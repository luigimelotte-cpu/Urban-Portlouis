import { describe, expect, it } from "vitest";
import { TraitsSchema } from "@/core/character/profile";
import { describePlan, planTurn } from "@/core/character/planner";
import { detectSignals } from "@/core/intent/detect";
import { postProcessReply, splitBubbles } from "@/core/style/postprocess";

describe("post-processing", () => {
  it("strips assistant tells and speaker prefixes", () => {
    const out = postProcessReply("Mila: As an AI, I can't feel things. *smiles* Hey. How can I help you today?", "Mila");
    expect(out).toBe("*smiles* Hey.");
  });
  it("splits bubbles on the || delimiter", () => {
    expect(splitBubbles("hey\n||\nwhat's up\n||\n")).toEqual(["hey", "what's up"]);
  });
});

describe("turn planner", () => {
  const base = { style: "ROLEPLAY" as const, relationship: { stage: "FRIEND" as const, comfort: 50 }, goals: ["Show you the turtle"], hasMemories: true };
  it("high initiative characters take initiative far more often", () => {
    const count = (initiative: number) =>
      Array.from({ length: 300 }, (_, seed) =>
        planTurn({ ...base, traits: TraitsSchema.parse({ initiative }), signals: detectSignals("ok cool, tell me more about it"), seed }).takeInitiative,
      ).filter(Boolean).length;
    expect(count(95)).toBeGreaterThan(count(5) * 2);
  });
  it("varies reply length across turns", () => {
    const lengths = new Set(Array.from({ length: 40 }, (_, seed) => planTurn({ ...base, traits: TraitsSchema.parse({}), signals: detectSignals("hey how was your day"), seed }).length));
    expect(lengths.size).toBeGreaterThanOrEqual(3);
  });
  it("describes the plan as instructions", () => {
    const text = describePlan({ length: "short", bubbles: 2, askQuestion: true, takeInitiative: true, callback: false, tease: true, goal: "Win" }, "ROLEPLAY");
    expect(text).toMatch(/2 separate texts/);
    expect(text).toMatch(/Win/);
  });
});

describe("intent detection", () => {
  it("detects key intents in English and French", () => {
    expect(detectSignals("you're so beautiful").intents).toContain("compliment");
    expect(detectSignals("tu veux sortir avec moi ?").intent).toBe("ask_out");
    expect(detectSignals("t'es nul").intent).toBe("insult");
    expect(detectSignals("*kisses your cheek*").intents).toContain("romantic_advance");
    expect(detectSignals("haha 😂").intents).toContain("humor");
    expect(detectSignals("I met a girl at the gym").rivalMention).toBe(true);
  });
});
