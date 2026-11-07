// Cloudflare: zones, DNS counts, 7-day traffic, Workers, tunnels, Registrar expiry.
// Non-GET calls: POST https://api.cloudflare.com/client/v4/graphql (analytics query, read-only).
import type { CfTunnel, CfWorker, CfZone, TrafficDay } from '../types.ts';
import { lastNDays } from '../util.ts';
import {
  Collector, SyncError, addDay, hoursAgo, isExpired, mapLimit, num, str, strOrNull, type SyncContext, secretsFor,
} from './ctx.ts';

const API = 'https://api.cloudflare.com/client/v4';

interface CfEnvelope<T> { success: boolean; errors?: { code: number; message: string }[]; result: T; result_info?: { page: number; per_page: number; total_pages: number; total_count: number } }
interface CfAccount { id: string; name: string }
interface CfZoneRaw { id: string; name: string; status: string; paused: boolean; plan?: { name?: string }; account?: { id?: string; name?: string } }
interface CfScript { id: string; modified_on?: string }
interface CfRoute { pattern: string; script?: string | null }
interface CfTunnelRaw { id: string; name: string; status?: string; connections?: unknown[]; created_at?: string }
interface CfRegistrarDomain { name: string; expires_at?: string | null; auto_renew?: boolean | null }

export async function sync(ctx: SyncContext): Promise<void> {
  const { apiToken } = secretsFor(ctx, 'cloudflare');
  const headers = { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' };
  const get = <T>(path: string, label: string) => cfGet<T>(ctx, headers, path, label);

  // ---- accounts ----
  let accounts = await get<CfAccount[]>('/accounts?per_page=50', 'accounts');
  if (ctx.meta.accountIds?.length) {
    const allow = new Set(ctx.meta.accountIds);
    accounts = accounts.filter((a) => allow.has(a.id));
  }
  if (!accounts.length) throw new SyncError('Cloudflare token can see no accounts (check Account Resources on the token)');
  const accountName = (id: string) => accounts.find((a) => a.id === id)?.name ?? ctx.meta.accountNames?.[id] ?? id;
  await ctx.writers.meta({ accountNames: Object.fromEntries(accounts.map((a) => [a.id, a.name])) }).catch(() => {});

  // ---- zones (paginated per account) ----
  const zonesRaw: CfZoneRaw[] = [];
  const zonePart = new Collector('accounts');
  for (const acct of accounts) {
    try {
      for (let page = 1; page <= 10; page++) {
        const env = await cfGetEnvelope<CfZoneRaw[]>(ctx, headers, `/zones?per_page=50&page=${page}&account.id=${acct.id}`, 'zones');
        zonesRaw.push(...(env.result ?? []));
        if (!env.result_info || page >= env.result_info.total_pages) break;
      }
      zonePart.success();
    } catch (e) { zonePart.fail(e, acct.name); }
  }
  zonePart.assertSome();

  const days = lastNDays(7, ctx.tz, ctx.now);
  const since = days[0];
  const until = days[days.length - 1];

  // ---- per-zone DNS count (one tiny GET each) ----
  const dnsCounts = new Map<string, number>();
  await mapLimit(zonesRaw, 6, async (z) => {
    try {
      const env = await cfGetEnvelope<unknown[]>(ctx, headers, `/zones/${z.id}/dns_records?per_page=1`, `dns ${z.name}`);
      dnsCounts.set(z.id, env.result_info?.total_count ?? env.result?.length ?? 0);
    } catch (e) { if (isExpired(e)) throw e; ctx.log(`dns count failed for ${z.name}: ${(e as Error).message}`); }
  });

  // ---- traffic: GraphQL httpRequests1dGroups, 10 zones per query ----
  const traffic = new Map<string, Map<string, TrafficDay>>(); // zoneId -> day -> values
  const trafficPart = new Collector('analytics queries');
  const chunks = chunk(zonesRaw.map((z) => z.id), 10);
  await mapLimit(chunks, 3, async (ids) => {
    try {
      const q = `query($zones:[string!],$since:Date!,$until:Date!){viewer{zones(filter:{zoneTag_in:$zones}){zoneTag
        httpRequests1dGroups(limit:100,filter:{date_geq:$since,date_leq:$until}){dimensions{date}sum{requests bytes threats}uniq{uniques}}}}}`;
      const data = await graphql<{ viewer: { zones: { zoneTag: string; httpRequests1dGroups: { dimensions: { date: string }; sum: { requests: number; bytes: number; threats: number }; uniq: { uniques: number } }[] }[] } }>(
        ctx, headers, q, { zones: ids, since, until }, 'zone analytics',
      );
      for (const z of data.viewer.zones ?? []) {
        const m = new Map<string, TrafficDay>();
        for (const g of z.httpRequests1dGroups ?? []) {
          m.set(g.dimensions.date, { requests: num(g.sum?.requests), visitors: num(g.uniq?.uniques), threats: num(g.sum?.threats), bytes: num(g.sum?.bytes) });
        }
        traffic.set(z.zoneTag, m);
      }
      trafficPart.success();
    } catch (e) { trafficPart.fail(e); }
  });
  if (trafficPart.errors.length) ctx.log(trafficPart.summary() ?? '');

  // ---- registrar (optional permission) ----
  const registrar = new Map<string, CfRegistrarDomain>();
  let registrarOk = false;
  for (const acct of accounts) {
    try {
      const doms = await get<CfRegistrarDomain[]>(`/accounts/${acct.id}/registrar/domains`, 'registrar');
      for (const d of doms ?? []) registrar.set(d.name.toLowerCase(), d);
      registrarOk = true;
    } catch (e) {
      // Token without Registrar read: swallow and report registrar:false on every zone.
      ctx.log(`registrar unavailable for ${acct.name}: ${(e as Error).message}`);
    }
  }

  // ---- assemble zones ----
  const prevZones = ctx.previous<CfZone[]>('zones') ?? [];
  const zones: CfZone[] = zonesRaw.map((z) => {
    const t = traffic.get(z.id);
    const sum = { requests: 0, visitors: 0, threats: 0, bytes: 0 };
    for (const v of t?.values() ?? []) { sum.requests += v.requests; sum.visitors += v.visitors; sum.threats += v.threats; sum.bytes += v.bytes; }
    const reg = registrar.get(z.name.toLowerCase());
    const accountId = z.account?.id ?? '';
    return {
      id: z.id, name: z.name, status: z.status, paused: !!z.paused, plan: z.plan?.name ?? 'Free',
      accountId, accountName: z.account?.name ?? accountName(accountId),
      dnsRecords: dnsCounts.get(z.id) ?? 0,
      requests7d: sum.requests, visitors7d: sum.visitors, threats7d: sum.threats, bytes7d: sum.bytes,
      expiresAt: reg?.expires_at ?? null, autoRenew: reg ? (reg.auto_renew ?? null) : null, registrar: registrarOk && !!reg,
    };
  });
  await ctx.writers.snapshot('zones', zones);

  // per-day traffic for the account = sum over zones
  const perDay = new Map<string, TrafficDay>();
  for (const day of days) perDay.set(day, { requests: 0, visitors: 0, threats: 0, bytes: 0 });
  for (const m of traffic.values()) for (const [day, v] of m) addDay(perDay, day, v);
  for (const [day, v] of perDay) ctx.writers.metric('traffic', day, { ...v });

  // zone status changes
  for (const z of zones) {
    const prev = prevZones.find((p) => p.id === z.id);
    if (prev && prev.status !== z.status) {
      ctx.writers.event({
        fingerprint: `cf:zone:${z.id}:${z.status}:${ctx.now.toISOString().slice(0, 10)}`,
        title: `${z.name} is now ${z.status}`, detail: `Was ${prev.status}`, occurredAt: ctx.now.toISOString(),
        link: { kind: 'domain', ref: z.name },
      });
    }
  }

  // ---- workers ----
  const workersPart = new Collector('accounts');
  const workers: CfWorker[] = [];
  const routesByScript = new Map<string, string[]>();
  await mapLimit(zonesRaw, 6, async (z) => {
    try {
      const routes = await get<CfRoute[]>(`/zones/${z.id}/workers/routes`, `routes ${z.name}`);
      for (const r of routes ?? []) {
        if (!r.script) continue;
        const list = routesByScript.get(r.script) ?? [];
        list.push(r.pattern);
        routesByScript.set(r.script, list);
      }
    } catch (e) { if (isExpired(e)) throw e; ctx.log(`routes failed for ${z.name}: ${(e as Error).message}`); }
  });
  const dayAgo = hoursAgo(ctx.now, 24).toISOString();
  for (const acct of accounts) {
    try {
      const scripts = await get<CfScript[]>(`/accounts/${acct.id}/workers/scripts`, 'workers');
      const stats = new Map<string, { requests: number; errors: number }>();
      if (scripts.length) {
        try {
          const q = `query($acct:string!,$since:Time!,$until:Time!){viewer{accounts(filter:{accountTag:$acct}){
            workersInvocationsAdaptive(limit:500,filter:{datetime_geq:$since,datetime_leq:$until}){dimensions{scriptName}sum{requests errors}}}}}`;
          const data = await graphql<{ viewer: { accounts: { workersInvocationsAdaptive: { dimensions: { scriptName: string }; sum: { requests: number; errors: number } }[] }[] } }>(
            ctx, headers, q, { acct: acct.id, since: dayAgo, until: ctx.now.toISOString() }, 'workers analytics',
          );
          for (const row of data.viewer.accounts?.[0]?.workersInvocationsAdaptive ?? []) {
            const cur = stats.get(row.dimensions.scriptName) ?? { requests: 0, errors: 0 };
            cur.requests += num(row.sum?.requests); cur.errors += num(row.sum?.errors);
            stats.set(row.dimensions.scriptName, cur);
          }
        } catch (e) { ctx.log(`workers analytics failed for ${acct.name}: ${(e as Error).message}`); }
      }
      for (const s of scripts) {
        const st = stats.get(s.id) ?? { requests: 0, errors: 0 };
        workers.push({ name: s.id, accountId: acct.id, accountName: acct.name, routes: routesByScript.get(s.id) ?? [], requests24h: st.requests, errors24h: st.errors, modifiedOn: s.modified_on ?? null });
      }
      workersPart.success();
    } catch (e) { workersPart.fail(e, acct.name); }
  }
  if (workersPart.ok) await ctx.writers.snapshot('workers', workers);
  else if (workersPart.errors.length) ctx.log(workersPart.summary() ?? '');

  // ---- tunnels ----
  const prevTunnels = ctx.previous<CfTunnel[]>('tunnels') ?? [];
  const tunnels: CfTunnel[] = [];
  const tunnelPart = new Collector('accounts');
  for (const acct of accounts) {
    try {
      const list = await get<CfTunnelRaw[]>(`/accounts/${acct.id}/cfd_tunnel?is_deleted=false&per_page=100`, 'tunnels');
      for (const t of list ?? []) {
        tunnels.push({ id: t.id, name: t.name, accountId: acct.id, accountName: acct.name, status: str(t.status, 'inactive'), connections: Array.isArray(t.connections) ? t.connections.length : 0, createdAt: strOrNull(t.created_at) });
      }
      tunnelPart.success();
    } catch (e) { tunnelPart.fail(e, acct.name); }
  }
  if (tunnelPart.ok) {
    await ctx.writers.snapshot('tunnels', tunnels);
    for (const t of tunnels) {
      const prev = prevTunnels.find((p) => p.id === t.id);
      const wasUp = prev && prev.status === 'healthy';
      const isDown = t.status === 'down' || t.status === 'inactive' || t.status === 'degraded';
      if (wasUp && isDown) {
        ctx.writers.event({
          fingerprint: `cf:tunnel:${t.id}:${t.status}:${ctx.now.toISOString().slice(0, 13)}`,
          title: `Tunnel ${t.name} went ${t.status}`, detail: `${t.connections} active connections`, occurredAt: ctx.now.toISOString(),
          link: { kind: 'tunnel', ref: t.id },
        });
      }
    }
  } else if (tunnelPart.errors.length) ctx.log(tunnelPart.summary() ?? '');

  // Domain expiry alerts are evaluated from the zones snapshot in alerts.ts.
}

// ---------- helpers ----------
async function cfGetEnvelope<T>(ctx: SyncContext, headers: Record<string, string>, path: string, label: string): Promise<CfEnvelope<T>> {
  const env = await ctx.fetchJson<CfEnvelope<T>>(`${API}${path}`, { headers, label });
  if (!env || env.success === false) {
    const first = env?.errors?.[0];
    const msg = first ? `${first.message} (code ${first.code})` : 'unknown error';
    const expired = !!first && [10000, 9109, 6003, 6111, 7000].includes(first.code);
    throw new SyncError(`Cloudflare: ${label} failed: ${msg}`, { expired });
  }
  return env;
}
async function cfGet<T>(ctx: SyncContext, headers: Record<string, string>, path: string, label: string): Promise<T> {
  return (await cfGetEnvelope<T>(ctx, headers, path, label)).result;
}

/** Read-only analytics query. This is the only POST the Cloudflare module makes. */
async function graphql<T>(ctx: SyncContext, headers: Record<string, string>, query: string, variables: Record<string, unknown>, label: string): Promise<T> {
  const res = await ctx.fetchJson<{ data: T | null; errors?: { message: string }[] }>(`${API}/graphql`, {
    method: 'POST', headers, body: JSON.stringify({ query, variables }), label, timeoutMs: 25000,
  });
  if (!res?.data) {
    throw new SyncError(`Cloudflare: ${label} failed: ${res?.errors?.[0]?.message ?? 'empty response'}`);
  }
  return res.data;
}

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}
