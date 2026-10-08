import { checkHardLimits, type ModerationResult } from "../content/policy";
import { estimateTokens } from "./tokens";
import type {
  GenerateRequest,
  GenerateResult,
  ModelCapabilities,
  ModelProvider,
  ProviderDescriptor,
  StreamChunk,
} from "./types";

/**
 * Shared behaviour for adapters: capability lookup, token estimate and the
 * platform hard-limit moderation. Adapters with a vendor moderation endpoint
 * extend moderateInput/Output and merge results.
 */
export abstract class BaseProvider implements ModelProvider {
  constructor(readonly descriptor: ProviderDescriptor) {}

  abstract generateResponse(req: GenerateRequest): Promise<GenerateResult>;
  abstract streamResponse(req: GenerateRequest): AsyncIterable<StreamChunk>;

  getCapabilities(): ModelCapabilities {
    return this.descriptor.capabilities;
  }

  estimateTokens(text: string): number {
    return estimateTokens(text);
  }

  async moderateInput(text: string): Promise<ModerationResult> {
    return checkHardLimits(text);
  }

  async moderateOutput(text: string): Promise<ModerationResult> {
    return checkHardLimits(text);
  }

  protected apiKey(): string | undefined {
    const name = this.descriptor.apiKeyEnv;
    if (!name) return undefined;
    const v = process.env[name];
    return v && v.trim() ? v.trim() : undefined;
  }

  isAvailable(): boolean {
    return !!this.apiKey();
  }
}

export const mergeModeration = (a: ModerationResult, b: ModerationResult): ModerationResult => ({
  allowed: a.allowed && b.allowed,
  violations: [...new Set([...a.violations, ...b.violations])],
  flags: [...new Set([...a.flags, ...b.flags])],
});
