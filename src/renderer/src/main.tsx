import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { useStore, type Preferences } from './store';
import './theme.css';
import '@blocknote/core/fonts/inter.css';
import '@blocknote/mantine/style.css';
import './editor.css';

async function bootstrap(): Promise<void> {
  // Restore the persisted layout before mounting the shell, so a closed
  // sidebar never paints open or animates closed during startup.
  try {
    const stored = (await window.api.prefs.get()) as Partial<Preferences>;
    const state = useStore.getState();
    state.setPreferences(stored);
    state.setSidebarOpen(stored.sidebarOpen ?? state.preferences.sidebarOpen);
    state.setSortMode(stored.sortMode ?? state.preferences.sortMode);
    state.setSortAsc(stored.sortAsc ?? state.preferences.sortAsc);
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
