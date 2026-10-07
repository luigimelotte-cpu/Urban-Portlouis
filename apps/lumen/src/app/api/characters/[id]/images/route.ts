import { prisma } from "@/server/db";
import { json, requireVerifiedUser, route } from "@/server/http";
import { imageUrl } from "@/server/images";

type Ctx = { params: Promise<{ id: string }> };

/** Photos this character has sent you (private to you). */
export const GET = route<Ctx>(async (_req, { params }) => {
  const { id } = await params;
  const uid = await requireVerifiedUser();
  const rows = await prisma.image.findMany({
    where: { userId: uid, characterId: id, kind: { in: ["SELFIE", "SCENE"] } },
    orderBy: { createdAt: "desc" },
    take: 60,
    select: { id: true, kind: true, caption: true, createdAt: true },
  });
  return json({ images: rows.map((r) => ({ ...r, url: imageUrl(r.id) })) });
});
