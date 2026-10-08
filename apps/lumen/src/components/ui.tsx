import type { ButtonHTMLAttributes, InputHTMLAttributes, TextareaHTMLAttributes } from "react";

export function Button({ variant = "primary", className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost" | "danger" }) {
  const v = {
    primary: "bg-gradient-to-r from-amber-glow to-rose-glow text-ink-950 font-semibold hover:brightness-110",
    ghost: "border border-ink-700 text-ink-100 hover:bg-ink-800",
    danger: "border border-rose-deep/60 text-rose-glow hover:bg-rose-deep/15",
  }[variant];
  return <button {...props} className={`rounded-full px-4 py-2.5 text-sm transition disabled:opacity-40 ${v} ${className}`} />;
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-xs font-medium uppercase tracking-wider text-ink-300">{label}</span>
      {children}
      {hint && <span className="block text-xs text-ink-400">{hint}</span>}
    </label>
  );
}

const inputCls = "w-full rounded-xl border border-ink-700 bg-ink-900 px-3.5 py-2.5 text-sm text-ink-100 placeholder:text-ink-400 focus:border-amber-glow/60 focus:outline-none";

export const Input = (p: InputHTMLAttributes<HTMLInputElement>) => <input {...p} className={`${inputCls} ${p.className ?? ""}`} />;
export const Textarea = (p: TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...p} className={`${inputCls} min-h-24 ${p.className ?? ""}`} />;

export function Select({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className={inputCls}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Segmented<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { value: T; label: string; disabled?: boolean }[] }) {
  return (
    <div className="flex rounded-full border border-ink-700 bg-ink-900 p-1">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          disabled={o.disabled}
          onClick={() => onChange(o.value)}
          className={`flex-1 rounded-full px-3 py-1.5 text-xs font-medium transition disabled:opacity-30 ${value === o.value ? "bg-ink-700 text-amber-glow" : "text-ink-300"}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Tag({ children }: { children: React.ReactNode }) {
  return <span className="rounded-full border border-ink-700 bg-ink-900/70 px-2.5 py-0.5 text-[11px] text-ink-300">{children}</span>;
}
