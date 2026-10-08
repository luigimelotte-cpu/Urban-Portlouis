import { z } from "zod";
import { body, json, requireVerifiedUser, route } from "@/server/http";
import { generatePortrait } from "@/server/images";

const Schema = z.object({
  age: z.number().int().min(18).max(1000),
  gender: z.string().trim().min(1).max(40),
  appearance: z.string().trim().min(10, "Describe their appearance first (10+ characters).").max(1200),
  occupation: z.string().trim().max(120).optional(),
  style: z.enum(["photoreal", "cinematic", "illustration"]).default("photoreal"),
  characterId: z.string().nullable().optional(),
});

export const POST = route(async (req) => {
  const uid = await requireVerifiedUser();
  const input = Schema.parse(await body(req));
  return json(await generatePortrait(uid, input), 201);
});
