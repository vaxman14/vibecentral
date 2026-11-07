// Shared plumbing for provider sync modules. Runtime-neutral: no Deno/npm imports here so the
// root tsconfig (Worker + web) can still type-check this folder.
import type { AccountMeta, AccountSecrets, Provider } from '../types.ts';
import { PROVIDERS } from '../types.ts';

// ---------- errors ----------
export class SyncError extends Error {
  status: number | null;
  /** true when the provider rejected our credentials (401/403/invalid_grant): account becomes 'expired' */
  expired: boolean;
  constructor(message: string, opts: { status?: number | null; expired?: boolean } = {}) {
    super(message);
    this.name = 'SyncError';
    this.status = opts.status ?? null;
    this.expired = opts.expired ?? false;
  }
}

export function isAbortError(e: unknown): boolean {
  return !!e && typeof e === 'object' && (e as { name?: string }).name === 'AbortError';
}
export function isExpired(e: unknown): boolean {
  return e instanceof SyncError && e.expired;
}
/** Short human text for the UI (accounts.last_error / sync_runs.error). */
export function errMsg(e: unknown, max = 300): string {
  let m: string;
  if (e instanceof Error) m = e.message || e.name;
  else if (typeof e === 'string') m = e;
  else m = JSON.stringify(e) ?? 'Unknown error';
  m = m.replace(/\s+/g, ' ').trim();
  return m.length > max ? m.slice(0, max - 1) + '...' : m;
}

/** Collects per-item failures so one zone/app/site failing never stops the rest. */
export class Collector {
  ok = 0;
  errors: string[] = [];
  expired = false;
  constructor(private readonly what: string) {}
  success(): void { this.ok++; }
  fail(e: unknown, label?: string): void {
    if (isExpired(e)) this.expired = true;
    this.errors.push((label ? `${label}: ` : '') + errMsg(e, 160));
  }
  /** Throws when nothing succeeded, surfacing the first meaningful error. */
  assertSome(): void {
    if (this.ok === 0 && this.errors.length) {
      throw new SyncError(this.errors[0], { expired: this.expired });
    }
  }
  summary(): string | null {
    if (!this.errors.length) return null;
    return `${this.errors.length} ${this.what} failed: ${this.errors[0]}`;
  }
}

// ---------- http ----------
export interface FetchInit {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  /** per-request timeout (default 20s), always also bound by the account budget signal */
  timeoutMs?: number;
  /** what to call this request in error messages, e.g. "zones" */
  label?: string;
  /** statuses to return as a normal Response instead of throwing (e.g. 404) */
  allow?: number[];
}

export function providerName(p: Provider): string {
  return PROVIDERS[p]?.name ?? p;
}

function anySignal(signals: AbortSignal[]): AbortSignal {
  const ac = new AbortController();
  for (const s of signals) {
    if (s.aborted) { ac.abort(s.reason); break; }
    s.addEventListener('abort', () => ac.abort(s.reason), { once: true });
  }
  return ac.signal;
}

function timeoutSignal(ms: number): { signal: AbortSignal; clear: () => void } {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(new SyncError(`request timed out after ${Math.round(ms / 1000)}s`)), ms);
  return { signal: ac.signal, clear: () => clearTimeout(t) };
}

/** Pulls a human message out of the many error envelope shapes providers use. */
export function extractErrorDetail(body: string): string {
  try {
    const j = JSON.parse(body) as Record<string, unknown>;
    const cand: unknown[] = [
      (j.errors as { message?: string }[] | undefined)?.[0]?.message,
      (j.error as { message?: string } | undefined)?.message,
      typeof j.error === 'string' ? j.error : undefined,
      j.error_description, j.message, j.msg, j.detail, j.name,
      (j.errors as { detail?: string }[] | undefined)?.[0]?.detail,
    ];
    const s = cand.find((c) => typeof c === 'string' && c.trim());
    if (typeof s === 'string') return s.trim().slice(0, 140);
  } catch { /* not json */ }
  const t = body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return t.slice(0, 120);
}

/** Low-level fetch with timeout + budget signal. Throws SyncError only on network failure/abort. */
export async function httpRaw(provider: Provider, url: string, init: FetchInit, budget: AbortSignal): Promise<Response> {
  const t = timeoutSignal(init.timeoutMs ?? 20000);
  try {
    return await fetch(url, {
      method: init.method ?? 'GET',
      headers: init.headers,
      body: init.body,
      signal: anySignal([budget, t.signal]),
      redirect: 'follow',
    });
  } catch (e) {
    if (budget.aborted) throw budget.reason instanceof Error ? budget.reason : new SyncError('Sync budget exhausted');
    if (e instanceof SyncError) throw e;
    if (isAbortError(e)) throw new SyncError(`${providerName(provider)}: ${init.label ?? 'request'} timed out`);
    throw new SyncError(`${providerName(provider)}: network error (${errMsg(e, 100)})`);
  } finally {
    t.clear();
  }
}

/** Fetch and classify. 401/403 => expired. Returns parsed JSON (or `null` for empty bodies). */
export async function httpJson<T>(provider: Provider, url: string, init: FetchInit, budget: AbortSignal): Promise<T> {
  const res = await httpRaw(provider, url, init, budget);
  const label = init.label ?? new URL(url).pathname;
  if (!res.ok && !(init.allow ?? []).includes(res.status)) {
    const text = await res.text().catch(() => '');
    const detail = extractErrorDetail(text);
    const name = providerName(provider);
    if (res.status === 401 || res.status === 403) {
      // A 403 for a disabled API, a missing permission on an otherwise valid token, or a plan/feature gate is not an
      // expired credential: keep the account retrying instead of parking it as 'expired'.
      const notExpired = res.status === 403 && /has not been used|is disabled|accessNotConfigured|SERVICE_DISABLED|PERMISSION_DENIED|insufficient.*(scope|permission)|not (enabled|authorized) for|Transaction Search|does not have permission|lacks? (the )?permission|forbidden for this (token|key)/i.test(text);
      if (notExpired) throw new SyncError(`${name} refused (403)${detail ? `: ${detail}` : ''}`, { status: 403 });
      throw new SyncError(`${name} token rejected (${res.status})${detail ? `: ${detail}` : ''}`, { status: res.status, expired: true });
    }
    if (res.status === 429) throw new SyncError(`${name} rate limited (429) on ${label}`, { status: 429 });
    throw new SyncError(`${name}: ${label} failed (${res.status})${detail ? `: ${detail}` : ''}`, { status: res.status });
  }
  const text = await res.text();
  if (!text.trim()) return null as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new SyncError(`${providerName(provider)}: ${label} returned non-JSON (${res.status})`, { status: res.status });
  }
}

// ---------- concurrency ----------
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const out: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try { out[i] = { status: 'fulfilled', value: await fn(items[i], i) }; }
      catch (reason) { out[i] = { status: 'rejected', reason }; }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

// ---------- coercion ----------
export const num = (v: unknown, d = 0): number => { const n = typeof v === 'string' ? Number(v) : (v as number); return Number.isFinite(n) ? n : d; };
export const numOrNull = (v: unknown): number | null => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
export const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : v === null || v === undefined ? d : String(v));
export const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
/** ISO string from an ISO string, epoch seconds or epoch ms; null when unparseable. */
export const iso = (v: unknown): string | null => {
  if (v === null || v === undefined || v === '') return null;
  const d = typeof v === 'number' ? new Date(v < 1e12 ? v * 1000 : v) : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
export const daysAgo = (now: Date, n: number): Date => new Date(now.getTime() - n * 86400000);
export const hoursAgo = (now: Date, n: number): Date => new Date(now.getTime() - n * 3600000);
export const within = (isoTime: string | null, since: Date): boolean => !!isoTime && new Date(isoTime).getTime() >= since.getTime();
export const form = (o: Record<string, string>): string => new URLSearchParams(o).toString();
export const utcMidnight = (d: Date): Date => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

/** Returns the same entries deduped by key, first wins. */
export function uniqBy<T>(items: T[], key: (t: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const it of items) { const k = key(it); if (!seen.has(k)) { seen.add(k); out.push(it); } }
  return out;
}

/** Sum numeric fields of per-day records into an accumulator map (day -> values). */
export function addDay<T extends object>(acc: Map<string, T>, day: string, values: T): void {
  const cur = acc.get(day) as Record<string, number> | undefined;
  if (!cur) { acc.set(day, { ...values }); return; }
  const v = values as Record<string, number>;
  for (const k of Object.keys(v)) cur[k] = (cur[k] ?? 0) + v[k];
}

// ---------- rows written by providers ----------
export type LinkKind = 'domain' | 'site' | 'database' | 'app' | 'repo' | 'account' | 'worker' | 'tunnel';
export interface LinkRef { kind: LinkKind; ref: string }

export interface HistoryEvent {
  /** unique dedupe key, e.g. nl:deploy:<id> */
  fingerprint: string;
  title: string;
  detail?: string | null;
  /** ISO time the thing happened at the provider */
  occurredAt: string;
  /** resolves to project_id via project_links */
  link?: LinkRef | null;
}

export type AlertKind = 'failed_deploy' | 'failed_run' | 'domain_expiry' | 'app_review' | 'token_failure' | 'sync_error' | 'new_revenue' | 'new_build';
export interface AlertCandidate {
  kind: AlertKind;
  fingerprint: string;
  title: string;
  body: string;
  urgent?: boolean;
  link?: LinkRef | null;
  /** set by the runner */
  accountId?: string | null;
}

export interface MailRow {
  message_id: string; thread_id: string | null; from_name: string | null; from_email: string | null;
  subject: string | null; snippet: string | null; received_at: string; important: boolean; unread: boolean; labels: string[];
}
export interface CalRow {
  event_id: string; calendar_id: string; calendar_name: string | null; color: string | null;
  title: string; starts_at: string; ends_at: string | null; all_day: boolean;
}

export interface Writers {
  /** upsert snapshots(account_id, kind) immediately */
  snapshot(kind: string, data: unknown): Promise<void>;
  /** buffered; flushed by the runner after the module returns (also on failure) */
  metric(kind: string, day: string, values: Record<string, number>): void;
  /** upsert mail rows; optionally delete this account's rows older than pruneBefore */
  mail(rows: MailRow[], opts?: { pruneBefore?: string }): Promise<void>;
  /** replace this account's calendar rows inside [from, to] */
  cal(rows: CalRow[], window: { from: string; to: string }): Promise<void>;
  /** buffered history row (kind 'provider', source = provider) */
  event(e: HistoryEvent): void;
  /** candidate for alerts.ts (gated by hq_user.notifications there) */
  alert(a: AlertCandidate): void;
  /** re-encrypt and store rotated secrets (Google access token) */
  secrets(next: AccountSecrets): Promise<void>;
  /** merge non-secret config into accounts.meta (discovered names, packages) */
  meta(patch: Partial<AccountMeta>): Promise<void>;
}

export interface AccountRow {
  id: string; provider: Provider; label: string; meta: AccountMeta; status: string;
  last_sync_at: string | null; secret_enc: string | null; sync_minutes: number | null;
}

export interface SyncContext<S extends AccountSecrets = AccountSecrets> {
  account: AccountRow;
  secrets: S;
  meta: AccountMeta;
  /** aborts when the 45s account budget is spent */
  signal: AbortSignal;
  now: Date;
  tz: string;
  /** hq_user.mail_lookback_days */
  lookbackDays: number;
  env: { googleClientId: string; googleClientSecret: string };
  fetchJson<T>(url: string, init?: FetchInit): Promise<T>;
  fetchRaw(url: string, init?: FetchInit): Promise<Response>;
  /** previous snapshot of this account for change detection */
  previous<T>(kind: string): T | null;
  writers: Writers;
  log(msg: string): void;
}

export type ProviderSync = (ctx: SyncContext) => Promise<void>;

/** Narrow ctx.secrets to one provider, failing loudly if the stored blob is for another provider. */
export function secretsFor<P extends AccountSecrets['provider']>(ctx: SyncContext, p: P): Extract<AccountSecrets, { provider: P }> {
  const s = ctx.secrets as AccountSecrets;
  if (s.provider !== p) throw new SyncError(`Stored credentials are for ${s.provider}, not ${p}: re-add this account`, { expired: true });
  return s as Extract<AccountSecrets, { provider: P }>;
}
