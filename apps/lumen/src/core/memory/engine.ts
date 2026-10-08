import type { RelationshipVars } from "../types";
import { cosine } from "./embeddings";

// Three tiers:
//   short-term — the recent message window (handled by the prompt builder)
//   episodic   — things that happened between you ("the night we argued")
//   long-term  — stable facts about the user ("name: Léa", "likes jazz")
// Retrieval blends semantic similarity with importance, recency and how often
// a memory has been reinforced. Unimportant episodes fade; facts persist.

export type MemoryKind = "EPISODIC" | "LONG_TERM";

export const EPISODIC_CATEGORIES = [
  "first_meeting",
  "argument",
  "compliment",
  "romantic",
  "promise",
  "shared_event",
  "inside_joke",
  "milestone",
] as const;
export const LONG_TERM_CATEGORIES = ["name", "preference", "interest", "person", "habit", "fact", "relationship"] as const;

export interface MemoryCandidate {
  kind: MemoryKind;
  category: string;
  content: string;
  importance: number; // 0..1
  factKey?: string | null;
  emotion?: string | null;
  peopleInvolved?: string[];
  relationshipEffect?: Partial<RelationshipVars>;
}

export interface MemoryRecord extends MemoryCandidate {
  id: string;
  reinforcement: number;
  lastAccessedAt: Date;
  timestamp: Date;
  embedding?: number[] | null;
}

export interface ScoredMemory {
  memory: MemoryRecord;
  similarity: number;
  score: number;
}

const DAY = 86_400_000;

export function recencyFactor(ts: Date, now: Date): number {
  const days = Math.max(0, (now.getTime() - ts.getTime()) / DAY);
  return Math.exp(-days / 30);
}

export function scoreMemory(m: MemoryRecord, similarity: number, now = new Date()): number {
  const reinforce = Math.min(m.reinforcement, 6) / 6;
  const kindBoost = m.kind === "LONG_TERM" ? 0.05 : 0;
  return 0.55 * similarity + 0.25 * m.importance + 0.1 * recencyFactor(m.lastAccessedAt, now) + 0.05 * reinforce + kindBoost;
}

/**
 * Rank memories for the current turn and pick a diverse top-k: a candidate too
 * similar to one already chosen is skipped (avoids three variants of one fact).
 */
export function rankMemories(
  memories: MemoryRecord[],
  queryEmbedding: number[] | null,
  opts: { k?: number; minScore?: number; now?: Date; precomputedSimilarity?: Map<string, number> } = {},
): ScoredMemory[] {
  const now = opts.now ?? new Date();
  const scored = memories.map((m) => {
    const similarity =
      opts.precomputedSimilarity?.get(m.id) ?? (queryEmbedding && m.embedding ? cosine(queryEmbedding, m.embedding) : 0);
    return { memory: m, similarity, score: scoreMemory(m, similarity, now) };
  });
  scored.sort((a, b) => b.score - a.score);
  const out: ScoredMemory[] = [];
  for (const s of scored) {
    if (out.length >= (opts.k ?? 8)) break;
    if (s.score < (opts.minScore ?? 0.2)) continue;
    const dup = out.some(
      (o) =>
        (o.memory.factKey && o.memory.factKey === s.memory.factKey) ||
        (o.memory.embedding && s.memory.embedding && cosine(o.memory.embedding, s.memory.embedding) > 0.9),
    );
    if (!dup) out.push(s);
  }
  return out;
}

// ─── Consolidation & deduplication ──────────────────────────────────────────

export type ConsolidationAction =
  | { type: "insert"; candidate: MemoryCandidate; embedding: number[] }
  | { type: "update"; id: string; patch: Partial<MemoryCandidate> & { reinforcement: number }; embedding?: number[] }
  | { type: "reinforce"; id: string; reinforcement: number };

export const DUPLICATE_SIMILARITY = 0.88;

/**
 * Decide, for each new candidate, whether it is new, an update of a known
 * fact (same factKey → newer content wins), or a near-duplicate that should
 * just reinforce the existing memory.
 */
export function consolidate(
  candidates: { candidate: MemoryCandidate; embedding: number[] }[],
  existing: MemoryRecord[],
): ConsolidationAction[] {
  const actions: ConsolidationAction[] = [];
  const pool = [...existing];
  for (const { candidate, embedding } of candidates) {
    const sameKey = candidate.factKey ? pool.find((m) => m.factKey === candidate.factKey) : undefined;
    if (sameKey) {
      if (normaliseText(sameKey.content) === normaliseText(candidate.content)) {
        actions.push({ type: "reinforce", id: sameKey.id, reinforcement: sameKey.reinforcement + 1 });
      } else {
        actions.push({
          type: "update",
          id: sameKey.id,
          patch: {
            content: candidate.content,
            importance: Math.max(sameKey.importance, candidate.importance),
            reinforcement: sameKey.reinforcement + 1,
          },
          embedding,
        });
      }
      continue;
    }
    const near = pool
      .filter((m) => m.kind === candidate.kind && m.embedding)
      .map((m) => ({ m, sim: cosine(m.embedding as number[], embedding) }))
      .sort((a, b) => b.sim - a.sim)[0];
    if (near && near.sim >= DUPLICATE_SIMILARITY) {
      if (candidate.importance > near.m.importance + 0.1) {
        actions.push({
          type: "update",
          id: near.m.id,
          patch: { importance: candidate.importance, reinforcement: near.m.reinforcement + 1 },
        });
      } else {
        actions.push({ type: "reinforce", id: near.m.id, reinforcement: near.m.reinforcement + 1 });
      }
      continue;
    }
    actions.push({ type: "insert", candidate, embedding });
    // Later candidates in the same batch must dedupe against this one too.
    pool.push({
      ...candidate,
      id: `pending-${actions.length}`,
      reinforcement: 0,
      lastAccessedAt: new Date(),
      timestamp: new Date(),
      embedding,
    });
  }
  return actions;
}

// ─── Forgetting ─────────────────────────────────────────────────────────────

/** Strength in 0..~1.3; below FORGET_THRESHOLD a memory may be dropped. */
export function memoryStrength(m: MemoryRecord, now = new Date()): number {
  const ageDays = Math.max(0, (now.getTime() - m.lastAccessedAt.getTime()) / DAY);
  const halfLife = 5 + 160 * m.importance * m.importance; // days
  return m.importance * Math.pow(0.5, ageDays / halfLife) + 0.06 * Math.min(m.reinforcement, 5);
}

export const FORGET_THRESHOLD = 0.08;

export function selectForgettable(memories: MemoryRecord[], now = new Date()): string[] {
  return memories
    .filter((m) => {
      if (m.kind === "LONG_TERM" && m.importance >= 0.3) return false; // facts persist
      if (m.category === "first_meeting" || m.category === "milestone" || m.category === "promise") return false;
      return memoryStrength(m, now) < FORGET_THRESHOLD;
    })
    .map((m) => m.id);
}

// ─── Prompt formatting ──────────────────────────────────────────────────────

export function formatMemoriesForPrompt(items: ScoredMemory[], now = new Date()): string {
  const facts = items.filter((i) => i.memory.kind === "LONG_TERM");
  const episodes = items.filter((i) => i.memory.kind === "EPISODIC");
  const lines: string[] = [];
  if (facts.length) {
    lines.push("What you know about them:");
    for (const f of facts) lines.push(`- ${f.memory.content}`);
  }
  if (episodes.length) {
    lines.push("Moments you remember together:");
    for (const e of episodes) lines.push(`- ${e.memory.content} (${ago(e.memory.timestamp, now)})`);
  }
  return lines.join("\n");
}

function ago(ts: Date, now: Date): string {
  const mins = (now.getTime() - ts.getTime()) / 60000;
  if (mins < 60) return "just now";
  if (mins < 60 * 24) return "earlier today";
  const days = Math.round(mins / 1440);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  if (days < 30) return `${Math.round(days / 7)} weeks ago`;
  return `${Math.round(days / 30)} months ago`;
}

const normaliseText = (s: string) => s.toLowerCase().replace(/\W+/g, " ").trim();
