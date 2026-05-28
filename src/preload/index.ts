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
  file: {
    save: (
      payloads: { sn: string; md: string },
      suggestedName?: string
    ) => Promise<{ ok: boolean; path?: string }>;
    open: () => Promise<{ ok: boolean; path?: string; content?: string }>;
    exportMarkdown: (
      markdown: string,
      suggestedName?: string
    ) => Promise<{ ok: boolean; path?: string }>;
    new: () => Promise<void>;
  };
  window: {
    setDirty: (dirty: boolean) => void;
    setTitle: (title: string) => void;
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
  file: {
    save: (payloads, suggestedName) => ipcRenderer.invoke('file:save', payloads, suggestedName),
    open: () => ipcRenderer.invoke('file:open'),
    exportMarkdown: (md, suggestedName) =>
      ipcRenderer.invoke('file:exportMarkdown', md, suggestedName),
    new: () => ipcRenderer.invoke('file:new'),
  },
  window: {
    setDirty: (dirty) => ipcRenderer.send('window:setDirty', dirty),
    setTitle: (title) => ipcRenderer.send('window:setTitle', title),
  },
  onMenu: (handler) => {
    type Listener = Parameters<typeof ipcRenderer.on>[1];
    const channels: Array<[string, Listener]> = [];
    const wrap = (cmd: string) => {
      const listener: Listener = () => handler(cmd);
      ipcRenderer.on(`menu:${cmd}`, listener);
      channels.push([`menu:${cmd}`, listener]);
    };
    wrap('new');
    wrap('open');
    wrap('save');
    wrap('export-md');
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
