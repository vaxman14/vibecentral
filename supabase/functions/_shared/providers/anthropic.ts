// Anthropic Admin API: org, workspaces, cost report and usage report. GET only.
import type { AnthropicSummary, SpendDay } from '../types.ts';
import { dayKey, lastNDays } from '../util.ts';
import { addDay, daysAgo, isExpired, num, str, type SyncContext, secretsFor, utcMidnight } from './ctx.ts';

const API = 'https://api.anthropic.com/v1/organizations';

interface Page<T> { data: T[]; has_more?: boolean; next_page?: string | null }
interface Bucket<R> { starting_at: string; ending_at: string; results: R[] }
interface CostRow { currency?: string; amount: string | number; workspace_id?: string | null; description?: string | null; model?: string | null; cost_type?: string; token_type?: string }
interface UsageRow {
  uncached_input_tokens?: number; cache_read_input_tokens?: number; output_tokens?: number;
  cache_creation?: { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number } | null;
  model?: string | null; workspace_id?: string | null;
}
interface Workspace { id: string; name: string; archived_at?: string | null }

/** Cost report amounts are decimal strings in the lowest currency unit (cents), e.g. "123.78912". */
export function toCents(amount: string | number): number {
  const n = typeof amount === 'number' ? amount : parseFloat(amount);
  return Number.isFinite(n) ? n : 0;
}

export async function sync(ctx: SyncContext): Promise<void> {
  const { adminKey } = secretsFor(ctx, 'anthropic');
  const headers = { 'x-api-key': adminKey, 'anthropic-version': '2023-06-01' };
  const get = <T>(url: string, label: string) => ctx.fetchJson<T>(url, { headers, label, timeoutMs: 25000 });

  const org = await get<{ id: string; name?: string }>(`${API}/me`, 'organization');
  const orgName = org.name ?? ctx.meta.orgSlug ?? ctx.account.label;

  const wsNames = new Map<string, string>();
  try {
    const ws = await get<Page<Workspace>>(`${API}/workspaces?limit=100`, 'workspaces');
    for (const w of ws.data ?? []) wsNames.set(w.id, w.name);
  } catch (e) { if (isExpired(e)) throw e; ctx.log(`workspaces failed: ${(e as Error).message}`); }
  const wsName = (id: string | null | undefined) => (id ? (wsNames.get(id) ?? id) : 'Default');

  const start30 = utcMidnight(daysAgo(ctx.now, 30));
  const monthStart = new Date(Date.UTC(ctx.now.getUTCFullYear(), ctx.now.getUTCMonth(), 1));
  const monthKey = monthStart.toISOString();

  // ---- cost report, 30 days of 1d buckets (covers the month-to-date slice too) ----
  const costBuckets = await paginate<Bucket<CostRow>>(get, `${API}/cost_report?starting_at=${enc(start30)}&ending_at=${enc(ctx.now)}&group_by[]=workspace_id&group_by[]=description&bucket_width=1d&limit=31`, 'cost report');
  const perDay = new Map<string, SpendDay>();
  for (const day of lastNDays(30, ctx.tz, ctx.now)) perDay.set(day, { costCents: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  let monthCost = 0;
  const wsCost = new Map<string, number>();
  const modelCost = new Map<string, number>();
  for (const b of costBuckets) {
    const inMonth = b.starting_at >= monthKey;
    const day = dayKey(b.starting_at, 'UTC');
    for (const r of b.results ?? []) {
      const cents = toCents(r.amount);
      addDay(perDay, day, { costCents: cents, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
      if (!inMonth) continue;
      monthCost += cents;
      const ws = r.workspace_id ?? '';
      wsCost.set(ws, (wsCost.get(ws) ?? 0) + cents);
      const model = r.model ?? modelFromDescription(r.description);
      if (model) modelCost.set(model, (modelCost.get(model) ?? 0) + cents);
    }
  }

  // ---- usage report, same window, by model + workspace ----
  const usageBuckets = await paginate<Bucket<UsageRow>>(get, `${API}/usage_report/messages?starting_at=${enc(start30)}&ending_at=${enc(ctx.now)}&bucket_width=1d&group_by[]=model&group_by[]=workspace_id&limit=31`, 'usage report');
  const monthTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const wsUsage = new Map<string, { input: number; output: number; models: Set<string> }>();
  const modelUsage = new Map<string, { input: number; output: number; cacheRead: number; cacheWrite: number }>();
  for (const b of usageBuckets) {
    const inMonth = b.starting_at >= monthKey;
    const day = dayKey(b.starting_at, 'UTC');
    for (const r of b.results ?? []) {
      const input = num(r.uncached_input_tokens), output = num(r.output_tokens), cacheRead = num(r.cache_read_input_tokens);
      const cacheWrite = num(r.cache_creation?.ephemeral_1h_input_tokens) + num(r.cache_creation?.ephemeral_5m_input_tokens);
      addDay(perDay, day, { costCents: 0, input, output, cacheRead, cacheWrite });
      if (!inMonth) continue;
      monthTokens.input += input; monthTokens.output += output; monthTokens.cacheRead += cacheRead; monthTokens.cacheWrite += cacheWrite;
      const ws = r.workspace_id ?? '';
      const w = wsUsage.get(ws) ?? { input: 0, output: 0, models: new Set<string>() };
      w.input += input; w.output += output; if (r.model) w.models.add(r.model);
      wsUsage.set(ws, w);
      const model = str(r.model, 'unknown');
      const m = modelUsage.get(model) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      m.input += input; m.output += output; m.cacheRead += cacheRead; m.cacheWrite += cacheWrite;
      modelUsage.set(model, m);
    }
  }

  for (const [day, v] of perDay) ctx.writers.metric('spend', day, { ...v, costCents: Math.round(v.costCents) });

  const wsIds = new Set<string>([...wsCost.keys(), ...wsUsage.keys()]);
  const workspaces: AnthropicSummary['workspaces'] = [...wsIds].map((id) => {
    const u = wsUsage.get(id);
    return { id: id || null, name: wsName(id || null), costCents: Math.round(wsCost.get(id) ?? 0), models: [...(u?.models ?? [])].sort(), input: u?.input ?? 0, output: u?.output ?? 0 };
  }).sort((a, b) => b.costCents - a.costCents);
  const modelIds = new Set<string>([...modelCost.keys(), ...modelUsage.keys()]);
  const models: AnthropicSummary['models'] = [...modelIds].map((model) => {
    const u = modelUsage.get(model) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    return { model, costCents: Math.round(modelCost.get(model) ?? 0), ...u };
  }).sort((a, b) => b.costCents - a.costCents);

  const summary: AnthropicSummary = { orgName, monthCostCents: Math.round(monthCost), monthTokens, workspaces, models };
  await ctx.writers.snapshot('anthropic', summary);
}

async function paginate<T>(get: <R>(url: string, label: string) => Promise<R>, url: string, label: string): Promise<T[]> {
  const out: T[] = [];
  let page: string | null | undefined;
  for (let i = 0; i < 10; i++) {
    const res = await get<Page<T>>(page ? `${url}&page=${encodeURIComponent(page)}` : url, label);
    out.push(...(res?.data ?? []));
    page = res?.has_more ? res.next_page : null;
    if (!page) break;
  }
  return out;
}

const enc = (d: Date) => encodeURIComponent(d.toISOString());

/** Cost descriptions look like "Claude Sonnet 4.5 Usage - Input Tokens"; pull the model part. */
function modelFromDescription(desc: string | null | undefined): string | null {
  if (!desc) return null;
  const m = desc.match(/^(.*?)\s+(?:Usage|Input|Output|Cache|Tokens|-)/i);
  return (m?.[1] ?? desc.split(' - ')[0]).trim() || null;
}
