import { prisma } from "@/server/db";
import { json, requireVerifiedUser, route } from "@/server/http";

type Ctx = { params: Promise<{ id: string }> };

export const DELETE = route<Ctx>(async (_req, { params }) => {
  const { id } = await params;
  const uid = await requireVerifiedUser();
  await prisma.memory.deleteMany({ where: { id, userId: uid } });
  return json({ ok: true });
});
