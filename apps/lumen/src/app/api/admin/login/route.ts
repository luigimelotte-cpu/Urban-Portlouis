import { z } from "zod";
import { body, json, route } from "@/server/http";
import { HttpError } from "@/server/services";
import { loginAdmin } from "@/server/session";

export const POST = route(async (req) => {
  const { token } = z.object({ token: z.string().min(1) }).parse(await body(req));
  if (!(await loginAdmin(token))) throw new HttpError(401, "Invalid admin token");
  return json({ ok: true });
});
