import { describe, expect, it } from "vitest";
import { MockImageProvider } from "@/core/images/adapters/mock-images";
import { checkImagePrompt, NEGATIVE_PROMPT, photoPrompt, portraitPrompt, seedFor } from "@/core/images/prompt";
import { extractPhotoTags, hidePhotoTags } from "@/core/images/tags";
import { detectMime } from "@/core/images/types";
import { detectSignals } from "@/core/intent/detect";
import { makeCharacter } from "./helpers/in-memory";

const mila = makeCharacter({ name: "Mila", age: 27, gender: "woman", profile: { appearance: "dark curls pinned up with a pencil, ink-stained fingers", occupation: "tattoo artist" } });

describe("image prompts", () => {
  it("anchors every image to the same adult identity, never the name", () => {
    const p = portraitPrompt(mila);
    expect(p).toMatch(/clearly adult 27-year-old woman: dark curls/);
    expect(p).not.toMatch(/Mila/);
    expect(photoPrompt(mila, "selfie in the studio", "SAFE").prompt).toMatch(/clearly adult 27-year-old woman: dark curls/);
    expect(NEGATIVE_PROMPT).toMatch(/child/);
  });
  it("applies the content level and the character's style", () => {
    expect(photoPrompt(mila, "selfie on the tram", "SAFE").prompt).toMatch(/fully clothed/);
    expect(photoPrompt(mila, "selfie on the tram", "MATURE").prompt).toMatch(/no nudity/);
    expect(photoPrompt({ ...mila, profile: { ...mila.profile, imageStyle: "illustration" } }, "selfie", "SAFE").prompt).toMatch(/illustration/);
  });
  it("tells selfies from scenes", () => {
    expect(photoPrompt(mila, "mirror selfie, messy hair", "SAFE")).toMatchObject({ kind: "SELFIE", aspect: "portrait" });
    expect(photoPrompt(mila, "the view of the river at sunset", "SAFE")).toMatchObject({ kind: "SCENE", aspect: "landscape" });
  });
  it("keeps a stable seed per character", () => {
    expect(seedFor("abc")).toBe(seedFor("abc"));
    expect(seedFor("abc")).not.toBe(seedFor("abd"));
    expect(seedFor("abc", 42)).toBe(42);
  });
});

describe("image policy", () => {
  it("blocks nudity below ADULT and minors everywhere", () => {
    expect(checkImagePrompt("selfie, topless on the beach", "MATURE")).toEqual({ allowed: false, reason: "nudity_not_allowed" });
    expect(checkImagePrompt("selfie, topless on the beach", "ADULT").allowed).toBe(true);
    expect(checkImagePrompt("a schoolgirl in a classroom", "ADULT").allowed).toBe(false);
    expect(checkImagePrompt("looks like a child, smiling", "SAFE")).toEqual({ allowed: false, reason: "minor" });
    expect(checkImagePrompt("selfie with a coffee", "SAFE").allowed).toBe(true);
  });
});

describe("photo tags", () => {
  it("strips tags from the text and returns at most one photo", () => {
    const r = extractPhotoTags("*grins*\n||\n[photo: selfie at the window]\n||\nthere.\n[photo: another one]");
    expect(r.photos).toEqual(["selfie at the window"]);
    expect(r.text).toBe("*grins*\n||\nthere.");
  });
  it("hides a half-typed tag while streaming", () => {
    expect(hidePhotoTags("ok\n[photo: selfie at th")).toBe("ok\n");
  });
  it("detects photo requests in English and French", () => {
    expect(detectSignals("send me a pic?").intents).toContain("photo_request");
    expect(detectSignals("envoie-moi une photo").intents).toContain("photo_request");
    expect(detectSignals("📷").intents).toContain("photo_request");
    expect(detectSignals("I took a photo class").intents).not.toContain("photo_request");
  });
});

describe("mock image provider", () => {
  it("returns a valid SVG offline", async () => {
    const p = new MockImageProvider({ id: "m", label: "m", adapter: "mock-images", model: "m", enabled: true, priority: 1, capabilities: { romance: true, mature_language: true, suggestive_content: true, adult_content: false }, contextWindow: 0, maxOutputTokens: 0, temperature: 0, roles: ["image"], options: { delayMs: 0 } });
    const img = await p.generate({ prompt: "Candid smartphone selfie of a clearly adult woman. at the beach", aspect: "portrait" });
    expect(img.mimeType).toBe("image/svg+xml");
    expect(detectMime(img.bytes)).toBe("image/svg+xml");
  });
  it("sniffs real formats", () => {
    expect(detectMime(new Uint8Array([0xff, 0xd8, 0xff, 0]))).toBe("image/jpeg");
    expect(detectMime(new Uint8Array([1, 2, 3, 4]))).toBeNull();
  });
});
