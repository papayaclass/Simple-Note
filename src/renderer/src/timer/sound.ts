// Resolved by Vite at build time to the bundled, content-hashed asset URL
// (works in both dev and the packaged file:// renderer).
const alarmUrl = new URL('../assets/Alarm.wav', import.meta.url).href;

// Single shared audio element so a new alarm/timer ring replaces any current
// one rather than stacking sounds on top of each other.
let current: HTMLAudioElement | null = null;

// Plays the alarm sound, repeating the clip up to `maxLoops` times. If it is not
// stopped sooner (the user dismissing the ring), it stops itself after the last
// loop and runs `onFinish` so the UI can clear its "ringing" state.
export function playAlarm(maxLoops = 10, onFinish?: () => void): void {
  stopAlarm();
  const audio = new Audio(alarmUrl);
  current = audio;
  let played = 0;
  audio.addEventListener('ended', () => {
    if (audio !== current) return; // superseded by a newer ring
    played += 1;
    if (played >= maxLoops) {
      stopAlarm();
      onFinish?.();
      return;
    }
    audio.currentTime = 0;
    void audio.play().catch(() => {});
  });
  void audio.play().catch(() => {});
}

export function stopAlarm(): void {
  if (current) {
    current.pause();
    current.currentTime = 0;
    current = null;
  }
}
