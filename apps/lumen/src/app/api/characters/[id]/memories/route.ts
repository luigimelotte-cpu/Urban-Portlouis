import { prismaMemoryStore } from "@/server/store";
import { json, requireVerifiedUser, route } from "@/server/http";
import { resetCharacterMemory } from "@/server/services";

type Ctx = { params: Promise<{ id: string }> };

/** The user's private memories with this character (never another user's). */
export const GET = route<Ctx>(async (_req, { params }) => {
  const { id } = await params;
  const uid = await requireVerifiedUser();
  const memories = await prismaMemoryStore.list(uid, id);
  return json({ memories: memories.map(({ embedding, ...m }) => m) });
});

export const DELETE = route<Ctx>(async (_req, { params }) => {
  const { id } = await params;
  const uid = await requireVerifiedUser();
  await resetCharacterMemory(uid, id);
  return json({ ok: true });
});
