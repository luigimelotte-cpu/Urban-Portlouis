import { redirect } from "next/navigation";
import { prisma } from "./db";
import { currentUserId } from "./session";

/** For server components: the current verified user, or redirect to the 18+ gate. */
export async function requireViewer(): Promise<string> {
  const id = await currentUserId();
  if (!id) redirect("/welcome");
  const u = await prisma.user.findUnique({ where: { id }, select: { ageVerifiedAt: true } });
  if (!u?.ageVerifiedAt) redirect("/welcome");
  return id;
}
