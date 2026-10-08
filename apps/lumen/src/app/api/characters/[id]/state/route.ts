import { baselineFromTraits, dominantEmotions } from "@/core/emotion/engine";
import { initialRelationship } from "@/core/relationship/engine";
import { json, requireVerifiedUser, route } from "@/server/http";
import { HttpError, getVisibleCharacter } from "@/server/services";
import { prismaChatStore } from "@/server/store";

type Ctx = { params: Promise<{ id: string }> };

export const GET = route<Ctx>(async (_req, { params }) => {
  const { id } = await params;
  const uid = await requireVerifiedUser();
  const c = await getVisibleCharacter(id, uid);
  if (!c) throw new HttpError(404, "Character not found");
  const baseline = baselineFromTraits(c.profile.traits);
  const relationship = (await prismaChatStore.getRelationship(uid, id)) ?? initialRelationship(c.profile.initialRelationship);
  const emo = await prismaChatStore.getEmotions(uid, id);
  return json({ relationship, emotions: dominantEmotions(emo?.values ?? baseline, baseline, 3), emotionVector: emo?.values ?? baseline });
});
