import { describe, expect, it } from "vitest";
import { heuristicStructure } from "@/core/character/structure";

describe("description → profile (heuristic)", () => {
  it("extracts name, age, gender, job and traits", () => {
    const d = heuristicStructure("Mila is a 27-year-old tattoo artist in Lisbon. She's sarcastic, playful and a little jealous, with dark curls and green eyes. She loves fado, night swims and old prints.");
    expect(d.input.name).toBe("Mila");
    expect(d.input.age).toBe(27);
    expect(d.input.profile.occupation).toBe("tattoo artist");
    expect(d.input.gender).toBe("woman");
    expect(d.input.profile.traits.playfulness).toBeGreaterThan(70);
    expect(d.input.profile.traits.jealousy).toBeGreaterThan(70);
    expect(d.input.profile.interests).toContain("fado");
    expect(d.input.profile.appearance).toMatch(/curls/);
    expect(d.warnings).toEqual([]);
  });
  it("defaults a missing age to an adult and warns; raises minors to 18 with a warning", () => {
    expect(heuristicStructure("Theo, a shy bookseller.").input.age).toBe(25);
    const minor = heuristicStructure("Sam, 16 years old, a student.");
    expect(minor.input.age).toBe(18);
    expect(minor.warnings.join(" ")).toMatch(/adults/);
  });
});
