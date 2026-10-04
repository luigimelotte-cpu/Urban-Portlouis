// Output clean-up: the prompt asks for natural texting, but models still slip
// into assistant habits. These rules strip the tell-tale phrases and split the
// reply into chat bubbles.

export const BUBBLE_DELIMITER = "||";

const ASSISTANT_TELLS: RegExp[] = [
  /\bas an ai( language model| assistant)?\b[^.!?]*[.!?]?/gi,
  /\bi('m| am) (just )?an ai\b[^.!?]*[.!?]?/gi,
  /\bi('m| am) (just )?a (language model|virtual assistant|chatbot)\b[^.!?]*[.!?]?/gi,
  /\b(how can i (help|assist) you( today)?|how may i (help|assist) you)\s*\??/gi,
  /\bis there anything else (you'?d like|i can (help|do))[^?]*\?/gi,
  /\b(let me know if (you need|there's) anything else)[^.!?]*[.!?]?/gi,
  /\bi hope this helps[.!]?/gi,
  /\b(en tant qu'ia|en tant qu'assistant)[^.!?]*[.!?]?/gi,
  /\bcomment puis-je vous aider[^?]*\?/gi,
  /\by a-t-il autre chose[^?]*\?/gi,
];

export function stripAssistantTells(text: string): string {
  let out = text;
  for (const re of ASSISTANT_TELLS) out = out.replace(re, "");
  return out
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Remove a leading "Name:" the model sometimes prefixes. */
export function stripSpeakerPrefix(text: string, name: string): string {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(`^\\s*\\**${esc}\\**\\s*:\\s*`, "i"), "");
}

export function splitBubbles(text: string): string[] {
  return text
    .split(/\n\s*\|\|\s*\n|\s+\|\|\s+/)
    .map((b) => b.trim())
    .filter(Boolean);
}

export function postProcessReply(text: string, characterName: string): string {
  const parts = splitBubbles(stripSpeakerPrefix(text, characterName))
    .map((b) => stripAssistantTells(stripSpeakerPrefix(b, characterName)))
    .filter(Boolean);
  return parts.join(`\n${BUBBLE_DELIMITER}\n`);
}
