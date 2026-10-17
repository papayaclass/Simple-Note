import { clipboard, contextBridge, ipcRenderer, webUtils } from 'electron';

// Both serializations of the current document; main writes whichever matches
// the target file's extension.
export interface NoteContents {
  markdown: string;
  snote: string;
}

// A document main pushes into a window as a new tab: a file opened from Finder
// / File → Open (dirty false), or a tab moved in from another window (which may
// be untitled and unsaved).
export interface OpenDocumentPayload {
  path: string | null;
  content: string;
  dirty?: boolean;
  kind?: 'editor' | 'sheet';
  fileName?: string;
  frontMatter?: string;
}

export interface SimpleNoteAPI {
  prefs: {
    get: () => Promise<Record<string, unknown>>;
    set: (key: string, value: unknown) => Promise<void>;
    setAll: (prefs: Record<string, unknown>) => Promise<void>;
  };
  ai: {
    run: (
      userContent: string
    ) => Promise<{ ok: true; content: string } | { ok: false; reason: string }>;
  };
  youtube: {
    preview: (
      videoId: string
    ) => Promise<
      | {
          ok: true;
          data: {
            title: string;
            author: string;
            thumbnail: string;
            viewCount: string | null;
            viewCountRaw: number | null;
            publishDate: string | null;
          };
        }
      | { ok: false; reason: string }
    >;
  };
  file: {
    save: (
      contents: NoteContents,
      options: { path: string | null; suggestedName?: string }
    ) => Promise<{ ok: boolean; path?: string }>;
    saveAs: (
      contents: NoteContents,
      suggestedName?: string
    ) => Promise<{ ok: boolean; path?: string }>;
    exportMarkdown: (
      markdown: string,
      suggestedName?: string
    ) => Promise<{ ok: boolean; path?: string }>;
    convertToSnote: (path: string, snote: string) => Promise<{ ok: boolean; path?: string }>;
    rename: (
      path: string,
      newBase: string
    ) => Promise<{ ok: boolean; path?: string; reason?: 'exists' | 'failed' }>;
    confirmLossy: (
      kind: 'convert' | 'export',
      name: string,
      features: string[],
      doc?: 'note' | 'sheet'
    ) => Promise<boolean>;
    confirmCloseDirty: (name: string) => Promise<0 | 1 | 2>;
    saveImage: (dataUrl: string) => Promise<{ ok: boolean; path?: string }>;
    getPathForFile: (file: File) => string;
    read: (path: string) => Promise<{ ok: boolean; content?: string }>;
    readImage: (noteDir: string | null, src: string) => Promise<{ ok: boolean; dataUrl?: string }>;
  };
  clipboard: {
    readText: () => string;
    writeText: (text: string) => void;
  };
  window: {
    setDirty: (dirty: boolean) => void;
    setTitle: (title: string) => void;
    close: () => void;
    moveTabToNewWindow: (doc: OpenDocumentPayload) => void;
    beginTabDrag: (token: string, tabId: string) => void;
    endTabDrag: (token: string) => void;
    moveTabHere: (token: string, paneId: string, index: number) => Promise<boolean>;
    saveAll: () => Promise<void>;
  };
  onTabDragState: (handler: (active: boolean) => void) => () => void;
  onMenu: (handler: (command: string) => void) => () => void;
  onOpenInTab: (handler: (payload: OpenDocumentPayload) => void) => () => void;
  notifyReady: () => Promise<boolean>;
}

const api: SimpleNoteAPI = {
  prefs: {
    get: () => ipcRenderer.invoke('prefs:get'),
    set: (key, value) => ipcRenderer.invoke('prefs:set', key, value),
    setAll: (prefs) => ipcRenderer.invoke('prefs:setAll', prefs),
  },
  ai: {
    run: (userContent) => ipcRenderer.invoke('ai:run', userContent),
  },
  youtube: {
    preview: (videoId) => ipcRenderer.invoke('youtube:preview', videoId),
  },
  file: {
    save: (contents, options) => ipcRenderer.invoke('file:save', contents, options),
    saveAs: (contents, suggestedName) =>
      ipcRenderer.invoke('file:saveAs', contents, suggestedName),
    exportMarkdown: (markdown, suggestedName) =>
      ipcRenderer.invoke('file:exportMarkdown', markdown, suggestedName),
    convertToSnote: (path, snote) => ipcRenderer.invoke('file:convertToSnote', path, snote),
    rename: (path, newBase) => ipcRenderer.invoke('file:rename', path, newBase),
    confirmLossy: (kind, name, features, doc) =>
      ipcRenderer.invoke('file:confirmLossy', kind, name, features, doc),
    confirmCloseDirty: (name) => ipcRenderer.invoke('file:confirmCloseDirty', name),
    saveImage: (dataUrl) => ipcRenderer.invoke('file:saveImage', dataUrl),
    getPathForFile: (file) => webUtils.getPathForFile(file),
    read: (path) => ipcRenderer.invoke('file:read', path),
    readImage: (noteDir, src) => ipcRenderer.invoke('file:readImage', noteDir, src),
  },
  clipboard: {
    readText: () => clipboard.readText(),
    writeText: (text) => clipboard.writeText(text),
  },
  window: {
    setDirty: (dirty) => ipcRenderer.send('window:setDirty', dirty),
    setTitle: (title) => ipcRenderer.send('window:setTitle', title),
    close: () => ipcRenderer.send('window:close'),
    moveTabToNewWindow: (doc) => ipcRenderer.send('window:moveTab', doc),
    beginTabDrag: (token, tabId) => ipcRenderer.send('window:beginTabDrag', token, tabId),
    endTabDrag: (token) => ipcRenderer.send('window:endTabDrag', token),
    moveTabHere: (token, paneId, index) => ipcRenderer.invoke('window:moveTabHere', token, paneId, index),
    saveAll: () => ipcRenderer.invoke('window:saveAll'),
  },
  onTabDragState: (handler) => {
    const listener = (_e: unknown, active: boolean) => handler(active);
    ipcRenderer.on('window:tabDragState', listener);
    return () => ipcRenderer.removeListener('window:tabDragState', listener);
  },
  onMenu: (handler) => {
    type Listener = Parameters<typeof ipcRenderer.on>[1];
    const channels: Array<[string, Listener]> = [];
    const wrap = (cmd: string) => {
      const listener: Listener = () => handler(cmd);
      ipcRenderer.on(`menu:${cmd}`, listener);
      channels.push([`menu:${cmd}`, listener]);
    };
    // 'open' is handled in main (reads the file then pushes it as a tab via
    // 'file:openInTab'). 'new-tab' asks the renderer to add a blank tab.
    wrap('save');
    wrap('preferences');
    wrap('new-tab');

    const cmdListener: Listener = (_e, cmd) => handler(String(cmd));
    ipcRenderer.on('menu:command', cmdListener);
    channels.push(['menu:command', cmdListener]);

    return () => {
      for (const [c, l] of channels) ipcRenderer.removeListener(c, l);
    };
  },
  onOpenInTab: (handler) => {
    const listener = (_e: unknown, payload: OpenDocumentPayload) => handler(payload);
    ipcRenderer.on('file:openInTab', listener);
    return () => ipcRenderer.removeListener('file:openInTab', listener);
  },
  notifyReady: () => ipcRenderer.invoke('renderer:ready'),
};

contextBridge.exposeInMainWorld('api', api);
