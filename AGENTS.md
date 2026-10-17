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
- `npm run icons`：從根目錄的 `Simple Note.png` 產生 `build/icons/` 內所有平台圖示。`build/icons/` 不在 git 裡，在 worktree 內打包前要先從主 checkout 複製過來（或執行 `npm run icons`），否則 electron-builder 找不到 `icon.icns` 而失敗。
- 指定 electron-builder 的 `CSC_NAME` 時使用 `Mu-Hua Wang (7Y3SNMCD34)`，不要加上 `Developer ID Application:` 前綴，否則 builder 會拒絕。正式 App 公證並 staple 後，需重新製作最終 DMG，確保其中包含已附票證的 App；DMG 先以 `hdiutil verify` 驗證，再簽章、公證與 staple。
- 目前沒有測試框架、ESLint 或 Prettier 設定；型別檢查只透過 `electron-vite build` 進行。要單獨檢查型別可執行 `npx tsc --noEmit -p tsconfig.web.json` 或 `tsconfig.node.json`。

**進程架構**

整體分為三個 Electron 進程，分別有獨立的 tsconfig 與 Vite 入口（見 `electron.vite.config.ts`）：

- `src/main/`（Node 端，編譯到 `out/main/`）：建立 BrowserWindow、註冊應用選單、處理檔案 IO、偏好設定，以及視窗大小／位置的持久化（用 `electron-store`，並驗證還原後仍在連接的顯示器內）。
- `src/preload/index.ts`（編譯到 `out/preload/`）：唯一允許跨進程的橋接層。透過 `contextBridge.exposeInMainWorld('api', ...)` 把白名單 IPC 包成型別化的 `SimpleNoteAPI`。**新增任何 main 端能力時，要在 preload 的 `SimpleNoteAPI` 介面與 `api` 實作同時加上，否則 renderer 無法存取。** Renderer 的型別直接從 preload 匯入（`src/renderer/src/types.d.ts` 只 `import type { SimpleNoteAPI }`，外加 `window.__simpleNote_*` 幾個全域函式的宣告），不需要另外維護一份型別。
- `src/renderer/`（React，編譯到 `out/renderer/`）：UI 與編輯器。使用 alias `@renderer/*` 指向 `src/renderer/`。
- `sandbox: false`、`contextIsolation: true`、`nodeIntegration: false`。Renderer 嚴禁直接 require Node 模組；所有原生功能都要走 preload。

**IPC 約定**

main 端在 `app.whenReady` 內註冊 handler，命名採 `namespace:action`（例：`prefs:get`、`file:save`、`file:read`）。雙向呼叫用 `ipcMain.handle` / `ipcRenderer.invoke`；單向用 `ipcMain.on` / `ipcRenderer.send`（如 `window:setDirty`）。

選單事件走另一條路：main 端 `menu.ts` 在點擊時 `webContents.send('menu:<cmd>')`，preload 把這些事件聚合成 `window.api.onMenu(handler)`，由 `App.tsx` 在 `useEffect` 內 dispatch。要新增選單命令時，三個地方都要動：`src/main/menu.ts`、`src/preload/index.ts`（加到 `wrap()` 或走 `menu:command`）、`src/renderer/src/App.tsx` 的 switch。

**檔案格式（`.snote` / `.md`，試算表見下節）**

格式的判斷邏輯集中在 `src/renderer/src/noteFormat.ts`：

- `.snote`（預設）：JSON，內容為 `{ format: 'simple-note', version, columnLayout, columnSplit, columns: { left, middle, right } }`，三欄各存一份 BlockNote block tree。由 `DocumentView.buildSnote()` 產生、`loadContent()` 還原（`parseSnote` 回傳 null 就當成 Markdown 解析，所以載入時不需要看副檔名）。
- `.md` / `.txt`：純 Markdown，內容由 `editor.blocksToMarkdownLossy` 產生。雙欄展開時 `buildMarkdown` 依「畫面左欄在上、右欄在下」合併兩欄，空白欄略過。
- Markdown 開頭的 YAML front matter（第一行 `---`、第二行是 `key:`）由 `splitFrontMatter` 在載入時切出來存在 `DocumentView` 的 `frontMatterRef`，不進編輯器，`buildMarkdown` 時原文接回最前面。原因是 BlockNote 會把 `---` 解析成分隔線與 setext 標題，存回去變成 `***` 與一長串 `-`，弄壞 Claude Code Skill 的 `SKILL.md` 這類靠 front matter 運作的檔案。因此 front matter 在 App 內看不到也改不了。

Renderer 每次存檔都同時算出兩種內容（`{ markdown, snote }`）交給 main，**由目標檔案的副檔名決定寫入哪一份**（`contentForPath`，`.md`/`.txt`/`.csv` 走純文字那份，其餘走 snote）。`file:save`、`file:saveAs` 都是這個約定；存檔對話框依建議檔名的副檔名決定篩選器（筆記 `.snote`/`.md`，試算表 `.ssheet`/`.csv`），筆記新檔／另存預設 `.snote`，對話框預設位置是下載資料夾，未命名筆記以第一個標題當建議檔名。

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
- 驗證整個 App（含 main 端、多視窗、Finder 開檔）：`npx electron-builder --dir --mac --arm64 -c.mac.identity=null` 快速打包，`open -a "dist/mac-arm64/Simple Note.app" <檔案...> --args --remote-debugging-port=9555` 啟動後，用 Node 的 `fetch('http://127.0.0.1:9555/json')` + `WebSocket` 送 `Runtime.evaluate` 檢查 DOM 與操作。不要用 9333，那個 port 是 Simple Gmail 在用。App 在背景時 `focus()` / `blur()` 不會觸發事件（例如分頁重新命名的輸入框按 Enter 不會送出），測之前先用 System Events 把 App 切到前景。macOS 會把「偏好設定…」自動改名成「設定⋯」，用 System Events 點選單時要用改名後的文字。原生對話框（儲存提醒）可用 System Events 的 `sheet 1 of window 1` 讀文字與按按鈕，但存檔面板讀不到。分頁拖放可用 CDP 模擬：`Input.setInterceptDrags` 開啟後以 `Input.dispatchMouseEvent` 按住分頁並移動，從 `Input.dragIntercepted` 取得 drag data，再用 `Input.dispatchDragEvent`（dragEnter／dragOver／drop）送到目標座標；這樣送出的事件 `isTrusted` 為 true，BlockNote 補送的那份則為 false。

**編輯器核心 (`src/renderer/src/editor/`)**

- Schema（`schema.ts`）：BlockNote 預設 block 加上自訂的 `image`、`toggle`、`divider`，以及自訂 style `redText`（紅字標記）。
- 透過 BlockNote 的 `createBlockNoteExtension` API 注入 ProseMirror plugin（大多在 `Editor.tsx` 的 extensions 陣列），key 都以 `simple-note-` 開頭，例如：
  - `simple-note-math`：數學模式 overlay (見下節)。
  - `simple-note-select-all`：兩段式 Cmd+A，第一次選整個 block，第二次才全選整份文件。
  - `simple-note-find`：尋找與取代的高亮 (見下節)。
  - `simple-note-block-delete`、`simple-note-codeblock-select`：整塊選取與刪除。
  - `simple-note-heading-enter`：在標題開頭或結尾按 Enter 會留下一般段落，而不是再產生一個標題。
  - 其他：`code-highlight` (lowlight 語法上色)、`code-wrap`、`selection-clamp`、`toggle-keys`、`paste-link`、`youtube`。
- 鍵盤快捷鍵：Cmd+1 段落、Cmd+2 折疊清單 (toggle)、Cmd+3 項目符號、Cmd+4 程式碼區塊、Cmd+5 checkbox、Shift+Cmd+D 引言、Shift+Cmd+S 刪除線、Shift+Cmd+X inline code、Shift+Cmd+V 貼成純文字、Opt+Cmd+1/2/3 H1/H2/H3、Opt+Cmd+V 紅字。
- 折疊清單是自訂 block `toggle`（`editor/toggle.tsx`）。**注意：不要改用 BlockNote 內建的 `toggleListItem`——在 0.40 版透過 BlockNoteView 渲染時它沒有箭頭、不能折疊（core 的 render 只對 isToggleable 的 heading 加 toggle UI，`toggleListItem` 沒有該 prop），會退化成普通段落。** 我們自繪 `.bn-toggle-wrapper` + `.bn-toggle-button`（沿用 BlockNote CSS：`data-show-children=false` 時隱藏子 `.bn-block-group`），展開/關閉狀態存在 block 的 `open` prop（活在文件模型中，不像 BlockNote 內建的 `ToggleWrapper` 存在 localStorage；存成 `.snote` 時會一併保存；存成 `.md` 則不會）。
- toggle 的 Notion 式互動由 `createToggleKeyboardExtension()`（在 `Editor.tsx` 的 extensions 內）提供：游標在 toggle 標題列按 Enter，展開時在內側新增子 block 並把游標移入、關閉時在下方新增 sibling toggle（像 list item）；Cmd/Ctrl+Enter 切換展開/關閉。**新增 sibling toggle 後必須用 `requestAnimationFrame` 才能把游標移入新 block——它是 React node view，內容 DOM 要等 React 繪製後才存在，同步設游標會失效。** Cmd+2 在 `Editor.tsx` 把目前 block 轉成 `toggle`。
- Toggle 跨 App 剪貼簿（Simple Canvas、Notion）：`editor/toggleClipboard.ts`（與 Simple Canvas 共用同一份，改了要兩邊同步）。BlockNote 輸出外部 HTML 時會把子 block 攤平，所以 `Editor.tsx` 在 copy/cut 時若選取含 toggle，就用 `toggleBlocksToHTML` 把 `text/html` 換成 `<details><summary>`，並加寫 Notion 私有的 `text/_notion-blocks-v3-production` 區塊 JSON（Notion 的 HTML 把 Toggle 輸出成一般 `<ul><li>`，也不認得 `<details>`，只認這份 JSON）。貼上時沒有 `blocknote/html` 才處理：`<details>` 或 Notion JSON 經 `htmlToToggleBlocks` 轉成 block，插在目前 block 之後。
- 左側把手（`editor/sideMenu.tsx`，自繪，不用 BlockNote 的 SideMenu）：拖曳移動 block；單純點一下會把整個 block（含子 block）設成 blockContainer 的 NodeSelection，由 `editor.css` 的 `.bn-block-outer.ProseMirror-selectednode > .bn-block` 反白，之後可直接複製、剪下或刪除。沒有彈出選單。注意 BlockNote 的 `getSelection()` 在這種選取下回傳 undefined，需要時改從 `selection.node.attrs.id` 取 block。
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

**分頁、分割窗格與視窗**

- 每個分頁是 `store.ts` 的一個 `Tab`，`kind` 為 `editor`（`DocumentView`）或 `sheet`（`SheetView`）。分頁的 view 一直掛著、非作用中時只是隱藏，所以各自保有復原紀錄、游標與捲動位置。App shell 透過 `getDocumentView(tabId)` 取得 `DocumentViewHandle` 操作特定分頁。
- 最多三個分割窗格（`panes`，上限 `MAX_PANES`）：分頁拖放規則集中在 `App.tsx` 的 `paneDropForPoint`（工作區 capture 階段處理，靠 `.editor-pane` 的 `data-pane-id` 判斷目標窗格）：放在另一個窗格內文區左半側時兩個窗格整組對調位置 (`swapPaneTabs`，寬度留在原位)；放在右半側時在該窗格右邊新增一欄 (`splitTabBesidePane`，所有窗格重設為等寬)，已滿三欄則改成對調；放在自己所在窗格的左／右半側時在該側分割出新窗格（該窗格只剩一個分頁或已滿三欄時不動作）；放在另一個窗格的分頁列則移入該窗格 (`moveTabToPane`)，來源窗格因此清空時就消失（等於合併）。拖曳中 `.split-drop-overlay` 預覽落點（對調蓋住整個目標窗格，分割蓋住一半）。沒有使用修飾鍵：macOS 拖曳時 `DragEvent.metaKey` 不可靠。每個窗格的寬度存在 `TabPane.size`（flex-grow），拖曳分隔線只在相鄰兩欄之間調整（`resizePanes`）。踩過的坑：BlockNote 會把拖放事件再派送一份到編輯器上（座標夾在編輯器內，`isTrusted` 為 false），連放在分頁列的 drop 都會，而且比分頁列的處理更早抵達工作區，被當成內文區的對調或分割，所以工作區的 dragover／drop 一律忽略 `!e.nativeEvent.isTrusted` 的事件。分頁移到另一個窗格時 React 會重新掛載 view，所以 `stageTabForPaneMove` 先把內容存進 `initialMarkdown`，並用 `restoreDirtyAfterLoad` 保留 dirty 狀態。
- App 沒有側邊欄與儲存庫（已移除）。所有文件都要手動存檔：編輯後分頁出現未存檔圓點，關閉未存檔分頁時 `closeTabWithChecks` 會先詢問儲存／不儲存／取消（`file:confirmCloseDirty`），選「不儲存」時不再做 `.snote` 轉存詢問。圖片從 Finder 拖入時以絕對路徑引用，貼上的圖片以 data URL 存在文件內。
- 啟動時一律只開一個未存檔的空白筆記。從 Finder 雙擊文件或以文件建立新視窗時，main 先將文件放入 `pendingOpenByWebContents`。`App.tsx` 註冊檔案事件後呼叫 `window.api.notifyReady()`（`renderer:ready` 使用 invoke / handle），main 才把排隊的文件送出；原本的空白分頁由 `openFileInTab` 移除。初始化以 ref 保護，避免 React StrictMode 重跑；main 快取每個視窗的啟動結果並在關閉時清除。
- 從 Finder 一次開啟多個檔案時都開在同一個視窗的不同分頁：第一個視窗建立前 (`initialWindowCreated` 為 false) 收到的 `open-file` 都先進 `coldStartPaths`，不能只看 `app.isReady()`，否則 ready 之後、視窗建立之前到達的檔案會各自開新視窗。
- 分頁右鍵「開啟在新視窗」是「移動」：`moveTabToNewWindow` 把分頁的 snote 內容、路徑、dirty 狀態與 kind 經 `window:moveTab` 交給 main 開新視窗（新視窗以 `openDocumentPayload` + `restoreDirtyAfterLoad` 還原），再從原視窗移除該分頁；原視窗只剩它一個分頁時直接關閉原視窗。未命名分頁也可以移動。
- 分頁也能拖到另一個視窗的分頁列合併，依藍色插入線決定位置。`src/main/tab-transfer.ts` 以拖曳 token 找到來源視窗，透過 renderer 的 `snapshotTabForTransfer`／`receiveTransferredTab`／`finishTabTransfer` 完成搬移；目標確認內容載入後才移除來源，來源只剩一個分頁時自動關閉視窗。保留自訂分頁名稱、檔案路徑、dirty、三欄內容、折疊／格式、試算表公式與樣式，以及 Markdown 的 YAML front matter（`initialFrontMatter`，載入後回到 `frontMatterRef`）。跨視窗合併不覆蓋目標原有分頁，也不合併同路徑的文件。拖曳期間 main 廣播 `window:tabDragState`，暫時把所有分頁列的空白區改成 `no-drag`，讓原本可拖動視窗的區域也能接收分頁；放開後恢復。分頁列同樣忽略 BlockNote 重送的非 trusted 拖放事件。
- 分頁右鍵「重新命名」在分頁上就地編輯名稱（Enter 確定、Esc 取消）：已存檔的分頁經 `file:rename` 在同一資料夾改檔名、保留副檔名，已有同名檔案時拒絕；未命名分頁只改 `fileName`，第一次存檔時優先用它當建議檔名（沒改過才用第一個標題）。
- 分頁右鍵「全部儲存」：renderer 呼叫 `window.api.window.saveAll()`（`window:saveAll`），main 逐一對每個視窗執行 `window.__simpleNote_save()`（與關閉視窗時的「儲存」共用），一次只處理一個視窗，讓未命名分頁的存檔對話框不會同時跳出。踩過的坑：`file:save` 會把視窗標題改成剛寫入的檔名，存到背景分頁時標題會錯，所以 `__simpleNote_save` 結束時會把標題與 edited 圓點還原成作用中分頁。
- 啟動時由 `src/renderer/src/main.tsx` 的 `bootstrap()` 先讀取偏好設定還原至 store，完成後才掛載 React。讀取失敗時會記錄錯誤並使用預設設定啟動。

**狀態管理 (`src/renderer/src/store.ts`)**

使用 Zustand，存放分頁、窗格與偏好設定。`dirty` 旗標由編輯器（或試算表）的變更觸發；`fileName` 從 `filePath` 衍生（去掉 `.md` / `.snote` / `.ssheet`，`.csv` 刻意保留，讓使用者看得出是會遺失格式的格式）。`Preferences` 同時定義於 `src/renderer/src/store.ts` 與 `src/main/preferences.ts`，**新增偏好欄位時兩邊都要改**，並且要更新 `App.tsx` 內把 preference 套用到 CSS variable 的 `useEffect`。

**右鍵選單與文字轉換 (`src/renderer/src/context-menu/`)**

命令清單集中在 `commands.ts` 的 `MENU_COMMANDS`：簡轉繁（`opencc-js`）、半形標點轉全形、清除格式、移除超連結（命令 key 仍是舊名 `stripLinksAndCitations`，保留使用者自訂的順序與名稱）、段落／分行轉換、字數統計、拼音查詢（`pinyin-pro`）、嘸蝦米查碼、Google 搜尋，以及中英互譯（透過 main 端 `openrouter.ts` 的 `ai:run` 呼叫 OpenRouter，需在偏好設定的 API Keys 填金鑰；結果一律取代選取文字）。使用者可在偏好設定「右鍵選單」頁調整順序、顯示與名稱、插入分隔線，存在 `preferences.menuCommands`；新增命令時 `reconcileMenuCommands` 會把它插到原本順序中的相鄰位置。部分命令也能從 macOS 應用選單（編輯 → ...）叫出，兩者透過 `window.dispatchEvent(new CustomEvent('simple-note:command', ...))` 統一處理。右鍵選單開啟後會用 `useLayoutEffect` 量測尺寸並把位置夾進可視範圍，過長時靠 CSS `max-height` + `overflow-y` 捲動。

**樣式與排版**

- 全域樣式：`src/renderer/src/theme.css`、`editor.css`。版面寬度／行高／段落間距／頂端 padding 都是 CSS 變數，由 `App.tsx` 從 preferences 動態設定（`--page-width`、`--line-height`、`--paragraph-spacing`、`--top-padding`）。
- 版面寬度、段落間距、上方留白與標題大小的滑桿在「微調面板」(`preferences/TweaksPanel.tsx`，應用程式選單 → 微調面板⋯，沒有快捷鍵)，不在偏好設定裡。面板是沒有遮罩的浮動 div，拖曳標題列移動、CSS `resize: both` 縮放，滑桿用 auto-fill grid 隨寬度換欄；改動即時寫入 store 並 `prefs.set` 存檔，不走取消／確定。偏好設定面板因此只在按「確定」時寫回它自己管的欄位 (右鍵選單、API Keys)，避免舊 draft 蓋掉微調面板的改動。新增空白筆記的第一行一律是內文。
- 視窗使用 `titleBarStyle: 'hiddenInset'`，拖曳視窗靠分頁列 `.tab-bar` 的 `-webkit-app-region: drag`（互動元件各自設 `no-drag`）；第一個窗格的分頁列 (`.clear-traffic-lights`) 左側固定讓出 78px 給紅綠燈按鈕。`theme.css` 裡的 `.drag-bar` 樣式已沒有元件使用。
- 顏色以 `theme.css` `:root` 的 CSS 變數定義，深色模式跟隨系統 `prefers-color-scheme`；試算表另有自己的色票變數（`sheet/sheet.css`）。
