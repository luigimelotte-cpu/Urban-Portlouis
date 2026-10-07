"use client";
import { useEffect, useState } from "react";

type Memory = { id: string; kind: "EPISODIC" | "LONG_TERM"; category: string; content: string; importance: number; timestamp: string };
type Rel = Record<"trust" | "affection" | "attraction" | "comfort" | "attachment" | "tension" | "conflict", number> & { stage: string; milestones: string[] };

const VARS = ["trust", "affection", "attraction", "comfort", "attachment", "tension", "conflict"] as const;

export function MemoryDrawer({ characterId, characterName, onClose, onReset }: { characterId: string; characterName: string; onClose: () => void; onReset: (stage?: string) => void }) {
  const [memories, setMemories] = useState<Memory[] | null>(null);
  const [rel, setRel] = useState<Rel | null>(null);
  const [emotions, setEmotions] = useState<{ emotion: string; value: number }[]>([]);
  const [tab, setTab] = useState<"LONG_TERM" | "EPISODIC" | "PHOTOS">("LONG_TERM");
  const [photos, setPhotos] = useState<{ id: string; url: string; caption: string }[] | null>(null);

  async function load() {
    const [m, s, p] = await Promise.all([
      fetch(`/api/characters/${characterId}/memories`).then((r) => r.json()),
      fetch(`/api/characters/${characterId}/state`).then((r) => r.json()),
      fetch(`/api/characters/${characterId}/images`).then((r) => r.json()),
    ]);
    setPhotos(p.images ?? []);
    setMemories(m.memories ?? []);
    setRel(s.relationship ?? null);
    setEmotions(s.emotions ?? []);
  }
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [characterId]);

  async function forget(id: string) {
    await fetch(`/api/memories/${id}`, { method: "DELETE" });
    setMemories((m) => m?.filter((x) => x.id !== id) ?? null);
  }

  async function reset(what: "relationship" | "memory") {
    const label = what === "memory" ? `Erase everything ${characterName} remembers about you?` : `Reset your relationship with ${characterName} to the beginning?`;
    if (!confirm(label)) return;
    await fetch(`/api/characters/${characterId}/reset`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ what }) });
    await load();
    onReset(what === "relationship" ? "STRANGER" : undefined);
  }

  const shown = memories?.filter((m) => m.kind === tab) ?? [];

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-ink-950/70 backdrop-blur-sm" onClick={onClose}>
      <div className="fade-in max-h-[85dvh] w-full max-w-md overflow-y-auto rounded-t-3xl border-t border-ink-700 bg-ink-900 p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))]" onClick={(e) => e.stopPropagation()}>
        <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-ink-600" />
        <h2 className="font-display text-2xl">You & {characterName}</h2>
        <p className="mt-0.5 text-xs text-ink-400">Private to you. Never shared, never public.</p>

        {rel && (
          <section className="mt-5 space-y-2">
            <p className="text-xs uppercase tracking-wider text-amber-glow">{rel.stage.replace("_", " ").toLowerCase()}</p>
            {VARS.map((k) => (
              <div key={k} className="flex items-center gap-3 text-xs">
                <span className="w-20 capitalize text-ink-300">{k}</span>
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-ink-800">
                  <div className={`h-full rounded-full ${k === "conflict" || k === "tension" ? "bg-rose-glow" : "bg-amber-glow"}`} style={{ width: `${rel[k]}%` }} />
                </div>
                <span className="w-7 text-right tabular-nums text-ink-400">{Math.round(rel[k])}</span>
              </div>
            ))}
            {emotions.length > 0 && <p className="pt-1 text-xs text-ink-300">Mood: {emotions.map((e) => e.emotion).join(", ")}</p>}
          </section>
        )}

        <section className="mt-6">
          <div className="flex gap-4 border-b border-ink-700 text-sm">
            {(["LONG_TERM", "EPISODIC", "PHOTOS"] as const).map((t) => (
              <button key={t} onClick={() => setTab(t)} className={`-mb-px border-b-2 pb-2 ${tab === t ? "border-amber-glow text-ink-100" : "border-transparent text-ink-400"}`}>
                {t === "LONG_TERM" ? "About you" : t === "EPISODIC" ? "Moments" : `Photos${photos?.length ? ` · ${photos.length}` : ""}`}
              </button>
            ))}
          </div>
          {tab === "PHOTOS" ? (
            photos && photos.length ? (
              <div className="grid grid-cols-3 gap-1.5 pt-3">
                {photos.map((ph) => (
                  <a key={ph.id} href={ph.url} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-lg" title={ph.caption}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={ph.url} alt={ph.caption} className="aspect-square w-full object-cover" loading="lazy" />
                  </a>
                ))}
              </div>
            ) : (
              <p className="py-6 text-center text-sm text-ink-400">No photos yet. Ask {characterName} for one with 📷.</p>
            )
          ) : memories === null ? (
            <p className="py-6 text-center text-sm text-ink-400">…</p>
          ) : shown.length === 0 ? (
            <p className="py-6 text-center text-sm text-ink-400">Nothing yet.</p>
          ) : (
            <ul className="divide-y divide-ink-800">
              {shown.map((m) => (
                <li key={m.id} className="flex items-start gap-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-ink-100">{m.content}</p>
                    <p className="mt-0.5 text-[11px] text-ink-400">
                      {m.category.replace("_", " ")} · importance {Math.round(m.importance * 100)}% · {new Date(m.timestamp).toLocaleDateString()}
                    </p>
                  </div>
                  <button onClick={() => forget(m.id)} className="shrink-0 text-xs text-ink-400 hover:text-rose-glow" aria-label="Forget">
                    forget
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <div className="mt-6 grid grid-cols-2 gap-2 text-sm">
          <button onClick={() => reset("relationship")} className="rounded-full border border-ink-700 py-2 text-ink-300">
            Reset relationship
          </button>
          <button onClick={() => reset("memory")} className="rounded-full border border-rose-deep/60 py-2 text-rose-glow">
            Erase memories
          </button>
        </div>
      </div>
    </div>
  );
}
