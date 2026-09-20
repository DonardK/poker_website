"use client";

let ctx: AudioContext | null = null;

function audio(): AudioContext | null {
  if (typeof window === "undefined") return null;
  ctx ??= new AudioContext();
  return ctx;
}

export function playSound(kind: "deal" | "chip" | "turn" | "win"): void {
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
