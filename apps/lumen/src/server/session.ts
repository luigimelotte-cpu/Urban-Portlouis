import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { prisma } from "./db";

// Minimal signed-cookie session. Every visitor gets an anonymous user row;
// proper auth (email/OAuth) can replace this without touching the core.

const COOKIE = "lumen_uid";
const ADMIN_COOKIE = "lumen_admin";

function secret(): string {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 16) {
    if (process.env.NODE_ENV === "production") throw new Error("SESSION_SECRET must be set (16+ chars)");
    return "dev-only-insecure-session-secret";
  }
  return s;
}

const sign = (v: string) => createHmac("sha256", secret()).update(v).digest("base64url");

export function encode(value: string): string {
  return `${value}.${sign(value)}`;
}

export function decode(token: string | undefined): string | null {
  if (!token) return null;
  const i = token.lastIndexOf(".");
  if (i <= 0) return null;
  const value = token.slice(0, i);
  const a = Buffer.from(token.slice(i + 1));
  const b = Buffer.from(sign(value));
  return a.length === b.length && timingSafeEqual(a, b) ? value : null;
}

/** Current user id, or null if no valid session cookie. */
export async function currentUserId(): Promise<string | null> {
  const jar = await cookies();
  return decode(jar.get(COOKIE)?.value);
}

/** Current user id, creating an anonymous user + cookie if needed (route handlers / actions only). */
export async function ensureUserId(): Promise<string> {
  const existing = await currentUserId();
  if (existing) {
    const u = await prisma.user.findUnique({ where: { id: existing }, select: { id: true } });
    if (u) return u.id;
  }
  const user = await prisma.user.create({ data: {} });
  const jar = await cookies();
  jar.set(COOKIE, encode(user.id), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
  return user.id;
}

export async function clearSession() {
  const jar = await cookies();
  jar.delete(COOKIE);
}

export async function isAdmin(): Promise<boolean> {
  const token = process.env.ADMIN_TOKEN;
  if (!token) return process.env.NODE_ENV !== "production";
  const jar = await cookies();
  return decode(jar.get(ADMIN_COOKIE)?.value) === "admin";
}

export async function loginAdmin(token: string): Promise<boolean> {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) return process.env.NODE_ENV !== "production";
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  const jar = await cookies();
  jar.set(ADMIN_COOKIE, encode("admin"), { httpOnly: true, sameSite: "strict", path: "/", maxAge: 60 * 60 * 8, secure: process.env.NODE_ENV === "production" });
  return true;
}
