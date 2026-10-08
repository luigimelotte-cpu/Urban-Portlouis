import { prisma } from "@/server/db";
import { body, json, requireAdmin, route } from "@/server/http";
import { invalidateProviderCache } from "@/server/providers";
import { ProviderSchema } from "@/server/admin-schema";

type Ctx = { params: Promise<{ id: string }> };

export const PATCH = route<Ctx>(async (req, { params }) => {
  await requireAdmin();
  const { id } = await params;
  const input = ProviderSchema.partial().parse(await body(req));
  const row = await prisma.providerConfig.update({
    where: { id },
    data: { ...input, options: input.options as object | undefined },
  });
  invalidateProviderCache();
  return json({ provider: row });
});

export const DELETE = route<Ctx>(async (_req, { params }) => {
  await requireAdmin();
  const { id } = await params;
  await prisma.providerConfig.delete({ where: { id } });
  invalidateProviderCache();
  return json({ ok: true });
});
