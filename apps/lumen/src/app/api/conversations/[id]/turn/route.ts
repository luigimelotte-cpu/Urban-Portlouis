import { z } from "zod";
import type { TurnRequest } from "@/core/pipeline/chat-pipeline";
import { body, json, requireVerifiedUser, route } from "@/server/http";
import { getPipeline } from "@/server/services";

type Ctx = { params: Promise<{ id: string }> };

const Schema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("send"), text: z.string().min(1).max(8000) }),
  z.object({ kind: z.literal("regenerate") }),
  z.object({ kind: z.literal("edit"), messageId: z.string(), text: z.string().min(1).max(8000) }),
  z.object({ kind: z.literal("nudge") }),
]);

export const dynamic = "force-dynamic";

/**
 * Runs one conversation turn and streams PipelineEvents as Server-Sent Events:
 *   meta → delta* → message → state     (or a single error)
 */
export const POST = route<Ctx>(async (req, { params }) => {
  const { id } = await params;
  const userId = await requireVerifiedUser();
  const input = Schema.parse(await body(req));
  const pipeline = getPipeline();

  if (input.kind === "nudge" && !(await pipeline.shouldNudge(id))) {
    return json({ skipped: true });
  }

  const turn = { ...input, userId, conversationId: id } as TurnRequest;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: unknown) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          /* client went away */
        }
      };
      try {
        for await (const event of pipeline.run(turn, req.signal)) send(event);
      } catch (e) {
        console.error(e);
        send({ type: "error", code: "provider_error", message: "Something went wrong generating the reply." });
      } finally {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" },
  });
});
