import type { Db } from '../db.ts';
import { many } from '../db.ts';
import { loadAccounts } from '../routes/me.ts';
import { PROVIDERS, type AsApp, type CfTunnel, type CfWorker, type CfZone, type GhRepo, type GpApp, type NlSite, type SbProject } from '@shared/types.ts';

export interface Linkable { kind: string; accountId: string | null; accountLabel: string | null; ref: string; label: string }
export interface SnapRow<T = any> { account_id: string; kind: string; data: T; fetched_at: string }

export async function loadSnapshots<T = any>(d: Db, kind?: string, provider?: string): Promise<SnapRow<T>[]> {
  let q = d.from('snapshots').select('account_id,kind,data,fetched_at');
  if (kind) q = q.eq('kind', kind);
  const rows = await many<SnapRow<T>>(q, 'snapshots');
  if (!provider) return rows;
  const accounts = await loadAccounts(d);
  const ids = new Set(accounts.filter((a) => a.provider === provider).map((a) => a.id));
  return rows.filter((r) => ids.has(r.account_id));
}

export async function linkables(d: Db): Promise<Linkable[]> {
  const [accounts, snaps] = await Promise.all([loadAccounts(d), loadSnapshots(d)]);
  const acc = new Map(accounts.map((a) => [a.id, a]));
  const lbl = (id: string) => { const a = acc.get(id); return a ? `${PROVIDERS[a.provider as keyof typeof PROVIDERS]?.name} · ${a.label}` : null; };
  const out: Linkable[] = [];
  for (const a of accounts) out.push({ kind: 'account', accountId: a.id, accountLabel: lbl(a.id), ref: a.id, label: lbl(a.id)! });
  for (const s of snaps) {
    const al = lbl(s.account_id);
    const prov = acc.get(s.account_id)?.provider;
    if (prov === 'cloudflare' && s.kind === 'zones') for (const z of s.data as CfZone[]) out.push({ kind: 'domain', accountId: s.account_id, accountLabel: al, ref: z.name, label: z.name });
    if (prov === 'cloudflare' && s.kind === 'workers') for (const w of s.data as CfWorker[]) out.push({ kind: 'worker', accountId: s.account_id, accountLabel: al, ref: w.name, label: w.name });
    if (prov === 'cloudflare' && s.kind === 'tunnels') for (const t of s.data as CfTunnel[]) out.push({ kind: 'tunnel', accountId: s.account_id, accountLabel: al, ref: t.id, label: t.name });
    if (prov === 'netlify' && s.kind === 'sites') for (const x of s.data as NlSite[]) out.push({ kind: 'site', accountId: s.account_id, accountLabel: al, ref: x.id, label: x.name });
    if (prov === 'supabase' && s.kind === 'projects') for (const p of s.data as SbProject[]) out.push({ kind: 'database', accountId: s.account_id, accountLabel: al, ref: p.ref, label: p.name });
    if (prov === 'github' && s.kind === 'repos') for (const r of s.data as GhRepo[]) out.push({ kind: 'repo', accountId: s.account_id, accountLabel: al, ref: r.fullName, label: r.fullName });
    if (prov === 'appstore' && s.kind === 'apps') for (const ap of s.data as AsApp[]) out.push({ kind: 'app', accountId: s.account_id, accountLabel: al, ref: ap.bundleId, label: `${ap.name} (App Store)` });
    if (prov === 'googleplay' && s.kind === 'apps') for (const ap of s.data as GpApp[]) out.push({ kind: 'app', accountId: s.account_id, accountLabel: al, ref: ap.packageName, label: `${ap.name ?? ap.packageName} (Google Play)` });
  }
  return out.sort((a, b) => a.kind.localeCompare(b.kind) || a.label.localeCompare(b.label));
}
