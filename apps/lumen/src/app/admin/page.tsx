"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Button, Field, Input, Segmented, Select } from "@/components/ui";

type Caps = { romance: boolean; mature_language: boolean; suggestive_content: boolean; adult_content: boolean };
type Provider = {
  id: string;
  label: string;
  adapter: string;
  model: string;
  baseUrl: string | null;
  apiKeyEnv: string | null;
  enabled: boolean;
  priority: number;
  capabilities: Caps;
  contextWindow: number;
  maxOutputTokens: number;
  temperature: number;
  roles: string[];
  options: Record<string, unknown>;
  available: boolean;
  maxMode: string | null;
};
type Mode = "SAFE" | "MATURE" | "ADULT";

const CAP_LABELS: [keyof Caps, string][] = [
  ["romance", "Romance"],
  ["mature_language", "Mature language"],
  ["suggestive_content", "Suggestive"],
  ["adult_content", "Adult"],
];

const NEW: Omit<Provider, "id" | "available" | "maxMode"> = {
  label: "",
  adapter: "openai-compatible",
  model: "",
  baseUrl: null,
  apiKeyEnv: "",
  enabled: true,
  priority: 50,
  capabilities: { romance: true, mature_language: false, suggestive_content: false, adult_content: false },
  contextWindow: 32000,
  maxOutputTokens: 1024,
  temperature: 0.9,
  roles: ["chat"],
  options: {},
};

export default function AdminPage() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [token, setToken] = useState("");
  const [providers, setProviders] = useState<Provider[]>([]);
  const [adapters, setAdapters] = useState<{ key: string; label: string }[]>([]);
  const [settings, setSettings] = useState<{ envCeiling: Mode; contentCeiling: Mode; routingFallback: "downgrade" | "refuse" } | null>(null);
  const [draft, setDraft] = useState<typeof NEW | null>(null);
  const [tests, setTests] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/admin/providers");
    if (res.status === 401) return setAuthed(false);
    const d = await res.json();
    setProviders(d.providers);
    setAdapters(d.adapters);
    setSettings(await fetch("/api/admin/settings").then((r) => r.json()));
    setAuthed(true);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function login(e: React.FormEvent) {
    e.preventDefault();
    const res = await fetch("/api/admin/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
    if (res.ok) load();
    else setError("Invalid token");
  }

  async function patch(id: string, body: Partial<Provider>) {
    const res = await fetch(`/api/admin/providers/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) setError(JSON.stringify((await res.json()).details ?? "Save failed"));
    load();
  }

  async function create() {
    if (!draft) return;
    const res = await fetch("/api/admin/providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...draft, baseUrl: draft.baseUrl || null, apiKeyEnv: draft.apiKeyEnv || null }),
    });
    if (!res.ok) return setError(JSON.stringify((await res.json()).details ?? "Create failed"));
    setDraft(null);
    load();
  }

  async function remove(id: string) {
    if (!confirm("Remove this provider?")) return;
    await fetch(`/api/admin/providers/${id}`, { method: "DELETE" });
    load();
  }

  async function test(id: string) {
    setTests((t) => ({ ...t, [id]: "testing…" }));
    const d = await fetch(`/api/admin/providers/${id}/test`, { method: "POST" }).then((r) => r.json());
    setTests((t) => ({ ...t, [id]: d.ok ? `✓ ${d.ms}ms · ${d.model} · “${d.sample}”` : `✗ ${d.error}` }));
  }

  async function saveSettings(body: Record<string, string>) {
    await fetch("/api/admin/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    load();
  }

  if (authed === null) return <p className="p-6 text-sm text-ink-400">…</p>;
  if (!authed)
    return (
      <main className="px-5 py-10">
        <h1 className="font-display text-3xl">Admin</h1>
        <form onSubmit={login} className="mt-6 space-y-3">
          <Input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="ADMIN_TOKEN" />
          {error && <p className="text-sm text-rose-glow">{error}</p>}
          <Button type="submit" className="w-full">
            Sign in
          </Button>
        </form>
      </main>
    );

  return (
    <main className="space-y-8 px-5 py-6 pb-16">
      <header className="flex items-center justify-between">
        <h1 className="font-display text-3xl">Models & policy</h1>
        <Link href="/settings" className="text-sm text-ink-400">
          Close
        </Link>
      </header>

      <p className="rounded-xl border border-ink-700 bg-ink-900 p-3 text-xs leading-relaxed text-ink-300">
        Declare each provider's capabilities to match <strong>that provider's own usage policy</strong>. The router only sends a conversation to a provider whose capabilities cover its content
        mode — it never works around a provider's restrictions. API keys stay in environment variables; here you only reference their names.
      </p>
      {error && (
        <p className="text-xs text-rose-glow" onClick={() => setError(null)}>
          {error}
        </p>
      )}

      {settings && (
        <section className="space-y-4">
          <Field label="Platform content ceiling" hint={`Env ceiling: ${settings.envCeiling}. The effective ceiling is the lower of the two.`}>
            <Segmented
              value={settings.contentCeiling}
              onChange={(v) => saveSettings({ contentCeiling: v })}
              options={(["SAFE", "MATURE", "ADULT"] as Mode[]).map((m) => ({ value: m, label: m.toLowerCase() }))}
            />
          </Field>
          <Field label="When no provider supports the requested mode">
            <Segmented
              value={settings.routingFallback}
              onChange={(v) => saveSettings({ routingFallback: v })}
              options={[
                { value: "downgrade", label: "Lower the mode" },
                { value: "refuse", label: "Refuse" },
              ]}
            />
          </Field>
        </section>
      )}

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-xs uppercase tracking-wider text-ink-300">Providers</h2>
          <button onClick={() => setDraft(draft ? null : { ...NEW })} className="text-sm text-amber-glow">
            {draft ? "Cancel" : "+ Add"}
          </button>
        </div>

        {draft && (
          <div className="space-y-3 rounded-2xl border border-amber-glow/30 bg-ink-900 p-4">
            <Field label="Adapter">
              <Select value={draft.adapter} onChange={(v) => setDraft({ ...draft, adapter: v, roles: v.endsWith("images") ? ["image"] : ["chat"] })} options={adapters.map((a) => ({ value: a.key, label: a.label }))} />
            </Field>
            <Input placeholder="Label" value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} />
            <Input placeholder="Model id" value={draft.model} onChange={(e) => setDraft({ ...draft, model: e.target.value })} />
            <Input placeholder="Base URL (optional)" value={draft.baseUrl ?? ""} onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })} />
            <Input placeholder="API key env var name, e.g. OPENROUTER_API_KEY" value={draft.apiKeyEnv ?? ""} onChange={(e) => setDraft({ ...draft, apiKeyEnv: e.target.value })} />
            <Caps value={draft.capabilities} onChange={(capabilities) => setDraft({ ...draft, capabilities })} />
            <Button onClick={create} disabled={!draft.label || !draft.model} className="w-full">
              Add provider
            </Button>
          </div>
        )}

        {providers.map((p) => (
          <div key={p.id} className={`space-y-3 rounded-2xl border p-4 ${p.enabled ? "border-ink-700 bg-ink-900" : "border-ink-800 bg-ink-950 opacity-70"}`}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="font-medium">{p.label}</p>
                <p className="truncate text-xs text-ink-400">
                  {p.adapter} · {p.model}
                  {p.apiKeyEnv ? ` · key: ${p.apiKeyEnv}` : ""}
                </p>
                <p className="mt-1 text-xs">
                  <span className={p.available ? "text-emerald-400" : "text-rose-glow"}>{p.available ? "ready" : "missing credentials"}</span>
                  <span className="text-ink-400"> · up to {p.maxMode?.toLowerCase() ?? "nothing"} · {p.roles.join(" + ")}</span>
                </p>
              </div>
              <label className="flex items-center gap-1.5 text-xs text-ink-300">
                <input type="checkbox" checked={p.enabled} onChange={(e) => patch(p.id, { enabled: e.target.checked })} className="accent-amber-glow" />
                on
              </label>
            </div>
            <Caps value={p.capabilities} onChange={(capabilities) => patch(p.id, { capabilities })} />
            <div className="grid grid-cols-3 gap-2 text-xs">
              <label className="space-y-1">
                <span className="text-ink-400">Priority</span>
                <Input type="number" defaultValue={p.priority} onBlur={(e) => patch(p.id, { priority: Number(e.target.value) })} />
              </label>
              <label className="space-y-1">
                <span className="text-ink-400">Context</span>
                <Input type="number" defaultValue={p.contextWindow} onBlur={(e) => patch(p.id, { contextWindow: Number(e.target.value) })} />
              </label>
              <label className="space-y-1">
                <span className="text-ink-400">Max out</span>
                <Input type="number" defaultValue={p.maxOutputTokens} onBlur={(e) => patch(p.id, { maxOutputTokens: Number(e.target.value) })} />
              </label>
            </div>
            <div className="flex flex-wrap gap-3 text-xs">
              {(["chat", "utility", "image"] as const).map((r) => (
                <label key={r} className="flex items-center gap-1.5 text-ink-300">
                  <input
                    type="checkbox"
                    checked={p.roles.includes(r)}
                    onChange={(e) => {
                      const roles = e.target.checked ? [...p.roles, r] : p.roles.filter((x) => x !== r);
                      if (roles.length) patch(p.id, { roles });
                    }}
                    className="accent-amber-glow"
                  />
                  {r}
                </label>
              ))}
            </div>
            <div className="flex items-center gap-3 text-xs">
              <button onClick={() => test(p.id)} className="text-amber-glow">
                Test
              </button>
              <button onClick={() => remove(p.id)} className="text-rose-glow">
                Remove
              </button>
            </div>
            {tests[p.id] && <p className="break-words text-xs text-ink-300">{tests[p.id]}</p>}
          </div>
        ))}
      </section>
    </main>
  );
}

function Caps({ value, onChange }: { value: Caps; onChange: (c: Caps) => void }) {
  return (
    <div className="grid grid-cols-2 gap-2 text-xs">
      {CAP_LABELS.map(([k, label]) => (
        <label key={k} className="flex items-center gap-2 text-ink-300">
          <input type="checkbox" checked={value[k]} onChange={(e) => onChange({ ...value, [k]: e.target.checked })} className="accent-amber-glow" />
          {label}
        </label>
      ))}
    </div>
  );
}
