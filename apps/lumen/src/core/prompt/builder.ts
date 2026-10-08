import type { LLMMessage } from "../providers/types";

// The system prompt is assembled from independent modules, each with a
// priority. When the token budget is tight, modules are shrunk (if they have a
// compact form) and then dropped, lowest priority first; finally the oldest
// recent messages are trimmed. Required modules are never dropped.

export const MODULE_KEYS = [
  "CORE_CHARACTER",
  "PERSONALITY",
  "CONTENT_MODE",
  "CONVERSATION_STYLE",
  "CURRENT_SCENARIO",
  "RELATIONSHIP",
  "CURRENT_EMOTION",
  "RELEVANT_MEMORIES",
  "CONVERSATION_SUMMARY",
  "TURN_DIRECTION",
] as const;
export type ModuleKey = (typeof MODULE_KEYS)[number];

export interface PromptModule {
  key: ModuleKey;
  /** 0..100 — higher survives longer under budget pressure. */
  priority: number;
  required?: boolean;
  text: string;
  /** Optional compact version tried before dropping the module entirely. */
  compact?: string;
}

export interface BuildInput {
  modules: PromptModule[];
  recent: LLMMessage[];
  /** Tokens available for the whole input (context window − output − safety). */
  budget: number;
  estimate: (s: string) => number;
  /** Always keep at least this many trailing messages. */
  minRecent?: number;
}

export interface BuiltPrompt {
  system: string;
  messages: LLMMessage[];
  tokens: number;
  included: ModuleKey[];
  compacted: ModuleKey[];
  dropped: ModuleKey[];
  droppedMessages: number;
}

const ORDER = new Map(MODULE_KEYS.map((k, i) => [k, i]));

function render(mods: PromptModule[]): string {
  return [...mods]
    .sort((a, b) => (ORDER.get(a.key) ?? 99) - (ORDER.get(b.key) ?? 99))
    .filter((m) => m.text.trim())
    .map((m) => `## ${m.key}\n${m.text.trim()}`)
    .join("\n\n");
}

export function buildPrompt(input: BuildInput): BuiltPrompt {
  const est = input.estimate;
  const minRecent = Math.min(input.minRecent ?? 4, input.recent.length);
  let mods = input.modules.filter((m) => m.text.trim()).map((m) => ({ ...m }));
  let messages = [...input.recent];
  const compacted: ModuleKey[] = [];
  const dropped: ModuleKey[] = [];
  let droppedMessages = 0;

  const msgTokens = (ms: LLMMessage[]) => ms.reduce((s, m) => s + est(m.content) + 4, 0);
  const total = () => est(render(mods)) + msgTokens(messages);

  // Phase 1: trim history beyond what we need, oldest first, while keeping at
  // least half the budget for the character itself.
  while (messages.length > minRecent && msgTokens(messages) > input.budget * 0.5 && total() > input.budget) {
    messages.shift();
    droppedMessages++;
  }

  // Phase 2: compact, then drop modules by ascending priority.
  const byPriority = () => mods.filter((m) => !m.required).sort((a, b) => a.priority - b.priority);
  for (const m of byPriority()) {
    if (total() <= input.budget) break;
    if (m.compact && m.text !== m.compact) {
      m.text = m.compact;
      compacted.push(m.key);
    }
  }
  for (const m of byPriority()) {
    if (total() <= input.budget) break;
    mods = mods.filter((x) => x !== m);
    dropped.push(m.key);
  }

  // Phase 3: if still over, trim history down to the minimum.
  while (messages.length > minRecent && total() > input.budget) {
    messages.shift();
    droppedMessages++;
  }

  // Providers expect the conversation to start with a user turn.
  while (messages.length && messages[0].role !== "user") {
    messages.shift();
    droppedMessages++;
  }

  const system = render(mods);
  return {
    system,
    messages,
    tokens: est(system) + msgTokens(messages),
    included: mods.map((m) => m.key),
    compacted,
    dropped,
    droppedMessages,
  };
}
