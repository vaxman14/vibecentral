// Effective app keys for the Worker: Settings → Setup keys (DB) win over env vars.
import type { Env } from './env.ts';
import { db } from './db.ts';
import { APP_KEYS, isInternal, loadAppConfig, resolveKey, type AppKey } from '@shared/appconfig.ts';

import { encryptJson } from '@shared/crypto.ts';

/** Keep the dashboard URL and name in app_config so the sync function can link alert emails back here. */
export async function mirrorIdentity(env: Env, origin: string, name: string): Promise<void> {
  const d = db(env);
  const cfg = await loadAppConfig(d as any, env.HQ_MASTER_KEY);
  const rows: { key: string; value_enc: string; updated_at: string }[] = [];
  if (cfg.app_origin !== origin) rows.push({ key: 'app_origin', value_enc: await encryptJson(env.HQ_MASTER_KEY, origin), updated_at: new Date().toISOString() });
  if (cfg.app_name !== name) rows.push({ key: 'app_name', value_enc: await encryptJson(env.HQ_MASTER_KEY, name), updated_at: new Date().toISOString() });
  if (rows.length) await d.from('app_config').upsert(rows, { onConflict: 'key' });
}

export interface AppConfig { googleClientId: string; googleClientSecret: string; resendApiKey: string; alertFrom: string; source: Partial<Record<AppKey, 'settings' | 'env' | 'missing'>> }

export async function getAppConfig(env: Env): Promise<AppConfig> {
  let cfg: Partial<Record<AppKey, string>> = {};
  try { cfg = await loadAppConfig(db(env) as any, env.HQ_MASTER_KEY); } catch { /* db not configured yet */ }
  const e = env as unknown as Record<string, string | undefined>;
  const source: AppConfig['source'] = {};
  for (const k of APP_KEYS) if (!isInternal(k.key)) source[k.key] = cfg[k.key] ? 'settings' : e[k.env] ? 'env' : 'missing';
  return {
    googleClientId: resolveKey(cfg, e, 'google_client_id'),
    googleClientSecret: resolveKey(cfg, e, 'google_client_secret'),
    resendApiKey: resolveKey(cfg, e, 'resend_api_key'),
    alertFrom: resolveKey(cfg, e, 'alert_from'),
    source,
  };
}
