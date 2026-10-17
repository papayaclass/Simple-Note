import type { OpenDocumentPayload, SimpleNoteAPI } from '../../preload';

declare global {
  interface Window {
    api: SimpleNoteAPI;
    __simpleNote_beforeClose?: () => Promise<boolean>;
    __simpleNote_isDirty?: () => boolean;
    __simpleNote_save?: () => Promise<boolean>;
    __simpleNote_snapshotTab?: (tabId: string) => Promise<OpenDocumentPayload | null>;
    __simpleNote_receiveTab?: (doc: OpenDocumentPayload, paneId: string, index: number) => Promise<boolean>;
    __simpleNote_finishTabTransfer?: (
      tabId: string,
      snapshot: OpenDocumentPayload
    ) => Promise<{ empty: boolean } | null>;
  }
}

declare module 'opencc-js';
