// Embedding providers. Kept separate from chat providers: you may well use one
// vendor for chat and another (or a local model) for embeddings.

export interface Embedder {
  readonly id: string;
  readonly dim: number;
  embed(texts: string[]): Promise<number[][]>;
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0,
    na = 0,
    nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/**
 * Offline embedder: signed feature hashing over normalised word unigrams,
 * bigrams and character trigrams. Captures lexical overlap (not deep
 * semantics) — enough for development and tests with zero setup.
 */
export class LocalHashEmbedder implements Embedder {
  readonly id = "local-hash";
  constructor(readonly dim = 768) {}

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.embedOne(t));
  }

  embedOne(text: string): number[] {
    const v = new Array<number>(this.dim).fill(0);
    const words = normalise(text)
      .split(/\s+/)
      .filter((w) => w.length > 1 && !STOP.has(w))
      .map(stem);
    const feats: [string, number][] = [];
    for (let i = 0; i < words.length; i++) {
      feats.push([`w:${words[i]}`, 1]);
      if (i + 1 < words.length) feats.push([`b:${words[i]}_${words[i + 1]}`, 0.6]);
      const w = `#${words[i]}#`;
      for (let j = 0; j + 3 <= w.length; j++) feats.push([`c:${w.slice(j, j + 3)}`, 0.25]);
    }
    for (const [f, weight] of feats) {
      const h = fnv(f);
      v[h % this.dim] += (h & 0x80000000 ? -1 : 1) * weight;
    }
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / norm);
  }
}

/** OpenAI-compatible /embeddings endpoint (OpenAI, Together, Ollama, …). */
export class OpenAICompatibleEmbedder implements Embedder {
  readonly id: string;
  constructor(
    private opts: { baseUrl?: string; apiKey?: string; model: string; dim: number },
  ) {
    this.id = `openai-compatible:${opts.model}`;
  }
  get dim() {
    return this.opts.dim;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (!texts.length) return [];
    const base = (this.opts.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
    const res = await fetch(`${base}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.opts.apiKey ? { Authorization: `Bearer ${this.opts.apiKey}` } : {}),
      },
      body: JSON.stringify({ model: this.opts.model, input: texts, dimensions: this.opts.dim }),
    });
    if (!res.ok) throw new Error(`Embedding request failed: HTTP ${res.status}`);
    const data = (await res.json()) as { data: { embedding: number[]; index: number }[] };
    const out = data.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
    if (out[0] && out[0].length !== this.dim) {
      throw new Error(`Embedding dimension ${out[0].length} != configured ${this.dim}`);
    }
    return out;
  }
}

function normalise(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s']/g, " ");
}

function stem(w: string): string {
  return w.replace(/(ing|ed|es|s|ement|ment|euse|eux|er)$/, "") || w;
}

function fnv(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

const STOP = new Set(
  "the a an and or but to of in on at for with is are was were be been it this that i you he she they we me my your his her their our its do does did have has had so just very really not no yes le la les un une des et ou mais de du au aux en pour avec est sont etait je tu il elle ils nous vous me te se mon ma mes ton ta tes son sa ses ce cette ca pas oui non tres".split(
    " ",
  ),
);
