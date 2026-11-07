import type { Context, MiddlewareHandler } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { Env, Vars } from '../env.ts';
import { db, getUser, many, one, HttpError } from '../db.ts';
import { randomToken, sha256Hex } from '@shared/crypto.ts';
import type { SessionDTO } from '@shared/types.ts';

export const COOKIE = 'hq_session';
type Ctx = Context<{ Bindings: Env; Variables: Vars }>;

export interface SessionRow { id: string; token_hash: string; user_id: string; created_at: string; expires_at: string; last_seen_at: string; user_agent: string | null; ip: string | null; device_label: string | null; method: string }

export function deviceLabel(ua: string | null | undefined): string {
  if (!ua) return 'Unknown device';
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows PC';
  if (/Android/.test(ua)) return 'Android';
  if (/Linux/.test(ua)) return 'Linux';
  return 'Browser';
}

export async function createSession(c: Ctx, userId: string, method: 'google' | 'passkey'): Promise<string> {
  const d = db(c.env);
  const user = await getUser(d);
  const token = randomToken(32);
  const hash = await sha256Hex(token);
  const days = Math.max(1, user.session_days || 30);
  const expires = new Date(Date.now() + days * 86400000);
  const ua = c.req.header('user-agent') ?? null;
  await many(d.from('sessions').insert({
    token_hash: hash, user_id: userId, expires_at: expires.toISOString(), user_agent: ua,
    ip: c.req.header('cf-connecting-ip') ?? null, device_label: deviceLabel(ua), method,
  }).select('id'), 'create session');
  const secure = new URL(c.req.url).protocol === 'https:';
  setCookie(c, COOKIE, token, { path: '/', httpOnly: true, secure, sameSite: 'Lax', expires });
  return token;
}

export async function readSession(c: Ctx): Promise<SessionRow | null> {
  const token = getCookie(c, COOKIE);
  if (!token) return null;
  const hash = await sha256Hex(token);
  const d = db(c.env);
  const s = await one<SessionRow>(d.from('sessions').select('*').eq('token_hash', hash).single(), 'read session');
  if (!s) return null;
  if (new Date(s.expires_at).getTime() < Date.now()) {
    await d.from('sessions').delete().eq('id', s.id);
    return null;
  }
  // touch at most once a minute
  if (Date.now() - new Date(s.last_seen_at).getTime() > 60000) {
    c.executionCtx.waitUntil(Promise.resolve(d.from('sessions').update({ last_seen_at: new Date().toISOString() }).eq('id', s.id)).then(() => {}));
  }
  return s;
}

export const requireAuth: MiddlewareHandler<{ Bindings: Env; Variables: Vars }> = async (c, next) => {
  const s = await readSession(c);
  if (!s) throw new HttpError(401, 'unauthorized');
  c.set('userId', s.user_id);
  c.set('sessionId', s.id);
  await next();
};

export async function signOut(c: Ctx): Promise<void> {
  const token = getCookie(c, COOKIE);
  if (token) {
    const hash = await sha256Hex(token);
    await db(c.env).from('sessions').delete().eq('token_hash', hash);
  }
  deleteCookie(c, COOKIE, { path: '/' });
}

export async function signOutOthers(c: Ctx): Promise<number> {
  const d = db(c.env);
  const rows = await many<{ id: string }>(d.from('sessions').delete().neq('id', c.get('sessionId')).select('id'), 'sign out others');
  return rows.length;
}

export async function listSessions(c: Ctx): Promise<SessionDTO[]> {
  const d = db(c.env);
  const rows = await many<SessionRow>(d.from('sessions').select('*').order('last_seen_at', { ascending: false }), 'list sessions');
  const cur = c.get('sessionId');
  return rows.map((r) => ({ id: r.id, current: r.id === cur, method: r.method, createdAt: r.created_at, lastSeenAt: r.last_seen_at, expiresAt: r.expires_at, deviceLabel: r.device_label }));
}
