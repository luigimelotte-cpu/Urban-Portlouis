import { BottomNav } from "@/components/BottomNav";
import { CharacterForm } from "@/components/CharacterForm";
import { requireViewer } from "@/server/viewer";

export default async function CreatePage() {
  await requireViewer();
  return (
    <>
      <header className="px-5 pb-4 pt-6">
        <h1 className="font-display text-3xl">Create a character</h1>
        <p className="mt-1 text-sm text-ink-400">Private by default. Every character is an adult.</p>
      </header>
      <main className="flex-1">
        <CharacterForm />
      </main>
      <BottomNav />
    </>
  );
}
