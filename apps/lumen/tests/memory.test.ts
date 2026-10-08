import { describe, expect, it } from "vitest";
import { detectSignals } from "@/core/intent/detect";
import { LocalHashEmbedder, cosine } from "@/core/memory/embeddings";
import { consolidate, formatMemoriesForPrompt, memoryStrength, rankMemories, selectForgettable, type MemoryRecord } from "@/core/memory/engine";
import { extractHeuristicMemories, parseLlmMemories } from "@/core/memory/extractor";

const emb = new LocalHashEmbedder(256);
const rec = (over: Partial<MemoryRecord>): MemoryRecord => ({
  id: Math.random().toString(36).slice(2),
  kind: "LONG_TERM",
  category: "fact",
  content: "x",
  importance: 0.5,
  reinforcement: 0,
  lastAccessedAt: new Date(),
  timestamp: new Date(),
  embedding: null,
  ...over,
});

describe("heuristic extraction", () => {
  it("captures name, job, likes and people (EN)", () => {
    const text = "Hi! My name is Léa, I work as an architect and I love brutalist buildings. My sister Inès visits tomorrow.";
    const m = extractHeuristicMemories(text, detectSignals(text), { characterName: "Mila", isFirstTurn: true });
    const keys = m.map((x) => x.factKey);
    expect(keys).toContain("user.name");
    expect(m.find((x) => x.factKey === "user.name")?.content).toBe("Their name is Léa.");
    expect(keys).toContain("user.occupation");
    expect(keys.some((k) => k?.startsWith("user.likes:"))).toBe(true);
    expect(keys.some((k) => k?.startsWith("user.person:"))).toBe(true);
    expect(m.some((x) => x.category === "first_meeting")).toBe(true);
  });
  it("works in French and ignores 'I like you'", () => {
    const text = "Je m'appelle Hugo et j'adore le jazz. I like you.";
    const m = extractHeuristicMemories(text, detectSignals(text), { characterName: "Mila", isFirstTurn: false });
    expect(m.find((x) => x.factKey === "user.name")?.content).toBe("Their name is Hugo.");
    expect(m.filter((x) => x.category === "preference").map((x) => x.content)).toEqual(["They love jazz."]);
  });
  it("catches an introduction mid-sentence but not adjectives", () => {
    const a = "*waves* Hi... I'm Luigi. I really can't swim";
    expect(extractHeuristicMemories(a, detectSignals(a), { characterName: "A", isFirstTurn: false }).find((x) => x.factKey === "user.name")?.content).toBe("Their name is Luigi.");
    const c = "i'm exhausted. long day";
    expect(extractHeuristicMemories(c, detectSignals(c), { characterName: "A", isFirstTurn: false }).find((x) => x.factKey === "user.name")).toBeUndefined();
    const b = "honestly I'm Tired. long day";
    expect(extractHeuristicMemories(b, detectSignals(b), { characterName: "A", isFirstTurn: false }).find((x) => x.factKey === "user.name")).toBeUndefined();
  });
  it("records promises as important episodes", () => {
    const text = "I promise I'll come to your show on Friday";
    const m = extractHeuristicMemories(text, detectSignals(text), { characterName: "Noor", isFirstTurn: false });
    expect(m.find((x) => x.category === "promise")?.importance).toBeGreaterThanOrEqual(0.8);
  });
});

describe("LLM extraction parsing", () => {
  it("parses valid JSON wrapped in text and rejects junk", () => {
    const raw = 'Sure: {"memories":[{"kind":"LONG_TERM","category":"name","content":"Their name is Sam.","importance":0.9,"factKey":"user.name"}]}';
    expect(parseLlmMemories(raw)?.[0].factKey).toBe("user.name");
    expect(parseLlmMemories("not json")).toBeNull();
    expect(parseLlmMemories('{"memories":[{"kind":"WRONG"}]}')).toBeNull();
  });
});

describe("consolidation", () => {
  it("updates a fact with the same key instead of duplicating", async () => {
    const [e1] = await emb.embed(["Their name is Sam."]);
    const existing = [rec({ id: "a", factKey: "user.name", content: "Their name is Sam.", embedding: e1 })];
    const [e2] = await emb.embed(["Their name is Samuel."]);
    const actions = consolidate([{ candidate: { kind: "LONG_TERM", category: "name", content: "Their name is Samuel.", importance: 0.9, factKey: "user.name" }, embedding: e2 }], existing);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ type: "update", id: "a" });
  });
  it("reinforces near-duplicates and dedupes within a batch", async () => {
    const text = "They love old jazz records.";
    const [e] = await emb.embed([text]);
    const existing = [rec({ id: "j", content: text, embedding: e, category: "preference" })];
    const actions = consolidate(
      [
        { candidate: { kind: "LONG_TERM", category: "preference", content: text, importance: 0.5 }, embedding: e },
        { candidate: { kind: "EPISODIC", category: "promise", content: "Promised to visit", importance: 0.8 }, embedding: (await emb.embed(["Promised to visit"]))[0] },
        { candidate: { kind: "EPISODIC", category: "promise", content: "Promised to visit", importance: 0.8 }, embedding: (await emb.embed(["Promised to visit"]))[0] },
      ],
      existing,
    );
    expect(actions.map((a) => a.type)).toEqual(["reinforce", "insert", "reinforce"]);
  });
});

describe("retrieval & forgetting", () => {
  it("ranks semantically relevant memories first and drops near-duplicates", async () => {
    const texts = ["They love jazz and piano bars.", "They love jazz and piano bars!", "Their sister is called Inès.", "They hate mornings."];
    const es = await emb.embed(texts);
    const mems = texts.map((t, i) => rec({ id: String(i), content: t, embedding: es[i] }));
    const [q] = await emb.embed(["want to go to a jazz bar?"]);
    const ranked = rankMemories(mems, q, { k: 3 });
    expect(ranked[0].memory.content).toMatch(/jazz/);
    expect(ranked.filter((r) => /jazz/.test(r.memory.content))).toHaveLength(1);
  });
  it("forgets weak old episodes but keeps facts and milestones", () => {
    const old = new Date(Date.now() - 200 * 86400000);
    const mems = [
      rec({ id: "trivia", kind: "EPISODIC", category: "shared_event", importance: 0.2, lastAccessedAt: old }),
      rec({ id: "fact", kind: "LONG_TERM", category: "name", importance: 0.95, lastAccessedAt: old }),
      rec({ id: "milestone", kind: "EPISODIC", category: "milestone", importance: 0.2, lastAccessedAt: old }),
      rec({ id: "fresh", kind: "EPISODIC", category: "shared_event", importance: 0.2 }),
    ];
    expect(selectForgettable(mems)).toEqual(["trivia"]);
    expect(memoryStrength(mems[3])).toBeGreaterThan(memoryStrength(mems[0]));
  });
  it("formats facts and moments separately", () => {
    const out = formatMemoriesForPrompt([
      { memory: rec({ content: "Their name is Sam." }), similarity: 1, score: 1 },
      { memory: rec({ kind: "EPISODIC", category: "promise", content: "They promised to come." }), similarity: 1, score: 1 },
    ]);
    expect(out).toMatch(/What you know about them:\n- Their name is Sam\./);
    expect(out).toMatch(/Moments you remember together:\n- They promised to come\./);
  });
  it("local embeddings put related text closer than unrelated text", async () => {
    const [a, b, c] = await emb.embed(["I adore jazz music", "jazz musicians are amazing", "my car broke down on the highway"]);
    expect(cosine(a, b)).toBeGreaterThan(cosine(a, c));
  });
});
