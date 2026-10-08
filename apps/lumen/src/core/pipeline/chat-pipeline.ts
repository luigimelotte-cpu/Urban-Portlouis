import { describePlan, mulberry32, planTurn, type TurnPlan } from "../character/planner";
import type { Character } from "../character/profile";
import { REFUSAL_LINES, checkHardLimits, resolveConversationMode } from "../content/policy";
import { appraise, baselineFromTraits, describeEmotions, dominantEmotions, updateEmotions } from "../emotion/engine";
import { detectSignals, type TurnSignals } from "../intent/detect";
import type { Embedder } from "../memory/embeddings";
import {
  consolidate,
  formatMemoriesForPrompt,
  rankMemories,
  selectForgettable,
  type MemoryCandidate,
  type ScoredMemory,
} from "../memory/engine";
import { extractHeuristicMemories, memoryExtractionPrompt, mergeCandidates, parseLlmMemories } from "../memory/extractor";
import { buildPrompt } from "../prompt/builder";
import {
  contentModeModule,
  coreCharacterModule,
  emotionModule,
  memoriesModule,
  personalityModule,
  relationshipModule,
  scenarioModule,
  styleModule,
  summaryModule,
  turnDirectionModule,
} from "../prompt/modules";
import { NoCompatibleProviderError, routeProvider } from "../providers/router";
import { ProviderError, type LLMMessage, type ModelProvider } from "../providers/types";
import { initialRelationship, summarizeRelationship, updateRelationship, type RelationshipUpdate } from "../relationship/engine";
import { postProcessReply } from "../style/postprocess";
import { checkImagePrompt, NEGATIVE_PROMPT, photoPrompt, seedFor } from "../images/prompt";
import { extractPhotoTags } from "../images/tags";
import { ImageProviderError, type ImageProvider } from "../images/types";
import { RELATIONSHIP_STAGES, type ContentMode, type EmotionVector, type RelationshipState, type UserContext } from "../types";
import type {
  ChatStore,
  ConversationRecord,
  ImageProviderSource,
  ImageStore,
  MemoryStore,
  MessageImage,
  MessageMeta,
  PlatformSettings,
  ProviderSource,
  StoredMessage,
} from "./ports";

// ─── Public types ───────────────────────────────────────────────────────────

export type TurnRequest =
  | { kind: "send"; userId: string; conversationId: string; text: string }
  | { kind: "regenerate"; userId: string; conversationId: string }
  | { kind: "edit"; userId: string; conversationId: string; messageId: string; text: string }
  | { kind: "nudge"; userId: string; conversationId: string };

export type PipelineEvent =
  | {
      type: "meta";
      mode: ContentMode;
      requestedMode: ContentMode;
      provider: { id: string; label: string; model: string };
      notices: string[];
      userMessage?: StoredMessage;
      removedMessageIds?: string[];
    }
  | { type: "delta"; text: string }
  | { type: "image"; messageId: string; index: number; image: MessageImage }
  | { type: "message"; message: StoredMessage }
  | {
      type: "state";
      relationship: RelationshipState;
      stageChanged?: RelationshipUpdate["stageChanged"];
      emotions: { emotion: string; value: number }[];
      newMemories: number;
    }
  | { type: "error"; code: "not_found" | "forbidden" | "blocked" | "no_provider" | "provider_error" | "invalid"; message: string };

export interface PipelineDeps {
  store: ChatStore;
  memory: MemoryStore;
  providers: ProviderSource;
  embedder: Embedder;
  settings: PlatformSettings;
  /** Optional: photo generation. Without it characters simply can't send pictures. */
  images?: { providers: ImageProviderSource; store: ImageStore; dailyLimit?: number };
  now?: () => Date;
}

export const DEFAULT_DAILY_IMAGE_LIMIT = 40;
/** Minimum character turns between two photos the character sends on its own. */
const SPONTANEOUS_PHOTO_GAP = 8;

/** Recent messages loaded per turn — the model never gets the full log. */
export const RECENT_WINDOW = 24;
const SUMMARY_TRIGGER = 12;
const NUDGE_AFTER_HOURS = 6;

// ─── Pipeline ───────────────────────────────────────────────────────────────

export class ChatPipeline {
  constructor(private deps: PipelineDeps) {}

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  async *run(req: TurnRequest, signal?: AbortSignal): AsyncGenerator<PipelineEvent> {
    const { store } = this.deps;

    // ── Load context ────────────────────────────────────────────────────────
    const user = await store.getUser(req.userId);
    const conv = await store.getConversation(req.conversationId, req.userId);
    if (!user || !conv) return yield { type: "error", code: "not_found", message: "Conversation not found." };
    if (!user.ageVerified) return yield { type: "error", code: "forbidden", message: "Age verification required." };
    const character = await store.getCharacter(conv.characterId);
    if (!character) return yield { type: "error", code: "not_found", message: "Character not found." };

    // ── 1. Receive / prepare the user message ──────────────────────────────
    const prep = await this.prepareTurn(req, conv, character);
    if ("error" in prep) return yield prep.error;
    const { userMessage, removedMessageIds } = prep;
    let { relationship, emotions } = prep;
    const userText = userMessage?.content ?? "";

    // ── 2. Detect intent ───────────────────────────────────────────────────
    const history = await store.listMessages(conv.id, { limit: RECENT_WINDOW + 1 });
    const prior = history.filter((m) => m.id !== userMessage?.id);
    const lastPrior = prior[prior.length - 1];
    const absenceHours = lastPrior ? (this.now().getTime() - lastPrior.createdAt.getTime()) / 3_600_000 : 0;
    const signals = detectSignals(userText, { absenceHours });

    // ── 3–5. Relationship + emotion (updated *before* generation so the reply
    //         reflects them, persisted after) ────────────────────────────────
    const traits = character.profile.traits;
    const baseline = baselineFromTraits(traits);
    const relUpdate: RelationshipUpdate =
      req.kind === "nudge"
        ? { state: relationship, deltas: {}, newMilestones: [] }
        : updateRelationship(relationship, signals, traits);
    const elapsedMin = emotions ? (this.now().getTime() - emotions.updatedAt.getTime()) / 60000 : 0;
    const nextEmotions = updateEmotions(
      emotions?.values ?? baseline,
      req.kind === "nudge" ? {} : appraise(signals, traits, relationship),
      baseline,
      elapsedMin,
    );

    // ── 7–8. Content mode + provider routing ───────────────────────────────
    const requestedMode = conv.contentMode;
    const resolution = resolveConversationMode({
      requested: requestedMode,
      user,
      character,
      platformCeiling: await this.deps.settings.contentCeiling(),
    });
    const notices: string[] = resolution.limitedBy.map(limitNotice);
    const allProviders = await this.deps.providers.list();
    let route;
    try {
      route = routeProvider({
        mode: resolution.mode,
        role: "chat",
        providers: allProviders,
        preferredProviderId: user.settings.preferredProviderId,
        fallback: await this.deps.settings.routingFallback(),
      });
    } catch (e) {
      if (e instanceof NoCompatibleProviderError)
        return yield { type: "error", code: "no_provider", message: `No model is configured for ${resolution.mode} mode. Choose a lower content mode or ask the admin to add a compatible provider.` };
      throw e;
    }
    if (route.downgradedFrom)
      notices.push(`No configured model supports ${route.downgradedFrom} mode — this reply uses ${route.mode}.`);
    const mode = route.mode;
    const primary = route.candidates[0];

    yield {
      type: "meta",
      mode,
      requestedMode,
      provider: { id: primary.descriptor.id, label: primary.descriptor.label, model: primary.descriptor.model },
      notices,
      userMessage,
      removedMessageIds,
    };

    // ── Hard-limit + provider moderation on input ──────────────────────────
    if (userText) {
      const mod = await primary.moderateInput(userText);
      if (!mod.allowed) {
        const refusal = await this.saveCharacterMessage(conv, character, pick(REFUSAL_LINES), {
          kind: "refusal",
          mode,
          notices: [`Blocked by content policy: ${mod.violations.join(", ")}`],
        });
        yield { type: "message", message: refusal };
        // Roll the turn's state changes back — nothing "happened".
        yield this.stateEvent(relationship, emotions?.values ?? baseline, baseline, undefined, 0);
        return;
      }
    }

    // ── 3. Retrieve memories ───────────────────────────────────────────────
    const memoryOn = user.settings.memoryEnabled;
    const recalled = memoryOn ? await this.recall(user, character, userText || lastPrior?.content || "") : [];

    // ── 9. Build context ───────────────────────────────────────────────────
    const userName = recalled.find((r) => r.memory.factKey === "user.name")?.memory.content.match(/is ([^.]+)\./)?.[1] ?? user.displayName;
    const plan = planTurn({
      traits,
      style: conv.style,
      signals,
      relationship: relUpdate.state,
      goals: character.profile.characterGoals,
      hasMemories: recalled.length > 0,
      seed: hashSeed(`${conv.id}:${history.length}:${userText}:${req.kind}`),
    });
    // Photos: who can send, and whether this turn invites one.
    const imageRoute = user.settings.imagesEnabled !== false ? await this.routeImages(mode) : null;
    const photo = photoDirective({
      signals,
      rel: relUpdate.state,
      canSend: !!imageRoute,
      plan,
      history: prior,
      initiative: traits.initiative,
      seed: hashSeed(`${conv.id}:photo:${history.length}`),
    });
    const turnText = [
      req.kind === "nudge" ? nudgeDirection(absenceHours) : "",
      describePlan(plan, conv.style),
      photo.text,
    ]
      .filter(Boolean)
      .join("\n");

    const modules = [
      coreCharacterModule(character, userName),
      personalityModule(character),
      contentModeModule(mode),
      styleModule(conv.style),
      scenarioModule(character),
      relationshipModule(summarizeRelationship(relUpdate.state), relUpdate.directive),
      emotionModule(describeEmotions(nextEmotions, baseline)),
      memoriesModule(formatMemoriesForPrompt(recalled), formatMemoriesForPrompt(recalled.slice(0, 3))),
      summaryModule(conv.summary),
      turnDirectionModule(turnText),
    ];
    const recent = toLLMMessages(history, req.kind === "nudge");
    const opts = primary.descriptor.options ?? {};
    const budget = Math.min(
      primary.descriptor.contextWindow - primary.descriptor.maxOutputTokens - 300,
      Number(opts.maxPromptTokens ?? 16000),
    );
    const prompt = buildPrompt({ modules, recent, budget, estimate: (s) => primary.estimateTokens(s) });

    // ── 10. Generate (streaming, with failover on transient errors) ────────
    let raw = "";
    let finish: string = "stop";
    let used: ModelProvider = primary;
    let usage: { inputTokens?: number; outputTokens?: number } | undefined;
    for (const candidate of route.candidates) {
      used = candidate;
      try {
        for await (const chunk of candidate.streamResponse({
          system: prompt.system,
          messages: prompt.messages,
          maxOutputTokens: candidate.descriptor.maxOutputTokens,
          temperature: candidate.descriptor.temperature,
          signal,
        })) {
          if (chunk.type === "text") {
            raw += chunk.text;
            yield { type: "delta", text: chunk.text };
          } else {
            finish = chunk.result.finishReason;
            usage = chunk.result.usage;
          }
        }
        break;
      } catch (e) {
        if (signal?.aborted) break;
        const retryable = e instanceof ProviderError && e.retryable && raw === "";
        if (retryable && candidate !== route.candidates[route.candidates.length - 1]) {
          notices.push(`${candidate.descriptor.label} unavailable, switched provider.`);
          continue;
        }
        return yield { type: "error", code: "provider_error", message: e instanceof Error ? e.message : "Generation failed." };
      }
    }

    // ── Output handling ────────────────────────────────────────────────────
    let content = postProcessReply(raw, character.name);
    let kind: MessageMeta["kind"] = req.kind === "nudge" ? "nudge" : "reply";
    if (finish === "refusal") {
      // The provider declined. We don't retry elsewhere to get around it.
      content = pick(REFUSAL_LINES);
      kind = "refusal";
      notices.push("The model declined this turn.");
    } else {
      const outMod = await used.moderateOutput(content);
      if (!outMod.allowed) {
        content = pick(REFUSAL_LINES);
        kind = "refusal";
        notices.push("Reply withheld by content policy.");
      }
    }
    const tagged = extractPhotoTags(content);
    const photos = kind !== "refusal" && photo.allowed && imageRoute ? tagged.photos : [];
    content = tagged.text || (photos.length ? "📷" : content);
    if (!content) content = "…";

    const reply = await this.saveCharacterMessage(conv, character, content, {
      kind,
      ...(photos.length ? { images: photos.map((caption) => ({ caption, status: "pending" as const })) } : {}),
      providerId: used.descriptor.id,
      model: used.descriptor.model,
      mode,
      intent: signals.intent,
      tokensIn: usage?.inputTokens ?? prompt.tokens,
      tokensOut: usage?.outputTokens,
      notices,
      prompt: { included: prompt.included, dropped: prompt.dropped, compacted: prompt.compacted, droppedMessages: prompt.droppedMessages },
    });
    yield { type: "message", message: reply };

    // ── Photos the character chose to send ─────────────────────────────────
    if (photos.length && imageRoute) {
      const images: MessageImage[] = [...(reply.meta.images ?? [])];
      for (let i = 0; i < photos.length; i++) {
        images[i] = await this.generatePhoto({ user, character, conv, messageId: reply.id, description: photos[i], route: imageRoute });
        yield { type: "image", messageId: reply.id, index: i, image: images[i] };
      }
      await store.updateMessage(reply.id, { meta: { ...reply.meta, images } });
    }

    // ── 11–14. Memories, emotion, relationship, summary ────────────────────
    let newMemoryIds: string[] = [];
    if (memoryOn && userMessage && kind !== "refusal") {
      newMemoryIds = await this.extractAndStoreMemories({
        user,
        character,
        conv,
        userText,
        reply: content,
        signals,
        relUpdate,
        mode,
        allProviders,
        isFirstTurn: relationship.turnCount === 0,
      }).catch(() => []);
      if (newMemoryIds.length) {
        await store.updateMessage(userMessage.id, { meta: { ...userMessage.meta, memoryIds: newMemoryIds } });
      }
    }
    await store.saveRelationship(user.id, character.id, relUpdate.state);
    await store.saveEmotions(user.id, character.id, nextEmotions);
    relationship = relUpdate.state;
    emotions = { values: nextEmotions, updatedAt: this.now() };

    await this.maybeSummarize(conv, character, mode, allProviders).catch(() => undefined);
    if (memoryOn && relationship.turnCount % 10 === 0) await this.forget(user.id, character.id).catch(() => undefined);

    yield this.stateEvent(relationship, nextEmotions, baseline, relUpdate.stageChanged, newMemoryIds.length);
  }

  /** Whether opening this conversation should trigger a proactive message. */
  async shouldNudge(conversationId: string): Promise<boolean> {
    const last = (await this.deps.store.listMessages(conversationId, { limit: 1 }))[0];
    if (!last) return false;
    const hours = (this.now().getTime() - last.createdAt.getTime()) / 3_600_000;
    return hours >= NUDGE_AFTER_HOURS && !(last.role === "character" && last.meta.kind === "nudge");
  }

  // ─── Steps ────────────────────────────────────────────────────────────────

  private async prepareTurn(
    req: TurnRequest,
    conv: ConversationRecord,
    character: Character,
  ): Promise<
    | { error: PipelineEvent }
    | {
        userMessage?: StoredMessage;
        removedMessageIds?: string[];
        relationship: RelationshipState;
        emotions: { values: EmotionVector; updatedAt: Date } | null;
      }
  > {
    const { store, memory } = this.deps;
    let relationship =
      (await store.getRelationship(conv.userId, character.id)) ?? initialRelationship(character.profile.initialRelationship);
    let emotions = await store.getEmotions(conv.userId, character.id);
    const snapshot = (): MessageMeta["stateBefore"] => ({ relationship, emotions: emotions?.values ?? null });

    const rollback = async (msg: StoredMessage) => {
      const before = msg.meta.stateBefore;
      if (before) {
        relationship = before.relationship;
        await store.saveRelationship(conv.userId, character.id, relationship);
        if (before.emotions) {
          await store.saveEmotions(conv.userId, character.id, before.emotions);
          emotions = { values: before.emotions, updatedAt: emotions?.updatedAt ?? this.now() };
        }
      }
      if (msg.meta.memoryIds?.length) await memory.remove(msg.meta.memoryIds);
    };

    switch (req.kind) {
      case "send": {
        const text = req.text.trim();
        if (!text) return { error: { type: "error", code: "invalid", message: "Empty message." } };
        if (text.length > 8000) return { error: { type: "error", code: "invalid", message: "Message too long." } };
        const hard = checkHardLimits(text);
        if (!hard.allowed) {
          return { error: { type: "error", code: "blocked", message: "That message crosses a hard content limit (minors, non-consent, incest or bestiality are never allowed)." } };
        }
        const userMessage = await store.addMessage(conv.id, { role: "user", content: text, meta: { stateBefore: snapshot() } });
        return { userMessage, relationship, emotions };
      }
      case "regenerate": {
        const msgs = await store.listMessages(conv.id, { limit: 50 });
        const lastUser = [...msgs].reverse().find((m) => m.role === "user");
        if (!lastUser) return { error: { type: "error", code: "invalid", message: "Nothing to regenerate." } };
        const removed = await store.deleteMessagesFrom(conv.id, lastUser.id, false);
        await this.deps.images?.store.removeForMessages(removed.map((m) => m.id));
        await rollback(lastUser);
        const userMessage = { ...lastUser, meta: { ...lastUser.meta, memoryIds: [] } };
        await store.updateMessage(lastUser.id, { meta: userMessage.meta });
        return { userMessage, removedMessageIds: removed.map((m) => m.id), relationship, emotions };
      }
      case "edit": {
        const target = await store.getMessage(conv.id, req.messageId);
        if (!target || target.role !== "user") return { error: { type: "error", code: "invalid", message: "Only your own messages can be edited." } };
        const text = req.text.trim();
        if (!text) return { error: { type: "error", code: "invalid", message: "Empty message." } };
        if (!checkHardLimits(text).allowed)
          return { error: { type: "error", code: "blocked", message: "That message crosses a hard content limit." } };
        const removed = await store.deleteMessagesFrom(conv.id, target.id, false);
        await this.deps.images?.store.removeForMessages(removed.map((m) => m.id));
        await rollback(target);
        const meta = { ...target.meta, memoryIds: [], stateBefore: target.meta.stateBefore ?? snapshot() };
        await store.updateMessage(target.id, { content: text, meta, edited: true });
        return { userMessage: { ...target, content: text, meta }, removedMessageIds: removed.map((m) => m.id), relationship, emotions };
      }
      case "nudge":
        return { relationship, emotions };
    }
  }

  private async recall(user: UserContext, character: Character, query: string): Promise<ScoredMemory[]> {
    const { memory, embedder } = this.deps;
    try {
      const [qEmb] = query ? await embedder.embed([query]) : [null];
      const [hits, facts] = await Promise.all([
        qEmb ? memory.search(user.id, character.id, qEmb, 14) : Promise.resolve([]),
        memory.coreFacts(user.id, character.id, 6),
      ]);
      const sims = new Map(hits.map((h) => [h.memory.id, h.similarity]));
      const pool = new Map([...facts, ...hits.map((h) => h.memory)].map((m) => [m.id, m]));
      const ranked = rankMemories([...pool.values()], qEmb ?? null, { k: 8, precomputedSimilarity: sims, now: this.now() });
      if (ranked.length) await memory.touch(ranked.map((r) => r.memory.id));
      return ranked;
    } catch {
      return []; // memory is an enhancement; never block a reply on it
    }
  }

  private async extractAndStoreMemories(a: {
    user: UserContext;
    character: Character;
    conv: ConversationRecord;
    userText: string;
    reply: string;
    signals: TurnSignals;
    relUpdate: RelationshipUpdate;
    mode: ContentMode;
    allProviders: ModelProvider[];
    isFirstTurn: boolean;
  }): Promise<string[]> {
    const { memory, embedder } = this.deps;
    const heuristic = extractHeuristicMemories(a.userText, a.signals, { characterName: a.character.name, isFirstTurn: a.isFirstTurn });

    let llm: MemoryCandidate[] | null = null;
    const utility = this.utilityProvider(a.allProviders, a.mode);
    if (utility) {
      try {
        const res = await utility.generateResponse({
          system: memoryExtractionPrompt(a.character.name),
          messages: [{ role: "user", content: `USER: ${a.userText}\n${a.character.name.toUpperCase()}: ${a.reply}` }],
          json: true,
          maxOutputTokens: 700,
          temperature: 0.2,
        });
        llm = parseLlmMemories(res.text);
      } catch {
        llm = null;
      }
    }
    const candidates = llm ? mergeCandidates(llm, heuristic) : heuristic;
    for (const m of a.relUpdate.newMilestones.filter((x) => x !== "first_meeting")) {
      candidates.push({ kind: "EPISODIC", category: "milestone", content: milestoneText(m), importance: 0.9, emotion: "happy" });
    }
    if (a.relUpdate.stageChanged) {
      candidates.push({
        kind: "EPISODIC",
        category: "milestone",
        content: `Your relationship moved from ${pretty(a.relUpdate.stageChanged.from)} to ${pretty(a.relUpdate.stageChanged.to)}.`,
        importance: 0.75,
        relationshipEffect: a.relUpdate.deltas,
      });
    }
    if (!candidates.length) return [];

    const embeddings = await embedder.embed(candidates.map((c) => c.content));
    const existing = await memory.list(a.user.id, a.character.id);
    const actions = consolidate(
      candidates.map((c, i) => ({ candidate: c, embedding: embeddings[i] })),
      existing,
    );
    const inserted: string[] = [];
    for (const act of actions) {
      if (act.type === "insert") inserted.push(await memory.insert(a.user.id, a.character.id, a.conv.id, act.candidate, act.embedding));
      else if (act.type === "update") await memory.update(act.id, act.patch, act.embedding);
      else await memory.update(act.id, { reinforcement: act.reinforcement });
    }
    return inserted;
  }

  private utilityProvider(all: ModelProvider[], mode: ContentMode): ModelProvider | null {
    try {
      // Utility calls see the same content as the chat, so they need the same
      // capability — no downgrade, no exceptions.
      return routeProvider({ mode, role: "utility", providers: all, fallback: "refuse" }).candidates[0];
    } catch {
      return null;
    }
  }

  private async maybeSummarize(conv: ConversationRecord, character: Character, mode: ContentMode, all: ModelProvider[]) {
    const { store } = this.deps;
    const total = await store.countMessages(conv.id);
    const unsummarized = total - RECENT_WINDOW - conv.summarizedCount;
    if (unsummarized < SUMMARY_TRIGGER) return;
    const msgs = await store.listMessages(conv.id, { limit: total });
    const chunk = msgs.slice(conv.summarizedCount, total - RECENT_WINDOW);
    if (!chunk.length) return;
    const transcript = chunk
      .map((m) => `${m.role === "user" ? "USER" : character.name.toUpperCase()}: ${m.content.replace(/\n\|\|\n/g, " ")}`)
      .join("\n")
      .slice(0, 12000);

    let summary = "";
    const utility = this.utilityProvider(all, mode);
    if (utility) {
      try {
        const res = await utility.generateResponse({
          system: `Update a running summary of a conversation between ${character.name} and the user. Keep names, events, feelings, promises and open threads. Max 120 words, past tense, from ${character.name}'s perspective.`,
          messages: [{ role: "user", content: `PREVIOUS SUMMARY:\n${conv.summary || "(none)"}\n\nNEW MESSAGES:\n${transcript}` }],
          maxOutputTokens: 300,
          temperature: 0.3,
        });
        if (res.finishReason !== "refusal" && res.text.trim() && !res.text.trim().startsWith("{")) summary = res.text.trim();
      } catch {
        /* heuristic below */
      }
    }
    if (!summary) {
      const userLines = chunk.filter((m) => m.role === "user").map((m) => m.content.split(/[.!?\n]/)[0].slice(0, 80));
      summary = [conv.summary, `They talked about: ${userLines.slice(-6).join("; ")}.`].filter(Boolean).join(" ").slice(-900);
    }
    await store.updateConversation(conv.id, { summary, summarizedCount: total - RECENT_WINDOW });
  }

  private async forget(userId: string, characterId: string) {
    const all = await this.deps.memory.list(userId, characterId);
    const ids = selectForgettable(all, this.now());
    if (ids.length) await this.deps.memory.remove(ids);
  }

  /** Image providers allowed for this content mode (may lower the mode, never raise it). */
  private async routeImages(mode: ContentMode): Promise<{ candidates: ImageProvider[]; mode: ContentMode } | null> {
    if (!this.deps.images) return null;
    try {
      const all = await this.deps.images.providers.list();
      return routeProvider({ mode, role: "image", providers: all, fallback: "downgrade" });
    } catch {
      return null;
    }
  }

  async generatePhoto(a: {
    user: UserContext;
    character: Character;
    conv: ConversationRecord;
    messageId: string;
    description: string;
    route: { candidates: ImageProvider[]; mode: ContentMode };
  }): Promise<MessageImage> {
    const deps = this.deps.images!;
    const fail = (error: string): MessageImage => ({ caption: a.description, status: "failed", error });
    const since = new Date(this.now().getTime() - 86_400_000);
    if ((await deps.store.countSince(a.user.id, since)) >= (deps.dailyLimit ?? DEFAULT_DAILY_IMAGE_LIMIT))
      return fail("Daily photo limit reached. Try again tomorrow.");

    const { prompt, kind, aspect } = photoPrompt(a.character, a.description, a.route.mode);
    const check = checkImagePrompt(prompt, a.route.mode);
    if (!check.allowed)
      return fail(check.reason === "nudity_not_allowed" ? "That photo isn't allowed at this content level." : "That photo crosses a content limit.");

    for (const provider of a.route.candidates) {
      try {
        const img = await provider.generate({ prompt, negativePrompt: NEGATIVE_PROMPT, aspect, seed: seedFor(a.character.id, a.character.profile.imageSeed) });
        const id = await deps.store.save({
          userId: a.user.id,
          characterId: a.character.id,
          conversationId: a.conv.id,
          messageId: a.messageId,
          kind,
          caption: a.description,
          prompt,
          providerId: provider.descriptor.id,
          model: img.model,
          mimeType: img.mimeType,
          bytes: img.bytes,
          width: img.width,
          height: img.height,
        });
        return { id, caption: a.description, status: "ready", kind };
      } catch (e) {
        // Transient errors fail over; a refusal from the provider is final.
        if (e instanceof ImageProviderError && e.retryable && provider !== a.route.candidates[a.route.candidates.length - 1]) continue;
        return fail(e instanceof ImageProviderError && !e.retryable ? "The image model declined this photo." : "Couldn't develop that photo. Try again in a moment.");
      }
    }
    return fail("No image model available.");
  }

  private async saveCharacterMessage(conv: ConversationRecord, character: Character, content: string, meta: MessageMeta) {
    return this.deps.store.addMessage(conv.id, { role: "character", content, characterId: character.id, meta });
  }

  private stateEvent(
    relationship: RelationshipState,
    emotions: EmotionVector,
    baseline: EmotionVector,
    stageChanged: RelationshipUpdate["stageChanged"],
    newMemories: number,
  ): PipelineEvent {
    return { type: "state", relationship, stageChanged, emotions: dominantEmotions(emotions, baseline, 3), newMemories };
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

const PHOTO_HOW =
  'To send it, put one line on its own: [photo: what the picture shows, e.g. "selfie at the studio window, coffee in hand, golden hour"]. Describe only what is visible, keep it within the content level, then react to sending it in a few words.';

/** Decides whether this turn may include a photo, and tells the model how. */
export function photoDirective(a: {
  signals: TurnSignals;
  rel: RelationshipState;
  canSend: boolean;
  plan: TurnPlan;
  history: StoredMessage[];
  initiative: number;
  seed: number;
}): { text: string; allowed: boolean } {
  const asked = a.signals.intents.includes("photo_request");
  const rank = RELATIONSHIP_STAGES.indexOf(a.rel.stage);
  const willing = a.rel.comfort >= 25 || rank >= RELATIONSHIP_STAGES.indexOf("FRIEND");
  if (asked && !a.canSend)
    return { text: "They asked for a photo. You can't send pictures right now. Deflect naturally, in character, and don't pretend you sent one.", allowed: false };
  if (asked && !willing)
    return { text: "They asked for a photo. It's too early for that with them: tease or decline in character. No photo this time.", allowed: false };
  if (asked) return { text: `They asked for a photo. If it fits who you are and your boundaries, send one. ${PHOTO_HOW}`, allowed: true };

  if (!a.canSend || rank < RELATIONSHIP_STAGES.indexOf("ACQUAINTANCE") || !a.plan.takeInitiative) return { text: "", allowed: false };
  const lastPhoto = [...a.history].reverse().findIndex((m) => m.role === "character" && (m.meta.images?.length ?? 0) > 0);
  const charTurnsSince = (lastPhoto < 0 ? a.history : a.history.slice(a.history.length - lastPhoto)).filter((m) => m.role === "character").length;
  if (charTurnsSince < SPONTANEOUS_PHOTO_GAP) return { text: "", allowed: false };
  const chance = 0.12 + 0.25 * (a.initiative / 100);
  if (mulberry32(a.seed)() >= chance) return { text: "", allowed: false };
  return { text: `If it feels natural, you may send them a photo on your own this turn (something from your day, or of you). ${PHOTO_HOW}`, allowed: true };
}

function toLLMMessages(history: StoredMessage[], forNudge: boolean): LLMMessage[] {
  const msgs: LLMMessage[] = history
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role === "user" ? "user" : "assistant", content: m.content }));
  // Merge consecutive same-role turns (providers require alternation).
  const merged: LLMMessage[] = [];
  for (const m of msgs) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) last.content += `\n${m.content}`;
    else merged.push({ ...m });
  }
  if (forNudge || !merged.length || merged[merged.length - 1].role !== "user") {
    merged.push({ role: "user", content: "(The user hasn't said anything yet — you write first.)" });
  }
  return merged;
}

function nudgeDirection(hours: number): string {
  const gap = hours >= 48 ? `${Math.round(hours / 24)} days` : `${Math.round(hours)} hours`;
  return `They've been away for about ${gap}. You reach out first: react to the silence in character (miss them, tease them, or act like you didn't notice), and bring up something real — a memory, something from your day, or a plan.`;
}

function limitNotice(reason: string): string {
  switch (reason) {
    case "age_verification":
      return "Verify your age to unlock mature modes.";
    case "adult_opt_in":
      return "Adult mode is off — enable it in Settings.";
    case "character":
      return "This character is limited to a lower content mode.";
    case "platform":
      return "Content mode limited by the platform setting.";
    default:
      return reason;
  }
}

function milestoneText(m: string): string {
  if (m === "dating_agreed") return "You agreed to go out together — your first real date.";
  if (m === "relationship_agreed") return "You made it official: you're together now.";
  return `Milestone: ${m.replace(/_/g, " ")}.`;
}

const pretty = (s: string) => s.toLowerCase().replace(/_/g, " ");
const pick = <T,>(arr: T[]) => arr[Math.floor(Math.random() * arr.length)];

function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
