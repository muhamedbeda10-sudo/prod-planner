// A short two-note chime for an incoming chat message, made with Web Audio so
// there is no sound file to ship. Browsers refuse to start audio until the
// page has had a click or a key press, so `armChime` listens for the first
// one and opens the audio context then; after that `playChime` works even
// while the tab is in the background. Client-only module.

let ctx: AudioContext | null = null;
let armed = false;

const SOUND_KEY = "chat.sound";

export function chimeOn(): boolean {
  try {
    return localStorage.getItem(SOUND_KEY) !== "off";
  } catch {
    return true;
  }
}

export function setChimeOn(on: boolean) {
  try {
    localStorage.setItem(SOUND_KEY, on ? "on" : "off");
  } catch {
    /* private window — the choice lasts until the page closes */
  }
}

function context(): AudioContext | null {
  if (ctx) return ctx;
  const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return null;
  ctx = new AC();
  return ctx;
}

/** Open the audio context on the first user gesture. Safe to call often. */
export function armChime() {
  if (armed || typeof window === "undefined") return;
  armed = true;
  const unlock = () => {
    const c = context();
    if (c && c.state === "suspended") void c.resume();
    window.removeEventListener("pointerdown", unlock);
    window.removeEventListener("keydown", unlock);
  };
  window.addEventListener("pointerdown", unlock);
  window.addEventListener("keydown", unlock);
}

/** Two soft rising notes. Silent when muted or when audio is not unlocked yet. */
export function playChime() {
  if (!chimeOn()) return;
  const c = context();
  if (!c) return;
  if (c.state === "suspended") void c.resume();
  const t0 = c.currentTime + 0.01;
  for (const [i, freq] of [880, 1318.5].entries()) {
    const start = t0 + i * 0.14;
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.22, start + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.32);
    osc.connect(gain).connect(c.destination);
    osc.start(start);
    osc.stop(start + 0.34);
  }
}
