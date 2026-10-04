import { z } from "zod";
import { CONTENT_MODES, CONVERSATION_STYLES } from "@/core/types";
import { prisma } from "@/server/db";
import { body, json, requireVerifiedUser, route } from "@/server/http";
import { createConversation } from "@/server/services";

export const GET = route(async () => {
  const uid = await requireVerifiedUser();
  const convs = await prisma.conversation.findMany({
    where: { userId: uid },
    orderBy: { updatedAt: "desc" },
    take: 50,
    include: {
      character: { select: { id: true, name: true, avatarUrl: true } },
      messages: { orderBy: { createdAt: "desc" }, take: 1, select: { content: true, role: true, createdAt: true } },
    },
  });
  return json({
    conversations: convs.map((c) => ({
      id: c.id,
      character: c.character,
      style: c.style,
      contentMode: c.contentMode,
      updatedAt: c.updatedAt,
      lastMessage: c.messages[0] ?? null,
    })),
  });
});

const Create = z.object({
  characterId: z.string(),
  style: z.enum(CONVERSATION_STYLES).optional(),
  contentMode: z.enum(CONTENT_MODES).optional(),
});

export const POST = route(async (req) => {
  const uid = await requireVerifiedUser();
  const input = Create.parse(await body(req));
  const conv = await createConversation(uid, input.characterId, input);
  return json({ id: conv.id }, 201);
});
