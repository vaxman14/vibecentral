import { Hono } from 'hono';
import type { Env, Vars } from '../env.ts';
import { db, getUser, many, HttpError } from '../db.ts';
import { settingsDTO, loadAccounts, accountDTO } from './me.ts';
import { signOut } from '../auth/session.ts';
import { triggerSync } from '../auth/google.ts';

export const dataRoutes = new Hono<{ Bindings: Env; Variables: Vars }>();

dataRoutes.get('/export', async (c) => {
  const d = db(c.env);
  const [user, accounts, projects, links, tasks, history, folders, usage, alerts, passkeys] = await Promise.all([
    getUser(d), loadAccounts(d),
    many(d.from('projects').select('*').order('sort'), 'projects'),
    many(d.from('project_links').select('*'), 'links'),
    many(d.from('tasks').select('*').order('created_at'), 'tasks'),
    many(d.from('history').select('*').order('occurred_at'), 'history'),
    many(d.from('folder_map').select('*'), 'folders'),
    many(d.from('usage_daily').select('*').order('day'), 'usage'),
    many(d.from('alerts').select('id,fingerprint,kind,urgent,title,body,project_id,account_id,created_at,sent_at,status'), 'alerts'),
    many(d.from('passkeys').select('id,label,created_at,last_used_at,device_type'), 'passkeys'),
  ]);
  const body = {
    exportedAt: new Date().toISOString(), app: 'Vibe Central', version: 1,
    settings: settingsDTO(user),
    accounts: accounts.map(accountDTO), // labels + meta only, never secrets
    projects, links, tasks, history, folders, usage, alerts, passkeys,
  };
  const stamp = new Date().toISOString().slice(0, 10);
  return new Response(JSON.stringify(body, null, 2), {
    headers: { 'content-type': 'application/json', 'content-disposition': `attachment; filename="hq-export-${stamp}.json"` },
  });
});

dataRoutes.post('/data/clear-cache', async (c) => {
  const d = db(c.env);
  for (const t of ['snapshots', 'metrics', 'mail_items', 'cal_events']) {
    const r = await d.from(t).delete().not('account_id', 'is', null);
    if (r.error) throw new HttpError(500, `clear ${t}: ${r.error.message}`);
  }
  await d.from('accounts').update({ next_sync_at: new Date().toISOString(), status: 'pending', last_error: null }).neq('status', 'expired');
  c.executionCtx.waitUntil(triggerSync(c.env, { all: true }).catch(() => {}));
  return c.json({ ok: true });
});

dataRoutes.post('/data/delete', async (c) => {
  const b = await c.req.json<{ confirm: string }>();
  if (b.confirm !== 'DELETE') throw new HttpError(400, 'type DELETE to confirm');
  const d = db(c.env);
  // order matters only for readability; FKs cascade from accounts/projects/hq_user
  const tables = ['alerts', 'usage_daily', 'agent_heartbeats', 'folder_map', 'history', 'tasks', 'project_links', 'projects',
    'mail_items', 'cal_events', 'metrics', 'snapshots', 'sync_runs', 'accounts', 'oauth_states', 'webauthn_challenges', 'passkeys', 'sessions'];
  for (const t of tables) {
    const r = await d.rpc('hq_truncate', { tbl: t });
    if (r.error) throw new HttpError(500, `delete ${t}: ${r.error.message}`);
  }
  const u = await getUser(d);
  await d.from('hq_user').delete().eq('id', u.id);
  await signOut(c);
  return c.json({ ok: true });
});
