"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, Field, Input } from "@/components/ui";

export function AgeGate() {
  const router = useRouter();
  const [dob, setDob] = useState("");
  const [name, setName] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch("/api/session/verify-age", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dob, confirm, displayName: name || undefined }),
    });
    setBusy(false);
    if (res.ok) {
      router.replace("/");
      router.refresh();
    } else setError((await res.json().catch(() => ({}))).error ?? "Something went wrong.");
  }

  return (
    <form onSubmit={submit} className="mt-10 space-y-5">
      <Field label="Date of birth" hint="Only your birth year is stored.">
        <Input type="date" required value={dob} onChange={(e) => setDob(e.target.value)} max={new Date().toISOString().slice(0, 10)} />
      </Field>
      <Field label="What should characters call you?" hint="Optional — you can also just tell them in chat.">
        <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} placeholder="Your name" />
      </Field>
      <label className="flex items-start gap-3 text-sm text-ink-300">
        <input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} className="mt-1 accent-amber-glow" />
        <span>I am 18 or older, I understand all characters are fictional adults, and I agree to the content rules.</span>
      </label>
      {error && <p className="text-sm text-rose-glow">{error}</p>}
      <Button type="submit" disabled={!dob || !confirm || busy} className="w-full">
        {busy ? "…" : "Enter"}
      </Button>
    </form>
  );
}
