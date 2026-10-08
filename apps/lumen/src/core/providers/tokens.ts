// Provider-independent token estimate. Real tokenizers differ by vendor; a
// slightly pessimistic chars-per-token ratio keeps the budget safe for English
// and French alike. Adapters may override estimateTokens with something exact.
const CHARS_PER_TOKEN = 3.5;

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN) + 1;
}
