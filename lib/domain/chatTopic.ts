// The per-user Realtime topic — ONE naming convention shared by the server
// (which broadcasts into it) and the browser (which subscribes to its own).
/** A team chat message, at most (characters). */
export const CHAT_MESSAGE_MAX = 2000;

export const chatTopic = (userId: number): string => `chat-user-${userId}`;
