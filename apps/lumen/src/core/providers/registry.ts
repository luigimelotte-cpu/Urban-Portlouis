import { AnthropicProvider } from "./adapters/anthropic";
import { MockProvider } from "./adapters/mock";
import { OpenAICompatibleProvider } from "./adapters/openai-compatible";
import type { ModelProvider, ProviderDescriptor } from "./types";

type Factory = (d: ProviderDescriptor) => ModelProvider;

/**
 * Adapter registry. Adding a vendor = one file in ./adapters + one line here.
 * The admin panel lists these keys; ProviderConfig rows pick one.
 */
const ADAPTERS: Record<string, { label: string; create: Factory }> = {
  anthropic: { label: "Anthropic (Claude)", create: (d) => new AnthropicProvider(d) },
  "openai-compatible": {
    label: "OpenAI-compatible (OpenAI, OpenRouter, Together, Groq, vLLM, Ollama…)",
    create: (d) => new OpenAICompatibleProvider(d),
  },
  mock: { label: "Mock (offline dev)", create: (d) => new MockProvider(d) },
};

export const adapterKeys = () => Object.keys(ADAPTERS);
export const adapterOptions = () => Object.entries(ADAPTERS).map(([key, v]) => ({ key, label: v.label }));

export function createProvider(d: ProviderDescriptor): ModelProvider {
  const a = ADAPTERS[d.adapter];
  if (!a) throw new Error(`Unknown provider adapter "${d.adapter}"`);
  return a.create(d);
}

export function registerAdapter(key: string, label: string, create: Factory) {
  ADAPTERS[key] = { label, create };
}
