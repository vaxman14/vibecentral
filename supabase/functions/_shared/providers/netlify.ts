// Netlify: sites and their last 15 deploys. GET only.
import type { DeployDay, NlDeploy, NlSite } from '../types.ts';
import { dayKey, lastNDays } from '../util.ts';
import { Collector, SyncError, addDay, daysAgo, isExpired, mapLimit, numOrNull, strOrNull, type SyncContext, secretsFor } from './ctx.ts';

const API = 'https://api.netlify.com/api/v1';

interface NlSiteRaw {
  id: string; name: string; url?: string; ssl_url?: string; custom_domain?: string | null; admin_url?: string;
  account_slug?: string; account_name?: string; build_settings?: { repo_url?: string | null } | null;
}
interface NlDeployRaw {
  id: string; site_id: string; state: string; created_at: string; published_at?: string | null; deploy_time?: number | null;
  branch?: string | null; title?: string | null; error_message?: string | null; context?: string | null;
  deploy_ssl_url?: string | null; ssl_url?: string | null; url?: string | null;
}

/** Netlify has many intermediate states; collapse them to the set the UI knows. */
export function mapDeployState(s: string): string {
  switch (s) {
    case 'ready': case 'error': case 'building': case 'enqueued': case 'new': case 'processing': case 'failed': return s;
    case 'preparing': case 'prepared': case 'uploading': case 'uploaded': case 'retrying': return 'building';
    case 'rejected': case 'cancelled': case 'canceled': return 'failed';
    default: return s || 'new';
  }
}

export async function sync(ctx: SyncContext): Promise<void> {
  const { accessToken } = secretsFor(ctx, 'netlify');
  const headers = { Authorization: `Bearer ${accessToken}` };

  const sitesRaw: NlSiteRaw[] = [];
  for (let page = 1; page <= 5; page++) {
    const batch = await ctx.fetchJson<NlSiteRaw[]>(`${API}/sites?per_page=100&page=${page}`, { headers, label: 'sites' });
    sitesRaw.push(...(batch ?? []));
    if (!batch || batch.length < 100) break;
  }
  const allowTeams = ctx.meta.teamSlugs?.length ? new Set(ctx.meta.teamSlugs) : null;
  const sitesFiltered = allowTeams ? sitesRaw.filter((s) => s.account_slug && allowTeams.has(s.account_slug)) : sitesRaw;
  if (!sitesFiltered.length && sitesRaw.length) throw new SyncError('Netlify: no sites match meta.teamSlugs');

  const weekAgo = daysAgo(ctx.now, 7);
  const part = new Collector('sites');
  const deploysBySite = new Map<string, NlDeploy[]>();
  await mapLimit(sitesFiltered, 6, async (s) => {
    try {
      const raw = await ctx.fetchJson<NlDeployRaw[]>(`${API}/sites/${s.id}/deploys?per_page=15`, { headers, label: `deploys ${s.name}` });
      deploysBySite.set(s.id, (raw ?? []).map((d) => toDeploy(d, s.name)));
      part.success();
    } catch (e) {
      if (isExpired(e)) throw e;
      part.fail(e, s.name);
      deploysBySite.set(s.id, []);
    }
  });
  if (sitesFiltered.length) part.assertSome();

  const sites: NlSite[] = sitesFiltered.map((s) => ({
    id: s.id, name: s.name, url: s.ssl_url ?? s.url ?? `https://${s.name}.netlify.app`,
    customDomain: strOrNull(s.custom_domain), accountSlug: s.account_slug ?? '', accountName: s.account_name ?? s.account_slug ?? '',
    repoUrl: strOrNull(s.build_settings?.repo_url), lastDeploy: deploysBySite.get(s.id)?.[0] ?? null,
    adminUrl: s.admin_url ?? `https://app.netlify.com/sites/${s.name}`,
  }));
  await ctx.writers.snapshot('sites', sites);

  const recent = [...deploysBySite.values()].flat().filter((d) => new Date(d.createdAt) >= weekAgo)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  await ctx.writers.snapshot('deploys', recent);

  // per-day deploy counts (7 days, zero-filled)
  const perDay = new Map<string, DeployDay>();
  for (const day of lastNDays(7, ctx.tz, ctx.now)) perDay.set(day, { deploys: 0, failed: 0 });
  for (const d of recent) addDay(perDay, dayKey(d.createdAt, ctx.tz), { deploys: 1, failed: d.state === 'error' || d.state === 'failed' ? 1 : 0 });
  for (const [day, v] of perDay) ctx.writers.metric('deploys', day, { ...v });

  // history: failed + published deploys in the last 7 days (alerts.ts turns recent failures into alerts)
  for (const d of recent) {
    if (d.state === 'error' || d.state === 'failed') {
      ctx.writers.event({ fingerprint: `nl:deploy:${d.id}`, title: `Deploy failed: ${d.siteName}`, detail: d.errorMessage ?? d.title ?? null, occurredAt: d.createdAt, link: { kind: 'site', ref: d.siteId } });
    } else if (d.state === 'ready' && d.context === 'production') {
      ctx.writers.event({ fingerprint: `nl:deploy:${d.id}`, title: `Published ${d.siteName}${d.branch ? ` (${d.branch})` : ''}`, detail: d.title ?? null, occurredAt: d.publishedAt ?? d.createdAt, link: { kind: 'site', ref: d.siteId } });
    }
  }
  if (part.errors.length) ctx.log(part.summary() ?? '');
}

function toDeploy(d: NlDeployRaw, siteName: string): NlDeploy {
  return {
    id: d.id, siteId: d.site_id, siteName, state: mapDeployState(d.state),
    createdAt: d.created_at, publishedAt: strOrNull(d.published_at), deployTimeSec: numOrNull(d.deploy_time),
    branch: strOrNull(d.branch), title: strOrNull(d.title), errorMessage: strOrNull(d.error_message),
    context: strOrNull(d.context), url: strOrNull(d.deploy_ssl_url ?? d.ssl_url ?? d.url),
  };
}
