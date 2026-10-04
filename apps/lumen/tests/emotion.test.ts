import { describe, expect, it } from "vitest";
import { TraitsSchema } from "@/core/character/profile";
import { appraise, baselineFromTraits, describeEmotions, dominantEmotions, updateEmotions } from "@/core/emotion/engine";
import { detectSignals } from "@/core/intent/detect";
import { initialRelationship } from "@/core/relationship/engine";
import { EMOTIONS } from "@/core/types";

const traits = TraitsSchema.parse({});
const rel = initialRelationship("FRIEND");

describe("emotion engine", () => {
  it("baseline reflects personality", () => {
    const shy = baselineFromTraits({ ...traits, confidence: 10 });
    const bold = baselineFromTraits({ ...traits, confidence: 95 });
    expect(shy.shy).toBeGreaterThan(bold.shy);
    expect(bold.confident).toBeGreaterThan(shy.confident);
  });

  it("changes gradually — one insult can't flip the whole state", () => {
    const base = baselineFromTraits(traits);
    const next = updateEmotions(base, appraise(detectSignals("you're stupid, I hate you"), traits, rel), base, 0);
    for (const e of EMOTIONS) expect(Math.abs(next[e] - base[e])).toBeLessThanOrEqual(0.25);
    expect(next.annoyed).toBeGreaterThan(base.annoyed);
  });

  it("relaxes back toward baseline over time", () => {
    const base = baselineFromTraits(traits);
    const agitated = { ...base, annoyed: 0.9 };
    const later = updateEmotions(agitated, {}, base, 600);
    expect(later.annoyed).toBeLessThan(0.2);
  });

  it("jealousy scales with the jealousy trait", () => {
    const s = detectSignals("I went out with my ex last night");
    const low = appraise(s, { ...traits, jealousy: 5 }, { ...rel, attraction: 70 });
    const high = appraise(s, { ...traits, jealousy: 95 }, { ...rel, attraction: 70 });
    expect(high.jealous ?? 0).toBeGreaterThan((low.jealous ?? 0) * 5);
  });

  it("describes dominant emotions in words", () => {
    const base = baselineFromTraits(traits);
    const v = { ...base, playful: 0.8 };
    expect(dominantEmotions(v, base)[0].emotion).toBe("playful");
    expect(describeEmotions(v, base)).toMatch(/playful/);
  });
});
