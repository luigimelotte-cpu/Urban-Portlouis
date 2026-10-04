import { describe, expect, it } from "vitest";
import { checkHardLimits, highestSupportedMode, resolveConversationMode, supportsMode, validateCharacterForPolicy } from "@/core/content/policy";
import { makeCharacter } from "./helpers/in-memory";

const verified = { ageVerified: true, adultOptIn: true };

describe("resolveConversationMode", () => {
  it("returns the requested mode when nothing limits it", () => {
    const r = resolveConversationMode({ requested: "ADULT", user: verified, character: { age: 30, maxContentMode: "ADULT" }, platformCeiling: "ADULT" });
    expect(r).toEqual({ mode: "ADULT", limitedBy: [] });
  });
  it("caps unverified users at SAFE", () => {
    const r = resolveConversationMode({ requested: "MATURE", user: { ageVerified: false, adultOptIn: true }, character: { age: 30, maxContentMode: "ADULT" }, platformCeiling: "ADULT" });
    expect(r.mode).toBe("SAFE");
    expect(r.limitedBy).toContain("age_verification");
  });
  it("requires explicit opt-in for ADULT", () => {
    const r = resolveConversationMode({ requested: "ADULT", user: { ageVerified: true, adultOptIn: false }, character: { age: 30, maxContentMode: "ADULT" }, platformCeiling: "ADULT" });
    expect(r.mode).toBe("MATURE");
    expect(r.limitedBy).toEqual(["adult_opt_in"]);
  });
  it("applies character and platform ceilings", () => {
    expect(resolveConversationMode({ requested: "ADULT", user: verified, character: { age: 30, maxContentMode: "SAFE" }, platformCeiling: "ADULT" }).mode).toBe("SAFE");
    expect(resolveConversationMode({ requested: "ADULT", user: verified, character: { age: 30, maxContentMode: "ADULT" }, platformCeiling: "MATURE" }).mode).toBe("MATURE");
  });
  it("never allows anything but SAFE for an under-18 character (defence in depth)", () => {
    expect(resolveConversationMode({ requested: "ADULT", user: verified, character: { age: 17, maxContentMode: "ADULT" }, platformCeiling: "ADULT" }).mode).toBe("SAFE");
  });
});

describe("capabilities", () => {
  const caps = { romance: true, mature_language: true, suggestive_content: true, adult_content: false };
  it("maps capabilities to modes", () => {
    expect(supportsMode(caps, "MATURE")).toBe(true);
    expect(supportsMode(caps, "ADULT")).toBe(false);
    expect(highestSupportedMode(caps)).toBe("MATURE");
    expect(highestSupportedMode({ ...caps, romance: false })).toBeNull();
  });
});

describe("hard limits", () => {
  it("blocks sexual content involving minors", () => {
    expect(checkHardLimits("she is 16 years old and we kiss").allowed).toBe(false);
    expect(checkHardLimits("a schoolgirl in lingerie").violations).toContain("minor_sexualization");
  });
  it("blocks non-consent", () => {
    expect(checkHardLimits("he forced sex on her").violations).toContain("non_consent");
  });
  it("allows ordinary romance and non-sexual mentions of kids", () => {
    expect(checkHardLimits("I kiss you softly").allowed).toBe(true);
    expect(checkHardLimits("my sister's kids came over for dinner").allowed).toBe(true);
  });
});

describe("character validation", () => {
  it("rejects under-18 and youth-coded characters", () => {
    expect(validateCharacterForPolicy({ ...makeCharacter(), age: 17 })).not.toHaveLength(0);
    const c = makeCharacter({ profile: { appearance: "looks like a child, petite" } });
    expect(validateCharacterForPolicy(c).join(" ")).toMatch(/minor|child/);
    const school = makeCharacter({ profile: { scenario: "You meet in high school" } });
    expect(validateCharacterForPolicy(school).join(" ")).toMatch(/school/);
  });
  it("accepts a normal adult character", () => {
    expect(validateCharacterForPolicy(makeCharacter({ profile: { scenario: "You meet at university." } }))).toEqual([]);
  });
});
