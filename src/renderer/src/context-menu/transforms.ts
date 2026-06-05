import * as OpenCC from 'opencc-js';
import { pinyin } from 'pinyin-pro';
import boshiamyData from './boshiamy-data';

const s2tConverter = OpenCC.Converter({ from: 'cn', to: 'twp' });

export function simplifiedToTraditional(text: string): string {
  return s2tConverter(text);
}

// Convert Chinese characters to Hanyu Pinyin without tone marks. Syllables are
// space-separated; non-Chinese characters are kept as-is (nonZh: 'consecutive'
// groups runs of non-Chinese text into single segments rather than per-char).
export function toPinyin(text: string): string {
  const segments = pinyin(text, {
    toneType: 'none',
    type: 'array',
    nonZh: 'consecutive',
  });
  return segments.join(' ').replace(/\s+/g, ' ').trim();
}

// --- 嘸蝦米查碼 (offline) -------------------------------------------------
// boshiamy-data.json is a faithful copy of the "繁體完整碼" table from
// boshiamy.then.tw: char -> { CODE(uppercase): weight }. The weight encodes
// flags in its ones digit (bitmask) and a display order group in the rest:
//   weight % 10 : bit 1 = 最短碼, bit 2 = 推薦碼(建議), bit 4 = V/重複字根變體
//   Math.trunc(weight / 10) : 顯示排序群組 (smaller shown first)
const BOSHIAMY = boshiamyData as Record<string, Record<string, number>>;

interface RankedCode {
  code: string; // lowercased
  order: number;
  recommended: boolean;
  shortest: boolean;
}

export interface BoshiamyEntry {
  char: string;
  primary: string | null; // 主要(推薦)碼，查無此字時為 null
  alternatives: string[]; // 其餘備選碼
}

// Sort by display order group, then by code length, then alphabetically — a
// stable "most canonical first" ordering used both for picking the primary and
// for ordering the alternatives.
function byCanonical(a: RankedCode, b: RankedCode): number {
  return a.order - b.order || a.code.length - b.code.length || (a.code < b.code ? -1 : 1);
}

function lookupBoshiamy(char: string): BoshiamyEntry {
  const codes = BOSHIAMY[char];
  if (!codes) return { char, primary: null, alternatives: [] };
  const ranked: RankedCode[] = Object.entries(codes).map(([code, weight]) => ({
    code: code.toLowerCase(),
    order: Math.trunc(weight / 10),
    recommended: (weight % 10 & 2) !== 0,
    shortest: (weight % 10 & 1) !== 0,
  }));
  // Primary = 推薦碼 if any, else 最短碼, else most canonical overall.
  const recommended = ranked.filter((r) => r.recommended);
  const shortest = ranked.filter((r) => r.shortest);
  const pool = recommended.length ? recommended : shortest.length ? shortest : ranked;
  const primary = [...pool].sort(byCanonical)[0].code;
  const alternatives = ranked
    .filter((r) => r.code !== primary)
    .sort(byCanonical)
    .map((r) => r.code);
  return { char, primary, alternatives };
}

// Look up each character of the selection (skipping whitespace). Surrogate
// pairs are handled by iterating with the string iterator. Characters with no
// entry come back with primary = null so the UI can show 「查無此碼」.
export function toBoshiamy(text: string): BoshiamyEntry[] {
  return [...text].filter((ch) => !/\s/.test(ch)).map((ch) => lookupBoshiamy(ch));
}

const HALF_TO_FULL: Record<string, string> = {
  ',': '，',
  '.': '。',
  ':': '：',
  ';': '；',
  '!': '！',
  '?': '？',
  '(': '（',
  ')': '）',
  '[': '【',
  ']': '】',
  '<': '〈',
  '>': '〉',
  '"': '＂',
  "'": '＇',
  '~': '～',
  '@': '＠',
  '#': '＃',
  '$': '＄',
  '%': '％',
  '&': '＆',
  '*': '＊',
};

export function halfToFullPunctuation(text: string): string {
  return text.replace(/[,.:;!?()[\]<>"'~@#$%&*]/g, (m) => HALF_TO_FULL[m] ?? m);
}

// ~100 words of standard Lorem Ipsum
export const LOREM_IPSUM =
  'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ' +
  'ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco ' +
  'laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in ' +
  'voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat ' +
  'non proident, sunt in culpa qui officia deserunt mollit anim id est laborum. Sed ut perspiciatis ' +
  'unde omnis iste natus error sit voluptatem accusantium doloremque laudantium, totam rem aperiam, ' +
  'eaque ipsa quae ab illo inventore veritatis et quasi architecto beatae vitae dicta sunt explicabo.';

export interface WordCount {
  chars: number; // 全部字元 (含空白)
  charsNoSpace: number; // 不含空白
  chinese: number; // CJK 字數
  words: number; // 英文 word 數
}

export function wordCount(text: string): WordCount {
  const chars = [...text].length;
  const charsNoSpace = [...text.replace(/\s+/g, '')].length;
  const chineseMatches = text.match(/[一-鿿㐀-䶿]/g);
  const chinese = chineseMatches?.length ?? 0;
  // count English words by stripping CJK + splitting whitespace
  const ascii = text.replace(/[一-鿿㐀-䶿]/g, ' ').trim();
  const words = ascii.length === 0 ? 0 : ascii.split(/\s+/).length;
  return { chars, charsNoSpace, chinese, words };
}
