// Alert evaluation + delivery. Runs after the account loop in the sync function.
// Candidates come from two places: provider modules (changes that need the previous snapshot: app review,
// new revenue, new build, failed Actions run) and this file (derivable from DB state: failed deploys,
// domain expiry, token failures, sync errors). Dedup is the `alerts.fingerprint` unique index.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { CfZone, NlDeploy, NlSite, Provider } from './types.ts';
import { PROVIDERS } from './types.ts';
import { esc, inQuietHours, quietHoursEnd } from './util.ts';
import type { AlertCandidate, AlertKind } from './providers/ctx.ts';
import { LinkIndex, type LinkRow } from './links.ts';
import { sendEmail } from './resend.ts';

type Db = SupabaseClient;

/** Dashboard URL and name, mirrored into app_config by the Worker; set by flushAlerts before rendering. */
let APP_URL = '';
let APP_NAME = 'Vibe Central';
export function setIdentity(origin: string, name: string): void { APP_URL = origin || ''; APP_NAME = name || 'Vibe Central'; }

interface HqUser { tz: string; quiet_start: string; quiet_end: string; notifications: Record<string, boolean> | null; alert_to: string }
interface AccountLite { id: string; provider: Provider; label: string; status: string; last_error: string | null }
interface SnapshotLite { account_id: string; kind: string; data: unknown; fetched_at: string }
interface ProjectLite { id: string; name: string; stage: number }

/** hq_user.notifications key that gates each alert kind (defaults mirror the migration). */
const GATE: Record<AlertKind, string> = {
  failed_deploy: 'failedDeploys', failed_run: 'failedDeploys', domain_expiry: 'domainExpiry', app_review: 'appReview',
  token_failure: 'tokenFailure', sync_error: 'syncErrors', new_revenue: 'newRevenue', new_build: 'newBuilds',
};
const DEFAULTS: Record<string, boolean> = { failedDeploys: true, domainExpiry: true, appReview: true, newRevenue: false, tokenFailure: true, syncErrors: false, newBuilds: false };
/** dashboard page (location.hash) each kind links to */
export const PAGE: Record<AlertKind, string> = {
  failed_deploy: 'sites', failed_run: 'projects', domain_expiry: 'domains', app_review: 'stores', new_build: 'stores',
  token_failure: 'connections', sync_error: 'connections', new_revenue: 'revenue',
};

export function enabled(user: HqUser, kind: AlertKind): boolean {
  const key = GATE[kind];
  const v = user.notifications?.[key];
  return typeof v === 'boolean' ? v : (DEFAULTS[key] ?? true);
}

export function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((t.getTime() - yearStart) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

async function must<T>(p: PromiseLike<{ data: T | null; error: { message: string } | null }>, what: string): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(`DB ${what}: ${error.message}`);
  return (data ?? ([] as unknown)) as T;
}

export async function evaluateAlerts(db: Db, input: { now: Date; candidates: AlertCandidate[] }): Promise<{ created: number; considered: number }> {
  const { now } = input;
  const users = await must<HqUser[]>(db.from('hq_user').select('tz,quiet_start,quiet_end,notifications,alert_to').limit(1), 'hq_user');
  const user = users[0];
  if (!user) return { created: 0, considered: 0 };

  const [accounts, linkRows, projects, snapshots] = await Promise.all([
    must<AccountLite[]>(db.from('accounts').select('id,provider,label,status,last_error'), 'accounts'),
    must<LinkRow[]>(db.from('project_links').select('kind,ref,project_id,account_id'), 'project_links'),
    must<ProjectLite[]>(db.from('projects').select('id,name,stage'), 'projects'),
    must<SnapshotLite[]>(db.from('snapshots').select('account_id,kind,data,fetched_at').in('kind', ['deploys', 'sites', 'zones']), 'snapshots'),
  ]);
  const links = new LinkIndex(linkRows);
  const stageOf = new Map(projects.map((p) => [p.id, p.stage]));
  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const dayStamp = now.toISOString().slice(0, 10);

  const candidates: AlertCandidate[] = [...input.candidates];

  // ---- failed deploys in the last 24h (Netlify) ----
  const dayAgo = now.getTime() - 24 * 3600000;
  const sitesByAccount = new Map<string, NlSite[]>();
  for (const s of snapshots) if (s.kind === 'sites' && Array.isArray(s.data)) sitesByAccount.set(s.account_id, s.data as NlSite[]);
  for (const s of snapshots) {
    if (s.kind !== 'deploys' || !Array.isArray(s.data)) continue;
    for (const d of s.data as NlDeploy[]) {
      if ((d.state !== 'error' && d.state !== 'failed') || new Date(d.createdAt).getTime() < dayAgo) continue;
      const site = sitesByAccount.get(s.account_id)?.find((x) => x.id === d.siteId);
      candidates.push({
        kind: 'failed_deploy', fingerprint: `failed_deploy:${d.id}`, accountId: s.account_id,
        title: `Deploy failed: ${d.siteName}`,
        body: [d.errorMessage ?? d.title ?? 'The build did not finish.', d.branch ? `Branch ${d.branch}` : null, site?.adminUrl ? `${site.adminUrl}/deploys/${d.id}` : null].filter(Boolean).join('\n'),
        link: { kind: 'site', ref: d.siteId },
      });
    }
  }

  // ---- domain expiry within 30 days (Cloudflare Registrar) ----
  const week = isoWeek(now);
  for (const s of snapshots) {
    if (s.kind !== 'zones' || !Array.isArray(s.data)) continue;
    for (const z of s.data as CfZone[]) {
      if (!z.expiresAt) continue;
      const days = Math.ceil((new Date(z.expiresAt).getTime() - now.getTime()) / 86400000);
      if (days > 30) continue;
      candidates.push({
        kind: 'domain_expiry', fingerprint: `domain_expiry:${z.name}:${week}`, accountId: s.account_id, urgent: days <= 7,
        title: days < 0 ? `${z.name} expired ${-days}d ago` : `${z.name} expires in ${days} day${days === 1 ? '' : 's'}`,
        body: `Registered with Cloudflare, auto-renew ${z.autoRenew === true ? 'on' : z.autoRenew === false ? 'OFF' : 'unknown'}. Expiry ${z.expiresAt.slice(0, 10)}.`,
        link: { kind: 'domain', ref: z.name },
      });
    }
  }

  // ---- token failures / sync errors ----
  const failing = accounts.filter((a) => a.status === 'error' || a.status === 'expired');
  let streaks = new Map<string, number>();
  if (failing.some((a) => a.status === 'error')) {
    const ids = failing.filter((a) => a.status === 'error').map((a) => a.id);
    const runs = await must<{ account_id: string; ok: boolean | null }[]>(
      db.from('sync_runs').select('account_id,ok').in('account_id', ids).not('ok', 'is', null).order('started_at', { ascending: false }).limit(ids.length * 3), 'sync_runs');
    streaks = consecutiveFailures(runs);
  }
  for (const a of failing) {
    const name = `${PROVIDERS[a.provider]?.name ?? a.provider} · ${a.label}`;
    if (a.status === 'expired' || (streaks.get(a.id) ?? 0) >= 3) {
      candidates.push({
        kind: 'token_failure', fingerprint: `token_failure:${a.id}:${dayStamp}`, accountId: a.id,
        title: `${name} needs attention`, body: `${a.status === 'expired' ? 'The token was rejected; reconnect or paste a new one.' : 'Three syncs in a row failed.'}\n${a.last_error ?? ''}`.trim(),
      });
    } else {
      candidates.push({ kind: 'sync_error', fingerprint: `sync_error:${a.id}:${dayStamp}`, accountId: a.id, title: `Sync error on ${name}`, body: a.last_error ?? 'Unknown error' });
    }
  }

  // ---- gate, resolve project, apply quiet hours, insert ----
  const quiet = inQuietHours(now, user.quiet_start, user.quiet_end, user.tz);
  const quietEnd = quiet ? quietHoursEnd(now, user.quiet_end, user.tz) : now;
  const seen = new Set<string>();
  const rows: Record<string, unknown>[] = [];
  for (const c of candidates) {
    if (seen.has(c.fingerprint) || !enabled(user, c.kind)) continue;
    seen.add(c.fingerprint);
    const projectId = links.resolve(c.link, c.accountId);
    const urgent = c.kind === 'failed_deploy' ? (projectId ? stageOf.get(projectId) === 4 : false) : !!c.urgent;
    const held = quiet && !urgent;
    rows.push({
      fingerprint: c.fingerprint, kind: c.kind, urgent, title: c.title.slice(0, 200), body: c.body.slice(0, 2000),
      project_id: projectId, account_id: c.accountId && accountById.has(c.accountId) ? c.accountId : null,
      send_after: (held ? quietEnd : now).toISOString(), status: held ? 'held' : 'pending',
    });
  }
  if (!rows.length) return { created: 0, considered: candidates.length };
  const inserted = await must<unknown[]>(db.from('alerts').upsert(rows, { onConflict: 'fingerprint', ignoreDuplicates: true }).select('id'), 'alerts upsert');
  return { created: inserted.length, considered: candidates.length };
}

/** Leading run of failures per account from rows ordered newest first. */
export function consecutiveFailures(runs: { account_id: string; ok: boolean | null }[]): Map<string, number> {
  const out = new Map<string, number>();
  const stopped = new Set<string>();
  for (const r of runs) {
    if (stopped.has(r.account_id)) continue;
    if (r.ok === false) out.set(r.account_id, (out.get(r.account_id) ?? 0) + 1);
    else stopped.add(r.account_id);
  }
  return out;
}

interface AlertRow { id: string; kind: AlertKind; urgent: boolean; title: string; body: string; project_id: string | null; account_id: string | null }

export async function flushAlerts(db: Db, env: { resendApiKey: string; alertFrom: string }, now: Date): Promise<{ sent: number; failed: number; pending: number }> {
  const users = await must<HqUser[]>(db.from('hq_user').select('tz,quiet_start,quiet_end,notifications,alert_to').limit(1), 'hq_user');
  const to = users[0]?.alert_to;
  const due = await must<AlertRow[]>(
    db.from('alerts').select('id,kind,urgent,title,body,project_id,account_id').in('status', ['pending', 'held']).lte('send_after', now.toISOString()).order('created_at', { ascending: true }).limit(25), 'alerts due');
  if (!due.length) return { sent: 0, failed: 0, pending: 0 };
  if (!to) {
    await db.from('alerts').update({ status: 'failed', error: 'hq_user.alert_to is empty' }).in('id', due.map((a) => a.id));
    return { sent: 0, failed: due.length, pending: 0 };
  }
  let sent = 0, failed = 0;
  for (const a of due) {
    try {
      await sendEmail({ apiKey: env.resendApiKey, from: env.alertFrom, to, subject: `[${APP_NAME}] ${a.title}`, html: renderHtml(a), text: renderText(a) });
      await db.from('alerts').update({ status: 'sent', sent_at: new Date().toISOString(), error: null }).eq('id', a.id);
      sent++;
      if (a.project_id) {
        await db.from('history').upsert({
          project_id: a.project_id, kind: 'alert', title: a.title, detail: a.body, occurred_at: now.toISOString(), source: 'alerts', fingerprint: `alert:${a.id}`,
        }, { onConflict: 'fingerprint', ignoreDuplicates: true });
      }
    } catch (e) {
      failed++;
      await db.from('alerts').update({ status: 'failed', error: (e instanceof Error ? e.message : String(e)).slice(0, 300) }).eq('id', a.id);
    }
  }
  return { sent, failed, pending: 0 };
}

export function alertLink(a: { kind: AlertKind; project_id: string | null }): string {
  return a.project_id ? `${APP_URL}/#p-${a.project_id}` : `${APP_URL}/#${PAGE[a.kind] ?? 'overview'}`;
}

function renderText(a: AlertRow): string {
  return `${a.title}\n\n${a.body}\n\nOpen ${APP_NAME}: ${alertLink(a)}\n`;
}

function renderHtml(a: AlertRow): string {
  const body = esc(a.body).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" style="color:#7c6cff">$1</a>').replace(/\n/g, '<br>');
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#0f1014;color:#e7e7ee;font:15px/1.5 -apple-system,Segoe UI,Roboto,sans-serif">
<div style="max-width:560px;margin:0 auto;background:#17181f;border:1px solid #262833;border-radius:14px;padding:22px 24px">
  <div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#8e90a0">${APP_NAME}${a.urgent ? ' · urgent' : ''}</div>
  <h1 style="font-size:19px;margin:8px 0 12px;color:#fff">${esc(a.title)}</h1>
  <p style="margin:0 0 18px;color:#c9cad6">${body}</p>
  <a href="${alertLink(a)}" style="display:inline-block;padding:10px 16px;border-radius:10px;background:#7c6cff;color:#fff;text-decoration:none;font-weight:600">Open ${esc(a.project_id ? 'project' : PAGE[a.kind] ?? 'dashboard')}</a>
</div>
<p style="max-width:560px;margin:14px auto 0;font-size:12px;color:#6f7183">Sent by the ${APP_NAME} sync function. Change what gets emailed under Settings → Notifications.</p>
</body></html>`;
}
