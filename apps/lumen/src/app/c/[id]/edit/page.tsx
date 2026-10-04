import { notFound } from "next/navigation";
import { CharacterForm } from "@/components/CharacterForm";
import { getVisibleCharacter } from "@/server/services";
import { requireViewer } from "@/server/viewer";

export const dynamic = "force-dynamic";

export default async function EditCharacterPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const userId = await requireViewer();
  const c = await getVisibleCharacter(id, userId);
  if (!c || c.creatorId !== userId) notFound();
  const { id: _id, creatorId: _creator, ...input } = c;
  return (
    <main className="flex-1">
      <header className="px-5 pb-4 pt-6">
        <h1 className="font-display text-3xl">Edit {c.name}</h1>
      </header>
      <CharacterForm initial={input} characterId={c.id} />
    </main>
  );
}
