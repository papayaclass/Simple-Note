import Store from 'electron-store';

export interface Preferences {
  pageWidth: number;
  lineHeight: number;
  paragraphSpacing: number;
  topPadding: number;
  exchangeRateApiKey: string;
}

const DEFAULTS: Preferences = {
  pageWidth: 720,
  lineHeight: 1.6,
  paragraphSpacing: 8,
  topPadding: 96,
  exchangeRateApiKey: '',
};

const store = new Store<Preferences>({ name: 'preferences', defaults: DEFAULTS });

export function getPreferences(): Preferences {
  return {
    pageWidth: store.get('pageWidth', DEFAULTS.pageWidth),
    lineHeight: store.get('lineHeight', DEFAULTS.lineHeight),
    paragraphSpacing: store.get('paragraphSpacing', DEFAULTS.paragraphSpacing),
    topPadding: store.get('topPadding', DEFAULTS.topPadding),
    exchangeRateApiKey: store.get('exchangeRateApiKey', DEFAULTS.exchangeRateApiKey),
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
