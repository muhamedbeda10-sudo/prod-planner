import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/server/auth";
import { getChatContacts } from "@/lib/server/chat";
import { ChatClient } from "@/components/ChatClient";

export const dynamic = "force-dynamic";

// In-app direct messages. Any active account can message any other — no
// permission key; the proxy already keeps logged-out visitors away.
export default async function ChatPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login"); // belt and braces — the proxy is optimistic

  const contacts = await getChatContacts(user.id);
  return <ChatClient me={{ id: user.id, name: user.name }} initialContacts={contacts} />;
}
