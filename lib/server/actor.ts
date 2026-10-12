import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import type { User } from "@prisma/client";

// Who a change made by the assistant is made AS.
//
// The assistant never gets a write path of its own: a change it proposes runs
// through the app's own server action for it — the same validation, the same
// permission check, the same audit columns as the person clicking it. Those
// actions find "who is asking" with getCurrentUser(); inside runAsActor that
// answer is the person the assistant acts for, so the action checks THEIR
// permissions (the assistant can never do more than they can) and stamps
// their name, marked as made by the assistant, wherever it records who did it.
//
// Only server code can enter this: a request never sets it, and an action
// called from a browser sees the session's user as always.

export type ActorVia = "ai" | "automation";

interface Actor {
  user: User;
  via: ActorVia;
}

const store = new AsyncLocalStorage<Actor>();

/** The name a change made by the assistant carries in the app's "by"
 *  columns — the person's, marked, so the record reads truthfully. */
export function actorName(name: string, via: ActorVia): string {
  return via === "automation" ? `${name} (AI automation)` : `${name} (AI)`;
}

/** Run `fn` with every permission check and audit stamp inside it reading
 *  `user` — already the effective user (the owner's rights expanded). */
export function runAsActor<T>(user: User, via: ActorVia, fn: () => Promise<T>): Promise<T> {
  return store.run({ user: { ...user, name: actorName(user.name, via) }, via }, fn);
}

/** The actor in force, if the current call runs on the assistant's behalf. */
export function currentActor(): Actor | undefined {
  return store.getStore();
}
