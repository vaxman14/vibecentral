// Vibe Central web entry: auth check → shell → hash router. Keeps the sidebar chip and the header badge fresh.
import type { MeDTO } from '@shared/types.ts';
import { ago } from '@shared/util.ts';
import { get, initApi, setUnauthorizedHandler } from './api.ts';
import { fetchStatus, showSignIn, signOut } from './auth.ts';
import { initPalette } from './palette.ts';
import { drawNav, parseHash, render } from './router.ts';
import { state, $ } from './state.ts';
import { initSwitcher } from './switcher.ts';
import { applyDensity, applyServerTheme, initTheme } from './theme.ts';

export function updateShell(me: MeDTO): void {
  state.me = me;
  const s = me.sync;
  $('#chipMain').textContent = s.allOk ? 'All sources synced' : `${s.failing} account${s.failing === 1 ? '' : 's'} need${s.failing === 1 ? 's' : ''} attention`;
  $('#chipSub').textContent = `${s.accounts} account${s.accounts === 1 ? '' : 's'} · ${s.providers} provider${s.providers === 1 ? '' : 's'}`;
  $('#chipDot').style.background = s.allOk ? '' : 'var(--warning)';
  $('#acctName').textContent = me.user.name;
  $('#av').textContent = me.user.initials;
  applyBranding(me.branding);
  tickFresh();
  const { page, pid } = parseHash();
  drawNav(pid ? 'projects' : page);
}

export function tickFresh(): void {
  const s = state.me?.sync;
  const el = $('#fresh');
  if (!s) return;
  el.textContent = s.oldestSyncAt ? `● Synced · ${ago(s.oldestSyncAt)}` : (s.accounts ? '● Syncing…' : '● No accounts yet');
  el.className = 'fresh' + (s.allOk ? '' : ' warn');
  el.title = s.allOk ? 'Every account synced' : `${s.failing} failing`;
}

async function poll(): Promise<void> {
  try { updateShell(await get<MeDTO>('/api/me')); } catch { /* keep the old chip */ }
}

async function boot(): Promise<void> {
  await initApi();
  initTheme();
  setUnauthorizedHandler(() => showSignIn(null));
  let status;
  try { status = await fetchStatus(); } catch (e) { showSignIn(null, e instanceof Error ? e.message : 'Cannot reach the server'); return; }
  if (!status.signedIn) { showSignIn(status); return; }

  let me: MeDTO;
  try { me = await get<MeDTO>('/api/me'); } catch (e) { if ((e as { status?: number }).status !== 401) showSignIn(null, e instanceof Error ? e.message : String(e)); return; }
  applyServerTheme(me.settings.theme);
  applyDensity(me.settings.density);
  updateShell(me);

  initSwitcher();
  initPalette();
  $('#signOut').onclick = () => signOut();
  window.addEventListener('hashchange', render);
  await render();

  setInterval(poll, 60_000);
  setInterval(tickFresh, 30_000);
}

boot();

/** Fill every place the shell names the app from the server's branding (env + database). */
export function applyBranding(b: { appName: string; host: string; ownerName?: string } | undefined): void {
  if (!b) return;
  document.title = b.appName;
  const set = (sel: string, text: string) => { const el = document.querySelector(sel); if (el) el.textContent = text; };
  set('#brandName', b.appName); set('#brandHost', b.host);
  const img = document.querySelector<HTMLImageElement>('#brandImg'); if (img) img.src = '/brand/vibecentral-mark.svg'; // loaded: static mark
  set('#credit', b.appName); set('#footName', `${b.appName} · read-only view of your accounts`);
}
