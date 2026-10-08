"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const ITEMS = [
  { href: "/", label: "Discover", icon: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm3.5 5.5-2 5-5 2 2-5 5-2Z" },
  { href: "/chats", label: "Chats", icon: "M4 5h16v10H8l-4 4V5Z" },
  { href: "/create", label: "Create", icon: "M12 5v14M5 12h14" },
  { href: "/settings", label: "Settings", icon: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm8 4-2 .7-.6 1.5 1 1.9-1.4 1.4-1.9-1-1.5.6L13 20h-2l-.7-2-1.5-.6-1.9 1-1.4-1.4 1-1.9-.6-1.5L4 13v-2l2-.7.6-1.5-1-1.9 1.4-1.4 1.9 1 1.5-.6L11 4h2l.7 2 1.5.6 1.9-1 1.4 1.4-1 1.9.6 1.5 2 .7v2Z" },
];

export function BottomNav() {
  const path = usePathname();
  return (
    <nav className="sticky bottom-0 z-20 mt-auto border-t border-ink-800 bg-ink-950/90 pb-[env(safe-area-inset-bottom)] backdrop-blur">
      <ul className="grid grid-cols-4">
        {ITEMS.map((it) => {
          const active = it.href === "/" ? path === "/" : path.startsWith(it.href);
          return (
            <li key={it.href}>
              <Link href={it.href} className={`flex flex-col items-center gap-1 py-2.5 text-[11px] ${active ? "text-amber-glow" : "text-ink-400"}`}>
                <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
                  <path d={it.icon} />
                </svg>
                {it.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
