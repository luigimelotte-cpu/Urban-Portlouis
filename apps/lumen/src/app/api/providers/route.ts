import { highestSupportedMode } from "@/core/content/policy";
import { json, route } from "@/server/http";
import { dbPlatformSettings, dbProviderSource } from "@/server/providers";

/** Providers a user may pick as preferred (no secrets, no config details). */
export const GET = route(async () => {
  const providers = await dbProviderSource.list();
  return json({
    ceiling: await dbPlatformSettings.contentCeiling(),
    providers: providers
      .filter((p) => p.descriptor.enabled && p.descriptor.roles.includes("chat") && p.isAvailable())
      .map((p) => ({ id: p.descriptor.id, label: p.descriptor.label, maxMode: highestSupportedMode(p.getCapabilities()) })),
  });
});
