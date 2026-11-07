// Keys that can live either in env vars or in the app_config table (entered from Settings → Setup keys).
// Shared by the Worker and the sync function. A DB row wins over the env var.
import { decryptJson } from './crypto.ts';

export interface AppKeyMeta { key: string; env: string; label: string; secret: boolean; hint: string; check: (v: string) => true | string; internal?: boolean }
export const APP_KEYS = [
  { key: 'google_client_id', env: 'GOOGLE_CLIENT_ID', label: 'Google OAuth client ID', secret: false, hint: 'Google Cloud → Google Auth Platform → Clients → Web application. Ends with .apps.googleusercontent.com', check: (v: string) => /\.apps\.googleusercontent\.com$/.test(v) || 'should end with .apps.googleusercontent.com' },
  { key: 'google_client_secret', env: 'GOOGLE_CLIENT_SECRET', label: 'Google OAuth client secret', secret: true, hint: 'Same client → Client secret (GOCSPX-…)', check: (v: string) => /^GOCSPX-/.test(v) || 'should start with GOCSPX-' },
  { key: 'resend_api_key', env: 'RESEND_API_KEY', label: 'Resend API key', secret: true, hint: 'resend.com → API Keys → Sending access (re_…)', check: (v: string) => /^re_/.test(v) || 'should start with re_' },
  { key: 'alert_from', env: 'ALERT_FROM', label: 'Alert sender address', secret: false, hint: 'From address on a domain verified in Resend, e.g. Vibe Central <vibe@yourdomain.com>', check: (v: string) => /@/.test(v) || 'needs an email address' },
  // mirrored by the Worker so the sync function can build links and subjects; not shown in Settings
  { key: 'app_origin', env: 'APP_ORIGIN', label: 'Dashboard URL', secret: false, hint: '', check: (v: string) => /^https?:\/\//.test(v) || 'must be a URL', internal: true },
  { key: 'app_name', env: 'APP_NAME', label: 'App name', secret: false, hint: '', check: (_v: string) => true, internal: true },
] as const satisfies readonly AppKeyMeta[];
export type AppKey = (typeof APP_KEYS)[number]['key'];
/** Keys mirrored by the Worker for the sync function; never shown or edited in Settings. */
export const INTERNAL_KEYS: ReadonlySet<string> = new Set(['app_origin', 'app_name']);
export const isInternal = (key: string): boolean => INTERNAL_KEYS.has(key);

type DbLike = { from: (t: string) => { select: (c: string) => PromiseLike<{ data: { key: string; value_enc: string }[] | null; error: { message: string } | null }> } };

/** Decrypted DB values only (no env). Missing table or rows → {}. */
export async function loadAppConfig(db: DbLike, masterKey: string): Promise<Partial<Record<AppKey, string>>> {
  const out: Partial<Record<AppKey, string>> = {};
  try {
    const { data, error } = await db.from('app_config').select('key,value_enc');
    if (error || !data) return out;
    for (const row of data) {
      try { out[row.key as AppKey] = await decryptJson<string>(masterKey, row.value_enc); } catch { /* wrong key or corrupt row: ignore */ }
    }
  } catch { /* table missing: ignore */ }
  return out;
}

/** Effective value: DB row, else env var, else ''. */
export function resolveKey(cfg: Partial<Record<AppKey, string>>, env: Record<string, string | undefined>, key: AppKey): string {
  const meta = APP_KEYS.find((k) => k.key === key)!;
  return (cfg[key] || env[meta.env] || '').trim();
}
