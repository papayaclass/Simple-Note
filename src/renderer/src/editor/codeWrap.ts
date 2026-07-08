import type { Node as ProseMirrorNode } from 'prosemirror-model';
import { Plugin, PluginKey } from 'prosemirror-state';
import { Decoration, DecorationSet, EditorView } from 'prosemirror-view';

const KEY = new PluginKey('simple-note-code-wrap');

type CodeLanguage = {
  id: string;
  label: string;
  aliases?: string[];
};

const CODE_LANGUAGES: CodeLanguage[] = [
  { id: 'text', label: 'Plain Text', aliases: ['plain', 'plaintext', 'none'] },
  { id: 'javascript', label: 'JavaScript', aliases: ['js'] },
  { id: 'jsx', label: 'JSX' },
  { id: 'typescript', label: 'TypeScript', aliases: ['ts'] },
  { id: 'tsx', label: 'TSX' },
  { id: 'python', label: 'Python', aliases: ['py'] },
  { id: 'markdown', label: 'Markdown', aliases: ['md'] },
  { id: 'html', label: 'HTML' },
  { id: 'css', label: 'CSS' },
  { id: 'json', label: 'JSON' },
  { id: 'bash', label: 'Bash', aliases: ['sh', 'zsh'] },
  { id: 'yaml', label: 'YAML', aliases: ['yml'] },
  { id: 'sql', label: 'SQL' },
  { id: 'swift', label: 'Swift' },
  { id: 'go', label: 'Go' },
  { id: 'rust', label: 'Rust' },
  { id: 'java', label: 'Java' },
  { id: 'c', label: 'C' },
  { id: 'cpp', label: 'C++', aliases: ['c++'] },
  { id: 'csharp', label: 'C#', aliases: ['c#'] },
  { id: 'php', label: 'PHP' },
  { id: 'ruby', label: 'Ruby' },
  { id: 'kotlin', label: 'Kotlin' },
  { id: 'diff', label: 'Diff' },
  { id: 'xml', label: 'XML' },
];

const LANGUAGE_IDS = new Set(CODE_LANGUAGES.map((language) => language.id));
const LANGUAGE_ALIASES = new Map<string, string>();

for (const language of CODE_LANGUAGES) {
  LANGUAGE_ALIASES.set(language.id, language.id);
  for (const alias of language.aliases ?? []) {
    LANGUAGE_ALIASES.set(alias, language.id);
  }
}

// Lucide "wrap-text" icon.
const WRAP_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<line x1="3" y1="6" x2="21" y2="6"/>' +
  '<path d="M3 12h15a3 3 0 1 1 0 6h-4"/>' +
  '<polyline points="16 16 14 18 16 20"/>' +
  '<line x1="3" y1="18" x2="10" y2="18"/></svg>';

const COPY_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<rect x="8" y="8" width="12" height="12" rx="2"/>' +
  '<path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>';

const CHECK_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M20 6 9 17l-5-5"/></svg>';

const CHEVRON_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="m6 9 6 6 6-6"/></svg>';

function normalizeLanguage(language: unknown): string {
  const normalized = typeof language === 'string' ? language.trim().toLowerCase() : '';
  if (!normalized) return 'text';
  return LANGUAGE_ALIASES.get(normalized) ?? (LANGUAGE_IDS.has(normalized) ? normalized : 'text');
}

function textHash(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) | 0;
  }
  return `${text.length}-${hash}`;
}

function buttonBase(className: string, title: string, label: string, icon: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = className;
  btn.contentEditable = 'false';
  btn.title = title;
  btn.setAttribute('aria-label', label);
  btn.innerHTML = icon;
  return btn;
}

function setCodeBlockLanguage(view: EditorView, pos: number, language: string): void {
  const node = view.state.doc.nodeAt(pos);
  if (!node || node.type.name !== 'codeBlock') return;
  view.dispatch(
    view.state.tr.setNodeMarkup(pos, undefined, {
      ...node.attrs,
      language,
    })
  );
  requestAnimationFrame(() => view.focus());
}

function buildLanguageSelect(
  language: string,
  onLanguageChange: (language: string) => void
): HTMLElement {
  const wrap = document.createElement('span');
  wrap.className = 'code-block-language';

  const select = document.createElement('select');
  select.className = 'code-block-language-select';
  select.setAttribute('aria-label', '選擇程式碼類型');

  for (const optionInfo of CODE_LANGUAGES) {
    const option = document.createElement('option');
    option.value = optionInfo.id;
    option.textContent = optionInfo.label;
    select.appendChild(option);
  }
  select.value = language;

  select.addEventListener('mousedown', (e) => e.stopPropagation());
  select.addEventListener('click', (e) => e.stopPropagation());
  select.addEventListener('change', (e) => {
    e.stopPropagation();
    onLanguageChange((e.target as HTMLSelectElement).value);
  });

  const chevron = document.createElement('span');
  chevron.className = 'code-block-language-chevron';
  chevron.innerHTML = CHEVRON_ICON;

  wrap.append(select, chevron);
  return wrap;
}

function buildCopyButton(text: string): HTMLButtonElement {
  const btn = buttonBase('code-block-copy', '複製', '複製程式碼', COPY_ICON);
  btn.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    window.api.clipboard.writeText(text);
    btn.classList.add('copied');
    btn.title = '已複製';
    btn.innerHTML = CHECK_ICON;
    window.setTimeout(() => {
      btn.classList.remove('copied');
      btn.title = '複製';
      btn.innerHTML = COPY_ICON;
    }, 1200);
  });
  return btn;
}

function buildWrapButton(active: boolean, toggle: () => void): HTMLButtonElement {
  const btn = buttonBase(
    'code-block-wrap' + (active ? ' active' : ''),
    active ? '取消自動換行' : '自動換行',
    '切換程式碼自動換行',
    WRAP_ICON
  );
  btn.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggle();
  });
  return btn;
}

function buildToolbar(
  view: EditorView,
  pos: number,
  node: ProseMirrorNode,
  wrapped: boolean,
  toggleWrap: () => void
): HTMLElement {
  const toolbar = document.createElement('div');
  toolbar.className = 'code-block-toolbar';
  toolbar.contentEditable = 'false';
  toolbar.addEventListener('mousedown', (e) => e.stopPropagation());
  toolbar.addEventListener('click', (e) => e.stopPropagation());

  const divider = document.createElement('span');
  divider.className = 'code-block-toolbar-divider';

  toolbar.append(
    buildLanguageSelect(normalizeLanguage(node.attrs.language), (language) =>
      setCodeBlockLanguage(view, pos, language)
    ),
    divider,
    buildCopyButton(node.textContent),
    buildWrapButton(wrapped, toggleWrap)
  );

  return toolbar;
}

// Renders a Notion-style tool strip in the top-right corner of every code block.
// The language select updates the code block's `language` attr, while the wrap
// toggle still drives the app's existing global code-wrap preference.
export function createCodeWrapPlugin(getWrap: () => boolean, toggleWrap: () => void): Plugin {
  return new Plugin({
    key: KEY,
    props: {
      decorations(state) {
        const wrapped = getWrap();
        const decos: Decoration[] = [];
        state.doc.descendants((node, pos) => {
          if (node.type.name !== 'codeBlock') return true;
          decos.push(
            Decoration.widget(
              pos + 1,
              (view) => buildToolbar(view, pos, node, wrapped, toggleWrap),
              {
                side: -1,
                key: `code-tools-${pos}-${normalizeLanguage(node.attrs.language)}-${
                  wrapped ? 'on' : 'off'
                }-${textHash(node.textContent)}`,
                ignoreSelection: true,
              }
            )
          );
          // Don't walk into the code block's text.
          return false;
        });
        return DecorationSet.create(state.doc, decos);
      },
    },
  });
}
