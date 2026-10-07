"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { Avatar } from "@/components/Avatar";
import { MemoryDrawer } from "./MemoryDrawer";
import { hidePhotoTags } from "@/core/images/tags";

export type MsgImage = { id?: string; caption: string; status: "pending" | "ready" | "failed"; error?: string };
export type Msg = { id: string; role: "user" | "character" | "system"; content: string; createdAt: string; meta?: { kind?: string; notices?: string[]; images?: MsgImage[] } };
type Mode = "SAFE" | "MATURE" | "ADULT";
type Style = "CHAT" | "ROLEPLAY" | "STORY";

export interface ChatViewProps {
  conversationId: string;
  character: { id: string; name: string; avatarUrl: string | null };
  initialMessages: Msg[];
  initialStyle: Style;
  initialMode: Mode;
  initialStage: string;
  adultOptIn: boolean;
}

const STAGE: Record<string, string> = {
  STRANGER: "strangers",
  ACQUAINTANCE: "acquaintances",
  FRIEND: "friends",
  CLOSE_FRIEND: "close friends",
  ATTRACTION: "something there",
  DATING: "dating",
  RELATIONSHIP: "together",
};
const EMOJI: Record<string, string> = {
  happy: "☺",
  sad: "☁",
  excited: "✦",
  annoyed: "≈",
  jealous: "◐",
  affectionate: "♡",
  playful: "~",
  shy: "◌",
  confident: "▲",
  romantic: "❦",
};

export function ChatView(props: ChatViewProps) {
  const router = useRouter();
  const [messages, setMessages] = useState<Msg[]>(props.initialMessages);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notices, setNotices] = useState<string[]>([]);
  const [stage, setStage] = useState(props.initialStage);
  const [mood, setMood] = useState<{ emotion: string; value: number }[]>([]);
  const [style, setStyle] = useState<Style>(props.initialStyle);
  const [mode, setMode] = useState<Mode>(props.initialMode);
  const [effectiveMode, setEffectiveMode] = useState<Mode | null>(null);
  const [menu, setMenu] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [viewer, setViewer] = useState<MsgImage | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const abort = useRef<AbortController | null>(null);
  const nudged = useRef(false);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, streaming]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  const runTurn = useCallback(
    async (payload: Record<string, unknown>, optimistic?: Msg) => {
      setBusy(true);
      setNotices([]);
      if (optimistic) setMessages((m) => [...m, optimistic]);
      abort.current = new AbortController();
      let res: Response;
      try {
        res = await fetch(`/api/conversations/${props.conversationId}/turn`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: abort.current.signal,
        });
      } catch {
        setBusy(false);
        return;
      }
      const ctype = res.headers.get("content-type") ?? "";
      if (!res.ok || !ctype.includes("text/event-stream")) {
        const data = await res.json().catch(() => ({}));
        if (!data.skipped) setToast(data.error ?? "Something went wrong.");
        if (optimistic && !res.ok) setMessages((m) => m.filter((x) => x.id !== optimistic.id));
        setBusy(false);
        return;
      }
      if (payload.kind !== "send") setStreaming("");
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let text = "";
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf("\n\n")) >= 0) {
            const chunk = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const line = chunk.split("\n").find((l) => l.startsWith("data: "));
            if (!line) continue;
            const ev = JSON.parse(line.slice(6));
            switch (ev.type) {
              case "meta":
                setEffectiveMode(ev.mode);
                if (ev.notices?.length) setNotices(ev.notices);
                setMessages((m) => {
                  let next = m.filter((x) => !(ev.removedMessageIds ?? []).includes(x.id));
                  if (ev.userMessage) {
                    const um = { ...ev.userMessage, createdAt: ev.userMessage.createdAt } as Msg;
                    next = optimistic ? next.map((x) => (x.id === optimistic.id ? um : x)) : next.map((x) => (x.id === um.id ? um : x));
                  }
                  return next;
                });
                setStreaming("");
                break;
              case "delta":
                text += ev.text;
                setStreaming(text);
                break;
              case "message":
                setStreaming(null);
                setMessages((m) => [...m, ev.message]);
                if (ev.message.meta?.notices?.length) setNotices((n) => [...new Set([...n, ...ev.message.meta.notices])]);
                break;
              case "image":
                setMessages((m) =>
                  m.map((x) => {
                    if (x.id !== ev.messageId) return x;
                    const images = [...(x.meta?.images ?? [])];
                    images[ev.index] = ev.image;
                    return { ...x, meta: { ...x.meta, images } };
                  }),
                );
                if (ev.image.status === "failed" && ev.image.error) setToast(ev.image.error);
                break;
              case "state":
                setStage(ev.relationship.stage);
                setMood(ev.emotions);
                if (ev.stageChanged) setToast(`You're now ${STAGE[ev.stageChanged.to] ?? ev.stageChanged.to}.`);
                else if (ev.newMemories > 0) setToast(`${props.character.name} will remember that.`);
                break;
              case "error":
                setToast(ev.message);
                setStreaming(null);
                if (optimistic) setMessages((m) => m.filter((x) => x.id !== optimistic.id));
                break;
            }
          }
        }
      } catch {
        /* aborted */
      }
      setStreaming(null);
      setBusy(false);
    },
    [props.conversationId, props.character.name],
  );

  // Proactive message when coming back after a while (server decides).
  useEffect(() => {
    if (nudged.current) return;
    nudged.current = true;
    if (props.initialMessages.length) runTurn({ kind: "nudge" });
    fetch(`/api/characters/${props.character.id}/state`)
      .then((r) => r.json())
      .then((d) => d.emotions && setMood(d.emotions))
      .catch(() => undefined);
  }, [props.initialMessages.length, props.character.id, runTurn]);

  function askForPhoto() {
    if (busy) return;
    const text = "Send me a photo? 📷";
    runTurn({ kind: "send", text }, { id: `tmp-${Date.now()}`, role: "user", content: text, createdAt: new Date().toISOString() });
  }

  function send() {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    runTurn({ kind: "send", text }, { id: `tmp-${Date.now()}`, role: "user", content: text, createdAt: new Date().toISOString() });
  }

  async function deleteMessage(id: string) {
    setSelected(null);
    await fetch(`/api/conversations/${props.conversationId}/messages/${id}`, { method: "DELETE" });
    setMessages((m) => m.filter((x) => x.id !== id));
  }

  function saveEdit() {
    if (!editing) return;
    const { id, text } = editing;
    setEditing(null);
    setSelected(null);
    setMessages((m) => {
      const i = m.findIndex((x) => x.id === id);
      return i < 0 ? m : [...m.slice(0, i), { ...m[i], content: text }];
    });
    runTurn({ kind: "edit", messageId: id, text });
  }

  async function patchConversation(patch: { style?: Style; contentMode?: Mode }) {
    await fetch(`/api/conversations/${props.conversationId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
    if (patch.style) setStyle(patch.style);
    if (patch.contentMode) setMode(patch.contentMode);
  }

  async function newConversation() {
    const res = await fetch("/api/conversations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ characterId: props.character.id, style, contentMode: mode }) });
    const d = await res.json();
    if (res.ok) router.push(`/chat/${d.id}`);
  }

  async function deleteConversation() {
    if (!confirm("Delete this conversation permanently?")) return;
    await fetch(`/api/conversations/${props.conversationId}`, { method: "DELETE" });
    router.push("/chats");
  }

  const lastCharacterId = [...messages].reverse().find((m) => m.role === "character")?.id;
  const lastIsCharacter = messages[messages.length - 1]?.role === "character";

  return (
    <div className="flex h-dvh flex-col">
      {/* Header */}
      <header className="z-10 flex items-center gap-3 border-b border-ink-800 bg-ink-950/95 px-3 py-2.5 backdrop-blur">
        <Link href="/chats" className="px-1 text-xl text-ink-300" aria-label="Back">
          ‹
        </Link>
        <Link href={`/c/${props.character.id}`}>
          <Avatar name={props.character.name} src={props.character.avatarUrl} size={40} />
        </Link>
        <button onClick={() => setDrawer(true)} className="min-w-0 flex-1 text-left">
          <p className="truncate font-medium leading-tight">{props.character.name}</p>
          <p className="truncate text-[11px] text-ink-400">
            {busy && streaming !== null ? "typing…" : STAGE[stage] ?? stage}
            {mood[0] && !busy && (
              <span className="ml-1.5 text-amber-glow/80">
                · {EMOJI[mood[0].emotion]} {mood[0].emotion}
              </span>
            )}
          </p>
        </button>
        <span className="rounded-full border border-ink-700 px-2 py-0.5 text-[10px] text-ink-300" title="Content mode">
          {effectiveMode ?? mode}
        </span>
        <button onClick={() => setMenu((v) => !v)} className="px-2 text-xl text-ink-300" aria-label="Menu">
          ⋯
        </button>
      </header>

      {menu && (
        <div className="fade-in absolute right-3 top-14 z-30 w-64 space-y-3 rounded-2xl border border-ink-700 bg-ink-900 p-4 text-sm shadow-2xl">
          <div>
            <p className="mb-1.5 text-[11px] uppercase tracking-wider text-ink-400">Style</p>
            <div className="flex gap-1">
              {(["CHAT", "ROLEPLAY", "STORY"] as Style[]).map((s) => (
                <button key={s} onClick={() => patchConversation({ style: s })} className={`flex-1 rounded-lg py-1.5 text-[11px] ${style === s ? "bg-ink-700 text-amber-glow" : "text-ink-300"}`}>
                  {s.toLowerCase()}
                </button>
              ))}
            </div>
          </div>
          <div>
            <p className="mb-1.5 text-[11px] uppercase tracking-wider text-ink-400">Content</p>
            <div className="flex gap-1">
              {(["SAFE", "MATURE", "ADULT"] as Mode[]).map((m) => (
                <button
                  key={m}
                  disabled={m === "ADULT" && !props.adultOptIn}
                  onClick={() => patchConversation({ contentMode: m })}
                  className={`flex-1 rounded-lg py-1.5 text-[11px] disabled:opacity-30 ${mode === m ? "bg-ink-700 text-amber-glow" : "text-ink-300"}`}
                >
                  {m.toLowerCase()}
                </button>
              ))}
            </div>
            {!props.adultOptIn && <p className="mt-1 text-[11px] text-ink-400">Adult mode: enable it in Settings.</p>}
          </div>
          <hr className="border-ink-700" />
          <button onClick={() => (setDrawer(true), setMenu(false))} className="block w-full text-left text-ink-100">
            Memories & relationship
          </button>
          <button onClick={newConversation} className="block w-full text-left text-ink-100">
            New conversation
          </button>
          <a href={`/api/conversations/${props.conversationId}/export?format=txt`} className="block text-ink-100">
            Export conversation
          </a>
          <button onClick={deleteConversation} className="block w-full text-left text-rose-glow">
            Delete conversation
          </button>
        </div>
      )}

      {/* Messages */}
      <main className="flex-1 space-y-2 overflow-y-auto px-3 py-4" onClick={() => menu && setMenu(false)}>
        {messages.map((m) => (
          <MessageRow
            key={m.id}
            msg={m}
            selected={selected === m.id}
            onSelect={() => setSelected(selected === m.id ? null : m.id)}
            onOpenImage={setViewer}
            actions={
              selected === m.id && !busy ? (
                <div className={`mt-1 flex gap-3 text-[11px] text-ink-400 ${m.role === "user" ? "justify-end" : ""}`}>
                  {m.role === "user" && !m.id.startsWith("tmp-") && <button onClick={() => setEditing({ id: m.id, text: m.content })}>Edit</button>}
                  {m.id === lastCharacterId && lastIsCharacter && <button onClick={() => (setSelected(null), runTurn({ kind: "regenerate" }))}>Regenerate</button>}
                  <button onClick={() => navigator.clipboard?.writeText(m.content.replace(/\n\|\|\n/g, "\n"))}>Copy</button>
                  {!m.id.startsWith("tmp-") && (
                    <button className="text-rose-glow" onClick={() => deleteMessage(m.id)}>
                      Delete
                    </button>
                  )}
                </div>
              ) : null
            }
          />
        ))}
        {streaming !== null &&
          (streaming === "" ? (
            <div className="fade-in bubble-char inline-flex rounded-2xl rounded-bl-md px-4 py-3">
              <span className="typing" aria-label="typing">
                <span />
                <span />
                <span />
              </span>
            </div>
          ) : (
            <MessageRow msg={{ id: "streaming", role: "character", content: hidePhotoTags(streaming), createdAt: "" }} selected={false} onSelect={() => undefined} />
          ))}
        {notices.length > 0 && (
          <div className="mx-auto max-w-[90%] space-y-1 py-1 text-center text-[11px] text-ink-400">
            {notices.map((n) => (
              <p key={n}>{n}</p>
            ))}
          </div>
        )}
        {lastIsCharacter && !busy && messages.length > 1 && (
          <div className="flex justify-start pl-1">
            <button onClick={() => runTurn({ kind: "regenerate" })} className="text-[11px] text-ink-400 hover:text-amber-glow">
              ↻ regenerate
            </button>
          </div>
        )}
        <div ref={bottom} />
      </main>

      {toast && <div className="fade-in pointer-events-none absolute inset-x-0 bottom-24 mx-auto w-fit rounded-full bg-ink-800 px-4 py-2 text-xs text-amber-glow shadow-lg">{toast}</div>}

      {/* Composer */}
      {editing ? (
        <div className="border-t border-ink-800 bg-ink-950 p-3">
          <p className="mb-1.5 text-[11px] text-ink-400">Editing — the conversation will continue from here.</p>
          <textarea value={editing.text} onChange={(e) => setEditing({ ...editing, text: e.target.value })} className="min-h-20 w-full rounded-xl border border-ink-700 bg-ink-900 p-3 text-sm focus:outline-none" />
          <div className="mt-2 flex justify-end gap-2">
            <button onClick={() => setEditing(null)} className="px-3 py-1.5 text-sm text-ink-300">
              Cancel
            </button>
            <button onClick={saveEdit} className="rounded-full bg-amber-glow px-4 py-1.5 text-sm font-medium text-ink-950">
              Save & resend
            </button>
          </div>
        </div>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
          className="flex items-end gap-2 border-t border-ink-800 bg-ink-950 px-3 pb-[calc(0.6rem+env(safe-area-inset-bottom))] pt-2.5"
        >
          <button type="button" onClick={askForPhoto} disabled={busy} className="mb-1 h-9 w-9 shrink-0 rounded-full border border-ink-700 text-ink-300 disabled:opacity-30" title="Ask for a photo" aria-label="Ask for a photo">
            📷
          </button>
          {style !== "CHAT" && (
            <button type="button" onClick={() => setInput((v) => `${v}${v && !v.endsWith(" ") ? " " : ""}**`)} className="mb-1 h-9 w-9 shrink-0 rounded-full border border-ink-700 text-ink-300" title="Action (*…*)">
              *
            </button>
          )}
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !("ontouchstart" in window)) {
                e.preventDefault();
                send();
              }
            }}
            rows={1}
            placeholder={`Message ${props.character.name}`}
            className="max-h-36 min-h-[42px] flex-1 resize-none rounded-2xl border border-ink-700 bg-ink-900 px-4 py-2.5 text-sm placeholder:text-ink-400 focus:border-amber-glow/50 focus:outline-none"
          />
          {busy && streaming !== null ? (
            <button type="button" onClick={() => abort.current?.abort()} className="mb-0.5 h-10 w-10 shrink-0 rounded-full border border-ink-600 text-ink-300" aria-label="Stop">
              ■
            </button>
          ) : (
            <button type="submit" disabled={!input.trim() || busy} className="mb-0.5 h-10 w-10 shrink-0 rounded-full bg-gradient-to-br from-amber-glow to-rose-glow text-ink-950 disabled:opacity-30" aria-label="Send">
              ↑
            </button>
          )}
        </form>
      )}

      {viewer?.id && (
        <div className="fade-in fixed inset-0 z-50 flex flex-col bg-ink-950/95 backdrop-blur" onClick={() => setViewer(null)} role="dialog" aria-label="Photo">
          <div className="flex items-center justify-between px-4 py-3 text-sm">
            <span className="text-ink-300">{props.character.name}</span>
            <div className="flex gap-4">
              <a href={`/api/images/${viewer.id}`} download onClick={(e) => e.stopPropagation()} className="text-amber-glow">
                Save
              </a>
              <button onClick={() => setViewer(null)} className="text-ink-300">
                Close
              </button>
            </div>
          </div>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`/api/images/${viewer.id}`} alt={viewer.caption} className="min-h-0 flex-1 object-contain px-3" />
          <p className="px-6 py-4 text-center text-sm italic text-ink-300">{viewer.caption}</p>
        </div>
      )}

      {drawer && <MemoryDrawer characterId={props.character.id} characterName={props.character.name} onClose={() => setDrawer(false)} onReset={(s) => s && setStage(s)} />}
    </div>
  );
}

function MessageRow({ msg, selected, onSelect, actions, onOpenImage }: { msg: Msg; selected: boolean; onSelect: () => void; actions?: React.ReactNode; onOpenImage?: (img: MsgImage) => void }) {
  const isUser = msg.role === "user";
  const bubbles = msg.content.split(/\n\s*\|\|\s*\n|\s+\|\|\s+/).filter((b) => b.trim());
  const isRefusal = msg.meta?.kind === "refusal";
  return (
    <div className={`fade-in flex flex-col ${isUser ? "items-end" : "items-start"}`}>
      {bubbles.map((b, i) => (
        <div
          key={i}
          onClick={onSelect}
          className={`mb-1 max-w-[85%] cursor-pointer whitespace-pre-wrap break-words px-3.5 py-2 text-[15px] leading-relaxed ${
            isUser ? "bubble-user rounded-2xl rounded-br-md text-white" : `bubble-char rounded-2xl rounded-bl-md ${isRefusal ? "opacity-80" : ""}`
          } ${selected ? "ring-1 ring-amber-glow/50" : ""}`}
        >
          <Rich text={b.trim()} user={isUser} />
        </div>
      ))}
      {msg.meta?.images?.map((img, i) => <PhotoBubble key={img.id ?? i} img={img} onOpen={() => onOpenImage?.(img)} />)}
      {actions}
    </div>
  );
}

/** A photo the character sent: developing → ready (tap to open) → or failed. */
function PhotoBubble({ img, onOpen }: { img: MsgImage; onOpen: () => void }) {
  if (img.status === "failed")
    return <p className="mb-1 max-w-[85%] rounded-2xl border border-dashed border-ink-700 px-3.5 py-2 text-xs italic text-ink-400">📷 Photo didn&apos;t come through: {img.error ?? "try again"}</p>;
  if (img.status === "pending" || !img.id)
    return (
      <div className="photo-pending mb-1 flex aspect-[4/5] w-56 max-w-[70%] items-end rounded-2xl rounded-bl-md p-3" aria-label="Photo developing">
        <span className="text-[11px] text-ink-300">📷 developing…</span>
      </div>
    );
  return (
    <button onClick={onOpen} className="fade-in mb-1 w-56 max-w-[70%] overflow-hidden rounded-2xl rounded-bl-md ring-1 ring-ink-700" aria-label={`Open photo: ${img.caption}`}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={`/api/images/${img.id}`} alt={img.caption} className="block aspect-[4/5] w-full object-cover" loading="lazy" />
    </button>
  );
}

/** *actions* render as soft italics; everything else is dialogue. */
function Rich({ text, user }: { text: string; user: boolean }) {
  const parts = text.split(/(\*[^*\n]+\*)/g);
  return (
    <>
      {parts.map((p, i) =>
        /^\*[^*]+\*$/.test(p) ? (
          <em key={i} className={user ? "text-white/75" : "text-ink-300"}>
            {p.slice(1, -1)}
          </em>
        ) : (
          <Fragment key={i}>{p}</Fragment>
        ),
      )}
    </>
  );
}
