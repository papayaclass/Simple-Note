import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { useStore, type Preferences } from './store';
import './theme.css';
import '@blocknote/core/fonts/inter.css';
import '@blocknote/mantine/style.css';
import './editor.css';

async function bootstrap(): Promise<void> {
  // Restore the persisted preferences before mounting the shell, so the first
  // paint already uses the user's layout.
  try {
    const stored = (await window.api.prefs.get()) as Partial<Preferences>;
    useStore.getState().setPreferences(stored);
  } catch (error) {
    console.error('Failed to restore startup preferences', error);
  }

  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}

void bootstrap();
