"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Button, Field, Input, Segmented, Select } from "@/components/ui";

type Mode = "SAFE" | "MATURE" | "ADULT";
type Style = "CHAT" | "ROLEPLAY" | "STORY";
type Me = { displayName: string | null; adultOptIn: boolean; settings: { preferredProviderId: string | null; defaultStyle: Style; memoryEnabled: boolean; imagesEnabled: boolean; requestedContentMode: Mode } };
type Provider = { id: string; label: string; maxMode: Mode | null };

const RANK: Record<Mode, number> = { SAFE: 0, MATURE: 1, ADULT: 2 };

export function SettingsForm() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [ceiling, setCeiling] = useState<Mode>("ADULT");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    fetch("/api/me").then((r) => r.json()).then(setMe);
    fetch("/api/providers")
      .then((r) => r.json())
      .then((d) => {
        setProviders(d.providers ?? []);
        setCeiling(d.ceiling ?? "ADULT");
      });
  }, []);

  if (!me) return <p className="px-5 text-sm text-ink-400">…</p>;

  async function save(patch: { displayName?: string | null; adultOptIn?: boolean; settings?: Partial<Me["settings"]> }) {
    const res = await fetch("/api/me", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
    const d = await res.json();
    if (res.ok) {
      setMe((m) => (m ? { ...m, displayName: patch.displayName !== undefined ? patch.displayName : m.displayName, adultOptIn: d.adultOptIn, settings: d.settings } : m));
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    }
  }

  async function deleteEverything() {
    if (!confirm("Delete your account, all conversations, memories and private characters? This cannot be undone.")) return;
    await fetch("/api/me", { method: "DELETE" });
    router.replace("/welcome");
  }

  const bestProviderMode = providers.reduce<Mode | null>((best, p) => (p.maxMode && (!best || RANK[p.maxMode] > RANK[best]) ? p.maxMode : best), null);

  return (
    <div className="space-y-7 px-5 pb-10">
      <Field label="Your name">
        <Input defaultValue={me.displayName ?? ""} onBlur={(e) => save({ displayName: e.target.value || null })} maxLength={40} />
      </Field>

      <Field label="Default conversation style">
        <Segmented
          value={me.settings.defaultStyle}
          onChange={(v) => save({ settings: { defaultStyle: v } })}
          options={[
            { value: "CHAT", label: "Chat" },
            { value: "ROLEPLAY", label: "Roleplay" },
            { value: "STORY", label: "Story" },
          ]}
        />
      </Field>

      <section className="space-y-3">
        <Field label="Content mode" hint="Applies to new conversations. Each character and model may cap it lower.">
          <Segmented
            value={me.settings.requestedContentMode}
            onChange={(v) => save({ settings: { requestedContentMode: v } })}
            options={[
              { value: "SAFE", label: "Safe" },
              { value: "MATURE", label: "Mature" },
              { value: "ADULT", label: "Adult", disabled: !me.adultOptIn || ceiling !== "ADULT" },
            ]}
          />
        </Field>
        <label className="flex items-start gap-3 rounded-xl border border-ink-700 p-3 text-sm">
          <input type="checkbox" checked={me.adultOptIn} onChange={(e) => save({ adultOptIn: e.target.checked })} className="mt-0.5 accent-amber-glow" />
          <span>
            <span className="text-ink-100">Enable adult mode</span>
            <span className="mt-0.5 block text-xs text-ink-400">I confirm I'm 18+ and want adult themes between fictional adult characters, within each model provider's own rules.</span>
          </span>
        </label>
        {me.settings.requestedContentMode !== "SAFE" && bestProviderMode && RANK[bestProviderMode] < RANK[me.settings.requestedContentMode] && (
          <p className="text-xs text-amber-glow">No configured model currently supports {me.settings.requestedContentMode.toLowerCase()} mode — replies will use {bestProviderMode.toLowerCase()}.</p>
        )}
      </section>

      <Field label="Model" hint="Used when it supports the conversation's content mode; otherwise the best compatible model is chosen.">
        <Select
          value={me.settings.preferredProviderId ?? ""}
          onChange={(v) => save({ settings: { preferredProviderId: v || null } })}
          options={[{ value: "", label: "Automatic" }, ...providers.map((p) => ({ value: p.id, label: `${p.label}${p.maxMode ? ` · up to ${p.maxMode.toLowerCase()}` : ""}` }))]}
        />
      </Field>

      <label className="flex items-center justify-between rounded-xl border border-ink-700 p-3 text-sm">
        <span>
          <span className="text-ink-100">Memory</span>
          <span className="mt-0.5 block text-xs text-ink-400">Characters remember facts and moments across conversations.</span>
        </span>
        <input type="checkbox" checked={me.settings.memoryEnabled} onChange={(e) => save({ settings: { memoryEnabled: e.target.checked } })} className="accent-amber-glow" />
      </label>

      <label className="flex items-center justify-between rounded-xl border border-ink-700 p-3 text-sm">
        <span>
          <span className="text-ink-100">Photos</span>
          <span className="mt-0.5 block text-xs text-ink-400">Characters can send you pictures when you ask, or on their own. Images follow the same content mode.</span>
        </span>
        <input type="checkbox" checked={me.settings.imagesEnabled !== false} onChange={(e) => save({ settings: { imagesEnabled: e.target.checked } })} className="accent-amber-glow" />
      </label>

      <section className="space-y-2 border-t border-ink-800 pt-6">
        <p className="text-xs uppercase tracking-wider text-ink-300">Privacy</p>
        <p className="text-xs text-ink-400">Your conversations and memories are private and never published. Per-character resets live in each chat's memory panel.</p>
        <a href="/api/me/export" className="block rounded-full border border-ink-700 py-2.5 text-center text-sm">
          Export all my data
        </a>
        <Button variant="danger" onClick={deleteEverything} className="w-full">
          Delete my account & data
        </Button>
      </section>

      <p className="text-center text-xs text-ink-400">
        <Link href="/admin" className="underline-offset-2 hover:underline">
          Admin
        </Link>
      </p>
      {saved && <p className="fixed inset-x-0 bottom-20 mx-auto w-fit rounded-full bg-ink-800 px-4 py-2 text-xs text-amber-glow">Saved</p>}
    </div>
  );
}
