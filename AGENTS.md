# AGENTS.md

This file provides guidance to Codex when working with code in this repository.

**專案概述**

Simple Note 是一款 macOS 為主的極簡 Block 式筆記桌面應用，採用 Electron + Vite + React + TypeScript 建置，編輯器核心使用 BlockNote (TipTap / ProseMirror)。筆記**預設以 App 專用的 `.snote` 格式儲存**（BlockNote block tree 的 JSON，完整保留紅字、Toggle、圖片與雙欄版面）；`.md` 檔仍可直接開啟並以 Markdown 儲存，但 Markdown 不支援的標記會在存檔時被捨棄。另外內建簡易試算表，可開啟 `.csv` 與 App 專用的 `.ssheet`（見「試算表」一節）。介面語言為繁體中文。

**常用指令**

- `npm run dev`：以 `electron-vite dev` 啟動開發模式（含 HMR），同時跑 main / preload / renderer。
- `npm run build`：使用 `electron-vite build`，輸出 production bundle 到 `out/`。
- `npm start`：執行 `electron-vite preview`，預覽已 build 的版本。
- `npm run pack`：build 後以 `electron-builder --dir` 產生未打包的 app 目錄（測試用，不簽章）。
- `npm run dist`：build 後以 `electron-builder` 產生可散布的安裝檔，輸出到 `dist/`electron-builder 會自動用鑰匙圈裡的 Developer ID 憑證簽章（含 hardened runtime 與時間戳記），但 `notarize` 設為 `false`，發布時要另外把 `dist/mac-universal/Simple Note.app` 壓成 zip 用 `notarytool` 公證再 `stapler staple`。第一次打包需要下載 x64 與 arm64 兩份 Electron（各約 100 MB），會花好幾分鐘。
- `npm run icons`：從根目錄的 `Simple Note.png` 產生 `build/icons/` 內所有平台圖示。
- 目前沒有測試框架、ESLint 或 Prettier 設定；型別檢查只透過 `electron-vite build` 進行。要單獨檢查型別可執行 `npx tsc --noEmit -p tsconfig.web.json` 或 `tsconfig.node.json`。

**進程架構**

整體分為三個 Electron 進程，分別有獨立的 tsconfig 與 Vite 入口（見 `electron.vite.config.ts`）：

- `src/main/`（Node 端，編譯到 `out/main/`）：建立 BrowserWindow、註冊應用選單、處理檔案 IO、偏好設定，以及視窗大小／位置的持久化（用 `electron-store`，並驗證還原後仍在連接的顯示器內）。
- `src/preload/index.ts`（編譯到 `out/preload/`）：唯一允許跨進程的橋接層。透過 `contextBridge.exposeInMainWorld('api', ...)` 把白名單 IPC 包成型別化的 `SimpleNoteAPI`。**新增任何 main 端能力時，要在 preload 的 `SimpleNoteAPI` 介面與 `api` 實作同時加上，否則 renderer 無法存取。** Renderer 的型別直接從 preload 匯入（`src/renderer/src/types.d.ts` 只 `import type { SimpleNoteAPI }`，外加 `window.__simpleNote_*` 幾個全域函式的宣告），不需要另外維護一份型別。
- `src/renderer/`（React，編譯到 `out/renderer/`）：UI 與編輯器。使用 alias `@renderer/*` 指向 `src/renderer/`。
- `sandbox: false`、`contextIsolation: true`、`nodeIntegration: false`。Renderer 嚴禁直接 require Node 模組；所有原生功能都要走 preload。

**IPC 約定**

main 端在 `app.whenReady` 內註冊 handler，命名採 `namespace:action`（例：`prefs:get`、`file:save`、`vault:read`）。雙向呼叫用 `ipcMain.handle` / `ipcRenderer.invoke`；單向用 `ipcMain.on` / `ipcRenderer.send`（如 `window:setDirty`）。

選單事件走另一條路：main 端 `menu.ts` 在點擊時 `webContents.send('menu:<cmd>')`，preload 把這些事件聚合成 `window.api.onMenu(handler)`，由 `App.tsx` 在 `useEffect` 內 dispatch。要新增選單命令時，三個地方都要動：`src/main/menu.ts`、`src/preload/index.ts`（加到 `wrap()` 或走 `menu:command`）、`src/renderer/src/App.tsx` 的 switch。

**檔案格式（`.snote` / `.md`，試算表見下節）**

格式的判斷邏輯集中在 `src/renderer/src/noteFormat.ts`：

- `.snote`（預設）：JSON，內容為 `{ format: 'simple-note', version, columnLayout, columnSplit, columns: { left, middle, right } }`，三欄各存一份 BlockNote block tree。由 `DocumentView.buildSnote()` 產生、`loadContent()` 還原（`parseSnote` 回傳 null 就當成 Markdown 解析，所以載入時不需要看副檔名）。
- `.md` / `.txt`：純 Markdown，內容由 `editor.blocksToMarkdownLossy` 產生。雙欄展開時 `buildMarkdown` 依「畫面左欄在上、右欄在下」合併兩欄，空白欄略過。
- Markdown 開頭的 YAML front matter（第一行 `---`、第二行是 `key:`）由 `splitFrontMatter` 在載入時切出來存在 `DocumentView` 的 `frontMatterRef`，不進編輯器，`buildMarkdown` 時原文接回最前面。原因是 BlockNote 會把 `---` 解析成分隔線與 setext 標題，存回去變成 `***` 與一長串 `-`，弄壞 Claude Code Skill 的 `SKILL.md` 這類靠 front matter 運作的檔案。因此 front matter 在 App 內看不到也改不了。

Renderer 每次存檔都同時算出兩種內容（`{ markdown, snote }`）交給 main，**由目標檔案的副檔名決定寫入哪一份**（`contentForPath`，`.md`/`.txt`/`.csv` 走純文字那份，其餘走 snote）。`file:save`、`file:saveAs`、`vault:moveToVault` 都是這個約定；存檔對話框依建議檔名的副檔名決定篩選器（筆記 `.snote`/`.md`，試算表 `.ssheet`/`.csv`），筆記新檔／另存預設 `.snote`。儲存庫內新建的空白筆記也是 `未命名筆記.snote`。

`lossyFeatures()`（noteFormat.ts）掃描 block tree 找出 Markdown 存不下的東西（紅字、底線、文字顏色／底色、折疊清單、圖片），`DocumentView` 再補上「雙欄版面」。用在兩處：

- 關閉含特殊格式的 `.md` 分頁時（`closeTabWithChecks` / 視窗關閉前的 `window.__simpleNote_beforeClose`）詢問是否轉存成 `.snote`；答「轉存」會寫出同名 `.snote` 並把原 `.md` 移到垃圾桶（`file:convertToSnote`），答「維持 Markdown」則特殊格式就此遺失。
- 分頁右鍵的「匯出成 MD 文件…」（僅 `.snote` 分頁可用）匯出前提醒，預設存到下載資料夾（`file:exportMarkdown`）。

`file:save` 會記住分頁的檔案路徑，後續按 Cmd+S 不再跳對話框。Renderer 端透過 `window.__simpleNote_isDirty()` / `window.__simpleNote_save()` / `window.__simpleNote_beforeClose()` 三個全域函式，讓 main 在視窗關閉前可依序做格式轉存詢問與未存檔詢問（會檢查 / 儲存所有未存的分頁）。

**試算表 (`src/renderer/src/sheet/`)**

`.ssheet` (Simple Sheet，JSON：`{ format: 'simple-sheet', version, colWidths, cells }`，cells 以 A1 位址為 key，存原始輸入含公式與粗斜體／顏色) 與 `.csv` 以 `kind: 'sheet'` 分頁開啟，由 `SheetView` 渲染 (`makeTab` 依副檔名推斷 kind)。沿用 `DocumentViewHandle`（透過 `registerDocumentView` 註冊），所以存檔、關閉詢問、分頁搬移不用分支：`buildMarkdown` 回傳 CSV、`buildSnote` 回傳 `.ssheet` JSON，main 端 `.csv` 與 `.md` 一樣走純文字那份。`.csv` 行為比照 `.md`：存回 CSV 時公式變計算結果、樣式捨棄，關閉時若用了公式或格式會詢問轉存 `.ssheet`。

- `formula.ts`：手寫公式引擎（文法在檔頭），支援 SUM / AVERAGE / COUNT / COUNTIF / SUMIF / IF 等；插入／刪除列欄與相對貼上時用 `shiftForStructure` / `shiftRelative` 改寫參照。
- `SheetView` 內的 `.sheet-input` 同時是鍵盤接收器：未編輯時透明地停在作用中儲存格上並保持 focus，讓注音等輸入法直接在格子上組字。快捷鍵一樣用 `e.code`。
- 「檔案 → 新增試算表」(Opt+Cmd+N) 建立試算表；分頁列的 + 號只建立一般筆記。
- 編輯公式時，`formulaRanges()` 找出公式內所有參照，畫成 `.sheet-ref-box` 虛線框；用滑鼠剛點選／拖曳的那一段 (`refPick`) 加 `.marching` 流動虛線（四條 gradient 邊框動畫 background-position），使用者一打字就停止。
- 踩過的坑：
  - 閒置的 `.sheet-input` 疊在作用中儲存格上方，**不可**套 `fill-*` 底色，否則會把格子裡的文字蓋掉（只在編輯時套）。
  - 整欄／整列選取時 `rowCount`/`colCount` 只能「容納」選取範圍 (`range.r2 + 1`)，不能再加緩衝，否則每點一次欄標題表格就長 50 列。
  - `registerDocumentView` 的 cleanup 要比對 handle 是否仍是自己：分頁從筆記切成試算表 (同一個 tab id) 時，新 view 可能先註冊、舊 view 後卸載。
  - Browser pane 模擬按鍵時 `e.code` 是空字串，快捷鍵用 `isKey()`：有 code 比 code，沒有才退回 `e.key`。
- 驗證 UI：`.claude/launch.json` 的 `renderer-only` 只跑 Vite，沒有 preload，`window.api` 不存在會直接壞掉。可暫時在 `src/renderer/` 放一個 harness html，先用 inline script 塞假的 `window.api` (記下 `onOpenInTab` / `onMenu` 的 handler 以便從 console 開檔、送選單命令) 再載入 `./src/main.tsx`，測完刪除。

**編輯器核心 (`src/renderer/src/editor/`)**

- Schema（`schema.ts`）：BlockNote 預設 block 加上自訂的 `image`、`toggle`、`divider`，以及自訂 style `redText`（紅字標記）。
- 透過 BlockNote 的 `createBlockNoteExtension` API 注入 ProseMirror plugin（大多在 `Editor.tsx` 的 extensions 陣列），key 都以 `simple-note-` 開頭，例如：
  - `simple-note-math`：數學模式 overlay (見下節)。
  - `simple-note-select-all`：兩段式 Cmd+A，第一次選整個 block，第二次才全選整份文件。
  - `simple-note-find`：尋找與取代的高亮 (見下節)。
  - `simple-note-block-delete`、`simple-note-codeblock-select`：整塊選取與刪除。
  - `simple-note-heading-enter`：在標題開頭或結尾按 Enter 會留下一般段落，而不是再產生一個標題。
  - 其他：`code-highlight` (lowlight 語法上色)、`code-wrap`、`selection-clamp`、`toggle-keys`、`paste-link`、`youtube`。
- 鍵盤快捷鍵：Cmd+1 段落、Cmd+2 折疊清單 (toggle)、Cmd+3 項目符號、Cmd+4 程式碼區塊、Cmd+5 checkbox、Shift+Cmd+L 引言、Shift+Cmd+S 刪除線、Shift+Cmd+X inline code、Shift+Cmd+V 貼成純文字、Opt+Cmd+1/2/3 H1/H2/H3、Opt+Cmd+V 紅字。
- 折疊清單是自訂 block `toggle`（`editor/toggle.tsx`）。**注意：不要改用 BlockNote 內建的 `toggleListItem`——在 0.40 版透過 BlockNoteView 渲染時它沒有箭頭、不能折疊（core 的 render 只對 isToggleable 的 heading 加 toggle UI，`toggleListItem` 沒有該 prop），會退化成普通段落。** 我們自繪 `.bn-toggle-wrapper` + `.bn-toggle-button`（沿用 BlockNote CSS：`data-show-children=false` 時隱藏子 `.bn-block-group`），展開/關閉狀態存在 block 的 `open` prop（活在文件模型中，不像 BlockNote 內建的 `ToggleWrapper` 存在 localStorage；存成 `.snote` 時會一併保存；存成 `.md` 則不會）。
- toggle 的 Notion 式互動由 `createToggleKeyboardExtension()`（在 `Editor.tsx` 的 extensions 內）提供：游標在 toggle 標題列按 Enter，展開時在內側新增子 block 並把游標移入、關閉時在下方新增 sibling toggle（像 list item）；Cmd/Ctrl+Enter 切換展開/關閉。**新增 sibling toggle 後必須用 `requestAnimationFrame` 才能把游標移入新 block——它是 React node view，內容 DOM 要等 React 繪製後才存在，同步設游標會失效。** Cmd+2 在 `Editor.tsx` 把目前 block 轉成 `toggle`。
- 框選整塊與整塊刪除：`codeBlockSelect.ts` 的 `WHOLE_BLOCK_TYPES` 同時涵蓋 `codeBlock` 與 `toggle`（被選取覆蓋時加 `.sn-block-selected` 整塊反白），`blockDelete.ts` 也把單一 `toggle` 視為整塊刪除（連同子 block）。**重要：所有 shortcut 都用 `e.code`（物理按鍵）判斷，不要用 `e.key`，因為 macOS 上 Option 會把 `key` 改寫（Opt+V 變 √、Opt+4 變 ¢）導致比對失敗。**
- BlockNote 的 `[ ]\s` input rule 在轉成 checkbox 後會多留一個空 paragraph，`Editor.tsx` 內有一段 `onChange` 監聽會偵測此 pattern 並 `removeBlocks` + `setTextCursorPosition` 修正。修改 onChange 邏輯時要小心不要重新引入這個 bug。

**數學模式 (`src/renderer/src/math/`)**

開啟後 (Shift+Cmd+M)，每個包含 `=` 的 textblock 會在行尾以 ProseMirror Decoration widget 顯示計算結果。

- `parser.ts` 是手寫 recursive-descent，支援四則運算、括號、Unicode（含 CJK）變數名稱，文法見檔頭註解。
- `evaluator.ts` 處理變數綁定（`x = 1+2` 形式會把 x 存入跨行 `vars` Map）與純查詢行（純運算式）。
- `overlay.ts` 是 plugin，把結果以 Decoration widget 畫在行尾。語法錯誤與未定義變數會被靜默（使用者還在輸入中），其他算術錯誤才會顯示。
- 數學模式只能用 Shift+Cmd+M（或「檢視」選單）切換，沒有任何關鍵字觸發。

**尋找與取代 (`src/renderer/src/find/`)**

Cmd+F 尋找、Opt+Cmd+F 尋找並取代、Cmd+G / Shift+Cmd+G 下一個／上一個（編輯選單命令，經 `DocumentViewHandle.openFind` 等轉給目前分頁）。`FindBar` 只搜尋目前版面上看得到的欄位，依畫面左到右排序；一行以內的選取文字會自動帶入搜尋欄。試算表分頁目前不支援尋找。

**分頁、分割窗格與儲存庫**

- 每個分頁是 `store.ts` 的一個 `Tab`，`kind` 為 `editor`（`DocumentView`）、`sheet`（`SheetView`）或 `image`（唯讀圖片預覽 `ImageView`）。分頁的 view 一直掛著、非作用中時只是隱藏，所以各自保有復原紀錄、游標與捲動位置。App shell 透過 `getDocumentView(tabId)` 取得 `DocumentViewHandle` 操作特定分頁。
- 最多兩個分割窗格（`panes`）：把分頁拖到工作區左右邊緣即可分割，中間的分隔線可拖曳調整比例。分頁移到另一個窗格時 React 會重新掛載 view，所以 `stageTabForPaneMove` 先把內容存進 `initialMarkdown`，並用 `restoreDirtyAfterLoad` 保留 dirty 狀態。
- 儲存庫 (vault) 是使用者選定的資料夾（main 端 `vault.ts` 負責 IO 與 `fs.watch` 監看，變動時送 `vault:changed`）。側邊欄 `sidebar/Sidebar.tsx` 列出檔案樹，支援手動／名稱／建立／修改時間排序、拖曳移動、從 Finder 拖入匯入、多選刪除（移到垃圾桶）。
- **儲存庫內的檔案編輯後約 600ms 自動存檔，不會出現未存檔圓點**；儲存庫外的檔案與未命名分頁才標 dirty、需要手動存檔。
- 新建的 `未命名筆記` 會自動以第一個標題命名（`autoName`，直到使用者手動改名為止）。儲存庫永遠至少保留一則筆記：刪光時會補一個 `未命名筆記.snote`，而唯一剩下的那個未命名筆記不能刪（`isProtectedUnnamedNote`）。
- 啟動行為由偏好設定 `startupBehavior` 決定：在儲存庫新增空白筆記，或重新開啟上次編輯的檔案（`lastEditedFilePath`）。
- 啟動時由 `src/renderer/src/main.tsx` 的 `bootstrap()` 先讀取偏好設定，將 `preferences`、`sidebarOpen` 與排序狀態還原至 store，完成後才掛載 React。不可在 `App.tsx` 掛載後才還原側邊欄狀態，否則已關閉的側邊欄會先顯示再收合；`App.tsx` 只沿用已載入的偏好設定，處理命令清單同步與儲存庫初始化。讀取失敗時會記錄錯誤並使用預設設定啟動。

**狀態管理 (`src/renderer/src/store.ts`)**

使用 Zustand，存放分頁、窗格、偏好設定與側邊欄狀態。`dirty` 旗標由編輯器（或試算表）的變更觸發，但儲存庫內的檔案改走自動存檔，不會標 dirty；`fileName` 從 `filePath` 衍生（去掉 `.md` / `.snote` / `.ssheet`，`.csv` 刻意保留，讓使用者看得出是會遺失格式的格式）。`Preferences` 同時定義於 `src/renderer/src/store.ts` 與 `src/main/preferences.ts`，**新增偏好欄位時兩邊都要改**，並且要更新 `App.tsx` 內把 preference 套用到 CSS variable 的 `useEffect`。

**右鍵選單與文字轉換 (`src/renderer/src/context-menu/`)**

命令清單集中在 `commands.ts` 的 `MENU_COMMANDS`：簡轉繁（`opencc-js`）、半形標點轉全形、清除格式、移除超連結與注釋、段落／分行轉換、插入 Lorem Ipsum、依觀看數排序 YouTube、字數統計、拼音查詢（`pinyin-pro`）、嘸蝦米查碼、Google／Maps／YouTube 搜尋、劍橋詞典，以及中英互譯（透過 main 端 `openrouter.ts` 的 `ai:run` 呼叫 OpenRouter，需在偏好設定的 API Keys 填金鑰）。使用者可在偏好設定「右鍵選單」頁調整順序、顯示與名稱、插入分隔線，存在 `preferences.menuCommands`；新增命令時 `reconcileMenuCommands` 會把它插到原本順序中的相鄰位置。部分命令也能從 macOS 應用選單（編輯 → ...）叫出，兩者透過 `window.dispatchEvent(new CustomEvent('simple-note:command', ...))` 統一處理。右鍵選單開啟後會用 `useLayoutEffect` 量測尺寸並把位置夾進可視範圍，過長時靠 CSS `max-height` + `overflow-y` 捲動。

**樣式與排版**

- 全域樣式：`src/renderer/src/theme.css`、`editor.css`。版面寬度／行高／段落間距／頂端 padding 都是 CSS 變數，由 `App.tsx` 從 preferences 動態設定（`--page-width`、`--line-height`、`--paragraph-spacing`、`--top-padding`）。
- 視窗使用 `titleBarStyle: 'hiddenInset'`，拖曳視窗靠分頁列 `.tab-bar` 的 `-webkit-app-region: drag`（互動元件各自設 `no-drag`）；側邊欄收合時分頁列左側會讓出紅綠燈按鈕的空間。`theme.css` 裡的 `.drag-bar` 樣式已沒有元件使用。
- 顏色以 `theme.css` `:root` 的 CSS 變數定義，深色模式跟隨系統 `prefers-color-scheme`；試算表另有自己的色票變數（`sheet/sheet.css`）。
