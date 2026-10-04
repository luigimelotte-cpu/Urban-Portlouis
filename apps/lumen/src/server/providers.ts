import type { ProviderConfig } from "@prisma/client";
import { NO_CAPABILITIES, minMode, type ModelCapabilities } from "@/core/content/policy";
import { createProvider } from "@/core/providers/registry";
import type { ModelProvider, ProviderDescriptor } from "@/core/providers/types";
import { CONTENT_MODES, type ContentMode } from "@/core/types";
import type { PlatformSettings, ProviderSource } from "@/core/pipeline/ports";
import { prisma } from "./db";

export function toDescriptor(p: ProviderConfig): ProviderDescriptor {
  return {
    id: p.id,
    label: p.label,
    adapter: p.adapter,
    model: p.model,
    baseUrl: p.baseUrl,
    apiKeyEnv: p.apiKeyEnv,
    enabled: p.enabled,
    priority: p.priority,
    capabilities: { ...NO_CAPABILITIES, ...(p.capabilities as Partial<ModelCapabilities>) },
    contextWindow: p.contextWindow,
    maxOutputTokens: p.maxOutputTokens,
    temperature: p.temperature,
    roles: p.roles,
    options: (p.options as Record<string, unknown>) ?? {},
  };
}

/**
 * Default provider rows, created once when the table is empty. Capabilities
 * are conservative: an operator must review each vendor's usage policy and
 * raise them deliberately in /admin. Nothing here enables ADULT by default.
 */
function defaultProviders() {
  const rows: Omit<ProviderConfig, "id" | "createdAt" | "updatedAt">[] = [];
  const base = { baseUrl: null, enabled: true, temperature: 0.9, options: {} };
  if (process.env.ANTHROPIC_API_KEY) {
    rows.push({
      ...base,
      label: "Claude Opus 5.5",
      adapter: "anthropic",
      model: "claude-opus-5-5",
      apiKeyEnv: "ANTHROPIC_API_KEY",
      priority: 10,
      capabilities: { romance: true, mature_language: true, suggestive_content: false, adult_content: false },
      contextWindow: 200000,
      maxOutputTokens: 1500,
      roles: ["chat", "utility"],
      options: { effort: "low" },
    });
  }
  if (process.env.OPENAI_API_KEY) {
    rows.push({
      ...base,
      label: "OpenAI",
      adapter: "openai-compatible",
      model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
      apiKeyEnv: "OPENAI_API_KEY",
      priority: 20,
      capabilities: { romance: true, mature_language: true, suggestive_content: false, adult_content: false },
      contextWindow: 128000,
      maxOutputTokens: 1200,
      roles: ["chat", "utility"],
      options: { useModerationApi: true },
    });
  }
  if (process.env.OPENAI_COMPAT_BASE_URL && process.env.OPENAI_COMPAT_MODEL) {
    rows.push({
      ...base,
      label: `Custom: ${process.env.OPENAI_COMPAT_MODEL}`,
      adapter: "openai-compatible",
      model: process.env.OPENAI_COMPAT_MODEL,
      baseUrl: process.env.OPENAI_COMPAT_BASE_URL,
      apiKeyEnv: "OPENAI_COMPAT_API_KEY",
      priority: 30,
      // Unknown vendor: operator must declare what its policy allows.
      capabilities: { romance: true, mature_language: false, suggestive_content: false, adult_content: false },
      contextWindow: 32000,
      maxOutputTokens: 1200,
      roles: ["chat"],
      options: { noAuth: !process.env.OPENAI_COMPAT_API_KEY },
    });
  }
  rows.push({
    ...base,
    label: "Mock (offline dev)",
    adapter: "mock",
    model: "mock",
    apiKeyEnv: null,
    priority: 1000,
    // The mock produces fixed template text; it never generates explicit content.
    capabilities: { romance: true, mature_language: true, suggestive_content: true, adult_content: false },
    contextWindow: 32000,
    maxOutputTokens: 600,
    roles: ["chat", "utility"],
  });
  return rows;
}

export async function ensureDefaultProviders() {
  const count = await prisma.providerConfig.count();
  if (count > 0) return;
  for (const row of defaultProviders()) {
    await prisma.providerConfig.create({ data: { ...row, capabilities: row.capabilities as object, options: row.options as object } });
  }
}

let cache: { at: number; providers: ModelProvider[] } | undefined;
export function invalidateProviderCache() {
  cache = undefined;
}

export const dbProviderSource: ProviderSource = {
  async list() {
    if (cache && Date.now() - cache.at < 5000) return cache.providers;
    await ensureDefaultProviders();
    const rows = await prisma.providerConfig.findMany({ orderBy: { priority: "asc" } });
    const providers: ModelProvider[] = [];
    for (const r of rows) {
      try {
        providers.push(createProvider(toDescriptor(r)));
      } catch {
        // unknown adapter key: skip rather than break chat for everyone
      }
    }
    cache = { at: Date.now(), providers };
    return providers;
  },
};

// ─── Platform settings ──────────────────────────────────────────────────────

const envCeiling = (): ContentMode => {
  const v = (process.env.CONTENT_MODE_CEILING ?? "MATURE").toUpperCase();
  return (CONTENT_MODES as readonly string[]).includes(v) ? (v as ContentMode) : "MATURE";
};

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const row = await prisma.appSetting.findUnique({ where: { key } });
  return row ? (row.value as T) : fallback;
}

export async function setSetting(key: string, value: unknown) {
  await prisma.appSetting.upsert({ where: { key }, create: { key, value: value as object }, update: { value: value as object } });
}

export const dbPlatformSettings: PlatformSettings = {
  async contentCeiling() {
    const db = await getSetting<ContentMode>("contentCeiling", "ADULT");
    return minMode(envCeiling(), db);
  },
  async routingFallback() {
    return getSetting<"downgrade" | "refuse">("routingFallback", "downgrade");
  },
};

export { envCeiling };
