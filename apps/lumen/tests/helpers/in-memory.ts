import type { Character } from "@/core/character/profile";
import { CharacterInputSchema } from "@/core/character/profile";
import { LocalHashEmbedder, cosine } from "@/core/memory/embeddings";
import type { MemoryRecord } from "@/core/memory/engine";
import { ChatPipeline } from "@/core/pipeline/chat-pipeline";
import type { ChatStore, ConversationRecord, ImageStore, MemoryStore, PlatformSettings, StoredMessage } from "@/core/pipeline/ports";
import type { GeneratedImage, ImageProvider, ImageRequest } from "@/core/images/types";
import { BaseProvider } from "@/core/providers/base";
import type { GenerateRequest, GenerateResult, ModelCapabilities, ProviderDescriptor, StreamChunk } from "@/core/providers/types";
import { DEFAULT_USER_SETTINGS, type ContentMode, type EmotionVector, type RelationshipState, type UserContext } from "@/core/types";

let n = 0;
const id = (p: string) => `${p}${++n}`;

export class InMemoryChatStore implements ChatStore {
  users = new Map<string, UserContext>();
  characters = new Map<string, Character>();
  conversations = new Map<string, ConversationRecord>();
  messages = new Map<string, StoredMessage[]>();
  relationships = new Map<string, RelationshipState>();
  emotions = new Map<string, { values: EmotionVector; updatedAt: Date }>();
  clock = () => new Date();

  async getUser(uid: string) {
    return this.users.get(uid) ?? null;
  }
  async getCharacter(cid: string) {
    return this.characters.get(cid) ?? null;
  }
  async getConversation(cid: string, uid: string) {
    const c = this.conversations.get(cid);
    return c && c.userId === uid ? c : null;
  }
  async updateConversation(cid: string, patch: Partial<ConversationRecord>) {
    Object.assign(this.conversations.get(cid)!, patch);
  }
  private list(cid: string) {
    if (!this.messages.has(cid)) this.messages.set(cid, []);
    return this.messages.get(cid)!;
  }
  async listMessages(cid: string, opts?: { limit?: number }) {
    const all = this.list(cid);
    return all.slice(Math.max(0, all.length - (opts?.limit ?? 50))).map((m) => ({ ...m, meta: { ...m.meta } }));
  }
  async countMessages(cid: string) {
    return this.list(cid).length;
  }
  async getMessage(cid: string, mid: string) {
    return this.list(cid).find((m) => m.id === mid) ?? null;
  }
  async addMessage(cid: string, msg: { role: StoredMessage["role"]; content: string; characterId?: string | null; meta?: StoredMessage["meta"] }) {
    const m: StoredMessage = { id: id("m"), role: msg.role, content: msg.content, characterId: msg.characterId ?? null, createdAt: this.clock(), meta: msg.meta ?? {} };
    this.list(cid).push(m);
    return { ...m, meta: { ...m.meta } };
  }
  async updateMessage(mid: string, patch: { content?: string; meta?: StoredMessage["meta"] }) {
    for (const list of this.messages.values()) {
      const m = list.find((x) => x.id === mid);
      if (m) {
        if (patch.content !== undefined) m.content = patch.content;
        if (patch.meta !== undefined) m.meta = patch.meta;
      }
    }
  }
  async deleteMessagesFrom(cid: string, mid: string, inclusive: boolean) {
    const list = this.list(cid);
    const i = list.findIndex((m) => m.id === mid);
    if (i < 0) return [];
    const removed = list.splice(inclusive ? i : i + 1);
    return removed;
  }
  async getRelationship(uid: string, cid: string) {
    const r = this.relationships.get(`${uid}:${cid}`);
    return r ? { ...r, milestones: [...r.milestones] } : null;
  }
  async saveRelationship(uid: string, cid: string, s: RelationshipState) {
    this.relationships.set(`${uid}:${cid}`, { ...s, milestones: [...s.milestones] });
  }
  async getEmotions(uid: string, cid: string) {
    return this.emotions.get(`${uid}:${cid}`) ?? null;
  }
  async saveEmotions(uid: string, cid: string, values: EmotionVector) {
    this.emotions.set(`${uid}:${cid}`, { values, updatedAt: this.clock() });
  }
}

export class InMemoryMemoryStore implements MemoryStore {
  rows = new Map<string, MemoryRecord & { userId: string; characterId: string }>();
  async search(uid: string, cid: string, embedding: number[], k: number) {
    return [...this.rows.values()]
      .filter((m) => m.userId === uid && m.characterId === cid && m.embedding)
      .map((m) => ({ memory: m, similarity: cosine(m.embedding!, embedding) }))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, k);
  }
  async coreFacts(uid: string, cid: string, limit: number) {
    return [...this.rows.values()].filter((m) => m.userId === uid && m.characterId === cid && m.kind === "LONG_TERM" && m.importance >= 0.7).slice(0, limit);
  }
  async list(uid: string, cid: string) {
    return [...this.rows.values()].filter((m) => m.userId === uid && m.characterId === cid);
  }
  async insert(uid: string, cid: string, _conv: string | null, m: Parameters<MemoryStore["insert"]>[3], embedding: number[]) {
    const mid = id("mem");
    this.rows.set(mid, {
      ...m,
      id: mid,
      userId: uid,
      characterId: cid,
      embedding,
      reinforcement: 0,
      lastAccessedAt: new Date(),
      timestamp: new Date(),
    });
    return mid;
  }
  async update(mid: string, patch: Parameters<MemoryStore["update"]>[1], embedding?: number[]) {
    const m = this.rows.get(mid);
    if (m) Object.assign(m, patch, embedding ? { embedding } : {});
  }
  async touch() {}
  async remove(ids: string[]) {
    ids.forEach((i) => this.rows.delete(i));
  }
}

/** Records every request; replies with a scripted or default line. */
export class SpyProvider extends BaseProvider {
  requests: GenerateRequest[] = [];
  reply: (req: GenerateRequest) => string | { text: string; finish?: GenerateResult["finishReason"] } = () => "*smiles* Hey you.\n||\nWhat are you up to?";
  failWith?: Error;

  constructor(caps: Partial<ModelCapabilities>, over: Partial<ProviderDescriptor> = {}) {
    super({
      id: over.id ?? id("p"),
      label: over.label ?? "Spy",
      adapter: "spy",
      model: "spy-1",
      enabled: true,
      priority: over.priority ?? 10,
      capabilities: { romance: true, mature_language: false, suggestive_content: false, adult_content: false, ...caps },
      contextWindow: 16000,
      maxOutputTokens: 500,
      temperature: 0.9,
      roles: over.roles ?? ["chat", "utility"],
      options: {},
      ...over,
    });
  }
  isAvailable() {
    return true;
  }
  async generateResponse(req: GenerateRequest): Promise<GenerateResult> {
    this.requests.push(req);
    if (req.json) return { text: "{}", finishReason: "stop", model: "spy-1" };
    const r = this.reply(req);
    const { text, finish } = typeof r === "string" ? { text: r, finish: "stop" as const } : r;
    return { text, finishReason: finish ?? "stop", model: "spy-1" };
  }
  async *streamResponse(req: GenerateRequest): AsyncIterable<StreamChunk> {
    if (this.failWith) throw this.failWith;
    const res = await this.generateResponse(req);
    for (const part of res.text.match(/.{1,8}/gs) ?? []) yield { type: "text", text: part };
    yield { type: "done", result: res };
  }
}

export function makeCharacter(over: Omit<Partial<Character>, "profile"> & { profile?: Partial<Character["profile"]> } = {}): Character {
  const parsed = CharacterInputSchema.parse({
    name: "Mila",
    age: 27,
    gender: "woman",
    maxContentMode: "MATURE",
    ...over,
    profile: { personality: "Sarcastic, warm underneath.", openingMessage: "We close in ten.", ...(over.profile ?? {}) },
  });
  return { ...parsed, id: over.id ?? id("c"), creatorId: null };
}

export class InMemoryImageStore implements ImageStore {
  rows: (Parameters<ImageStore["save"]>[0] & { id: string; createdAt: Date })[] = [];
  async save(img: Parameters<ImageStore["save"]>[0]) {
    const iid = id("img");
    this.rows.push({ ...img, id: iid, createdAt: new Date() });
    return iid;
  }
  async countSince(userId: string, since: Date) {
    return this.rows.filter((r) => r.userId === userId && r.createdAt >= since).length;
  }
  async removeForMessages(ids: string[]) {
    this.rows = this.rows.filter((r) => !r.messageId || !ids.includes(r.messageId));
  }
}

export class SpyImageProvider implements ImageProvider {
  requests: ImageRequest[] = [];
  failWith?: Error;
  readonly descriptor: ProviderDescriptor;
  constructor(caps: Partial<ModelCapabilities> = {}, over: Partial<ProviderDescriptor> = {}) {
    this.descriptor = {
      id: over.id ?? id("ip"),
      label: "SpyImages",
      adapter: "spy-images",
      model: "spy-img",
      enabled: true,
      priority: 10,
      capabilities: { romance: true, mature_language: true, suggestive_content: true, adult_content: false, ...caps },
      contextWindow: 0,
      maxOutputTokens: 0,
      temperature: 0,
      roles: ["image"],
      options: {},
      ...over,
    };
  }
  getCapabilities() {
    return this.descriptor.capabilities;
  }
  isAvailable() {
    return true;
  }
  async generate(req: ImageRequest): Promise<GeneratedImage> {
    this.requests.push(req);
    if (this.failWith) throw this.failWith;
    return { bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]), mimeType: "image/png", width: 768, height: 1024, model: "spy-img" };
  }
}

export function setup(opts: {
  providers: BaseProvider[];
  ceiling?: ContentMode;
  fallback?: "downgrade" | "refuse";
  character?: Character;
  user?: Partial<UserContext>;
  mode?: ContentMode;
  imageProviders?: ImageProvider[];
  dailyImageLimit?: number;
}) {
  const store = new InMemoryChatStore();
  const memory = new InMemoryMemoryStore();
  const character = opts.character ?? makeCharacter();
  store.characters.set(character.id, character);
  const user: UserContext = { id: "u1", ageVerified: true, adultOptIn: false, displayName: null, settings: { ...DEFAULT_USER_SETTINGS }, ...opts.user };
  store.users.set(user.id, user);
  const conv: ConversationRecord = { id: "conv1", userId: user.id, characterId: character.id, style: "ROLEPLAY", contentMode: opts.mode ?? "SAFE", summary: "", summarizedCount: 0 };
  store.conversations.set(conv.id, conv);
  const settings: PlatformSettings = { contentCeiling: async () => opts.ceiling ?? "ADULT", routingFallback: async () => opts.fallback ?? "downgrade" };
  const images = new InMemoryImageStore();
  const pipeline = new ChatPipeline({
    store,
    memory,
    providers: { list: async () => opts.providers },
    embedder: new LocalHashEmbedder(256),
    settings,
    ...(opts.imageProviders ? { images: { providers: { list: async () => opts.imageProviders! }, store: images, dailyLimit: opts.dailyImageLimit } } : {}),
  });
  return { store, memory, character, user, conv, pipeline, images };
}

export async function collect<T>(gen: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const e of gen) out.push(e);
  return out;
}
