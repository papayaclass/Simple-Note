// Maps each BlockNote editor instance to the directory of the note it is
// editing, so an image block can resolve a relative `src` against it. A WeakMap
// avoids leaking when editors are torn down. Used instead of React context
// because BlockNote node views don't reliably inherit the app's context.
const noteDirByEditor = new WeakMap<object, string | null>();

export function setEditorNoteDir(editor: object, dir: string | null): void {
  noteDirByEditor.set(editor, dir);
}

export function getEditorNoteDir(editor: object): string | null {
  return noteDirByEditor.get(editor) ?? null;
}

// Cache of resolved file-path images (key = `${noteDir}\0${src}`)
// so node-view re-renders don't re-read the same file from disk.
const resolvedImages = new Map<string, string>();

export function imageCacheKey(noteDir: string | null, src: string): string {
  return `${noteDir ?? ''}\0${src}`;
}

export function getResolvedImage(key: string): string | undefined {
  return resolvedImages.get(key);
}

export function setResolvedImage(key: string, dataUrl: string): void {
  resolvedImages.set(key, dataUrl);
}

// Directory portion of a file path using plain string ops (renderer has no
// node:path). Returns null for untitled/no-path notes.
export function dirOf(path: string | null): string | null {
  if (!path) return null;
  const i = path.lastIndexOf('/');
  return i > 0 ? path.slice(0, i) : null;
}
