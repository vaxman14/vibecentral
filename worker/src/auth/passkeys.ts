// Passkeys (WebAuthn) with @simplewebauthn/server. Face ID on iPhone, Touch ID on the Mac mini.
import { Hono } from 'hono';
import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
  type AuthenticatorTransportFuture,
} from '@simplewebauthn/server';
import type { Env, Vars } from '../env.ts';
import { db, getUser, many, one, HttpError } from '../db.ts';
import { createSession, requireAuth } from './session.ts';
import { b64urlDecode, b64urlEncode } from '@shared/crypto.ts';
import type { PasskeyDTO } from '@shared/types.ts';
import { appName, originOf, rpIdOf } from '../branding.ts';

export const passkeys = new Hono<{ Bindings: Env; Variables: Vars }>();

interface PasskeyRow { id: string; user_id: string; public_key: string; counter: number; transports: string[]; device_type: string | null; backed_up: boolean; label: string; created_at: string; last_used_at: string | null }

const toDTO = (r: PasskeyRow): PasskeyDTO => ({ id: r.id, label: r.label, createdAt: r.created_at, lastUsedAt: r.last_used_at, deviceType: r.device_type, backedUp: r.backed_up });

function origins(env: Env, c: any): string[] {
  const set = new Set<string>([originOf(env, c.req.raw)]);
  const o = c.req.header('origin');
  if (o && new URL(o).hostname === rpIdOf(env, c.req.raw)) set.add(o);
  return [...set];
}

async function saveChallenge(env: Env, challenge: string, kind: 'register' | 'login'): Promise<string> {
  const rows = await many<{ id: string }>(db(env).from('webauthn_challenges').insert({ challenge, kind, expires_at: new Date(Date.now() + 5 * 60000).toISOString() }).select('id'), 'save challenge');
  return rows[0].id;
}
async function takeChallenge(env: Env, id: string, kind: 'register' | 'login'): Promise<string> {
  const d = db(env);
  const row = await one<{ id: string; challenge: string; kind: string; expires_at: string }>(d.from('webauthn_challenges').select('*').eq('id', id).single(), 'challenge');
  if (!row) throw new HttpError(400, 'challenge not found; try again');
  await d.from('webauthn_challenges').delete().eq('id', id);
  if (row.kind !== kind || new Date(row.expires_at).getTime() < Date.now()) throw new HttpError(400, 'challenge expired; try again');
  return row.challenge;
}

// ---------- registration (signed in) ----------
passkeys.post('/register/options', requireAuth, async (c) => {
  const d = db(c.env);
  const user = await getUser(d);
  const existing = await many<PasskeyRow>(d.from('passkeys').select('*'), 'passkeys');
  const options = await generateRegistrationOptions({
    rpName: appName(c.env), rpID: rpIdOf(c.env, c.req.raw),
    userName: user.emails[0] || 'owner', userDisplayName: user.name || 'Owner',
    userID: new TextEncoder().encode(user.id),
    attestationType: 'none',
    excludeCredentials: existing.map((p) => ({ id: p.id, transports: p.transports as AuthenticatorTransportFuture[] })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
  });
  const challengeId = await saveChallenge(c.env, options.challenge, 'register');
  return c.json({ challengeId, options });
});

passkeys.post('/register/verify', requireAuth, async (c) => {
  const body = await c.req.json<{ challengeId: string; response: any; label?: string }>();
  const expectedChallenge = await takeChallenge(c.env, body.challengeId, 'register');
  const v = await verifyRegistrationResponse({ response: body.response, expectedChallenge, expectedOrigin: origins(c.env, c), expectedRPID: rpIdOf(c.env, c.req.raw), requireUserVerification: true });
  if (!v.verified || !v.registrationInfo) throw new HttpError(400, 'passkey could not be verified');
  const cred = v.registrationInfo.credential;
  const d = db(c.env);
  const user = await getUser(d);
  const row = await one<PasskeyRow>(d.from('passkeys').insert({
    id: cred.id, user_id: user.id, public_key: b64urlEncode(cred.publicKey), counter: cred.counter,
    transports: cred.transports ?? [], device_type: v.registrationInfo.credentialDeviceType, backed_up: v.registrationInfo.credentialBackedUp,
    label: (body.label || 'Passkey').slice(0, 60),
  }).select('*').single(), 'save passkey');
  return c.json(toDTO(row!));
});

// ---------- authentication (signed out) ----------
passkeys.post('/login/options', async (c) => {
  const options = await generateAuthenticationOptions({ rpID: rpIdOf(c.env, c.req.raw), userVerification: 'required' });
  const challengeId = await saveChallenge(c.env, options.challenge, 'login');
  return c.json({ challengeId, options });
});

passkeys.post('/login/verify', async (c) => {
  const body = await c.req.json<{ challengeId: string; response: any }>();
  const expectedChallenge = await takeChallenge(c.env, body.challengeId, 'login');
  const d = db(c.env);
  const pk = await one<PasskeyRow>(d.from('passkeys').select('*').eq('id', body.response?.id ?? '').single(), 'passkey');
  if (!pk) throw new HttpError(400, 'unknown passkey');
  const v = await verifyAuthenticationResponse({
    response: body.response, expectedChallenge, expectedOrigin: origins(c.env, c), expectedRPID: rpIdOf(c.env, c.req.raw), requireUserVerification: true,
    credential: { id: pk.id, publicKey: new Uint8Array(b64urlDecode(pk.public_key)) as Uint8Array<ArrayBuffer>, counter: Number(pk.counter), transports: pk.transports as AuthenticatorTransportFuture[] },
  });
  if (!v.verified) throw new HttpError(401, 'passkey rejected');
  await d.from('passkeys').update({ counter: v.authenticationInfo.newCounter, last_used_at: new Date().toISOString() }).eq('id', pk.id);
  await createSession(c, pk.user_id, 'passkey');
  return c.json({ ok: true });
});

// ---------- management ----------
passkeys.get('/', requireAuth, async (c) => c.json((await many<PasskeyRow>(db(c.env).from('passkeys').select('*').order('created_at'), 'passkeys')).map(toDTO)));
passkeys.patch('/:id', requireAuth, async (c) => {
  const { label } = await c.req.json<{ label: string }>();
  const row = await one<PasskeyRow>(db(c.env).from('passkeys').update({ label: String(label).slice(0, 60) }).eq('id', c.req.param('id')).select('*').single(), 'rename passkey');
  if (!row) throw new HttpError(404, 'passkey not found');
  return c.json(toDTO(row));
});
passkeys.delete('/:id', requireAuth, async (c) => {
  await many(db(c.env).from('passkeys').delete().eq('id', c.req.param('id')).select('id'), 'remove passkey');
  return c.json({ ok: true });
});
