// Browser side of chat delivery. When the Supabase env vars are present the
// tab subscribes to its own user topic and events arrive as broadcasts; when
// they're absent (or the socket drops) the ChatClient's polling covers it.
// Client-only module — never import from server code.

import { createClient, type RealtimeChannel, type SupabaseClient } from "@supabase/supabase-js";
import type { ChatMessageDTO, ThreadKind } from "@/lib/server/chat";
import { chatTopic } from "@/lib/domain/chatTopic";

export interface ChatBroadcastPayload {
  message: ChatMessageDTO;
  fromName: string;
}

/** "Re-read this thread": pins/reactions/membership changed EXISTING rows,
 *  which the incremental message flow never re-delivers. */
export interface ChatSyncPayload {
  kind: ThreadKind;
  id: number;
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

/** Whether live delivery is configured — the ChatClient polls faster when not. */
export const chatRealtimeConfigured = !!(url && key);

let client: SupabaseClient | null = null;

/** Subscribe to the caller's own chat topic. Returns an unsubscribe. The
 *  `onDrop` callback fires when the socket errors — the caller should do one
 *  catch-up poll, since anything broadcast while down is gone for good. */
export function subscribeChat(
  userId: number,
  handlers: {
    onMessage: (p: ChatBroadcastPayload) => void;
    onSync?: (p: ChatSyncPayload) => void;
    onDrop?: () => void;
  },
): () => void {
  if (!url || !key) return () => {};
  client ??= createClient(url, key, { auth: { persistSession: false } });

  const channel: RealtimeChannel = client
    .channel(chatTopic(userId))
    .on("broadcast", { event: "message" }, ({ payload }) => handlers.onMessage(payload as ChatBroadcastPayload))
    .on("broadcast", { event: "sync" }, ({ payload }) => handlers.onSync?.(payload as ChatSyncPayload))
    .subscribe((status) => {
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") handlers.onDrop?.();
    });

  return () => {
    void channel.unsubscribe();
  };
}
