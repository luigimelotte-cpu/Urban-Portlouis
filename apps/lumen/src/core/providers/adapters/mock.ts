import { BaseProvider } from "../base";
import type { GenerateRequest, GenerateResult, StreamChunk } from "../types";

/**
 * Offline development provider. It does not call any model: it assembles a
 * short in-character reply from templates so the whole pipeline (routing,
 * memory, relationship, streaming UI) can be exercised with no API key.
 * Utility (JSON) calls return "{}" so callers fall back to heuristics.
 */
export class MockProvider extends BaseProvider {
  isAvailable(): boolean {
    return true;
  }

  private compose(req: GenerateRequest): string {
    if (req.json) return "{}";
    const name = /You are ([^,.\n]+)/.exec(req.system)?.[1]?.trim() ?? "them";
    const roleplay = /STYLE: (ROLEPLAY|STORY)/.test(req.system);
    const userName = /user's name is ([A-Z][\p{L}'-]+)/u.exec(req.system)?.[1];
    const last = [...req.messages].reverse().find((m) => m.role === "user")?.content ?? "";
    const seed = hash(last + req.messages.length);
    const pick = <T,>(arr: T[]) => arr[seed % arr.length];

    const topic = last
      .replace(/\*[^*]*\*/g, " ")
      .replace(/[*_~`]/g, "")
      .split(/\s+/)
      .filter((w) => w.length > 4)
      .slice(0, 3)
      .join(" ");
    const action = roleplay
      ? pick([
          `*${name} tilts their head, half a smile forming*`,
          "*leans back, studying you for a second*",
          "*laughs under their breath*",
          "*taps a finger against the table, thinking*",
        ]) + "\n"
      : "";
    const opener = pick(["Hm.", "Okay, wait.", "Ha.", "Honestly?", "You know what…"]);
    const body = topic
      ? pick([
          `${opener} You really just said "${topic}" like it's nothing.`,
          `${opener} I keep thinking about the "${topic}" part.`,
          `${opener} "${topic}"… tell me more. Slowly.`,
        ])
      : `${opener} You went quiet on me.`;
    const follow = pick([
      userName ? `So, ${userName} — what are you doing later?` : "So what are you doing later?",
      "Your turn. And don't dodge.",
      "I'm curious now. That's dangerous.",
    ]);
    // When the turn direction allows a photo, "send" one like a real model would.
    const photo = /\[photo: what the picture shows/.test(req.system)
      ? `\n||\n[photo: ${pick(["candid selfie, half-smile, warm evening light", "mirror selfie, relaxed, soft window light", "selfie outdoors at golden hour, wind in the hair"])}]\n||\nThere. Happy?`
      : "";
    return `${action}${body}\n||\n${follow}${photo}\n\n(mock provider — configure a real model in /admin)`;
  }

  async generateResponse(req: GenerateRequest): Promise<GenerateResult> {
    return { text: this.compose(req), finishReason: "stop", model: "mock", usage: {} };
  }

  async *streamResponse(req: GenerateRequest): AsyncIterable<StreamChunk> {
    const text = this.compose(req);
    const delay = Number(this.descriptor.options?.delayMs ?? 18);
    for (const piece of text.match(/\S+\s*|\s+/g) ?? []) {
      if (req.signal?.aborted) break;
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      yield { type: "text", text: piece };
    }
    yield { type: "done", result: { text, finishReason: "stop", model: "mock", usage: {} } };
  }
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
