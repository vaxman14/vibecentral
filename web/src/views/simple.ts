// Table-driven pages: domains, sites, databases, revenue, stores, help.
import type { DatabasesDTO, DomainsDTO, RevenueDTO, SitesDTO, StoresDTO } from '@shared/types.ts';
import { cached } from '../api.ts';
import type { ViewFn } from '../router.ts';
import { byAcct } from '../state.ts';
import { compact } from '@shared/util.ts';
import { chart, dash, dateOf, esc, pill, stats, tbl, when } from '../ui.ts';

const reqs = (n: number | null | undefined) => (n == null ? '—' : n === 0 ? '0' : compact(n));

const empty = (t: string) => `<p class="muted" style="margin:0">${t}</p>`;
const starRow = (n: number) => '★'.repeat(Math.max(0, Math.min(5, n))) + '☆'.repeat(Math.max(0, 5 - Math.max(0, Math.min(5, n))));

export const domains: ViewFn = async (ctx) => {
  const d = await cached<DomainsDTO>('/api/domains');
  if (!ctx.alive()) return;
  const rows = byAcct(d.domains), workers = byAcct(d.workers);
  ctx.root.innerHTML = `<div class="grid g4">${stats(d.stats, ['◎', '↯', '⛨', '⌁'])}</div>
  <div class="card row"><h2>Domains</h2>${rows.length ? tbl(['Domain', 'Account', 'Status', 'DNS records', 'Requests 7d', 'Renews'], rows.map((r) => [`<b>${esc(r.name)}</b>`, `<span class="muted">${esc(r.account)}</span>`, pill(r.status), dash(r.dnsRecords), reqs(r.requests7d), esc(r.renews ?? (r.expiresAt ? dateOf(r.expiresAt) : '—'))])) : empty('No zones yet. Connect a Cloudflare account.')}</div>
  <div class="card"><h2>Workers</h2>${workers.length ? tbl(['Worker', 'Account', 'Routes', 'Requests 24h', 'Status'], workers.map((w) => [`<b>${esc(w.name)}</b>`, `<span class="muted">${esc(w.account)}</span>`, esc(w.routes || '—'), reqs(w.requests24h), pill(w.status)])) : empty('No Workers found.')}</div>
  ${d.tunnels.length ? `<div class="card row"><h2>Tunnels</h2>${tbl(['Tunnel', 'Account', 'Status'], d.tunnels.map((t) => [`<b>${esc(t.name)}</b>`, `<span class="muted">${esc(t.account)}</span>`, pill(t.status)]))}</div>` : ''}`;
};

export const sites: ViewFn = async (ctx) => {
  const d = await cached<SitesDTO>('/api/sites');
  if (!ctx.alive()) return;
  const rows = byAcct(d.sites), recent = byAcct(d.recent);
  ctx.root.innerHTML = `<div class="card"><h2>Sites</h2>${rows.length ? tbl(['Site', 'Domain', 'Account', 'Last deploy', 'When', 'Build time'], rows.map((s) => [`<b><a href="${esc(s.url)}" target="_blank" rel="noopener" style="color:inherit">${esc(s.name)}</a></b>`, esc(s.domain), `<span class="muted">${esc(s.account)}</span>`, pill(s.state, s.errorMessage ?? undefined), esc(s.when ?? '—'), esc(s.buildTime ?? '—')])) : empty('No sites yet. Connect a Netlify account.')}</div>
  <div class="card row"><h2>Deploys, last 7 days</h2>${chart(d.deploys, 160)}</div>
  ${recent.length ? `<div class="card"><h2>Recent deploys</h2>${tbl(['Site', 'State', 'Branch', 'Title', 'When'], recent.slice(0, 12).map((r) => [`<b>${esc(r.site)}</b>`, pill(r.state), `<span class="mono">${esc(r.branch ?? '—')}</span>`, `<span class="muted">${esc(r.title ?? '—')}</span>`, esc(when(r.at))]))}</div>` : ''}`;
};

export const databases: ViewFn = async (ctx) => {
  const d = await cached<DatabasesDTO>('/api/databases');
  if (!ctx.alive()) return;
  const rows = byAcct(d.projects);
  ctx.root.innerHTML = `<div class="grid g4">${stats(d.stats, ['▤', '⛁', '☺', '⚑'])}</div>
  <div class="card row"><h2>Supabase projects</h2>${rows.length ? tbl(['Project', 'Account', 'Status', 'Database', 'Auth users', 'Region'], rows.map((r) => [`<b>${esc(r.name)}</b>`, `<span class="muted">${esc(r.account)}</span>`, pill(r.status), esc(r.dbSize), dash(r.authUsers), `<span class="mono">${esc(r.region)}</span>`])) : empty('No projects yet. Connect a Supabase account.')}</div>
  ${d.advisors.length ? `<div class="card"><h2>Advisor warnings</h2>${tbl(['Project', 'Category', 'Level', 'Finding'], d.advisors.map((a) => [`<b>${esc(a.project)}</b>`, esc(a.category), pill(a.level === 'ERROR' || a.level === 'error' ? 'Error' : a.level), esc(a.title)]))}</div>` : ''}`;
};

export const revenue: ViewFn = async (ctx) => {
  const d = await cached<RevenueDTO>('/api/revenue');
  if (!ctx.alive()) return;
  const recent = byAcct(d.recent);
  ctx.root.innerHTML = `<div class="grid g4">${stats(d.stats, ['$', '↻', '⇣', 'P'])}</div>
  <div class="card row"><h2>Revenue by day</h2>${chart(d.byDay)}</div>
  <div class="grid g11"><div class="card"><h2>Subscriptions</h2>${d.subscriptions.length ? tbl(['Customer', 'Product', 'Amount', 'Status'], d.subscriptions.map((s) => [`<b>${esc(s.customer)}</b><div class="sub">${esc(s.account)}</div>`, esc(s.product), `${esc(s.amount)} <span class="muted">/ ${esc(s.interval)}</span>`, pill(s.status)])) : empty('No active subscriptions.')}</div>
  <div class="card"><h2>Recent</h2>${recent.length ? tbl(['Amount', 'Description', 'Via', 'When'], recent.slice(0, 15).map((r) => [`<b>${esc(r.amount)}</b>`, `<span class="muted">${esc(r.description)}</span>`, esc(r.kind === 'stripe' ? 'Stripe' : 'PayPal'), esc(when(r.at))])) : empty('No transactions in the window.')}</div></div>`;
};

export const stores: ViewFn = async (ctx) => {
  const d = await cached<StoresDTO>('/api/stores');
  if (!ctx.alive()) return;
  const rows = byAcct(d.apps);
  ctx.root.innerHTML = `<div class="card"><h2>Apps</h2>${rows.length ? tbl(['App', 'Store', 'Version', 'Status', 'Rating'], rows.map((r) => [`<b>${esc(r.app)}</b>`, esc(r.store), `<span class="mono">${esc(r.version)}</span>`, pill(r.status), esc(r.rating || '—')])) : empty('No apps yet. Connect App Store Connect or Google Play.')}</div>
  ${d.reviews.length ? `<div class="card row"><h2>Recent reviews</h2><div class="list">${d.reviews.slice(0, 10).map((r) => `<div class="li"><div><b style="font-weight:600">${esc(r.author)}</b> <span class="muted" style="color:var(--warning)">${starRow(r.stars)}</span><div style="margin-top:2px">${esc(r.text)}</div><div class="meta">${esc(r.app)} · ${esc(r.store)}</div></div><span class="when">${esc(when(r.at))}</span></div>`).join('')}</div></div>` : ''}`;
};

export const help: ViewFn = async (ctx) => {
  ctx.root.innerHTML = `<div class="card"><h2>Help</h2><p class="muted" style="margin:0 0 12px">This dashboard only reads. To add a provider, open Connections and paste a read-only token, or sign in with that provider. Each account syncs every 5 minutes.</p><p class="muted" style="margin:0 0 12px">Docs, setup and source: <a href="https://github.com/vaxman14/vibecentral" target="_blank" rel="noopener">github.com/vaxman14/vibecentral</a>. Want a feature or a new connection? Ask at <a href="https://vibecentral.app" target="_blank" rel="noopener">vibecentral.app</a>.</p><p class="muted" style="margin:0">vibecentral is free and open source. If it saves you time: <a href="https://buymeacoffee.com/romanvaxman" target="_blank" rel="noopener">buy me a coffee</a> ☕</p></div>`;
};
