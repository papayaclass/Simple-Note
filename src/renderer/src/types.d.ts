import type { SimpleNoteAPI } from '../../preload';

declare global {
  interface Window {
    api: SimpleNoteAPI;
    __simpleNote_isDirty?: () => boolean;
    __simpleNote_save?: () => Promise<boolean>;
  }
}

declare module 'opencc-js';
