// Supabase Management API: projects, organizations, health, advisors, and three SELECT-only queries.
// Non-GET calls: POST https://api.supabase.com/v1/projects/{ref}/database/query — body is always one of the
// read-only SELECT statements in `SQL` below; it is the only way the Management API exposes pg_database_size etc.
import type { SbProject } from '../types.ts';
import { Collector, SyncError, isExpired, mapLimit, num, numOrNull, str, type SyncContext, secretsFor } from './ctx.ts';

const API = 'https://api.supabase.com/v1';

interface SbProjectRaw { id: string; organization_id: string; name: string; region: string; created_at: string; status: string }
interface SbOrg { id: string; name: string; slug?: string }
interface SbHealth { name: string; healthy: boolean; status?: string; error?: string }
interface SbLint { name?: string; title?: string; level?: string; categories?: string[]; facing?: string }

const SQL = {
  dbSize: 'select pg_database_size(current_database()) as bytes',
  authUsers: 'select count(*)::bigint as n from auth.users',
  storageBytes: "select coalesce(sum((metadata->>'size')::bigint),0)::bigint as bytes from storage.objects",
} as const;

export function mapStatus(projectStatus: string, health: SbHealth[] | null): string {
  switch (projectStatus) {
    case 'ACTIVE_HEALTHY': return health && health.some((h) => !h.healthy) ? 'Degraded' : 'Healthy';
    case 'ACTIVE_UNHEALTHY': return 'Unhealthy';
    case 'INACTIVE': return 'Paused';
    case 'PAUSING': return 'Pausing';
    case 'COMING_UP': case 'RESTORING': case 'UPGRADING': case 'RESIZING': case 'INIT_FAILED': return projectStatus === 'INIT_FAILED' ? 'Failed' : 'Starting';
    case 'GOING_DOWN': case 'REMOVED': return 'Removed';
    case 'PAUSE_FAILED': case 'RESTORE_FAILED': case 'RESTARTING': return projectStatus === 'RESTARTING' ? 'Restarting' : 'Failed';
    default: return projectStatus ? projectStatus.charAt(0) + projectStatus.slice(1).toLowerCase().replace(/_/g, ' ') : 'Unknown';
  }
}

export async function sync(ctx: SyncContext): Promise<void> {
  const { accessToken } = secretsFor(ctx, 'supabase');
  const headers = { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' };

  const [projectsRaw, orgs] = await Promise.all([
    ctx.fetchJson<SbProjectRaw[]>(`${API}/projects`, { headers, label: 'projects' }),
    ctx.fetchJson<SbOrg[]>(`${API}/organizations`, { headers, label: 'organizations' }).catch((e: unknown) => { if (isExpired(e)) throw e; ctx.log(`organizations failed: ${(e as Error).message}`); return [] as SbOrg[]; }),
  ]);
  if (!projectsRaw) throw new SyncError('Supabase: projects returned nothing');
  const orgById = new Map((orgs ?? []).map((o) => [o.id, o]));
  const prev = ctx.previous<SbProject[]>('projects') ?? [];

  const part = new Collector('projects');
  const results = await mapLimit(projectsRaw, 3, async (p): Promise<SbProject> => {
    const active = p.status === 'ACTIVE_HEALTHY' || p.status === 'ACTIVE_UNHEALTHY';
    let health: SbHealth[] | null = null;
    if (active) {
      try { health = await ctx.fetchJson<SbHealth[]>(`${API}/projects/${p.id}/health?services=db,auth,storage,rest`, { headers, label: `health ${p.name}` }); }
      catch (e) { if (isExpired(e)) throw e; ctx.log(`health failed for ${p.name}: ${(e as Error).message}`); }
    }

    const advisors = { security: 0, performance: 0, items: [] as { category: string; level: string; title: string }[] };
    if (active) {
      for (const kind of ['security', 'performance'] as const) {
        try {
          const res = await ctx.fetchJson<{ lints?: SbLint[] }>(`${API}/projects/${p.id}/advisors/${kind}`, { headers, label: `${kind} advisors ${p.name}` });
          const lints = (res?.lints ?? []).filter((l) => (l.level ?? '').toUpperCase() !== 'INFO');
          advisors[kind] = lints.length;
          for (const l of lints) advisors.items.push({ category: kind, level: str(l.level, 'warn').toLowerCase(), title: str(l.title ?? l.name, 'Advisor finding') });
        } catch (e) { if (isExpired(e)) throw e; ctx.log(`${kind} advisors failed for ${p.name}: ${(e as Error).message}`); }
      }
      const rank = (lvl: string) => (lvl === 'error' ? 0 : lvl === 'warn' ? 1 : 2);
      advisors.items.sort((a, b) => rank(a.level) - rank(b.level)).splice(10);
    }

    // SELECT-only queries, each wrapped: paused projects reject them and keep nulls.
    const [dbSizeBytes, authUsers, storageBytes] = active
      ? await Promise.all([
        query(ctx, headers, p, SQL.dbSize, (r) => numOrNull(r.bytes)),
        query(ctx, headers, p, SQL.authUsers, (r) => numOrNull(r.n)),
        query(ctx, headers, p, SQL.storageBytes, (r) => numOrNull(r.bytes)),
      ])
      : [null, null, null];

    const org = orgById.get(p.organization_id);
    const project: SbProject = {
      ref: p.id, name: p.name, region: p.region, status: mapStatus(p.status, health),
      orgSlug: org?.slug ?? p.organization_id, orgName: org?.name ?? ctx.meta.orgSlug ?? p.organization_id, createdAt: p.created_at,
      dbSizeBytes, storageBytes, authUsers, advisors,
    };
    const before = prev.find((x) => x.ref === p.id);
    if (before && before.status !== project.status) {
      ctx.writers.event({
        fingerprint: `sb:status:${p.id}:${project.status}:${ctx.now.toISOString().slice(0, 10)}`,
        title: `${p.name} is now ${project.status}`, detail: `Was ${before.status}`, occurredAt: ctx.now.toISOString(),
        link: { kind: 'database', ref: p.id },
      });
    }
    part.success();
    return project;
  });

  const projects: SbProject[] = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') projects.push(r.value);
    else {
      part.fail(r.reason, projectsRaw[i].name);
      if (isExpired(r.reason)) throw r.reason;
      // keep the project visible with whatever the list endpoint told us
      const p = projectsRaw[i];
      const org = orgById.get(p.organization_id);
      projects.push({ ref: p.id, name: p.name, region: p.region, status: mapStatus(p.status, null), orgSlug: org?.slug ?? p.organization_id, orgName: org?.name ?? p.organization_id, createdAt: p.created_at, dbSizeBytes: null, storageBytes: null, authUsers: null, advisors: { security: 0, performance: 0, items: [] } });
    }
  });
  await ctx.writers.snapshot('projects', projects);
  if (part.errors.length) ctx.log(part.summary() ?? '');
}

/** Runs one read-only SELECT through the Management API. Never throws; returns null on any failure. */
async function query<T>(ctx: SyncContext, headers: Record<string, string>, p: SbProjectRaw, sql: string, pick: (row: Record<string, unknown>) => T | null): Promise<T | null> {
  if (!/^\s*select\b/i.test(sql)) throw new SyncError('refusing non-SELECT statement');
  try {
    const rows = await ctx.fetchJson<Record<string, unknown>[]>(`${API}/projects/${p.id}/database/query`, {
      method: 'POST', headers, body: JSON.stringify({ query: sql, read_only: true }), label: `query ${p.name}`, timeoutMs: 15000,
    });
    const row = Array.isArray(rows) ? rows[0] : null;
    return row ? pick(row) : null;
  } catch (e) {
    if (isExpired(e) && (e as { status?: number }).status === 401) throw e;
    ctx.log(`query failed for ${p.name}: ${(e as Error).message} (${num((e as { status?: number }).status)})`);
    return null;
  }
}
