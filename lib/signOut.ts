// Signing out of this device. The browser's push subscription belongs to the
// account that turned notifications on; left behind, the next person to sign
// in on a shared tablet would see the previous account's inbox on its screen.
// So the device is unsubscribed first, then the session ends. Client-only.

import { logoutAction } from "@/app/login/actions";
import { turnPushOff } from "@/lib/pushClient";

export async function signOut(): Promise<void> {
  try {
    await turnPushOff();
  } catch {
    // no notifications on this device, or the browser refused — the sign-out still stands
  }
  await logoutAction();
}
