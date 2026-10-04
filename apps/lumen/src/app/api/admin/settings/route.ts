import { z } from "zod";
import { CONTENT_MODES } from "@/core/types";
import { body, json, requireAdmin, route } from "@/server/http";
import { envCeiling, getSetting, setSetting } from "@/server/providers";

export const GET = route(async () => {
  await requireAdmin();
  return json({
    envCeiling: envCeiling(),
    contentCeiling: await getSetting("contentCeiling", "ADULT"),
    routingFallback: await getSetting("routingFallback", "downgrade"),
  });
});

const Schema = z.object({
  contentCeiling: z.enum(CONTENT_MODES).optional(),
  routingFallback: z.enum(["downgrade", "refuse"]).optional(),
});

export const PUT = route(async (req) => {
  await requireAdmin();
  const input = Schema.parse(await body(req));
  if (input.contentCeiling) await setSetting("contentCeiling", input.contentCeiling);
  if (input.routingFallback) await setSetting("routingFallback", input.routingFallback);
  return json({ ok: true });
});
