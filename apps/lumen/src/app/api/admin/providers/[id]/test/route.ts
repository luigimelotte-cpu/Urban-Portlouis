import { createProvider } from "@/core/providers/registry";
import { createImageProvider, isImageAdapter } from "@/core/images/registry";
import { prisma } from "@/server/db";
import { json, requireAdmin, route } from "@/server/http";
import { toDescriptor } from "@/server/providers";
import { HttpError } from "@/server/services";

type Ctx = { params: Promise<{ id: string }> };

/** Sends a tiny SAFE prompt to verify credentials and connectivity. */
export const POST = route<Ctx>(async (_req, { params }) => {
  await requireAdmin();
  const { id } = await params;
  const row = await prisma.providerConfig.findUnique({ where: { id } });
  if (!row) throw new HttpError(404, "Provider not found");
  if (isImageAdapter(row.adapter)) {
    const img = createImageProvider(toDescriptor(row));
    if (!img.isAvailable()) return json({ ok: false, error: `Missing API key (env var ${row.apiKeyEnv ?? "?"})` });
    const t0 = Date.now();
    try {
      const out = await img.generate({ prompt: "A ceramic coffee cup on a sunlit wooden café table, photograph", aspect: "square" });
      return json({ ok: true, ms: Date.now() - t0, model: out.model, finishReason: "image", sample: `${out.mimeType}, ${Math.round(out.bytes.length / 1024)} KB` });
    } catch (e) {
      return json({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  const provider = createProvider(toDescriptor(row));
  if (!provider.isAvailable()) return json({ ok: false, error: `Missing API key (env var ${row.apiKeyEnv ?? "?"})` });
  const started = Date.now();
  try {
    const res = await provider.generateResponse({
      system: "You are a friendly barista. Reply in one short sentence.",
      messages: [{ role: "user", content: "Hi! What's good today?" }],
      maxOutputTokens: 60,
    });
    return json({ ok: true, ms: Date.now() - started, model: res.model, finishReason: res.finishReason, sample: res.text.slice(0, 200) });
  } catch (e) {
    return json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});
