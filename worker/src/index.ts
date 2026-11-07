import { Hono } from 'hono';
import type { Env, Vars } from './env.ts';
import { HttpError } from './db.ts';
import { requireAuth } from './auth/session.ts';
import { authRoutes } from './routes/auth.ts';
import { googleConnect } from './auth/google.ts';
import { meRoutes } from './routes/me.ts';
import { projectRoutes } from './routes/projects.ts';
import { accountRoutes } from './routes/accounts.ts';
import { viewRoutes } from './routes/views.ts';
import { dataRoutes } from './routes/data.ts';
import { ingestRoutes } from './routes/ingest.ts';
import { setupRoutes } from './routes/setup.ts';
import { legalRoutes } from './routes/legal.ts';

const app = new Hono<{ Bindings: Env; Variables: Vars }>();

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status as any);
  console.error('unhandled', err);
  return c.json({ error: err.message || 'internal error' }, 500);
});
app.notFound((c) => c.json({ error: 'not found' }, 404));

// security headers for API responses
app.use('/api/*', async (c, next) => {
  await next();
  c.header('cache-control', 'no-store');
  c.header('x-content-type-options', 'nosniff');
});

// public
app.route('/api/auth', authRoutes);
app.route('/api/ingest', ingestRoutes);
app.route('/api/accounts/google', googleConnect); // OAuth connect flow (start requires auth inside)

// private
app.use('/api/*', async (c, next) => {
  const p = c.req.path;
  // only the two OAuth connect endpoints are exempt (connect/start enforces requireAuth itself);
  // a prefix match would also let /api/accounts/google/sync and /runs through unauthenticated.
  if (p.startsWith('/api/auth/') || p.startsWith('/api/ingest') || p === '/api/accounts/google/callback' || p === '/api/accounts/google/connect/start') return next();
  return requireAuth(c, next);
});
app.route('/api', meRoutes);
app.route('/api', projectRoutes);
app.route('/api', accountRoutes);
app.route('/api', viewRoutes);
app.route('/api', dataRoutes);
app.route('/api', setupRoutes);

app.route('/', legalRoutes);

// Everything else is the SPA (served by the assets binding; /login is the same app).
app.get('*', async (c) => {
  const res = await c.env.ASSETS.fetch(c.req.raw);
  if (res.status === 404 || res.status === 405) {
    return c.env.ASSETS.fetch(new Request(new URL('/', c.req.url), c.req.raw));
  }
  // security headers on the document
  const h = new Headers(res.headers);
  if ((h.get('content-type') || '').includes('text/html')) {
    h.set('x-frame-options', 'DENY');
    h.set('referrer-policy', 'strict-origin-when-cross-origin');
    h.set('permissions-policy', 'publickey-credentials-get=(self), publickey-credentials-create=(self)');
    return new Response(res.body, { status: res.status, headers: h });
  }
  return res;
});

// Every minute: ask the Supabase sync function to run whatever accounts are due (and flush alerts).
// This replaces the pg_cron + Vault path, which stays available as a fallback.
export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    const { triggerSync } = await import('./auth/google.ts');
    ctx.waitUntil(triggerSync(env, {}).catch((e) => console.error('sync tick failed', e)));
  },
};
