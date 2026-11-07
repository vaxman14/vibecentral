// Stripe with a read-only restricted key. GET only.
import type { MoneyTxn, RevenueDay, StripeSummary } from '../types.ts';
import { dayKey, lastNDays } from '../util.ts';
import { addDay, daysAgo, isExpired, num, str, type SyncContext, secretsFor } from './ctx.ts';

const API = 'https://api.stripe.com/v1';

interface StList<T> { data: T[]; has_more: boolean }
interface StAccount { id: string; business_profile?: { name?: string | null } | null; settings?: { dashboard?: { display_name?: string | null } | null } | null; default_currency?: string }
interface StBalance { available?: { amount: number; currency: string }[]; pending?: { amount: number; currency: string }[] }
interface StBalanceTxn { id: string; amount: number; net: number; currency: string; type: string; description?: string | null; created: number; status: string; source?: string | null; reporting_category?: string }
interface StPrice { id: string; unit_amount?: number | null; currency: string; recurring?: { interval: string; interval_count: number } | null; product?: string | { id: string; name?: string } | null; nickname?: string | null }
interface StSubscription { id: string; status: string; customer: string | { id: string; name?: string | null; email?: string | null; deleted?: boolean }; items: { data: { quantity?: number; price: StPrice }[] } }
interface StPayout { id: string; amount: number; currency: string; arrival_date: number; status: string }

const REVENUE_TYPES = new Set(['charge', 'payment']);
const REFUND_TYPES = new Set(['refund', 'payment_refund']);
const RECENT_TYPES = new Set(['charge', 'payment', 'refund', 'payment_refund', 'payout', 'adjustment']);

export function monthlyAmount(unitAmount: number, quantity: number, interval: string | undefined, count: number): number {
  const per = unitAmount * quantity;
  const c = Math.max(1, count || 1);
  switch (interval) {
    case 'month': return per / c;
    case 'year': return per / (12 * c);
    case 'week': return (per * 52) / (12 * c);
    case 'day': return (per * 365) / (12 * c);
    default: return per;
  }
}

export async function sync(ctx: SyncContext): Promise<void> {
  const { restrictedKey } = secretsFor(ctx, 'stripe');
  const headers = { Authorization: `Bearer ${restrictedKey}`, 'Stripe-Version': '2024-06-20' };
  const get = <T>(path: string, label: string) => ctx.fetchJson<T>(`${API}${path}`, { headers, label });

  const account = await get<StAccount>('/account', 'account');
  const accountName = account.settings?.dashboard?.display_name ?? account.business_profile?.name ?? ctx.account.label;
  const currency = (account.default_currency ?? 'usd').toLowerCase();

  // ---- balance ----
  let balanceAvailable = 0, balancePending = 0;
  try {
    const bal = await get<StBalance>('/balance', 'balance');
    balanceAvailable = sumCurrency(bal.available, currency);
    balancePending = sumCurrency(bal.pending, currency);
  } catch (e) { if (isExpired(e)) throw e; ctx.log(`balance failed: ${(e as Error).message}`); }

  // ---- balance transactions, last 60 days, up to 300 ----
  const since60 = Math.floor(daysAgo(ctx.now, 60).getTime() / 1000);
  const txns: StBalanceTxn[] = [];
  let startingAfter: string | null = null;
  for (let page = 0; page < 3; page++) {
    const qs = `created[gte]=${since60}&limit=100${startingAfter ? `&starting_after=${startingAfter}` : ''}`;
    const res: StList<StBalanceTxn> = await get<StList<StBalanceTxn>>(`/balance_transactions?${qs}`, 'balance transactions');
    txns.push(...res.data);
    if (!res.has_more || !res.data.length) break;
    startingAfter = res.data[res.data.length - 1].id;
  }

  const since30 = daysAgo(ctx.now, 30).getTime() / 1000;
  let revenue30d = 0, revenuePrev30d = 0;
  const perDay = new Map<string, RevenueDay>();
  for (const day of lastNDays(30, ctx.tz, ctx.now)) perDay.set(day, { amount: 0, count: 0 });
  for (const t of txns) {
    const isRev = REVENUE_TYPES.has(t.type), isRefund = REFUND_TYPES.has(t.type);
    if (!isRev && !isRefund) continue;
    const amt = num(t.amount); // refunds are negative, so adding nets them out
    if (t.created >= since30) {
      revenue30d += amt;
      addDay(perDay, dayKey(new Date(t.created * 1000), ctx.tz), { amount: amt, count: isRev ? 1 : 0 });
    } else revenuePrev30d += amt;
  }
  for (const [day, v] of perDay) ctx.writers.metric('revenue', day, { ...v });

  const recent: MoneyTxn[] = txns.filter((t) => RECENT_TYPES.has(t.type)).slice(0, 20).map((t) => ({
    id: t.id, amount: num(t.amount), currency: t.currency, type: t.type, description: str(t.description ?? t.reporting_category, t.type),
    createdAt: new Date(t.created * 1000).toISOString(), status: t.status,
  }));

  // ---- subscriptions (+ MRR) ----
  let subs: StSubscription[] = [];
  let expanded = true;
  try {
    const qs = 'status=active&limit=100&expand[]=data.items.data.price.product&expand[]=data.customer';
    subs = (await get<StList<StSubscription>>(`/subscriptions?${qs}`, 'subscriptions')).data;
  } catch (e) {
    if (isExpired(e)) throw e;
    // older API versions reject the deep expand: retry flat and resolve product names separately
    expanded = false;
    try { subs = (await get<StList<StSubscription>>('/subscriptions?status=active&limit=100&expand[]=data.customer', 'subscriptions')).data; }
    catch (e2) { if (isExpired(e2)) throw e2; ctx.log(`subscriptions failed: ${(e2 as Error).message}`); }
  }
  const productNames = new Map<string, string>();
  if (!expanded) {
    const ids = new Set<string>();
    for (const s of subs) for (const it of s.items.data) if (typeof it.price.product === 'string') ids.add(it.price.product);
    for (const id of [...ids].slice(0, 25)) {
      try { productNames.set(id, (await get<{ name?: string }>(`/products/${id}`, 'product')).name ?? id); } catch { /* keep id */ }
    }
  }
  let mrr = 0;
  const subscriptions: StripeSummary['subscriptions'] = subs.map((s) => {
    let amount = 0;
    let interval = 'month';
    const names: string[] = [];
    for (const it of s.items.data) {
      const p = it.price;
      const qty = num(it.quantity, 1);
      amount += num(p.unit_amount) * qty;
      interval = p.recurring?.interval ?? interval;
      mrr += monthlyAmount(num(p.unit_amount), qty, p.recurring?.interval, num(p.recurring?.interval_count, 1));
      const prod = p.product;
      names.push(typeof prod === 'object' && prod ? (prod.name ?? prod.id) : typeof prod === 'string' ? (productNames.get(prod) ?? p.nickname ?? prod) : (p.nickname ?? p.id));
    }
    const c = s.customer;
    const customer = typeof c === 'string' ? c : (c.name ?? c.email ?? c.id);
    return { id: s.id, customer, product: [...new Set(names)].join(', '), amount, interval, status: s.status };
  });
  mrr = Math.round(mrr);

  // ---- payouts ----
  let nextPayout: StripeSummary['nextPayout'] = null;
  try {
    const payouts = (await get<StList<StPayout>>('/payouts?limit=5', 'payouts')).data
      .filter((p) => p.status === 'pending' || p.status === 'in_transit')
      .sort((a, b) => a.arrival_date - b.arrival_date);
    if (payouts[0]) nextPayout = { amount: payouts[0].amount, arrivalDate: new Date(payouts[0].arrival_date * 1000).toISOString(), status: payouts[0].status };
  } catch (e) { if (isExpired(e)) throw e; ctx.log(`payouts failed: ${(e as Error).message}`); }

  const summary: StripeSummary = {
    accountName, currency, revenue30d: Math.round(revenue30d), revenuePrev30d: Math.round(revenuePrev30d),
    activeSubscriptions: subs.length, mrr, balanceAvailable, balancePending, nextPayout, subscriptions, recent,
  };

  // new_revenue candidates: charges that were not in the previous snapshot's recent list
  const prev = ctx.previous<StripeSummary>('stripe');
  if (prev) {
    const known = new Set(prev.recent.map((r) => r.id));
    const cutoff = daysAgo(ctx.now, 2);
    for (const t of recent) {
      if (!REVENUE_TYPES.has(t.type) || known.has(t.id) || new Date(t.createdAt) < cutoff) continue;
      ctx.writers.alert({
        kind: 'new_revenue', fingerprint: `new_revenue:${t.id}`,
        title: `${fmt(t.amount, t.currency)} from ${accountName}`,
        body: `${t.description} on ${t.createdAt.slice(0, 10)} (Stripe · ${accountName}).`,
        link: { kind: 'account', ref: ctx.account.id },
      });
    }
  }
  await ctx.writers.snapshot('stripe', summary);
}

function sumCurrency(list: { amount: number; currency: string }[] | undefined, currency: string): number {
  if (!list?.length) return 0;
  const match = list.filter((b) => b.currency.toLowerCase() === currency);
  return (match.length ? match : list).reduce((a, b) => a + num(b.amount), 0);
}
function fmt(minor: number, currency: string): string {
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase() }).format(minor / 100); }
  catch { return `${(minor / 100).toFixed(2)} ${currency.toUpperCase()}`; }
}
