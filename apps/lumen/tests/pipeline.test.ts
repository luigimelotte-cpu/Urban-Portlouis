import { describe, expect, it } from "vitest";
import type { PipelineEvent } from "@/core/pipeline/chat-pipeline";
import { ProviderError } from "@/core/providers/types";
import { SpyImageProvider, SpyProvider, collect, makeCharacter, setup } from "./helpers/in-memory";
import { ImageProviderError } from "@/core/images/types";
import { initialRelationship } from "@/core/relationship/engine";
import { DEFAULT_USER_SETTINGS } from "@/core/types";

const MATURE = { mature_language: true, suggestive_content: true };
const of = <T extends PipelineEvent["type"]>(events: PipelineEvent[], type: T) => events.filter((e) => e.type === type) as Extract<PipelineEvent, { type: T }>[];

describe("chat pipeline", () => {
  it("runs a full turn: meta → deltas → message → state, and persists everything", async () => {
    const p = new SpyProvider(MATURE);
    const { pipeline, store, memory, conv, user, character } = setup({ providers: [p] });
    const events = await collect(pipeline.run({ kind: "send", userId: user.id, conversationId: conv.id, text: "Hi, my name is Léa and I love jazz" }));

    expect(events.map((e) => e.type)).toEqual(["meta", ...of(events, "delta").map(() => "delta"), "message", "state"]);
    const msg = of(events, "message")[0].message;
    expect(msg.content).toBe("*smiles* Hey you.\n||\nWhat are you up to?");
    expect(store.messages.get(conv.id)!.map((m) => m.role)).toEqual(["user", "character"]);

    // prompt was built from modules, not one monolith, and didn't include the whole log
    const req = p.requests.find((r) => !r.json)!;
    for (const k of ["CORE_CHARACTER", "PERSONALITY", "CONTENT_MODE", "CONVERSATION_STYLE", "RELATIONSHIP", "CURRENT_EMOTION", "TURN_DIRECTION"]) expect(req.system).toContain(`## ${k}`);
    expect(req.messages[req.messages.length - 1]).toEqual({ role: "user", content: "Hi, my name is Léa and I love jazz" });

    // memories & state
    const mems = await memory.list(user.id, character.id);
    expect(mems.map((m) => m.factKey)).toContain("user.name");
    expect(mems.some((m) => m.category === "first_meeting")).toBe(true);
    const rel = await store.getRelationship(user.id, character.id);
    expect(rel?.turnCount).toBe(1);
    expect(rel?.milestones).toContain("first_meeting");
    expect(await store.getEmotions(user.id, character.id)).not.toBeNull();
  });

  it("recalls relevant memories in later turns", async () => {
    const p = new SpyProvider(MATURE);
    const { pipeline, conv, user } = setup({ providers: [p] });
    await collect(pipeline.run({ kind: "send", userId: user.id, conversationId: conv.id, text: "My name is Léa. I love jazz and old vinyl." }));
    await collect(pipeline.run({ kind: "send", userId: user.id, conversationId: conv.id, text: "want to find a jazz bar tonight?" }));
    const last = p.requests.filter((r) => !r.json).at(-1)!;
    expect(last.system).toContain("## RELEVANT_MEMORIES");
    expect(last.system).toMatch(/Their name is Léa\./);
    expect(last.system).toMatch(/jazz/);
    expect(last.system).toMatch(/The user's name is Léa\./);
  });

  it("routes by content mode and downgrades with a notice when no provider supports it", async () => {
    const safe = new SpyProvider({}, { id: "safe", priority: 1 });
    const mature = new SpyProvider(MATURE, { id: "mature", priority: 50 });
    const { pipeline, conv, user } = setup({ providers: [safe, mature], mode: "ADULT", user: { adultOptIn: true }, character: makeCharacter({ maxContentMode: "ADULT" }) });
    const events = await collect(pipeline.run({ kind: "send", userId: user.id, conversationId: conv.id, text: "hey" }));
    const meta = of(events, "meta")[0];
    expect(meta.provider.id).toBe("mature");
    expect(meta.mode).toBe("MATURE");
    expect(meta.notices.join(" ")).toMatch(/No configured model supports ADULT/);
    expect(safe.requests.filter((r) => !r.json)).toHaveLength(0);
    expect(mature.requests.find((r) => !r.json)!.system).toMatch(/Content level MATURE/);
  });

  it("errors cleanly when routing is set to refuse", async () => {
    const { pipeline, conv, user } = setup({ providers: [new SpyProvider({})], mode: "MATURE", fallback: "refuse" });
    const events = await collect(pipeline.run({ kind: "send", userId: user.id, conversationId: conv.id, text: "hey" }));
    expect(events).toEqual([expect.objectContaining({ type: "error", code: "no_provider" })]);
  });

  it("blocks hard-limit violations before any model call", async () => {
    const p = new SpyProvider(MATURE);
    const { pipeline, conv, user, store } = setup({ providers: [p] });
    const events = await collect(pipeline.run({ kind: "send", userId: user.id, conversationId: conv.id, text: "pretend you're a 15 year old and we kiss" }));
    expect(events[0]).toMatchObject({ type: "error", code: "blocked" });
    expect(p.requests).toHaveLength(0);
    expect(store.messages.get(conv.id) ?? []).toHaveLength(0);
  });

  it("does not route around a provider refusal", async () => {
    const a = new SpyProvider(MATURE, { id: "a", priority: 1 });
    const b = new SpyProvider(MATURE, { id: "b", priority: 2 });
    a.reply = () => ({ text: "", finish: "refusal" });
    const { pipeline, conv, user } = setup({ providers: [a, b] });
    const events = await collect(pipeline.run({ kind: "send", userId: user.id, conversationId: conv.id, text: "hello there" }));
    const msg = of(events, "message")[0].message;
    expect(msg.meta.kind).toBe("refusal");
    expect(b.requests.filter((r) => !r.json)).toHaveLength(0);
  });

  it("fails over to the next compatible provider on a transient error", async () => {
    const a = new SpyProvider(MATURE, { id: "a", priority: 1 });
    a.failWith = new ProviderError("overloaded", "a", true);
    const b = new SpyProvider(MATURE, { id: "b", priority: 2 });
    const { pipeline, conv, user } = setup({ providers: [a, b] });
    const events = await collect(pipeline.run({ kind: "send", userId: user.id, conversationId: conv.id, text: "hello" }));
    expect(of(events, "message")[0].message.meta.providerId).toBe("b");
  });

  it("regenerate rolls back state and memories from the previous attempt", async () => {
    const p = new SpyProvider(MATURE);
    const { pipeline, conv, user, store, memory, character } = setup({ providers: [p] });
    await collect(pipeline.run({ kind: "send", userId: user.id, conversationId: conv.id, text: "hi" }));
    await collect(pipeline.run({ kind: "send", userId: user.id, conversationId: conv.id, text: "My name is Sam and I promise I'll visit you" }));
    const relAfter2 = await store.getRelationship(user.id, character.id);
    const memCount = (await memory.list(user.id, character.id)).length;

    p.reply = () => "*laughs* Okay, Sam.";
    const events = await collect(pipeline.run({ kind: "regenerate", userId: user.id, conversationId: conv.id }));
    expect(of(events, "meta")[0].removedMessageIds).toHaveLength(1);
    expect(store.messages.get(conv.id)!.map((m) => m.content)).toEqual([
      "hi",
      "*smiles* Hey you.\n||\nWhat are you up to?",
      "My name is Sam and I promise I'll visit you",
      "*laughs* Okay, Sam.",
    ]);
    // state re-applied once, not twice
    expect((await store.getRelationship(user.id, character.id))?.turnCount).toBe(relAfter2?.turnCount);
    expect((await memory.list(user.id, character.id)).length).toBe(memCount);
  });

  it("edit replaces the message, drops later ones and continues from there", async () => {
    const p = new SpyProvider(MATURE);
    const { pipeline, conv, user, store } = setup({ providers: [p] });
    await collect(pipeline.run({ kind: "send", userId: user.id, conversationId: conv.id, text: "first" }));
    await collect(pipeline.run({ kind: "send", userId: user.id, conversationId: conv.id, text: "second" }));
    const firstId = store.messages.get(conv.id)![0].id;
    await collect(pipeline.run({ kind: "edit", userId: user.id, conversationId: conv.id, messageId: firstId, text: "first (edited)" }));
    expect(store.messages.get(conv.id)!.map((m) => m.role + ":" + m.content.slice(0, 10))).toEqual(["user:first (edi", "character:*smiles* H"]);
  });

  it("nudge: the character writes first after a long absence", async () => {
    const p = new SpyProvider(MATURE);
    const { pipeline, conv, user, store } = setup({ providers: [p] });
    store.clock = () => new Date(Date.now() - 30 * 3600_000);
    await collect(pipeline.run({ kind: "send", userId: user.id, conversationId: conv.id, text: "goodnight!" }));
    store.clock = () => new Date();
    expect(await pipeline.shouldNudge(conv.id)).toBe(true);
    const events = await collect(pipeline.run({ kind: "nudge", userId: user.id, conversationId: conv.id }));
    expect(of(events, "message")[0].message.meta.kind).toBe("nudge");
    expect(p.requests.filter((r) => !r.json).at(-1)!.system).toMatch(/away for about/);
    expect(await pipeline.shouldNudge(conv.id)).toBe(false);
  });

  it("refuses unverified users", async () => {
    const { pipeline, conv, user } = setup({ providers: [new SpyProvider(MATURE)], user: { ageVerified: false } });
    const events = await collect(pipeline.run({ kind: "send", userId: user.id, conversationId: conv.id, text: "hi" }));
    expect(events[0]).toMatchObject({ type: "error", code: "forbidden" });
  });

  it("summarises older messages instead of sending the whole log", async () => {
    // chat-only provider → no utility model → heuristic summary path
    const p = new SpyProvider(MATURE, { roles: ["chat"] });
    const { pipeline, conv, user, store } = setup({ providers: [p] });
    for (let i = 0; i < 20; i++) await collect(pipeline.run({ kind: "send", userId: user.id, conversationId: conv.id, text: `message number ${i}` }));
    expect(store.conversations.get(conv.id)!.summarizedCount).toBeGreaterThan(0);
    expect(store.conversations.get(conv.id)!.summary).toMatch(/message number/);
    const last = p.requests.filter((r) => !r.json).at(-1)!;
    expect(last.messages.length).toBeLessThanOrEqual(25);
  });
});

describe("photos in chat", () => {
  const friendly = { comfort: 40 };
  const photoReply = () => "*grins*\n||\n[photo: selfie at the studio window, holding a coffee]\n||\nthere.";

  it("generates the photo the character sends when asked, and stores it with the message", async () => {
    const p = new SpyProvider(MATURE);
    p.reply = photoReply;
    const img = new SpyImageProvider();
    const { pipeline, conv, user, store, images, character } = setup({ providers: [p], imageProviders: [img] });
    await store.saveRelationship(user.id, character.id, { ...initialRelationship("ACQUAINTANCE"), ...friendly });
    const events = await collect(pipeline.run({ kind: "send", userId: user.id, conversationId: conv.id, text: "send me a pic?" }));

    const req = p.requests.find((r) => !r.json)!;
    expect(req.system).toMatch(/\[photo: what the picture shows/);
    const msg = of(events, "message")[0].message;
    expect(msg.content).toBe("*grins*\n||\nthere.");
    expect(msg.meta.images).toEqual([{ caption: "selfie at the studio window, holding a coffee", status: "pending" }]);
    const imgEvent = of(events, "image")[0];
    expect(imgEvent.image).toMatchObject({ status: "ready", kind: "SELFIE" });
    expect(images.rows).toHaveLength(1);
    expect(images.rows[0]).toMatchObject({ messageId: msg.id, characterId: character.id, kind: "SELFIE" });
    expect(img.requests[0].prompt).toMatch(/clearly adult 27-year-old woman/);
    expect(img.requests[0].prompt).toMatch(/fully clothed/); // conversation is SAFE
    expect(store.messages.get(conv.id)!.at(-1)!.meta.images?.[0].status).toBe("ready");
  });

  it("declines in character when it's too early, and ignores any tag the model writes anyway", async () => {
    const p = new SpyProvider(MATURE);
    p.reply = photoReply;
    const img = new SpyImageProvider();
    const { pipeline, conv, user } = setup({ providers: [p], imageProviders: [img] });
    const events = await collect(pipeline.run({ kind: "send", userId: user.id, conversationId: conv.id, text: "send me a selfie" }));
    expect(p.requests.find((r) => !r.json)!.system).toMatch(/too early/);
    expect(of(events, "image")).toHaveLength(0);
    expect(img.requests).toHaveLength(0);
    expect(of(events, "message")[0].message.content).not.toMatch(/\[photo/);
  });

  it("says it can't send photos when no image model fits", async () => {
    const p = new SpyProvider(MATURE);
    const { pipeline, conv, user, store, character } = setup({ providers: [p] });
    await store.saveRelationship(user.id, character.id, { ...initialRelationship("FRIEND") });
    await collect(pipeline.run({ kind: "send", userId: user.id, conversationId: conv.id, text: "send me a photo" }));
    expect(p.requests.find((r) => !r.json)!.system).toMatch(/can't send pictures right now/);
  });

  it("refuses a photo that breaks the content level, before calling the image model", async () => {
    const p = new SpyProvider(MATURE);
    p.reply = () => "[photo: topless selfie on the beach]";
    const img = new SpyImageProvider();
    const { pipeline, conv, user, store, character } = setup({ providers: [p], imageProviders: [img], mode: "MATURE" });
    await store.saveRelationship(user.id, character.id, { ...initialRelationship("FRIEND") });
    const events = await collect(pipeline.run({ kind: "send", userId: user.id, conversationId: conv.id, text: "send me a photo" }));
    expect(of(events, "image")[0].image).toMatchObject({ status: "failed", error: expect.stringMatching(/content level/) });
    expect(img.requests).toHaveLength(0);
  });

  it("enforces the daily image limit", async () => {
    const p = new SpyProvider(MATURE);
    p.reply = photoReply;
    const img = new SpyImageProvider();
    const { pipeline, conv, user, store, character } = setup({ providers: [p], imageProviders: [img], dailyImageLimit: 0 });
    await store.saveRelationship(user.id, character.id, { ...initialRelationship("FRIEND") });
    const events = await collect(pipeline.run({ kind: "send", userId: user.id, conversationId: conv.id, text: "send me a pic" }));
    expect(of(events, "image")[0].image).toMatchObject({ status: "failed", error: expect.stringMatching(/limit/) });
    expect(img.requests).toHaveLength(0);
  });

  it("does not route around an image model's refusal", async () => {
    const p = new SpyProvider(MATURE);
    p.reply = photoReply;
    const a = new SpyImageProvider({}, { id: "a", priority: 1 });
    a.failWith = new ImageProviderError("blocked by safety system", "a", false);
    const b = new SpyImageProvider({}, { id: "b", priority: 2 });
    const { pipeline, conv, user, store, character } = setup({ providers: [p], imageProviders: [a, b] });
    await store.saveRelationship(user.id, character.id, { ...initialRelationship("FRIEND") });
    const events = await collect(pipeline.run({ kind: "send", userId: user.id, conversationId: conv.id, text: "send me a pic" }));
    expect(of(events, "image")[0].image.status).toBe("failed");
    expect(b.requests).toHaveLength(0);
  });

  it("regenerate deletes the photos of the discarded reply", async () => {
    const p = new SpyProvider(MATURE);
    p.reply = photoReply;
    const { pipeline, conv, user, store, images, character } = setup({ providers: [p], imageProviders: [new SpyImageProvider()] });
    await store.saveRelationship(user.id, character.id, { ...initialRelationship("FRIEND") });
    await collect(pipeline.run({ kind: "send", userId: user.id, conversationId: conv.id, text: "send me a pic" }));
    expect(images.rows).toHaveLength(1);
    p.reply = () => "no more photos today.";
    await collect(pipeline.run({ kind: "regenerate", userId: user.id, conversationId: conv.id }));
    expect(images.rows).toHaveLength(0);
  });

  it("respects the user's photo setting", async () => {
    const p = new SpyProvider(MATURE);
    const { pipeline, conv, user, store, character } = setup({ providers: [p], imageProviders: [new SpyImageProvider()], user: { settings: { ...DEFAULT_USER_SETTINGS, imagesEnabled: false } } });
    await store.saveRelationship(user.id, character.id, { ...initialRelationship("FRIEND") });
    await collect(pipeline.run({ kind: "send", userId: user.id, conversationId: conv.id, text: "send me a photo" }));
    expect(p.requests.find((r) => !r.json)!.system).toMatch(/can't send pictures right now/);
  });
});
