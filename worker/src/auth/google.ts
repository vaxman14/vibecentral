// Google OAuth: sign-in (openid email profile, allowlisted addresses only) and data connect (Gmail + Calendar read-only).
import { Hono } from 'hono';
import type { Env, Vars } from '../env.ts';
import { db, getUser, many, one, HttpError } from '../db.ts';
import { createSession, requireAuth } from './session.ts';
import { encryptJson, randomToken } from '@shared/crypto.ts';
import type { AccountSecrets } from '@shared/types.ts';
import { getAppConfig } from '../config.ts';
import { allowedEmails, originOf } from '../branding.ts';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO = 'https://openidconnect.googleapis.com/v1/userinfo';
const DATA_SCOPES = ['openid', 'email', 'profile', 'https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/calendar.readonly'];

export const googleAuth = new Hono<{ Bindings: Env; Variables: Vars }>();
export const googleConnect = new Hono<{ Bindings: Env; Variables: Vars }>();


async function startFlow(c: any, kind: 'signin' | 'connect' | 'reconnect', redirectPath: string, scopes: string[], extra: Record<string, string>, data: Record<string, unknown>, accountId: string | null) {
  const cfg = await getAppConfig(c.env);
  if (!cfg.googleClientId) throw new HttpError(500, 'Google OAuth is not configured. Add the client ID under Settings → Setup keys.');
  const state = randomToken(24);
  await many(db(c.env).from('oauth_states').insert({
    state, kind, provider: 'google', account_id: accountId, data, expires_at: new Date(Date.now() + 10 * 60000).toISOString(),
  }).select('state'), 'save oauth state');
  const u = new URL(AUTH_URL);
  u.searchParams.set('client_id', cfg.googleClientId);
  u.searchParams.set('redirect_uri', originOf(c.env, c.req.raw) + redirectPath);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', scopes.join(' '));
  u.searchParams.set('state', state);
  for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, v);
  return c.redirect(u.toString(), 302);
}

async function exchange(env: Env, code: string, redirectPath: string, origin: string) {
  const cfg = await getAppConfig(env);
  if (!cfg.googleClientId || !cfg.googleClientSecret) throw new HttpError(500, 'Google OAuth client ID or secret is missing. Add them under Settings → Setup keys.');
  const body = new URLSearchParams({ code, client_id: cfg.googleClientId, client_secret: cfg.googleClientSecret, redirect_uri: origin + redirectPath, grant_type: 'authorization_code' });
  const r = await fetch(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
  const j = (await r.json()) as any;
  if (!r.ok) throw new HttpError(400, `Google token exchange failed: ${j.error_description || j.error || r.status}`);
  const ui = await fetch(USERINFO, { headers: { authorization: `Bearer ${j.access_token}` } });
  const info = (await ui.json()) as { email?: string; email_verified?: boolean; name?: string; hd?: string };
  return { tokens: j as { access_token: string; refresh_token?: string; expires_in: number; scope: string }, info };
}

async function consumeState(env: Env, state: string | undefined, kind: string) {
  if (!state) throw new HttpError(400, 'missing state');
  const d = db(env);
  const row = await one<{ state: string; kind: string; account_id: string | null; data: any; expires_at: string }>(d.from('oauth_states').select('*').eq('state', state).single(), 'oauth state');
  if (!row) throw new HttpError(400, 'unknown or expired sign-in attempt');
  await d.from('oauth_states').delete().eq('state', state);
  if (new Date(row.expires_at).getTime() < Date.now()) throw new HttpError(400, 'sign-in attempt expired');
  if (row.kind !== kind && !(kind === 'connect' && row.kind === 'reconnect')) throw new HttpError(400, 'state mismatch');
  return row;
}

// ---------- sign-in ----------
googleAuth.get('/start', async (c) => {
  const next = c.req.query('next') || '/';
  return startFlow(c, 'signin', '/api/auth/google/callback', ['openid', 'email', 'profile'], { prompt: 'select_account' }, { next }, null);
});

googleAuth.get('/callback', async (c) => {
  const err = c.req.query('error');
  if (err) return c.redirect(`/login?error=${encodeURIComponent('Google sign-in cancelled')}`);
  try {
    const st = await consumeState(c.env, c.req.query('state'), 'signin');
    const { info } = await exchange(c.env, c.req.query('code') || '', '/api/auth/google/callback', originOf(c.env, c.req.raw));
    const email = (info.email || '').toLowerCase();
    const d = db(c.env);
    let user = await getUser(d);
    const allowed = allowedEmails(c.env, user);
    if (!info.email_verified || !email) return c.redirect(`/login?error=${encodeURIComponent('Google did not return a verified email address')}`);
    if (allowed.length === 0) {
      // first sign-in on a fresh deployment: this Google account becomes the owner
      const name = (info.name || email.split('@')[0]).slice(0, 80);
      await many(d.from('hq_user').update({ emails: [email], name: user.name || name, alert_to: user.alert_to || email, updated_at: new Date().toISOString() }).eq('id', user.id).select('id'), 'claim owner');
      user = await getUser(d);
    } else if (!allowed.includes(email)) {
      return c.redirect(`/login?error=${encodeURIComponent(`${email} is not allowed to sign in`)}`);
    }
    await createSession(c, user.id, 'google');
    const next = typeof st.data?.next === 'string' && st.data.next.startsWith('/') ? st.data.next : '/';
    return c.redirect(next);
  } catch (e: any) {
    return c.redirect(`/login?error=${encodeURIComponent(e.message || 'Sign-in failed')}`);
  }
});

// ---------- connect a Google account for Gmail + Calendar ----------
googleConnect.use('/connect/start', requireAuth);
googleConnect.get('/connect/start', async (c) => {
  const accountId = c.req.query('accountId') || null; // reconnect
  const hint = c.req.query('email') || '';
  const extra: Record<string, string> = { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' };
  if (hint) extra.login_hint = hint;
  return startFlow(c, accountId ? 'reconnect' : 'connect', '/api/accounts/google/callback', DATA_SCOPES, extra, {}, accountId);
});

googleConnect.get('/callback', async (c) => {
  const err = c.req.query('error');
  if (err) return c.redirect(`/#connections?error=${encodeURIComponent('Google connection cancelled')}`);
  try {
    const st = await consumeState(c.env, c.req.query('state'), 'connect');
    const { tokens, info } = await exchange(c.env, c.req.query('code') || '', '/api/accounts/google/callback', originOf(c.env, c.req.raw));
    const email = (info.email || '').toLowerCase();
    if (!email) throw new HttpError(400, 'Google did not return an email address');
    const granted = tokens.scope.split(' ');
    const d = db(c.env);
    const existing = st.account_id
      ? await one<{ id: string; secret_enc: string | null }>(d.from('accounts').select('id,secret_enc').eq('id', st.account_id).single())
      : await one<{ id: string; secret_enc: string | null }>(d.from('accounts').select('id,secret_enc').eq('provider', 'google').eq('meta->>email', email).maybeSingle());
    let refresh = tokens.refresh_token;
    if (!refresh && existing?.secret_enc) {
      // Google only returns a refresh token on first consent; keep the one we have.
      const { decryptJson } = await import('@shared/crypto.ts');
      const old = await decryptJson<Extract<AccountSecrets, { provider: 'google' }>>(c.env.HQ_MASTER_KEY, existing.secret_enc);
      refresh = old.refreshToken;
    }
    if (!refresh) throw new HttpError(400, 'Google did not return a refresh token. Remove the app at myaccount.google.com/permissions and connect again.');
    const secrets: AccountSecrets = { provider: 'google', refreshToken: refresh, accessToken: tokens.access_token, accessTokenExpiresAt: new Date(Date.now() + tokens.expires_in * 1000).toISOString() };
    const secret_enc = await encryptJson(c.env.HQ_MASTER_KEY, secrets);
    const meta = { email, scopes: granted };
    if (existing) {
      await many(d.from('accounts').update({ secret_enc, meta, status: 'pending', last_error: null, next_sync_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', existing.id).select('id'), 'update google account');
    } else {
      await many(d.from('accounts').insert({ provider: 'google', label: email, secret_enc, meta, status: 'pending' }).select('id'), 'insert google account');
    }
    c.executionCtx.waitUntil(triggerSync(c.env, { all: true }).catch(() => {}));
    return c.redirect(`/#connections?connected=${encodeURIComponent(email)}`);
  } catch (e: any) {
    return c.redirect(`/#connections?error=${encodeURIComponent(e.message || 'Google connection failed')}`);
  }
});

/** Ask the Supabase Edge Function to sync now. Fire-and-forget safe. */
export async function triggerSync(env: Env, body: { accountId?: string; all?: boolean }): Promise<void> {
  if (!env.SUPABASE_URL || !env.HQ_SYNC_SECRET) return;
  await fetch(`${env.SUPABASE_URL}/functions/v1/sync`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-hq-sync-key': env.HQ_SYNC_SECRET },
    body: JSON.stringify({ source: 'worker', ...body }),
  });
}
