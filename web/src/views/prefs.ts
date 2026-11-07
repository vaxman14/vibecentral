// Settings: the 7 sections of the mockup, every control saves immediately via PATCH /api/settings.
import type { ConnectionsDTO, PasskeyDTO, SessionDTO, Settings } from '@shared/types.ts';
import { ago, esc } from '@shared/util.ts';
import { manageAccountDialog } from '../accounts.ts';
import { cached, del, get, invalidate, patch, post } from '../api.ts';
import { defaultPasskeyLabel, registerPasskey } from '../auth.ts';
import { confirmDialog, f, flashSaved, openDialog, toast } from '../dialogs.ts';
import type { ViewFn } from '../router.ts';
import { state } from '../state.ts';
import { applyDensity, isLight, setTone } from '../theme.ts';
import { dateOf, fld, sw } from '../ui.ts';
import type { ValueEl } from '../ui.ts';
import { TITLES } from '../router.ts';

const SECTIONS = ['Profile', 'Sign-in & security', 'Connections', 'Sync', 'Notifications', 'Appearance', 'Data & export', 'Setup keys'];
const TZS = ['America/Los_Angeles', 'America/Denver', 'America/Phoenix', 'America/Chicago', 'America/New_York', 'America/Anchorage', 'Pacific/Honolulu', 'UTC'];
// TODO(contract): Settings.notifications is Record<string, boolean> with no key list in types.ts; these keys are the web app's convention.
const NOTIF: [string, string, string][] = [
  ['failedDeploys', 'Failed deploys', 'Email you'],
  ['domainExpiry', 'Domains about to expire', '30 days ahead'],
  ['appReview', 'App review changes', 'App Store and Google Play'],
  ['newRevenue', 'New revenue', 'Stripe and PayPal'],
  ['tokenFailure', 'Sync token failures', 'When a token stops working or expires'],
  ['syncErrors', 'Sync errors', 'Any failed sync, not just tokens'],
  ['newBuilds', 'New app builds', 'App Store Connect uploads'],
];

const S = (): Settings => state.me!.settings;

async function save(partial: Partial<Settings>, ctl: Element | null): Promise<void> {
  try {
    const next = await patch<Settings>('/api/settings', partial);
    if (next && typeof next === 'object') state.me!.settings = { ...S(), ...partial, ...next };
    else Object.assign(S(), partial);
    invalidate('/api/me');
    flashSaved(ctl);
  } catch (e) { toast(String((e as Error).message), 'bad'); }
}

const opt = (list: [string, string][], cur: string) => list.map(([v, l]) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(l)}</option>`).join('');

const SET: ((root: HTMLElement, refresh: () => void) => Promise<string> | string)[] = [
  // Profile
  () => {
    const s = S();
    const tzs = TZS.includes(s.tz) ? TZS : [s.tz, ...TZS];
    const pages: [string, string][] = ['overview', 'projects', 'tasks'].map((k) => [k, TITLES[k]]);
    if (!pages.some((p) => p[0] === s.startPage) && TITLES[s.startPage]) pages.push([s.startPage, TITLES[s.startPage]]);
    return `<h2>Profile</h2>${fld('Name', 'Shown in the sidebar', `<input class="in" id="s-name" value="${esc(s.name)}">`)}${fld('Time zone', 'Used for calendars and history', `<select class="in" id="s-tz">${opt(tzs.map((z) => [z, z]), s.tz)}</select>`)}${fld('Start page', 'What opens after sign-in', `<select class="in" id="s-start">${opt(pages, s.startPage)}</select>`)}`;
  },
  // Sign-in & security
  async () => {
    const s = S();
    let keys: PasskeyDTO[] = [], sessions: SessionDTO[] = [];
    try { [keys, sessions] = await Promise.all([get<PasskeyDTO[]>('/api/auth/passkeys'), get<SessionDTO[]>('/api/auth/sessions')]); } catch (e) { toast(String((e as Error).message), 'bad'); }
    const emails = s.emails.length ? s.emails.join(', ') : '—';
    void keys; void dateOf; void ago; // passkeys are not offered (Google only)
    return `<h2>Sign-in & security</h2>${fld('Sign in with Google', `Only these accounts can sign in: ${esc(emails)}`, sw(true))}${fld('Session length', 'How long you stay signed in on a device', `<select class="in" id="s-sess">${opt([['30', '30 days'], ['7', '7 days'], ['1', '1 day']], String(s.sessionDays))}</select>`)}${fld('Active sessions', `${sessions.length || 1} device${sessions.length === 1 ? '' : 's'}${sessions.length > 1 ? ` · ${sessions.filter((x) => !x.current).map((x) => x.deviceLabel || x.method).join(', ')}` : ''}`, '<button class="act" type="button" id="s-outothers">Sign out others</button>')}`;
  },
  // Connections
  async () => {
    const d = await cached<ConnectionsDTO>('/api/connections');
    const n = d.providers.reduce((a, c) => a + c.accounts.length, 0);
    const withAccounts = d.providers.filter((p) => p.accounts.length);
    return `<h2>Connections</h2><p class="muted" style="margin:0 0 8px;font-size:14px">${n} account${n === 1 ? '' : 's'} across ${withAccounts.length} provider${withAccounts.length === 1 ? '' : 's'}, all read-only.</p>${withAccounts.length ? withAccounts.map((c) => fld(esc(c.name), esc(c.accounts.map((a) => a.label).join(', ')), c.accounts.map((a) => `<button class="act" type="button" data-manage="${esc(a.id)}">${c.accounts.length > 1 ? `Manage ${esc(a.label.length > 14 ? a.label.slice(0, 13) + '…' : a.label)}` : 'Manage'}</button>`).join(''))).join('') : '<p class="muted" style="margin:0">Nothing connected yet. Add accounts under <a href="#connections">Connections</a>.</p>'}`;
  },
  // Sync
  () => {
    const s = S();
    return `<h2>Sync</h2>${fld('Sync every', 'How often each account is read', `<select class="in" id="s-sync">${opt([['5', '5 minutes'], ['15', '15 minutes'], ['60', '1 hour']], String(s.syncMinutes))}</select>`)}${fld('Mail lookback', 'How far back mail is read', `<select class="in" id="s-mail">${opt([['14', '14 days'], ['30', '30 days']], String(s.mailLookbackDays))}</select>`)}${fld('Pull Claude Code sessions', 'Show session titles in project history', sw(s.pullSessions, 's-pull'))}`;
  },
  // Notifications
  () => {
    const s = S();
    return `<h2>Notifications</h2>${NOTIF.map(([k, b, sub]) => fld(b, sub, sw(s.notifications?.[k] ?? false, 'n-' + k))).join('')}${fld('Quiet hours', 'No emails between these times', `<input type="time" class="in" id="s-qs" value="${esc(s.quietStart)}"><span class="muted" style="font-size:13px">to</span><input type="time" class="in" id="s-qe" value="${esc(s.quietEnd)}">`)}`;
  },
  // Appearance
  () => {
    const s = S();
    return `<h2>Appearance</h2>${fld('Theme', 'Also in the top bar', `<select class="in" id="s-theme">${opt([['Dark', 'Dark'], ['Light', 'Light']], isLight() ? 'Light' : 'Dark')}</select>`)}${fld('Density', 'Spacing in tables and lists', `<select class="in" id="s-dens">${opt([['comfortable', 'Comfortable'], ['compact', 'Compact']], s.density)}</select>`)}`;
  },
  // Data & export
  () => `<h2>Data & export</h2>${fld('Export everything', 'Projects, tasks and history as JSON', '<button class="act" type="button" id="s-export">Export</button>')}${fld('Clear cached data', 'Tokens stay, synced data is read again', '<button class="act" type="button" id="s-clear">Clear</button>')}${fld('Delete all dashboard data', 'Removes every token and record', '<button class="act" type="button" id="s-delete" style="color:var(--danger);border-color:var(--danger)">Delete…</button>')}`,
  // Setup keys: app-level keys that were missing from .dev.vars, stored encrypted; env vars are the fallback
  async () => {
    let d: SetupDTO | null = null;
    try { d = await get<SetupDTO>('/api/setup'); } catch (e) { toast(String((e as Error).message), 'bad'); }
    if (!d) return '<h2>Setup keys</h2><p class="muted" style="margin:0">Could not load.</p>';
    const src = (s: SetupItem['source']) => s === 'settings' ? '<span class="pill good">Set here</span>' : s === 'env' ? '<span class="pill dim">From .dev.vars</span>' : '<span class="pill warn">Missing</span>';
    const rows = d.items.map((it) => fld(esc(it.label), `${esc(it.hint)}${it.preview ? ` · <span class="mono">${esc(it.preview)}</span>` : ''}`,
      `${src(it.source)}<input class="in" type="${it.secret ? 'password' : 'text'}" data-setup="${esc(it.key)}" placeholder="${it.source === 'missing' ? 'Paste value' : 'Replace…'}" autocomplete="off" style="width:220px"><button class="act" type="button" data-setup-save="${esc(it.key)}">Save</button>${it.source === 'settings' ? `<button class="act" type="button" data-setup-rm="${esc(it.key)}">Remove</button>` : ''}`)).join('');
    const fixed = [['Supabase', d.fixed.supabase], ['Master key', d.fixed.masterKey], ['Sync secret', d.fixed.syncSecret], ['Ingest key', d.fixed.ingestKey]]
      .map(([n, ok]) => `<span class="pill ${ok ? 'good' : 'bad'}">${esc(String(n))}: ${ok ? 'set' : 'missing'}</span>`).join(' ');
    return `<h2>Setup keys</h2><p class="muted" style="margin:0 0 8px;font-size:14px">Keys the dashboard itself needs. Anything missing from <span class="mono">.dev.vars</span> can be pasted here instead; it is stored encrypted and wins over the file.</p>${rows}${fld('Server-only secrets', 'These can only live in .dev.vars (wrangler secret bulk)', fixed)}${fld('Agent ingest key', 'Needed by the Mac mini and Windows installers (docs/CLAUDE-CODE-SETUP.md)', '<button class="act" type="button" id="s-reveal">Reveal</button><span class="mono" id="s-ingest" style="font-size:12px"></span>')}`;
  },
];
interface SetupItem { key: string; label: string; hint: string; secret: boolean; source: 'settings' | 'env' | 'missing'; preview: string | null }
interface SetupDTO { items: SetupItem[]; fixed: { supabase: boolean; masterKey: boolean; syncSecret: boolean; ingestKey: boolean } }

function wireSection(body: HTMLElement, i: number, redraw: () => void, refreshAll: () => void): void {
  const q = <T extends HTMLElement>(s: string) => body.querySelector<T>(s);
  if (i === 7) {
    body.querySelectorAll<HTMLButtonElement>('[data-setup-save]').forEach((b) => (b.onclick = async () => {
      const inp = body.querySelector<HTMLInputElement>(`[data-setup="${b.dataset.setupSave}"]`)!;
      const v = inp.value.trim(); if (!v) { toast('Paste a value first', 'bad'); return; }
      try { await patch('/api/setup', { [b.dataset.setupSave!]: v }); toast('Saved'); redraw(); } catch (e) { toast(String((e as Error).message), 'bad'); }
    }));
    body.querySelectorAll<HTMLButtonElement>('[data-setup-rm]').forEach((b) => (b.onclick = async () => {
      if (!(await confirmDialog('Remove key', 'Fall back to the value in .dev.vars (if any)?', 'Remove'))) return;
      try { await del(`/api/setup/${b.dataset.setupRm}`); toast('Removed'); redraw(); } catch (e) { toast(String((e as Error).message), 'bad'); }
    }));
    const rv = q<HTMLButtonElement>('#s-reveal');
    if (rv) rv.onclick = async () => {
      try { const r = await get<{ ingestKey: string | null; url: string }>('/api/setup/ingest-key'); q<HTMLElement>('#s-ingest')!.textContent = r.ingestKey ? `${r.ingestKey}  (url ${r.url})` : 'not set'; rv.hidden = true; } catch (e) { toast(String((e as Error).message), 'bad'); }
    };
  }
  const onChange = (sel: string, fn: (el: ValueEl) => Partial<Settings>) => {
    const el = q<ValueEl>(sel); if (!el) return;
    el.onchange = () => save(fn(el), el);
  };
  const onSwitch = (sel: string, key: (on: boolean) => Partial<Settings>) => {
    const el = q<HTMLButtonElement>(sel); if (!el) return;
    el.onclick = () => { const on = el.classList.toggle('on'); el.setAttribute('aria-checked', String(on)); save(key(on), el); };
  };
  if (i === 0) {
    const name = q<HTMLInputElement>('#s-name')!;
    name.onchange = () => { const v = name.value.trim(); if (!v) return; save({ name: v }, name).then(() => { if (state.me) { state.me.user.name = v; document.querySelector('#acctName')!.textContent = v; } }); };
    onChange('#s-tz', (el) => ({ tz: el.value }));
    onChange('#s-start', (el) => ({ startPage: el.value }));
  }
  if (i === 1) {
    const addKey = q<HTMLButtonElement>('#s-addkey');
    if (addKey) addKey.onclick = () => openDialog({
      title: 'Add passkey',
      body: f('Label', `<input class="in" id="pk-label" value="${esc(defaultPasskeyLabel())}">`) + '<p class="sub" style="margin:0">Your browser will ask for Face ID, Touch ID, Windows Hello or a security key.</p>',
      primary: { label: 'Create passkey', onClick: async (dlg) => {
        const label = dlg.q<HTMLInputElement>('#pk-label').value.trim() || defaultPasskeyLabel();
        await registerPasskey(label);
        dlg.close(); toast('Passkey added'); redraw();
      } },
    });
    body.querySelectorAll<HTMLButtonElement>('[data-rmkey]').forEach((b) => (b.onclick = async () => {
      if (!(await confirmDialog('Remove passkey', 'Remove this passkey? You can still sign in with Google or another passkey.', 'Remove'))) return;
      try { await del(`/api/auth/passkeys/${b.dataset.rmkey}`); toast('Passkey removed'); redraw(); } catch (e) { toast(String((e as Error).message), 'bad'); }
    }));
    onChange('#s-sess', (el) => ({ sessionDays: +el.value }));
    q<HTMLButtonElement>('#s-outothers')!.onclick = async () => {
      try { const r = await post<{ ok: boolean; removed: number }>('/api/auth/signout-others'); toast(`Signed out ${r.removed} other session${r.removed === 1 ? '' : 's'}`); redraw(); } catch (e) { toast(String((e as Error).message), 'bad'); }
    };
  }
  if (i === 2) {
    body.querySelectorAll<HTMLButtonElement>('[data-manage]').forEach((b) => (b.onclick = () => {
      const a = state.me?.accounts.find((x) => x.id === b.dataset.manage);
      if (a) manageAccountDialog(a, refreshAll);
    }));
  }
  if (i === 3) {
    onChange('#s-sync', (el) => ({ syncMinutes: +el.value }));
    onChange('#s-mail', (el) => ({ mailLookbackDays: +el.value }));
    onSwitch('#s-pull', (on) => ({ pullSessions: on }));
  }
  if (i === 4) {
    for (const [k] of NOTIF) onSwitch('#n-' + k, (on) => ({ notifications: { ...(S().notifications ?? {}), [k]: on } }));
    onChange('#s-qs', (el) => ({ quietStart: el.value }));
    onChange('#s-qe', (el) => ({ quietEnd: el.value }));
  }
  if (i === 5) {
    const th = q<ValueEl>('#s-theme')!;
    th.onchange = () => { setTone(th.value === 'Light'); flashSaved(th); };
    const dn = q<ValueEl>('#s-dens')!;
    dn.onchange = () => { applyDensity(dn.value as Settings['density']); save({ density: dn.value as Settings['density'] }, dn); };
  }
  if (i === 6) {
    q<HTMLButtonElement>('#s-export')!.onclick = () => { window.location.href = '/api/export'; };
    q<HTMLButtonElement>('#s-clear')!.onclick = async () => {
      if (!(await confirmDialog('Clear cached data', 'Delete every snapshot, metric, mail and calendar row? Accounts and tokens stay; everything is read again on the next sync.', 'Clear', false))) return;
      try { await post('/api/data/clear-cache'); invalidate(); toast('Cache cleared, syncing again'); } catch (e) { toast(String((e as Error).message), 'bad'); }
    };
    q<HTMLButtonElement>('#s-delete')!.onclick = () => openDialog({
      title: 'Delete all dashboard data',
      body: `<p style="margin:0">This removes every token, account, project, task and record, and signs you out. It cannot be undone.</p>${f('Type DELETE to confirm', '<input class="in" id="dd-confirm" autocomplete="off" placeholder="DELETE">')}`,
      primary: { label: 'Delete everything', danger: true, onClick: async (dlg) => {
        if (dlg.q<HTMLInputElement>('#dd-confirm').value.trim() !== 'DELETE') { toast('Type DELETE to confirm', 'bad'); return; }
        await post('/api/data/delete', { confirm: 'DELETE' });
        dlg.close(); location.reload();
      } },
    });
  }
}

export const prefs: ViewFn = async (ctx) => {
  let cur = Math.max(0, SECTIONS.indexOf(decodeURIComponent(ctx.query.get('s') ?? '')));
  ctx.root.innerHTML = `<div class="set"><div class="card setnav" id="setnav">${SECTIONS.map((s, i) => `<button type="button" class="${i === cur ? 'on' : ''}" data-i="${i}">${s}</button>`).join('')}</div><div class="card" id="setBody"><p class="muted" style="margin:0">Loading…</p></div></div>`;
  const body = ctx.root.querySelector<HTMLElement>('#setBody')!, sn = ctx.root.querySelector('#setnav')!;
  let token = 0;
  const show = async (i: number) => {
    const my = ++token; cur = i;
    sn.querySelectorAll('button').forEach((x) => x.classList.toggle('on', +(x as HTMLElement).dataset.i! === i));
    const html = await SET[i](body, ctx.refresh);
    if (my !== token || !ctx.alive()) return;
    body.innerHTML = html;
    wireSection(body, i, () => show(i), ctx.refresh);
  };
  sn.querySelectorAll<HTMLButtonElement>('button').forEach((b) => (b.onclick = () => show(+b.dataset.i!)));
  await show(cur);
};
