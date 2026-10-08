import { z } from "zod";
import { prisma } from "@/server/db";
import { body, json, requireUser, requireVerifiedUser, route } from "@/server/http";
import { deleteAllUserData } from "@/server/services";
import { clearSession } from "@/server/session";
import { readSettings } from "@/server/store";
import { CONTENT_MODES, CONVERSATION_STYLES } from "@/core/types";

export const GET = route(async () => {
  const id = await requireUser();
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return json({ id: u.id, displayName: u.displayName, ageVerified: !!u.ageVerifiedAt, adultOptIn: u.adultOptIn, settings: readSettings(u.settings) });
});

const Patch = z.object({
  displayName: z.string().trim().max(40).nullable().optional(),
  adultOptIn: z.boolean().optional(),
  settings: z
    .object({
      preferredProviderId: z.string().nullable().optional(),
      defaultStyle: z.enum(CONVERSATION_STYLES).optional(),
      memoryEnabled: z.boolean().optional(),
      imagesEnabled: z.boolean().optional(),
      requestedContentMode: z.enum(CONTENT_MODES).optional(),
    })
    .optional(),
});

export const PATCH = route(async (req) => {
  const id = await requireVerifiedUser();
  const input = Patch.parse(await body(req));
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  const settings = { ...readSettings(u.settings), ...(input.settings ?? {}) };
  // ADULT can only be requested after explicit opt-in.
  const adultOptIn = input.adultOptIn ?? u.adultOptIn;
  if (settings.requestedContentMode === "ADULT" && !adultOptIn) settings.requestedContentMode = "MATURE";
  const updated = await prisma.user.update({
    where: { id },
    data: { displayName: input.displayName === undefined ? undefined : input.displayName, adultOptIn, settings },
  });
  return json({ ok: true, adultOptIn: updated.adultOptIn, settings });
});

/** Right to erasure: deletes the user and all private data. */
export const DELETE = route(async () => {
  const id = await requireUser();
  await deleteAllUserData(id);
  await clearSession();
  return json({ ok: true });
});
