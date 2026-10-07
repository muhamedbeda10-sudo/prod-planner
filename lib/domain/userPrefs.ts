// The view settings a person keeps on their account. Only these keys are
// stored; each value is the setting's own short text.

/** The Plan Tracker's columns ("v1|mo,soi,…"), its components folded to
 *  "Made %" ("CF,TC") and its hidden components ("AR"). */
export const TRACKER_PREF_KEYS = ["tracker:cols", "tracker:collapsed", "tracker:hiddenItems"] as const;
/** The LV Panels tracker's columns ("v1|mo,product,…") and its hidden
 *  stages ("Bending,Delivered"). */
export const LV_TRACKER_PREF_KEYS = ["lvtracker:cols", "lvtracker:hiddenStages"] as const;
/** The newest "What's new" entry this person has opened the list on — the
 *  ones after it are counted on the button. */
export const WHATS_NEW_PREF_KEYS = ["whatsnew:seen"] as const;
const ALL_KEYS = [...TRACKER_PREF_KEYS, ...LV_TRACKER_PREF_KEYS, ...WHATS_NEW_PREF_KEYS] as const;
export type UserPrefKey = (typeof ALL_KEYS)[number];

export const USER_PREF_MAX = 1000;

export function isUserPrefKey(k: string): k is UserPrefKey {
  return (ALL_KEYS as readonly string[]).includes(k);
}

/** What a page hands its client: each key's saved value, or null when this
 *  account has never set it. */
export type UserPrefs = Partial<Record<UserPrefKey, string | null>>;
