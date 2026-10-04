import { z } from "zod";
import type { TurnSignals } from "../intent/detect";
import type { MemoryCandidate } from "./engine";

// Memory extraction runs after each turn. A utility LLM (if one is routed for
// the conversation's content mode) gives the best results; the heuristic
// extractor below always runs too, so names / likes / promises are captured
// even fully offline. Results are merged and then consolidated.

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const clean = (s: string) => s.replace(/[.!?,;:]+$/, "").trim();
const keyOf = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 40);

const NOT_NAMES = new Set(["Happy", "Sad", "Ready", "Done", "Home", "Busy", "Free", "Single", "Married", "Hungry", "Cold", "Hot", "Late", "Lost", "New", "Alone", "Bien", "Prête", "Prêt", "Not", "Just", "So", "Really", "Very", "Here", "Fine", "Good", "Sorry", "Back", "Tired", "Bored", "Okay", "Ok", "Going", "Trying", "Sure", "Pas", "Bien", "Là", "Désolé", "Désolée", "Fatigué", "Fatiguée", "En"]);

export function extractHeuristicMemories(
  userText: string,
  signals: TurnSignals,
  ctx: { characterName: string; isFirstTurn: boolean },
): MemoryCandidate[] {
  const out: MemoryCandidate[] = [];
  const t = userText.replace(/\*[^*]*\*/g, " ").trim(); // ignore roleplay actions for facts

  // Name
  const name =
    /\b(?:my name is|my name's|call me|i'm called|je m'appelle|appelle[- ]moi|mon nom est|moi c'est)\s+([A-ZÀ-Ý][\p{L}'-]{1,24})/iu.exec(t)?.[1] ??
    /(?:^|[.!?,]\s*|\s)(?:[iI]'?m|[iI] am|[jJ]e suis|[mM]oi c'est)\s+([A-ZÀ-Ý][\p{L}'-]{1,24})(?=\s*(?:[.!?,]|$|and\b|et\b))/u.exec(t)?.[1];
  if (name && !NOT_NAMES.has(cap(name))) {
    out.push({ kind: "LONG_TERM", category: "name", content: `Their name is ${cap(name)}.`, importance: 0.95, factKey: "user.name" });
  }

  // Age (only stored as a fact; the user's own age is verified elsewhere)
  const age = /\b(?:i'm|i am|j'ai)\s+(\d{2})\s*(?:years? old|yo|ans)\b/i.exec(t)?.[1];
  if (age && Number(age) >= 18 && Number(age) < 100) {
    out.push({ kind: "LONG_TERM", category: "fact", content: `They are ${age}.`, importance: 0.6, factKey: "user.age" });
  }

  // Occupation
  const job =
    /\b(?:i work as(?: an?)?|i'm an? |i am an? |je travaille comme|je suis (?:un |une )?)\s*(architect|designer|developer|engineer|student|nurse|doctor|teacher|lawyer|artist|photographer|chef|writer|musician|architecte|étudiante?|infirmière?|médecin|professeure?|avocate?|artiste|photographe|développeuse|développeur|ingénieure?|graphiste)\b/i.exec(t)?.[1];
  if (job) {
    out.push({ kind: "LONG_TERM", category: "fact", content: `They work as ${/^[aeiou]/i.test(job) ? "an" : "a"} ${job.toLowerCase()}.`, importance: 0.7, factKey: "user.occupation" });
  }
  const workplace = /\b(?:i work at|je travaille (?:chez|à|a))\s+([\p{L}0-9&' -]{2,40}?)(?:[.,!?]|$)/iu.exec(t)?.[1];
  if (workplace) {
    out.push({ kind: "LONG_TERM", category: "fact", content: `They work at ${clean(workplace)}.`, importance: 0.6, factKey: "user.workplace" });
  }

  // Likes / dislikes (one memory per item)
  const likeRe = /\b(?:i (?:really )?(?:love|like|enjoy|adore)|i'm (?:really )?into|j'adore|j'aime(?: bien| beaucoup)?|je kiffe)\s+([^.!?\n]{2,60})/giu;
  for (const m of t.matchAll(likeRe)) {
    const what = clean(m[1]).replace(/^(to |de |d'|le |la |les )/i, "");
    if (/^(you|toi|te|t')\b/i.test(what)) continue; // "I like you" is not a preference
    if (what.split(/\s+/).length > 8) continue;
    out.push({ kind: "LONG_TERM", category: "preference", content: `They love ${what}.`, importance: 0.55, factKey: `user.likes:${keyOf(what)}` });
  }
  const dislikeRe = /\b(?:i (?:really )?(?:hate|dislike|can't stand)|je (?:déteste|deteste|supporte pas|n'aime pas))\s+([^.!?\n]{2,60})/giu;
  for (const m of t.matchAll(dislikeRe)) {
    const what = clean(m[1]);
    if (/^(you|toi|te|t')\b/i.test(what) || what.split(/\s+/).length > 8) continue;
    out.push({ kind: "LONG_TERM", category: "preference", content: `They dislike ${what}.`, importance: 0.5, factKey: `user.dislikes:${keyOf(what)}` });
  }

  // People in their life
  for (const p of signals.mentionedPeople) {
    out.push({
      kind: "LONG_TERM",
      category: "person",
      content: `They mentioned their ${p}.`,
      importance: 0.45,
      factKey: `user.person:${keyOf(p)}`,
      peopleInvolved: [p],
    });
  }

  // Habits
  const habit = /\b(?:every (?:morning|day|night|evening|weekend)|i usually|i always|tous les (?:matins|soirs|jours|week-ends)|d'habitude|je fais toujours)\b[^.!?\n]{3,80}/iu.exec(t)?.[0];
  if (habit) {
    out.push({ kind: "LONG_TERM", category: "habit", content: `Habit: ${clean(habit)}.`, importance: 0.45, factKey: `user.habit:${keyOf(habit).slice(0, 30)}` });
  }

  // Episodic
  if (ctx.isFirstTurn) {
    out.push({
      kind: "EPISODIC",
      category: "first_meeting",
      content: `The first time you talked. They opened with: "${t.slice(0, 120)}"`,
      importance: 0.8,
      emotion: "curious",
    });
  }
  if (/\b(i promise|i swear|je (?:te )?(?:promets|jure))\b/i.test(t)) {
    out.push({ kind: "EPISODIC", category: "promise", content: `They promised: "${t.slice(0, 160)}"`, importance: 0.8, emotion: "hopeful", relationshipEffect: { trust: 2 } });
  }
  if (signals.intents.includes("insult")) {
    out.push({ kind: "EPISODIC", category: "argument", content: `They said something hurtful: "${t.slice(0, 140)}"`, importance: 0.6, emotion: "hurt", relationshipEffect: { conflict: 8 } });
  }
  if (signals.intents.includes("compliment") && t.length > 25) {
    out.push({ kind: "EPISODIC", category: "compliment", content: `They told you: "${t.slice(0, 140)}"`, importance: 0.45, emotion: "flattered", relationshipEffect: { affection: 2 } });
  }
  if (signals.intents.includes("romantic_advance") || signals.intents.includes("ask_out") || signals.intents.includes("ask_relationship")) {
    out.push({ kind: "EPISODIC", category: "romantic", content: `A romantic moment: they said "${t.slice(0, 140)}"`, importance: 0.7, emotion: "romantic", relationshipEffect: { attraction: 3 } });
  }
  if (signals.intents.includes("share_personal") && t.length > 40) {
    out.push({ kind: "EPISODIC", category: "shared_event", content: `They opened up: "${t.slice(0, 160)}"`, importance: 0.55, emotion: "tender", relationshipEffect: { trust: 2 } });
  }
  return out;
}

// ─── LLM extraction ─────────────────────────────────────────────────────────

const LlmMemorySchema = z.object({
  kind: z.enum(["EPISODIC", "LONG_TERM"]),
  category: z.string().max(40),
  content: z.string().min(3).max(300),
  importance: z.number().min(0).max(1),
  factKey: z.string().max(80).nullish(),
  emotion: z.string().max(30).nullish(),
  people: z.array(z.string().max(60)).max(6).nullish(),
});
const LlmExtractionSchema = z.object({ memories: z.array(LlmMemorySchema).max(8) });

export function memoryExtractionPrompt(characterName: string): string {
  return [
    `You extract memories for ${characterName}, a character in an ongoing conversation with a user.`,
    "From the LAST exchange only, list what is worth remembering long-term. Skip small talk.",
    'Return JSON: {"memories":[{"kind":"LONG_TERM"|"EPISODIC","category":string,"content":string,"importance":0..1,"factKey":string|null,"emotion":string|null,"people":string[]}]}',
    "LONG_TERM = stable facts about the user (categories: name, preference, interest, person, habit, fact, relationship). Give each a stable factKey like \"user.name\", \"user.likes:jazz\", \"user.person:sister_lea\".",
    "EPISODIC = notable moments between them (categories: argument, compliment, romantic, promise, shared_event, inside_joke, milestone). factKey null.",
    "Write content as short third-person notes from the character's perspective (\"They hate mornings.\").",
    "Importance: 0.9 identity facts, 0.7 meaningful moments/promises, 0.5 preferences, 0.3 trivia.",
    'If nothing is worth keeping return {"memories":[]}.',
  ].join("\n");
}

export function parseLlmMemories(raw: string): MemoryCandidate[] | null {
  const json = extractJsonObject(raw);
  if (!json) return null;
  const res = LlmExtractionSchema.safeParse(json);
  if (!res.success) return null;
  return res.data.memories.map((m) => ({
    kind: m.kind,
    category: m.category,
    content: m.content,
    importance: m.importance,
    factKey: m.kind === "LONG_TERM" ? (m.factKey ?? null) : null,
    emotion: m.emotion ?? null,
    peopleInvolved: m.people ?? [],
  }));
}

/** Merge LLM + heuristic candidates; LLM wins on the same factKey. */
export function mergeCandidates(primary: MemoryCandidate[], secondary: MemoryCandidate[]): MemoryCandidate[] {
  const keys = new Set(primary.map((c) => c.factKey).filter(Boolean));
  const cats = new Set(primary.filter((c) => c.kind === "EPISODIC").map((c) => c.category));
  return [
    ...primary,
    ...secondary.filter((c) => (c.factKey ? !keys.has(c.factKey) : !cats.has(c.category))),
  ];
}

export function extractJsonObject(raw: string): unknown | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}
