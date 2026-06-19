import { create } from 'zustand';
import { DEFAULT_MENU_COMMANDS, MenuItemPref } from './context-menu/commands';

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
  heading1Scale: number;
  heading2Scale: number;
  heading3Scale: number;
  exchangeRateApiKey: string;
  codeWrap: boolean;
  openRouterApiKey: string;
  openRouterModel: string;
  geminiApiKey: string;
  geminiTtsModel: string;
  aiGlobalInstruction: string;
  aiSkills: AISkill[];
  menuCommands: MenuItemPref[];
}

export const DEFAULT_PREFS: Preferences = {
  pageWidth: 720,
  twoColumnPageWidth: 1080,
  lineHeight: 1.6,
  paragraphSpacing: 8,
  topPadding: 96,
  heading1Scale: 2,
  heading2Scale: 1.5,
  heading3Scale: 1.2,
  exchangeRateApiKey: '',
  codeWrap: false,
  openRouterApiKey: '',
  openRouterModel: '',
  geminiApiKey: '',
  geminiTtsModel: 'gemini-3.1-flash-tts-preview',
  aiGlobalInstruction: '',
  aiSkills: [],
  menuCommands: DEFAULT_MENU_COMMANDS,
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
      fileName: path ? path.split('/').pop()!.replace(/\.md$/, '') : '未命名筆記',
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
