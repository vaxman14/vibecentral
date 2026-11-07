import { Hono } from 'hono';
import type { Env, Vars } from '../env.ts';
import { db, getUser, many, one, HttpError, type UserRow } from '../db.ts';
import type { AccountDTO, MeDTO, Settings } from '@shared/types.ts';
import { PROVIDERS } from '@shared/types.ts';
import { branding } from '../branding.ts';
import { mirrorIdentity } from '../config.ts';

export const meRoutes = new Hono<{ Bindings: Env; Variables: Vars }>();

export interface AccountRow { id: string; provider: string; label: string; secret_enc?: string | null; meta: any; status: string; last_sync_at: string | null; last_sync_ms: number | null; last_error: string | null; next_sync_at: string | null; sync_minutes: number | null; created_at: string; updated_at: string }

export const accountDTO = (a: AccountRow): AccountDTO => ({
  id: a.id, provider: a.provider as any, label: a.label, status: a.status as any, lastSyncAt: a.last_sync_at, lastSyncMs: a.last_sync_ms,
  lastError: a.last_error, nextSyncAt: a.next_sync_at, meta: a.meta ?? {}, createdAt: a.created_at,
});

export function settingsDTO(u: UserRow): Settings {
  return {
    name: u.name, emails: u.emails, tz: u.tz, startPage: u.start_page, sessionDays: u.session_days, syncMinutes: u.sync_minutes,
    mailLookbackDays: u.mail_lookback_days, pullSessions: u.pull_sessions, theme: u.theme as any, density: u.density as any,
    quietStart: u.quiet_start, quietEnd: u.quiet_end, notifications: u.notifications ?? {}, alertTo: u.alert_to,
  };
}

export async function loadAccounts(d: ReturnType<typeof db>): Promise<AccountRow[]> {
  return many<AccountRow>(d.from('accounts').select('id,provider,label,meta,status,last_sync_at,last_sync_ms,last_error,next_sync_at,sync_minutes,created_at,updated_at').order('provider').order('created_at'), 'accounts');
}

meRoutes.get('/me', async (c) => {
  const d = db(c.env);
  const [u, accounts, projects, openTasks, mail, unsorted, session] = await Promise.all([
    getUser(d),
    loadAccounts(d),
    many<{ id: string }>(d.from('projects').select('id').eq('archived', false), 'projects'),
    many<{ id: string }>(d.from('tasks').select('id').eq('done', false), 'tasks'),
    many<{ message_id: string }>(d.from('mail_items').select('message_id').eq('important', true).eq('unread', true).limit(200), 'mail'),
    many<{ id: string }>(d.from('folder_map').select('id').is('project_id', null), 'unsorted'),
    one<{ id: string; method: string; created_at: string; expires_at: string }>(d.from('sessions').select('id,method,created_at,expires_at').eq('id', c.get('sessionId')).single(), 'session'),
  ]);
  const b = await branding(c);
  c.executionCtx.waitUntil(mirrorIdentity(c.env, b.origin, b.appName).catch(() => {}));
  const synced = accounts.filter((a) => a.last_sync_at).map((a) => a.last_sync_at!).sort();
  const failing = accounts.filter((a) => a.status === 'error' || a.status === 'expired').length;
  const initials = (u.name || b.appName).split(/\s+/).map((p) => p[0]).join('').slice(0, 2).toUpperCase() || 'H';
  const me: MeDTO = {
    user: { id: u.id, name: u.name || 'Owner', initials },
    branding: { appName: b.appName, host: b.host, origin: b.origin, ownerName: b.ownerName, contact: b.contact },
    settings: settingsDTO(u),
    accounts: accounts.map(accountDTO),
    counts: { projects: projects.length, openTasks: openTasks.length, mail: mail.length, unsorted: unsorted.length },
    sync: { allOk: failing === 0, accounts: accounts.length, providers: new Set(accounts.map((a) => a.provider)).size, oldestSyncAt: synced[0] ?? null, failing },
    session: { id: session?.id ?? '', method: session?.method ?? 'google', createdAt: session?.created_at ?? '', expiresAt: session?.expires_at ?? '' },
  };
  return c.json(me);
});

const SETTING_COLS: Record<keyof Settings, string> = {
  name: 'name', emails: 'emails', tz: 'tz', startPage: 'start_page', sessionDays: 'session_days', syncMinutes: 'sync_minutes',
  mailLookbackDays: 'mail_lookback_days', pullSessions: 'pull_sessions', theme: 'theme', density: 'density', quietStart: 'quiet_start',
  quietEnd: 'quiet_end', notifications: 'notifications', alertTo: 'alert_to',
};

meRoutes.patch('/settings', async (c) => {
  const body = (await c.req.json()) as Partial<Settings>;
  const patch: Record<string, unknown> = {};
  for (const [k, col] of Object.entries(SETTING_COLS)) {
    if (!(k in body)) continue;
    let v: any = (body as any)[k];
    if (k === 'sessionDays' || k === 'syncMinutes' || k === 'mailLookbackDays') { v = Number(v); if (!Number.isFinite(v) || v < 1) throw new HttpError(400, `${k} must be a positive number`); }
    if (k === 'theme' && !['dark', 'light'].includes(v)) throw new HttpError(400, 'theme must be dark or light');
    if (k === 'density' && !['comfortable', 'compact'].includes(v)) throw new HttpError(400, 'density must be comfortable or compact');
    if ((k === 'quietStart' || k === 'quietEnd') && !/^\d{2}:\d{2}$/.test(v)) throw new HttpError(400, `${k} must be HH:MM`);
    if (k === 'notifications') {
      const u = await getUser(db(c.env));
      v = { ...(u.notifications ?? {}), ...Object.fromEntries(Object.entries(v).map(([a, b]) => [a, !!b])) };
    }
    if (k === 'name') v = String(v).trim().slice(0, 80);
    if (k === 'emails') { v = (Array.isArray(v) ? v : String(v).split(',')).map((e: unknown) => String(e).trim().toLowerCase()).filter((e: string) => /^[^@\s]+@[^@\s]+$/.test(e)); if (!v.length) throw new HttpError(400, 'keep at least one sign-in email'); }
    patch[col] = v;
  }
  if (!Object.keys(patch).length) throw new HttpError(400, 'nothing to update');
  patch.updated_at = new Date().toISOString();
  const d = db(c.env);
  const u = await getUser(d);
  const row = await one<UserRow>(d.from('hq_user').update(patch).eq('id', u.id).select('*').single(), 'save settings');
  if (!row) throw new HttpError(500, 'settings not saved');
  // changing the sync interval re-schedules every account
  if ('sync_minutes' in patch) await d.from('accounts').update({ next_sync_at: new Date().toISOString() }).is('sync_minutes', null);
  return c.json(settingsDTO(row));
});

export { PROVIDERS };
