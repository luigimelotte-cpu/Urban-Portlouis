import { z } from "zod";
import { body, json, requireVerifiedUser, route } from "@/server/http";
import { resetCharacterMemory, resetRelationship } from "@/server/services";

type Ctx = { params: Promise<{ id: string }> };
const Schema = z.object({ what: z.enum(["relationship", "memory", "all"]) });

export const POST = route<Ctx>(async (req, { params }) => {
  const { id } = await params;
  const uid = await requireVerifiedUser();
  const { what } = Schema.parse(await body(req));
  if (what === "relationship" || what === "all") await resetRelationship(uid, id);
  if (what === "memory" || what === "all") await resetCharacterMemory(uid, id);
  return json({ ok: true });
});
