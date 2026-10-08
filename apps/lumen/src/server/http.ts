import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { prisma } from "./db";
import { HttpError } from "./services";
import { currentUserId, ensureUserId, isAdmin } from "./session";

export const json = (data: unknown, status = 200) => NextResponse.json(data, { status });

type Handler<C> = (req: Request, ctx: C) => Promise<Response>;

/** Wrap a route handler: HttpError/ZodError → JSON error responses. */
export function route<C>(fn: Handler<C>): Handler<C> {
  return async (req, ctx) => {
    try {
      return await fn(req, ctx);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message, details: e.details }, e.status);
      if (e instanceof ZodError) return json({ error: "Invalid request", details: e.issues }, 400);
      console.error(e);
      return json({ error: "Internal error" }, 500);
    }
  };
}

export async function requireUser(): Promise<string> {
  return ensureUserId();
}

/** User must exist and have passed the 18+ gate. */
export async function requireVerifiedUser(): Promise<string> {
  const id = await currentUserId();
  if (!id) throw new HttpError(401, "No session");
  const u = await prisma.user.findUnique({ where: { id }, select: { ageVerifiedAt: true } });
  if (!u) throw new HttpError(401, "No session");
  if (!u.ageVerifiedAt) throw new HttpError(403, "Age verification required");
  return id;
}

export async function requireAdmin() {
  if (!(await isAdmin())) throw new HttpError(401, "Admin login required");
}

export async function body<T = Record<string, unknown>>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
}
