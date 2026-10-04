import Link from "next/link";
import { notFound } from "next/navigation";
import { Portrait } from "@/components/Avatar";
import { Tag } from "@/components/ui";
import { prisma } from "@/server/db";
import { getVisibleCharacter } from "@/server/services";
import { prismaChatStore } from "@/server/store";
import { requireViewer } from "@/server/viewer";
import { StartChat } from "./StartChat";

export const dynamic = "force-dynamic";

const STAGE: Record<string, string> = {
  STRANGER: "Strangers",
  ACQUAINTANCE: "Acquaintances",
  FRIEND: "Friends",
  CLOSE_FRIEND: "Close friends",
  ATTRACTION: "Something there",
  DATING: "Dating",
  RELATIONSHIP: "Together",
};

export default async function CharacterPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const userId = await requireViewer();
  const c = await getVisibleCharacter(id, userId);
  if (!c) notFound();
  const [rel, convs] = await Promise.all([
    prismaChatStore.getRelationship(userId, id),
    prisma.conversation.findMany({ where: { userId, characterId: id }, orderBy: { updatedAt: "desc" }, take: 5, select: { id: true, updatedAt: true } }),
  ]);

  return (
    <main className="flex-1 pb-28">
      <div className="relative aspect-[4/5] w-full overflow-hidden">
        <Portrait name={c.name} src={c.avatarUrl} />
        <div className="absolute inset-0 bg-gradient-to-t from-ink-950 via-ink-950/20 to-transparent" />
        <Link href="/" className="absolute left-4 top-4 rounded-full bg-ink-950/60 px-3 py-1.5 text-sm backdrop-blur">
          ← Back
        </Link>
        {c.creatorId === userId && (
          <Link href={`/c/${c.id}/edit`} className="absolute right-4 top-4 rounded-full bg-ink-950/60 px-3 py-1.5 text-sm backdrop-blur">
            Edit
          </Link>
        )}
        <div className="absolute inset-x-0 bottom-0 px-5 pb-4">
          <h1 className="font-display text-4xl">
            {c.name} <span className="text-2xl text-ink-300">{c.age}</span>
          </h1>
          <p className="mt-1 text-sm text-ink-300">{[c.gender, c.profile.occupation].filter(Boolean).join(" · ")}</p>
        </div>
      </div>
      <section className="space-y-5 px-5 pt-2">
        {c.tagline && <p className="font-display text-lg italic text-ink-100">“{c.tagline}”</p>}
        <div className="flex flex-wrap gap-1.5">
          {c.tags.map((t) => (
            <Tag key={t}>{t}</Tag>
          ))}
          {rel && rel.turnCount > 0 && <span className="rounded-full bg-rose-deep/25 px-2.5 py-0.5 text-[11px] text-rose-glow">{STAGE[rel.stage]}</span>}
        </div>
        {c.profile.personality && <p className="whitespace-pre-line text-sm leading-relaxed text-ink-300">{c.profile.personality}</p>}
        {c.profile.scenario && (
          <div className="rounded-2xl border border-ink-800 bg-ink-900 p-4">
            <p className="text-xs uppercase tracking-wider text-amber-glow">Scenario</p>
            <p className="mt-1.5 text-sm leading-relaxed text-ink-300">{c.profile.scenario}</p>
          </div>
        )}
        {convs.length > 0 && (
          <div>
            <p className="text-xs uppercase tracking-wider text-ink-400">Your conversations</p>
            <ul className="mt-2 space-y-1.5">
              {convs.map((cv) => (
                <li key={cv.id}>
                  <Link href={`/chat/${cv.id}`} className="block rounded-xl bg-ink-900 px-4 py-2.5 text-sm text-ink-300 hover:bg-ink-850">
                    Continue · {cv.updatedAt.toLocaleDateString()}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
      <StartChat characterId={c.id} />
    </main>
  );
}
