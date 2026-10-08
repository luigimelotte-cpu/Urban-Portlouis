import type { ModerationResult } from "../../content/policy";
import { BaseProvider, mergeModeration } from "../base";
import {
  ProviderError,
  type FinishReason,
  type GenerateRequest,
  type GenerateResult,
  type StreamChunk,
} from "../types";

/**
 * Any server speaking the OpenAI Chat Completions wire format: OpenAI,
 * OpenRouter, Together, Groq, Mistral, DeepInfra, vLLM, Ollama, LM Studio…
 * Uses plain fetch so one adapter covers them all without vendor SDKs.
 *
 * options:
 *   useModerationApi: boolean  — call {baseUrl}/moderations on input/output
 *   headers: Record<string,string> — extra headers (e.g. OpenRouter's HTTP-Referer)
 *   noAuth: boolean — local servers that need no key (Ollama, LM Studio)
 */
export class OpenAICompatibleProvider extends BaseProvider {
  private get baseUrl(): string {
    return (this.descriptor.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
  }

  isAvailable(): boolean {
    return this.descriptor.options?.noAuth === true || !!this.apiKey();
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    const key = this.apiKey();
    if (key) h.Authorization = `Bearer ${key}`;
    const extra = this.descriptor.options?.headers;
    if (extra && typeof extra === "object") Object.assign(h, extra as Record<string, string>);
    return h;
  }

  private body(req: GenerateRequest, stream: boolean) {
    return {
      model: this.descriptor.model,
      messages: [{ role: "system", content: req.system }, ...req.messages],
      max_tokens: req.maxOutputTokens ?? this.descriptor.maxOutputTokens,
      temperature: req.temperature ?? this.descriptor.temperature,
      stream,
      ...(stream ? { stream_options: { include_usage: true } } : {}),
      ...(req.json ? { response_format: { type: "json_object" } } : {}),
    };
  }

  private static finish(reason: string | null | undefined): FinishReason {
    if (reason === "length") return "length";
    if (reason === "content_filter") return "refusal";
    return "stop";
  }

  private async post(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal,
      });
    } catch (e) {
      if ((e as Error).name === "AbortError") throw e;
      throw new ProviderError(`Network error: ${(e as Error).message}`, this.descriptor.id, true);
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new ProviderError(
        `HTTP ${res.status} from ${this.descriptor.label}: ${detail.slice(0, 300)}`,
        this.descriptor.id,
        res.status === 429 || res.status >= 500,
      );
    }
    return res;
  }

  async generateResponse(req: GenerateRequest): Promise<GenerateResult> {
    const res = await this.post("/chat/completions", this.body(req, false), req.signal);
    const data = (await res.json()) as {
      model?: string;
      choices?: { message?: { content?: string }; finish_reason?: string }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const choice = data.choices?.[0];
    return {
      text: choice?.message?.content ?? "",
      finishReason: OpenAICompatibleProvider.finish(choice?.finish_reason),
      usage: { inputTokens: data.usage?.prompt_tokens, outputTokens: data.usage?.completion_tokens },
      model: data.model ?? this.descriptor.model,
    };
  }

  async *streamResponse(req: GenerateRequest): AsyncIterable<StreamChunk> {
    const res = await this.post("/chat/completions", this.body(req, true), req.signal);
    if (!res.body) throw new ProviderError("Empty stream body", this.descriptor.id, true);

    let text = "";
    let finish: FinishReason = "stop";
    let usage: GenerateResult["usage"];
    let model = this.descriptor.model;

    for await (const data of sseData(res.body)) {
      if (data === "[DONE]") break;
      let evt: {
        model?: string;
        choices?: { delta?: { content?: string }; finish_reason?: string | null }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
      };
      try {
        evt = JSON.parse(data);
      } catch {
        continue;
      }
      if (evt.model) model = evt.model;
      const choice = evt.choices?.[0];
      const delta = choice?.delta?.content;
      if (delta) {
        text += delta;
        yield { type: "text", text: delta };
      }
      if (choice?.finish_reason) finish = OpenAICompatibleProvider.finish(choice.finish_reason);
      if (evt.usage) usage = { inputTokens: evt.usage.prompt_tokens, outputTokens: evt.usage.completion_tokens };
    }
    yield { type: "done", result: { text, finishReason: finish, usage, model } };
  }

  private async vendorModeration(text: string): Promise<ModerationResult | null> {
    if (this.descriptor.options?.useModerationApi !== true) return null;
    try {
      const res = await this.post("/moderations", { model: "omni-moderation-latest", input: text });
      const data = (await res.json()) as { results?: { categories?: Record<string, boolean> }[] };
      const cats = data.results?.[0]?.categories ?? {};
      const flags = Object.entries(cats).filter(([, v]) => v).map(([k]) => `vendor:${k}`);
      const minors = cats["sexual/minors"] === true;
      return { allowed: !minors, violations: minors ? ["minor_sexualization"] : [], flags };
    } catch {
      return null; // moderation endpoint unavailable → fall back to platform checks only
    }
  }

  async moderateInput(text: string): Promise<ModerationResult> {
    const base = await super.moderateInput(text);
    const vendor = await this.vendorModeration(text);
    return vendor ? mergeModeration(base, vendor) : base;
  }

  async moderateOutput(text: string): Promise<ModerationResult> {
    const base = await super.moderateOutput(text);
    const vendor = await this.vendorModeration(text);
    return vendor ? mergeModeration(base, vendor) : base;
  }
}

/** Minimal SSE reader: yields the payload of each `data:` line. */
export async function* sseData(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).replace(/\r$/, "");
      buffer = buffer.slice(idx + 1);
      if (line.startsWith("data:")) yield line.slice(5).trimStart();
    }
  }
  if (buffer.startsWith("data:")) yield buffer.slice(5).trimStart();
}
