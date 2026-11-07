// Read-model endpoints: aggregate snapshots/metrics/mail/calendar/usage into the DTOs the web app renders.
import { Hono } from 'hono';
import type { Env, Vars } from '../env.ts';
import { db, getUser, many, type Db, type UserRow } from '../db.ts';
import {
  PROVIDERS, STAGES,
  type AnthropicSummary, type AsApp, type CalEventDTO, type CalendarDTO, type CfTunnel, type CfWorker, type CfZone, type ClaudeDTO, type DatabasesDTO,
  type DomainsDTO, type GhRepo, type GoogleSummary, type GpApp, type HealthRow, type MailDTO, type NlDeploy, type NlSite, type OverviewDTO, type PaypalSummary,
  type RevenueDTO, type SbProject, type SearchItem, type SeriesDTO, type SitesDTO, type StatDTO, type StoresDTO, type StripeSummary, type TrafficDay, type DeployDay,
  type RevenueDay, type SpendDay,
} from '@shared/types.ts';
import { ago, bytes, compact, dayKey, lastNDays, money, pct, shortDay } from '@shared/util.ts';
import { loadAccounts, type AccountRow } from './me.ts';
import { loadProjects, projectMap, taskDTO, historyDTO, type TaskRow, type HistoryRow, type LinkRow } from './projects.ts';
import { loadSnapshots, type SnapRow } from '../views/linkables.ts';

export const viewRoutes = new Hono<{ Bindings: Env; Variables: Vars }>();

// ---------- shared loading ----------
interface Ctx {
  d: Db; user: UserRow; tz: string; accounts: AccountRow[]; acc: Map<string, AccountRow>; snaps: SnapRow[]; links: LinkRow[];
  label(id: string): string; byProvider(p: string): AccountRow[]; snap<T>(provider: string, kind: string): { account: AccountRow; data: T; fetchedAt: string }[];
  projectFor(kind: string, ref: string): string | null;
}
async function ctx(env: Env): Promise<Ctx> {
  const d = db(env);
  const [user, accounts, snaps, links] = await Promise.all([getUser(d), loadAccounts(d), loadSnapshots(d), many<LinkRow>(d.from('project_links').select('*'), 'links')]);
  const acc = new Map(accounts.map((a) => [a.id, a]));
  const label = (id: string) => { const a = acc.get(id); return a ? `${PROVIDERS[a.provider as keyof typeof PROVIDERS]?.name ?? a.provider} · ${a.label}` : 'Unknown'; };
  return {
    d, user, tz: user.tz || 'America/Los_Angeles', accounts, acc, snaps, links, label,
    byProvider: (p) => accounts.filter((a) => a.provider === p),
    snap: <T,>(provider: string, kind: string) => snaps.filter((s) => s.kind === kind && acc.get(s.account_id)?.provider === provider).map((s) => ({ account: acc.get(s.account_id)!, data: s.data as T, fetchedAt: s.fetched_at })),
    projectFor: (kind, ref) => links.find((l) => l.kind === kind && l.ref === ref)?.project_id ?? null,
  };
}

interface MetricRow { account_id: string; kind: string; day: string; values: any }
async function metrics(d: Db, kind: string, days: number, tz: string, accountIds?: string[]): Promise<MetricRow[]> {
  const from = lastNDays(days, tz)[0];
  let q = d.from('metrics').select('account_id,kind,day,values').eq('kind', kind).gte('day', from);
  if (accountIds) q = q.in('account_id', accountIds.length ? accountIds : ['00000000-0000-0000-0000-000000000000']);
  return many<MetricRow>(q, 'metrics');
}
function series(rows: MetricRow[], days: string[], pick: (v: any) => number): number[] {
  return days.map((day) => rows.filter((r) => r.day === day).reduce((a, r) => a + (Number(pick(r.values)) || 0), 0));
}
const stat = (label: string, value: string, unit: string, p: number, sub: string): StatDTO => ({ label, value, unit: unit || undefined, pct: Math.max(0, Math.min(100, Math.round(p))), sub });
const fmtMonth = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }) : null);
const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—');
const daysUntil = (iso: string | null) => (iso ? Math.ceil((new Date(iso).getTime() - Date.now()) / 86400000) : null);
const plural = (n: number, s: string, p = s + 's') => `${n} ${n === 1 ? s : p}`;

const nlState = (s: string | null | undefined) => {
  const v = (s || '').toLowerCase();
  if (v === 'ready') return 'Published';
  if (v === 'error' || v === 'failed') return 'Failed';
  if (['building', 'enqueued', 'processing', 'new', 'preparing', 'uploading', 'uploaded'].includes(v)) return 'Building';
  return s ? s[0].toUpperCase() + s.slice(1) : '—';
};
const sbState = (s: string) => {
  const v = (s || '').toUpperCase();
  if (v === 'ACTIVE_HEALTHY') return 'Healthy';
  if (v === 'INACTIVE' || v === 'PAUSED' || v === 'PAUSING') return 'Paused';
  if (['COMING_UP', 'RESTORING', 'UPGRADING', 'RESTARTING', 'INIT_FAILED'].includes(v)) return v === 'INIT_FAILED' ? 'Failed' : 'Building';
  if (v === 'ACTIVE_UNHEALTHY' || v === 'DEGRADED' || v === 'UNHEALTHY') return 'Error';
  if (v === 'STARTING') return 'Building';
  return s || '—';
};
const asState = (s: string | null) => {
  const m: Record<string, string> = { READY_FOR_SALE: 'Live', READY_FOR_DISTRIBUTION: 'Live', WAITING_FOR_REVIEW: 'Waiting', IN_REVIEW: 'In review', PENDING_DEVELOPER_RELEASE: 'Approved', PREPARE_FOR_SUBMISSION: 'Preparing', DEVELOPER_REJECTED: 'Rejected', REJECTED: 'Rejected', METADATA_REJECTED: 'Rejected', INVALID_BINARY: 'Rejected', PROCESSING_FOR_DISTRIBUTION: 'Processing', PENDING_APPLE_RELEASE: 'Approved', WAITING_FOR_EXPORT_COMPLIANCE: 'Waiting', REMOVED_FROM_SALE: 'Removed', DEVELOPER_REMOVED_FROM_SALE: 'Removed' };
  return s ? m[s] ?? s.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase()) : '—';
};

// ---------- domains ----------
async function domains(x: Ctx): Promise<DomainsDTO> {
  const zones = x.snap<CfZone[]>('cloudflare', 'zones').flatMap((s) => s.data.map((z) => ({ ...z, accountId: s.account.id })));
  const workers = x.snap<CfWorker[]>('cloudflare', 'workers').flatMap((s) => s.data.map((w) => ({ ...w, accountId: s.account.id })));
  const tunnels = x.snap<CfTunnel[]>('cloudflare', 'tunnels').flatMap((s) => s.data.map((t) => ({ ...t, accountId: s.account.id })));
  const cfIds = x.byProvider('cloudflare').map((a) => a.id);
  const days14 = lastNDays(14, x.tz);
  const tr = await metrics(x.d, 'traffic', 14, x.tz, cfIds);
  const req = series(tr, days14, (v: TrafficDay) => v.requests);
  const thisWeek = req.slice(7).reduce((a, b) => a + b, 0), lastWeek = req.slice(0, 7).reduce((a, b) => a + b, 0);
  const wow = lastWeek ? Math.round(((thisWeek - lastWeek) / lastWeek) * 100) : null;
  const threats = zones.reduce((a, z) => a + (z.threats7d || 0), 0);
  const topThreat = [...zones].sort((a, b) => b.threats7d - a.threats7d)[0];
  const live = tunnels.filter((t) => (t.status || '').toLowerCase() === 'healthy' || (t.status || '').toLowerCase() === 'active');
  const active = zones.filter((z) => z.status === 'active' && !z.paused).length;
  const stats: StatDTO[] = [
    stat('Zones', String(zones.length), '', pct(active, zones.length), plural(cfIds.length, 'Cloudflare account')),
    stat('Requests, 7 days', compact(zones.reduce((a, z) => a + (z.requests7d || 0), 0)), '', wow === null ? 50 : 50 + Math.max(-50, Math.min(50, wow)), wow === null ? 'No previous week yet' : `${wow >= 0 ? '+' : ''}${wow}% week over week`),
    stat('Threats blocked', threats.toLocaleString('en-US'), '', Math.min(100, threats / 100), topThreat && topThreat.threats7d ? `Mostly on ${topThreat.name}` : 'Last 7 days'),
    stat('Tunnels', String(live.length), tunnels.length ? 'live' : '', pct(live.length, tunnels.length || 1), tunnels.map((t) => t.name).slice(0, 3).join(', ') || 'None'),
  ];
  const rows = zones.map((z) => {
    const du = daysUntil(z.expiresAt);
    const status = z.paused ? 'Paused' : du !== null && du <= 30 ? 'Expiring' : z.status === 'active' ? 'Active' : z.status.replace(/^\w/, (c) => c.toUpperCase());
    return { name: z.name, accountId: z.accountId, account: x.label(z.accountId), status, dnsRecords: z.dnsRecords, requests7d: z.requests7d, renews: fmtMonth(z.expiresAt), expiresAt: z.expiresAt, projectId: x.projectFor('domain', z.name) };
  }).sort((a, b) => b.requests7d - a.requests7d);
  return {
    stats, domains: rows,
    workers: workers.map((w) => ({ name: w.name, accountId: w.accountId, account: x.label(w.accountId), routes: w.routes.join(', ') || '—', requests24h: w.requests24h, status: w.errors24h > 0 && w.requests24h > 0 && w.errors24h / w.requests24h > 0.05 ? 'Error' : 'Live' })),
    tunnels: tunnels.map((t) => ({ name: t.name, account: x.label(t.accountId), status: t.status })),
  };
}

// ---------- sites ----------
async function sites(x: Ctx): Promise<SitesDTO> {
  const list = x.snap<NlSite[]>('netlify', 'sites').flatMap((s) => s.data.map((site) => ({ ...site, accountId: s.account.id })));
  const deploys = x.snap<NlDeploy[]>('netlify', 'deploys').flatMap((s) => s.data.map((dep) => ({ ...dep, accountId: s.account.id })));
  const ids = x.byProvider('netlify').map((a) => a.id);
  const days = lastNDays(7, x.tz);
  const m = await metrics(x.d, 'deploys', 7, x.tz, ids);
  const rows = list.map((s) => ({
    id: s.id, name: s.name, domain: s.customDomain || s.url.replace(/^https?:\/\//, ''), accountId: s.accountId, account: x.label(s.accountId),
    state: nlState(s.lastDeploy?.state), when: s.lastDeploy ? ago(s.lastDeploy.createdAt) : null,
    buildTime: s.lastDeploy ? (s.lastDeploy.deployTimeSec != null ? `${s.lastDeploy.deployTimeSec}s` : nlState(s.lastDeploy.state) === 'Building' ? '…' : null) : null,
    url: s.url, adminUrl: s.adminUrl, errorMessage: s.lastDeploy?.errorMessage ?? null, projectId: x.projectFor('site', s.id),
  })).sort((a, b) => (a.state === 'Failed' ? -1 : 0) - (b.state === 'Failed' ? -1 : 0) || a.name.localeCompare(b.name));
  return {
    sites: rows,
    deploys: { labels: days.map(shortDay), series: [{ name: 'Deploys', color: 1, data: series(m, days, (v: DeployDay) => v.deploys) }, { name: 'Failed', color: 2, data: series(m, days, (v: DeployDay) => v.failed) }] },
    recent: deploys.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 30).map((d) => ({ site: d.siteName, state: nlState(d.state), at: d.createdAt, branch: d.branch, title: d.title, accountId: d.accountId })),
  };
}

// ---------- databases ----------
function databases(x: Ctx): DatabasesDTO {
  const projects = x.snap<SbProject[]>('supabase', 'projects').flatMap((s) => s.data.map((p) => ({ ...p, accountId: s.account.id })));
  const storage = projects.reduce((a, p) => a + (p.dbSizeBytes || 0) + (p.storageBytes || 0), 0);
  const users = projects.reduce((a, p) => a + (p.authUsers || 0), 0);
  const topUsers = [...projects].sort((a, b) => (b.authUsers || 0) - (a.authUsers || 0))[0];
  const warn = projects.reduce((a, p) => a + (p.advisors?.security || 0) + (p.advisors?.performance || 0), 0);
  const topWarn = [...projects].sort((a, b) => ((b.advisors?.security || 0) + (b.advisors?.performance || 0)) - ((a.advisors?.security || 0) + (a.advisors?.performance || 0)))[0];
  const healthy = projects.filter((p) => sbState(p.status) === 'Healthy').length;
  const gb = storage / 1e9;
  const stats: StatDTO[] = [
    stat('Projects', String(projects.length), '', pct(healthy, projects.length || 1), plural(x.byProvider('supabase').length, 'Supabase account')),
    stat('Storage', gb >= 1 ? gb.toFixed(1) : String(Math.round(storage / 1e6)), gb >= 1 ? ' GB' : ' MB', Math.min(100, gb * 10), 'Database and files, all projects'),
    stat('Auth users', users.toLocaleString('en-US'), '', Math.min(100, users / 10), topUsers?.authUsers ? `${topUsers.name} has the most` : 'Across all projects'),
    stat('Advisor warnings', String(warn), '', Math.min(100, warn * 10), topWarn && warn ? `Most on ${topWarn.name}` : 'None open'),
  ];
  return {
    stats,
    projects: projects.map((p) => ({ ref: p.ref, name: p.name, accountId: p.accountId, account: x.label(p.accountId), status: sbState(p.status), dbSize: p.dbSizeBytes != null ? bytes(p.dbSizeBytes) : '—', authUsers: p.authUsers, region: p.region, advisors: (p.advisors?.security || 0) + (p.advisors?.performance || 0), projectId: x.projectFor('database', p.ref) })),
    advisors: projects.flatMap((p) => (p.advisors?.items || []).map((i) => ({ project: p.name, ...i }))),
  };
}

// ---------- revenue ----------
async function revenue(x: Ctx): Promise<RevenueDTO> {
  const stripe = x.snap<StripeSummary>('stripe', 'stripe');
  const paypal = x.snap<PaypalSummary>('paypal', 'paypal');
  const cur = stripe[0]?.data.currency || paypal[0]?.data.currency || 'USD';
  const s30 = stripe.reduce((a, s) => a + s.data.revenue30d, 0), sPrev = stripe.reduce((a, s) => a + s.data.revenuePrev30d, 0);
  const p30 = paypal.reduce((a, s) => a + s.data.revenue30d, 0);
  const total = s30 + p30;
  const delta = sPrev ? Math.round(((s30 - sPrev) / sPrev) * 100) : null;
  const subs = stripe.flatMap((s) => s.data.subscriptions.map((sub) => ({ ...sub, account: s.account.label })));
  const products = [...new Set(subs.map((s) => s.product))].slice(0, 2).join(' and ');
  const payouts = stripe.map((s) => s.data.nextPayout && { ...s.data.nextPayout, account: s.account.label }).filter(Boolean) as { amount: number; arrivalDate: string; status: string; account: string }[];
  const next = payouts.sort((a, b) => a.arrivalDate.localeCompare(b.arrivalDate))[0];
  const days = lastNDays(7, x.tz);
  const [sm, pm] = await Promise.all([metrics(x.d, 'revenue', 7, x.tz, x.byProvider('stripe').map((a) => a.id)), metrics(x.d, 'revenue', 7, x.tz, x.byProvider('paypal').map((a) => a.id))]);
  const stats: StatDTO[] = [
    stat('Revenue, 30 days', money(total, cur), '', delta === null ? 50 : 50 + Math.max(-50, Math.min(50, delta)), delta === null ? `Stripe and PayPal, ${plural(stripe.length + paypal.length, 'account')}` : `${delta >= 0 ? '+' : ''}${delta}% vs last month`),
    stat('Subscriptions', String(subs.length), subs.length ? 'active' : '', Math.min(100, subs.length * 5), products || 'No active subscriptions'),
    stat('Next payout', next ? money(next.amount, cur) : '—', '', next ? 50 : 0, next ? `Stripe · ${fmtDate(next.arrivalDate)}` : 'Nothing scheduled'),
    stat('PayPal, 30 days', money(p30, cur), '', total ? pct(p30, total) : 0, plural(paypal.reduce((a, s) => a + s.data.txnCount30d, 0), 'transaction')),
  ];
  const recent = [
    ...stripe.flatMap((s) => s.data.recent.map((t) => ({ account: s.account.label, accountId: s.account.id, amount: money(t.amount, t.currency || cur), description: t.description, at: t.createdAt, status: t.status, kind: 'stripe' as const }))),
    ...paypal.flatMap((s) => s.data.recent.map((t) => ({ account: s.account.label, accountId: s.account.id, amount: money(t.amount, t.currency || cur), description: t.description, at: t.createdAt, status: t.status, kind: 'paypal' as const }))),
  ].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 40);
  return {
    stats,
    byDay: { labels: days.map(shortDay), series: [{ name: 'Stripe ($)', color: 1, data: series(sm, days, (v: RevenueDay) => v.amount / 100) }, { name: 'PayPal ($)', color: 2, data: series(pm, days, (v: RevenueDay) => v.amount / 100) }] },
    subscriptions: subs.map((s) => ({ account: s.account, customer: s.customer, product: s.product, amount: money(s.amount, cur), interval: s.interval, status: s.status })),
    recent,
  };
}

// ---------- stores ----------
function stores(x: Ctx): StoresDTO {
  const apps: StoresDTO['apps'] = [];
  const reviews: StoresDTO['reviews'] = [];
  for (const s of x.snap<AsApp[]>('appstore', 'apps')) for (const a of s.data) {
    const pid = x.projectFor('app', a.bundleId);
    const version = a.pendingVersion && a.pendingState && a.pendingState !== 'READY_FOR_SALE' ? a.pendingVersion : a.liveVersion;
    const state = a.pendingVersion && a.pendingState && a.pendingState !== 'READY_FOR_SALE' ? a.pendingState : a.liveState;
    apps.push({ app: a.name, store: 'App Store', version: version || (a.latestBuild ? `${a.latestBuild.version} (${a.latestBuild.build})` : '—'), status: asState(state), rating: a.rating != null ? a.rating.toFixed(1) : '—', accountId: s.account.id, projectId: pid });
    if (a.testflight) apps.push({ app: a.name, store: 'TestFlight', version: `${a.testflight.version} (${a.testflight.build})`, status: asState(a.testflight.state), rating: '—', accountId: s.account.id, projectId: pid });
  }
  for (const s of x.snap<GpApp[]>('googleplay', 'apps')) for (const a of s.data) {
    const pid = x.projectFor('app', a.packageName);
    const linked = x.links.find((l) => l.kind === 'app' && l.ref === a.packageName);
    apps.push({ app: a.name || linked?.label?.replace(/ \(Google Play\)$/, '') || a.packageName, store: 'Google Play', version: '—', status: a.rating != null || (a.installs || 0) > 0 ? 'Live' : '—', rating: a.rating != null ? a.rating.toFixed(1) : '—', accountId: s.account.id, projectId: pid });
    for (const r of a.reviews || []) reviews.push({ app: a.name || a.packageName, store: 'Google Play', author: r.author, stars: r.stars, text: r.text, at: r.at });
  }
  return { apps: apps.sort((a, b) => a.app.localeCompare(b.app) || a.store.localeCompare(b.store)), reviews: reviews.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 30) };
}

// ---------- calendar ----------
const ACCOUNT_COLORS = ['#B9A5FF', '#F5C542', '#42D9D0', '#67D391', '#F08CC6', '#AEB5FF', '#E8AE48', '#FF94A7'];
function colorFor(x: Ctx, accountId: string): string {
  const g = x.byProvider('google');
  const i = g.findIndex((a) => a.id === accountId);
  return ACCOUNT_COLORS[(i < 0 ? 0 : i) % ACCOUNT_COLORS.length];
}
async function calendar(x: Ctx): Promise<CalendarDTO> {
  interface Row { account_id: string; event_id: string; calendar_id: string; calendar_name: string | null; color: string | null; title: string; starts_at: string; ends_at: string | null; all_day: boolean }
  const today = dayKey(new Date(), x.tz);
  const weekEnd = lastNDays(1, x.tz, new Date(Date.now() + 7 * 86400000))[0];
  const rows = await many<Row>(x.d.from('cal_events').select('*').gte('starts_at', new Date(Date.now() - 86400000).toISOString()).lte('starts_at', new Date(Date.now() + 8 * 86400000).toISOString()).order('starts_at'), 'calendar');
  const toDTO = (r: Row): CalEventDTO => ({ id: r.event_id, accountId: r.account_id, account: x.acc.get(r.account_id)?.label ?? '', title: r.title, calendar: r.calendar_name || 'Calendar', color: r.color || colorFor(x, r.account_id), startsAt: r.starts_at, endsAt: r.ends_at, allDay: r.all_day });
  const dayOf = (r: Row) => dayKey(r.starts_at, x.tz);
  const all = rows.map((r) => ({ r, day: dayOf(r) }));
  const calendars = x.snap<GoogleSummary>('google', 'google').flatMap((s) => s.data.calendars.map((c) => ({ id: c.id, name: c.name, account: s.account.label, color: c.color || colorFor(x, s.account.id) })));
  return {
    today: all.filter((e) => e.day === today).map((e) => toDTO(e.r)),
    week: all.filter((e) => e.day >= today && e.day <= weekEnd).map((e) => toDTO(e.r)),
    calendars,
  };
}

// ---------- mail ----------
async function mail(x: Ctx): Promise<MailDTO> {
  interface Row { account_id: string; message_id: string; from_name: string | null; from_email: string | null; subject: string | null; snippet: string | null; received_at: string; important: boolean; unread: boolean }
  const rows = await many<Row>(x.d.from('mail_items').select('account_id,message_id,from_name,from_email,subject,snippet,received_at,important,unread').order('received_at', { ascending: false }).limit(300), 'mail');
  return {
    items: rows.map((r) => {
      const from = r.from_name || (r.from_email || '').split('@')[0] || 'Unknown';
      return { id: r.message_id, accountId: r.account_id, account: x.acc.get(r.account_id)?.label ?? '', from, fromEmail: r.from_email || '', subject: r.subject || '(no subject)', snippet: r.snippet || '', at: r.received_at, important: r.important, unread: r.unread, color: colorFor(x, r.account_id), initial: from[0].toUpperCase() };
    }),
    accounts: x.byProvider('google').map((a) => ({ id: a.id, email: a.meta?.email || a.label })),
  };
}

// ---------- claude ----------
async function claude(x: Ctx): Promise<ClaudeDTO> {
  const orgs = x.snap<AnthropicSummary>('anthropic', 'anthropic');
  const ids = x.byProvider('anthropic').map((a) => a.id);
  const days7 = lastNDays(7, x.tz);
  const sm = await metrics(x.d, 'spend', 7, x.tz, ids);
  const cost = orgs.reduce((a, o) => a + o.data.monthCostCents, 0);
  const tok = orgs.reduce((a, o) => ({ input: a.input + o.data.monthTokens.input, output: a.output + o.data.monthTokens.output, cacheRead: a.cacheRead + o.data.monthTokens.cacheRead, cacheWrite: a.cacheWrite + o.data.monthTokens.cacheWrite }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  const allIn = tok.input + tok.cacheRead + tok.cacheWrite;
  const hit = allIn ? Math.round((tok.cacheRead / allIn) * 100) : 0;
  const ws = orgs.flatMap((o) => o.data.workspaces.map((w) => ({ org: o.data.orgName || o.account.label, workspace: w.name, models: w.models.join(', ') || '—', spendCents: w.costCents, spend: money(w.costCents), input: w.input, output: w.output }))).sort((a, b) => b.spendCents - a.spendCents);
  const top = ws[0];
  const dom = new Date().getDate(), dim = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();
  const api: ClaudeDTO['api'] = {
    connected: orgs.length > 0,
    stats: [
      stat('API spend, this month', money(cost), '', pct(dom, dim), orgs.map((o) => o.data.orgName || o.account.label).join(', ') || 'No Anthropic org connected'),
      stat('Tokens', compact(tok.input + tok.output + tok.cacheRead + tok.cacheWrite), '', 60, `Input ${compact(tok.input)} · output ${compact(tok.output)}`),
      stat('Cache hit rate', `${hit}%`, '', hit, `Cache read ${compact(tok.cacheRead)} · write ${compact(tok.cacheWrite)}`),
      stat('Top workspace', top ? top.workspace : '—', '', top && cost ? pct(top.spendCents, cost) : 0, top ? `${money(top.spendCents)} of ${money(cost)}` : 'No spend this month'),
    ],
    byDay: { labels: days7.map(shortDay), series: [{ name: 'API ($)', color: 1, data: series(sm, days7, (v: SpendDay) => v.costCents / 100) }] },
    workspaces: ws.map(({ spendCents, ...w }) => w),
  };

  // subscription usage from the local agents
  interface URow { day: string; machine: string; folder_key: string; folder_name: string; model: string; input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number; messages: number; sessions: number }
  const days14 = lastNDays(14, x.tz);
  const [urows, beats, folders, pm] = await Promise.all([
    many<URow>(x.d.from('usage_daily').select('*').gte('day', lastNDays(31, x.tz)[0]), 'usage'),
    many<{ machine: string; last_seen: string; agent_version: string | null }>(x.d.from('agent_heartbeats').select('*'), 'heartbeats'),
    many<{ folder_key: string; project_id: string | null }>(x.d.from('folder_map').select('folder_key,project_id'), 'folders'),
    projectMap(x.d),
  ]);
  const today = days14[13], weekStart = days14[7], week = urows.filter((r) => r.day >= weekStart), todayRows = urows.filter((r) => r.day === today);
  const sum = (rows: URow[]) => rows.reduce((a, r) => ({ input: a.input + Number(r.input_tokens), output: a.output + Number(r.output_tokens), cacheRead: a.cacheRead + Number(r.cache_read_tokens), cacheWrite: a.cacheWrite + Number(r.cache_write_tokens), messages: a.messages + r.messages }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0 });
  const t = sum(todayRows), w = sum(week), m = sum(urows);
  const wAll = w.input + w.cacheRead + w.cacheWrite;
  const group = <K extends string>(rows: URow[], key: (r: URow) => K) => {
    const mp = new Map<K, URow[]>();
    for (const r of rows) mp.set(key(r), [...(mp.get(key(r)) || []), r]);
    return [...mp.entries()].map(([k, rs]) => ({ key: k, ...sum(rs) })).sort((a, b) => (b.input + b.output + b.cacheRead) - (a.input + a.output + a.cacheRead));
  };
  const fmap = new Map(folders.map((f) => [f.folder_key, f.project_id]));
  const subscription: ClaudeDTO['subscription'] = {
    connected: beats.length > 0,
    machines: beats.map((b) => ({ machine: b.machine, lastSeen: b.last_seen, agentVersion: b.agent_version })),
    stats: [
      stat('Tokens today', compact(t.input + t.output + t.cacheRead + t.cacheWrite), '', Math.min(100, (t.input + t.output + t.cacheRead) / 5e5), `Output ${compact(t.output)} · ${plural(t.messages, 'message')}`),
      stat('Tokens, 7 days', compact(w.input + w.output + w.cacheRead + w.cacheWrite), '', Math.min(100, (w.input + w.output + w.cacheRead) / 3e6), `Output ${compact(w.output)} · ${plural(w.messages, 'message')}`),
      stat('Cache read share', `${wAll ? Math.round((w.cacheRead / wAll) * 100) : 0}%`, '', wAll ? Math.round((w.cacheRead / wAll) * 100) : 0, 'Of all input this week'),
      stat('Tokens, 30 days', compact(m.input + m.output + m.cacheRead + m.cacheWrite), '', Math.min(100, (m.input + m.output + m.cacheRead) / 1e7), `${plural(beats.length, 'machine')} reporting`),
    ],
    byDay: {
      labels: days14.map(shortDay),
      series: [
        { name: 'Tokens in + out (K)', color: 1, data: days14.map((d) => Math.round(urows.filter((r) => r.day === d).reduce((a, r) => a + Number(r.input_tokens) + Number(r.output_tokens), 0) / 1000)) },
        { name: 'Cache read (K)', color: 2, data: days14.map((d) => Math.round(urows.filter((r) => r.day === d).reduce((a, r) => a + Number(r.cache_read_tokens), 0) / 1000)) },
      ],
    },
    byProject: group(urows, (r) => r.folder_key).map((g) => { const pid = fmap.get(g.key) ?? null; const folderName = urows.find((r) => r.folder_key === g.key)?.folder_name || g.key; return { project: pid ? pm.get(pid)?.name ?? pid : folderName, projectId: pid, folder: folderName, input: g.input, output: g.output, cacheRead: g.cacheRead, cacheWrite: g.cacheWrite, messages: g.messages }; }),
    byModel: group(urows, (r) => r.model).map((g) => ({ model: g.key, input: g.input, output: g.output, cacheRead: g.cacheRead, cacheWrite: g.cacheWrite, messages: g.messages })),
    byMachine: group(urows, (r) => r.machine).map((g) => ({ machine: g.key, input: g.input, output: g.output, cacheRead: g.cacheRead, cacheWrite: g.cacheWrite, messages: g.messages })),
    range: { from: lastNDays(31, x.tz)[0], to: today },
  };
  return { api, subscription };
}

// ---------- overview ----------
async function overview(x: Ctx): Promise<OverviewDTO> {
  const [projects, tasks, history, dom, st, dbs, rev, cl, cal, mailDTO] = await Promise.all([
    loadProjects(x.d),
    many<TaskRow>(x.d.from('tasks').select('*').eq('done', false).order('created_at', { ascending: false }).limit(50), 'tasks'),
    many<HistoryRow>(x.d.from('history').select('*').not('project_id', 'is', null).neq('kind', 'system').order('occurred_at', { ascending: false }).limit(60), 'history'),
    domains(x), sites(x), Promise.resolve(databases(x)), revenue(x), claude(x), calendar(x), mail(x),
  ]);
  const pm = await projectMap(x.d);
  const failed = st.sites.filter((s) => s.state === 'Failed');
  const activeProjects = projects.filter((p) => p.stage >= 1);
  const weekAgo = Date.now() - 7 * 86400000;
  const counts = new Map<string, number>();
  for (const h of history) if (h.project_id && new Date(h.occurred_at).getTime() > weekAgo) counts.set(h.project_id, (counts.get(h.project_id) || 0) + 1);
  const fastest = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  const openTasks = tasks.length;
  const parts = [plural(projects.length, 'project'), plural(openTasks, 'open task')];
  if (failed.length) parts.push(plural(failed.length, 'failed deploy'));
  const summary = `${parts.slice(0, -1).join(', ')}${parts.length > 1 ? ', and ' : ''}${parts.at(-1)} across ${plural(x.accounts.length, 'account')}.` + (fastest ? ` ${pm.get(fastest[0])?.name ?? fastest[0]} is the one moving fastest this week.` : '');
  const notes: string[] = [];
  for (const f of failed) notes.push(`Netlify: **${f.name}** failed to deploy${f.when ? ' ' + f.when : ''}.`);
  for (const d of dom.domains) { const du = daysUntil(d.expiresAt); if (du !== null && du <= 30) notes.push(`**${d.name}** expires in ${plural(du, 'day')}.`); }
  for (const a of x.accounts) if (a.status === 'expired' || a.status === 'error') notes.push(`${x.label(a.id)} ${a.status === 'expired' ? 'needs reconnecting' : 'sync failed'}${a.last_error ? ': ' + a.last_error : ''}.`);
  const byStage = (s: number) => projects.filter((p) => p.stage === s).length;
  const stageSub = [[4, 'live'], [3, 'in review'], [2, 'in beta'], [1, 'building']].map(([s, n]) => (byStage(s as number) ? `${byStage(s as number)} ${n}` : '')).filter(Boolean).join(', ');
  const dueSoon = tasks.filter((t) => /today|tomorrow|this week|now|next/i.test(t.due_label || '')).length;
  const stats: OverviewDTO['stats'] = [
    stat('Active projects', String(activeProjects.length), `of ${projects.length}`, pct(activeProjects.length, projects.length), stageSub || 'All ideas so far'),
    stat('Open tasks', String(openTasks), '', Math.min(100, openTasks * 4), `${dueSoon} due this week`),
    rev.stats[0] ? { ...rev.stats[0], sub: `Stripe and PayPal, ${plural(x.byProvider('stripe').length + x.byProvider('paypal').length, 'account')}` } : stat('Revenue, 30 days', '$0', '', 0, 'Connect Stripe or PayPal'),
    cl.api.connected ? { ...cl.api.stats[0], label: 'Claude API spend', sub: 'This month, all orgs' } : stat('Claude API spend', '—', '', 0, 'Connect an Anthropic admin key'),
  ];
  const cfIds = x.byProvider('cloudflare').map((a) => a.id);
  const days = lastNDays(7, x.tz);
  const tr = await metrics(x.d, 'traffic', 7, x.tz, cfIds);
  const traffic: SeriesDTO = { labels: days.map(shortDay), series: [{ name: 'Requests (K)', color: 1, data: series(tr, days, (v: TrafficDay) => v.requests / 1000).map((v) => Math.round(v)) }, { name: 'Visitors (K)', color: 2, data: series(tr, days, (v: TrafficDay) => v.visitors / 1000).map((v) => Math.round(v * 10) / 10) }] };
  const health: HealthRow[] = [];
  if (cfIds.length) { const z = dom.domains, a = z.filter((d) => d.status === 'Active').length; health.push({ label: 'Cloudflare zones', value: `${a} of ${z.length} active`, tone: a === z.length ? 'good' : 'warn' }); }
  if (x.byProvider('netlify').length) { const p = st.sites.filter((s) => s.state === 'Published').length; health.push({ label: 'Netlify sites', value: `${p} of ${st.sites.length} published`, tone: failed.length ? 'warn' : 'good' }); }
  if (x.byProvider('supabase').length) { const h = dbs.projects.filter((p) => p.status === 'Healthy').length, paused = dbs.projects.filter((p) => p.status === 'Paused').length; health.push({ label: 'Supabase projects', value: `${h} healthy${paused ? `, ${paused} paused` : ''}`, tone: h === dbs.projects.length ? 'good' : paused ? 'good' : 'warn' }); }
  if (x.byProvider('appstore').length || x.byProvider('googleplay').length) { const waiting = x.snap<AsApp[]>('appstore', 'apps').flatMap((s) => s.data).filter((a) => a.pendingState && a.pendingState !== 'READY_FOR_SALE').length; health.push({ label: 'App reviews', value: waiting ? `${waiting} waiting` : 'Nothing in review', tone: waiting ? 'warn' : 'good' }); }
  if (x.byProvider('google').length) { const n = mailDTO.items.filter((m) => m.important && m.unread).length; health.push({ label: 'Inbox', value: `${n} unread that matter`, tone: 'dim' }); }
  if (x.byProvider('github').length) { const runs = x.snap<any[]>('github', 'runs').flatMap((s) => s.data), f = runs.filter((r) => r.conclusion === 'failure').length; health.push({ label: 'GitHub Actions', value: f ? `${f} failed recently` : 'All green', tone: f ? 'warn' : 'good' }); }
  const failingAcc = x.accounts.filter((a) => a.status === 'error' || a.status === 'expired').length;
  if (x.accounts.length) health.push({ label: 'Sync', value: failingAcc ? `${failingAcc} of ${x.accounts.length} accounts failing` : `${x.accounts.length} accounts healthy`, tone: failingAcc ? 'bad' : 'good' });
  return {
    greetingName: (x.user.name || '').split(' ')[0] || 'there',
    summary, notes, stats, traffic, health,
    projects: projects.slice(0, 6),
    today: cal.today.slice(0, 4),
    openTasks: tasks.slice(0, 5).map((t) => taskDTO(t, pm)),
    history: history.slice(0, 5).map((h) => historyDTO(h, pm)),
  };
}

// ---------- search ----------
async function search(x: Ctx): Promise<SearchItem[]> {
  const [projects, tasks, mailRows] = await Promise.all([
    loadProjects(x.d),
    many<TaskRow>(x.d.from('tasks').select('*').eq('done', false).limit(200), 'tasks'),
    many<{ message_id: string; subject: string | null; from_name: string | null }>(x.d.from('mail_items').select('message_id,subject,from_name').order('received_at', { ascending: false }).limit(60), 'mail'),
  ]);
  const items: SearchItem[] = [];
  for (const p of projects) items.push({ t: p.name, k: 'Project', h: '#p-' + p.id, i: '▦' });
  for (const s of x.snap<CfZone[]>('cloudflare', 'zones')) for (const z of s.data) items.push({ t: z.name, k: 'Domain', h: '#domains', i: '◎', sub: s.account.label });
  for (const s of x.snap<NlSite[]>('netlify', 'sites')) for (const z of s.data) items.push({ t: z.name, k: 'Site', h: '#sites', i: '◆', sub: s.account.label });
  for (const s of x.snap<SbProject[]>('supabase', 'projects')) for (const z of s.data) items.push({ t: z.name, k: 'Database', h: '#databases', i: '▤', sub: s.account.label });
  for (const s of x.snap<GhRepo[]>('github', 'repos')) for (const z of s.data) items.push({ t: z.fullName, k: 'Repo', h: '#history', i: '⌥' });
  for (const s of x.snap<AsApp[]>('appstore', 'apps')) for (const z of s.data) items.push({ t: z.name, k: 'App', h: '#stores', i: '▸' });
  for (const t of tasks) items.push({ t: t.title, k: 'Task', h: '#tasks', i: '✓' });
  for (const m of mailRows) items.push({ t: `${m.from_name || ''}: ${m.subject || ''}`.replace(/^: /, ''), k: 'Mail', h: '#mail', i: '✉' });
  return items;
}

viewRoutes.get('/overview', async (c) => c.json(await overview(await ctx(c.env))));
viewRoutes.get('/domains', async (c) => c.json(await domains(await ctx(c.env))));
viewRoutes.get('/sites', async (c) => c.json(await sites(await ctx(c.env))));
viewRoutes.get('/databases', async (c) => c.json(databases(await ctx(c.env))));
viewRoutes.get('/revenue', async (c) => c.json(await revenue(await ctx(c.env))));
viewRoutes.get('/stores', async (c) => c.json(stores(await ctx(c.env))));
viewRoutes.get('/calendar', async (c) => c.json(await calendar(await ctx(c.env))));
viewRoutes.get('/mail', async (c) => c.json(await mail(await ctx(c.env))));
viewRoutes.get('/claude', async (c) => c.json(await claude(await ctx(c.env))));
viewRoutes.get('/search', async (c) => c.json(await search(await ctx(c.env))));

export { STAGES };
