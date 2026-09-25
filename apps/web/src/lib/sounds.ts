"use client";

let ctx: AudioContext | null = null;
const SOUND_KEY = "poker-sound-enabled";

export function soundEnabled(): boolean {
  return typeof window !== "undefined" && window.localStorage.getItem(SOUND_KEY) !== "false";
}

export function setSoundEnabled(enabled: boolean): void {
  if (typeof window !== "undefined") window.localStorage.setItem(SOUND_KEY, String(enabled));
}

function audio(): AudioContext | null {
  if (typeof window === "undefined") return null;
  ctx ??= new AudioContext();
  return ctx;
}

export function playSound(kind: "deal" | "chip" | "turn" | "win"): void {
  if (!soundEnabled()) return;
  const ac = audio();
  if (!ac) return;
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
}
