import type { ModelCapabilities, ModerationResult } from "../content/policy";

export type { ModelCapabilities } from "../content/policy";

export interface LLMMessage {
  role: "user" | "assistant";
  content: string;
}

export interface GenerateRequest {
  system: string;
  messages: LLMMessage[];
  maxOutputTokens?: number;
  temperature?: number;
  /** Ask for a single JSON object back (utility calls). Best-effort per adapter. */
  json?: boolean;
  signal?: AbortSignal;
}

export type FinishReason = "stop" | "length" | "refusal" | "error";

export interface GenerateResult {
  text: string;
  finishReason: FinishReason;
  usage?: { inputTokens?: number; outputTokens?: number };
  model: string;
}

export type StreamChunk =
  | { type: "text"; text: string }
  | { type: "done"; result: GenerateResult };

/** Static description of a configured provider instance (from ProviderConfig). */
export interface ProviderDescriptor {
  id: string;
  label: string;
  adapter: string;
  model: string;
  baseUrl?: string | null;
  apiKeyEnv?: string | null;
  enabled: boolean;
  priority: number;
  capabilities: ModelCapabilities;
  contextWindow: number;
  maxOutputTokens: number;
  temperature: number;
  roles: string[];
  options: Record<string, unknown>;
}

/**
 * The single interface every model backend implements. Nothing above this
 * layer knows which vendor is answering.
 */
export interface ModelProvider {
  readonly descriptor: ProviderDescriptor;
  generateResponse(req: GenerateRequest): Promise<GenerateResult>;
  streamResponse(req: GenerateRequest): AsyncIterable<StreamChunk>;
  getCapabilities(): ModelCapabilities;
  estimateTokens(text: string): number;
  moderateInput(text: string): Promise<ModerationResult>;
  moderateOutput(text: string): Promise<ModerationResult>;
  /** Whether credentials etc. are present so the provider can actually be called. */
  isAvailable(): boolean;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly providerId: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}
