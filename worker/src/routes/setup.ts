// Settings → Setup keys: enter the app-level keys that are missing from .dev.vars, stored encrypted in app_config.
import { Hono } from 'hono';
import type { Env, Vars } from '../env.ts';
import { db, many, HttpError } from '../db.ts';
import { encryptJson } from '@shared/crypto.ts';
import { APP_KEYS, isInternal, type AppKey } from '@shared/appconfig.ts';
import { getAppConfig } from '../config.ts';
import { originOf } from '../branding.ts';

export const setupRoutes = new Hono<{ Bindings: Env; Variables: Vars }>();

export interface SetupItem { key: AppKey; label: string; hint: string; secret: boolean; source: 'settings' | 'env' | 'missing'; preview: string | null }

const mask = (v: string, secret: boolean) => (!v ? null : secret ? (v.length <= 8 ? '••••' : v.slice(0, 4) + '…' + v.slice(-3)) : v);

setupRoutes.get('/setup', async (c) => {
  const cfg = await getAppConfig(c.env);
  const values: Partial<Record<AppKey, string>> = { google_client_id: cfg.googleClientId, google_client_secret: cfg.googleClientSecret, resend_api_key: cfg.resendApiKey, alert_from: cfg.alertFrom };
  const items: SetupItem[] = APP_KEYS.filter((k) => !isInternal(k.key)).map((k) => ({ key: k.key, label: k.label, hint: k.hint, secret: k.secret, source: cfg.source[k.key] ?? 'missing', preview: mask(values[k.key] ?? '', k.secret) }));
  const fixed = {
    supabase: !!(c.env.SUPABASE_URL && c.env.SUPABASE_SERVICE_ROLE_KEY),
    masterKey: !!c.env.HQ_MASTER_KEY, syncSecret: !!c.env.HQ_SYNC_SECRET, ingestKey: !!c.env.HQ_INGEST_KEY,
  };
  return c.json({ items, fixed });
});

setupRoutes.patch('/setup', async (c) => {
  const body = (await c.req.json()) as Partial<Record<AppKey, string>>;
  const d = db(c.env);
  const saved: AppKey[] = [];
  for (const k of APP_KEYS) {
    if (isInternal(k.key)) continue;
    const v = body[k.key];
    if (v === undefined) continue;
    const val = String(v).trim();
    if (!val) throw new HttpError(400, `${k.label} cannot be empty (use Remove to fall back to the env var)`);
    const ok = k.check(val);
    if (ok !== true) throw new HttpError(400, `${k.label}: ${ok}`);
    const value_enc = await encryptJson(c.env.HQ_MASTER_KEY, val);
    await many(d.from('app_config').upsert({ key: k.key, value_enc, updated_at: new Date().toISOString() }, { onConflict: 'key' }).select('key'), 'save key');
    saved.push(k.key);
  }
  if (!saved.length) throw new HttpError(400, 'nothing to save');
  return c.json({ ok: true, saved });
});

setupRoutes.delete('/setup/:key', async (c) => {
  const key = c.req.param('key') as AppKey;
  if (!APP_KEYS.some((k) => k.key === key)) throw new HttpError(400, 'unknown key');
  await many(db(c.env).from('app_config').delete().eq('key', key).select('key'), 'remove key');
  return c.json({ ok: true });
});

/** Reveal the agent ingest key so it can be pasted into the Mac mini / Windows installer. */
setupRoutes.get('/setup/ingest-key', (c) => c.json({ ingestKey: c.env.HQ_INGEST_KEY || null, url: originOf(c.env, c.req.raw) }));
