import { LocalHashEmbedder, OpenAICompatibleEmbedder, type Embedder } from "@/core/memory/embeddings";

let cached: Embedder | undefined;

export const EMBEDDING_DIM = Number(process.env.EMBEDDING_DIM ?? 768);

export function getEmbedder(): Embedder {
  if (cached) return cached;
  const kind = (process.env.EMBEDDING_PROVIDER ?? "local").toLowerCase();
  if (kind === "openai") {
    const apiKey = process.env.EMBEDDING_API_KEY || process.env.OPENAI_API_KEY;
    if (apiKey || process.env.EMBEDDING_BASE_URL) {
      cached = new OpenAICompatibleEmbedder({
        baseUrl: process.env.EMBEDDING_BASE_URL || undefined,
        apiKey,
        model: process.env.EMBEDDING_MODEL || "text-embedding-3-small",
        dim: EMBEDDING_DIM,
      });
      return cached;
    }
  }
  cached = new LocalHashEmbedder(EMBEDDING_DIM);
  return cached;
}
