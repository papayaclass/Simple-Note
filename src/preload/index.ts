import { clipboard, contextBridge, ipcRenderer } from 'electron';

// One node in the vault file tree (mirrors VaultNode in src/main/vault.ts —
// preload compiles separately, so the shape is re-declared here).
export interface VaultNode {
  name: string;
  path: string;
  type: 'file' | 'folder';
  mtimeMs: number;
  birthtimeMs: number;
  children?: VaultNode[];
}

export interface SimpleNoteAPI {
  prefs: {
    get: () => Promise<Record<string, unknown>>;
    set: (key: string, value: unknown) => Promise<void>;
    setAll: (prefs: Record<string, unknown>) => Promise<void>;
  };
  rate: {
    get: (
      currency: string
    ) => Promise<{ ok: true; rate: number; fetchedAt: number } | { ok: false; reason: string }>;
    clearCache: () => Promise<void>;
  };
  ai: {
    run: (
      userContent: string
    ) => Promise<{ ok: true; content: string } | { ok: false; reason: string }>;
  };
  tts: {
    speak: (
      text: string
    ) => Promise<{ ok: true; audio: string } | { ok: false; reason: string }>;
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
      markdown: string,
      options: { path: string | null; suggestedName?: string }
    ) => Promise<{ ok: boolean; path?: string }>;
    saveImage: (dataUrl: string) => Promise<{ ok: boolean; path?: string }>;
  };
  vault: {
    pick: () => Promise<string | null>;
    get: () => Promise<string | null>;
    clear: () => Promise<void>;
    list: () => Promise<VaultNode[]>;
    read: (path: string) => Promise<{ ok: boolean; content?: string }>;
    createFile: (dir?: string | null) => Promise<{ ok: boolean; path?: string }>;
    createFolder: (dir?: string | null) => Promise<{ ok: boolean; path?: string }>;
    rename: (
      path: string,
      newName: string
    ) => Promise<{ ok: boolean; path?: string; reason?: string }>;
    delete: (path: string) => Promise<{ ok: boolean }>;
    duplicate: (path: string) => Promise<{ ok: boolean; path?: string }>;
    move: (
      src: string,
      destDir: string
    ) => Promise<{ ok: boolean; path?: string; reason?: string }>;
    reveal: (path: string) => Promise<void>;
    moveToVault: (
      markdown: string,
      suggestedName?: string
    ) => Promise<{ ok: boolean; path?: string }>;
  };
  clipboard: {
    readText: () => string;
    writeText: (text: string) => void;
  };
  window: {
    setDirty: (dirty: boolean) => void;
    setTitle: (title: string) => void;
    close: () => void;
    openInNewWindow: (path: string) => void;
  };
  notify: {
    show: (title: string, body: string) => void;
  };
  onMenu: (handler: (command: string) => void) => () => void;
  onExternalOpen: (
    handler: (payload: { path: string; content: string }) => void
  ) => () => void;
  onOpenInTab: (
    handler: (payload: { path: string; content: string }) => void
  ) => () => void;
  onVaultChanged: (handler: () => void) => () => void;
  notifyReady: () => void;
}

const api: SimpleNoteAPI = {
  prefs: {
    get: () => ipcRenderer.invoke('prefs:get'),
    set: (key, value) => ipcRenderer.invoke('prefs:set', key, value),
    setAll: (prefs) => ipcRenderer.invoke('prefs:setAll', prefs),
  },
  rate: {
    get: (currency) => ipcRenderer.invoke('rate:get', currency),
    clearCache: () => ipcRenderer.invoke('rate:clear'),
  },
  ai: {
    run: (userContent) => ipcRenderer.invoke('ai:run', userContent),
  },
  tts: {
    speak: (text) => ipcRenderer.invoke('tts:speak', text),
  },
  youtube: {
    preview: (videoId) => ipcRenderer.invoke('youtube:preview', videoId),
  },
  file: {
    save: (markdown, options) => ipcRenderer.invoke('file:save', markdown, options),
    saveImage: (dataUrl) => ipcRenderer.invoke('file:saveImage', dataUrl),
  },
  vault: {
    pick: () => ipcRenderer.invoke('vault:pick'),
    get: () => ipcRenderer.invoke('vault:get'),
    clear: () => ipcRenderer.invoke('vault:clear'),
    list: () => ipcRenderer.invoke('vault:list'),
    read: (path) => ipcRenderer.invoke('vault:read', path),
    createFile: (dir) => ipcRenderer.invoke('vault:createFile', dir),
    createFolder: (dir) => ipcRenderer.invoke('vault:createFolder', dir),
    rename: (path, newName) => ipcRenderer.invoke('vault:rename', path, newName),
    delete: (path) => ipcRenderer.invoke('vault:delete', path),
    duplicate: (path) => ipcRenderer.invoke('vault:duplicate', path),
    move: (src, destDir) => ipcRenderer.invoke('vault:move', src, destDir),
    reveal: (path) => ipcRenderer.invoke('vault:reveal', path),
    moveToVault: (markdown, suggestedName) =>
      ipcRenderer.invoke('vault:moveToVault', markdown, suggestedName),
  },
  clipboard: {
    readText: () => clipboard.readText(),
    writeText: (text) => clipboard.writeText(text),
  },
  window: {
    setDirty: (dirty) => ipcRenderer.send('window:setDirty', dirty),
    setTitle: (title) => ipcRenderer.send('window:setTitle', title),
    close: () => ipcRenderer.send('window:close'),
    openInNewWindow: (path) => ipcRenderer.send('window:openFile', path),
  },
  notify: {
    show: (title, body) => ipcRenderer.send('notify:show', { title, body }),
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
  onExternalOpen: (handler) => {
    const listener = (_e: unknown, payload: { path: string; content: string }) =>
      handler(payload);
    ipcRenderer.on('file:externalOpen', listener);
    return () => ipcRenderer.removeListener('file:externalOpen', listener);
  },
  onOpenInTab: (handler) => {
    const listener = (_e: unknown, payload: { path: string; content: string }) =>
      handler(payload);
    ipcRenderer.on('file:openInTab', listener);
    return () => ipcRenderer.removeListener('file:openInTab', listener);
  },
  onVaultChanged: (handler) => {
    const listener = (): void => handler();
    ipcRenderer.on('vault:changed', listener);
    return () => ipcRenderer.removeListener('vault:changed', listener);
  },
  notifyReady: () => ipcRenderer.send('renderer:ready'),
};

contextBridge.exposeInMainWorld('api', api);
