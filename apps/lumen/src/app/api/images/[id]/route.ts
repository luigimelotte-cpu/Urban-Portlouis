import { prisma } from "@/server/db";
import { json, requireVerifiedUser, route } from "@/server/http";
import { canView } from "@/server/images";
import { currentUserId } from "@/server/session";

type Ctx = { params: Promise<{ id: string }> };

export const GET = route<Ctx>(async (_req, { params }) => {
  const { id } = await params;
  const img = await canView(id, await currentUserId());
  if (!img) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(img.data), {
    headers: {
      "Content-Type": img.mimeType,
      "Cache-Control": "private, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
      // SVGs (mock images) can carry script; never let one run.
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    },
  });
});

/** Delete one of your own images (it disappears from the chat and the gallery). */
export const DELETE = route<Ctx>(async (_req, { params }) => {
  const { id } = await params;
  const uid = await requireVerifiedUser();
  await prisma.image.deleteMany({ where: { id, userId: uid } });
  return json({ ok: true });
});
