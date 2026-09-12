import { getConversationMessages } from "../../lib/api";
import ChatView from "../ChatView";

export default async function ConversationPage({ params }: { params: Promise<{ conversationId: string }> }) {
  const { conversationId } = await params;
  const { messages } = await getConversationMessages(conversationId);
  return <ChatView conversationId={conversationId} initialMessages={messages} />;
}
