import { describe, expect, it } from "vitest";
import { buildPrompt, type PromptModule } from "@/core/prompt/builder";
import { estimateTokens } from "@/core/providers/tokens";

const mod = (key: PromptModule["key"], priority: number, size: number, extra: Partial<PromptModule> = {}): PromptModule => ({ key, priority, text: "x".repeat(size), ...extra });

describe("prompt builder", () => {
  const recent = Array.from({ length: 20 }, (_, i) => ({ role: (i % 2 ? "assistant" : "user") as "user" | "assistant", content: `message ${i} `.repeat(20) }));

  it("keeps everything when under budget, in canonical order", () => {
    const p = buildPrompt({ modules: [mod("RELEVANT_MEMORIES", 75, 100), mod("CORE_CHARACTER", 100, 100, { required: true })], recent: recent.slice(0, 2), budget: 10000, estimate: estimateTokens });
    expect(new Set(p.included)).toEqual(new Set(["RELEVANT_MEMORIES", "CORE_CHARACTER"]));
    expect(p.system.indexOf("CORE_CHARACTER")).toBeLessThan(p.system.indexOf("RELEVANT_MEMORIES"));
    expect(p.dropped).toEqual([]);
  });

  it("compacts, then drops lowest-priority modules first, never required ones", () => {
    const modules = [
      mod("CORE_CHARACTER", 100, 2000, { required: true }),
      mod("CONVERSATION_SUMMARY", 55, 3000),
      mod("CURRENT_SCENARIO", 60, 3000, { compact: "short scenario" }),
      mod("RELEVANT_MEMORIES", 75, 1500),
    ];
    const p = buildPrompt({ modules, recent: recent.slice(-4), budget: 1700, estimate: estimateTokens });
    expect(p.compacted).toContain("CURRENT_SCENARIO");
    expect(p.dropped[0]).toBe("CONVERSATION_SUMMARY");
    expect(p.included).toContain("CORE_CHARACTER");
    expect(p.tokens).toBeLessThanOrEqual(1700);
  });

  it("trims the oldest messages and always starts with a user turn", () => {
    const p = buildPrompt({ modules: [mod("CORE_CHARACTER", 100, 200, { required: true })], recent, budget: 600, estimate: estimateTokens });
    expect(p.droppedMessages).toBeGreaterThan(0);
    expect(p.messages[0].role).toBe("user");
    expect(p.messages[p.messages.length - 1]).toEqual(recent[recent.length - 1]);
  });
});
