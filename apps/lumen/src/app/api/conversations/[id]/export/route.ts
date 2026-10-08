import { requireVerifiedUser, route } from "@/server/http";
import { exportConversation } from "@/server/services";

type Ctx = { params: Promise<{ id: string }> };

export const GET = route<Ctx>(async (req, { params }) => {
  const { id } = await params;
  const uid = await requireVerifiedUser();
  const data = await exportConversation(id, uid);
  const format = new URL(req.url).searchParams.get("format");
  if (format === "txt") {
    const text = data.messages
      .map((m) => `[${new Date(m.createdAt).toISOString()}] ${m.role === "user" ? "You" : data.conversation.character}: ${m.content.replace(/\n\|\|\n/g, "\n")}`)
      .join("\n\n");
    return new Response(text, { headers: { "Content-Type": "text/plain; charset=utf-8", "Content-Disposition": `attachment; filename="conversation-${id}.txt"` } });
  }
  return new Response(JSON.stringify(data, null, 2), {
    headers: { "Content-Type": "application/json", "Content-Disposition": `attachment; filename="conversation-${id}.json"` },
  });
});
