import { prisma } from "@/server/db";
import { json, requireVerifiedUser, route } from "@/server/http";
import { HttpError } from "@/server/services";

type Ctx = { params: Promise<{ id: string; messageId: string }> };

/** Delete a single message (yours or the character's) from your conversation. */
export const DELETE = route<Ctx>(async (_req, { params }) => {
  const { id, messageId } = await params;
  const uid = await requireVerifiedUser();
  const conv = await prisma.conversation.findFirst({ where: { id, userId: uid }, select: { id: true } });
  if (!conv) throw new HttpError(404, "Conversation not found");
  await prisma.message.deleteMany({ where: { id: messageId, conversationId: id } });
  return json({ ok: true });
});
