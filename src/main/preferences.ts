import Store from 'electron-store';

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

export interface Preferences {
  pageWidth: number;
  lineHeight: number;
  paragraphSpacing: number;
  listMarkerGap: number;
  topPadding: number;
  heading1Scale: number;
  heading2Scale: number;
  heading3Scale: number;
  codeWrap: boolean;
  openRouterApiKey: string;
  openRouterModel: string;
  aiGlobalInstruction: string;
  menuCommands: MenuItemPref[];
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
  'wordCount',
  'pinyin',
  'boshiamy',
  'googleSearch',
  'translate',
].map((key) => ({ key, visible: true }));

const DEFAULTS: Preferences = {
  pageWidth: 720,
  lineHeight: 1.6,
  paragraphSpacing: 8,
  listMarkerGap: 4,
  topPadding: 96,
  heading1Scale: 2,
  heading2Scale: 1.5,
  heading3Scale: 1.2,
  codeWrap: false,
  openRouterApiKey: '',
  openRouterModel: '',
  aiGlobalInstruction: '',
  menuCommands: DEFAULT_MENU_COMMANDS,
};

const store = new Store<Preferences>({ name: 'preferences', defaults: DEFAULTS });

export function getPreferences(): Preferences {
  return {
    pageWidth: store.get('pageWidth', DEFAULTS.pageWidth),
    lineHeight: store.get('lineHeight', DEFAULTS.lineHeight),
    paragraphSpacing: store.get('paragraphSpacing', DEFAULTS.paragraphSpacing),
    listMarkerGap: store.get('listMarkerGap', DEFAULTS.listMarkerGap),
    topPadding: store.get('topPadding', DEFAULTS.topPadding),
    heading1Scale: store.get('heading1Scale', DEFAULTS.heading1Scale),
    heading2Scale: store.get('heading2Scale', DEFAULTS.heading2Scale),
    heading3Scale: store.get('heading3Scale', DEFAULTS.heading3Scale),
    codeWrap: store.get('codeWrap', DEFAULTS.codeWrap),
    openRouterApiKey: store.get('openRouterApiKey', DEFAULTS.openRouterApiKey),
    openRouterModel: store.get('openRouterModel', DEFAULTS.openRouterModel),
    aiGlobalInstruction: store.get('aiGlobalInstruction', DEFAULTS.aiGlobalInstruction),
    menuCommands: store.get('menuCommands', DEFAULTS.menuCommands),
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
