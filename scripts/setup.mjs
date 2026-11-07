#!/usr/bin/env node
// HQ one-command setup: npm run setup   (Windows PowerShell: node scripts/setup.mjs)
//
// Takes a fresh clone plus free Cloudflare + Supabase accounts to a working dashboard:
//   1 preflight  2 cloudflare login  3 supabase login + project  4 keys (.dev.vars)  5 worker vars (wrangler.jsonc)
//   6 database schema  7 sync edge function  8 build + deploy worker  9 verify + summary
// Re-run safe: answers live in .dev.vars (HQ_SETUP_* keys hold wizard state); finished steps can be skipped with Enter.
// Flags: --non-interactive (fail instead of asking)  --skip-deploy (steps 1-5 only)  --only <step>  --help
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as P from './lib/prompt.mjs';
import { DEV_VARS, WRANGLER_CONFIG, GENERATED, isPlaceholder, readDevVars, writeDevVars, readJsonc, writeJson, applyWranglerConfig } from './lib/config.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(ROOT);
const WIN = process.platform === 'win32';
const NPX = WIN ? 'npx.cmd' : 'npx';
const NPM = WIN ? 'npm.cmd' : 'npm';
const RUN_CMD = WIN ? 'node scripts/setup.mjs' : 'npm run setup';

const STEPS = [
  ['preflight', 'Preflight checks'],
  ['cloudflare', 'Cloudflare login'],
  ['supabase', 'Supabase login and project'],
  ['keys', 'Keys and settings (.dev.vars)'],
  ['vars', 'Worker vars (wrangler.jsonc)'],
  ['db', 'Database schema'],
  ['function', 'Sync Edge Function'],
  ['worker', 'Build and deploy the Worker'],
  ['verify', 'Verify and summary'],
];
const SIGNIN_CALLBACK = '/api/auth/google/callback';
const CONNECT_CALLBACK = '/api/accounts/google/callback';
const DEV_ORIGIN = 'http://localhost:8787';

// ---------- flags ----------
const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const NONINT = flag('--non-interactive');
const SKIP_DEPLOY = flag('--skip-deploy');
const onlyIdx = argv.indexOf('--only');
const ONLY = onlyIdx > -1 ? argv[onlyIdx + 1] : null;
if (flag('--help') || flag('-h')) {
  console.log(`HQ setup wizard

Usage: ${RUN_CMD} [--non-interactive] [--skip-deploy] [--only <step>]

Steps (each is skipped with Enter when it is already done):
${STEPS.map(([id, label], i) => `  ${i + 1}. ${id.padEnd(11)} ${label}`).join('\n')}

Flags:
  --non-interactive   never ask; fail if something is missing (for CI or scripted re-runs)
  --skip-deploy       stop after writing .dev.vars and wrangler.jsonc (steps 1-5)
  --only <step>       run a single step by name, e.g. --only worker
  --help              this text

Answers and progress are stored in .dev.vars (gitignored): the secrets plus HQ_SETUP_* state keys.
Re-run the wizard any time; it keeps prior answers and skips finished steps.
Windows PowerShell blocks npm.ps1 by default, so use:  node scripts/setup.mjs`);
  process.exit(0);
}
if (ONLY && !STEPS.some(([id]) => id === ONLY)) {
  console.error(`Unknown step "${ONLY}". Steps: ${STEPS.map(([id]) => id).join(', ')}`);
  process.exit(2);
}

// ---------- output helpers ----------
const log = (s = '') => console.log(s);
const ok = (s) => log(`  ✓ ${s}`);
const note = (s) => log(`  · ${s}`);
const warn = (s) => log(`  ! ${s}`);
class StepError extends Error { constructor(msg, how) { super(msg); this.how = how; } }
const fail = (msg, how) => { throw new StepError(msg, how); };

// ---------- processes ----------
const quoteWin = (a) => (a === '' || /[\s"&|<>^()]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
/**
 * Run a command. interactive: child owns the terminal (logins, prompts). Otherwise stdout/stderr are
 * captured and, unless quiet, echoed live. Returns { status, out, err, text }.
 */
function run(cmd, args, { interactive = false, quiet = false, input } = {}) {
  const shown = `${cmd === NPX ? 'npx' : cmd === NPM ? 'npm' : cmd} ${args.join(' ')}`;
  if (!quiet) log(`  $ ${shown}`);
  // Windows: .cmd shims need a shell; pass one quoted command line (an args array + shell:true trips DEP0190).
  const [file, spawnArgs] = WIN ? [[cmd, ...args.map(quoteWin)].join(' '), []] : [cmd, args];
  return new Promise((done) => {
    P.pause();
    const child = spawn(file, spawnArgs, {
      shell: WIN,
      stdio: interactive ? 'inherit' : [input !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', ...(NONINT ? { CI: '1' } : {}) },
    });
    let out = '', err = '';
    if (!interactive) {
      child.stdout.on('data', (d) => { out += d; if (!quiet) process.stdout.write(d); });
      child.stderr.on('data', (d) => { err += d; if (!quiet) process.stderr.write(d); });
      if (input !== undefined) { child.stdin.write(input); child.stdin.end(); }
    }
    child.on('error', (e) => { P.resume(); done({ status: -1, out, err: err + String(e), text: out + err }); });
    child.on('close', (status) => { P.resume(); done({ status: status ?? -1, out, err, text: out + '\n' + err }); });
  });
}
const npx = (args, o) => run(NPX, args, o);
const helpCache = new Map();
/** Does `npx <tool> <sub...> --help` mention the flag? Used where CLI versions differ. */
async function supportsFlag(tool, sub, f) {
  const key = [tool, ...sub].join(' ');
  if (!helpCache.has(key)) helpCache.set(key, (await npx([tool, ...sub, '--help'], { quiet: true })).text);
  return helpCache.get(key).includes(f);
}
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');

// ---------- state ----------
const S = readDevVars(DEV_VARS); // all .dev.vars keys incl. HQ_SETUP_*
const save = () => writeDevVars(S);
const has = (k) => !isPlaceholder(S[k]);
const setupOrigin = () => (S.HQ_SETUP_DOMAIN ? `https://${S.HQ_SETUP_DOMAIN}` : S.HQ_SETUP_WORKERS_DEV_URL || '');
const redirectUris = () => {
  const origins = [setupOrigin(), DEV_ORIGIN].filter(Boolean);
  return origins.flatMap((o) => [o + SIGNIN_CALLBACK, o + CONNECT_CALLBACK]);
};
let cfAccountId = ''; // chosen during the cloudflare step when the login has more than one account

// ---------- prompting ----------
/** Visible question with default. Non-interactive: returns the default or fails if required. */
async function ask(label, { def = '', required = false, check, hint } = {}) {
  if (NONINT) {
    if (!def && required) fail(`${label} is missing and --non-interactive was given.`, `Run ${RUN_CMD} without --non-interactive once, or add the value to ${DEV_VARS}.`);
    return def;
  }
  while (true) {
    const v = (await P.ask(`  ${label}${def ? ` [${def}]` : required ? '' : ' [skip]'}: `)) || def;
    if (!v) { if (required) { log('  (required)'); continue; } return ''; }
    const res = check ? check(v) : true;
    if (res !== true) { log(`  looks wrong: ${res}${hint ? ` (${hint})` : ''}`); continue; }
    return v;
  }
}
/** Hidden question; keeps the current value on Enter. Never echoes the value. */
async function askSecret(label, cur, { required = false, check } = {}) {
  if (NONINT) {
    if (!cur && required) fail(`${label} is missing and --non-interactive was given.`, `Add it to ${DEV_VARS} or run interactively once.`);
    return cur;
  }
  while (true) {
    const v = await P.askHidden(`  ${label}${cur ? ` [keep ${P.mask(cur)}]` : required ? '' : ' [skip]'}: `);
    const val = v || cur;
    if (!val) { if (required) { log('  (required)'); continue; } return ''; }
    const res = check ? check(val) : true;
    if (res !== true) { log(`  looks wrong: ${res}`); continue; }
    return val;
  }
}
/** "Already done": Enter skips, "redo" repeats. Non-interactive always skips. */
async function skipIfDone(what) {
  if (NONINT) { ok(`${what} already done (skipping)`); return true; }
  const a = (await P.ask(`  ${what} looks done. Enter to skip, or type redo: `)).toLowerCase();
  return a !== 'redo' && a !== 'r';
}
async function confirm(q, def = true) {
  if (NONINT) return def;
  const a = (await P.ask(`  ${q} ${def ? '[Y/n]' : '[y/N]'}: `)).toLowerCase();
  return a ? a.startsWith('y') : def;
}

// ====================================================================================================
// 1. Preflight
// ====================================================================================================
async function stepPreflight() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 18) fail(`Node ${process.versions.node} is too old; HQ needs Node 18 or newer.`, 'Install the current LTS from https://nodejs.org and re-run.');
  ok(`node ${process.version}`);
  if (WIN) note('Windows: commands run through npx.cmd / npm.cmd (npm.ps1 is blocked by the default PowerShell policy; that is fine).');

  if (!existsSync(join(ROOT, 'node_modules', 'wrangler')) || !existsSync(join(ROOT, 'node_modules', 'supabase'))) {
    warn('node_modules is missing or incomplete.');
    if (NONINT || await confirm('Run npm install now?')) {
      const r = await run(NPM, ['install'], { interactive: true });
      if (r.status !== 0) fail('npm install failed.', 'Fix the error above (usually network or a Node version issue) and re-run.');
    } else fail('Dependencies are not installed.', 'Run npm install, then re-run the wizard.');
  }
  const w = await npx(['wrangler', '--version'], { quiet: true });
  if (w.status !== 0) fail('wrangler does not start.', `Run npm install, then ${RUN_CMD}. Output:\n${w.text}`);
  ok(`wrangler ${stripAnsi(w.out).trim().split(/\s+/).pop()}`);
  const s = await npx(['supabase', '--version'], { quiet: true });
  if (s.status !== 0) fail('supabase CLI does not start.', `Run npm install, then ${RUN_CMD}. Output:\n${s.text}`);
  ok(`supabase CLI ${stripAnsi(s.out).trim().split(/\r?\n/).pop()}`);
  const g = await run('git', ['--version'], { quiet: true });
  if (g.status === 0) ok(stripAnsi(g.out).trim()); else warn('git not found (not required to deploy, but you will want it to pull updates)');
  for (const f of [WRANGLER_CONFIG, 'supabase/config.toml', 'supabase/migrations', 'supabase/functions/sync']) {
    if (!existsSync(f)) fail(`${f} is missing.`, 'Run the wizard from a complete clone of the HQ repository.');
  }
  ok('repo layout');
}

// ====================================================================================================
// 2. Cloudflare login
// ====================================================================================================
function parseAccounts(text) {
  // wrangler whoami prints a table: │ Account Name │ Account ID │
  const rows = [];
  for (const line of stripAnsi(text).split(/\r?\n/)) {
    const cells = line.split(/[│|]/).map((c) => c.trim()).filter(Boolean);
    if (cells.length >= 2 && /^[0-9a-f]{32}$/.test(cells[cells.length - 1])) rows.push({ name: cells[0], id: cells[cells.length - 1] });
  }
  return rows;
}
async function stepCloudflare() {
  let r = await npx(['wrangler', 'whoami'], { quiet: true });
  let text = stripAnsi(r.text);
  if (r.status !== 0 || /not authenticated|not logged in/i.test(text)) {
    if (NONINT) fail('Not logged in to Cloudflare.', 'Run npx wrangler login (or set CLOUDFLARE_API_TOKEN) and re-run.');
    log('  Not logged in to Cloudflare. A browser window will open; approve wrangler there, then come back.');
    const l = await npx(['wrangler', 'login'], { interactive: true });
    if (l.status !== 0) fail('wrangler login did not complete.', 'Run npx wrangler login by hand, then re-run the wizard.');
    r = await npx(['wrangler', 'whoami'], { quiet: true });
    text = stripAnsi(r.text);
    if (r.status !== 0 || /not authenticated/i.test(text)) fail('Still not logged in to Cloudflare.', 'Run npx wrangler login by hand, then re-run the wizard.');
  }
  const email = text.match(/associated with the email ([^\s.]+@[^\s]+?)\.?(?:\s|$)/)?.[1];
  const accounts = parseAccounts(text);
  if (email) ok(`logged in as ${email}`);
  if (accounts.length === 1) ok(`account: ${accounts[0].name}`);
  else if (accounts.length > 1) {
    log('  This login can deploy to several Cloudflare accounts:');
    accounts.forEach((a, i) => log(`    ${i + 1}. ${a.name}`));
    const cur = S.HQ_SETUP_CF_ACCOUNT_ID;
    const defIdx = Math.max(0, accounts.findIndex((a) => a.id === cur));
    const pick = await ask('Deploy to which account (number)', { def: String(defIdx + 1), check: (v) => (/^\d+$/.test(v) && accounts[Number(v) - 1]) ? true : 'enter a number from the list' });
    const a = accounts[Number(pick) - 1];
    cfAccountId = a.id; S.HQ_SETUP_CF_ACCOUNT_ID = a.id; save();
    ok(`account: ${a.name}`);
  } else warn('could not read the account name from wrangler whoami; continuing');
}

// ====================================================================================================
// 3. Supabase login + project
// ====================================================================================================
const REF_RE = /^[a-z]{20}$/;
function parseProjects(r) {
  try {
    const j = JSON.parse(r.out.trim().replace(/^[^[{]*/, ''));
    const arr = Array.isArray(j) ? j : j.projects || [];
    const list = arr.map((p) => ({ ref: p.id || p.ref || p.reference_id, name: p.name || '', region: p.region || '' })).filter((p) => REF_RE.test(p.ref || ''));
    if (list.length) return list;
  } catch { /* fall through to table parsing */ }
  const list = [];
  for (const line of stripAnsi(r.out).split(/\r?\n/)) {
    const cells = line.split(/[│|]/).map((c) => c.trim());
    const i = cells.findIndex((c) => REF_RE.test(c));
    if (i >= 0) list.push({ ref: cells[i], name: cells[i + 1] || '', region: cells[i + 2] || '' });
  }
  return list;
}
async function projectsList() {
  let r = await npx(['supabase', 'projects', 'list', '--output', 'json'], { quiet: true });
  if (r.status !== 0 && /unknown (flag|shorthand)/i.test(r.text)) r = await npx(['supabase', 'projects', 'list'], { quiet: true });
  return r;
}
async function listProjects() {
  let r = await projectsList();
  const notLoggedIn = r.status !== 0 && /login|access token|not logged|unauthorized|401/i.test(stripAnsi(r.text));
  if (notLoggedIn) {
    if (NONINT) fail('Not logged in to Supabase.', 'Run npx supabase login (or set SUPABASE_ACCESS_TOKEN) and re-run.');
    log('  Not logged in to Supabase. A browser window will open; approve the CLI there, then come back.');
    const l = await npx(['supabase', 'login'], { interactive: true });
    if (l.status !== 0) fail('supabase login did not complete.', 'Run npx supabase login by hand, then re-run the wizard.');
    r = await projectsList();
  }
  if (r.status !== 0) fail('Could not list Supabase projects.', `Output:\n${stripAnsi(r.text).trim()}\nRun npx supabase login and re-run.`);
  return parseProjects(r);
}
async function stepSupabase() {
  let projects = await listProjects();
  ok('logged in to Supabase');
  const cur = S.HQ_SETUP_PROJECT_REF || (S.SUPABASE_URL?.match(/^https:\/\/([a-z]{20})\.supabase\.co/)?.[1] ?? '');
  let ref = '';
  if (NONINT) {
    ref = cur;
    if (!ref) fail('No Supabase project chosen.', `Set HQ_SETUP_PROJECT_REF=<ref> in ${DEV_VARS} or run interactively once.`);
  } else {
    while (!ref) {
      if (!projects.length) {
        log('  You have no Supabase projects yet. Create a free one at https://supabase.com/dashboard/new (any name, any region;');
        log('  the database password is not needed by HQ), then come back here.');
      } else {
        log('  Your Supabase projects:');
        projects.forEach((p, i) => log(`    ${i + 1}. ${p.name.padEnd(28)} ${p.ref}${p.region ? `  (${p.region})` : ''}`));
      }
      const defIdx = projects.findIndex((p) => p.ref === cur);
      const a = await P.ask(`  Pick a project (number), paste a project ref, or Enter to refresh the list${defIdx >= 0 ? ` [${defIdx + 1}]` : cur ? ` [${cur}]` : ''}: `);
      if (!a) { if (defIdx >= 0) ref = projects[defIdx].ref; else if (cur) ref = cur; else projects = await listProjects(); continue; }
      if (/^\d+$/.test(a) && projects[Number(a) - 1]) ref = projects[Number(a) - 1].ref;
      else if (REF_RE.test(a)) ref = a;
      else log('  Enter a number from the list or a 20-letter project ref (Supabase dashboard → Project Settings → General → Reference ID).');
    }
  }
  if (!REF_RE.test(ref)) fail(`"${ref}" is not a Supabase project ref (20 lowercase letters).`);
  const name = projects.find((p) => p.ref === ref)?.name;
  S.HQ_SETUP_PROJECT_REF = ref;
  S.SUPABASE_URL = `https://${ref}.supabase.co`;
  save();
  ok(`project ${name ? `${name} (${ref})` : ref} → SUPABASE_URL=${S.SUPABASE_URL}`);
}

// ====================================================================================================
// 4. Keys and settings
// ====================================================================================================
const emailList = (v) => v.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const cleanDomain = (v) => v.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
async function stepKeys() {
  const ref = S.HQ_SETUP_PROJECT_REF;
  log(`  Supabase service_role key. Dashboard → project${ref ? ` ${ref}` : ''} → Project Settings → API keys →`);
  log('  "service_role" (legacy, starts with eyJ) or create a Secret key (starts with sb_secret_). Never the anon/publishable key.');
  if (ref) log(`  https://supabase.com/dashboard/project/${ref}/settings/api-keys`);
  S.SUPABASE_SERVICE_ROLE_KEY = await askSecret('Service role key', has('SUPABASE_SERVICE_ROLE_KEY') ? S.SUPABASE_SERVICE_ROLE_KEY : '', {
    required: true, check: (v) => /^(eyJ|sb_secret_)/.test(v) || 'should start with eyJ or sb_secret_',
  });
  save();

  log('');
  S.HQ_SETUP_APP_NAME = await ask('App name (shown in the dashboard title)', { def: S.HQ_SETUP_APP_NAME || 'HQ', required: true });

  log('');
  log('  Owner Google account(s), comma separated. Only these addresses may sign in. Leave empty and the first');
  log('  Google account that signs in claims the dashboard (everyone else is refused from then on).');
  S.HQ_SETUP_OWNER_EMAILS = emailList(await ask('Owner email(s)', {
    def: S.HQ_SETUP_OWNER_EMAILS || '', check: (v) => emailList(v).every((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) || 'comma-separated email addresses',
  })).join(',');

  log('');
  log('  Custom domain (optional). It must be a zone in the Cloudflare account you logged in to; Cloudflare creates the');
  log('  DNS record on deploy. Leave empty to use the free <name>.workers.dev URL.');
  S.HQ_SETUP_DOMAIN = cleanDomain(await ask('Custom domain, e.g. hq.example.com', {
    def: S.HQ_SETUP_DOMAIN || '', check: (v) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(cleanDomain(v)) || 'a hostname like hq.example.com (no https://, no path)',
  }));
  save();

  log('');
  log('  Google OAuth client (optional now; needed before anyone can sign in). You can also paste it later under');
  log('  Settings → Setup keys. Create it at https://console.cloud.google.com/auth/clients → Create client → Web application,');
  log('  with these Authorised redirect URIs:');
  for (const u of redirectUris()) log(`    ${u}`);
  if (!setupOrigin()) log('    (plus the two for your workers.dev URL, shown at the end once it exists)');
  S.GOOGLE_CLIENT_ID = await ask('Google client ID', { def: has('GOOGLE_CLIENT_ID') ? S.GOOGLE_CLIENT_ID : '', check: (v) => /\.apps\.googleusercontent\.com$/.test(v) || 'ends with .apps.googleusercontent.com' });
  if (S.GOOGLE_CLIENT_ID) S.GOOGLE_CLIENT_SECRET = await askSecret('Google client secret', has('GOOGLE_CLIENT_SECRET') ? S.GOOGLE_CLIENT_SECRET : '', { check: (v) => /^GOCSPX-/.test(v) || 'starts with GOCSPX-' });
  save();

  log('');
  log('  Resend (optional, for alert emails; https://resend.com → API Keys). Also settable later in Settings → Setup keys.');
  S.RESEND_API_KEY = await askSecret('Resend API key', has('RESEND_API_KEY') ? S.RESEND_API_KEY : '', { check: (v) => /^re_/.test(v) || 'starts with re_' });
  if (S.RESEND_API_KEY) {
    const defFrom = has('ALERT_FROM') ? S.ALERT_FROM : `${S.HQ_SETUP_APP_NAME} <hq@${S.HQ_SETUP_DOMAIN || 'your-verified-domain.com'}>`;
    S.ALERT_FROM = await ask('Alert sender (From address, domain verified in Resend)', { def: defFrom, check: (v) => /@/.test(v) || 'needs an email address' });
  }

  log('');
  log('  Random secrets:');
  for (const g of GENERATED) {
    if (has(g.key)) { note(`${g.key}: keeping existing value (${g.what})`); continue; }
    S[g.key] = g.make(); ok(`${g.key}: generated (${g.what})`);
  }
  save();
  ok(`wrote ${DEV_VARS}`);
}

// ====================================================================================================
// 5. Worker vars (wrangler.jsonc)
// ====================================================================================================
function writeWranglerVars(origin) {
  const cfg = readJsonc(WRANGLER_CONFIG);
  applyWranglerConfig(cfg, { appName: S.HQ_SETUP_APP_NAME, origin, emails: S.HQ_SETUP_OWNER_EMAILS, domain: S.HQ_SETUP_DOMAIN, accountId: cfAccountId || S.HQ_SETUP_CF_ACCOUNT_ID });
  writeJson(WRANGLER_CONFIG, cfg);
  return cfg;
}
async function stepVars() {
  if (!has('HQ_SETUP_APP_NAME')) fail('Run the keys step first (app name is not set).', `${RUN_CMD} --only keys`);
  const origin = setupOrigin();
  const cfg = writeWranglerVars(origin);
  ok(`${WRANGLER_CONFIG}: APP_NAME=${cfg.vars.APP_NAME}, ALLOWED_GOOGLE_EMAILS=${cfg.vars.ALLOWED_GOOGLE_EMAILS || '(first sign-in claims it)'}`);
  if (S.HQ_SETUP_DOMAIN) ok(`custom domain route ${S.HQ_SETUP_DOMAIN}; APP_ORIGIN=${origin}`);
  else if (origin) ok(`workers.dev; APP_ORIGIN=${origin}`);
  else ok('workers.dev; APP_ORIGIN left empty until the first deploy tells us the URL (the Worker derives it from the request meanwhile)');
  note('comments in wrangler.jsonc are not preserved by the rewrite');
}

// ====================================================================================================
// 6. Database
// ====================================================================================================
function linkedRef() {
  try { return readFileSync('supabase/.temp/project-ref', 'utf8').trim(); } catch { return ''; }
}
async function ensureLinked(ref) {
  if (linkedRef() === ref) { ok(`supabase link: already linked to ${ref}`); return; }
  log('  Linking the CLI to the project (the CLI login applies migrations; if it asks for a database password, just press Enter).');
  const args = ['supabase', 'link', '--project-ref', ref, '--password', ''];
  if (await supportsFlag('supabase', ['link'], '--yes')) args.push('--yes');
  const r = await npx(args, { interactive: true });
  if (r.status !== 0 || linkedRef() !== ref) fail('supabase link failed.', `Run npx supabase link --project-ref ${ref} by hand, then ${RUN_CMD} --only db.`);
}
async function stepDb() {
  const ref = S.HQ_SETUP_PROJECT_REF;
  if (!ref) fail('No Supabase project chosen yet.', `${RUN_CMD} --only supabase`);
  if (S.HQ_SETUP_DB_PUSHED === ref && await skipIfDone('Database schema')) return;
  log('  This installs the HQ schema (tables, RLS, the app_config key store) into your Supabase project.');
  await ensureLinked(ref);
  const args = ['supabase', 'db', 'push'];
  const hasLinked = await supportsFlag('supabase', ['db', 'push'], '--linked');
  if (hasLinked) args.push('--linked');
  const hasYes = await supportsFlag('supabase', ['db', 'push'], '--yes');
  if (hasYes) args.push('--yes');
  const r = await npx(args, hasYes ? {} : { input: 'y\n' });
  if (r.status !== 0) fail('supabase db push failed.', `Fix the error above (an expired login → npx supabase login) and re-run ${RUN_CMD} --only db.`);
  S.HQ_SETUP_DB_PUSHED = ref; save();
  ok('schema is in place');
}

// ====================================================================================================
// 7. Edge Function
// ====================================================================================================
const envQuote = (v) => `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
function withTempFile(name, content, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'hq-setup-'));
  const file = join(dir, name);
  writeFileSync(file, content, { encoding: 'utf8', mode: 0o600 });
  return fn(file).finally(() => rmSync(dir, { recursive: true, force: true }));
}
const pick = (keys) => Object.fromEntries(keys.filter((k) => has(k)).map((k) => [k, S[k]]));
async function stepFunction() {
  const ref = S.HQ_SETUP_PROJECT_REF;
  if (!ref) fail('No Supabase project chosen yet.', `${RUN_CMD} --only supabase`);
  if (S.HQ_SETUP_FUNCTION_DEPLOYED === ref && await skipIfDone('Sync function deploy')) return;
  log('  Deploying the "sync" Edge Function (it pulls data from your connected providers every few minutes).');
  const args = ['supabase', 'functions', 'deploy', 'sync', '--project-ref', ref, '--no-verify-jwt'];
  if (await supportsFlag('supabase', ['functions', 'deploy'], '--use-api')) args.push('--use-api'); // bundle server-side; no Docker needed
  const d = await npx(args, { interactive: true });
  if (d.status !== 0) fail('Function deploy failed.', `Fix the error above and re-run ${RUN_CMD} --only function.`);

  const secrets = pick(['HQ_MASTER_KEY', 'HQ_SYNC_SECRET', 'RESEND_API_KEY', 'ALERT_FROM', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']);
  log(`  Setting function secrets: ${Object.keys(secrets).join(', ')}`);
  const env = Object.entries(secrets).map(([k, v]) => `${k}=${envQuote(v)}`).join('\n') + '\n';
  const s = await withTempFile('hq-function.env', env, (file) => npx(['supabase', 'secrets', 'set', '--project-ref', ref, '--env-file', file], { interactive: true }));
  if (s.status !== 0) fail('supabase secrets set failed.', `Re-run ${RUN_CMD} --only function.`);
  S.HQ_SETUP_FUNCTION_DEPLOYED = ref; save();
  ok('sync function deployed with its secrets');
}

// ====================================================================================================
// 8. Worker
// ====================================================================================================
const WORKER_SECRETS = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'HQ_MASTER_KEY', 'HQ_SYNC_SECRET', 'HQ_INGEST_KEY', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'RESEND_API_KEY', 'ALERT_FROM'];
async function deployWorker() {
  const r = await npx(['wrangler', 'deploy']);
  if (r.status !== 0) fail('wrangler deploy failed.', `Fix the error above and re-run ${RUN_CMD} --only worker. If wrangler needs to ask you something (e.g. replace an existing DNS record for a custom domain), run npx wrangler deploy by hand once, then re-run the wizard.`);
  const urls = [...stripAnsi(r.text).matchAll(/https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.workers\.dev/g)].map((m) => m[0]);
  return urls[0] || '';
}
async function stepWorker() {
  if (!has('SUPABASE_SERVICE_ROLE_KEY') || !has('HQ_MASTER_KEY')) fail('Keys are not set yet.', `${RUN_CMD} --only keys`);
  const wantOrigin = setupOrigin();
  if (S.HQ_SETUP_WORKER_DEPLOYED && S.HQ_SETUP_WORKER_DEPLOYED === wantOrigin && await skipIfDone('Worker deploy')) return;

  log('  Building the web app and Worker bundle.');
  const b = await run(NPM, ['run', 'build'], { interactive: true });
  if (b.status !== 0) fail('npm run build failed.', `Fix the error above and re-run ${RUN_CMD} --only worker.`);

  log('  Deploying the Worker to Cloudflare.');
  let devUrl = await deployWorker();
  if (devUrl) { S.HQ_SETUP_WORKERS_DEV_URL = devUrl; save(); }

  const secrets = pick(WORKER_SECRETS);
  log(`  Uploading Worker secrets: ${Object.keys(secrets).join(', ')}`);
  const s = await withTempFile('hq-worker-secrets.json', JSON.stringify(secrets), (file) => npx(['wrangler', 'secret', 'bulk', file], { interactive: true }));
  if (s.status !== 0) fail('wrangler secret bulk failed.', `Re-run ${RUN_CMD} --only worker.`);

  if (!S.HQ_SETUP_DOMAIN) {
    if (!devUrl) fail('Could not find the workers.dev URL in the deploy output.', 'Open the Cloudflare dashboard → Workers & Pages → the worker → its workers.dev URL, put it in .dev.vars as HQ_SETUP_WORKERS_DEV_URL=https://… and re-run.');
    const cfg = readJsonc(WRANGLER_CONFIG);
    if (cfg.vars?.APP_ORIGIN !== devUrl) {
      log(`  First deploy gave ${devUrl}; setting APP_ORIGIN/RP_ID to it and deploying once more.`);
      writeWranglerVars(devUrl);
      await deployWorker();
    }
  }
  S.HQ_SETUP_WORKER_DEPLOYED = setupOrigin(); save();
  ok(`Worker is live at ${setupOrigin()}`);
}

// ====================================================================================================
// 9. Verify + summary
// ====================================================================================================
async function probe(url, init) {
  try {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(20000) });
    return { status: r.status, body: (await r.text()).slice(0, 200) };
  } catch (e) { return { status: 0, body: String(e.cause?.message || e.message) }; }
}
async function stepVerify() {
  const origin = setupOrigin();
  let allGood = true;
  if (!origin) { warn('no deployed URL known yet; skipping the HTTP checks'); allGood = false; }
  else {
    const a = await probe(`${origin}/api/auth/status`);
    (a.status === 200 ? ok : warn)(`GET ${origin}/api/auth/status → ${a.status || a.body}${a.status === 200 ? '' : ' (want 200)'}`); allGood &&= a.status === 200;
    const m = await probe(`${origin}/api/me`);
    (m.status === 401 ? ok : warn)(`GET ${origin}/api/me without a cookie → ${m.status || m.body} (want 401)`); allGood &&= m.status === 401;
    if (a.status === 0 && S.HQ_SETUP_DOMAIN) note('a custom domain can take a minute to resolve after the first deploy; re-run --only verify shortly');
  }
  if (has('SUPABASE_URL') && has('HQ_SYNC_SECRET')) {
    const s = await probe(`${S.SUPABASE_URL}/functions/v1/sync`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hq-sync-key': S.HQ_SYNC_SECRET }, body: '{"source":"setup"}' });
    (s.status === 200 ? ok : warn)(`POST sync function → ${s.status || s.body}${s.status === 200 ? '' : ' (want 200)'}`); allGood &&= s.status === 200;
  }

  log('');
  log('==================================================================');
  log(`  ${S.HQ_SETUP_APP_NAME || 'HQ'} is ${allGood ? 'ready' : 'deployed, with warnings above'}`);
  log('==================================================================');
  if (origin) {
    log(`  Dashboard:        ${origin}`);
    log(`  Sign in:          ${origin}  → "Sign in with Google"${S.HQ_SETUP_OWNER_EMAILS ? ` as ${S.HQ_SETUP_OWNER_EMAILS}` : ' (the first account to sign in becomes the owner)'}`);
  }
  log('');
  log(has('GOOGLE_CLIENT_ID') ? '  Google OAuth client: make sure it lists these Authorised redirect URIs:' : '  Google sign-in needs an OAuth client (console.cloud.google.com → Auth → Clients → Web application).');
  if (!has('GOOGLE_CLIENT_ID')) log('  Paste its ID and secret under Settings → Setup keys, with these Authorised redirect URIs:');
  for (const u of redirectUris()) log(`    ${u}`);
  log('');
  log('  Next:');
  log('    1. Sign in, then Connections → Add account to paste provider tokens (Cloudflare, Netlify, Supabase, Stripe, GitHub…).');
  log('    2. Claude Code sessions: Connections → Claude Code → Install, and run the one-line installer it shows on each machine.');
  log('    3. Alerts: Settings → Setup keys → Resend key and sender, if you skipped them here.');
  log('');
  log(`  Re-run any time: ${RUN_CMD}   (keeps your answers; Enter skips finished steps; --only <step> for one step)`);
  log(`  Smoke test later: node scripts/setup-check.mjs`);
  log(`  Secrets live only in ${DEV_VARS} (gitignored) and in Cloudflare/Supabase. Keep a backup of ${DEV_VARS}.`);
}

// ====================================================================================================
// main
// ====================================================================================================
const IMPL = { preflight: stepPreflight, cloudflare: stepCloudflare, supabase: stepSupabase, keys: stepKeys, vars: stepVars, db: stepDb, function: stepFunction, worker: stepWorker, verify: stepVerify };
const DEPLOY_STEPS = new Set(['db', 'function', 'worker']);

async function main() {
  log('');
  log(`HQ setup${NONINT ? ' (non-interactive)' : ''}${SKIP_DEPLOY ? ' (skip deploy)' : ''}${ONLY ? ` (only: ${ONLY})` : ''}`);
  log(`Repo: ${ROOT}`);
  if (!NONINT) log('Enter keeps the value in [brackets]. Secrets are typed hidden and never printed. Ctrl+C stops; re-running resumes.');
  if (WIN && !ONLY) log('Tip: in Windows PowerShell run  node scripts/setup.mjs  (npm.ps1 is blocked by the default execution policy).');

  const steps = ONLY ? STEPS.filter(([id]) => id === ONLY) : STEPS;
  for (const [id, label] of steps) {
    const n = STEPS.findIndex(([x]) => x === id) + 1;
    if (SKIP_DEPLOY && DEPLOY_STEPS.has(id)) { log(`\n[${n}/${STEPS.length}] ${label}: skipped (--skip-deploy)`); continue; }
    if (SKIP_DEPLOY && id === 'verify' && !setupOrigin()) { log(`\n[${n}/${STEPS.length}] ${label}: skipped (nothing deployed yet)`); continue; }
    log(`\n[${n}/${STEPS.length}] ${label}`);
    try {
      await IMPL[id]();
    } catch (e) {
      if (!(e instanceof StepError)) throw e;
      log('');
      log(`✗ Step ${n} (${id}) failed: ${e.message}`);
      if (e.how) log(`  How to continue: ${e.how}`);
      log(`  Then re-run ${RUN_CMD}; finished steps are skipped, or use --only ${id}.`);
      P.stop();
      process.exit(1);
    }
  }
  P.stop();
}

main().catch((e) => { console.error('\nUnexpected error:', e?.stack || e); P.stop(); process.exit(1); });
