#!/usr/bin/env node
// Interactive setup: asks for each secret, generates the random ones, and writes .dev.vars.
// Run it from the repo root in a real terminal:  node scripts/setup-secrets.mjs   (full wizard incl. deploy: node scripts/setup.mjs)
// Press Enter to keep a value that is already in .dev.vars. Secret input is hidden while you type (paste works).
import { existsSync, copyFileSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { ask, askHidden, mask, stop } from './lib/prompt.mjs';
import { DEV_VARS as FILE, ORDER, isPlaceholder, readDevVars, writeDevVars } from './lib/config.mjs';

const b64url = (b) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const ITEMS = [
  { key: 'SUPABASE_URL', secret: false, label: 'Supabase project URL',
    where: 'Supabase dashboard → your hq project → Project Settings → General → Project URL. Looks like https://abcdefghijkl.supabase.co',
    check: (v) => /^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(v) || 'should look like https://<ref>.supabase.co' },
  { key: 'SUPABASE_SERVICE_ROLE_KEY', secret: true, label: 'Supabase service_role key',
    where: 'Project Settings → API keys → service_role (legacy, starts with eyJ…) or a Secret key (starts with sb_secret_). Never the anon/publishable key.',
    check: (v) => /^(eyJ|sb_secret_)/.test(v) || 'should start with eyJ or sb_secret_' },
  { key: 'GOOGLE_CLIENT_ID', secret: false, label: 'Google OAuth client ID',
    where: 'console.cloud.google.com → your HQ project → Google Auth Platform → Clients → the Web application client. Ends with .apps.googleusercontent.com',
    check: (v) => /\.apps\.googleusercontent\.com$/.test(v) || 'should end with .apps.googleusercontent.com' },
  { key: 'GOOGLE_CLIENT_SECRET', secret: true, label: 'Google OAuth client secret',
    where: 'Same client → Client secret (starts with GOCSPX-)',
    check: (v) => /^GOCSPX-/.test(v) || 'should start with GOCSPX-' },
  { key: 'RESEND_API_KEY', secret: true, label: 'Resend API key',
    where: 'resend.com → API Keys → Create → Sending access, domain your-domain.com. Starts with re_',
    check: (v) => /^re_/.test(v) || 'should start with re_' },
  { key: 'ALERT_FROM', secret: false, label: 'Alert sender', default: 'HQ <hq@yourdomain.com>',
    where: 'The From address for alert emails.', check: (v) => /@/.test(v) || 'needs an email address' },
];
const GENERATED = [
  { key: 'HQ_MASTER_KEY', make: () => randomBytes(32).toString('base64'), what: 'encrypts every provider token at rest' },
  { key: 'HQ_SYNC_SECRET', make: () => b64url(randomBytes(32)), what: 'shared between the Worker, the sync function and Vault' },
  { key: 'HQ_INGEST_KEY', make: () => 'hqi_' + b64url(randomBytes(32)), what: 'write-only key for the Mac mini and Windows PC agents' },
];

// ---------- read existing ----------
const existing = readDevVars(FILE);
// Prompting (line queue, hidden input) and .dev.vars I/O are shared with scripts/setup.mjs via scripts/lib/.

console.log('\nHQ secrets setup. Values go into .dev.vars only (gitignored). Press Enter to keep an existing value.\n');
const out = { ...existing };

for (const it of ITEMS) {
  const cur = existing[it.key];
  const has = !isPlaceholder(cur);
  console.log(`\n${it.label}  (${it.key})\n  ${it.where}`);
  while (true) {
    const hint = has ? `[keep ${it.secret ? mask(cur) : cur}] ` : it.default ? `[${it.default}] ` : '[skip for now] ';
    const v = it.secret ? await askHidden(`  → ${hint}`) : await ask(`  → ${hint}`);
    if (v === 'skip') break;
    const val = v || (has ? cur : it.default || '');
    if (!val) break; // left for later
    const ok = it.check ? it.check(val) : true;
    if (ok !== true) { console.log(`  looks wrong: ${ok}. Enter again, or type skip.`); continue; }
    out[it.key] = val; break;
  }
}

console.log('\nRandom secrets:');
for (const g of GENERATED) {
  if (!isPlaceholder(existing[g.key])) { console.log(`  ${g.key}: keeping existing value (${g.what})`); out[g.key] = existing[g.key]; continue; }
  out[g.key] = g.make();
  console.log(`  ${g.key}: generated (${g.what})`);
}

// optional key files
const files = [
  { src: 'App Store Connect .p8 file path', dst: 'secrets/appstore.p8' },
  { src: 'Google Play service account JSON path', dst: 'secrets/googleplay.json' },
];
console.log('\nOptional key files (Enter to skip; you can also paste their contents later in Connections):');
for (const f of files) {
  const p = (await ask(`  ${f.src} → `)).replace(/^"|"$/g, '');
  if (!p) continue;
  if (!existsSync(p)) { console.log(`  not found: ${p} (skipped)`); continue; }
  mkdirSync('secrets', { recursive: true }); copyFileSync(p, f.dst); console.log(`  copied to ${f.dst}`);
}
stop();

// ---------- write ----------
writeDevVars(out, { header: '# HQ secrets (gitignored). Written by scripts/setup-secrets.mjs. Load into Cloudflare with: npm run secrets:worker' });

const missing = ORDER.filter((k) => isPlaceholder(out[k]));
console.log(`\nWrote ${FILE}.`);
if (missing.length) console.log(`Still missing: ${missing.join(', ')}. Run this script again any time.`);
else console.log('All set. Tell Claude "secrets are in".');
