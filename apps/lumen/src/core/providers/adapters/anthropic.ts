import Anthropic from "@anthropic-ai/sdk";
import { BaseProvider } from "../base";
import {
  ProviderError,
  type FinishReason,
  type GenerateRequest,
  type GenerateResult,
  type StreamChunk,
} from "../types";

type Effort = "low" | "medium" | "high" | "xhigh" | "max";

// Models that accept the server-side refusal fallback ("default" form).
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-sonnet-5-5"]);
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

/**
 * Claude via the official Anthropic SDK.
 *
 * Notes for current models: sampling params (temperature) are rejected, so we
 * don't send them; depth is tuned with output_config.effort instead. A
 * `refusal` stop reason is surfaced as finishReason "refusal" and handled by
 * the pipeline — never retried with a rephrased prompt.
 */
export class AnthropicProvider extends BaseProvider {
  private client?: Anthropic;

  private getClient(): Anthropic {
    if (!this.client) {
      const apiKey = this.apiKey();
      if (!apiKey) throw new ProviderError("Anthropic API key not configured", this.descriptor.id);
      this.client = new Anthropic({
        apiKey,
        ...(this.descriptor.baseUrl ? { baseURL: this.descriptor.baseUrl } : {}),
      });
    }
    return this.client;
  }

  private params(req: GenerateRequest) {
    const o = this.descriptor.options ?? {};
    const effort = (o.effort as Effort | undefined) ?? "medium";
    const useFallback = o.refusalFallback !== false && FALLBACK_MODELS.has(this.descriptor.model);
    const system = req.json
      ? `${req.system}\n\nRespond with a single valid JSON object and nothing else.`
      : req.system;
    return {
      model: this.descriptor.model,
      max_tokens: req.maxOutputTokens ?? this.descriptor.maxOutputTokens,
      system,
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
      output_config: { effort },
      ...(useFallback ? { fallbacks: "default" as const, betas: [FALLBACK_BETA] } : {}),
    };
  }

  private static finish(stop: string | null | undefined): FinishReason {
    if (stop === "refusal") return "refusal";
    if (stop === "max_tokens") return "length";
    return "stop";
  }

  async generateResponse(req: GenerateRequest): Promise<GenerateResult> {
    let text = "";
    let final: GenerateResult | undefined;
    for await (const chunk of this.streamResponse(req)) {
      if (chunk.type === "text") text += chunk.text;
      else final = chunk.result;
    }
    return final ?? { text, finishReason: "stop", model: this.descriptor.model };
  }

  async *streamResponse(req: GenerateRequest): AsyncIterable<StreamChunk> {
    const client = this.getClient();
    let text = "";
    try {
      const stream = client.beta.messages.stream(this.params(req), { signal: req.signal });
      for await (const event of stream) {
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          text += event.delta.text;
          yield { type: "text", text: event.delta.text };
        }
      }
      const msg = await stream.finalMessage();
      yield {
        type: "done",
        result: {
          text,
          finishReason: AnthropicProvider.finish(msg.stop_reason),
          usage: { inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens },
          model: msg.model,
        },
      };
    } catch (err) {
      if (err instanceof Anthropic.RateLimitError || err instanceof Anthropic.InternalServerError) {
        throw new ProviderError(err.message, this.descriptor.id, true);
      }
      if (err instanceof Anthropic.APIConnectionError) {
        throw new ProviderError("Could not reach Anthropic API", this.descriptor.id, true);
      }
      if (err instanceof Anthropic.APIError) {
        throw new ProviderError(err.message, this.descriptor.id, false);
      }
      throw err;
    }
  }
}
