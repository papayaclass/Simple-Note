# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

**專案概述**

Simple Note 是一款 macOS 為主的極簡 Block 式筆記桌面應用，採用 Electron + Vite + React + TypeScript 建置，編輯器核心使用 BlockNote (TipTap / ProseMirror)。筆記直接以 Markdown（`.md`）格式儲存，Markdown 不支援的標記（如紅字、雙欄版面）在存檔時會被捨棄。介面語言為繁體中文。

**常用指令**

- `npm run dev`：以 `electron-vite dev` 啟動開發模式（含 HMR），同時跑 main / preload / renderer。
- `npm run build`：使用 `electron-vite build`，輸出 production bundle 到 `out/`。
- `npm start`：執行 `electron-vite preview`，預覽已 build 的版本。
- `npm run pack`：build 後以 `electron-builder --dir` 產生未打包的 app 目錄（測試用，不簽章）。
- `npm run dist`：build 後以 `electron-builder` 產生可散布的安裝檔，輸出到 `dist/`。
- `npm run icons`：從根目錄的 `Simple Note.png` 產生 `build/icons/` 內所有平台圖示。
- 目前沒有測試框架、ESLint 或 Prettier 設定；型別檢查只透過 `electron-vite build` 進行。要單獨檢查型別可執行 `npx tsc --noEmit -p tsconfig.web.json` 或 `tsconfig.node.json`。

**進程架構**

整體分為三個 Electron 進程，分別有獨立的 tsconfig 與 Vite 入口（見 `electron.vite.config.ts`）：

- `src/main/`（Node 端，編譯到 `out/main/`）：建立 BrowserWindow、註冊應用選單、處理檔案 IO、偏好設定、匯率快取，以及視窗大小／位置的持久化（用 `electron-store`，並驗證還原後仍在連接的顯示器內）。
- `src/preload/index.ts`（編譯到 `out/preload/`）：唯一允許跨進程的橋接層。透過 `contextBridge.exposeInMainWorld('api', ...)` 把白名單 IPC 包成型別化的 `SimpleNoteAPI`。**新增任何 main 端能力時必須同步更新 preload 與 `src/renderer/src/types.d.ts`，否則 renderer 無法存取。**
- `src/renderer/`（React，編譯到 `out/renderer/`）：UI 與編輯器。使用 alias `@renderer/*` 指向 `src/renderer/`。
- `sandbox: false`、`contextIsolation: true`、`nodeIntegration: false`。Renderer 嚴禁直接 require Node 模組；所有原生功能都要走 preload。

**IPC 約定**

main 端在 `app.whenReady` 內註冊 handler，命名採 `namespace:action`（例：`prefs:get`、`file:save`、`rate:get`）。雙向呼叫用 `ipcMain.handle` / `ipcRenderer.invoke`；單向用 `ipcMain.on` / `ipcRenderer.send`（如 `window:setDirty`）。

選單事件走另一條路：main 端 `menu.ts` 在點擊時 `webContents.send('menu:<cmd>')`，preload 把這些事件聚合成 `window.api.onMenu(handler)`，由 `App.tsx` 在 `useEffect` 內 dispatch。要新增選單命令時，三個地方都要動：`src/main/menu.ts`、`src/preload/index.ts`（加到 `wrap()` 或走 `menu:command`）、`src/renderer/src/App.tsx` 的 switch。

**檔案儲存格式**

存檔內容是純 Markdown：`file:save` 收下 renderer 用 `editor.blocksToMarkdownLossy` 產生的字串直接寫入 `.md`。雙欄模式啟用時，右欄文字會接到左欄下方（Markdown 無法表達多欄）。`file:save` 會記住 `currentFilePath`，後續按 Cmd+S 不再跳對話框；`file:new` 與 `file:open` 會更新標題列與 `representedFilename`。開啟檔案時一律用 `loadMarkdown` 解析進左欄、清空右欄並退回單欄。Renderer 端透過 `window.__simpleNote_isDirty()` / `window.__simpleNote_save()` 兩個全域函式，讓 main 在視窗關閉前可同步詢問是否儲存。

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

- 使用 BlockNote 預設 schema，加上一個自訂 style `RedText`（紅字標記）。
- 透過 BlockNote 的 `createBlockNoteExtension` API 注入兩個 ProseMirror plugin：
  - `simple-note-math`：數學模式 overlay (見下節)。
  - `simple-note-select-all`：兩段式 Cmd+A，第一次選整個 block，第二次才全選整份文件。
- 鍵盤快捷鍵：Cmd+1 段落、Cmd+2 折疊清單 (toggle)、Cmd+3 項目符號、Cmd+4 程式碼區塊、Cmd+5 checkbox、Shift+Cmd+L 引言、Shift+Cmd+S 刪除線、Shift+Cmd+X inline code、Opt+Cmd+1/2/3 H1/H2/H3、Opt+Cmd+V 紅字。
- 折疊清單是自訂 block `toggle`（`editor/toggle.tsx`）。**注意：不要改用 BlockNote 內建的 `toggleListItem`——在 0.40 版透過 BlockNoteView 渲染時它沒有箭頭、不能折疊（core 的 render 只對 isToggleable 的 heading 加 toggle UI，`toggleListItem` 沒有該 prop），會退化成普通段落。** 我們自繪 `.bn-toggle-wrapper` + `.bn-toggle-button`（沿用 BlockNote CSS：`data-show-children=false` 時隱藏子 `.bn-block-group`），展開/關閉狀態存在 block 的 `open` prop（活在文件模型中，不像 BlockNote 內建的 `ToggleWrapper` 存在 localStorage；但因為存檔是 Markdown，此狀態不會被持久化）。
- toggle 的 Notion 式互動由 `createToggleKeyboardExtension()`（在 `Editor.tsx` 的 extensions 內）提供：游標在 toggle 標題列按 Enter，展開時在內側新增子 block 並把游標移入、關閉時在下方新增 sibling toggle（像 list item）；Cmd/Ctrl+Enter 切換展開/關閉。**新增 sibling toggle 後必須用 `requestAnimationFrame` 才能把游標移入新 block——它是 React node view，內容 DOM 要等 React 繪製後才存在，同步設游標會失效。** Cmd+2 在 `Editor.tsx` 把目前 block 轉成 `toggle`。
- 框選整塊與整塊刪除：`codeBlockSelect.ts` 的 `WHOLE_BLOCK_TYPES` 同時涵蓋 `codeBlock` 與 `toggle`（被選取覆蓋時加 `.sn-block-selected` 整塊反白），`blockDelete.ts` 也把單一 `toggle` 視為整塊刪除（連同子 block）。**重要：所有 shortcut 都用 `e.code`（物理按鍵）判斷，不要用 `e.key`，因為 macOS 上 Option 會把 `key` 改寫（Opt+V 變 √、Opt+4 變 ¢）導致比對失敗。**
- BlockNote 的 `[ ]\s` input rule 在轉成 checkbox 後會多留一個空 paragraph，`Editor.tsx` 內有一段 `onChange` 監聽會偵測此 pattern 並 `removeBlocks` + `setTextCursorPosition` 修正。修改 onChange 邏輯時要小心不要重新引入這個 bug。

**數學模式 (`src/renderer/src/math/`)**

開啟後 (Shift+Cmd+M)，每個包含 `=` 的 textblock 會在行尾以 ProseMirror Decoration widget 顯示計算結果。

- `parser.ts` 是手寫 recursive-descent，支援四則運算、括號、Unicode（含 CJK）變數名稱，文法見檔頭註解。
- `evaluator.ts` 處理變數綁定（`x = 1+2` 形式會把 x 存入跨行 `vars` Map）、純查詢行（純運算式）、以及貨幣查詢行（如 `100 USD`）。
- `overlay.ts` 是 plugin。匯率查詢非同步，因此 plugin 維護自己的 `rateCache`：首次查詢顯示「查詢中…」並 `dispatch` 一個帶 meta 的 transaction 強制 redraw，避免 ProseMirror decoration 必須同步的限制。語法錯誤與未定義變數會被靜默（使用者還在輸入中），其他算術錯誤才會顯示。

**匯率查詢 (`src/main/exchange-rate.ts`)**

呼叫 `https://v6.exchangerate-api.com` 取得以 TWD 為基準的匯率，需要使用者在偏好設定中填入 API key。快取存於 `app.getPath('userData')/rate-cache.json`，TTL 24 小時；若 fetch 失敗會 fallback 到過期快取。API 回傳的是「1 TWD = N 外幣」，因此換回 TWD 要取倒數，這在 `getRate` 內已處理。

**狀態管理 (`src/renderer/src/store.ts`)**

使用 Zustand。`dirty` 旗標由 BlockNote 的 `onChange` 觸發；`fileName` 從 `filePath` 衍生（去掉 `.md`）。`Preferences` 同時定義於 `src/renderer/src/store.ts` 與 `src/main/preferences.ts`，**新增偏好欄位時兩邊都要改**，並且要更新 `App.tsx` 內把 preference 套用到 CSS variable 的 `useEffect`。

**右鍵選單與文字轉換 (`src/renderer/src/context-menu/`)**

提供簡轉繁（用 `opencc-js`）、半形標點轉全形、清除格式、插入 Lorem Ipsum、字數統計（含中文字、英文 words、含／不含空白字元）、聆聽發音等命令。可從 macOS 應用選單（編輯 → ...）或右鍵叫出；兩者透過 `window.dispatchEvent(new CustomEvent('simple-note:command', ...))` 統一處理。右鍵選單開啟後會用 `useLayoutEffect` 量測尺寸並把位置夾進可視範圍，過長時靠 CSS `max-height` + `overflow-y` 捲動。

聆聽發音走 Gemini TTS（`src/main/gemini-tts.ts`）：main 端呼叫 `generateContent` 的 AUDIO 模式，把回傳的原始 PCM 補上 WAV 檔頭後以 base64 WAV 回傳，renderer 用 `<audio>` 播放。語音狀態集中在 `src/renderer/src/context-menu/speech.ts` 的**單例**（module scope，非 per-component）：`audioCache`（文字→音訊，重播不再送 API）、`inFlight`（同字併發去重）、`lastAudio`（重播上一次）。**務必保持單例**——雙欄模式有兩個 Editor → 兩個 `ContextMenu`，若把快取或 Shift+Cmd+P 監聽放回 component 內，按一次會播兩次甚至重疊。`installSpeechShortcut()` 在 `App.tsx` 只註冊一次（內部 `installed` 旗標防重複）。需在偏好設定的 API Keys 頁填入 Gemini API Key 與模型名稱（`geminiApiKey`、`geminiTtsModel`，預設 `gemini-3.1-flash-tts-preview`）。

**樣式與排版**

- 全域樣式：`src/renderer/src/theme.css`、`editor.css`。版面寬度／行高／段落間距／頂端 padding 都是 CSS 變數，由 `App.tsx` 從 preferences 動態設定（`--page-width`、`--line-height`、`--paragraph-spacing`、`--top-padding`）。
- 視窗使用 `titleBarStyle: 'hiddenInset'`，因此 renderer 內有一個 `.drag-bar` 提供拖曳區。
