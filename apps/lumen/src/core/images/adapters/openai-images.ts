import type { ModelCapabilities } from "../../content/policy";
import type { ProviderDescriptor } from "../../providers/types";
import { detectMime, ImageProviderError, type GeneratedImage, type ImageAspect, type ImageProvider, type ImageRequest } from "../types";

/**
 * Any server exposing the OpenAI Images API shape (POST /images/generations):
 * OpenAI (gpt-image-1), Together, DeepInfra, many self-hosted gateways.
 *
 * options:
 *   sizes: { portrait, square, landscape }   e.g. "1024x1536"
 *   sizeMode: "size" | "wh"                   OpenAI uses size, Together uses width/height
 *   quality: string                           passed through when set
 *   responseFormat: "b64_json" | "url"        omit for gpt-image-1 (always b64)
 *   sendSeed / sendNegative: boolean          only for servers that accept them
 *   noAuth: boolean
 */
const DEFAULT_SIZES: Record<ImageAspect, string> = { portrait: "1024x1536", square: "1024x1024", landscape: "1536x1024" };

export class OpenAIImagesProvider implements ImageProvider {
  constructor(readonly descriptor: ProviderDescriptor) {}

  private get o() {
    return (this.descriptor.options ?? {}) as Record<string, unknown>;
  }
  private apiKey(): string | undefined {
    const n = this.descriptor.apiKeyEnv;
    const v = n ? process.env[n] : undefined;
    return v?.trim() || undefined;
  }
  getCapabilities(): ModelCapabilities {
    return this.descriptor.capabilities;
  }
  isAvailable(): boolean {
    return this.o.noAuth === true || !!this.apiKey();
  }

  async generate(req: ImageRequest): Promise<GeneratedImage> {
    const base = (this.descriptor.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
    const sizes = { ...DEFAULT_SIZES, ...((this.o.sizes as Record<string, string>) ?? {}) };
    const size = sizes[req.aspect];
    const [w, h] = size.split("x").map(Number);
    const body: Record<string, unknown> = { model: this.descriptor.model, prompt: req.prompt, n: 1 };
    if (this.o.sizeMode === "wh") Object.assign(body, { width: w, height: h });
    else body.size = size;
    if (this.o.quality) body.quality = this.o.quality;
    if (this.o.responseFormat) body.response_format = this.o.responseFormat;
    if (this.o.sendSeed && req.seed !== undefined) body.seed = req.seed;
    if (this.o.sendNegative && req.negativePrompt) body.negative_prompt = req.negativePrompt;

    const key = this.apiKey();
    let res: Response;
    try {
      res = await fetch(`${base}/images/generations`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify(body),
        signal: req.signal,
      });
    } catch (e) {
      throw new ImageProviderError(`Network error: ${(e as Error).message}`, this.descriptor.id, true);
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      // 400 from a safety system is a refusal: surfaced as-is, never retried elsewhere.
      throw new ImageProviderError(`HTTP ${res.status}: ${detail.slice(0, 300)}`, this.descriptor.id, res.status === 429 || res.status >= 500);
    }
    const data = (await res.json()) as { data?: { b64_json?: string; url?: string }[] };
    const item = data.data?.[0];
    let bytes: Uint8Array | undefined;
    if (item?.b64_json) bytes = Uint8Array.from(Buffer.from(item.b64_json, "base64"));
    else if (item?.url) {
      const img = await fetch(item.url);
      if (!img.ok) throw new ImageProviderError(`Could not download image (HTTP ${img.status})`, this.descriptor.id, true);
      bytes = new Uint8Array(await img.arrayBuffer());
    }
    if (!bytes?.length) throw new ImageProviderError("Provider returned no image", this.descriptor.id);
    const mimeType = detectMime(bytes);
    if (!mimeType) throw new ImageProviderError("Provider returned an unknown file type", this.descriptor.id);
    return { bytes, mimeType, width: w, height: h, model: this.descriptor.model };
  }
}
