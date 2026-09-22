import { clipboard, contextBridge, ipcRenderer, webUtils } from 'electron';

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

// Both serializations of the current document; main writes whichever matches
// the target file's extension.
export interface NoteContents {
  markdown: string;
  snote: string;
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
    confirmLossy: (
      kind: 'convert' | 'export',
      name: string,
      features: string[],
      doc?: 'note' | 'sheet'
    ) => Promise<boolean>;
    saveImage: (dataUrl: string) => Promise<{ ok: boolean; path?: string }>;
    getPathForFile: (file: File) => string;
  };
  vault: {
    pick: () => Promise<string | null>;
    get: () => Promise<string | null>;
    clear: () => Promise<void>;
    list: () => Promise<VaultNode[]>;
    read: (path: string) => Promise<{ ok: boolean; content?: string }>;
    createFile: (
      dir?: string | null,
      kind?: 'note' | 'sheet'
    ) => Promise<{ ok: boolean; path?: string }>;
    createBlankNote: () => Promise<{ ok: boolean; path?: string }>;
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
      contents: NoteContents,
      suggestedName?: string
    ) => Promise<{ ok: boolean; path?: string }>;
    importExternal: (
      paths: string[],
      destDir: string | null
    ) => Promise<{ ok: boolean; moved: string[] }>;
    saveImageForNote: (args: {
      notePath: string | null;
      sourcePath?: string;
      dataUrl?: string;
    }) => Promise<{ ok: boolean; persistSrc?: string; absPath?: string; memoryOnly?: boolean }>;
    readImageAsDataUrl: (
      noteDir: string | null,
      src: string
    ) => Promise<{ ok: boolean; dataUrl?: string }>;
    openSelf: () => Promise<void>;
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
    confirmLossy: (kind, name, features, doc) =>
      ipcRenderer.invoke('file:confirmLossy', kind, name, features, doc),
    saveImage: (dataUrl) => ipcRenderer.invoke('file:saveImage', dataUrl),
    getPathForFile: (file) => webUtils.getPathForFile(file),
  },
  vault: {
    pick: () => ipcRenderer.invoke('vault:pick'),
    get: () => ipcRenderer.invoke('vault:get'),
    clear: () => ipcRenderer.invoke('vault:clear'),
    list: () => ipcRenderer.invoke('vault:list'),
    read: (path) => ipcRenderer.invoke('vault:read', path),
    createFile: (dir, kind) => ipcRenderer.invoke('vault:createFile', dir, kind),
    createBlankNote: () => ipcRenderer.invoke('vault:createBlankNote'),
    createFolder: (dir) => ipcRenderer.invoke('vault:createFolder', dir),
    rename: (path, newName) => ipcRenderer.invoke('vault:rename', path, newName),
    delete: (path) => ipcRenderer.invoke('vault:delete', path),
    duplicate: (path) => ipcRenderer.invoke('vault:duplicate', path),
    move: (src, destDir) => ipcRenderer.invoke('vault:move', src, destDir),
    reveal: (path) => ipcRenderer.invoke('vault:reveal', path),
    moveToVault: (contents, suggestedName) =>
      ipcRenderer.invoke('vault:moveToVault', contents, suggestedName),
    importExternal: (paths, destDir) =>
      ipcRenderer.invoke('vault:importExternal', paths, destDir),
    saveImageForNote: (args) => ipcRenderer.invoke('vault:saveImageForNote', args),
    readImageAsDataUrl: (noteDir, src) =>
      ipcRenderer.invoke('vault:readImageAsDataUrl', noteDir, src),
    openSelf: () => ipcRenderer.invoke('vault:openSelf'),
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
