import { Hono } from 'hono';
import type { Env, Vars } from '../env.ts';
import { db, many, one, HttpError } from '../db.ts';
import { encryptJson } from '@shared/crypto.ts';
import { FORMS } from '@shared/forms.ts';
import { PROVIDERS, type AccountMeta, type ConnectionsDTO, type Provider } from '@shared/types.ts';
import { accountDTO, loadAccounts, type AccountRow } from './me.ts';
import { triggerSync } from '../auth/google.ts';

export const accountRoutes = new Hono<{ Bindings: Env; Variables: Vars }>();

function validateSecrets(provider: Provider, secrets: Record<string, unknown>, partial = false): Record<string, string> {
  const form = FORMS[provider];
  if (form.oauth) throw new HttpError(400, `${PROVIDERS[provider].name} connects through OAuth, not a pasted token`);
  const out: Record<string, string> = {};
  for (const f of form.fields) {
    const v = secrets?.[f.key];
    if (v === undefined || v === null || String(v).trim() === '') {
      if (partial || f.optional) continue;
      throw new HttpError(400, `${f.label} is required`);
    }
    out[f.key] = String(v).trim();
  }
  if (provider === 'googleplay' && out.serviceAccountJson) {
    try { const j = JSON.parse(out.serviceAccountJson); if (!j.client_email || !j.private_key) throw new Error(); } catch { throw new HttpError(400, 'That is not a service account JSON key'); }
  }
  if (provider === 'appstore' && out.privateKeyP8 && !/BEGIN PRIVATE KEY/.test(out.privateKeyP8)) throw new HttpError(400, 'The .p8 contents should include the BEGIN PRIVATE KEY line');
  if (provider === 'stripe' && out.restrictedKey && !/^rk_(live|test)_/.test(out.restrictedKey)) throw new HttpError(400, 'Use a restricted key (rk_live_…), not a secret key');
  if (provider === 'anthropic' && out.adminKey && !/^sk-ant-admin/.test(out.adminKey)) throw new HttpError(400, 'Use an Admin key (sk-ant-admin…)');
  return out;
}

function cleanMeta(provider: Provider, meta: any): AccountMeta {
  const m: AccountMeta = {};
  if (!meta || typeof meta !== 'object') return m;
  for (const f of FORMS[provider].metaFields) if (meta[f.key] !== undefined && meta[f.key] !== '') (m as any)[f.key] = String(meta[f.key]).trim().replace(/^gs:\/\//, '');
  if (Array.isArray(meta.accountIds)) m.accountIds = meta.accountIds.map(String);
  if (Array.isArray(meta.calendarIds)) m.calendarIds = meta.calendarIds.map(String);
  if (Array.isArray(meta.packageNames)) m.packageNames = meta.packageNames.map(String);
  return m;
}

accountRoutes.get('/connections', async (c) => {
  const d = db(c.env);
  const [accounts, beats, today] = await Promise.all([
    loadAccounts(d),
    many<{ machine: string; last_seen: string; agent_version: string | null; files_tracked: number | null }>(d.from('agent_heartbeats').select('*').order('last_seen', { ascending: false }), 'heartbeats'),
    many<{ id: string }>(d.from('history').select('id').eq('source', 'claude-code').gte('occurred_at', new Date(Date.now() - 86400000).toISOString()), 'sessions'),
  ]);
  const dto: ConnectionsDTO = {
    providers: (Object.keys(PROVIDERS) as Provider[]).map((p) => ({ provider: p, ...PROVIDERS[p], accounts: accounts.filter((a) => a.provider === p).map(accountDTO) })),
    claudeCode: { machines: beats.map((b) => ({ machine: b.machine, lastSeen: b.last_seen, agentVersion: b.agent_version, filesTracked: b.files_tracked })), sessionsToday: today.length },
  };
  return c.json(dto);
});

accountRoutes.post('/accounts', async (c) => {
  const b = await c.req.json<{ provider: Provider; label: string; secrets: Record<string, unknown>; meta?: any }>();
  if (!(b.provider in PROVIDERS)) throw new HttpError(400, 'unknown provider');
  const label = String(b.label ?? '').trim().slice(0, 60);
  if (!label) throw new HttpError(400, 'label is required');
  const secrets = validateSecrets(b.provider, b.secrets ?? {});
  const meta = cleanMeta(b.provider, b.meta);
  if (b.provider === 'googleplay' && !meta.reportsBucket) throw new HttpError(400, 'Reports bucket is required for Google Play');
  const d = db(c.env);
  const secret_enc = await encryptJson(c.env.HQ_MASTER_KEY, { provider: b.provider, ...secrets });
  const row = await one<AccountRow>(d.from('accounts').insert({ provider: b.provider, label, secret_enc, meta, status: 'pending' }).select('id,provider,label,meta,status,last_sync_at,last_sync_ms,last_error,next_sync_at,sync_minutes,created_at,updated_at').single(), 'add account');
  c.executionCtx.waitUntil(triggerSync(c.env, { accountId: row!.id }).catch(() => {}));
  return c.json(accountDTO(row!));
});

accountRoutes.patch('/accounts/:id', async (c) => {
  const b = await c.req.json<{ label?: string; meta?: any; secrets?: Record<string, unknown> }>();
  const d = db(c.env);
  const id = c.req.param('id');
  const cur = await one<AccountRow & { secret_enc: string | null }>(d.from('accounts').select('*').eq('id', id).single(), 'account');
  if (!cur) throw new HttpError(404, 'account not found');
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (b.label !== undefined) { const l = String(b.label).trim().slice(0, 60); if (!l) throw new HttpError(400, 'label cannot be empty'); patch.label = l; }
  if (b.meta !== undefined) patch.meta = { ...(cur.meta ?? {}), ...cleanMeta(cur.provider as Provider, b.meta) };
  if (b.secrets && Object.keys(b.secrets).length) {
    const s = validateSecrets(cur.provider as Provider, b.secrets, true);
    const { decryptJson } = await import('@shared/crypto.ts');
    const old = cur.secret_enc ? await decryptJson<Record<string, string>>(c.env.HQ_MASTER_KEY, cur.secret_enc) : { provider: cur.provider };
    patch.secret_enc = await encryptJson(c.env.HQ_MASTER_KEY, { ...old, ...s, provider: cur.provider });
    patch.status = 'pending'; patch.last_error = null; patch.next_sync_at = new Date().toISOString();
  }
  const row = await one<AccountRow>(d.from('accounts').update(patch).eq('id', id).select('id,provider,label,meta,status,last_sync_at,last_sync_ms,last_error,next_sync_at,sync_minutes,created_at,updated_at').single(), 'update account');
  if (patch.secret_enc || patch.meta) c.executionCtx.waitUntil(triggerSync(c.env, { accountId: id }).catch(() => {}));
  return c.json(accountDTO(row!));
});

accountRoutes.delete('/accounts/:id', async (c) => {
  await many(db(c.env).from('accounts').delete().eq('id', c.req.param('id')).select('id'), 'remove account');
  return c.json({ ok: true });
});

accountRoutes.post('/accounts/:id/sync', async (c) => {
  const id = c.req.param('id');
  const d = db(c.env);
  await d.from('accounts').update({ next_sync_at: new Date().toISOString() }).eq('id', id);
  c.executionCtx.waitUntil(triggerSync(c.env, { accountId: id }).catch(() => {}));
  return c.json({ ok: true });
});

accountRoutes.post('/sync', async (c) => {
  const d = db(c.env);
  await d.from('accounts').update({ next_sync_at: new Date().toISOString() }).neq('status', 'expired');
  c.executionCtx.waitUntil(triggerSync(c.env, { all: true }).catch(() => {}));
  return c.json({ ok: true });
});

// ---------- Claude Code machines (from the local agents) ----------
accountRoutes.patch('/claude/machines/:machine', async (c) => {
  const old = decodeURIComponent(c.req.param('machine'));
  const { name } = await c.req.json<{ name: string }>();
  const next = String(name ?? '').trim().slice(0, 40);
  if (!next) throw new HttpError(400, 'name is required');
  if (next === old) return c.json({ ok: true });
  const r = await db(c.env).rpc('hq_rename_machine', { old_name: old, new_name: next });
  if (r.error) throw new HttpError(500, `rename failed: ${r.error.message}`);
  return c.json({ ok: true, moved: r.data ?? 0 });
});
accountRoutes.delete('/claude/machines/:machine', async (c) => {
  await many(db(c.env).from('agent_heartbeats').delete().eq('machine', decodeURIComponent(c.req.param('machine'))).select('machine'), 'remove machine');
  return c.json({ ok: true });
});

accountRoutes.get('/accounts/:id/runs', async (c) => {
  const rows = await many<{ started_at: string; ok: boolean | null; error: string | null; duration_ms: number | null }>(
    db(c.env).from('sync_runs').select('started_at,ok,error,duration_ms').eq('account_id', c.req.param('id')).order('started_at', { ascending: false }).limit(20), 'runs');
  return c.json(rows.map((r) => ({ startedAt: r.started_at, ok: r.ok, error: r.error, durationMs: r.duration_ms })));
});
