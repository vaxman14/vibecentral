// Google Play: ratings/installs/crashes from the Play Console reports bucket (GCS, read-only) and the
// Reviews API. Non-GET calls: POST https://oauth2.googleapis.com/token (service-account JWT exchange, the only
// way to get a bearer token). edits.* is never touched, so release status is not available here.
import type { GpApp } from '../types.ts';
import { Collector, SyncError, daysAgo, form, isExpired, mapLimit, num, numOrNull, str, type SyncContext, secretsFor, extractErrorDetail } from './ctx.ts';
import { nowSeconds, signJwt } from './jwt.ts';

const GCS = 'https://storage.googleapis.com/storage/v1/b';
const PUBLISHER = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications';
const SCOPES = 'https://www.googleapis.com/auth/androidpublisher https://www.googleapis.com/auth/devstorage.read_only';

interface ServiceAccount { client_email: string; private_key: string; token_uri?: string }
interface GcsList { items?: { name: string }[]; nextPageToken?: string }
interface GpReview { reviewId: string; authorName?: string; comments?: { userComment?: { text?: string; lastModified?: { seconds?: string | number }; starRating?: number } }[] }

export async function sync(ctx: SyncContext): Promise<void> {
  const { serviceAccountJson } = secretsFor(ctx, 'googleplay');
  let sa: ServiceAccount;
  try { sa = JSON.parse(serviceAccountJson) as ServiceAccount; } catch { throw new SyncError('Google Play: service account JSON is not valid JSON', { expired: true }); }
  if (!sa.client_email || !sa.private_key) throw new SyncError('Google Play: service account JSON lacks client_email/private_key', { expired: true });

  const token = await serviceAccountToken(ctx, sa);
  const headers = { Authorization: `Bearer ${token}` };
  const bucket = ctx.meta.reportsBucket?.replace(/^gs:\/\//, '').replace(/\/+$/, '');

  // ---- discover packages + report files ----
  const files = new Map<string, Map<string, string[]>>(); // kind -> pkg -> file names (sorted ascending by month)
  if (bucket) {
    for (const kind of ['ratings', 'installs', 'crashes'] as const) {
      try {
        const names = await listObjects(ctx, headers, bucket, `stats/${kind}/`);
        const byPkg = new Map<string, string[]>();
        for (const n of names) {
          const m = n.match(new RegExp(`stats/${kind}/${kind}_(.+)_(\\d{6})_overview\\.csv$`));
          if (!m) continue;
          const list = byPkg.get(m[1]) ?? [];
          list.push(n);
          byPkg.set(m[1], list);
        }
        for (const l of byPkg.values()) l.sort();
        files.set(kind, byPkg);
      } catch (e) {
        if (isExpired(e)) throw new SyncError(`Google Play: the service account cannot read bucket ${bucket} (grant "View app information and download bulk reports")`, { expired: true });
        ctx.log(`listing ${kind} reports failed: ${(e as Error).message}`);
      }
    }
  } else ctx.log('no reportsBucket in meta: ratings/installs/crashes unavailable');

  const packages = new Set<string>(ctx.meta.packageNames ?? []);
  for (const byPkg of files.values()) for (const p of byPkg.keys()) packages.add(p);
  if (!packages.size) throw new SyncError(bucket ? `Google Play: no report files found in ${bucket} (reports appear a day after the first install)` : 'Google Play: set the reports bucket (meta.reportsBucket) or package names');
  await ctx.writers.meta({ packageNames: [...packages].sort() }).catch(() => {});

  const weekAgo = daysAgo(ctx.now, 7).toISOString().slice(0, 10);
  const part = new Collector('apps');
  const results = await mapLimit([...packages].sort(), 2, async (pkg): Promise<GpApp> => {
    // App display name is not available without edits.* (write) calls: the Worker falls back to the package name.
    const app: GpApp = { packageName: pkg, name: null, rating: null, ratingCount: null, crashes7d: null, anrs7d: null, installs: null, reviews: [] };
    let any = false;

    const latest = (kind: string, n = 1) => (files.get(kind)?.get(pkg) ?? []).slice(-n);
    try {
      const [ratingsFile] = latest('ratings');
      if (ratingsFile) {
        const rows = parseCsv(await downloadCsv(ctx, headers, bucket as string, ratingsFile));
        const last = [...rows].reverse().find((r) => numOrNull(r['Total Average Rating']) !== null);
        if (last) app.rating = round2(num(last['Total Average Rating']));
        any = true;
      }
    } catch (e) { if (isExpired(e)) throw e; ctx.log(`ratings failed for ${pkg}: ${(e as Error).message}`); }

    try {
      const [installsFile] = latest('installs');
      if (installsFile) {
        const rows = parseCsv(await downloadCsv(ctx, headers, bucket as string, installsFile));
        const last = [...rows].reverse().find((r) => numOrNull(r['Total User Installs'] ?? r['Active Device Installs']) !== null);
        if (last) app.installs = num(last['Total User Installs'] ?? last['Active Device Installs']);
        any = true;
      }
    } catch (e) { if (isExpired(e)) throw e; ctx.log(`installs failed for ${pkg}: ${(e as Error).message}`); }

    try {
      const crashFiles = latest('crashes', 2); // current + previous month covers any 7-day window
      if (crashFiles.length) {
        let crashes = 0, anrs = 0;
        for (const f of crashFiles) {
          for (const r of parseCsv(await downloadCsv(ctx, headers, bucket as string, f))) {
            if ((r['Date'] ?? '') >= weekAgo) { crashes += num(r['Daily Crashes']); anrs += num(r['Daily ANRs']); }
          }
        }
        app.crashes7d = crashes; app.anrs7d = anrs;
        any = true;
      }
    } catch (e) { if (isExpired(e)) throw e; ctx.log(`crashes failed for ${pkg}: ${(e as Error).message}`); }

    try {
      const res = await ctx.fetchJson<{ reviews?: GpReview[] }>(`${PUBLISHER}/${encodeURIComponent(pkg)}/reviews?maxResults=20`, { headers, label: `reviews ${pkg}` });
      app.reviews = (res?.reviews ?? []).map((rv) => {
        const c = rv.comments?.[0]?.userComment;
        const secs = num(c?.lastModified?.seconds);
        return { author: str(rv.authorName, 'Anonymous'), stars: num(c?.starRating), text: str(c?.text).replace(/^\t/, '').trim(), at: new Date((secs || nowSeconds(ctx.now)) * 1000).toISOString() };
      });
      any = true;
    } catch (e) {
      // 403 here means the package is not in this developer account (or the SA lacks the permission), not a dead token.
      ctx.log(`reviews failed for ${pkg}: ${(e as Error).message}`);
    }

    if (any) part.success(); else part.fail(new SyncError('no report files and reviews unavailable'), pkg);
    return app;
  });

  const apps: GpApp[] = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') apps.push(r.value);
    else if (isExpired(r.reason)) throw r.reason;
    else part.fail(r.reason, [...packages].sort()[i]);
  });
  part.assertSome();
  await ctx.writers.snapshot('apps', apps);
  if (part.errors.length) ctx.log(part.summary() ?? '');
}

/** RS256 service-account JWT -> access token (POST). */
async function serviceAccountToken(ctx: SyncContext, sa: ServiceAccount): Promise<string> {
  const iat = nowSeconds(ctx.now);
  const aud = sa.token_uri ?? 'https://oauth2.googleapis.com/token';
  const assertion = await signJwt('RS256', sa.private_key, {}, { iss: sa.client_email, scope: SCOPES, aud, iat, exp: iat + 3600 });
  const res = await ctx.fetchRaw(aud, {
    method: 'POST', label: 'token', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  });
  const text = await res.text();
  if (!res.ok) throw new SyncError(`Google Play: service account rejected (${res.status}): ${extractErrorDetail(text)}`, { status: res.status, expired: true });
  return (JSON.parse(text) as { access_token: string }).access_token;
}

async function listObjects(ctx: SyncContext, headers: Record<string, string>, bucket: string, prefix: string): Promise<string[]> {
  const names: string[] = [];
  let pageToken: string | undefined;
  for (let i = 0; i < 20; i++) {
    const qs = `prefix=${encodeURIComponent(prefix)}&fields=items(name),nextPageToken&maxResults=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
    const res = await ctx.fetchJson<GcsList>(`${GCS}/${encodeURIComponent(bucket)}/o?${qs}`, { headers, label: `list ${prefix}` });
    names.push(...(res?.items ?? []).map((o) => o.name));
    pageToken = res?.nextPageToken;
    if (!pageToken) break;
  }
  return names;
}

/** Play Console CSVs are UTF-16LE with a BOM; TextDecoder strips the BOM for us. */
async function downloadCsv(ctx: SyncContext, headers: Record<string, string>, bucket: string, name: string): Promise<string> {
  const res = await ctx.fetchRaw(`${GCS}/${encodeURIComponent(bucket)}/o/${encodeURIComponent(name)}?alt=media`, { headers, label: `download ${name}` });
  if (!res.ok) throw new SyncError(`Google Play: download ${name} failed (${res.status})`, { status: res.status, expired: res.status === 401 || res.status === 403 });
  const bytes = new Uint8Array(await res.arrayBuffer());
  return decodeCsvBytes(bytes);
}

export function decodeCsvBytes(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes as BufferSource);
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes as BufferSource);
  // no BOM: Play files are still UTF-16LE in practice; detect by the NUL bytes of ASCII text
  if (bytes.length >= 4 && bytes[1] === 0 && bytes[3] === 0) return new TextDecoder('utf-16le').decode(bytes as BufferSource);
  return new TextDecoder('utf-8').decode(bytes as BufferSource);
}

/** Minimal RFC4180 parser: handles quoted fields and CRLF. Returns rows keyed by header. */
export function parseCsv(text: string): Record<string, string>[] {
  const lines: string[][] = [];
  let row: string[] = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((c) => c !== '')) lines.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); if (row.some((c) => c !== '')) lines.push(row); }
  const [header, ...rest] = lines;
  if (!header) return [];
  const keys = header.map((h) => h.replace(/^﻿/, '').trim());
  return rest.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? '').trim()])));
}

const round2 = (n: number) => Math.round(n * 100) / 100;
