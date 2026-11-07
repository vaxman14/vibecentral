// Dev-only fixtures that reproduce the mockup's sample data for every endpoint (http://localhost:5173/?mock=1).
// Loaded lazily by api.ts behind import.meta.env.DEV, so it never ships in production builds.
import type {
  AccountDTO, CalendarDTO, CalEventDTO, ClaudeDTO, ConnectionsDTO, DatabasesDTO, DomainsDTO, HistoryDTO, MailDTO, MeDTO, OverviewDTO,
  PasskeyDTO, ProjectDTO, ProjectLinkDTO, Provider, RevenueDTO, SearchItem, SeriesDTO, SessionDTO, Settings, SitesDTO, StoresDTO, TaskDTO, UnsortedDTO,
} from '@shared/types.ts';
import { PROVIDERS } from '@shared/types.ts';

const now = Date.now();
const MIN = 60_000, H = 3_600_000, D = 86_400_000;
const iso = (t: number) => new Date(t).toISOString();
/** daysAgo at local HH:MM */
const at = (daysAgo: number, hm: string) => { const d = new Date(now - daysAgo * D); const [h, m] = hm.split(':').map(Number); d.setHours(h, m, 0, 0); return d.toISOString(); };
const rel = (s: string) => { const m = /^(\d+)([mhd])$/.exec(s); if (!m) return iso(now); return iso(now - +m[1] * (m[2] === 'm' ? MIN : m[2] === 'h' ? H : D)); };
const DAYS = ['Oct 31', 'Nov 1', 'Nov 2', 'Nov 3', 'Nov 4', 'Nov 5', 'Nov 6'];
let seq = 100;
const nid = (p: string) => `${p}${++seq}`;

/* ---------- accounts ---------- */
const acct = (id: string, provider: Provider, label: string, extra: Partial<AccountDTO> = {}): AccountDTO => ({
  id, provider, label, status: 'ok', lastSyncAt: iso(now - 3 * MIN), lastSyncMs: 1840, lastError: null, nextSyncAt: iso(now + 2 * MIN), meta: {}, createdAt: iso(now - 20 * D), ...extra,
});
const ACCOUNTS: AccountDTO[] = [
  acct('cf-work', 'cloudflare', 'Studio'), acct('cf-personal', 'cloudflare', 'Personal'),
  acct('nl-work', 'netlify', 'Studio'), acct('nl-personal', 'netlify', 'Personal'),
  acct('sb-atlas', 'supabase', 'atlas'), acct('sb-nimbus', 'supabase', 'nimbus'), acct('sb-relay', 'supabase', 'relay'), acct('sb-family', 'supabase', 'family'), acct('sb-labs', 'supabase', 'labs'),
  acct('st-work', 'stripe', 'Studio'), acct('pp-work', 'paypal', 'Studio'),
  acct('g-1', 'google', 'sam@gmail.com', { meta: { email: 'sam@gmail.com' } }), acct('g-2', 'google', 'sam@studio.example', { meta: { email: 'sam@studio.example' } }), acct('g-3', 'google', 'sam@reception.example', { meta: { email: 'sam@reception.example' } }),
  acct('gh-1', 'github', 'sam-example'), acct('as-1', 'appstore', 'Studio'), acct('gp-1', 'googleplay', 'Studio'), acct('an-1', 'anthropic', 'API org: Studio'),
];
const A = (id: string) => ACCOUNTS.find((a) => a.id === id)!;
const alabel = (id: string) => `${PROVIDERS[A(id).provider].name} · ${A(id).label}`;

/* ---------- settings / me ---------- */
const settings: Settings = {
  name: 'Sam Example', emails: ['sam@gmail.com', 'sam@studio.example'], tz: 'America/Los_Angeles', startPage: 'overview', sessionDays: 30, syncMinutes: 5, mailLookbackDays: 14,
  pullSessions: true, theme: 'dark', density: 'comfortable', quietStart: '22:00', quietEnd: '08:00',
  notifications: { failedDeploys: true, domainExpiry: true, appReview: true, newRevenue: false, syncFailures: true }, alertTo: 'sam@gmail.com',
};

/* ---------- projects ---------- */
interface PSeed { id: string; n: string; c: string; stage: number; blurb: string; open: number; done: number; dom: string[]; acc: string[]; upd: string; t: string; links: Omit<ProjectLinkDTO, 'id'>[] }
const PS: PSeed[] = [
  { id: 'atlas', n: 'Atlas', c: '#B9A5FF', stage: 2, blurb: 'AI assistant. Lean beta: relay off, direct address, Stage chat.', open: 7, done: 31, dom: ['atlas.app'], acc: ['Cloudflare · Studio', 'Netlify · Studio', 'Supabase · atlas'], upd: 'Android lean-beta prompt ready to run', t: '12m',
    links: [{ kind: 'zone', accountId: 'cf-work', accountLabel: 'Cloudflare · Studio', ref: 'atlas.app', label: 'atlas.app' }, { kind: 'site', accountId: 'nl-work', accountLabel: 'Netlify · Studio', ref: 'atlas-site', label: 'atlas-site' }, { kind: 'supabase', accountId: 'sb-atlas', accountLabel: 'Supabase · atlas', ref: 'atlas-prod', label: 'atlas-prod' }] },
  { id: 'bnn', n: 'nimbus.app', c: '#F5C542', stage: 4, blurb: 'Self-hosted control room for servers, Macs and PCs.', open: 4, done: 58, dom: ['nimbus.app'], acc: ['Cloudflare · Studio', 'Stripe', 'Supabase · nimbus'], upd: 'iOS approved, owner announcement drafted', t: '2h',
    links: [{ kind: 'zone', accountId: 'cf-work', accountLabel: 'Cloudflare · Studio', ref: 'nimbus.app', label: 'nimbus.app' }, { kind: 'account', accountId: 'st-work', accountLabel: 'Stripe · Studio', ref: 'st-work', label: 'Stripe' }, { kind: 'supabase', accountId: 'sb-nimbus', accountLabel: 'Supabase · nimbus', ref: 'nimbus-accounts', label: 'nimbus-accounts' }] },
  { id: 'jf', n: 'Relay', c: '#42D9D0', stage: 3, blurb: 'Desktop app to move docs between your devices.', open: 3, done: 22, dom: ['relay.app'], acc: ['Netlify · personal', 'Supabase · relay'], upd: 'Search Console verified', t: '1d',
    links: [{ kind: 'site', accountId: 'nl-personal', accountLabel: 'Netlify · Personal', ref: 'relay-web', label: 'relay-web' }, { kind: 'supabase', accountId: 'sb-relay', accountLabel: 'Supabase · relay', ref: 'relay-sync', label: 'relay-sync' }] },
  { id: 'ss', n: 'Ledger', c: '#67D391', stage: 3, blurb: 'Local-only co-parent expense app.', open: 2, done: 19, dom: [], acc: ['App Store Connect', 'Google Play'], upd: 'iOS 1.0.0 (9) waiting for review', t: '5h',
    links: [{ kind: 'app', accountId: 'as-1', accountLabel: 'App Store Connect · Studio', ref: 'com.example.ledger', label: 'Ledger (iOS)' }, { kind: 'app', accountId: 'gp-1', accountLabel: 'Google Play · Studio', ref: 'com.example.ledger', label: 'Ledger (Android)' }] },
  { id: 'cf', n: 'Clipper', c: '#F08CC6', stage: 4, blurb: 'Local AI video clipper with Recorder.', open: 2, done: 27, dom: [], acc: ['GitHub'], upd: 'Recorder 0.6.2 shipped, notarized', t: '3d',
    links: [{ kind: 'repo', accountId: 'gh-1', accountLabel: 'GitHub · sam-example', ref: 'sam-example/clipper', label: 'sam-example/clipper' }] },
  { id: 'hq', n: 'HQ', c: '#AEB5FF', stage: 0, blurb: 'This dashboard.', open: 5, done: 0, dom: ['hq.example.com'], acc: ['Cloudflare · personal'], upd: 'Mockup in review', t: 'now',
    links: [{ kind: 'zone', accountId: 'cf-personal', accountLabel: 'Cloudflare · Personal', ref: 'hq.example.com', label: 'hq.example.com' }] },
  { id: 'work', n: 'Studio', c: '#E8AE48', stage: 4, blurb: 'Studio site and product line.', open: 1, done: 12, dom: ['studio.example'], acc: ['Netlify · Studio', 'Resend'], upd: 'No changes this week', t: '6d',
    links: [{ kind: 'site', accountId: 'nl-work', accountLabel: 'Netlify · Studio', ref: 'studio-site', label: 'studio-site' }] },
  { id: 'wing', n: 'Wingman', c: '#FF94A7', stage: 0, blurb: 'Companion that introduces you to people nearby.', open: 1, done: 0, dom: [], acc: [], upd: 'Idea noted', t: '4d', links: [] },
];
const P: ProjectDTO[] = PS.map((p, i) => ({
  id: p.id, name: p.n, color: p.c, stage: p.stage, blurb: p.blurb, sort: i, archived: false, open: p.open, done: p.done, domains: p.dom, accounts: p.acc,
  links: p.links.map((l) => ({ id: nid('lk'), ...l })), latest: { title: p.upd, at: rel(p.t) }, updatedAt: rel(p.t),
}));
const proj = (id: string) => P.find((p) => p.id === id);

/* ---------- tasks / history ---------- */
const TSEED: [string, string, number, string][] = [
  ['atlas', 'Run the Android lean-beta prompt on Windows', 0, 'Today'], ['atlas', 'Record Google verification demo video', 0, 'This week'], ['atlas', 'Write the iOS Stage prompt', 0, 'This week'],
  ['atlas', 'Pick the final logo', 0, 'Later'], ['bnn', 'Release the Stripe paywall', 0, 'Waiting on you'], ['bnn', 'Finish the iOS announcement graphic', 0, 'Today'],
  ['jf', 'Publish Relay 1.0', 0, 'This week'], ['ss', 'Bump Android versionCode to 2', 0, 'Next build'], ['hq', 'Approve the dashboard mockup', 0, 'Today'],
  ['atlas', 'Make 10 bold ghost animations', 1, 'Nov 6'], ['atlas', 'Park the relay and droplet', 1, 'Nov 6'], ['bnn', 'iOS App Store approval', 1, 'Nov 5'], ['ss', 'Resubmit iOS build 9', 1, 'Nov 6'], ['cf', 'Ship Recorder 0.6.2', 1, 'Nov 3'],
];
const TASKS: TaskDTO[] = TSEED.map((t, i) => { const p = proj(t[0])!; return { id: `t${i + 1}`, projectId: p.id, projectName: p.name, projectColor: p.color, title: t[1], done: !!t[2], dueLabel: t[3], source: 'manual', createdAt: iso(now - (i + 1) * H), doneAt: t[2] ? iso(now - D) : null }; });
const HSEED: [string, string, string][] = [
  ['atlas', 'Stage demo published with all 14 animations', at(0, '20:24')], ['atlas', 'Android prompt revised for Stage', at(0, '20:21')], ['atlas', 'PR 31 merged into atlas-app main', at(0, '18:10')],
  ['bnn', 'New paying account on Business plan', at(0, '16:02')], ['ss', 'iOS build 1.0.0 (9) submitted for review', at(0, '14:15')], ['atlas', 'Relay Worker deleted, snapshot kept', at(1, '11:00')],
  ['bnn', 'App Store approved nimbus iOS', at(2, '09:30')], ['jf', 'relay.app verified in Search Console', at(9, '15:00')],
];
const HIST: HistoryDTO[] = HSEED.map((h, i) => { const p = proj(h[0])!; return { id: `h${i + 1}`, projectId: p.id, projectName: p.name, projectColor: p.color, kind: 'update', title: h[1], detail: null, at: h[2], source: 'manual', machine: null, branch: null, folder: null }; });
const UNSORTED: UnsortedDTO[] = [
  { id: 'u1', folderKey: 'ghoststage', folderName: 'ghost-stage', machine: 'Mac mini', sessions: 3, lastSeen: iso(now - 40 * MIN), projectId: null },
  { id: 'u2', folderKey: 'scratch', folderName: 'scratch', machine: 'Windows PC', sessions: 1, lastSeen: iso(now - 2 * D), projectId: null },
];

/* ---------- series ---------- */
const series = (names: [string, string?], a: number[], b?: number[]): SeriesDTO => ({ labels: DAYS, series: [{ name: names[0], color: 1, data: a }, ...(b ? [{ name: names[1] ?? '', color: 2 as const, data: b }] : [])] });

/* ---------- views ---------- */
const DOMAINS: DomainsDTO = {
  stats: [{ label: 'Zones', value: '6', pct: 100, sub: '2 Cloudflare accounts' }, { label: 'Requests, 7 days', value: '2.6M', pct: 70, sub: '+12% week over week' }, { label: 'Threats blocked', value: '4,812', pct: 40, sub: 'Mostly bots on nimbus.app' }, { label: 'Tunnels', value: '3', unit: 'live', pct: 75, sub: 'atlas, atlas-ce, atlas-engine' }],
  domains: ([['nimbus.app', 'cf-work', 'Active', 14, 2_400_000, 'Mar 2027', 'bnn'], ['atlas.app', 'cf-work', 'Active', 9, 38_000, 'Jan 2027', 'atlas'], ['relay.app', 'cf-personal', 'Active', 6, 12_000, 'Oct 2027', 'jf'], ['studio.example', 'cf-work', 'Active', 11, 64_000, 'Aug 2027', 'work'], ['hq.example.com', 'cf-personal', 'Active', 3, 0, 'Feb 2027', 'hq'], ['reception.example', 'cf-work', 'Expiring', 4, 210, 'Dec 2026', null]] as [string, string, string, number, number, string, string | null][])
    .map((d) => ({ name: d[0], accountId: d[1], account: alabel(d[1]).replace('Studio', 'Studio').replace('Personal', 'personal'), status: d[2], dnsRecords: d[3], requests7d: d[4], renews: d[5], expiresAt: null, projectId: d[6] })),
  workers: [{ name: 'nimbus-relay', accountId: 'cf-work', account: 'Cloudflare · Studio', routes: '*.nimbus.app', requests24h: 184_000, status: 'Live' }, { name: 'nimbus-api', accountId: 'cf-work', account: 'Cloudflare · Studio', routes: 'api.nimbus.app', requests24h: 22_000, status: 'Live' }],
  tunnels: [{ name: 'atlas', account: 'Cloudflare · Studio', status: 'healthy' }, { name: 'atlas-ce', account: 'Cloudflare · Studio', status: 'healthy' }, { name: 'atlas-engine', account: 'Cloudflare · Studio', status: 'healthy' }],
};
const SITES: SitesDTO = {
  sites: ([['nimbus-site', 'nimbus.app', 'nl-work', 'Published', '6m ago', '42s', 'bnn'], ['atlas-site', 'atlas.app', 'nl-work', 'Published', '2h ago', '38s', 'atlas'], ['relay-web', 'relay.app', 'nl-personal', 'Published', '1d ago', '51s', 'jf'], ['studio-site', 'studio.example', 'nl-work', 'Failed', '3d ago', '12s', 'work'], ['hq-preview', 'hq.example.com', 'nl-personal', 'Building', 'now', '…', 'hq']] as [string, string, string, string, string, string, string][])
    .map((s) => ({ id: s[0], name: s[0], domain: s[1], accountId: s[2], account: alabel(s[2]).replace('Studio', 'Studio').replace('Personal', 'personal'), state: s[3], when: s[4], buildTime: s[5], url: `https://${s[1]}`, adminUrl: `https://app.netlify.com/sites/${s[0]}`, errorMessage: s[3] === 'Failed' ? 'Build script returned non-zero exit code: 2' : null, projectId: s[6] })),
  deploys: series(['Deploys', 'Failed'], [4, 6, 3, 8, 5, 9, 7], [0, 1, 0, 1, 0, 0, 0]),
  recent: [{ site: 'nimbus-site', state: 'ready', at: iso(now - 6 * MIN), branch: 'main', title: 'Owner announcement copy', accountId: 'nl-work' }, { site: 'studio-site', state: 'error', at: iso(now - 3 * D), branch: 'main', title: 'Bump deps', accountId: 'nl-work' }],
};
const DBS: DatabasesDTO = {
  stats: [{ label: 'Projects', value: '5', pct: 80, sub: '5 Supabase accounts' }, { label: 'Storage', value: '3.0', unit: ' GB', pct: 30, sub: 'Across all projects' }, { label: 'Auth users', value: '256', pct: 50, sub: 'Atlas has the most' }, { label: 'Advisor warnings', value: '2', pct: 20, sub: 'Both on ledger-db' }],
  projects: ([['atlas-prod', 'sb-atlas', 'Healthy', '2.1 GB', 184, 'us-west-1', 'atlas'], ['nimbus-accounts', 'sb-nimbus', 'Healthy', '640 MB', 29, 'us-east-1', 'bnn'], ['relay-sync', 'sb-relay', 'Healthy', '220 MB', 41, 'us-west-1', 'jf'], ['ledger-db', 'sb-family', 'Paused', '80 MB', 2, 'us-west-1', null], ['wingman-dev', 'sb-labs', 'Healthy', '12 MB', 0, 'us-west-1', 'wing']] as [string, string, string, string, number, string, string | null][])
    .map((d) => ({ ref: d[0], name: d[0], accountId: d[1], account: alabel(d[1]), status: d[2], dbSize: d[3], authUsers: d[4], region: d[5], advisors: d[0] === 'ledger-db' ? 2 : 0, projectId: d[6] })),
  advisors: [{ project: 'ledger-db', category: 'security', level: 'WARN', title: 'RLS disabled on table expenses' }, { project: 'ledger-db', category: 'performance', level: 'WARN', title: 'Unindexed foreign key on splits.expense_id' }],
};
const REVENUE: RevenueDTO = {
  stats: [{ label: 'Revenue, 30 days', value: '$1,420', pct: 62, sub: '+18% vs last month' }, { label: 'Subscriptions', value: '7', unit: 'active', pct: 35, sub: 'nimbus Pro and Business' }, { label: 'Next payout', value: '$612', pct: 50, sub: 'Stripe · Nov 10' }, { label: 'PayPal, 30 days', value: '$180', pct: 20, sub: '3 transactions' }],
  byDay: series(['Stripe ($)', 'PayPal ($)'], [120, 40, 210, 90, 260, 180, 320], [0, 60, 0, 0, 90, 0, 30]),
  subscriptions: [{ account: 'Stripe · Studio', customer: 'new-customer', product: 'nimbus Business', amount: '$49', interval: 'month', status: 'active' }, { account: 'Stripe · Studio', customer: 'dana@northwind.io', product: 'nimbus Pro', amount: '$12', interval: 'month', status: 'active' }, { account: 'Stripe · Studio', customer: 'ops@tinyfleet.dev', product: 'nimbus Pro', amount: '$120', interval: 'year', status: 'active' }],
  recent: [{ account: 'Stripe · Studio', accountId: 'st-work', amount: '$49', description: 'nimbus Business · new-customer', at: iso(now - 4 * H), status: 'succeeded', kind: 'stripe' }, { account: 'PayPal · Studio', accountId: 'pp-work', amount: '$30', description: 'Clipper Recorder license', at: iso(now - D), status: 'completed', kind: 'paypal' }, { account: 'Stripe · Studio', accountId: 'st-work', amount: '$12', description: 'nimbus Pro · dana@northwind.io', at: iso(now - 2 * D), status: 'succeeded', kind: 'stripe' }],
};
const STORES: StoresDTO = {
  apps: [{ app: 'nimbus', store: 'App Store', version: '1.0.0', status: 'Live', rating: '4.8', accountId: 'as-1', projectId: 'bnn' }, { app: 'nimbus', store: 'Google Play', version: '1.2.1', status: 'Live', rating: '4.6', accountId: 'gp-1', projectId: 'bnn' }, { app: 'Ledger', store: 'App Store', version: '1.0.0 (9)', status: 'Waiting', rating: '—', accountId: 'as-1', projectId: 'ss' }, { app: 'Ledger', store: 'Google Play', version: '1.0.0', status: 'Live', rating: '5.0', accountId: 'gp-1', projectId: 'ss' }, { app: 'Atlas', store: 'TestFlight', version: '0.5.0 (28)', status: 'In review', rating: '—', accountId: 'as-1', projectId: 'atlas' }],
  reviews: [{ app: 'nimbus', store: 'Google Play', author: 'Kai', stars: 5, text: 'Finally one place for all my boxes.', at: iso(now - 2 * D) }],
};
const CALS = [['Work', 'g-2', '#B9A5FF'], ['Family', 'g-1', '#67D391'], ['Studio', 'g-2', '#F5C542'], ['Personal', 'g-1', '#F08CC6'], ['Family', 'g-1', '#42D9D0']] as const;
const ev = (hm: string, title: string, cal: string, color: string, daysAhead = 0): CalEventDTO => { const c = CALS.find((x) => x[0] === cal)!; return { id: nid('ev'), accountId: c[1], account: A(c[1]).label, title, calendar: cal, color, startsAt: at(-daysAhead, hm), endsAt: null, allDay: false }; };
const TODAY = [ev('09:30', 'Standup with Alex', 'Work', '#B9A5FF'), ev('11:00', 'Pickup', 'Family', '#67D391'), ev('13:00', 'Atlas beta tester call', 'Studio', '#F5C542'), ev('16:30', 'Gym', 'Personal', '#F08CC6'), ev('19:00', 'Dinner, family', 'Family', '#42D9D0')];
const CALENDAR: CalendarDTO = {
  today: TODAY,
  week: [...TODAY, ev('10:00', 'Relay 1.0 release review', 'Work', '#B9A5FF', 1), ev('15:00', 'Dentist', 'Personal', '#F08CC6', 2), ev('09:00', 'Soccer', 'Family', '#67D391', 3)],
  calendars: CALS.map((c) => ({ id: c[0].toLowerCase().replace(/\s/g, '-'), name: c[0], account: A(c[1]).label, color: c[2] })),
};
const MAIL: MailDTO = {
  items: ([['G', 'Apple', 'App Store review update for Ledger', 'g-2', at(0, '14:40'), '#42D9D0'], ['B', 'nimbus.app', 'New owner signed up: new-customer', 'g-2', at(0, '13:12'), '#F5C542'], ['G', 'Google Cloud', 'OAuth verification: next step', 'g-1', at(0, '11:05'), '#B9A5FF'], ['S', 'Stripe', 'Payout on the way', 'g-2', at(0, '09:30'), '#AEB5FF'], ['N', 'Netlify', 'Deploy failed: studio-site', 'g-2', at(3, '08:12'), '#FF94A7']] as [string, string, string, string, string, string][])
    .map((m, i) => ({ id: `m${i}`, accountId: m[3], account: A(m[3]).label, from: m[1], fromEmail: `${m[1].toLowerCase().replace(/\W/g, '')}@example.com`, subject: m[2], snippet: '', at: m[4], important: true, unread: true, color: m[5], initial: m[0] })),
  accounts: [{ id: 'g-1', email: 'sam@gmail.com' }, { id: 'g-2', email: 'sam@studio.example' }, { id: 'g-3', email: 'sam@reception.example' }],
};
const D14 = Array.from({ length: 14 }, (_, i) => new Date(now - (13 - i) * D).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
const CLAUDE: ClaudeDTO = {
  api: {
    connected: true,
    stats: [{ label: 'API spend, this month', value: '$84', unit: '/ $150', pct: 56, sub: 'Studio org' }, { label: 'Tokens', value: '41.2M', pct: 60, sub: 'Input 36.8M · output 4.4M' }, { label: 'Cache hit rate', value: '71%', pct: 71, sub: 'Saved about $38' }, { label: 'Top workspace', value: 'Atlas', pct: 45, sub: '$38 of $84' }],
    byDay: series(['API ($)'], [9, 11, 8, 14, 12, 16, 14]),
    workspaces: [{ org: 'Studio', workspace: 'Atlas', models: 'Fable 5.1, Sonnet 5.5', spend: '$38.10', input: 16_400_000, output: 1_840_000 }, { org: 'Studio', workspace: 'nimbus', models: 'Haiku 5.5', spend: '$21.40', input: 12_900_000, output: 1_200_000 }, { org: 'Studio', workspace: 'Clipper', models: 'Sonnet 5.5', spend: '$16.20', input: 5_100_000, output: 900_000 }, { org: 'Studio', workspace: 'Labs', models: 'Opus 5.5', spend: '$8.30', input: 2_400_000, output: 460_000 }],
  },
  subscription: {
    connected: true,
    machines: [{ machine: 'Mac mini', lastSeen: iso(now - 12 * MIN), agentVersion: '0.3.1' }, { machine: 'Windows PC', lastSeen: iso(now - 3 * H), agentVersion: '0.3.1' }],
    stats: [{ label: 'Tokens, 14 days', value: '312M', pct: 78, sub: 'Input 58M · output 9.2M' }, { label: 'Cache read', value: '245M', pct: 79, sub: '79% of all input' }, { label: 'Messages', value: '4,120', pct: 55, sub: 'Across 6 folders' }, { label: 'Top project', value: 'Atlas', pct: 62, sub: '62% of tokens' }],
    byDay: { labels: D14, series: [{ name: 'Tokens in+out (M)', color: 1, data: [12, 18, 9, 22, 25, 14, 8, 19, 27, 31, 24, 29, 35, 40] }, { name: 'Cache read (M)', color: 2, data: [9, 14, 7, 18, 20, 11, 6, 15, 22, 26, 19, 24, 29, 33] }] },
    byProject: [{ project: 'Atlas', projectId: 'atlas', folder: 'atlas-app', input: 36_000_000, output: 5_700_000, cacheRead: 152_000_000, cacheWrite: 9_000_000, messages: 2_410 }, { project: 'nimbus.app', projectId: 'bnn', folder: 'nimbus', input: 12_000_000, output: 2_100_000, cacheRead: 61_000_000, cacheWrite: 3_000_000, messages: 980 }, { project: 'HQ', projectId: 'hq', folder: 'SamHQ', input: 6_000_000, output: 900_000, cacheRead: 22_000_000, cacheWrite: 1_200_000, messages: 410 }, { project: 'ghost-stage', projectId: null, folder: 'ghost-stage', input: 4_000_000, output: 500_000, cacheRead: 10_000_000, cacheWrite: 600_000, messages: 320 }],
    byModel: [{ model: 'claude-fable-5-1', input: 44_000_000, output: 7_200_000, cacheRead: 190_000_000, cacheWrite: 11_000_000, messages: 3_100 }, { model: 'claude-sonnet-5-5', input: 12_000_000, output: 1_800_000, cacheRead: 50_000_000, cacheWrite: 2_600_000, messages: 900 }, { model: 'claude-haiku-5-5', input: 2_000_000, output: 200_000, cacheRead: 5_000_000, cacheWrite: 200_000, messages: 120 }],
    byMachine: [{ machine: 'Mac mini', input: 40_000_000, output: 6_400_000, cacheRead: 170_000_000, cacheWrite: 9_800_000, messages: 2_900 }, { machine: 'Windows PC', input: 18_000_000, output: 2_800_000, cacheRead: 75_000_000, cacheWrite: 4_000_000, messages: 1_220 }],
    range: { from: D14[0], to: D14[13] },
  },
};
const PASSKEYS: PasskeyDTO[] = [{ id: 'pk1', label: 'iPhone', createdAt: iso(now - D), lastUsedAt: iso(now - 2 * H), deviceType: 'multiDevice', backedUp: true }, { id: 'pk2', label: 'Mac mini', createdAt: iso(now - D), lastUsedAt: iso(now - 10 * MIN), deviceType: 'multiDevice', backedUp: true }];
const SESSIONS: SessionDTO[] = [{ id: 's1', current: true, method: 'passkey', createdAt: iso(now - 2 * H), lastSeenAt: iso(now), expiresAt: iso(now + 30 * D), deviceLabel: 'Mac mini' }, { id: 's2', current: false, method: 'google', createdAt: iso(now - 3 * D), lastSeenAt: iso(now - D), expiresAt: iso(now + 27 * D), deviceLabel: 'iPhone' }];

function me(): MeDTO {
  return {
    branding: { appName: 'HQ', host: 'hq.example.com', origin: 'https://hq.example.com', ownerName: 'Sam Example', contact: 'sam@example.com' },
    user: { id: 'u1', name: settings.name, initials: settings.name.split(' ').map((x) => x[0]).join('').slice(0, 2).toUpperCase() },
    settings, accounts: ACCOUNTS,
    counts: { projects: P.length, openTasks: TASKS.filter((t) => !t.done).length, mail: 5, unsorted: UNSORTED.filter((u) => !u.projectId).length },
    sync: { allOk: true, accounts: 14, providers: 9, oldestSyncAt: iso(now - 3 * MIN), failing: 0 },
    session: { id: 's1', method: 'passkey', createdAt: iso(now - 2 * H), expiresAt: iso(now + 30 * D) },
  };
}
function overview(): OverviewDTO {
  return {
    greetingName: 'Sam',
    summary: '8 projects, 9 open tasks, and 1 failed deploy across 14 accounts. Atlas is the one moving fastest this week.',
    notes: ['Netlify: studio-site failed to deploy 3 days ago. reception.example expires in 25 days.'],
    stats: [{ label: 'Active projects', value: '6', unit: 'of 8', pct: 75, sub: '2 live, 2 in review, 1 in beta' }, { label: 'Open tasks', value: String(TASKS.filter((t) => !t.done).length), pct: 36, sub: '5 due this week' }, { label: 'Revenue, 30 days', value: '$1,420', pct: 62, sub: 'Stripe and PayPal, both accounts' }, { label: 'Claude API spend', value: '$84', unit: '/ $150', pct: 56, sub: 'This month, Studio org' }],
    traffic: series(['Requests (K)', 'Visitors (K)'], [310, 342, 298, 380, 412, 468, 455], [88, 96, 90, 112, 121, 140, 134]),
    health: [{ label: 'Cloudflare zones', value: '6 of 6 active', tone: 'good' }, { label: 'Netlify sites', value: '4 of 5 published', tone: 'warn' }, { label: 'Supabase projects', value: '4 healthy, 1 paused', tone: 'good' }, { label: 'App reviews', value: '1 waiting', tone: 'warn' }, { label: 'Inbox', value: '5 unread that matter', tone: 'dim' }],
    projects: P, today: TODAY, openTasks: TASKS.filter((t) => !t.done), history: HIST,
  };
}
function connections(): ConnectionsDTO {
  const claudeCode = { machines: [{ machine: 'Mac mini', lastSeen: new Date(Date.now() - 4 * 60000).toISOString(), agentVersion: '1.0.0', filesTracked: 31 }], sessionsToday: 3 };
  return { claudeCode, providers: (Object.keys(PROVIDERS) as Provider[]).map((p) => ({ provider: p, name: PROVIDERS[p].name, icon: PROVIDERS[p].icon, blurb: PROVIDERS[p].blurb, accounts: ACCOUNTS.filter((a) => a.provider === p) })) };
}
function search(): SearchItem[] {
  return [
    ...P.map((p) => ({ t: p.name, k: 'Project' as const, h: '#p-' + p.id, i: '▦' })),
    ...DOMAINS.domains.map((d) => ({ t: d.name, k: 'Domain' as const, h: '#domains', i: '◎' })),
    ...SITES.sites.map((s) => ({ t: s.name, k: 'Site' as const, h: '#sites', i: '◆' })),
    ...DBS.projects.map((d) => ({ t: d.name, k: 'Database' as const, h: '#databases', i: '▤' })),
    ...TASKS.map((t) => ({ t: t.title, k: 'Task' as const, h: '#tasks', i: '✓', sub: t.projectName })),
    ...MAIL.items.map((m) => ({ t: m.subject, k: 'Mail' as const, h: '#mail', i: '✉', sub: m.from })),
  ];
}
function linkables() {
  return [
    ...DOMAINS.domains.map((d) => ({ kind: 'zone', accountId: d.accountId, accountLabel: alabel(d.accountId), ref: d.name, label: d.name })),
    ...SITES.sites.map((s) => ({ kind: 'site', accountId: s.accountId, accountLabel: alabel(s.accountId), ref: s.id, label: s.name })),
    ...DBS.projects.map((d) => ({ kind: 'supabase', accountId: d.accountId, accountLabel: alabel(d.accountId), ref: d.ref, label: d.name })),
    ...STORES.apps.map((a) => ({ kind: 'app', accountId: a.accountId, accountLabel: alabel(a.accountId), ref: `${a.store}:${a.app}`, label: `${a.app} (${a.store})` })),
    { kind: 'repo', accountId: 'gh-1', accountLabel: alabel('gh-1'), ref: 'sam-example/clipper', label: 'sam-example/clipper' },
    { kind: 'repo', accountId: 'gh-1', accountLabel: alabel('gh-1'), ref: 'sam-example/hq', label: 'sam-example/hq' },
    ...DOMAINS.workers.map((w) => ({ kind: 'worker', accountId: w.accountId, accountLabel: alabel(w.accountId), ref: w.name, label: w.name })),
    ...ACCOUNTS.map((a) => ({ kind: 'account', accountId: a.id, accountLabel: alabel(a.id), ref: a.id, label: alabel(a.id) })),
  ];
}

const delay = () => new Promise((r) => setTimeout(r, 120 + Math.random() * 180));
const notFound = (p: string) => { const e = new Error(`not found: ${p}`) as Error & { status: number }; e.status = 404; throw e; };

export async function mockRequest(method: string, path: string, body?: unknown): Promise<unknown> {
  await delay();
  const [p, qs] = path.split('?');
  const q = new URLSearchParams(qs ?? '');
  const B = (body ?? {}) as Record<string, unknown>;
  let m: RegExpExecArray | null;

  if (p === '/api/auth/status') return { signedIn: true, hasPasskeys: true, allowedEmails: settings.emails };
  if (p === '/api/auth/passkeys' && method === 'GET') return PASSKEYS;
  if ((m = /^\/api\/auth\/passkeys\/(.+)$/.exec(p))) { const i = PASSKEYS.findIndex((k) => k.id === m![1]); if (method === 'DELETE') { if (i >= 0) PASSKEYS.splice(i, 1); return { ok: true }; } if (i >= 0) PASSKEYS[i].label = String(B.label); return PASSKEYS[i]; }
  if (p === '/api/auth/passkey/register/options' || p === '/api/auth/passkey/login/options') return { challengeId: 'c1', options: { challenge: 'bW9ja2NoYWxsZW5nZQ', rp: { name: 'HQ', id: location.hostname }, user: { id: 'dTE', name: 'roman', displayName: 'Sam' }, pubKeyCredParams: [{ alg: -7, type: 'public-key' }], timeout: 60000, rpId: location.hostname } };
  if (p === '/api/auth/passkey/register/verify') { const k: PasskeyDTO = { id: nid('pk'), label: String(B.label ?? 'This device'), createdAt: iso(now), lastUsedAt: null, deviceType: 'multiDevice', backedUp: true }; PASSKEYS.push(k); return k; }
  if (p === '/api/auth/passkey/login/verify') return { ok: true };
  if (p === '/api/auth/sessions') return SESSIONS;
  if (p === '/api/auth/signout') return { ok: true };
  if (p === '/api/auth/signout-others') { const n = SESSIONS.length - 1; SESSIONS.splice(1); return { ok: true, removed: n }; }

  if (p === '/api/me') return me();
  if (p === '/api/settings') { Object.assign(settings, B); return settings; }
  if (p === '/api/overview') return overview();
  if (p === '/api/domains') return DOMAINS;
  if (p === '/api/sites') return SITES;
  if (p === '/api/databases') return DBS;
  if (p === '/api/revenue') return REVENUE;
  if (p === '/api/stores') return STORES;
  if (p === '/api/calendar') return CALENDAR;
  if (p === '/api/mail') return MAIL;
  if (p === '/api/claude') return CLAUDE;
  if (p === '/api/connections') return connections();
  if (p === '/api/search') return search();
  if (p === '/api/linkables') return linkables();

  if (p === '/api/projects' && method === 'GET') return P;
  if (p === '/api/projects' && method === 'POST') {
    const np: ProjectDTO = { id: nid('p'), name: String(B.name), color: String(B.color ?? '#B9A5FF'), stage: Number(B.stage ?? 0), blurb: String(B.blurb ?? ''), sort: P.length, archived: false, open: 0, done: 0, domains: [], accounts: [], links: [], latest: null, updatedAt: iso(Date.now()) };
    P.push(np); return np;
  }
  if ((m = /^\/api\/projects\/([^/]+)\/links\/([^/]+)$/.exec(p)) && method === 'DELETE') { const pr = proj(m[1]); if (pr) pr.links = pr.links.filter((l) => l.id !== m![2]); return { ok: true }; }
  if ((m = /^\/api\/projects\/([^/]+)\/links$/.exec(p)) && method === 'POST') { const pr = proj(m[1]) ?? notFound(p); const l: ProjectLinkDTO = { id: nid('lk'), kind: String(B.kind), accountId: (B.accountId as string) ?? null, accountLabel: B.accountId ? alabel(String(B.accountId)) : null, ref: String(B.ref), label: String(B.label) }; pr.links.push(l); return l; }
  if ((m = /^\/api\/projects\/([^/]+)$/.exec(p))) {
    const pr = proj(m[1]); if (!pr) notFound(p);
    if (method === 'GET') return { project: pr, tasks: TASKS.filter((t) => t.projectId === pr!.id), history: HIST.filter((h) => h.projectId === pr!.id) };
    if (method === 'PATCH') { Object.assign(pr!, B); pr!.updatedAt = iso(Date.now()); TASKS.forEach((t) => { if (t.projectId === pr!.id) { t.projectName = pr!.name; t.projectColor = pr!.color; } }); return pr; }
    if (method === 'DELETE') { P.splice(P.indexOf(pr!), 1); return { ok: true }; }
  }
  if (p === '/api/tasks' && method === 'GET') { const s = q.get('state') ?? 'open'; return TASKS.filter((t) => s === 'all' || (s === 'done') === t.done).filter((t) => !q.get('projectId') || t.projectId === q.get('projectId')); }
  if (p === '/api/tasks' && method === 'POST') { const pr = proj(String(B.projectId)) ?? notFound(p); const t: TaskDTO = { id: nid('t'), projectId: pr.id, projectName: pr.name, projectColor: pr.color, title: String(B.title), done: false, dueLabel: (B.dueLabel as string) ?? null, source: 'manual', createdAt: iso(Date.now()), doneAt: null }; TASKS.unshift(t); pr.open++; return t; }
  if ((m = /^\/api\/tasks\/([^/]+)$/.exec(p))) {
    const t = TASKS.find((x) => x.id === m![1]) ?? notFound(p);
    if (method === 'DELETE') { TASKS.splice(TASKS.indexOf(t), 1); return { ok: true }; }
    if (typeof B.done === 'boolean' && B.done !== t.done) { const pr = proj(t.projectId); if (pr) { pr.open += B.done ? -1 : 1; pr.done += B.done ? 1 : -1; } t.done = B.done; t.doneAt = B.done ? iso(Date.now()) : null; }
    if (typeof B.title === 'string') t.title = B.title;
    if ('dueLabel' in B) t.dueLabel = (B.dueLabel as string) ?? null;
    return t;
  }
  if (p === '/api/history' && method === 'GET') { const pid = q.get('projectId'); return HIST.filter((h) => !pid || h.projectId === pid).slice(0, Number(q.get('limit') ?? 200)); }
  if (p === '/api/history' && method === 'POST') { const pr = proj(String(B.projectId)) ?? notFound(p); const h: HistoryDTO = { id: nid('h'), projectId: pr.id, projectName: pr.name, projectColor: pr.color, kind: 'update', title: String(B.title), detail: (B.detail as string) ?? null, at: iso(Date.now()), source: 'manual', machine: null, branch: null, folder: null }; HIST.unshift(h); pr.latest = { title: h.title, at: h.at }; pr.updatedAt = h.at; return h; }
  if (p === '/api/unsorted' && method === 'GET') return UNSORTED.filter((u) => !u.projectId);
  if ((m = /^\/api\/unsorted\/([^/]+)$/.exec(p))) { const u = UNSORTED.find((x) => x.id === m![1]) ?? notFound(p); u.projectId = String(B.projectId); return u; }

  if (p === '/api/accounts' && method === 'POST') { const a = acct(nid('a'), B.provider as Provider, String(B.label), { status: 'pending', lastSyncAt: null, meta: (B.meta as AccountDTO['meta']) ?? {} }); ACCOUNTS.push(a); return a; }
  if ((m = /^\/api\/accounts\/([^/]+)\/sync$/.exec(p))) return { ok: true };
  if ((m = /^\/api\/accounts\/([^/]+)\/runs$/.exec(p))) return [{ startedAt: iso(now - 3 * MIN), ok: true, error: null, durationMs: 1840 }];
  if ((m = /^\/api\/accounts\/([^/]+)$/.exec(p))) { const i = ACCOUNTS.findIndex((a) => a.id === m![1]); if (i < 0) notFound(p); if (method === 'DELETE') { ACCOUNTS.splice(i, 1); return { ok: true }; } if (typeof B.label === 'string') ACCOUNTS[i].label = B.label; return ACCOUNTS[i]; }
  if (p === '/api/sync') return { ok: true };
  if (p === '/api/data/clear-cache') return { ok: true };
  if (p === '/api/data/delete') return { ok: true };
  return notFound(path);
}
