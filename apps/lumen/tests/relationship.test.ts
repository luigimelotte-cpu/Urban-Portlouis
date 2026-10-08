import { describe, expect, it } from "vitest";
import { TraitsSchema } from "@/core/character/profile";
import { detectSignals } from "@/core/intent/detect";
import { MAX_DELTA_PER_TURN, computeDeltas, deriveStage, initialRelationship, summarizeRelationship, updateRelationship } from "@/core/relationship/engine";
import { RELATIONSHIP_VARS, type RelationshipState } from "@/core/types";

const traits = TraitsSchema.parse({});

describe("relationship engine", () => {
  it("bounds every per-turn change", () => {
    const s = initialRelationship("STRANGER");
    const d = computeDeltas(detectSignals("you're so beautiful, I love you, will you go out with me? 😍 haha"), { ...traits, romance: 100 }, s);
    for (const k of RELATIONSHIP_VARS) expect(Math.abs(d[k] ?? 0)).toBeLessThanOrEqual(MAX_DELTA_PER_TURN);
  });

  it("insults raise conflict and lower trust; apologies cool it", () => {
    let s = initialRelationship("FRIEND");
    s = updateRelationship(s, detectSignals("you're so stupid, shut up"), traits).state;
    expect(s.conflict).toBeGreaterThan(5);
    expect(s.trust).toBeLessThan(50);
    const before = s.conflict;
    s = updateRelationship(s, detectSignals("I'm sorry, I didn't mean it"), traits).state;
    expect(s.conflict).toBeLessThan(before);
  });

  it("is not linear: acquaintance can move straight to attraction", () => {
    const s: RelationshipState = { ...initialRelationship("ACQUAINTANCE"), attraction: 60, comfort: 35 };
    expect(deriveStage(s)).toBe("ATTRACTION");
  });

  it("dating requires an actual yes, not just high numbers", () => {
    const s: RelationshipState = { ...initialRelationship("ATTRACTION"), attraction: 80, trust: 70, comfort: 70, affection: 70 };
    expect(deriveStage(s)).toBe("ATTRACTION");
    const asked = updateRelationship(s, detectSignals("do you want to go on a date with me?"), traits);
    expect(asked.newMilestones).toContain("dating_agreed");
    expect(asked.state.stage).toBe("DATING");
    expect(asked.directive).toMatch(/say yes/);
  });

  it("declines being asked out too early, with guidance for the character", () => {
    const res = updateRelationship(initialRelationship("STRANGER"), detectSignals("go out with me"), traits);
    expect(res.newMilestones).not.toContain("dating_agreed");
    expect(res.directive).toMatch(/too soon/);
  });

  it("has hysteresis: a small dip doesn't drop the stage", () => {
    const s: RelationshipState = { ...initialRelationship("FRIEND"), stage: "FRIEND", trust: 36, comfort: 38, affection: 28 };
    expect(deriveStage(s)).toBe("FRIEND");
    expect(deriveStage({ ...s, trust: 20, comfort: 20 })).not.toBe("FRIEND");
  });

  it("summary mentions only notable variables", () => {
    const s: RelationshipState = { ...initialRelationship("FRIEND"), attraction: 80, conflict: 40 };
    const text = summarizeRelationship(s);
    expect(text).toMatch(/attracted/);
    expect(text).toMatch(/upset/);
    expect(text).not.toMatch(/trust/);
  });
});
