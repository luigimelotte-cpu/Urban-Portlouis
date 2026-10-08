import { body, json, requireVerifiedUser, route } from "@/server/http";
import { createCharacter, listVisibleCharacters } from "@/server/services";
import { currentUserId } from "@/server/session";

export const GET = route(async (req) => {
  const url = new URL(req.url);
  const uid = await currentUserId();
  const chars = await listVisibleCharacters(uid, { q: url.searchParams.get("q") ?? undefined, tag: url.searchParams.get("tag") ?? undefined });
  return json({ characters: chars.map(({ profile, ...c }) => ({ ...c, openingMessage: profile.openingMessage })) });
});

export const POST = route(async (req) => {
  const uid = await requireVerifiedUser();
  const character = await createCharacter(uid, await body(req));
  return json({ character }, 201);
});
