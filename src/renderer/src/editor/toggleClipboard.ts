// Toggle List 跨 App 剪貼簿：Simple Note、Simple Canvas 與 Notion 之間互相貼上。
//
// 這個檔案在 Simple Note 與 Simple Canvas 各有一份，內容相同，改了要兩邊同步。
//
// 三方的共同語言：
// - Simple Note ↔ Simple Canvas：標準 HTML 的 <details><summary>標題</summary>子內容</details>。
// - Notion 的 text/html 把 Toggle 輸出成一般的 <ul><li>，跟項目符號分不出來，也不認得
//   <details>。Toggle 的資訊只存在 Notion 私有的 text/_notion-blocks-v3-production
//   (區塊樹的 JSON)，而 Notion 也接受外部寫入的這個格式 (2026-10 實測)。
//   所以從 Notion 貼上時讀 JSON 轉成 <details>；複製時若含 Toggle，就另外寫一份 JSON 給 Notion。

export const NOTION_MIME = 'text/_notion-blocks-v3-production';

export const hasDetails = (html: string | null | undefined): boolean =>
  !!html && /<details[\s>]/i.test(html);

type Seg = [string, unknown[][]?];

interface NotionBlock {
  id: string;
  type: string;
  version?: number;
  alive?: boolean;
  properties?: { title?: Seg[]; checked?: string[][]; language?: string[][] };
  content?: string[];
  format?: { toggleable?: boolean };
}

// ---------- Notion JSON → HTML ----------

const escapeHTML = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function richTextToHTML(title: Seg[] | undefined): string {
  return (title ?? [])
    .map(([text, marks = []]) => {
      let html = escapeHTML(text).replace(/\n/g, '<br>');
      for (const [mark, value] of marks as [string, unknown][]) {
        if (mark === 'c') html = `<code>${html}</code>`;
        else if (mark === 'b') html = `<strong>${html}</strong>`;
        else if (mark === 'i') html = `<em>${html}</em>`;
        else if (mark === '_') html = `<u>${html}</u>`;
        else if (mark === 's') html = `<s>${html}</s>`;
        else if (mark === 'a') html = `<a href="${escapeHTML(String(value))}">${html}</a>`;
      }
      return html;
    })
    .join('');
}

const plainText = (title: Seg[] | undefined): string => (title ?? []).map(([t]) => t).join('');

const isNotionToggle = (b: NotionBlock): boolean =>
  b.type === 'toggle' || (/header$/.test(b.type) && !!b.format?.toggleable);

// 回傳含 <details> 的 HTML；剪貼簿裡沒有 Toggle 時回傳 null，交給原本的貼上流程。
export function notionToHTML(json: string | null | undefined): string | null {
  if (!json) return null;
  let data: { blocks?: { blockId: string; blockSubtree?: { block?: Record<string, any> } }[] };
  try {
    data = JSON.parse(json);
  } catch {
    return null;
  }
  const records: Record<string, NotionBlock> = {};
  const roots: string[] = [];
  for (const entry of data.blocks ?? []) {
    roots.push(entry.blockId);
    for (const [id, rec] of Object.entries(entry.blockSubtree?.block ?? {})) {
      const value = rec?.value?.value ?? rec?.value;
      if (value) records[id] = value;
    }
  }
  if (!Object.values(records).some(isNotionToggle)) return null;

  const render = (ids: string[] = []): string => {
    let html = '';
    let openList = '';
    const closeList = (): void => {
      if (openList) html += `</${openList === 'ol' ? 'ol' : 'ul'}>`;
      openList = '';
    };
    for (const id of ids) {
      const b = records[id];
      if (!b || b.alive === false) continue;
      const title = richTextToHTML(b.properties?.title);
      const children = render(b.content);
      const listKind =
        b.type === 'bulleted_list' ? 'ul' : b.type === 'numbered_list' ? 'ol' : b.type === 'to_do' ? 'todo' : '';
      if (listKind !== openList) {
        closeList();
        if (listKind) html += listKind === 'ol' ? '<ol>' : listKind === 'todo' ? '<ul data-type="taskList">' : '<ul>';
        openList = listKind;
      }
      if (listKind === 'todo') {
        const checked = b.properties?.checked?.[0]?.[0] === 'Yes';
        html += `<li data-type="taskItem" data-checked="${checked}"><input type="checkbox"${checked ? ' checked' : ''}><p>${title}</p>${children}</li>`;
      } else if (listKind) {
        html += `<li><p>${title}</p>${children}</li>`;
      } else if (isNotionToggle(b)) {
        // 空的 Toggle 也放一個段落：Simple Canvas 的 toggleItem 必須有內容區
        html += `<details open><summary>${title}</summary>${children || '<p></p>'}</details>`;
      } else if (b.type === 'header' || b.type === 'sub_header' || b.type === 'sub_sub_header') {
        const level = b.type === 'header' ? 1 : b.type === 'sub_header' ? 2 : 3;
        html += `<h${level}>${title}</h${level}>${children}`;
      } else if (b.type === 'quote' || b.type === 'callout') {
        html += `<blockquote><p>${title}</p></blockquote>${children}`;
      } else if (b.type === 'code') {
        const lang = (b.properties?.language?.[0]?.[0] ?? '').toLowerCase().replace(/\s+/g, '');
        html += `<pre><code class="language-${escapeHTML(lang)}">${escapeHTML(plainText(b.properties?.title))}</code></pre>`;
      } else if (b.type === 'divider') {
        html += '<hr>';
      } else if (b.type === 'text' || title) {
        html += `<p>${title}</p>${children}`;
      } else {
        html += children;
      }
    }
    closeList();
    return html;
  };
  return render(roots);
}

// ---------- HTML → Notion JSON ----------

const BLOCK_TAGS = new Set([
  'P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'DETAILS', 'SUMMARY',
  'PRE', 'BLOCKQUOTE', 'HR', 'TABLE', 'FIGURE', 'SECTION', 'ARTICLE', 'LABEL', 'IMG',
]);
const SKIP_TAGS = new Set(['META', 'STYLE', 'SCRIPT', 'INPUT', 'IMG', 'BUTTON', 'svg']);
const isBlockNode = (n: Node): boolean => n instanceof Element && BLOCK_TAGS.has(n.tagName);

function richTextFromNodes(nodes: Node[]): Seg[] {
  const segs: Seg[] = [];
  const push = (text: string, marks: unknown[][]): void => {
    if (!text) return;
    const last = segs[segs.length - 1];
    const key = JSON.stringify(marks);
    if (last && JSON.stringify(last[1] ?? []) === key) last[0] += text;
    else segs.push(marks.length ? [text, marks] : [text]);
  };
  const walk = (node: Node, marks: unknown[][]): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      push((node.textContent ?? '').replace(/[\t\n\r ]+/g, ' '), marks);
      return;
    }
    if (!(node instanceof Element) || SKIP_TAGS.has(node.tagName)) return;
    if (node.tagName === 'BR') return push('\n', marks);
    const next = [...marks];
    const add = (m: unknown[]): void => {
      if (!next.some((x) => x[0] === m[0])) next.push(m);
    };
    const tag = node.tagName;
    const style = (node.getAttribute('style') ?? '').toLowerCase();
    if (tag === 'STRONG' || tag === 'B' || /font-weight:\s*(bold|[6-9]00)/.test(style)) add(['b']);
    if (tag === 'EM' || tag === 'I' || /font-style:\s*italic/.test(style)) add(['i']);
    if (tag === 'U' || /underline/.test(style)) add(['_']);
    if (tag === 'S' || tag === 'DEL' || tag === 'STRIKE' || /line-through/.test(style)) add(['s']);
    if (tag === 'CODE') add(['c']);
    if (tag === 'A' && node.getAttribute('href')) add(['a', node.getAttribute('href')]);
    if (/(^|;)\s*color:[^;]*red/.test(style)) add(['h', 'red']);
    node.childNodes.forEach((c) => walk(c, next));
  };
  nodes.forEach((n) => walk(n, []));
  if (segs.length) {
    segs[0][0] = segs[0][0].replace(/^ +/, '');
    const last = segs[segs.length - 1];
    last[0] = last[0].replace(/ +$/, '');
  }
  return segs.filter(([t]) => t !== '');
}

// 把 li / details 的子節點拆成「標題」與「子區塊」。div、label 這類包裝層 (Simple Canvas
// 的 task item 會用) 直接攤平。
function splitTitle(nodes: Node[]): { title: Node[]; children: Node[] } {
  const title: Node[] = [];
  const children: Node[] = [];
  let titleDone = false;
  const visit = (n: Node): void => {
    if (n instanceof Element && (n.tagName === 'DIV' || n.tagName === 'LABEL') && !n.hasAttribute('data-type')) {
      n.childNodes.forEach(visit);
      return;
    }
    if (titleDone) return void children.push(n);
    if (n instanceof Element && n.tagName === 'P') {
      title.push(...Array.from(n.childNodes));
      titleDone = true;
    } else if (isBlockNode(n)) {
      titleDone = true;
      children.push(n);
    } else {
      title.push(n);
    }
  };
  nodes.forEach(visit);
  return { title, children };
}

const NOTION_LANGS: Record<string, string> = {
  js: 'JavaScript', javascript: 'JavaScript', ts: 'TypeScript', typescript: 'TypeScript',
  py: 'Python', python: 'Python', html: 'HTML', css: 'CSS', json: 'JSON', bash: 'Bash',
  sh: 'Shell', shell: 'Shell', swift: 'Swift', java: 'Java', c: 'C', cpp: 'C++', go: 'Go',
  rust: 'Rust', ruby: 'Ruby', php: 'PHP', sql: 'SQL', markdown: 'Markdown', yaml: 'YAML',
};

// 回傳 Notion 剪貼簿 JSON；HTML 裡沒有 <details> 時回傳 null (Notion 自己解析 HTML 就夠了)。
export function htmlToNotion(html: string | null | undefined): string | null {
  if (!hasDetails(html)) return null;
  const doc = new DOMParser().parseFromString(html!, 'text/html');
  const records: Record<string, NotionBlock> = {};

  const make = (type: string, title: Seg[], children: Node[] = [], extra: Partial<NotionBlock> = {}): string => {
    const id = crypto.randomUUID();
    const content = convert(children);
    records[id] = {
      id,
      type,
      version: 1,
      alive: true,
      ...(title.length || extra.properties ? { properties: { ...(title.length ? { title } : {}), ...extra.properties } } : {}),
      ...(content.length ? { content } : {}),
      ...(extra.format ? { format: extra.format } : {}),
    };
    return id;
  };

  function convert(nodes: Node[]): string[] {
    const ids: string[] = [];
    let inline: Node[] = [];
    const flushInline = (): void => {
      const title = richTextFromNodes(inline);
      if (title.length) ids.push(make('text', title));
      inline = [];
    };
    for (const n of nodes) {
      if (!(n instanceof Element) || !BLOCK_TAGS.has(n.tagName)) {
        inline.push(n);
        continue;
      }
      flushInline();
      const tag = n.tagName;
      const kids = Array.from(n.childNodes);
      if (tag === 'DETAILS') {
        const summary = kids.find((k) => k instanceof Element && k.tagName === 'SUMMARY');
        ids.push(make('toggle', richTextFromNodes(summary ? Array.from(summary.childNodes) : []), kids.filter((k) => k !== summary)));
      } else if (tag === 'UL' || tag === 'OL') {
        for (const li of kids) {
          if (!(li instanceof Element) || li.tagName !== 'LI') continue;
          const box = li.querySelector('input[type=checkbox]') as HTMLInputElement | null;
          const isTask = li.getAttribute('data-type') === 'taskItem' || !!box;
          const { title, children } = splitTitle(Array.from(li.childNodes));
          if (isTask) {
            const checked = li.getAttribute('data-checked') === 'true' || !!box?.hasAttribute('checked');
            ids.push(make('to_do', richTextFromNodes(title), children, { properties: { checked: [[checked ? 'Yes' : 'No']] } }));
          } else {
            ids.push(make(tag === 'OL' ? 'numbered_list' : 'bulleted_list', richTextFromNodes(title), children));
          }
        }
      } else if (/^H[1-6]$/.test(tag)) {
        const level = Number(tag[1]);
        const type = level === 1 ? 'header' : level === 2 ? 'sub_header' : level === 3 ? 'sub_sub_header' : 'text';
        ids.push(make(type, richTextFromNodes(kids)));
      } else if (tag === 'PRE') {
        const code = n.querySelector('code');
        const lang = /language-([\w+-]+)/.exec(code?.className ?? '')?.[1]?.toLowerCase() ?? '';
        const text = (n.textContent ?? '').replace(/\n$/, '');
        ids.push(make('code', text ? [[text]] : [], [], { properties: { language: [[NOTION_LANGS[lang] ?? 'Plain Text']] } }));
      } else if (tag === 'BLOCKQUOTE') {
        const { title, children } = splitTitle(kids);
        ids.push(make('quote', richTextFromNodes(title), children));
      } else if (tag === 'HR') {
        ids.push(make('divider', []));
      } else if (tag === 'P' || !kids.some(isBlockNode)) {
        const title = richTextFromNodes(kids);
        if (title.length) ids.push(make('text', title));
      } else {
        // div、section 等包裝層：往裡面找區塊
        ids.push(...convert(kids));
      }
    }
    flushInline();
    return ids;
  }

  const roots = convert(Array.from(doc.body.childNodes));
  if (!roots.length) return null;
  const subtree = (id: string, out: Record<string, { value: NotionBlock }> = {}) => {
    out[id] = { value: records[id] };
    records[id].content?.forEach((c) => subtree(c, out));
    return out;
  };
  return JSON.stringify({
    blocks: roots.map((id) => ({ blockId: id, blockSubtree: { __version__: 3, block: subtree(id) } })),
    action: 'copy',
    wasContiguousSelection: true,
  });
}
