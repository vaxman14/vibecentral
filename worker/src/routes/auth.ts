import { Hono } from 'hono';
import type { Env, Vars } from '../env.ts';
import { db, many } from '../db.ts';
import { googleAuth } from '../auth/google.ts';
import { passkeys } from '../auth/passkeys.ts';
import { listSessions, readSession, requireAuth, signOut, signOutOthers } from '../auth/session.ts';
import { branding } from '../branding.ts';

export const authRoutes = new Hono<{ Bindings: Env; Variables: Vars }>();

authRoutes.get('/status', async (c) => {
  const s = await readSession(c);
  let hasPasskeys = false;
  try {
    const rows = await many<{ id: string }>(db(c.env).from('passkeys').select('id').limit(1), 'passkeys');
    hasPasskeys = rows.length > 0;
  } catch { /* not configured yet */ }
  const b = await branding(c);
  return c.json({ signedIn: !!s, hasPasskeys, allowedEmails: b.allowedEmails, claimed: b.allowedEmails.length > 0, branding: { appName: b.appName, host: b.host, origin: b.origin, ownerName: b.ownerName, contact: b.contact } });
});

authRoutes.route('/google', googleAuth);
authRoutes.route('/passkey', passkeys);
authRoutes.route('/passkeys', passkeys);

authRoutes.get('/sessions', requireAuth, async (c) => c.json(await listSessions(c)));
authRoutes.post('/signout', async (c) => { await signOut(c); return c.json({ ok: true }); });
authRoutes.post('/signout-others', requireAuth, async (c) => c.json({ ok: true, removed: await signOutOthers(c) }));
