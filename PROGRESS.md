**2026-11-06：貼成純文字快捷鍵與本機安裝**

- 將應用程式選單、筆記編輯器與試算表的貼成純文字快捷鍵統一為 Shift + Option + Cmd + V，移除原本自訂的 Shift + Cmd + V 綁定。保留以實體按鍵 code 判斷，避免 Option 改變按鍵字元造成失效。
- 驗證：兩組 TypeScript 型別檢查、production build 與 git diff --check 通過；已確認封裝內選單使用新快捷鍵。未執行實際鍵盤互動測試。
- 使用 Developer ID Application: Mu-Hua Wang (7Y3SNMCD34) 製作 Universal 本機版本，含 hardened runtime 與時間戳記；依本機模式略過公證與 DMG。
- 建置產物與 /Applications/Simple Note.app 的深度嚴格簽章檢查均通過，app.asar 完全一致；已用 open 啟動安裝版，並確認持續執行。CDHash：30e0907a37ce5793759135597fda59a9621ccced。
- 沙箱內 codesign 曾誤報 invalid signature，於沙箱外重新驗證通過。
