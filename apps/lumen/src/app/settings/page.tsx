import { BottomNav } from "@/components/BottomNav";
import { requireViewer } from "@/server/viewer";
import { SettingsForm } from "./SettingsForm";

export default async function SettingsPage() {
  await requireViewer();
  return (
    <>
      <header className="px-5 pb-4 pt-6">
        <h1 className="font-display text-3xl">Settings</h1>
      </header>
      <main className="flex-1">
        <SettingsForm />
      </main>
      <BottomNav />
    </>
  );
}
