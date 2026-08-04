// The per-user Realtime topic — ONE naming convention shared by the server
// (which broadcasts into it) and the browser (which subscribes to its own).
export const chatTopic = (userId: number): string => `chat-user-${userId}`;
