import { redirect } from "next/navigation";
import { getCurrentUser, guardTab } from "@/lib/server/auth";
import { getChatContacts } from "@/lib/server/chat";
import { ChatClient } from "@/components/ChatClient";
import { PageHead } from "@/components/ui";

export const dynamic = "force-dynamic";

// In-app direct messages. Any active account can message any other — no
// permission key; the proxy already keeps logged-out visitors away.
export default async function ChatPage({ searchParams }: { searchParams: Promise<{ open?: string }> }) {
  await guardTab("/chat");
  const user = await getCurrentUser();
  if (!user) redirect("/login"); // belt and braces — the proxy is optimistic

  const contacts = await getChatContacts(user.id);
  // ?open=user-12 / ?open=group-3 — Reply on a message popup, on a phone
  const m = /^(user|group)-(\d+)$/.exec((await searchParams).open ?? "");
  const openOn = m ? { kind: m[1] as "user" | "group", id: Number(m[2]) } : null;
  return (
    <>
      <PageHead title="Chat" sub="Messages between the plant's accounts" />
      <ChatClient me={{ id: user.id, name: user.name }} initialContacts={contacts} openOn={openOn} />
    </>
  );
}
