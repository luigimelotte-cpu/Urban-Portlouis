import { notFound } from "next/navigation";
import { prisma } from "@/server/db";
import { getConversationForUser } from "@/server/services";
import { prismaChatStore } from "@/server/store";
import { requireViewer } from "@/server/viewer";
import { ChatView, type Msg } from "./ChatView";

export const dynamic = "force-dynamic";

export default async function ChatPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const userId = await requireViewer();
  const data = await getConversationForUser(id, userId);
  if (!data) notFound();
  const [rel, user] = await Promise.all([prismaChatStore.getRelationship(userId, data.character.id), prisma.user.findUnique({ where: { id: userId }, select: { adultOptIn: true } })]);
  const messages: Msg[] = data.messages.map((m) => ({
    id: m.id,
    role: m.role,
    content: m.content,
    createdAt: m.createdAt.toISOString(),
    meta: { kind: m.meta.kind },
  }));
  return (
    <ChatView
      conversationId={id}
      character={{ id: data.character.id, name: data.character.name, avatarUrl: data.character.avatarUrl ?? null }}
      initialMessages={messages}
      initialStyle={data.conversation.style}
      initialMode={data.conversation.contentMode}
      initialStage={rel?.stage ?? data.character.profile.initialRelationship}
      adultOptIn={!!user?.adultOptIn}
    />
  );
}
