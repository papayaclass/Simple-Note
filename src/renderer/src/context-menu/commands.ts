// Single source of truth for the built-in right-click menu commands.
// Shared by ContextMenu.tsx (rendering / dispatch) and the preferences panel
// (per-command Toggle + drag-to-reorder). The stored order + visibility lives
// in preferences.menuCommands; this registry maps each key to its label.

export interface MenuCommandDef {
  key: string;
  label: string;
  requiresSelection: boolean;
}

export const MENU_COMMANDS: MenuCommandDef[] = [
  { key: 's2t', label: '簡體轉繁體', requiresSelection: true },
  { key: 'half2full', label: '半形標點轉全形', requiresSelection: true },
  { key: 'clearFormat', label: '清除所有格式', requiresSelection: true },
  { key: 'mergeBreaks', label: '分段符號轉分行符號', requiresSelection: true },
  { key: 'lorem', label: '插入 Lorem Ipsum', requiresSelection: false },
  { key: 'wordCount', label: '字數統計', requiresSelection: true },
  { key: 'pinyin', label: '拼音查詢', requiresSelection: true },
  { key: 'boshiamy', label: '嘸蝦米查碼', requiresSelection: true },
  { key: 'googleSearch', label: '在 Google 搜尋', requiresSelection: true },
  { key: 'googleMaps', label: '在 Google Maps 搜尋', requiresSelection: true },
  { key: 'youtube', label: '在 YouTube 搜尋', requiresSelection: true },
  { key: 'cambridge', label: '查詢劍橋詞典', requiresSelection: true },
];

export interface MenuCommandPref {
  key: string;
  visible: boolean;
  // User-customized display name; falls back to the registry label when unset.
  label?: string;
}

// A user-inserted separator that produces a visual group break in the menu.
export interface MenuDividerPref {
  type: 'divider';
  id: string;
}

// menuCommands holds both commands and dividers interleaved in one ordered list.
export type MenuItemPref = MenuCommandPref | MenuDividerPref;

export const isDivider = (item: MenuItemPref): item is MenuDividerPref =>
  'type' in item && item.type === 'divider';

export const DEFAULT_MENU_COMMANDS: MenuItemPref[] = MENU_COMMANDS.map((c) => ({
  key: c.key,
  visible: true,
}));

// Reconcile stored prefs against the current registry: keep stored order for
// known keys, append any registry keys missing from storage (e.g. newly added
// commands like `pinyin` in older saves) with default visibility, and drop keys
// no longer in the registry. Dividers are kept as-is, in place.
export function reconcileMenuCommands(stored: MenuItemPref[] | undefined): MenuItemPref[] {
  const known = new Set(MENU_COMMANDS.map((c) => c.key));
  const seen = new Set<string>();
  const result: MenuItemPref[] = [];
  for (const item of stored ?? []) {
    if (isDivider(item)) {
      result.push(item);
    } else if (known.has(item.key) && !seen.has(item.key)) {
      result.push({ key: item.key, visible: item.visible !== false, label: item.label });
      seen.add(item.key);
    }
  }
  for (const def of MENU_COMMANDS) {
    if (!seen.has(def.key)) result.push({ key: def.key, visible: true });
  }
  return result;
}
