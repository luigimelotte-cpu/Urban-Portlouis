import { highestSupportedMode } from "@/core/content/policy";
import { adapterOptions, createProvider } from "@/core/providers/registry";
import { prisma } from "@/server/db";
import { body, json, requireAdmin, route } from "@/server/http";
import { ProviderSchema } from "@/server/admin-schema";
import { ensureDefaultProviders, invalidateProviderCache, toDescriptor } from "@/server/providers";


export const GET = route(async () => {
  await requireAdmin();
  await ensureDefaultProviders();
  const rows = await prisma.providerConfig.findMany({ orderBy: { priority: "asc" } });
  return json({
    adapters: adapterOptions(),
    providers: rows.map((r) => {
      let available = false;
      try {
        available = createProvider(toDescriptor(r)).isAvailable();
      } catch {
        available = false;
      }
      return { ...r, available, maxMode: highestSupportedMode(toDescriptor(r).capabilities) };
    }),
  });
});

export const POST = route(async (req) => {
  await requireAdmin();
  const input = ProviderSchema.parse(await body(req));
  const row = await prisma.providerConfig.create({ data: { ...input, options: input.options as object } });
  invalidateProviderCache();
  return json({ provider: row }, 201);
});
