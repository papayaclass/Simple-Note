import Store from 'electron-store';

export interface AISkill {
  id: string;
  name: string;
  prompt: string;
}

export interface MenuCommandPref {
  key: string;
  visible: boolean;
  label?: string;
}

export interface MenuDividerPref {
  type: 'divider';
  id: string;
}

export type MenuItemPref = MenuCommandPref | MenuDividerPref;

export type SortMode = 'manual' | 'name' | 'created' | 'modified';
export type StartupBehavior = 'newBlankInVault' | 'lastEdited';
export type BlankFirstLineFormat = 'heading1' | 'heading2' | 'heading3' | 'paragraph';

export interface Preferences {
  vaultPath: string;
  sidebarOpen: boolean;
  sidebarWidth: number;
  sortMode: SortMode;
  sortAsc: boolean;
  // When true, folders form an implicit group above files in the sidebar; the
  // chosen sort (manual or keyed) then only applies within each group.
  foldersOnTop: boolean;
  // Per-folder manual ordering: folder path → ordered array of child paths.
  manualOrder: Record<string, string[]>;
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
  startupBehavior: StartupBehavior;
  blankNoteFirstLineFormat: BlankFirstLineFormat;
  lastEditedFilePath: string;
}

// Default order + visibility for the right-click menu commands. Kept in sync
// with src/renderer/src/context-menu/commands.ts (main and renderer use
// separate tsconfigs, so the canonical registry can't be imported here).
const DEFAULT_MENU_COMMANDS: MenuCommandPref[] = [
  's2t',
  'half2full',
  'clearFormat',
  'stripLinksAndCitations',
  'mergeBreaks',
  'removeParagraphBreaks',
  'lorem',
  'sortYoutube',
  'wordCount',
  'pinyin',
  'boshiamy',
  'googleSearch',
  'googleMaps',
  'youtube',
  'cambridge',
  'speak',
].map((key) => ({ key, visible: true }));

const DEFAULTS: Preferences = {
  vaultPath: '',
  sidebarOpen: true,
  sidebarWidth: 250,
  sortMode: 'manual',
  sortAsc: true,
  foldersOnTop: true,
  manualOrder: {},
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
  startupBehavior: 'newBlankInVault',
  blankNoteFirstLineFormat: 'paragraph',
  lastEditedFilePath: '',
};

const store = new Store<Preferences>({ name: 'preferences', defaults: DEFAULTS });

function normalizeStartupBehavior(value: unknown): StartupBehavior {
  return value === 'lastEdited' ? 'lastEdited' : 'newBlankInVault';
}

export function getPreferences(): Preferences {
  return {
    vaultPath: store.get('vaultPath', DEFAULTS.vaultPath),
    sidebarOpen: store.get('sidebarOpen', DEFAULTS.sidebarOpen),
    sidebarWidth: store.get('sidebarWidth', DEFAULTS.sidebarWidth),
    sortMode: store.get('sortMode', DEFAULTS.sortMode),
    sortAsc: store.get('sortAsc', DEFAULTS.sortAsc),
    foldersOnTop: store.get('foldersOnTop', DEFAULTS.foldersOnTop),
    manualOrder: store.get('manualOrder', DEFAULTS.manualOrder),
    pageWidth: store.get('pageWidth', DEFAULTS.pageWidth),
    twoColumnPageWidth: store.get('twoColumnPageWidth', DEFAULTS.twoColumnPageWidth),
    lineHeight: store.get('lineHeight', DEFAULTS.lineHeight),
    paragraphSpacing: store.get('paragraphSpacing', DEFAULTS.paragraphSpacing),
    topPadding: store.get('topPadding', DEFAULTS.topPadding),
    heading1Scale: store.get('heading1Scale', DEFAULTS.heading1Scale),
    heading2Scale: store.get('heading2Scale', DEFAULTS.heading2Scale),
    heading3Scale: store.get('heading3Scale', DEFAULTS.heading3Scale),
    exchangeRateApiKey: store.get('exchangeRateApiKey', DEFAULTS.exchangeRateApiKey),
    codeWrap: store.get('codeWrap', DEFAULTS.codeWrap),
    openRouterApiKey: store.get('openRouterApiKey', DEFAULTS.openRouterApiKey),
    openRouterModel: store.get('openRouterModel', DEFAULTS.openRouterModel),
    geminiApiKey: store.get('geminiApiKey', DEFAULTS.geminiApiKey),
    geminiTtsModel: store.get('geminiTtsModel', DEFAULTS.geminiTtsModel),
    aiGlobalInstruction: store.get('aiGlobalInstruction', DEFAULTS.aiGlobalInstruction),
    aiSkills: store.get('aiSkills', DEFAULTS.aiSkills),
    menuCommands: store.get('menuCommands', DEFAULTS.menuCommands),
    startupBehavior: normalizeStartupBehavior(
      store.get('startupBehavior', DEFAULTS.startupBehavior)
    ),
    blankNoteFirstLineFormat: store.get(
      'blankNoteFirstLineFormat',
      DEFAULTS.blankNoteFirstLineFormat
    ),
    lastEditedFilePath: store.get('lastEditedFilePath', DEFAULTS.lastEditedFilePath),
  };
}

export function setPreference(key: string, value: unknown): void {
  store.set(key as keyof Preferences, value as never);
}

export function setAllPreferences(prefs: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(prefs)) {
    store.set(k as keyof Preferences, v as never);
  }
}
