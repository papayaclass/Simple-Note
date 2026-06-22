import { Menu, MenuItemConstructorOptions, app } from 'electron';

export interface MenuHandlers {
  onNew: () => void;
  onOpen: () => void;
  onSave: () => void;
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
        { type: 'separator' },
        { role: 'close' },
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
          label: '切換雙欄',
          accelerator: 'Shift+CmdOrCtrl+2',
          click: () => h.onCommand('toggle-column'),
        },
        { type: 'separator' },
        {
          label: '切換數學模式',
          accelerator: 'Shift+CmdOrCtrl+1',
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
