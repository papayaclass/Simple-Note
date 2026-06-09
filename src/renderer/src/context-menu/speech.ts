// Shared, app-wide text-to-speech state. Lives at module scope (not per React
// component) because in two-column mode there are two Editor → ContextMenu
// instances; without sharing they would each keep a separate cache and each
// register the replay shortcut, causing the same word to play twice / overlap.

const audioCache = new Map<string, string>();
// De-dupe concurrent requests for the same text so two callers in the same tick
// share one API round-trip instead of generating two (slightly different) clips.
const inFlight = new Map<string, Promise<string | null>>();
let lastAudio: string | null = null;

function play(base64: string): void {
  lastAudio = base64;
  const audio = new Audio(`data:audio/wav;base64,${base64}`);
  void audio.play();
}

async function fetchAudio(text: string): Promise<string | null> {
  const res = await window.api.tts.speak(text);
  if (!res.ok) {
    window.alert(res.reason);
    return null;
  }
  audioCache.set(text, res.audio);
  return res.audio;
}

// Speak the given (or current selection) text. Same text → served from cache,
// so repeats never re-hit the API.
export async function speak(raw?: string): Promise<void> {
  const text = (raw ?? window.getSelection()?.toString() ?? '').trim();
  if (!text) return;
  const cached = audioCache.get(text);
  if (cached) {
    play(cached);
    return;
  }
  let pending = inFlight.get(text);
  if (!pending) {
    pending = fetchAudio(text).finally(() => inFlight.delete(text));
    inFlight.set(text, pending);
  }
  const audio = await pending;
  if (audio) play(audio);
}

export function replayLast(): void {
  if (lastAudio) play(lastAudio);
}

// Shift+Cmd+P: speak the selection (cache makes a repeat instant + API-free), or
// replay the last clip when nothing is selected. Installed exactly once for the
// whole app — guarded so multiple ContextMenu instances don't stack listeners.
let installed = false;
export function installSpeechShortcut(): void {
  if (installed) return;
  installed = true;
  window.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && e.code === 'KeyP') {
      e.preventDefault();
      const text = (window.getSelection()?.toString() ?? '').trim();
      if (text) void speak(text);
      else replayLast();
    }
  });
}
