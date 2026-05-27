import { create } from 'zustand';

export interface Preferences {
  pageWidth: number;
  lineHeight: number;
  paragraphSpacing: number;
  topPadding: number;
  exchangeRateApiKey: string;
}

export const DEFAULT_PREFS: Preferences = {
  pageWidth: 720,
  lineHeight: 1.6,
  paragraphSpacing: 8,
  topPadding: 96,
  exchangeRateApiKey: '',
};

interface AppState {
  dirty: boolean;
  filePath: string | null;
  fileName: string;
  mathMode: boolean;
  preferences: Preferences;
  prefsPanelOpen: boolean;
  contextMenuOpen: boolean;
  wordCountPopover: { count: number; chars: number; charsNoSpace: number; chinese: number } | null;
  setDirty: (dirty: boolean) => void;
  setFile: (path: string | null) => void;
  toggleMathMode: () => void;
  setMathMode: (on: boolean) => void;
  setPreferences: (p: Partial<Preferences>) => void;
  setPrefsPanelOpen: (open: boolean) => void;
  setWordCountPopover: (v: AppState['wordCountPopover']) => void;
}

export const useStore = create<AppState>((set) => ({
  dirty: false,
  filePath: null,
  fileName: '未命名筆記',
  mathMode: false,
  preferences: DEFAULT_PREFS,
  prefsPanelOpen: false,
  contextMenuOpen: false,
  wordCountPopover: null,
  setDirty: (dirty) => set({ dirty }),
  setFile: (path) =>
    set({
      filePath: path,
      fileName: path ? path.split('/').pop()!.replace(/\.sn$/, '') : '未命名筆記',
      dirty: false,
    }),
  toggleMathMode: () => set((s) => ({ mathMode: !s.mathMode })),
  setMathMode: (on) => set({ mathMode: on }),
  setPreferences: (p) => set((s) => ({ preferences: { ...s.preferences, ...p } })),
  setPrefsPanelOpen: (open) => set({ prefsPanelOpen: open }),
  setWordCountPopover: (v) => set({ wordCountPopover: v }),
}));
