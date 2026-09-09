import { Menu, MenuItemConstructorOptions, app } from 'electron';

export interface MenuHandlers {
  onNew: () => void;
  onOpen: () => void;
  onSave: () => void;
  onPrint: () => void;
  onPreferences: () => void;
  onCommand: (cmd: string) => void;
}

export function buildMenu(h: MenuHandlers): void {
  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        {
          label: '偏好設定…',
          accelerator: 'Alt+CmdOrCtrl+P',
          click: () => h.onPreferences(),
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: '檔案',
      submenu: [
        { label: '新增', accelerator: 'CmdOrCtrl+N', click: () => h.onNew() },
        { label: '開啟…', accelerator: 'CmdOrCtrl+O', click: () => h.onOpen() },
        { type: 'separator' },
        { label: '儲存', accelerator: 'CmdOrCtrl+S', click: () => h.onSave() },
        { label: '列印', accelerator: 'CmdOrCtrl+P', click: () => h.onPrint() },
        { type: 'separator' },
        {
          label: '關閉',
          accelerator: 'CmdOrCtrl+W',
          click: () => h.onCommand('close-tab-or-window'),
        },
      ],
    },
    {
      label: '編輯',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        {
          label: '貼成純文字',
          accelerator: 'Shift+CmdOrCtrl+V',
          click: () => h.onCommand('paste-plain'),
        },
        { role: 'selectAll' },
        { type: 'separator' },
        {
          label: '尋找…',
          accelerator: 'CmdOrCtrl+F',
          click: () => h.onCommand('find'),
        },
        {
          label: '尋找並取代…',
          accelerator: 'Alt+CmdOrCtrl+F',
          click: () => h.onCommand('find-replace'),
        },
        {
          label: '找下一個',
          accelerator: 'CmdOrCtrl+G',
          click: () => h.onCommand('find-next'),
        },
        {
          label: '找上一個',
          accelerator: 'Shift+CmdOrCtrl+G',
          click: () => h.onCommand('find-prev'),
        },
        { type: 'separator' },
        {
          label: '簡體轉繁體',
          click: () => h.onCommand('s2t'),
        },
        {
          label: '半形標點轉全形',
          click: () => h.onCommand('half2full'),
        },
        {
          label: '清除所有格式',
          click: () => h.onCommand('clear-format'),
        },
        {
          label: '移除段落符號',
          click: () => h.onCommand('remove-paragraph-breaks'),
        },
        {
          label: '插入 Lorem Ipsum',
          click: () => h.onCommand('lorem'),
        },
        {
          label: '字數統計',
          click: () => h.onCommand('word-count'),
        },
      ],
    },
    {
      label: '檢視',
      submenu: [
        {
          label: '切換側邊欄',
          accelerator: 'Shift+CmdOrCtrl+F',
          click: () => h.onCommand('toggle-sidebar'),
        },
        { type: 'separator' },
        {
          label: '將文章推往左側',
          accelerator: 'Shift+CmdOrCtrl+Left',
          click: () => h.onCommand('push-article-left'),
        },
        {
          label: '將文章推往右側',
          accelerator: 'Shift+CmdOrCtrl+Right',
          click: () => h.onCommand('push-article-right'),
        },
        { type: 'separator' },
        {
          label: '切換數學模式',
          accelerator: 'Shift+CmdOrCtrl+M',
          click: () => h.onCommand('toggle-math'),
        },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' },
      ],
    },
    {
      label: '視窗',
      role: 'windowMenu',
    },
    {
      role: 'help',
      submenu: [],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}
