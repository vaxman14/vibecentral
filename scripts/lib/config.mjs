// Shared file helpers for the setup scripts: .dev.vars read/write, random secrets, tolerant JSONC.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

export const DEV_VARS = '.dev.vars';
export const WRANGLER_CONFIG = 'wrangler.jsonc';

const b64url = (b) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** The three random secrets and how to make them. */
export const GENERATED = [
  { key: 'HQ_MASTER_KEY', make: () => randomBytes(32).toString('base64'), what: 'encrypts every provider token at rest' },
  { key: 'HQ_SYNC_SECRET', make: () => b64url(randomBytes(32)), what: 'shared between the Worker and the sync function' },
  { key: 'HQ_INGEST_KEY', make: () => 'hqi_' + b64url(randomBytes(32)), what: 'write-only key for the Claude Code agents' },
];

/** Order of the well-known keys in .dev.vars; anything else follows, HQ_SETUP_* state last. */
export const ORDER = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'HQ_MASTER_KEY', 'HQ_SYNC_SECRET', 'HQ_INGEST_KEY', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'RESEND_API_KEY', 'ALERT_FROM'];

/** Empty or still the example placeholder. */
export const isPlaceholder = (v) => !v || /xxxx/.test(v);

/** Parse KEY=value lines. Quotes around the value and trailing "  # comments" are dropped. */
export function readDevVars(file = DEV_VARS) {
  const vars = {};
  if (!existsSync(file)) return vars;
  for (const line of readFileSync(file, 'utf8').replace(/^﻿/, '').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2];
    if (v.startsWith('#')) v = '';
    else if (/^".*"$/.test(v)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    vars[m[1]] = v;
  }
  return vars;
}

/** Write the whole map back (well-known keys first, setup state last). Values are written verbatim. */
export function writeDevVars(vars, { file = DEV_VARS, header } = {}) {
  const lines = [header || '# Vibe Central secrets (gitignored). Written by scripts/setup.mjs. Load into Cloudflare with: npm run secrets:worker'];
  for (const k of ORDER) if (vars[k] !== undefined) lines.push(`${k}=${vars[k]}`);
  const rest = Object.keys(vars).filter((k) => !ORDER.includes(k));
  for (const k of rest.filter((k) => !k.startsWith('HQ_SETUP_'))) lines.push(`${k}=${vars[k]}`);
  const state = rest.filter((k) => k.startsWith('HQ_SETUP_')).sort();
  if (state.length) { lines.push('# setup wizard state (npm run setup); safe to delete'); for (const k of state) lines.push(`${k}=${vars[k]}`); }
  writeFileSync(file, lines.join('\n') + '\n', 'utf8');
}

/**
 * Strip // and /* *\/ comments and trailing commas from JSONC without touching string contents,
 * so the result can go through JSON.parse. Comments are not preserved on rewrite.
 */
export function stripJsonc(text) {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '"') { // string: copy verbatim, honouring escapes
      let j = i + 1;
      while (j < n && text[j] !== '"') { if (text[j] === '\\') j++; j++; }
      out += text.slice(i, j + 1); i = j + 1; continue;
    }
    if (c === '/' && text[i + 1] === '/') { while (i < n && text[i] !== '\n') i++; continue; }
    if (c === '/' && text[i + 1] === '*') { const e = text.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
    out += c; i++;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

export function readJsonc(file) {
  return JSON.parse(stripJsonc(readFileSync(file, 'utf8').replace(/^﻿/, '')));
}

export function writeJson(file, obj) {
  writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

/**
 * Apply the setup wizard answers to a parsed wrangler config (pure; used by scripts/setup.mjs).
 * origin empty → APP_ORIGIN/RP_ID empty, the Worker derives them from the request until the first deploy reveals the URL.
 */
export function applyWranglerConfig(cfg, { appName, origin, emails, domain, accountId }) {
  cfg.vars = { ...(cfg.vars || {}) };
  cfg.vars.APP_NAME = appName || 'Vibe Central';
  cfg.vars.APP_ORIGIN = origin || '';
  cfg.vars.RP_ID = origin ? new URL(origin).hostname : '';
  cfg.vars.ALLOWED_GOOGLE_EMAILS = emails || '';
  if (domain) { cfg.routes = [{ pattern: domain, custom_domain: true }]; delete cfg.workers_dev; }
  else { delete cfg.routes; cfg.workers_dev = true; }
  if (accountId) cfg.account_id = accountId;
  if (cfg.env?.dev?.vars) { cfg.env.dev.vars.APP_NAME = cfg.vars.APP_NAME; cfg.env.dev.vars.ALLOWED_GOOGLE_EMAILS = cfg.vars.ALLOWED_GOOGLE_EMAILS; }
  return cfg;
}

/** APP_ORIGIN as the deployed Worker sees it: wrangler.jsonc vars, else the workers.dev URL the wizard recorded. */
export function deployedOrigin({ wrangler = WRANGLER_CONFIG, devVars = DEV_VARS } = {}) {
  let origin = '';
  try { origin = readJsonc(wrangler)?.vars?.APP_ORIGIN || ''; } catch { /* no config yet */ }
  if (!origin) origin = readDevVars(devVars).HQ_SETUP_WORKERS_DEV_URL || '';
  return origin.replace(/\/$/, '');
}
