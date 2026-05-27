import * as OpenCC from 'opencc-js';

const s2tConverter = OpenCC.Converter({ from: 'cn', to: 'twp' });

export function simplifiedToTraditional(text: string): string {
  return s2tConverter(text);
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
