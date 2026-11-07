// Light/dark tone, exactly as the mockup, plus server sync via settings.theme.
import { patch } from './api.ts';
import { state, $ } from './state.ts';
import type { ValueEl } from './ui.ts';

export const isLight = (): boolean => document.documentElement.dataset.theme === 'light';

let syncing = false;

export function setTone(l: boolean, persist = true): void {
  document.documentElement.dataset.theme = l ? 'light' : 'dark';
  const skin = $('#skin');
  if (skin) skin.innerHTML = l ? '☾ <span class="lbl">Dark</span>' : '☀ <span class="lbl">Light</span>';
  try { localStorage.setItem('hq-tone', l ? 'light' : 'dark'); } catch { /* ignore */ }
  const sel = document.querySelector<ValueEl>('#s-theme');
  if (sel) sel.value = l ? 'Light' : 'Dark';
  const theme = l ? 'light' : 'dark';
  if (persist && !syncing && state.me && state.me.settings.theme !== theme) {
    state.me.settings.theme = theme;
    patch('/api/settings', { theme }).catch(() => { /* non-fatal */ });
  }
}

export function initTheme(): void {
  let saved: string | null = null;
  try { saved = localStorage.getItem('hq-tone'); } catch { /* ignore */ }
  setTone(saved ? saved === 'light' : (document.documentElement.dataset.theme === 'light' || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: light)').matches)), false);
  $('#skin').onclick = () => setTone(!isLight());
}

/** First load after sign-in: the server setting wins over localStorage. */
export function applyServerTheme(theme: 'dark' | 'light'): void {
  syncing = true;
  setTone(theme === 'light', false);
  syncing = false;
}

export function applyDensity(d: 'comfortable' | 'compact'): void {
  if (d === 'compact') document.documentElement.dataset.density = 'compact';
  else delete document.documentElement.dataset.density;
}
