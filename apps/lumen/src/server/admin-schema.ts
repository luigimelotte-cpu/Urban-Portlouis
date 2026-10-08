import { z } from "zod";

export const ProviderSchema = z.object({
  label: z.string().trim().min(1).max(80),
  adapter: z.string().min(1),
  model: z.string().trim().min(1).max(120),
  baseUrl: z.string().url().nullable().optional(),
  // The NAME of an env var, never the key itself.
  apiKeyEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/, "Use an environment variable name, e.g. OPENROUTER_API_KEY").nullable().optional(),
  enabled: z.boolean().default(true),
  priority: z.number().int().min(0).max(10000).default(100),
  capabilities: z.object({
    romance: z.boolean(),
    mature_language: z.boolean(),
    suggestive_content: z.boolean(),
    adult_content: z.boolean(),
  }),
  contextWindow: z.number().int().min(2000).max(2_000_000).default(32000),
  maxOutputTokens: z.number().int().min(0).max(64000).default(1024),
  temperature: z.number().min(0).max(2).default(0.9),
  roles: z.array(z.enum(["chat", "utility", "image"])).min(1).default(["chat"]),
  options: z.record(z.string(), z.unknown()).default({}),
});
