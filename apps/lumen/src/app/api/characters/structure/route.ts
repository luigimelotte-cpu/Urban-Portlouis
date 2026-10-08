import { z } from "zod";
import { structureCharacter } from "@/core/character/structure";
import { routeProvider } from "@/core/providers/router";
import { body, json, requireVerifiedUser, route } from "@/server/http";
import { dbProviderSource } from "@/server/providers";

const Schema = z.object({ description: z.string().trim().min(10).max(6000) });

export const POST = route(async (req) => {
  await requireVerifiedUser();
  const { description } = Schema.parse(await body(req));
  let utility = null;
  try {
    // Describing a character is SAFE-level work; any utility provider will do.
    utility = routeProvider({ mode: "SAFE", role: "utility", providers: await dbProviderSource.list(), fallback: "refuse" }).candidates[0];
  } catch {
    utility = null;
  }
  const draft = await structureCharacter(description, utility);
  return json(draft);
});
