// Shared contract between the sync Edge Function (writes snapshots/metrics),
// the Worker API (aggregates them into view DTOs) and the web app (renders DTOs).
// Pure types only: this file must stay importable from Deno, Workers and the browser.

export type Provider =
  | 'cloudflare' | 'netlify' | 'supabase' | 'stripe' | 'paypal'
  | 'google' | 'github' | 'appstore' | 'googleplay' | 'anthropic';

export const PROVIDERS: Record<Provider, { name: string; icon: string; blurb: string; multi: boolean }> = {
  cloudflare: { name: 'Cloudflare', icon: '☁', blurb: 'DNS, Workers, tunnels, traffic', multi: true },
  netlify: { name: 'Netlify', icon: '◆', blurb: 'Sites and deploys', multi: true },
  supabase: { name: 'Supabase', icon: '▲', blurb: 'Projects, health, usage', multi: true },
  stripe: { name: 'Stripe', icon: '$', blurb: 'Revenue, payouts, subscriptions', multi: true },
  paypal: { name: 'PayPal', icon: 'P', blurb: 'Transactions, balances', multi: true },
  google: { name: 'Google', icon: 'G', blurb: 'Mail and calendars', multi: true },
  github: { name: 'GitHub', icon: '⌥', blurb: 'Repos, PRs, Actions', multi: true },
  appstore: { name: 'App Store Connect', icon: '', blurb: 'Builds, review status, ratings', multi: true },
  googleplay: { name: 'Google Play', icon: '▶', blurb: 'Ratings, reviews, crashes', multi: true },
  anthropic: { name: 'Claude API', icon: '✦', blurb: 'API usage and cost (admin key, optional)', multi: true },
};

export const STAGES = ['Idea', 'Building', 'Beta', 'Review', 'Live'] as const;
export type AccountStatus = 'pending' | 'ok' | 'error' | 'expired';

// ---------- secrets stored encrypted per account (never leave the server) ----------
export type AccountSecrets =
  | { provider: 'cloudflare'; apiToken: string }
  | { provider: 'netlify'; accessToken: string }
  | { provider: 'supabase'; accessToken: string }
  | { provider: 'stripe'; restrictedKey: string }
  | { provider: 'paypal'; clientId: string; clientSecret: string }
  | { provider: 'google'; refreshToken: string; accessToken?: string; accessTokenExpiresAt?: string }
  | { provider: 'github'; token: string }
  | { provider: 'appstore'; issuerId: string; keyId: string; privateKeyP8: string }
  | { provider: 'googleplay'; serviceAccountJson: string }
  | { provider: 'anthropic'; adminKey: string };

// Non-secret config per account, stored in accounts.meta
export interface AccountMeta {
  email?: string;              // google
  accountIds?: string[];       // cloudflare: restrict to these account ids (optional)
  accountNames?: Record<string, string>; // cloudflare account id -> name
  teamSlugs?: string[];        // netlify (optional restriction)
  orgSlug?: string;            // supabase / anthropic
  reportsBucket?: string;      // googleplay: pubsite_prod_rev_...
  packageNames?: string[];     // googleplay
  scopes?: string[];           // google granted scopes
  calendarIds?: string[];      // google: which calendars (default all)
}

// ---------- snapshot payloads written by sync (snapshots.kind -> type) ----------
export interface CfZone {
  id: string; name: string; status: string; paused: boolean; plan: string;
  accountId: string; accountName: string;
  dnsRecords: number; requests7d: number; visitors7d: number; threats7d: number; bytes7d: number;
  // from Cloudflare Registrar when the domain is registered there
  expiresAt: string | null; autoRenew: boolean | null; registrar: boolean;
}
export interface CfWorker { name: string; accountId: string; accountName: string; routes: string[]; requests24h: number; errors24h: number; modifiedOn: string | null }
export interface CfTunnel { id: string; name: string; accountId: string; accountName: string; status: string; connections: number; createdAt: string | null }
export interface TrafficDay { requests: number; visitors: number; threats: number; bytes: number }

export interface NlDeploy {
  id: string; siteId: string; siteName: string; state: string; // ready | error | building | enqueued | new | processing | failed
  createdAt: string; publishedAt: string | null; deployTimeSec: number | null; branch: string | null; title: string | null; errorMessage: string | null; context: string | null; url: string | null;
}
export interface NlSite {
  id: string; name: string; url: string; customDomain: string | null; accountSlug: string; accountName: string;
  repoUrl: string | null; lastDeploy: NlDeploy | null; adminUrl: string;
}
export interface DeployDay { deploys: number; failed: number }

export interface SbProject {
  ref: string; name: string; region: string; status: string; orgSlug: string; orgName: string; createdAt: string;
  dbSizeBytes: number | null; storageBytes: number | null; authUsers: number | null;
  advisors: { security: number; performance: number; items: { category: string; level: string; title: string }[] };
}

export interface MoneyTxn { id: string; amount: number; currency: string; type: string; description: string; createdAt: string; status: string }
export interface StripeSummary {
  accountName: string; currency: string; revenue30d: number; revenuePrev30d: number; // minor units
  activeSubscriptions: number; mrr: number; balanceAvailable: number; balancePending: number;
  nextPayout: { amount: number; arrivalDate: string; status: string } | null;
  subscriptions: { id: string; customer: string; product: string; amount: number; interval: string; status: string }[];
  recent: MoneyTxn[];
}
export interface PaypalSummary { accountName: string; currency: string; revenue30d: number; txnCount30d: number; balance: number; recent: MoneyTxn[] }
export interface RevenueDay { amount: number; count: number }

export interface GhRepo { fullName: string; name: string; private: boolean; defaultBranch: string; pushedAt: string; openIssues: number; openPRs: number; stars: number; language: string | null; url: string }
export interface GhPull { repo: string; number: number; title: string; author: string; createdAt: string; updatedAt: string; draft: boolean; url: string; headBranch: string }
export interface GhRun { repo: string; id: number; name: string; status: string; conclusion: string | null; branch: string | null; createdAt: string; updatedAt: string; url: string; event: string }
export interface ActionsDay { runs: number; failed: number }

export interface AsApp {
  id: string; name: string; bundleId: string; sku: string | null; platforms: string[];
  liveVersion: string | null; liveState: string | null; pendingVersion: string | null; pendingState: string | null;
  rating: number | null; ratingCount: number | null;
  latestBuild: { version: string; build: string; uploadedAt: string; processingState: string } | null;
  testflight: { version: string; build: string; state: string } | null;
}
export interface GpApp {
  packageName: string; name: string | null; rating: number | null; ratingCount: number | null;
  crashes7d: number | null; anrs7d: number | null; installs: number | null;
  reviews: { author: string; stars: number; text: string; at: string }[];
}

export interface AnthropicSummary {
  orgName: string; monthCostCents: number; monthTokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  workspaces: { id: string | null; name: string; costCents: number; models: string[]; input: number; output: number }[];
  models: { model: string; costCents: number; input: number; output: number; cacheRead: number; cacheWrite: number }[];
}
export interface SpendDay { costCents: number; input: number; output: number; cacheRead: number; cacheWrite: number }

export interface GoogleSummary { email: string; unreadImportant: number; calendars: { id: string; name: string; color: string | null; primary: boolean }[]; lastMailSyncAt: string }

// ---------- API DTOs (Worker -> web) ----------
export interface AccountDTO {
  id: string; provider: Provider; label: string; status: AccountStatus;
  lastSyncAt: string | null; lastSyncMs: number | null; lastError: string | null; nextSyncAt: string | null;
  meta: AccountMeta; createdAt: string;
}
export interface Settings {
  name: string; emails: string[]; tz: string; startPage: string; sessionDays: number; syncMinutes: number; mailLookbackDays: number;
  pullSessions: boolean; theme: 'dark' | 'light'; density: 'comfortable' | 'compact'; quietStart: string; quietEnd: string;
  notifications: Record<string, boolean>; alertTo: string;
}
export interface MeDTO {
  user: { id: string; name: string; initials: string };
  branding: { appName: string; host: string; origin: string; ownerName: string; contact: string };
  settings: Settings;
  accounts: AccountDTO[];
  counts: { projects: number; openTasks: number; mail: number; unsorted: number };
  sync: { allOk: boolean; accounts: number; providers: number; oldestSyncAt: string | null; failing: number };
  session: { id: string; method: string; createdAt: string; expiresAt: string };
}

export interface ProjectDTO {
  id: string; name: string; color: string; stage: number; blurb: string; sort: number; archived: boolean;
  open: number; done: number;
  domains: string[]; accounts: string[]; // account labels like "Cloudflare · Work"
  links: ProjectLinkDTO[];
  latest: { title: string; at: string } | null;
  updatedAt: string;
}
export interface ProjectLinkDTO { id: string; kind: string; accountId: string | null; accountLabel: string | null; ref: string; label: string }
export interface TaskDTO {
  id: string; projectId: string; projectName: string; projectColor: string; title: string; done: boolean;
  dueLabel: string | null; source: string; createdAt: string; doneAt: string | null;
}
export interface HistoryDTO {
  id: string; projectId: string | null; projectName: string | null; projectColor: string | null;
  kind: string; title: string; detail: string | null; at: string; source: string | null; machine: string | null; branch: string | null; folder: string | null;
}
export interface UnsortedDTO { id: string; folderKey: string; folderName: string; machine: string | null; sessions: number; lastSeen: string; projectId: string | null }

export interface StatDTO { label: string; value: string; unit?: string; pct: number; sub: string }
export interface SeriesDTO { labels: string[]; series: { name: string; color: 1 | 2; data: number[] }[] }
export interface HealthRow { label: string; value: string; tone: 'good' | 'warn' | 'bad' | 'dim' }

export interface OverviewDTO {
  greetingName: string;
  summary: string;              // "8 projects, 9 open tasks, and 1 failed deploy across 14 accounts. X is the one moving fastest this week."
  notes: string[];              // warnings line(s) for the ⚑ note; empty = no note
  stats: [StatDTO, StatDTO, StatDTO, StatDTO];
  traffic: SeriesDTO;
  health: HealthRow[];
  projects: ProjectDTO[];
  today: CalEventDTO[];
  openTasks: TaskDTO[];
  history: HistoryDTO[];
}

export interface DomainRow { name: string; accountId: string; account: string; status: string; dnsRecords: number; requests7d: number; renews: string | null; expiresAt: string | null; projectId: string | null }
export interface WorkerRow { name: string; accountId: string; account: string; routes: string; requests24h: number; status: string }
export interface DomainsDTO { stats: StatDTO[]; domains: DomainRow[]; workers: WorkerRow[]; tunnels: { name: string; account: string; status: string }[] }

export interface SiteRow { id: string; name: string; domain: string; accountId: string; account: string; state: string; when: string | null; buildTime: string | null; url: string; adminUrl: string; errorMessage: string | null; projectId: string | null }
export interface SitesDTO { sites: SiteRow[]; deploys: SeriesDTO; recent: { site: string; state: string; at: string; branch: string | null; title: string | null; accountId: string }[] }

export interface DbRow { ref: string; name: string; accountId: string; account: string; status: string; dbSize: string; authUsers: number | null; region: string; advisors: number; projectId: string | null }
export interface DatabasesDTO { stats: StatDTO[]; projects: DbRow[]; advisors: { project: string; category: string; level: string; title: string }[] }

export interface RevenueDTO { stats: StatDTO[]; byDay: SeriesDTO; subscriptions: { account: string; customer: string; product: string; amount: string; interval: string; status: string }[]; recent: { account: string; accountId: string; amount: string; description: string; at: string; status: string; kind: 'stripe' | 'paypal' }[] }

export interface StoreRow { app: string; store: 'App Store' | 'Google Play' | 'TestFlight'; version: string; status: string; rating: string; accountId: string; projectId: string | null }
export interface StoresDTO { apps: StoreRow[]; reviews: { app: string; store: string; author: string; stars: number; text: string; at: string }[] }

export interface CalEventDTO { id: string; accountId: string; account: string; title: string; calendar: string; color: string; startsAt: string; endsAt: string | null; allDay: boolean }
export interface CalendarDTO { today: CalEventDTO[]; week: CalEventDTO[]; calendars: { id: string; name: string; account: string; color: string }[] }

export interface MailDTO { items: { id: string; accountId: string; account: string; from: string; fromEmail: string; subject: string; snippet: string; at: string; important: boolean; unread: boolean; color: string; initial: string }[]; accounts: { id: string; email: string }[] }

export interface ClaudeDTO {
  api: {
    connected: boolean;
    stats: StatDTO[];
    byDay: SeriesDTO;
    workspaces: { org: string; workspace: string; models: string; spend: string; input: number; output: number }[];
  };
  subscription: {
    connected: boolean;            // at least one agent heartbeat
    machines: { machine: string; lastSeen: string; agentVersion: string | null }[];
    stats: StatDTO[];
    byDay: SeriesDTO;              // tokens per day (input+output) and cache read, 14 days
    byProject: { project: string; projectId: string | null; folder: string; input: number; output: number; cacheRead: number; cacheWrite: number; messages: number }[];
    byModel: { model: string; input: number; output: number; cacheRead: number; cacheWrite: number; messages: number }[];
    byMachine: { machine: string; input: number; output: number; cacheRead: number; cacheWrite: number; messages: number }[];
    range: { from: string; to: string };
  };
}

export interface ConnectionsDTO {
  providers: { provider: Provider; name: string; icon: string; blurb: string; accounts: AccountDTO[] }[];
  // Claude Code subscription usage: machines running the local agent (not a provider token)
  claudeCode: { machines: { machine: string; lastSeen: string; agentVersion: string | null; filesTracked: number | null }[]; sessionsToday: number };
}

export interface SearchItem { t: string; k: 'Page' | 'Project' | 'Domain' | 'Site' | 'Database' | 'Task' | 'Mail' | 'Repo' | 'App'; h: string; i: string; sub?: string }

export interface PasskeyDTO { id: string; label: string; createdAt: string; lastUsedAt: string | null; deviceType: string | null; backedUp: boolean }
export interface SessionDTO { id: string; current: boolean; method: string; createdAt: string; lastSeenAt: string; expiresAt: string; deviceLabel: string | null }

// ---------- ingest payloads (hook + usage agent -> Worker) ----------
export interface SessionIngest {
  type: 'session';
  machine: string;
  folder: string;              // folder name only, e.g. "ClipForge"
  cwd?: string;
  branch?: string | null;
  sessionId: string;
  endedAt: string;             // ISO
  summary: string;             // one line
  done: string[];
  open: string[];
  source?: string;             // 'hq-block' | 'last-message'
}
export interface UsageIngest {
  type: 'usage';
  machine: string;
  agentVersion: string;
  filesTracked: number;
  rows: { day: string; folder: string; model: string; input: number; output: number; cacheRead: number; cacheWrite: number; messages: number; sessions: number }[];
  // rows are absolute totals for (day, folder, model) on this machine; the server upserts them
}
