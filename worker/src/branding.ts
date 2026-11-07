// App identity for the public edition: name, origin and owner come from env vars and the database,
// never from code. Works with zero config on a workers.dev URL.
import type { Context } from 'hono';
import type { Env } from './env.ts';
import { db, getUser, type UserRow } from './db.ts';

export interface Branding { appName: string; origin: string; host: string; ownerName: string; contact: string; allowedEmails: string[] }

/** Origin of this deployment: APP_ORIGIN when set, otherwise derived from the request. */
export function originOf(env: Env, req: Request): string {
  if (env.APP_ORIGIN) return env.APP_ORIGIN.replace(/\/+$/, '');
  const u = new URL(req.url);
  return `${u.protocol}//${u.host}`;
}
export function rpIdOf(env: Env, req: Request): string {
  return env.RP_ID || new URL(originOf(env, req)).hostname;
}
export function appName(env: Env): string {
  return (env.APP_NAME || 'HQ').trim().slice(0, 40) || 'HQ';
}
export function envEmails(env: Env): string[] {
  return (env.ALLOWED_GOOGLE_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}
/** Emails allowed to sign in: the env allow-list plus whoever owns the hq_user row. Empty = nobody has claimed it yet. */
export function allowedEmails(env: Env, user: UserRow | null): string[] {
  return [...new Set([...envEmails(env), ...((user?.emails ?? []).map((e) => e.toLowerCase()))])];
}

export async function branding(c: Context<any>): Promise<Branding> {
  let user: UserRow | null = null;
  try { user = await getUser(db(c.env)); } catch { /* database not configured yet */ }
  const origin = originOf(c.env, c.req.raw);
  const allowed = allowedEmails(c.env, user);
  return {
    appName: appName(c.env), origin, host: new URL(origin).host,
    ownerName: user?.name || c.env.OWNER_NAME || '',
    contact: user?.alert_to || allowed[0] || '',
    allowedEmails: allowed,
  };
}
