import { BlankFirstLineFormat, Tab, useStore } from './store';
import { getDocumentView } from './DocumentView';
import { isSnotePath } from './noteFormat';
import { isCsvPath } from './sheet/sheetFormat';

type OpenDocumentPayload = Parameters<Window['api']['window']['moveTabToNewWindow']>[0];

interface OpenFileOptions {
  autoFocus?: boolean;
  blankFirstLineFormat?: BlankFirstLineFormat;
  forceNew?: boolean;
}

function currentBlankFirstLineFormat(): BlankFirstLineFormat {
  return useStore.getState().preferences.blankNoteFirstLineFormat;
}

function focusTabWhenReady(tabId: string): void {
  let tries = 0;
  const focus = (): void => {
    const view = getDocumentView(tabId);
    if (view) {
      view.focusLastBlock();
      return;
    }
    tries += 1;
    if (tries < 8) window.setTimeout(focus, 16);
  };
  window.requestAnimationFrame(focus);
}

export async function stageTabForPaneMove(tabId: string): Promise<void> {
  const s = useStore.getState();
  const tab = s.tabs.find((t) => t.id === tabId);
  if (!tab) return;
  const view = getDocumentView(tabId);
  if (!view) return;
  // Staged in the app's own format so a pane move never drops red text,
  // toggles or the column layout.
  const markdown = await view.buildSnote();
  useStore.getState().updateTab(tabId, {
    initialMarkdown: markdown,
    restoreDirtyAfterLoad: tab.dirty,
  });
}

// Open a file path as a tab: if it's already open, just activate that tab;
// otherwise read its content (unless already supplied) and add a new tab.
export async function openFileInTab(
  path: string,
  content?: string,
  opts: OpenFileOptions = {}
): Promise<string | null> {
  const s = useStore.getState();
  const existing = opts.forceNew ? undefined : s.tabs.find((t) => t.filePath === path);
  if (existing) {
    s.setActiveTab(existing.id);
    if (opts.autoFocus) focusTabWhenReady(existing.id);
    return existing.id;
  }
  let md = content;
  if (md == null) {
    const r = await window.api.file.read(path);
    if (!r.ok) return null;
    md = r.content ?? '';
  }
  // If the active tab is a pristine, blank, untitled starter, replace it
  // instead of piling a new tab beside it (Obsidian behaviour).
  const prev = useStore.getState().tabs.find((t) => t.id === useStore.getState().activeTabId);
  const tabId = s.addTab({
    filePath: path,
    initialMarkdown: md,
    autoFocus: opts.autoFocus,
    blankFirstLineFormat: opts.blankFirstLineFormat,
  });
  if (opts.autoFocus) focusTabWhenReady(tabId);
  closeIfPristineStarter(prev);
  return tabId;
}

function closeIfPristineStarter(tab: Tab | undefined): void {
  if (!tab || tab.filePath || tab.dirty) return;
  const dv = getDocumentView(tab.id);
  if (!dv || !dv.hasContent()) useStore.getState().closeTab(tab.id);
}

// A document pushed in by main: a file opened from Finder / File → Open, or a
// tab moved here from another window (possibly untitled and unsaved).
export async function openDocumentPayload(doc: OpenDocumentPayload): Promise<void> {
  if (doc.path && !doc.dirty) {
    await openFileInTab(doc.path, doc.content, { autoFocus: true });
    return;
  }
  const s = useStore.getState();
  const prev = s.tabs.find((t) => t.id === s.activeTabId);
  const tabId = s.addTab({
    filePath: doc.path,
    initialMarkdown: doc.content,
    kind: doc.kind,
    autoFocus: true,
  });
  useStore.getState().updateTab(tabId, { restoreDirtyAfterLoad: !!doc.dirty });
  focusTabWhenReady(tabId);
  closeIfPristineStarter(prev);
}

// "開啟在新視窗": hand the tab's current content to a new window and drop it
// from this one. A window left with nothing else closes.
export async function moveTabToNewWindow(tabId: string): Promise<void> {
  const s = useStore.getState();
  const tab = s.tabs.find((t) => t.id === tabId);
  const view = getDocumentView(tabId);
  if (!tab || !view) return;
  window.api.window.moveTabToNewWindow({
    path: tab.filePath,
    // The app's own format, so red text, toggles and columns survive the move.
    content: await view.buildSnote(),
    dirty: tab.dirty,
    kind: tab.kind,
  });
  const wasOnlyTab = useStore.getState().tabs.length === 1;
  useStore.getState().closeTab(tabId);
  if (wasOnlyTab) window.api.window.close();
}

// "New tab": an untitled in-memory note. Used by Cmd+N and the tab bar's + button.
export function createNewTab(): void {
  const tabId = useStore.getState().addTab({ blankFirstLineFormat: currentBlankFirstLineFormat() });
  focusTabWhenReady(tabId);
}

// File → 新增試算表: an untitled in-memory Simple Sheet. The tab bar's + button
// never creates sheets.
export function createNewSheet(): void {
  useStore.getState().addTab({ kind: 'sheet' });
}

// Closing a Markdown note that uses formatting Markdown can't store: offer to
// convert it to the app's own `.snote` format (answering "維持 Markdown" is what
// loses the red text / toggles / two-column layout). A `.csv` sheet with
// formulas or cell styling gets the same offer for `.ssheet`. Returns silently
// for native-format files and for documents that survive untouched.
export async function convertMarkdownNoteIfLossy(tab: Tab): Promise<void> {
  if (!tab.filePath) return;
  const plain = tab.kind === 'sheet' ? isCsvPath(tab.filePath) : !isSnotePath(tab.filePath);
  if (!plain) return;
  const view = getDocumentView(tab.id);
  if (!view) return;
  const features = view.lossyFeatures();
  if (features.length === 0) return;
  const convert = await window.api.file.confirmLossy(
    'convert',
    tab.fileName,
    features,
    tab.kind === 'sheet' ? 'sheet' : 'note'
  );
  if (!convert) return;
  const snote = await view.buildSnote();
  const r = await window.api.file.convertToSnote(tab.filePath, snote);
  if (r.ok && r.path) {
    useStore.getState().retargetTabs(tab.filePath, r.path);
    useStore.getState().setTabDirty(tab.id, false);
  }
}

// Close a tab, first asking about unsaved changes and then about any
// formatting a Markdown file can't keep.
export async function closeTabWithChecks(tabId: string): Promise<void> {
  const tab = useStore.getState().tabs.find((t) => t.id === tabId);
  if (!tab) return;
  const view = getDocumentView(tabId);
  let discarded = false;
  if (tab.dirty && view?.hasContent()) {
    const choice = await window.api.file.confirmCloseDirty(tab.fileName);
    if (choice === 2) return;
    if (choice === 0 && !(await view.save())) return;
    discarded = choice === 1;
  }
  // Converting writes the editor's current content, which a discard just threw away.
  const current = useStore.getState().tabs.find((t) => t.id === tabId);
  if (current && !discarded) await convertMarkdownNoteIfLossy(current);
  useStore.getState().closeTab(tabId);
}

// Same check across every open tab — run by the main process before a window
// closes (see window.__simpleNote_beforeClose in App.tsx).
export async function convertLossyMarkdownTabs(): Promise<void> {
  for (const tab of [...useStore.getState().tabs]) {
    await convertMarkdownNoteIfLossy(tab);
  }
}

