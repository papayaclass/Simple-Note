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
  menuCommands: MenuItemPref[];
}

// Default order + visibility for the right-click menu commands. Kept in sync
// with src/renderer/src/context-menu/commands.ts (main and renderer use
// separate tsconfigs, so the canonical registry can't be imported here).
const DEFAULT_MENU_COMMANDS: MenuCommandPref[] = [
  's2t',
  'half2full',
  'clearFormat',
  'mergeBreaks',
  'lorem',
  'wordCount',
  'pinyin',
  'boshiamy',
  'googleSearch',
  'googleMaps',
  'youtube',
  'cambridge',
].map((key) => ({ key, visible: true }));

const DEFAULTS: Preferences = {
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
  menuCommands: DEFAULT_MENU_COMMANDS,
};

const store = new Store<Preferences>({ name: 'preferences', defaults: DEFAULTS });

export function getPreferences(): Preferences {
  return {
    pageWidth: store.get('pageWidth', DEFAULTS.pageWidth),
    twoColumnPageWidth: store.get('twoColumnPageWidth', DEFAULTS.twoColumnPageWidth),
    lineHeight: store.get('lineHeight', DEFAULTS.lineHeight),
    paragraphSpacing: store.get('paragraphSpacing', DEFAULTS.paragraphSpacing),
    topPadding: store.get('topPadding', DEFAULTS.topPadding),
    exchangeRateApiKey: store.get('exchangeRateApiKey', DEFAULTS.exchangeRateApiKey),
    codeWrap: store.get('codeWrap', DEFAULTS.codeWrap),
    openRouterApiKey: store.get('openRouterApiKey', DEFAULTS.openRouterApiKey),
    openRouterModel: store.get('openRouterModel', DEFAULTS.openRouterModel),
    aiGlobalInstruction: store.get('aiGlobalInstruction', DEFAULTS.aiGlobalInstruction),
    aiSkills: store.get('aiSkills', DEFAULTS.aiSkills),
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
