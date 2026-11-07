// PayPal Reporting API: balances and the last 31 days of transactions.
// Non-GET calls: POST https://api-m.paypal.com/v1/oauth2/token (client-credentials token exchange; the only way
// to obtain a bearer token for the GET calls below).
import type { MoneyTxn, PaypalSummary, RevenueDay } from '../types.ts';
import { dayKey, lastNDays } from '../util.ts';
import { SyncError, addDay, daysAgo, extractErrorDetail, form, isExpired, num, str, type SyncContext, secretsFor } from './ctx.ts';

const API = 'https://api-m.paypal.com';

interface PpBalances { balances?: { currency: string; primary?: boolean; total_balance?: { currency_code: string; value: string }; available_balance?: { currency_code: string; value: string } }[]; account_id?: string }
interface PpTxn {
  transaction_info: {
    transaction_id: string; transaction_event_code?: string; transaction_initiation_date: string; transaction_updated_date?: string;
    transaction_status: string; transaction_amount: { currency_code: string; value: string }; transaction_subject?: string; transaction_note?: string;
  };
  payer_info?: { email_address?: string; payer_name?: { alternate_full_name?: string; given_name?: string; surname?: string } };
  cart_info?: { item_details?: { item_name?: string }[] };
}
interface PpTxnPage { transaction_details?: PpTxn[]; total_pages?: number; page?: number }

/** PayPal T-codes: T00xx are payments received, T11xx refunds, T03/T04/T06/T07 bank/card funding movements. */
export function txnType(code: string | undefined): string {
  const c = code ?? '';
  if (c.startsWith('T00')) return 'payment';
  if (c.startsWith('T11')) return 'refund';
  if (c.startsWith('T01')) return 'fee';
  if (c.startsWith('T03') || c.startsWith('T04') || c.startsWith('T06') || c.startsWith('T07') || c.startsWith('T17')) return 'transfer';
  if (c.startsWith('T10') || c.startsWith('T12') || c.startsWith('T19')) return 'adjustment';
  return 'other';
}
const STATUS: Record<string, string> = { S: 'completed', P: 'pending', D: 'denied', V: 'reversed', F: 'failed' };

export async function sync(ctx: SyncContext): Promise<void> {
  const { clientId, clientSecret } = secretsFor(ctx, 'paypal');

  // OAuth2 client credentials (POST). invalid_client => expired.
  const tokenRes = await ctx.fetchRaw(`${API}/v1/oauth2/token`, {
    method: 'POST', label: 'token',
    headers: { Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({ grant_type: 'client_credentials' }),
  });
  if (!tokenRes.ok) {
    const detail = extractErrorDetail(await tokenRes.text().catch(() => ''));
    throw new SyncError(`PayPal rejected the client credentials (${tokenRes.status})${detail ? `: ${detail}` : ''}`, { status: tokenRes.status, expired: tokenRes.status === 401 || tokenRes.status === 403 || tokenRes.status === 400 });
  }
  const { access_token } = (await tokenRes.json()) as { access_token: string };
  const headers = { Authorization: `Bearer ${access_token}` };

  // ---- balances ----
  let balance = 0;
  let currency = 'USD';
  try {
    const b = await ctx.fetchJson<PpBalances>(`${API}/v1/reporting/balances`, { headers, label: 'balances' });
    const primary = b.balances?.find((x) => x.primary) ?? b.balances?.[0];
    if (primary) {
      currency = primary.total_balance?.currency_code ?? primary.currency ?? currency;
      balance = Math.round(num(primary.total_balance?.value ?? primary.available_balance?.value) * 100);
    }
  } catch (e) {
    if (isExpired(e)) throw permissionError(e, 'Balances');
    ctx.log(`balances failed: ${(e as Error).message}`);
  }

  // ---- transactions: the API caps one window at 31 days ----
  const end = ctx.now;
  const start = daysAgo(end, 31);
  const all: PpTxn[] = [];
  for (let page = 1; page <= 10; page++) {
    const qs = `start_date=${encodeURIComponent(start.toISOString())}&end_date=${encodeURIComponent(end.toISOString())}&fields=all&page_size=100&page=${page}`;
    let res: PpTxnPage;
    try {
      res = await ctx.fetchJson<PpTxnPage>(`${API}/v1/reporting/transactions?${qs}`, { headers, label: 'transactions', timeoutMs: 25000 });
    } catch (e) {
      throw isExpired(e) ? permissionError(e, 'Transaction Search') : e;
    }
    all.push(...(res.transaction_details ?? []));
    if (!res.total_pages || page >= res.total_pages) break;
  }

  const since30 = daysAgo(end, 30);
  const perDay = new Map<string, RevenueDay>();
  for (const day of lastNDays(30, ctx.tz, ctx.now)) perDay.set(day, { amount: 0, count: 0 });
  let revenue30d = 0, txnCount30d = 0;
  const recent: MoneyTxn[] = [];
  const sorted = all.sort((a, b) => b.transaction_info.transaction_initiation_date.localeCompare(a.transaction_info.transaction_initiation_date));
  for (const t of sorted) {
    const info = t.transaction_info;
    const minor = Math.round(num(info.transaction_amount?.value) * 100);
    const when = new Date(info.transaction_initiation_date);
    const type = txnType(info.transaction_event_code);
    if (type === 'payment' && info.transaction_status === 'S' && minor > 0 && when >= since30) {
      revenue30d += minor; txnCount30d++;
      addDay(perDay, dayKey(when, ctx.tz), { amount: minor, count: 1 });
    }
    if (recent.length < 20 && type !== 'fee') {
      const payer = t.payer_info?.payer_name?.alternate_full_name
        || [t.payer_info?.payer_name?.given_name, t.payer_info?.payer_name?.surname].filter(Boolean).join(' ')
        || t.payer_info?.email_address;
      const item = t.cart_info?.item_details?.[0]?.item_name;
      recent.push({
        id: info.transaction_id, amount: minor, currency: info.transaction_amount?.currency_code ?? currency, type,
        description: str(info.transaction_subject ?? item ?? info.transaction_note ?? payer, type), createdAt: when.toISOString(), status: STATUS[info.transaction_status] ?? info.transaction_status,
      });
    }
  }
  for (const [day, v] of perDay) ctx.writers.metric('revenue', day, { ...v });

  const summary: PaypalSummary = { accountName: ctx.account.label, currency, revenue30d, txnCount30d, balance, recent };
  await ctx.writers.snapshot('paypal', summary);
}

function permissionError(e: unknown, feature: string): SyncError {
  const msg = e instanceof Error ? e.message : String(e);
  if (/NOT_AUTHORIZED|PERMISSION_DENIED|403/.test(msg)) {
    return new SyncError(`PayPal: ${feature} not enabled on this app (enable it under Apps & Credentials, then wait up to 9 hours)`, { status: 403, expired: false });
  }
  return e instanceof SyncError ? e : new SyncError(msg);
}
