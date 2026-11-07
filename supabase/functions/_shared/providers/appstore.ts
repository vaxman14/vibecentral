// App Store Connect: apps, versions, review states, latest build, TestFlight review state.
// Non-GET calls: none. The ES256 JWT is signed locally (jwt.ts).
import type { AsApp } from '../types.ts';
import { Collector, SyncError, isExpired, mapLimit, str, strOrNull, type SyncContext, secretsFor } from './ctx.ts';
import { nowSeconds, signJwt } from './jwt.ts';

const API = 'https://api.appstoreconnect.apple.com';

interface AsResource<A> { id: string; type: string; attributes: A; relationships?: Record<string, { data?: { id: string; type: string } | null }> }
interface AsList<A, I = unknown> { data: AsResource<A>[]; included?: AsResource<I>[]; links?: { next?: string } }
interface AppAttrs { name: string; bundleId: string; sku?: string | null }
interface VersionAttrs { versionString: string; appStoreState?: string | null; appVersionState?: string | null; platform?: string; createdDate?: string }
interface BuildAttrs { version: string; uploadedDate: string; processingState: string }
interface PreReleaseAttrs { version: string }
interface BetaReviewAttrs { betaReviewState: string }

const LIVE = new Set(['READY_FOR_SALE', 'READY_FOR_DISTRIBUTION']);
const DONE = new Set(['READY_FOR_SALE', 'READY_FOR_DISTRIBUTION', 'REPLACED_WITH_NEW_VERSION', 'REMOVED_FROM_SALE', 'DEVELOPER_REMOVED_FROM_SALE']);

export function humanState(s: string | null): string {
  if (!s) return '';
  return s.toLowerCase().split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

export async function sync(ctx: SyncContext): Promise<void> {
  const { issuerId, keyId, privateKeyP8 } = secretsFor(ctx, 'appstore');
  const iat = nowSeconds(ctx.now);
  const jwt = await signJwt('ES256', privateKeyP8, { kid: keyId }, { iss: issuerId, iat, exp: iat + 15 * 60, aud: 'appstoreconnect-v1' });
  const headers = { Authorization: `Bearer ${jwt}` };
  const get = <T>(url: string, label: string, allow?: number[]) => ctx.fetchJson<T>(url.startsWith('http') ? url : `${API}${url}`, { headers, label, allow });

  // ---- apps (follow links.next just in case) ----
  const apps: AsResource<AppAttrs>[] = [];
  let next: string | undefined = `/v1/apps?limit=50&fields[apps]=name,bundleId,sku`;
  for (let i = 0; i < 5 && next; i++) {
    const page: AsList<AppAttrs> = await get<AsList<AppAttrs>>(next, 'apps');
    apps.push(...(page.data ?? []));
    next = page.links?.next;
  }
  if (!apps.length) throw new SyncError('App Store Connect: the key can see no apps');

  const prev = ctx.previous<AsApp[]>('apps') ?? [];
  const part = new Collector('apps');
  const results = await mapLimit(apps, 3, async (app): Promise<AsApp> => {
    const out: AsApp = {
      id: app.id, name: app.attributes.name, bundleId: app.attributes.bundleId, sku: strOrNull(app.attributes.sku), platforms: [],
      liveVersion: null, liveState: null, pendingVersion: null, pendingState: null,
      // Aggregate rating is not exposed by the App Store Connect API (customerReviews are individual reviews).
      rating: null, ratingCount: null, latestBuild: null, testflight: null,
    };
    let any = false;

    try {
      const v = await get<AsList<VersionAttrs>>(`/v1/apps/${app.id}/appStoreVersions?limit=5&fields[appStoreVersions]=versionString,appStoreState,appVersionState,platform,createdDate`, `versions ${app.attributes.name}`);
      const versions = (v.data ?? []).map((x) => ({ version: x.attributes.versionString, state: str(x.attributes.appVersionState ?? x.attributes.appStoreState), platform: x.attributes.platform ?? 'IOS', created: x.attributes.createdDate ?? '' }))
        .sort((a, b) => b.created.localeCompare(a.created));
      out.platforms = [...new Set(versions.map((x) => x.platform))];
      const live = versions.find((x) => LIVE.has(x.state));
      if (live) { out.liveVersion = live.version; out.liveState = live.state; }
      const pending = versions.find((x) => !DONE.has(x.state));
      if (pending) { out.pendingVersion = pending.version; out.pendingState = pending.state; }
      any = true;
    } catch (e) { if (isExpired(e)) throw e; part.fail(e, `${app.attributes.name} versions`); }

    try {
      const b = await get<AsList<BuildAttrs, PreReleaseAttrs>>(`/v1/apps/${app.id}/builds?limit=1&sort=-uploadedDate&fields[builds]=version,uploadedDate,processingState,preReleaseVersion&include=preReleaseVersion&fields[preReleaseVersions]=version`, `builds ${app.attributes.name}`);
      const build = b.data?.[0];
      if (build) {
        const preId = build.relationships?.preReleaseVersion?.data?.id;
        const pre = b.included?.find((i) => i.id === preId)?.attributes.version ?? out.pendingVersion ?? out.liveVersion ?? '';
        out.latestBuild = { version: pre, build: build.attributes.version, uploadedAt: build.attributes.uploadedDate, processingState: build.attributes.processingState };
        try {
          const tf = await get<{ data?: AsResource<BetaReviewAttrs> | null }>(`/v1/builds/${build.id}/betaAppReviewSubmission?fields[betaAppReviewSubmissions]=betaReviewState`, `testflight ${app.attributes.name}`, [404]);
          if (tf?.data?.attributes?.betaReviewState) out.testflight = { version: pre, build: build.attributes.version, state: tf.data.attributes.betaReviewState };
        } catch (e) { if (isExpired(e)) throw e; ctx.log(`testflight failed for ${app.attributes.name}: ${(e as Error).message}`); }
      }
      any = true;
    } catch (e) { if (isExpired(e)) throw e; part.fail(e, `${app.attributes.name} builds`); }

    if (any) part.success();
    return out;
  });

  const list: AsApp[] = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') list.push(r.value);
    else if (isExpired(r.reason)) throw r.reason;
    else part.fail(r.reason, apps[i].attributes.name);
  });
  part.assertSome();

  // ---- change detection against the previous snapshot ----
  for (const a of list) {
    const before = prev.find((p) => p.id === a.id);
    if (!before) continue;
    if (a.pendingState && (a.pendingState !== before.pendingState || a.pendingVersion !== before.pendingVersion)) {
      const title = `${a.name} ${a.pendingVersion ?? ''} is now ${humanState(a.pendingState)}`.replace(/\s+/g, ' ');
      const fp = `as:state:${a.id}:${a.pendingState}:${a.pendingVersion ?? ''}`;
      ctx.writers.event({ fingerprint: fp, title, detail: before.pendingState ? `Was ${humanState(before.pendingState)}` : null, occurredAt: ctx.now.toISOString(), link: { kind: 'app', ref: a.bundleId } });
      ctx.writers.alert({ kind: 'app_review', fingerprint: `app_review:${a.id}:${a.pendingState}:${a.pendingVersion ?? ''}`, title, body: `App Store review state changed for ${a.name} (${a.bundleId}).`, urgent: /REJECTED/.test(a.pendingState), link: { kind: 'app', ref: a.bundleId } });
    } else if (!a.pendingState && before.pendingState && a.liveVersion && a.liveVersion === before.pendingVersion) {
      const title = `${a.name} ${a.liveVersion} is live on the App Store`;
      ctx.writers.event({ fingerprint: `as:state:${a.id}:LIVE:${a.liveVersion}`, title, occurredAt: ctx.now.toISOString(), link: { kind: 'app', ref: a.bundleId } });
      ctx.writers.alert({ kind: 'app_review', fingerprint: `app_review:${a.id}:LIVE:${a.liveVersion}`, title, body: `${a.bundleId} was approved and released.`, link: { kind: 'app', ref: a.bundleId } });
    }
    if (a.latestBuild && a.latestBuild.build !== before.latestBuild?.build) {
      const title = `New build ${a.latestBuild.version} (${a.latestBuild.build}) for ${a.name}`;
      ctx.writers.event({ fingerprint: `as:build:${a.id}:${a.latestBuild.build}`, title, detail: a.latestBuild.processingState, occurredAt: a.latestBuild.uploadedAt, link: { kind: 'app', ref: a.bundleId } });
      ctx.writers.alert({ kind: 'new_build', fingerprint: `new_build:${a.id}:${a.latestBuild.build}`, title, body: `Uploaded ${a.latestBuild.uploadedAt} · ${a.latestBuild.processingState}.`, link: { kind: 'app', ref: a.bundleId } });
    }
  }

  await ctx.writers.snapshot('apps', list);
  if (part.errors.length) ctx.log(part.summary() ?? '');
}
