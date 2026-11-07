// Vibe Central sync Edge Function. Called every minute by pg_cron ({source:'cron'}) and on demand by the Worker
// ({accountId} or {all:true}). Reads provider APIs (GET only, see _shared/providers/*) and writes
// snapshots / metrics / mail_items / cal_events / history, then evaluates and emails alerts.
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { decryptJson, encryptJson, safeEqual } from '../_shared/crypto.ts';
import type { AccountMeta, AccountSecrets } from '../_shared/types.ts';
import {
  SyncError, errMsg, httpJson, httpRaw, isExpired,
  type AccountRow, type AlertCandidate, type CalRow, type FetchInit, type HistoryEvent, type MailRow, type SyncContext, type Writers,
} from '../_shared/providers/ctx.ts';
import { PROVIDER_SYNC } from '../_shared/providers/index.ts';
import { evaluateAlerts, flushAlerts, setIdentity } from '../_shared/alerts.ts';
import { LinkIndex, type LinkRow } from '../_shared/links.ts';
import { loadAppConfig, resolveKey } from '../_shared/appconfig.ts';

const ACCOUNT_BUDGET_MS = 45_000;   // per account
const START_DEADLINE_MS = 90_000;   // stop starting new accounts after this (free tier wall clock is 150s)
const MAX_PER_TICK = 6;
const CONCURRENCY = 2;
const BACKOFF_MINUTES = [5, 15, 60]; // by consecutive failures (1, 2, 3+)
const ACCOUNT_COLS = 'id,provider,label,meta,status,last_sync_at,secret_enc,sync_minutes';

type Db = SupabaseClient;

interface SyncRequest { source?: string; accountId?: string; all?: boolean }
interface HqUser { tz: string; sync_minutes: number; mail_lookback_days: number }
interface RunResult { accountId: string; provider: string; label: string; ok: boolean; status: string; ms: number; error: string | null }
interface Shared { user: HqUser; links: LinkIndex; candidates: AlertCandidate[]; masterKey: string; env: SyncContext['env'] }
interface MetricRow { account_id: string; kind: string; day: string; values: Record<string, number> }

function env(name: string, required = true): string {
  const v = Deno.env.get(name);
  if (!v && required) throw new Error(`Missing env ${name}`);
  return v ?? '';
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const minutesFromNow = (min: number) => new Date(Date.now() + min * 60000).toISOString();

async function must<T>(p: PromiseLike<{ data: T | null; error: { message: string } | null }>, what: string): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(`DB ${what}: ${error.message}`);
  return data as T;
}

Deno.serve(async (req: Request) => {
  const t0 = Date.now();
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  const secret = Deno.env.get('HQ_SYNC_SECRET') ?? '';
  const key = req.headers.get('x-hq-sync-key') ?? '';
  if (!secret || !safeEqual(key, secret)) return json({ error: 'unauthorized' }, 401);

  let body: SyncRequest = {};
  try { body = (await req.json()) as SyncRequest; } catch { /* empty body behaves like cron */ }

  try {
    const db: Db = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false, autoRefreshToken: false } });
    const now = new Date();
    const shared: Shared = {
      user: await loadUser(db),
      links: new LinkIndex(await must<LinkRow[]>(db.from('project_links').select('kind,ref,project_id,account_id'), 'project_links') ?? []),
      candidates: [],
      masterKey: env('HQ_MASTER_KEY'),
      env: { googleClientId: '', googleClientSecret: '' },
    };
    // keys entered under Settings → Setup keys (app_config) win over env vars
    const appCfg = await loadAppConfig(db as unknown as Parameters<typeof loadAppConfig>[0], shared.masterKey);
    const denoEnv = { GOOGLE_CLIENT_ID: env('GOOGLE_CLIENT_ID', false), GOOGLE_CLIENT_SECRET: env('GOOGLE_CLIENT_SECRET', false), RESEND_API_KEY: env('RESEND_API_KEY', false), ALERT_FROM: env('ALERT_FROM', false) };
    shared.env.googleClientId = resolveKey(appCfg, denoEnv, 'google_client_id');
    shared.env.googleClientSecret = resolveKey(appCfg, denoEnv, 'google_client_secret');
    setIdentity(appCfg.app_origin || env('APP_ORIGIN', false), appCfg.app_name || env('APP_NAME', false) || 'Vibe Central');

    const accounts = await pickAccounts(db, body, now);
    const queue = [...accounts];
    const results: RunResult[] = [];
    let skipped = 0;
    const worker = async () => {
      while (queue.length) {
        if (Date.now() - t0 > START_DEADLINE_MS) { skipped += queue.length; queue.length = 0; break; }
        const acct = queue.shift();
        if (!acct) break;
        results.push(await runAccount(db, acct, shared));
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, Math.max(1, queue.length)) }, worker));

    let alerts: Record<string, unknown>;
    try {
      const evaluated = await evaluateAlerts(db, { now: new Date(), candidates: shared.candidates });
      const resendKey = resolveKey(appCfg, denoEnv, 'resend_api_key');
      const from = resolveKey(appCfg, denoEnv, 'alert_from');
      const flushed = resendKey && from
        ? await flushAlerts(db, { resendApiKey: resendKey, alertFrom: from }, new Date())
        : { skipped: 'Resend key / alert sender not set (Settings → Setup keys); alerts stay pending' };
      alerts = { ...evaluated, ...flushed };
    } catch (e) {
      console.error('alerts failed', e);
      alerts = { error: errMsg(e) };
    }

    return json({
      ok: true, source: body.accountId ? 'account' : body.all ? 'all' : (body.source ?? 'cron'),
      ran: results, skipped, alerts, ms: Date.now() - t0,
    });
  } catch (e) {
    console.error('sync failed', e);
    return json({ ok: false, error: errMsg(e), ms: Date.now() - t0 }, 500);
  }
});

// ---------- selection ----------
async function loadUser(db: Db): Promise<HqUser> {
  const rows = await must<HqUser[]>(db.from('hq_user').select('tz,sync_minutes,mail_lookback_days').limit(1), 'hq_user');
  return rows?.[0] ?? { tz: 'America/Los_Angeles', sync_minutes: 5, mail_lookback_days: 14 };
}

async function pickAccounts(db: Db, body: SyncRequest, now: Date): Promise<AccountRow[]> {
  if (body.accountId) {
    const row = await must<AccountRow | null>(db.from('accounts').select(ACCOUNT_COLS).eq('id', body.accountId).maybeSingle(), 'account');
    if (!row) throw new Error(`account ${body.accountId} not found`);
    return [row];
  }
  const nowIso = now.toISOString();
  if (body.all) await must(db.from('accounts').update({ next_sync_at: nowIso }).gt('next_sync_at', nowIso), 'mark all due');
  const due = await must<AccountRow[]>(db.from('accounts').select(ACCOUNT_COLS).lte('next_sync_at', nowIso).order('next_sync_at', { ascending: true }).limit(40), 'due accounts') ?? [];
  // oldest first, at most MAX_PER_TICK, and never more than one Google account per tick (Gmail is the slowest)
  const picked: AccountRow[] = [];
  let google = 0;
  for (const a of due) {
    if (picked.length >= MAX_PER_TICK) break;
    if (a.provider === 'google') { if (google >= 1) continue; google++; }
    picked.push(a);
  }
  return picked;
}

// ---------- one account ----------
async function runAccount(db: Db, acct: AccountRow, shared: Shared): Promise<RunResult> {
  const started = Date.now();
  const tag = `[${acct.provider}:${acct.label}]`;
  let runId: number | null = null;
  try {
    const run = await must<{ id: number }>(db.from('sync_runs').insert({ account_id: acct.id }).select('id').single(), 'sync_runs insert');
    runId = run.id;
  } catch (e) { console.error(tag, errMsg(e)); }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new SyncError(`Timed out after ${ACCOUNT_BUDGET_MS / 1000}s`)), ACCOUNT_BUDGET_MS);
  const metrics = new Map<string, MetricRow>();
  const events: HistoryEvent[] = [];
  const now = new Date();
  let error: string | null = null;
  let expired = false;

  try {
    if (!acct.secret_enc) throw new SyncError('No credentials stored: add the token again', { expired: true });
    let secrets: AccountSecrets;
    try { secrets = await decryptJson<AccountSecrets>(shared.masterKey, acct.secret_enc); }
    catch { throw new SyncError('Stored credentials could not be decrypted (HQ_MASTER_KEY changed?)', { expired: true }); }
    const previous = await loadSnapshots(db, acct.id);
    const writers = makeWriters(db, acct, shared, now, metrics, events);
    const ctx: SyncContext = {
      account: acct, secrets, meta: acct.meta ?? {}, signal: ac.signal, now, tz: shared.user.tz, lookbackDays: shared.user.mail_lookback_days || 14, env: shared.env,
      fetchJson: <T>(url: string, init: FetchInit = {}) => httpJson<T>(acct.provider, url, init, ac.signal),
      fetchRaw: (url: string, init: FetchInit = {}) => httpRaw(acct.provider, url, init, ac.signal),
      previous: <T>(kind: string) => (previous.has(kind) ? (previous.get(kind) as T) : null),
      writers,
      log: (msg: string) => console.log(tag, msg),
    };
    const fn = PROVIDER_SYNC[acct.provider];
    if (!fn) throw new SyncError(`Unknown provider ${acct.provider}`);
    await fn(ctx);
  } catch (e) {
    expired = isExpired(e);
    error = ac.signal.aborted ? `Timed out after ${ACCOUNT_BUDGET_MS / 1000}s` : errMsg(e);
    console.error(tag, error);
  } finally {
    clearTimeout(timer);
  }

  // write whatever was collected, even after a failure half-way through
  try {
    await flushMetrics(db, metrics);
    await flushEvents(db, acct, shared.links, events);
  } catch (e) {
    const m = `Data saved but metrics/history write failed: ${errMsg(e, 160)}`;
    console.error(tag, m);
    if (!error) error = m;
  }

  const ms = Date.now() - started;
  const finished = new Date().toISOString();
  if (!error) {
    const minutes = acct.sync_minutes ?? shared.user.sync_minutes ?? 5;
    await db.from('accounts').update({ status: 'ok', last_sync_at: finished, last_sync_ms: ms, last_error: null, next_sync_at: minutesFromNow(minutes), updated_at: finished }).eq('id', acct.id);
  } else {
    const failures = (await consecutiveFailures(db, acct.id, runId)) + 1;
    const backoff = BACKOFF_MINUTES[Math.min(failures, BACKOFF_MINUTES.length) - 1];
    await db.from('accounts').update({ status: expired ? 'expired' : 'error', last_sync_ms: ms, last_error: error, next_sync_at: minutesFromNow(backoff), updated_at: finished }).eq('id', acct.id);
  }
  if (runId !== null) await db.from('sync_runs').update({ finished_at: finished, ok: !error, error, duration_ms: ms }).eq('id', runId);
  return { accountId: acct.id, provider: acct.provider, label: acct.label, ok: !error, status: error ? (expired ? 'expired' : 'error') : 'ok', ms, error };
}

async function consecutiveFailures(db: Db, accountId: string, currentRunId: number | null): Promise<number> {
  let q = db.from('sync_runs').select('ok').eq('account_id', accountId).not('ok', 'is', null).order('started_at', { ascending: false }).limit(5);
  if (currentRunId !== null) q = q.neq('id', currentRunId);
  const { data } = await q;
  let n = 0;
  for (const r of (data ?? []) as { ok: boolean | null }[]) { if (r.ok === false) n++; else break; }
  return n;
}

async function loadSnapshots(db: Db, accountId: string): Promise<Map<string, unknown>> {
  const rows = await must<{ kind: string; data: unknown }[]>(db.from('snapshots').select('kind,data').eq('account_id', accountId), 'snapshots');
  return new Map((rows ?? []).map((r) => [r.kind, r.data]));
}

// ---------- writers ----------
function makeWriters(db: Db, acct: AccountRow, shared: Shared, now: Date, metrics: Map<string, MetricRow>, events: HistoryEvent[]): Writers {
  const fail = (what: string, error: { message: string } | null) => { if (error) throw new SyncError(`DB write failed (${what}): ${error.message}`); };
  return {
    async snapshot(kind, data) {
      const { error } = await db.from('snapshots').upsert({ account_id: acct.id, kind, data, fetched_at: now.toISOString() }, { onConflict: 'account_id,kind' });
      fail(`snapshots/${kind}`, error);
    },
    metric(kind, day, values) {
      metrics.set(`${kind}|${day}`, { account_id: acct.id, kind, day, values });
    },
    async mail(rows: MailRow[], opts) {
      for (const chunk of chunks(rows, 200)) {
        const { error } = await db.from('mail_items').upsert(chunk.map((r) => ({ ...r, account_id: acct.id })), { onConflict: 'account_id,message_id' });
        fail('mail_items', error);
      }
      if (opts?.pruneBefore) {
        const { error } = await db.from('mail_items').delete().eq('account_id', acct.id).lt('received_at', opts.pruneBefore);
        fail('mail_items prune', error);
      }
    },
    async cal(rows: CalRow[], window) {
      const del = await db.from('cal_events').delete().eq('account_id', acct.id).gte('starts_at', window.from).lte('starts_at', window.to);
      fail('cal_events clear', del.error);
      for (const chunk of chunks(rows, 200)) {
        const { error } = await db.from('cal_events').upsert(chunk.map((r) => ({ ...r, account_id: acct.id })), { onConflict: 'account_id,event_id' });
        fail('cal_events', error);
      }
    },
    event(e) { events.push(e); },
    alert(a) { shared.candidates.push({ ...a, accountId: acct.id }); },
    async secrets(next) {
      const secret_enc = await encryptJson(shared.masterKey, next);
      const { error } = await db.from('accounts').update({ secret_enc, updated_at: new Date().toISOString() }).eq('id', acct.id);
      fail('accounts.secret_enc', error);
      acct.secret_enc = secret_enc;
    },
    async meta(patch: Partial<AccountMeta>) {
      const merged = { ...(acct.meta ?? {}), ...patch };
      const { error } = await db.from('accounts').update({ meta: merged }).eq('id', acct.id);
      fail('accounts.meta', error);
      acct.meta = merged;
    },
  };
}

async function flushMetrics(db: Db, metrics: Map<string, MetricRow>): Promise<void> {
  const rows = [...metrics.values()];
  for (const chunk of chunks(rows, 200)) {
    const { error } = await db.from('metrics').upsert(chunk, { onConflict: 'account_id,kind,day' });
    if (error) throw new Error(`metrics: ${error.message}`);
  }
}

async function flushEvents(db: Db, acct: AccountRow, links: LinkIndex, events: HistoryEvent[]): Promise<void> {
  if (!events.length) return;
  const seen = new Set<string>();
  const rows = [];
  for (const e of events) {
    if (seen.has(e.fingerprint)) continue;
    seen.add(e.fingerprint);
    rows.push({
      project_id: links.resolve(e.link, acct.id), kind: 'provider', title: e.title.slice(0, 200), detail: e.detail ?? null,
      occurred_at: e.occurredAt, source: acct.provider, fingerprint: e.fingerprint,
      // the linked thing's ref, so the Worker can attach these rows when a link is added later
      folder: e.link?.ref ?? null,
    });
  }
  for (const chunk of chunks(rows, 200)) {
    const { error } = await db.from('history').upsert(chunk, { onConflict: 'fingerprint', ignoreDuplicates: true });
    if (error) throw new Error(`history: ${error.message}`);
  }
}

function chunks<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}
