import { describe, expect, it } from "vitest";
import { NoCompatibleProviderError, routeProvider } from "@/core/providers/router";
import { SpyProvider } from "./helpers/in-memory";

const safe = () => new SpyProvider({}, { id: "safe", priority: 1 });
const mature = () => new SpyProvider({ mature_language: true, suggestive_content: true }, { id: "mature", priority: 5 });
const adult = () => new SpyProvider({ mature_language: true, suggestive_content: true, adult_content: true }, { id: "adult", priority: 9 });

describe("SafetyRouter", () => {
  it("picks only providers whose capabilities cover the mode, by priority", () => {
    const r = routeProvider({ mode: "MATURE", role: "chat", providers: [safe(), adult(), mature()] });
    expect(r.candidates.map((p) => p.descriptor.id)).toEqual(["mature", "adult"]);
    expect(r.mode).toBe("MATURE");
  });
  it("prefers the user's choice when compatible", () => {
    const r = routeProvider({ mode: "SAFE", role: "chat", providers: [safe(), mature()], preferredProviderId: "mature" });
    expect(r.candidates[0].descriptor.id).toBe("mature");
  });
  it("ignores the user's choice when it is not compatible", () => {
    const r = routeProvider({ mode: "MATURE", role: "chat", providers: [safe(), mature()], preferredProviderId: "safe" });
    expect(r.candidates[0].descriptor.id).toBe("mature");
  });
  it("downgrades and reports when nothing supports the mode", () => {
    const r = routeProvider({ mode: "ADULT", role: "chat", providers: [safe(), mature()] });
    expect(r.mode).toBe("MATURE");
    expect(r.downgradedFrom).toBe("ADULT");
  });
  it("refuses instead when configured to", () => {
    expect(() => routeProvider({ mode: "ADULT", role: "chat", providers: [safe()], fallback: "refuse" })).toThrow(NoCompatibleProviderError);
  });
  it("skips disabled providers and wrong roles", () => {
    const off = new SpyProvider({ mature_language: true, suggestive_content: true }, { id: "off", enabled: false });
    const util = new SpyProvider({ mature_language: true, suggestive_content: true }, { id: "util", roles: ["utility"] });
    const r = routeProvider({ mode: "MATURE", role: "chat", providers: [off, util, safe()] });
    expect(r.mode).toBe("SAFE");
    expect(r.candidates.map((p) => p.descriptor.id)).toEqual(["safe"]);
  });
});
