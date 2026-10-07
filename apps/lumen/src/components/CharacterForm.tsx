"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { CharacterInput } from "@/core/character/profile";
import { Avatar } from "./Avatar";
import { Button, Field, Input, Segmented, Select, Textarea } from "./ui";

const STAGES = ["STRANGER", "ACQUAINTANCE", "FRIEND", "CLOSE_FRIEND", "ATTRACTION", "DATING", "RELATIONSHIP"] as const;
const TRAITS: { key: keyof CharacterInput["profile"]["traits"]; label: string; low: string; high: string }[] = [
  { key: "initiative", label: "Initiative", low: "follows your lead", high: "drives the conversation" },
  { key: "confidence", label: "Confidence", low: "shy, flustered", high: "bold, direct" },
  { key: "playfulness", label: "Playfulness", low: "earnest", high: "teasing, joking" },
  { key: "affection", label: "Affection", low: "reserved", high: "openly warm" },
  { key: "romance", label: "Romance", low: "slow burn", high: "hopeless romantic" },
  { key: "jealousy", label: "Jealousy", low: "secure", high: "possessive" },
];

export const EMPTY_CHARACTER: CharacterInput = {
  name: "",
  age: 25,
  gender: "woman",
  tagline: "",
  tags: [],
  avatarUrl: null,
  visibility: "PRIVATE",
  maxContentMode: "MATURE",
  profile: {
    appearance: "",
    personality: "",
    background: "",
    occupation: "",
    interests: [],
    likes: [],
    dislikes: [],
    speechStyle: "",
    relationshipStyle: "",
    flirtingStyle: "",
    humorStyle: "",
    emotionalTraits: [],
    boundaries: "",
    scenario: "",
    initialRelationship: "STRANGER",
    characterGoals: [],
    exampleLines: [],
    openingMessage: "",
    defaultStyle: "ROLEPLAY",
    imageStyle: "photoreal",
    traits: { initiative: 55, jealousy: 25, affection: 50, confidence: 55, playfulness: 55, romance: 45 },
  },
};

const toList = (s: string) => s.split(/[,\n]/).map((x) => x.trim()).filter(Boolean);
const fromList = (l: string[]) => l.join(", ");

export function CharacterForm({ initial, characterId }: { initial?: CharacterInput; characterId?: string }) {
  const router = useRouter();
  const [c, setC] = useState<CharacterInput>(initial ?? EMPTY_CHARACTER);
  const [description, setDescription] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState<"structure" | "save" | "portrait" | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);

  const set = <K extends keyof CharacterInput>(k: K, v: CharacterInput[K]) => setC((s) => ({ ...s, [k]: v }));
  const setP = <K extends keyof CharacterInput["profile"]>(k: K, v: CharacterInput["profile"][K]) => setC((s) => ({ ...s, profile: { ...s.profile, [k]: v } }));

  async function structure() {
    setBusy("structure");
    setErrors([]);
    const res = await fetch("/api/characters/structure", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ description }) });
    const data = await res.json();
    setBusy(null);
    if (!res.ok) return setErrors([data.error ?? "Could not build a profile."]);
    setC({ ...data.input, avatarUrl: c.avatarUrl, visibility: c.visibility });
    setWarnings([...(data.warnings ?? []), data.source === "heuristic" ? "Built offline from keywords — review and refine the fields." : ""].filter(Boolean));
  }

  async function generatePortrait() {
    setBusy("portrait");
    setErrors([]);
    const res = await fetch("/api/images/portrait", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        age: c.age,
        gender: c.gender,
        appearance: c.profile.appearance,
        occupation: c.profile.occupation,
        style: c.profile.imageStyle,
        characterId: characterId ?? null,
      }),
    });
    const data = await res.json();
    setBusy(null);
    if (!res.ok) return setErrors([data.error ?? "Could not generate a portrait.", ...(Array.isArray(data.details) ? data.details.map((d: { message?: string }) => d.message ?? "") : [])].filter(Boolean));
    set("avatarUrl", data.url);
  }

  async function onAvatar(file: File | undefined) {
    if (!file) return;
    const url = await resizeImage(file, 640);
    set("avatarUrl", url);
  }

  async function save() {
    setBusy("save");
    setErrors([]);
    const res = await fetch(characterId ? `/api/characters/${characterId}` : "/api/characters", {
      method: characterId ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(c),
    });
    const data = await res.json();
    setBusy(null);
    if (!res.ok) return setErrors([data.error, ...(Array.isArray(data.details) ? data.details : [])].filter(Boolean));
    router.push(`/c/${data.character.id}`);
    router.refresh();
  }

  async function remove() {
    if (!characterId || !confirm(`Delete ${c.name}? Everyone's chats with this character will be deleted.`)) return;
    await fetch(`/api/characters/${characterId}`, { method: "DELETE" });
    router.push("/");
    router.refresh();
  }

  return (
    <div className="space-y-6 px-5 pb-10">
      {!characterId && (
        <section className="rounded-2xl border border-amber-glow/25 bg-gradient-to-br from-ink-850 to-ink-900 p-4">
          <Field label="Describe this character in your own words" hint="We'll turn it into a full profile you can tweak.">
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Mila, 27, a sarcastic tattoo artist in Lisbon who pretends not to care but remembers everything you tell her…"
              className="min-h-28"
            />
          </Field>
          <Button onClick={structure} disabled={description.trim().length < 10 || !!busy} className="mt-3 w-full">
            {busy === "structure" ? "Building…" : "Build profile"}
          </Button>
        </section>
      )}

      {warnings.length > 0 && (
        <div className="space-y-1 rounded-xl bg-amber-glow/10 p-3 text-xs text-amber-glow">
          {warnings.map((w) => (
            <p key={w}>{w}</p>
          ))}
        </div>
      )}

      <div className="flex items-center gap-4">
        <label className="cursor-pointer">
          <Avatar name={c.name || "?"} src={c.avatarUrl} size={84} className="ring-1 ring-ink-700" />
          <input type="file" accept="image/*" className="hidden" onChange={(e) => onAvatar(e.target.files?.[0])} />
        </label>
        <div className="flex-1 space-y-2">
          <Input value={c.name} onChange={(e) => set("name", e.target.value)} placeholder="Name" maxLength={60} />
          <div className="flex gap-2">
            <Input type="number" min={18} max={1000} value={c.age} onChange={(e) => set("age", Number(e.target.value))} className="w-20" aria-label="Age" />
            <Input value={c.gender} onChange={(e) => set("gender", e.target.value)} placeholder="Gender" maxLength={40} />
          </div>
        </div>
      </div>
      <p className="-mt-3 text-[11px] text-ink-400">Tap the portrait to upload a picture, or generate one from the appearance below. Characters must be 18 or older.</p>

      <Field label="Tagline">
        <Input value={c.tagline} onChange={(e) => set("tagline", e.target.value)} placeholder="One line that makes people curious" maxLength={160} />
      </Field>
      <Field label="Appearance" hint="Also used for every picture of this character, so their look stays consistent.">
        <Textarea value={c.profile.appearance} onChange={(e) => setP("appearance", e.target.value)} />
      </Field>
      <section className="space-y-3 rounded-2xl border border-ink-700 bg-ink-900 p-4">
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs font-medium uppercase tracking-wider text-ink-300">Image style</span>
          {c.avatarUrl?.startsWith("/api/images/") && <span className="text-[11px] text-amber-glow">Portrait generated</span>}
        </div>
        <Segmented
          value={c.profile.imageStyle}
          onChange={(v) => setP("imageStyle", v)}
          options={[
            { value: "photoreal", label: "Photo" },
            { value: "cinematic", label: "Cinematic" },
            { value: "illustration", label: "Illustration" },
          ]}
        />
        <Button variant="ghost" onClick={generatePortrait} disabled={!!busy || c.profile.appearance.trim().length < 10} className="w-full">
          {busy === "portrait" ? "Developing portrait…" : c.avatarUrl ? "Regenerate portrait" : "Generate portrait"}
        </Button>
        {c.profile.appearance.trim().length < 10 && <p className="text-[11px] text-ink-400">Describe their appearance first.</p>}
      </section>
      <Field label="Personality">
        <Textarea value={c.profile.personality} onChange={(e) => setP("personality", e.target.value)} />
      </Field>
      <Field label="Backstory">
        <Textarea value={c.profile.background} onChange={(e) => setP("background", e.target.value)} />
      </Field>
      <Field label="Relationship at the start">
        <Select value={c.profile.initialRelationship} onChange={(v) => setP("initialRelationship", v as (typeof STAGES)[number])} options={STAGES.map((s) => ({ value: s, label: s.replace("_", " ").toLowerCase() }))} />
      </Field>
      <Field label="Scenario" hint="Where and how you meet. Written to the user (you).">
        <Textarea value={c.profile.scenario} onChange={(e) => setP("scenario", e.target.value)} />
      </Field>
      <Field label="Conversation style">
        <Segmented
          value={c.profile.defaultStyle}
          onChange={(v) => setP("defaultStyle", v)}
          options={[
            { value: "CHAT", label: "Chat" },
            { value: "ROLEPLAY", label: "Roleplay" },
            { value: "STORY", label: "Story" },
          ]}
        />
      </Field>
      <Field label="Opening message" hint="Their first message. *Actions* in asterisks.">
        <Textarea value={c.profile.openingMessage} onChange={(e) => setP("openingMessage", e.target.value)} />
      </Field>
      <Field label="Tags" hint="Comma-separated">
        <Input value={fromList(c.tags)} onChange={(e) => set("tags", toList(e.target.value).map((t) => t.toLowerCase()))} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Visibility">
          <Select
            value={c.visibility}
            onChange={(v) => set("visibility", v as CharacterInput["visibility"])}
            options={[
              { value: "PRIVATE", label: "Only me" },
              { value: "UNLISTED", label: "Link only" },
              { value: "PUBLIC", label: "Public" },
            ]}
          />
        </Field>
        <Field label="Max content">
          <Select
            value={c.maxContentMode}
            onChange={(v) => set("maxContentMode", v as CharacterInput["maxContentMode"])}
            options={[
              { value: "SAFE", label: "Safe" },
              { value: "MATURE", label: "Mature" },
              { value: "ADULT", label: "Adult" },
            ]}
          />
        </Field>
      </div>

      <button onClick={() => setAdvanced((v) => !v)} className="flex w-full items-center justify-between rounded-xl border border-ink-700 px-4 py-3 text-sm">
        <span>Advanced settings</span>
        <span className="text-ink-400">{advanced ? "−" : "+"}</span>
      </button>

      {advanced && (
        <div className="fade-in space-y-5">
          <section className="space-y-4 rounded-2xl bg-ink-900 p-4">
            {TRAITS.map((t) => (
              <div key={t.key}>
                <div className="flex justify-between text-xs">
                  <span className="font-medium text-ink-100">{t.label}</span>
                  <span className="tabular-nums text-amber-glow">{c.profile.traits[t.key]}</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={c.profile.traits[t.key]}
                  onChange={(e) => setP("traits", { ...c.profile.traits, [t.key]: Number(e.target.value) })}
                  className="mt-1 w-full"
                />
                <div className="flex justify-between text-[10px] text-ink-400">
                  <span>{t.low}</span>
                  <span>{t.high}</span>
                </div>
              </div>
            ))}
          </section>
          <Field label="Occupation">
            <Input value={c.profile.occupation} onChange={(e) => setP("occupation", e.target.value)} />
          </Field>
          <Field label="Interests">
            <Input value={fromList(c.profile.interests)} onChange={(e) => setP("interests", toList(e.target.value))} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Likes">
              <Input value={fromList(c.profile.likes)} onChange={(e) => setP("likes", toList(e.target.value))} />
            </Field>
            <Field label="Dislikes">
              <Input value={fromList(c.profile.dislikes)} onChange={(e) => setP("dislikes", toList(e.target.value))} />
            </Field>
          </div>
          <Field label="Speech style" hint="Vocabulary, rhythm, slang, emoji use, languages…">
            <Textarea value={c.profile.speechStyle} onChange={(e) => setP("speechStyle", e.target.value)} className="min-h-16" />
          </Field>
          <Field label="Flirting style">
            <Textarea value={c.profile.flirtingStyle} onChange={(e) => setP("flirtingStyle", e.target.value)} className="min-h-16" />
          </Field>
          <Field label="Humour">
            <Input value={c.profile.humorStyle} onChange={(e) => setP("humorStyle", e.target.value)} />
          </Field>
          <Field label="In relationships">
            <Textarea value={c.profile.relationshipStyle} onChange={(e) => setP("relationshipStyle", e.target.value)} className="min-h-16" />
          </Field>
          <Field label="Emotional traits">
            <Input value={fromList(c.profile.emotionalTraits)} onChange={(e) => setP("emotionalTraits", toList(e.target.value))} />
          </Field>
          <Field label="Goals" hint="What they want — drives their initiative.">
            <Textarea value={c.profile.characterGoals.join("\n")} onChange={(e) => setP("characterGoals", e.target.value.split("\n").map((s) => s.trim()).filter(Boolean))} className="min-h-16" />
          </Field>
          <Field label="Boundaries" hint="Topics or pace this character won't go along with.">
            <Textarea value={c.profile.boundaries} onChange={(e) => setP("boundaries", e.target.value)} className="min-h-16" />
          </Field>
          <Field label="Example lines" hint="One per line, in their voice. The strongest style anchor.">
            <Textarea value={c.profile.exampleLines.join("\n")} onChange={(e) => setP("exampleLines", e.target.value.split("\n").map((s) => s.trim()).filter(Boolean))} />
          </Field>
        </div>
      )}

      {errors.length > 0 && (
        <div className="space-y-1 rounded-xl bg-rose-deep/15 p-3 text-xs text-rose-glow">
          {errors.map((e) => (
            <p key={e}>{e}</p>
          ))}
        </div>
      )}
      <Button onClick={save} disabled={!c.name.trim() || c.age < 18 || !!busy} className="w-full py-3">
        {busy === "save" ? "Saving…" : characterId ? "Save changes" : "Create character"}
      </Button>
      {characterId && (
        <Button variant="danger" onClick={remove} className="w-full">
          Delete character
        </Button>
      )}
    </div>
  );
}

function resizeImage(file: File, max: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/jpeg", 0.85));
      URL.revokeObjectURL(img.src);
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}
