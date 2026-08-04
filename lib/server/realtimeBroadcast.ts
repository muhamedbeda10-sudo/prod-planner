import "server-only";

// Supabase Realtime broadcast over its HTTP endpoint — no websocket from the
// serverless side. Fire-and-forget: the DB row is the source of truth, the
// broadcast only saves the recipient a refresh. When the env vars are absent
// the app still works — clients fall back to polling.

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

/** Whether live delivery is configured (clients poll otherwise). */
export const realtimeConfigured = !!(url && key);

/** Send one broadcast message to a topic. Never throws — delivery is
 *  best-effort and a miss only means the client sees it on the next poll. */
export async function broadcast(topic: string, event: string, payload: unknown): Promise<void> {
  if (!url || !key) return;
  try {
    await fetch(`${url}/realtime/v1/api/broadcast`, {
      method: "POST",
      headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ topic, event, payload }] }),
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    // swallowed on purpose — see above
  }
}
