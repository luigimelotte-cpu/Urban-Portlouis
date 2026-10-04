import Link from "next/link";
import { Avatar } from "@/components/Avatar";
import { BottomNav } from "@/components/BottomNav";
import { prisma } from "@/server/db";
import { requireViewer } from "@/server/viewer";

export const dynamic = "force-dynamic";

export default async function ChatsPage() {
  const userId = await requireViewer();
  const convs = await prisma.conversation.findMany({
    where: { userId },
    orderBy: { updatedAt: "desc" },
    take: 50,
    include: {
      character: { select: { name: true, avatarUrl: true } },
      messages: { orderBy: { createdAt: "desc" }, take: 1, select: { content: true, role: true } },
    },
  });
  return (
    <>
      <header className="px-5 pb-2 pt-6">
        <h1 className="font-display text-3xl">Chats</h1>
      </header>
      <main className="flex-1 px-3">
        {convs.length === 0 && <p className="mt-10 text-center text-sm text-ink-400">No conversations yet.</p>}
        <ul>
          {convs.map((c) => {
            const last = c.messages[0];
            const preview = last ? `${last.role === "USER" ? "You: " : ""}${last.content.replace(/\n\|\|\n/g, " ").replace(/\*[^*]+\*/g, "").trim()}` : "";
            return (
              <li key={c.id}>
                <Link href={`/chat/${c.id}`} className="flex items-center gap-3 rounded-2xl px-2 py-3 hover:bg-ink-900">
                  <Avatar name={c.character.name} src={c.character.avatarUrl} size={52} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <p className="font-medium">{c.character.name}</p>
                      <p className="shrink-0 text-[11px] text-ink-400">{c.updatedAt.toLocaleDateString()}</p>
                    </div>
                    <p className="truncate text-sm text-ink-400">{preview}</p>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      </main>
      <BottomNav />
    </>
  );
}
