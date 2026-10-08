"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui";

export function StartChat({ characterId }: { characterId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function start() {
    setBusy(true);
    const res = await fetch("/api/conversations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ characterId }) });
    const data = await res.json();
    if (res.ok) router.push(`/chat/${data.id}`);
    else {
      setError(data.error ?? "Could not start chat");
      setBusy(false);
    }
  }
  return (
    <div className="fixed inset-x-0 bottom-0 z-10 mx-auto max-w-md bg-gradient-to-t from-ink-950 via-ink-950 to-transparent px-5 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-8">
      {error && <p className="mb-2 text-center text-sm text-rose-glow">{error}</p>}
      <Button onClick={start} disabled={busy} className="glow-ring w-full py-3.5 text-base">
        {busy ? "…" : "Start chat"}
      </Button>
    </div>
  );
}
