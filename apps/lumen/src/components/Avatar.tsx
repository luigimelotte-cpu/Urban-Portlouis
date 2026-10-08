/* eslint-disable @next/next/no-img-element */

const GRADIENTS = [
  "from-rose-glow to-amber-glow",
  "from-amber-glow to-rose-deep",
  "from-rose-deep to-ink-600",
  "from-amber-deep to-rose-glow",
];

export function Avatar({ name, src, size = 48, className = "" }: { name: string; src?: string | null; size?: number; className?: string }) {
  const style = { width: size, height: size };
  if (src) return <img src={src} alt={name} style={style} className={`shrink-0 rounded-full object-cover ${className}`} />;
  const g = GRADIENTS[[...name].reduce((a, c) => a + c.charCodeAt(0), 0) % GRADIENTS.length];
  return (
    <div style={style} className={`flex shrink-0 items-center justify-center rounded-full bg-gradient-to-br ${g} ${className}`} aria-label={name}>
      <span className="font-display font-semibold text-ink-950" style={{ fontSize: size * 0.42 }}>
        {name.charAt(0).toUpperCase()}
      </span>
    </div>
  );
}

/** Large portrait for cards and the character page. */
export function Portrait({ name, src, className = "" }: { name: string; src?: string | null; className?: string }) {
  if (src) return <img src={src} alt={name} className={`h-full w-full object-cover ${className}`} />;
  const g = GRADIENTS[[...name].reduce((a, c) => a + c.charCodeAt(0), 0) % GRADIENTS.length];
  return (
    <div className={`flex h-full w-full items-center justify-center bg-gradient-to-br ${g} ${className}`}>
      <span className="font-display text-7xl font-semibold text-ink-950/80">{name.charAt(0).toUpperCase()}</span>
    </div>
  );
}
