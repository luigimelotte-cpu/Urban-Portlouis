import { BottomNav } from "@/components/BottomNav";
import { listVisibleCharacters } from "@/server/services";
import { requireViewer } from "@/server/viewer";
import { Discover } from "./Discover";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const userId = await requireViewer();
  const characters = await listVisibleCharacters(userId);
  const cards = characters.map((c) => ({ id: c.id, name: c.name, age: c.age, tagline: c.tagline, tags: c.tags, avatarUrl: c.avatarUrl ?? null, mine: c.creatorId === userId }));
  return (
    <>
      <header className="px-5 pb-3 pt-6">
        <p className="text-xs uppercase tracking-[0.3em] text-amber-glow">Lumen</p>
        <h1 className="mt-1 font-display text-3xl">Who will you meet tonight?</h1>
      </header>
      <Discover characters={cards} />
      <BottomNav />
    </>
  );
}
