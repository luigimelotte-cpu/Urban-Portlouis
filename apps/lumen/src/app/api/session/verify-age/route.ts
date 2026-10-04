import { z } from "zod";
import { prisma } from "@/server/db";
import { ageFromDob } from "@/server/age";
import { body, json, requireUser, route } from "@/server/http";
import { HttpError } from "@/server/services";

const Schema = z.object({
  dob: z.string(),
  confirm: z.literal(true),
  displayName: z.string().trim().max(40).optional(),
});

// Self-declared age gate. Production deployments in many jurisdictions need a
// real age-assurance provider here; the rest of the app only reads ageVerifiedAt.
export const POST = route(async (req) => {
  const userId = await requireUser();
  const input = Schema.parse(await body(req));
  const age = ageFromDob(input.dob);
  if (age === null) throw new HttpError(400, "Invalid date of birth");
  if (age < 18) throw new HttpError(403, "You must be 18 or older to use Lumen.");
  await prisma.user.update({
    where: { id: userId },
    data: { ageVerifiedAt: new Date(), birthYear: Number(input.dob.slice(0, 4)), displayName: input.displayName || undefined },
  });
  return json({ ok: true });
});
