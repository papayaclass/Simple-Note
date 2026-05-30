// Pure parsing helpers for the in-document `timer` / `alarm` commands.
// Kept free of React / editor dependencies so they're trivially testable.

// Line matchers: command word at line start, case-insensitive, tolerant of
// surrounding whitespace. The captured group is the argument (e.g. "10m").
export const TIMER_RE = /^\s*timer\s+(.+?)\s*$/i;
export const ALARM_RE = /^\s*alarm\s+(.+?)\s*$/i;

// Normalize a line before command matching so it survives whatever form the
// macOS input source produced: a Chinese IME emits full-width digits/colon
// (１３：３０) and some keyboards render digits as keycap emoji (1️⃣3️⃣). Strip
// emoji variation selectors / keycap combiners and fold full-width chars to
// ASCII so `alarm 13:30` is recognized regardless.
export function normalizeCommandText(text: string): string {
  return text
    .replace(/[️⃣]/g, '') // emoji variation selector + keycap combiner
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xff10 + 0x30))
    .replace(/：/g, ':') // full-width colon
    .replace(/　/g, ' '); // ideographic space
}

// Parse a timer argument into a number of seconds, or null if unparseable.
//   10m → 600, 1h → 3600, 30s → 30
//   10  → 600   (no unit ⇒ minutes)
//   1:30    → 90      (mm:ss)
//   1:30:30 → 5430    (hh:mm:ss)
export function parseTimer(arg: string): number | null {
  const s = arg.trim();
  if (s.length === 0) return null;

  // Colon form: mm:ss or hh:mm:ss
  if (s.includes(':')) {
    const parts = s.split(':');
    if (parts.length < 2 || parts.length > 3) return null;
    if (!parts.every((p) => /^\d+$/.test(p))) return null;
    const nums = parts.map((p) => parseInt(p, 10));
    if (parts.length === 2) {
      const [mm, ss] = nums as [number, number];
      return mm * 60 + ss;
    }
    const [hh, mm, ss] = nums as [number, number, number];
    return hh * 3600 + mm * 60 + ss;
  }

  // Unit form: <number><s|m|h>
  const unit = /^(\d+)\s*([smh])$/i.exec(s);
  if (unit) {
    const n = parseInt(unit[1]!, 10);
    switch (unit[2]!.toLowerCase()) {
      case 's':
        return n;
      case 'm':
        return n * 60;
      case 'h':
        return n * 3600;
    }
  }

  // Bare number ⇒ minutes
  if (/^\d+$/.test(s)) return parseInt(s, 10) * 60;

  return null;
}

// Parse an alarm argument "HH:MM" (24-hour). Returns {hours, minutes} or null.
export function parseAlarm(arg: string): { hours: number; minutes: number } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(arg.trim());
  if (!m) return null;
  const hours = parseInt(m[1]!, 10);
  const minutes = parseInt(m[2]!, 10);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return { hours, minutes };
}

// Format a positive remaining-seconds value for the countdown chip.
//   ≥ 1h → "H:MM:SS", otherwise "M:SS"
export function formatRemaining(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n: number): string => String(n).padStart(2, '0');
  if (hh > 0) return `${hh}:${pad(mm)}:${pad(ss)}`;
  return `${mm}:${pad(ss)}`;
}

// Compute the next epoch-ms timestamp for an alarm at the given wall-clock
// time. If that time has already passed today, roll over to tomorrow.
export function nextAlarmTimestamp(
  hours: number,
  minutes: number,
  now: number = Date.now()
): number {
  const d = new Date(now);
  d.setHours(hours, minutes, 0, 0);
  let ts = d.getTime();
  if (ts <= now) ts += 24 * 60 * 60 * 1000;
  return ts;
}

// Display label for an alarm chip from its epoch-ms timestamp: "HH:MM".
export function formatAlarmLabel(at: number): string {
  const d = new Date(at);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
