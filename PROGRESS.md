**2026-11-09：試算表填滿控點與 F4 絕對參照、本機安裝**

- 試算表選取範圍右下角新增 Excel 式填滿控點：拖曳時以灰色虛線框預覽，放開後依主要方向 (上下或左右) 循環複製來源格，公式的相對參照隨位移調整，`$` 鎖定的參照不變，可復原。
- 編輯公式時按 F4 切換游標所在參照：A1 → $A$1 → A$1 → $A1 → A1，範圍 (A1:B3) 兩端一起切換，字串內的文字不受影響。Mac 鍵盤若 F4 被系統功能占用，需搭配 fn。
- 驗證：兩組 TypeScript 型別檢查通過；以 tsx 測試 `cycleAbsoluteAt` 循環與 `shiftRelative`；arm64 測試版以 CDP 實際拖曳 D2 控點到 D5，得到 700、1700、7700、8500，選取變為 D2:D5；在 E2 輸入 =B2*C2 後按兩次 F4 得到 =B2*$C$2、=B2*C$2。未測試向上／向左填滿與雙擊控點 (雙擊無動作)。
- 使用 Developer ID 製作 Universal 本機版本，依本機模式略過公證與 DMG；/Applications 安裝版深度嚴格簽章檢查通過並已啟動。CDHash：c3c753b92af21cbe61aadb33c7fbf3eed110b01d。

**2026-11-06：貼成純文字快捷鍵與本機安裝**

- 將應用程式選單、筆記編輯器與試算表的貼成純文字快捷鍵統一為 Shift + Option + Cmd + V，移除原本自訂的 Shift + Cmd + V 綁定。保留以實體按鍵 code 判斷，避免 Option 改變按鍵字元造成失效。
- 驗證：兩組 TypeScript 型別檢查、production build 與 git diff --check 通過；已確認封裝內選單使用新快捷鍵。未執行實際鍵盤互動測試。
- 使用 Developer ID Application: Mu-Hua Wang (7Y3SNMCD34) 製作 Universal 本機版本，含 hardened runtime 與時間戳記；依本機模式略過公證與 DMG。
- 建置產物與 /Applications/Simple Note.app 的深度嚴格簽章檢查均通過，app.asar 完全一致；已用 open 啟動安裝版，並確認持續執行。CDHash：30e0907a37ce5793759135597fda59a9621ccced。
- 沙箱內 codesign 曾誤報 invalid signature，於沙箱外重新驗證通過。
