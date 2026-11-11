// Alert side channels: the synthesized beep and the desktop notification.
// No DOM lookup at import time; nothing here runs until an alert fires.

/* ---------- Web Audio Alert (Synthesized Beep) ---------- */
// One AudioContext for the whole session. Creating a fresh one per alert costs
// hundreds of ms on Windows/WebView2, can hit the browser's concurrent-context
// quota, and starts suspended — the main source of the perceived ff delay.
// Reusing one context + resuming when suspended makes the beep fire instantly.
let beepCtx: AudioContext | null = null;
export function getBeepCtx(): AudioContext | null {
  const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
  if (!AudioCtx) return null;
  if (!beepCtx) {
    beepCtx = new AudioCtx();
  }
  if (beepCtx.state === "suspended") {
    void beepCtx.resume();
  }
  return beepCtx;
}

export function playBeepAlert() {
  try {
    const ctx = getBeepCtx();
    if (!ctx) return;
    const now = ctx.currentTime;

    // First tone: 880 Hz
    const osc1 = ctx.createOscillator();
    const gain1 = ctx.createGain();
    osc1.frequency.setValueAtTime(880, now);
    gain1.gain.setValueAtTime(0.2, now);
    gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
    osc1.connect(gain1);
    gain1.connect(ctx.destination);
    osc1.start(now);
    osc1.stop(now + 0.18);

    // Second tone: 1320 Hz
    const osc2 = ctx.createOscillator();
    const gain2 = ctx.createGain();
    osc2.frequency.setValueAtTime(1320, now + 0.2);
    gain2.gain.setValueAtTime(0.25, now + 0.2);
    gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.52);
    osc2.connect(gain2);
    gain2.connect(ctx.destination);
    osc2.start(now + 0.2);
    osc2.stop(now + 0.52);
  } catch (e) {
    console.warn("AudioContext tone generation failed:", e);
  }
}

export function showDesktopNotification(title: string, body: string) {
  if (typeof Notification === "undefined") return;
  try {
    if (Notification.permission === "granted") {
      new Notification(title, { body });
    } else if (Notification.permission !== "denied") {
      void Notification.requestPermission().then((permission) => {
        if (permission === "granted") new Notification(title, { body });
      });
    }
  } catch (e) {
    console.warn("Desktop notification failed:", e);
  }
}
