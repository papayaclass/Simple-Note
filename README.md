# Simple Note

極簡 Block 式筆記桌面應用，介面為繁體中文。以 Electron + React + BlockNote 打造，
筆記預設以 App 專用的 .snote 格式儲存（完整保留紅字、折疊清單、雙欄版面等），
也能直接編輯與儲存純 Markdown（.md）檔案，並隨時匯出成 Markdown。

## 主要功能

- Block 式編輯器：標題、清單、折疊清單 (Toggle)、待辦事項、程式碼區塊、引言、分隔線
- 兩種格式：專用的 .snote 完整保留格式，.md 檔則維持純 Markdown 儲存，可互相匯出／轉存
- 側邊欄筆記庫與分頁：以資料夾管理筆記、多文件分頁切換
- 雙欄對照：可將文章推往左右兩側並排編輯
- 數學模式（⇧⌘M）：在行尾即時顯示計算結果，支援變數
- 圖片插入與預覽：貼上或拖曳插入圖片，可縮放預覽
- YouTube 預覽卡：貼上連結自動顯示標題、頻道與觀看數
- 右鍵文字工具：簡體轉繁體、半形標點轉全形、清除格式、字數統計、拼音查詢、嘸蝦米查碼
- AI Skill：透過 OpenRouter 呼叫 AI 處理選取文字（需自備 API Key）
- 列印、多視窗支援

## 下載

請前往 [Releases](https://github.com/papayaclass/Simple-Note/releases/latest) 頁面
下載最新的 .dmg 安裝檔。

## 系統需求

- macOS 11 (Big Sur) 或以上
- 同時支援 Apple Silicon 與 Intel 晶片（Universal Binary）

## 安裝方式

- 下載並打開 .dmg，將 Simple Note 拖入「應用程式」資料夾。
- 本 App 已經過 Apple 公證 (Notarized)。第一次開啟時若 Gatekeeper 出現
  「Apple 已檢查此 App 是否含有惡意軟體」的提示，按「打開」即可正常使用。

## 隱私

- 所有筆記皆儲存在本機，不會上傳到任何伺服器。
- OpenRouter AI 功能需自行在偏好設定中填入 API Key 才會啟用；API Key 僅儲存在本機。

## 授權

本專案以 MIT License 釋出，詳見 LICENSE。

## 聯絡方式

如有問題或建議，歡迎到 GitHub Issues 回報，或來信
702765+papayaclass@users.noreply.github.com。
