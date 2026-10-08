import { body, json, requireVerifiedUser, route } from "@/server/http";
import { HttpError, deleteCharacter, getVisibleCharacter, updateCharacter } from "@/server/services";
import { currentUserId } from "@/server/session";

type Ctx = { params: Promise<{ id: string }> };

export const GET = route<Ctx>(async (_req, { params }) => {
  const { id } = await params;
  const c = await getVisibleCharacter(id, await currentUserId());
  if (!c) throw new HttpError(404, "Character not found");
  return json({ character: c });
});

export const PUT = route<Ctx>(async (req, { params }) => {
  const { id } = await params;
  const uid = await requireVerifiedUser();
  return json({ character: await updateCharacter(uid, id, await body(req)) });
});

export const DELETE = route<Ctx>(async (_req, { params }) => {
  const { id } = await params;
  const uid = await requireVerifiedUser();
  await deleteCharacter(uid, id);
  return json({ ok: true });
});
