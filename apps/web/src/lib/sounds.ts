"use client";

/**
 * Table sound effects. Everything here is best-effort and must never throw:
 * playSound runs right next to a player's action (and from snapshot effects),
 * and a throwing localStorage (private mode, blocked site data, a sandboxed
 * iframe) or AudioContext (no audio device, a browser that refuses it) would
 * otherwise freeze the action buttons or crash the table page.
 */
let ctx: AudioContext | null = null;
let audioUnavailable = false;
const SOUND_KEY = "poker-sound-enabled";
/**
 * The choice made in this tab, used when storage is unavailable, so the
 * toggle still works for the session even where it cannot be remembered.
 */
let memoryEnabled: boolean | null = null;

export function soundEnabled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const stored = window.localStorage.getItem(SOUND_KEY);
    if (stored !== null) return stored !== "false";
  } catch {
    // Storage blocked: fall back to this tab's choice.
  }
  return memoryEnabled ?? true;
}

export function setSoundEnabled(enabled: boolean): void {
  memoryEnabled = enabled;
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SOUND_KEY, String(enabled));
  } catch {
    // Not remembered across visits; this tab still honours it.
  }
}

function audio(): AudioContext | null {
  if (typeof window === "undefined" || audioUnavailable) return null;
  if (ctx) return ctx;
  try {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) {
      audioUnavailable = true;
      return null;
    }
    ctx = new Ctor();
  } catch {
    // Some browsers refuse an AudioContext outright; stop asking.
    audioUnavailable = true;
    return null;
  }
  return ctx;
}

/**
 * Browsers start an AudioContext suspended until a user gesture, and mobile
 * browsers suspend it again after an interruption (a call, the app going to
 * the background). resume() returns a promise that may reject; it is never awaited.
 */
function resumeIfSuspended(ac: AudioContext): void {
  try {
    if (ac.state === "suspended") void ac.resume().catch(() => undefined);
  } catch {
    // Ignore: sound is optional.
  }
}

/**
 * Resume (or create) the audio context on pointer and keyboard gestures, the
 * only moments a browser lets a page start audio. Returns the cleanup.
 */
export function installAudioUnlock(): () => void {
  if (typeof window === "undefined") return () => undefined;
  const unlock = () => {
    if (!soundEnabled()) return;
    const ac = audio();
    if (ac) resumeIfSuspended(ac);
  };
  window.addEventListener("pointerdown", unlock, true);
  window.addEventListener("keydown", unlock, true);
  return () => {
    window.removeEventListener("pointerdown", unlock, true);
    window.removeEventListener("keydown", unlock, true);
  };
}

export function playSound(kind: "deal" | "chip" | "turn" | "win"): void {
  try {
    if (!soundEnabled()) return;
    const ac = audio();
    if (!ac) return;
    resumeIfSuspended(ac);
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.connect(gain);
    gain.connect(ac.destination);
    const now = ac.currentTime;
    const freq = kind === "deal" ? 520 : kind === "chip" ? 240 : kind === "win" ? 660 : 880;
    osc.frequency.setValueAtTime(freq, now);
    gain.gain.setValueAtTime(0.04, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);
    osc.start(now);
    osc.stop(now + 0.2);
  } catch {
    // Sound is decoration; a failure here must never reach the caller.
  }
}
