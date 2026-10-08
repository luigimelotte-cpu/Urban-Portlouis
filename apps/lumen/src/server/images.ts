import { checkImagePrompt, NEGATIVE_PROMPT, portraitPrompt } from "@/core/images/prompt";
import { ImageProviderError, type ImageStyle } from "@/core/images/types";
import type { ImageStore } from "@/core/pipeline/ports";
import { routeProvider } from "@/core/providers/router";
import { prisma } from "./db";
import { dbImageProviderSource } from "./providers";
import { HttpError } from "./services";

export const imageUrl = (id: string) => `/api/images/${id}`;
export const DAILY_IMAGE_LIMIT = Number(process.env.IMAGE_DAILY_LIMIT ?? 40);

export const prismaImageStore: ImageStore = {
  async save(img) {
    const row = await prisma.image.create({
      data: {
        userId: img.userId,
        characterId: img.characterId,
        conversationId: img.conversationId,
        messageId: img.messageId,
        kind: img.kind,
        caption: img.caption.slice(0, 300),
        prompt: img.prompt.slice(0, 4000),
        providerId: img.providerId,
        model: img.model,
        mimeType: img.mimeType,
        data: Buffer.from(img.bytes),
        width: img.width,
        height: img.height,
      },
      select: { id: true },
    });
    return row.id;
  },
  async countSince(userId, since) {
    return prisma.image.count({ where: { userId, createdAt: { gte: since } } });
  },
  async removeForMessages(ids) {
    if (ids.length) await prisma.image.deleteMany({ where: { messageId: { in: ids } } });
  },
};

/**
 * A user may see an image if they own it, or if it is the portrait of a
 * character they are allowed to see (public / unlisted / their own).
 */
export async function canView(imageId: string, userId: string | null) {
  const img = await prisma.image.findUnique({ where: { id: imageId }, select: { id: true, userId: true, kind: true, mimeType: true, data: true } });
  if (!img) return null;
  if (userId && img.userId === userId) return img;
  if (img.kind !== "PORTRAIT") return null;
  const used = await prisma.character.findFirst({
    where: { avatarUrl: imageUrl(img.id), OR: [{ visibility: { in: ["PUBLIC", "UNLISTED"] } }, ...(userId ? [{ creatorId: userId }] : [])] },
    select: { id: true },
  });
  return used ? img : null;
}

/** Portrait for the character creator (character may not exist yet). */
export async function generatePortrait(
  userId: string,
  input: { age: number; gender: string; appearance: string; occupation?: string; style: ImageStyle; characterId?: string | null },
) {
  if (input.age < 18) throw new HttpError(400, "Characters must be 18 or older.");
  const since = new Date(Date.now() - 86_400_000);
  if ((await prismaImageStore.countSince(userId, since)) >= DAILY_IMAGE_LIMIT) throw new HttpError(429, "Daily image limit reached. Try again tomorrow.");

  const prompt = portraitPrompt({ age: input.age, gender: input.gender, profile: { appearance: input.appearance, occupation: input.occupation ?? "", imageStyle: input.style } as never }, input.style);
  const check = checkImagePrompt(prompt, "SAFE");
  if (!check.allowed) throw new HttpError(400, "This description can't be used for a portrait. Describe a clearly adult, clothed character.");

  let route;
  try {
    route = routeProvider({ mode: "SAFE", role: "image", providers: await dbImageProviderSource.list(), fallback: "refuse" });
  } catch {
    throw new HttpError(503, "No image model is configured. Add one in /admin.");
  }
  for (const provider of route.candidates) {
    try {
      const img = await provider.generate({ prompt, negativePrompt: NEGATIVE_PROMPT, aspect: "portrait" });
      const id = await prismaImageStore.save({
        userId,
        characterId: input.characterId ?? null,
        conversationId: null,
        messageId: null,
        kind: "PORTRAIT",
        caption: "Portrait",
        prompt,
        providerId: provider.descriptor.id,
        model: img.model,
        mimeType: img.mimeType,
        bytes: img.bytes,
        width: img.width,
        height: img.height,
      });
      return { id, url: imageUrl(id) };
    } catch (e) {
      if (e instanceof ImageProviderError && e.retryable && provider !== route.candidates.at(-1)) continue;
      throw new HttpError(502, e instanceof ImageProviderError && !e.retryable ? "The image model declined this portrait. Try a different description." : "Image generation failed. Try again.");
    }
  }
  throw new HttpError(503, "No image model available.");
}
