import { requireUser, route } from "@/server/http";
import { exportAllUserData } from "@/server/services";

export const GET = route(async () => {
  const id = await requireUser();
  const data = await exportAllUserData(id);
  return new Response(JSON.stringify(data, null, 2), {
    headers: { "Content-Type": "application/json", "Content-Disposition": `attachment; filename="lumen-export.json"` },
  });
});
