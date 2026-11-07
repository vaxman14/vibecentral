#!/usr/bin/env node
// Checks .dev.vars for missing values and smoke-tests the deployment.
// Usage: node scripts/setup-check.mjs                      (URL = APP_ORIGIN from wrangler.jsonc, or the workers.dev URL the setup wizard recorded)
//        node scripts/setup-check.mjs --url https://your-dashboard.example
import { existsSync } from 'node:fs';
import { DEV_VARS, readDevVars, deployedOrigin } from './lib/config.mjs';

// Google and Resend keys can instead be entered in the dashboard (Settings → Setup keys), so they are optional here.
const REQUIRED = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'HQ_MASTER_KEY', 'HQ_SYNC_SECRET', 'HQ_INGEST_KEY'];
const OPTIONAL = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'RESEND_API_KEY', 'ALERT_FROM'];
const vars = readDevVars(DEV_VARS);
if (!existsSync(DEV_VARS)) console.log(`✗ ${DEV_VARS} missing (run: node scripts/setup.mjs)`);

const empty = (v) => !v || /xxxx/.test(v);
let ok = true;
for (const k of REQUIRED) {
  const bad = empty(vars[k]);
  console.log(`${bad ? '✗' : '✓'} ${k}${bad ? ' is empty' : ''}`);
  if (bad) ok = false;
}
for (const k of OPTIONAL) console.log(`${empty(vars[k]) ? '·' : '✓'} ${k}${empty(vars[k]) ? ' (optional: set here or under Settings → Setup keys)' : ''}`);
if (vars.HQ_MASTER_KEY) {
  const len = Buffer.from(vars.HQ_MASTER_KEY.replace(/-/g, '+').replace(/_/g, '/'), 'base64').length;
  if (len !== 32) { console.log(`✗ HQ_MASTER_KEY decodes to ${len} bytes, need 32 (clear it in ${DEV_VARS} and run node scripts/setup.mjs --only keys)`); ok = false; }
}
for (const f of ['secrets/appstore.p8', 'secrets/googleplay.json']) console.log(`${existsSync(f) ? '✓' : '·'} ${f}${existsSync(f) ? '' : ' (optional until you add that provider)'}`);

const urlIdx = process.argv.indexOf('--url');
const base = urlIdx > -1 ? (process.argv[urlIdx + 1] || '').replace(/\/$/, '') : deployedOrigin();
if (!base) console.log('· no deployed URL known (pass --url, or run the setup wizard so wrangler.jsonc has APP_ORIGIN); skipping the HTTP checks');
else {
  console.log(`\nChecking ${base}`);
  const get = async (p, init) => {
    try {
      const r = await fetch(base + p, { ...init, signal: AbortSignal.timeout(20000) });
      let j = null; try { j = await r.clone().json(); } catch {}
      return { status: r.status, j, r };
    } catch (e) { return { status: 0, j: null, err: String(e.cause?.message || e.message) }; }
  };
  const status = await get('/api/auth/status');
  console.log(`${status.status === 200 ? '✓' : '✗'} GET /api/auth/status → ${status.status || status.err} ${status.j ? JSON.stringify(status.j) : ''}`);
  if (status.status !== 200) ok = false;
  const noauth = await get('/api/me');
  console.log(`${noauth.status === 401 ? '✓' : '✗'} GET /api/me without cookie → ${noauth.status || noauth.err} (want 401)`);
  if (noauth.status !== 401) ok = false;
  if (vars.HQ_INGEST_KEY) {
    const ping = await get('/api/ingest/ping', { headers: { authorization: `Bearer ${vars.HQ_INGEST_KEY}` } });
    console.log(`${ping.status === 200 ? '✓' : '✗'} GET /api/ingest/ping with key → ${ping.status || ping.err}`);
    const badKey = await get('/api/ingest/ping', { headers: { authorization: 'Bearer nope' } });
    console.log(`${badKey.status === 401 ? '✓' : '✗'} GET /api/ingest/ping with wrong key → ${badKey.status || badKey.err} (want 401)`);
  }
  const html = await get('/');
  console.log(`${html.status === 200 ? '✓' : '✗'} GET / → ${html.status || html.err} ${html.r?.headers.get('content-type') || ''}`);
  if (vars.SUPABASE_URL && vars.HQ_SYNC_SECRET) {
    try {
      const r = await fetch(`${vars.SUPABASE_URL}/functions/v1/sync`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hq-sync-key': vars.HQ_SYNC_SECRET }, body: '{"source":"check"}', signal: AbortSignal.timeout(20000) });
      console.log(`${r.ok ? '✓' : '✗'} POST sync function → ${r.status} ${(await r.text()).slice(0, 200)}`);
      if (!r.ok) ok = false;
    } catch (e) { console.log(`✗ POST sync function → ${String(e.cause?.message || e.message)}`); ok = false; }
  }
}
process.exit(ok ? 0 : 1);
