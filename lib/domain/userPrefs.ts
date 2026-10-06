// The view settings a person keeps on their account. Only these keys are
// stored; each value is the setting's own short text.

/** The Plan Tracker's columns ("v1|mo,soi,…"), its components folded to
 *  "Made %" ("CF,TC") and its hidden components ("AR"). */
export const TRACKER_PREF_KEYS = ["tracker:cols", "tracker:collapsed", "tracker:hiddenItems"] as const;
export type UserPrefKey = (typeof TRACKER_PREF_KEYS)[number];

export const USER_PREF_MAX = 1000;

export function isUserPrefKey(k: string): k is UserPrefKey {
  return (TRACKER_PREF_KEYS as readonly string[]).includes(k);
}

/** What a page hands its client: each key's saved value, or null when this
 *  account has never set it. */
export type UserPrefs = Partial<Record<UserPrefKey, string | null>>;
