import { contextBridge, ipcRenderer } from 'electron';

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
  };
  window: {
    setDirty: (dirty: boolean) => void;
    setTitle: (title: string) => void;
  };
  notify: {
    show: (title: string, body: string) => void;
  };
  onMenu: (handler: (command: string) => void) => () => void;
  onExternalOpen: (
    handler: (payload: { path: string; content: string }) => void
  ) => () => void;
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
  youtube: {
    preview: (videoId) => ipcRenderer.invoke('youtube:preview', videoId),
  },
  file: {
    save: (markdown, options) => ipcRenderer.invoke('file:save', markdown, options),
  },
  window: {
    setDirty: (dirty) => ipcRenderer.send('window:setDirty', dirty),
    setTitle: (title) => ipcRenderer.send('window:setTitle', title),
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
    // 'new' and 'open' are handled entirely in main now (each spawns its own
    // window), so the renderer no longer listens for them.
    wrap('save');
    wrap('preferences');

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
  notifyReady: () => ipcRenderer.send('renderer:ready'),
};

contextBridge.exposeInMainWorld('api', api);
