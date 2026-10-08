"use client";
import Link from "next/link";
import { useMemo, useState } from "react";
import { Portrait } from "@/components/Avatar";

type Card = { id: string; name: string; age: number; tagline: string; tags: string[]; avatarUrl: string | null; mine: boolean };

export function Discover({ characters }: { characters: Card[] }) {
  const [q, setQ] = useState("");
  const [tag, setTag] = useState<string | null>(null);
  const tags = useMemo(() => {
    const counts = new Map<string, number>();
    characters.forEach((c) => c.tags.forEach((t) => counts.set(t, (counts.get(t) ?? 0) + 1)));
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([t]) => t);
  }, [characters]);
  const shown = characters.filter(
    (c) => (!tag || c.tags.includes(tag)) && (!q || `${c.name} ${c.tagline} ${c.tags.join(" ")}`.toLowerCase().includes(q.toLowerCase())),
  );

  return (
    <main className="flex-1 px-5 pb-6">
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search characters"
        className="w-full rounded-full border border-ink-700 bg-ink-900 px-4 py-2.5 text-sm placeholder:text-ink-400 focus:border-amber-glow/60 focus:outline-none"
      />
      <div className="no-scrollbar -mx-5 mt-3 flex gap-2 overflow-x-auto px-5">
        {[null, ...tags].map((t) => (
          <button
            key={t ?? "all"}
            onClick={() => setTag(t)}
            className={`shrink-0 rounded-full border px-3 py-1 text-xs ${tag === t ? "border-amber-glow/60 bg-amber-glow/10 text-amber-glow" : "border-ink-700 text-ink-300"}`}
          >
            {t ?? "All"}
          </button>
        ))}
      </div>
      <div className="mt-5 grid grid-cols-2 gap-3">
        {shown.map((c) => (
          <Link key={c.id} href={`/c/${c.id}`} className="group fade-in relative aspect-[3/4] overflow-hidden rounded-2xl bg-ink-850">
            <Portrait name={c.name} src={c.avatarUrl} className="transition duration-500 group-hover:scale-105" />
            <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-ink-950 via-ink-950/70 to-transparent p-3 pt-10">
              <p className="font-display text-lg leading-tight">
                {c.name} <span className="text-sm text-ink-300">{c.age}</span>
              </p>
              <p className="mt-0.5 line-clamp-2 text-xs text-ink-300">{c.tagline}</p>
            </div>
            {c.mine && <span className="absolute right-2 top-2 rounded-full bg-ink-950/70 px-2 py-0.5 text-[10px] text-amber-glow">yours</span>}
          </Link>
        ))}
      </div>
      {!shown.length && <p className="mt-10 text-center text-sm text-ink-400">No one here yet. Create someone.</p>}
    </main>
  );
}
