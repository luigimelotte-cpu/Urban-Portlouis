import { z } from "zod";
import { CONTENT_MODES, CONVERSATION_STYLES } from "@/core/types";
import { prisma } from "@/server/db";
import { body, json, requireVerifiedUser, route } from "@/server/http";
import { HttpError, getConversationForUser } from "@/server/services";

type Ctx = { params: Promise<{ id: string }> };

export const GET = route<Ctx>(async (_req, { params }) => {
  const { id } = await params;
  const uid = await requireVerifiedUser();
  const data = await getConversationForUser(id, uid);
  if (!data) throw new HttpError(404, "Conversation not found");
  return json(data);
});

const Patch = z.object({ style: z.enum(CONVERSATION_STYLES).optional(), contentMode: z.enum(CONTENT_MODES).optional() });

export const PATCH = route<Ctx>(async (req, { params }) => {
  const { id } = await params;
  const uid = await requireVerifiedUser();
  const input = Patch.parse(await body(req));
  const res = await prisma.conversation.updateMany({ where: { id, userId: uid }, data: input });
  if (!res.count) throw new HttpError(404, "Conversation not found");
  return json({ ok: true });
});

export const DELETE = route<Ctx>(async (_req, { params }) => {
  const { id } = await params;
  const uid = await requireVerifiedUser();
  // Memories formed in this conversation are kept unless the user also resets memory.
  const res = await prisma.conversation.deleteMany({ where: { id, userId: uid } });
  if (!res.count) throw new HttpError(404, "Conversation not found");
  return json({ ok: true });
});
