// Google: Gmail headers + Calendar events for one account.
// Non-GET calls: POST https://oauth2.googleapis.com/token (refresh_token grant; the only way to get an access token).
import type { AccountSecrets, GoogleSummary } from '../types.ts';
import {
  SyncError, daysAgo, extractErrorDetail, form, isExpired, mapLimit, str, strOrNull, uniqBy, type CalRow, type MailRow, type SyncContext, secretsFor,
} from './ctx.ts';

type GoogleSecrets = Extract<AccountSecrets, { provider: 'google' }>;

interface GmList { messages?: { id: string; threadId: string }[]; nextPageToken?: string; resultSizeEstimate?: number }
interface GmMessage { id: string; threadId?: string; labelIds?: string[]; snippet?: string; internalDate?: string; payload?: { headers?: { name: string; value: string }[] } }
interface GcCalendar { id: string; summary?: string; summaryOverride?: string; backgroundColor?: string; primary?: boolean; selected?: boolean; accessRole?: string; deleted?: boolean }
interface GcEvent { id: string; status?: string; summary?: string; start?: { date?: string; dateTime?: string }; end?: { date?: string; dateTime?: string } }

export async function sync(ctx: SyncContext): Promise<void> {
  const secrets = secretsFor(ctx, 'google');
  const accessToken = await ensureAccessToken(ctx, secrets);
  const headers = { Authorization: `Bearer ${accessToken}` };
  const get = <T>(url: string, label: string, allow?: number[]) => ctx.fetchJson<T>(url, { headers, label, allow });

  let email = ctx.meta.email ?? '';
  if (!email) {
    try {
      const profile = await get<{ emailAddress?: string }>('https://gmail.googleapis.com/gmail/v1/users/me/profile', 'profile');
      email = profile.emailAddress ?? '';
      if (email) await ctx.writers.meta({ email });
    } catch (e) { if (isExpired(e)) throw e; }
  }

  // ---- Gmail: newest messages in the lookback window, headers only ----
  const lookback = Math.max(1, ctx.lookbackDays || 14);
  let mailOk = false;
  let unreadImportant = 0;
  let mailError: string | null = null;
  try {
    const q = encodeURIComponent(`newer_than:${lookback}d -category:promotions -category:social`);
    const list = await get<GmList>(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${q}&maxResults=100`, 'mail list');
    const ids = (list.messages ?? []).map((m) => m.id);
    const fetched = await mapLimit(ids, 8, (id) =>
      get<GmMessage>(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`, 'message', [404]));
    const rows: MailRow[] = [];
    for (const r of fetched) {
      if (r.status === 'rejected') { if (isExpired(r.reason)) throw r.reason; continue; }
      const m = r.value;
      if (!m?.id) continue;
      const row = toMailRow(m);
      if (row) rows.push(row);
    }
    unreadImportant = rows.filter((r) => r.unread && r.important).length;
    await ctx.writers.mail(rows, { pruneBefore: daysAgo(ctx.now, lookback).toISOString() });
    mailOk = true;
  } catch (e) {
    if (isExpired(e)) throw e;
    mailError = (e as Error).message;
    ctx.log(`gmail failed: ${mailError}`);
  }

  // ---- Calendar: yesterday .. +14d ----
  const summaryCalendars: GoogleSummary['calendars'] = [];
  let calOk = false;
  let calError: string | null = null;
  try {
    const list = await get<{ items?: GcCalendar[] }>('https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=250', 'calendar list');
    let cals = (list.items ?? []).filter((c) => !c.deleted);
    if (ctx.meta.calendarIds?.length) {
      const allow = new Set(ctx.meta.calendarIds);
      cals = cals.filter((c) => allow.has(c.id));
    } else cals = cals.filter((c) => c.selected !== false || c.primary);
    cals.sort((a, b) => Number(!!b.primary) - Number(!!a.primary));
    for (const c of cals) summaryCalendars.push({ id: c.id, name: c.summaryOverride ?? c.summary ?? c.id, color: strOrNull(c.backgroundColor), primary: !!c.primary });

    const from = startOfDayInTz(daysAgo(ctx.now, 1), ctx.tz);
    const to = new Date(ctx.now.getTime() + 14 * 86400000);
    const perCal = await mapLimit(cals, 4, async (c) => {
      const qs = `timeMin=${encodeURIComponent(from.toISOString())}&timeMax=${encodeURIComponent(to.toISOString())}&singleEvents=true&orderBy=startTime&maxResults=250`;
      const res = await get<{ items?: GcEvent[] }>(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(c.id)}/events?${qs}`, `events ${c.summary ?? c.id}`);
      return (res.items ?? []).map((ev) => toCalRow(ev, c, ctx.tz)).filter((r): r is CalRow => !!r);
    });
    const rows: CalRow[] = [];
    let calFailures = 0;
    for (const r of perCal) {
      if (r.status === 'fulfilled') rows.push(...r.value);
      else { if (isExpired(r.reason)) throw r.reason; calFailures++; ctx.log(`calendar failed: ${(r.reason as Error).message}`); }
    }
    if (cals.length && calFailures === cals.length) throw new SyncError(`Google: every calendar failed to load`);
    await ctx.writers.cal(uniqBy(rows, (r) => r.event_id), { from: from.toISOString(), to: to.toISOString() });
    calOk = true;
  } catch (e) {
    if (isExpired(e)) throw e;
    calError = (e as Error).message;
    ctx.log(`calendar failed: ${calError}`);
  }

  if (!mailOk && !calOk) throw new SyncError(mailError ?? calError ?? 'Google: nothing could be read');

  const summary: GoogleSummary = {
    email, unreadImportant, calendars: summaryCalendars,
    lastMailSyncAt: mailOk ? ctx.now.toISOString() : (ctx.previous<GoogleSummary>('google')?.lastMailSyncAt ?? ctx.now.toISOString()),
  };
  await ctx.writers.snapshot('google', summary);
  if (!mailOk || !calOk) throw new SyncError(`Google: ${!mailOk ? `mail failed (${mailError})` : `calendar failed (${calError})`}`);
}

/** Returns a valid access token, refreshing (POST) and re-encrypting when the cached one is missing/expiring. */
async function ensureAccessToken(ctx: SyncContext, secrets: GoogleSecrets): Promise<string> {
  const exp = secrets.accessTokenExpiresAt ? new Date(secrets.accessTokenExpiresAt).getTime() : 0;
  if (secrets.accessToken && exp - ctx.now.getTime() > 2 * 60 * 1000) return secrets.accessToken;
  if (!secrets.refreshToken) throw new SyncError('Google: no refresh token stored; reconnect this account', { expired: true });
  if (!ctx.env.googleClientId || !ctx.env.googleClientSecret) throw new SyncError('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not set on the sync function');

  const res = await ctx.fetchRaw('https://oauth2.googleapis.com/token', {
    method: 'POST', label: 'token refresh', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({ client_id: ctx.env.googleClientId, client_secret: ctx.env.googleClientSecret, refresh_token: secrets.refreshToken, grant_type: 'refresh_token' }),
  });
  const text = await res.text();
  if (!res.ok) {
    const detail = extractErrorDetail(text);
    const invalidGrant = /invalid_grant/i.test(text);
    throw new SyncError(
      invalidGrant ? 'Google access was revoked or expired: reconnect this account' : `Google token refresh failed (${res.status})${detail ? `: ${detail}` : ''}`,
      { status: res.status, expired: invalidGrant || res.status === 401 || res.status === 403 },
    );
  }
  const tok = JSON.parse(text) as { access_token: string; expires_in?: number; scope?: string };
  const next: GoogleSecrets = {
    ...secrets, accessToken: tok.access_token,
    accessTokenExpiresAt: new Date(ctx.now.getTime() + Math.max(60, (tok.expires_in ?? 3600) - 60) * 1000).toISOString(),
  };
  await ctx.writers.secrets(next);
  if (tok.scope) await ctx.writers.meta({ scopes: tok.scope.split(' ') }).catch(() => {});
  return tok.access_token;
}

export function parseFrom(v: string): { name: string | null; email: string | null } {
  const m = v.match(/^\s*"?([^"<]*)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim() || null, email: m[2].trim().toLowerCase() || null };
  const e = v.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
  return { name: e ? null : v.trim() || null, email: e ? e[0].toLowerCase() : null };
}

function toMailRow(m: GmMessage): MailRow | null {
  const h = (n: string) => m.payload?.headers?.find((x) => x.name.toLowerCase() === n.toLowerCase())?.value ?? null;
  const ms = Number(m.internalDate);
  const received = Number.isFinite(ms) && ms > 0 ? new Date(ms) : (h('Date') ? new Date(h('Date') as string) : null);
  if (!received || Number.isNaN(received.getTime())) return null;
  const from = parseFrom(h('From') ?? '');
  const labels = m.labelIds ?? [];
  return {
    message_id: m.id, thread_id: m.threadId ?? null, from_name: from.name, from_email: from.email,
    subject: h('Subject'), snippet: str(m.snippet).slice(0, 300) || null, received_at: received.toISOString(),
    important: labels.includes('IMPORTANT'), unread: labels.includes('UNREAD'), labels,
  };
}

function toCalRow(ev: GcEvent, cal: GcCalendar, tz: string): CalRow | null {
  if (ev.status === 'cancelled' || !ev.id) return null;
  const allDay = !!ev.start?.date;
  const starts = allDay ? zonedMidnight(ev.start?.date as string, tz) : (ev.start?.dateTime ? new Date(ev.start.dateTime) : null);
  if (!starts || Number.isNaN(starts.getTime())) return null;
  const ends = allDay ? (ev.end?.date ? zonedMidnight(ev.end.date, tz) : null) : (ev.end?.dateTime ? new Date(ev.end.dateTime) : null);
  return {
    event_id: ev.id, calendar_id: cal.id, calendar_name: cal.summaryOverride ?? cal.summary ?? null, color: strOrNull(cal.backgroundColor),
    title: ev.summary?.trim() || '(No title)', starts_at: starts.toISOString(), ends_at: ends && !Number.isNaN(ends.getTime()) ? ends.toISOString() : null, all_day: allDay,
  };
}

/** Offset of `tz` at instant `d`, in minutes east of UTC. */
function tzOffsetMinutes(d: Date, tz: string): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' }).formatToParts(d);
    const v = parts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
    const m = v.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/);
    if (!m) return 0;
    const sign = m[1] === '-' ? -1 : 1;
    return sign * (Number(m[2]) * 60 + Number(m[3] ?? 0));
  } catch { return 0; }
}
/** Midnight of a YYYY-MM-DD date in `tz`, as a UTC instant. */
export function zonedMidnight(date: string, tz: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  const guess = new Date(Date.UTC(y, m - 1, d));
  return new Date(guess.getTime() - tzOffsetMinutes(guess, tz) * 60000);
}
function startOfDayInTz(d: Date, tz: string): Date {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '01';
  return zonedMidnight(`${get('year')}-${get('month')}-${get('day')}`, tz);
}
