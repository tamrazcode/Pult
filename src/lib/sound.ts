/** Soft synthesized chimes; no binary assets and no new dependencies. */

export type NotificationSound = "done" | "error" | "cancelled";

let context: AudioContext | null = null;

type AudioContextCtor = typeof AudioContext;

function audioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext;
  if (!ctor) return null;
  context ??= new ctor();
  return context;
}

/** Two-note rising chime for success, a gentle falling pair for errors. */
export function playNotificationSound(kind: NotificationSound): void {
  const audio = audioContext();
  if (!audio) return;
  void audio.resume().catch(() => {});
  const notes = kind === "error" ? [392, 311.13] : kind === "cancelled" ? [440] : [523.25, 659.25];
  notes.forEach((frequency, index) => {
    const start = audio.currentTime + index * 0.16;
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.11, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.32);
    oscillator.connect(gain);
    gain.connect(audio.destination);
    oscillator.start(start);
    oscillator.stop(start + 0.34);
  });
}
