import { create } from 'zustand';

export interface AISkill {
  id: string;
  name: string;
  prompt: string;
}

export interface Preferences {
  pageWidth: number;
  twoColumnPageWidth: number;
  lineHeight: number;
  paragraphSpacing: number;
  topPadding: number;
  exchangeRateApiKey: string;
  codeWrap: boolean;
  openRouterApiKey: string;
  openRouterModel: string;
  aiGlobalInstruction: string;
  aiSkills: AISkill[];
}

export const DEFAULT_PREFS: Preferences = {
  pageWidth: 720,
  twoColumnPageWidth: 1080,
  lineHeight: 1.6,
  paragraphSpacing: 8,
  topPadding: 96,
  exchangeRateApiKey: '',
  codeWrap: false,
  openRouterApiKey: '',
  openRouterModel: '',
  aiGlobalInstruction: '',
  aiSkills: [],
};

interface AppState {
  dirty: boolean;
  filePath: string | null;
  fileName: string;
  mathMode: boolean;
  twoColumn: boolean;
  timer: { endsAt: number } | null;
  alarms: Array<{ id: string; at: number }>;
  preferences: Preferences;
  prefsPanelOpen: boolean;
  contextMenuOpen: boolean;
  wordCountPopover: { count: number; chars: number; charsNoSpace: number; chinese: number } | null;
  setDirty: (dirty: boolean) => void;
  setFile: (path: string | null) => void;
  toggleMathMode: () => void;
  setMathMode: (on: boolean) => void;
  setTimer: (t: { endsAt: number } | null) => void;
  addAlarm: (at: number) => void;
  removeAlarm: (id: string) => void;
  setTwoColumn: (on: boolean) => void;
  toggleTwoColumn: () => void;
  setPreferences: (p: Partial<Preferences>) => void;
  setPrefsPanelOpen: (open: boolean) => void;
  setWordCountPopover: (v: AppState['wordCountPopover']) => void;
}

export const useStore = create<AppState>((set) => ({
  dirty: false,
  filePath: null,
  fileName: '未命名筆記',
  mathMode: false,
  twoColumn: false,
  timer: null,
  alarms: [],
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
  setTimer: (t) => set({ timer: t }),
  addAlarm: (at) =>
    set((s) => ({
      alarms: [...s.alarms, { id: `${at}-${Math.random().toString(36).slice(2, 8)}`, at }].sort(
        (a, b) => a.at - b.at
      ),
    })),
  removeAlarm: (id) => set((s) => ({ alarms: s.alarms.filter((a) => a.id !== id) })),
  setTwoColumn: (on) => set({ twoColumn: on }),
  toggleTwoColumn: () => set((s) => ({ twoColumn: !s.twoColumn })),
  setPreferences: (p) => set((s) => ({ preferences: { ...s.preferences, ...p } })),
  setPrefsPanelOpen: (open) => set({ prefsPanelOpen: open }),
  setWordCountPopover: (v) => set({ wordCountPopover: v }),
}));
