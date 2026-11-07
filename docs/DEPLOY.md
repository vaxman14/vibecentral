# Deploy HQ by hand

`npm run setup` does everything on this page for you. Read on if you want to see every command, if the wizard failed halfway, or if you prefer to run the steps yourself.

## Architecture

- **Cloudflare Worker** (free plan) serves the web app and the `/api` on your origin. Its cron trigger fires every minute and calls the sync function. It also serves the Claude Code installers at `/agent/install.sh` and `/agent/install.ps1`.
- **Supabase project** (free plan) holds the data in Postgres and runs the `sync` Edge Function, which reads your providers and writes snapshots, mail headers, calendar events, history and alerts.
- **Resend** (optional, free plan) sends alert emails.
- **Your machines** run the Claude Code hook and usage agent, which post to the Worker's write-only ingest endpoint.

Nothing is hosted by the author. There is no telemetry and no update check.

## 0. Prerequisites

- Node 24 (18 or newer works for the local agent scripts).
- A Cloudflare account. Workers Free is enough. A custom domain is optional; `<name>.<subdomain>.workers.dev` works.
- A Supabase account with a new, empty project for HQ. Note the project ref (the part before `.supabase.co`) and the service role key (Project Settings → API keys → `service_role`, or a secret key `sb_secret_...`).
- A Google Cloud OAuth client. Sign-in to the dashboard uses it, so you need it before the first sign-in. Steps in [PROVIDERS.md](PROVIDERS.md#google-gmail-and-calendar); the Gmail and Calendar APIs can be enabled later.
- Optional: a Resend API key for alert emails.

```bash
git clone https://github.com/vaxman14/hq
cd hq
npm install
cp .dev.vars.example .dev.vars
node scripts/gen-secrets.mjs      # prints HQ_MASTER_KEY, HQ_SYNC_SECRET, HQ_INGEST_KEY
```

Fill `.dev.vars` (see the table at the end). On Windows PowerShell use `npm.cmd` and `npx.cmd`; the `.ps1` wrappers are blocked by the default execution policy. Git Bash has no such problem.

## 1. Database

```bash
npx supabase login
npx supabase link --project-ref <ref>
npx supabase db push
```

`db push` applies `supabase/migrations/*.sql`. The CLI login role is enough; no database password is needed. Answer Yes at the prompt.

Scheduling needs nothing here: the Worker's cron trigger calls the sync function every minute. The migration also installs a pg_cron job as an optional fallback. It stays dormant unless you create two Vault secrets in the SQL editor:

```sql
select vault.create_secret('https://<ref>.supabase.co', 'hq_project_url');
select vault.create_secret('<HQ_SYNC_SECRET>', 'hq_sync_secret');
```

## 2. Sync Edge Function

```bash
npx supabase functions deploy sync --project-ref <ref> --no-verify-jwt
npx supabase secrets set --project-ref <ref> \
  HQ_MASTER_KEY="..." \
  HQ_SYNC_SECRET="..." \
  GOOGLE_CLIENT_ID="..." \
  GOOGLE_CLIENT_SECRET="..." \
  RESEND_API_KEY="..." \
  ALERT_FROM="HQ <hq@yourdomain.com>"
```

`--no-verify-jwt` is required: the function authenticates callers with its own `x-hq-sync-key` header, not a Supabase JWT (`supabase/config.toml` sets the same). `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected by Supabase; do not set them (the CLI rejects `SUPABASE_*` names, which is why you cannot pass `.dev.vars` itself). Google and Resend values can be left out and entered later under Settings → Setup keys; values there override the secrets.

Check it answers:

```bash
curl -s -X POST https://<ref>.supabase.co/functions/v1/sync \
  -H "x-hq-sync-key: <HQ_SYNC_SECRET>" -H "content-type: application/json" -d '{"source":"manual"}'
```

Expected: `{"ok":true,"ran":[],...}` (no accounts yet). A wrong key returns 401.

## 3. Worker

Edit `wrangler.jsonc`:

- `name`: the Worker name (becomes `<name>.<subdomain>.workers.dev`).
- `vars.APP_ORIGIN`: your origin, for example `https://hq.yourdomain.com` or `https://hq.yoursubdomain.workers.dev`.
- `vars.RP_ID`: the hostname of that origin.
- `vars.ALLOWED_GOOGLE_EMAILS`: comma-separated Google addresses allowed to sign in. Leave it empty to let the first Google account that signs in become the owner.
- `vars.APP_NAME`: the name shown in the sidebar and in alert emails (default `HQ`).
- `workers_dev: true` serves the app at `https://hq.<your-subdomain>.workers.dev`. For a custom domain in a zone of the same Cloudflare account, replace it with `"routes": [{ "pattern": "hq.yourdomain.com", "custom_domain": true }]`.

Then:

```bash
npx wrangler login
npm run build
npx wrangler deploy
npx wrangler secret bulk .dev.vars
```

The first deploy creates the Worker, attaches the custom domain if you added `routes`, and registers the cron trigger. `secret bulk` uploads every line of `.dev.vars` as a Worker secret.

For deploys on push: Cloudflare dashboard → Workers & Pages → your Worker → Settings → Build → Connect to Git. Build command `npm run build`, deploy command `npx wrangler deploy`. Secrets persist across builds.

### The "Deploy to Cloudflare" button

The README's button opens `https://deploy.workers.cloudflare.com/?url=https://github.com/vaxman14/hq`. It forks the repo into your GitHub, creates the Worker and sets up deploys on push. It does only the Worker half: it does not create the Supabase project, push the schema, deploy the sync function or set secrets. After the button, clone your fork and run `npm run setup` (Windows PowerShell: `node scripts/setup.mjs`) to finish the database side and load the Worker secrets. The wizard is re-run safe: it keeps its answers in `.dev.vars` and lets you skip a finished step with Enter. To run one step on its own use `--only <step>` with one of `preflight`, `cloudflare`, `supabase`, `keys`, `vars`, `db`, `function`, `worker`, `verify`, for example `npm run setup -- --only db` (the `--` is needed so npm passes the flag through).

## 4. Resend sending domain (optional)

Verify your domain under resend.com → Domains and add the DKIM, SPF and MX records at your DNS host. If the domain is on Cloudflare you can let a script do it: put a Cloudflare token with DNS:Edit on that zone on a `CF_DNS_TOKEN=` line in `.dev.vars` and run

```bash
node scripts/resend-dns.mjs yourdomain.com
```

It registers the domain in Resend, adds the records to Cloudflare and requests verification. Remove `CF_DNS_TOKEN` from `.dev.vars` afterwards; the app never needs it.

## 5. First sign-in

1. Open your origin. Click **Sign in with Google**.
2. If `ALLOWED_GOOGLE_EMAILS` is empty, the account you use now becomes the owner and no other Google account can sign in afterwards. If it is set, only the listed addresses can sign in.
3. Settings → Setup keys: paste anything you skipped (Google client, Resend). The page shows which values come from env and which are missing.
4. Connections → Add account for each provider. Token click paths are in [PROVIDERS.md](PROVIDERS.md). Google: Connect with Google, once per address.
5. Projects → New project, then open it and use **+ Link** to attach its domains, sites, databases, apps and repos. Provider events for linked things land in that project's history and drive the alert urgency.
6. Connections → Claude Code → Install for each machine you use Claude Code on. See [CLAUDE-CODE-SETUP.md](CLAUDE-CODE-SETUP.md).

## Environment variables

| Where | Name | Value |
|---|---|---|
| Worker var (`wrangler.jsonc`) | `APP_NAME` | name shown in the app and in alert subjects, default `HQ` |
| Worker var | `APP_ORIGIN` | `https://hq.yourdomain.com` or your workers.dev URL, no trailing slash |
| Worker var | `RP_ID` | hostname of `APP_ORIGIN` |
| Worker var | `ALLOWED_GOOGLE_EMAILS` | comma-separated allow-list, or empty for first-sign-in-wins |
| Worker secret | `SUPABASE_URL` | `https://<ref>.supabase.co` |
| Worker secret | `SUPABASE_SERVICE_ROLE_KEY` | service role key or `sb_secret_...` |
| Worker secret | `HQ_MASTER_KEY` | 32 random bytes, base64; encrypts provider tokens and setup keys |
| Worker secret | `HQ_SYNC_SECRET` | random string; sent in `x-hq-sync-key` to the sync function |
| Worker secret | `HQ_INGEST_KEY` | random string; the only credential the Claude Code hook and agent hold, write-only |
| Worker secret | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | OAuth client; required for sign-in |
| Worker secret | `RESEND_API_KEY`, `ALERT_FROM` | optional; can instead be set under Settings → Setup keys |
| Edge Function secret | `HQ_MASTER_KEY`, `HQ_SYNC_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `RESEND_API_KEY`, `ALERT_FROM` | same values as the Worker |
| Edge Function (automatic) | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | injected by Supabase |
| Supabase Vault (optional) | `hq_project_url`, `hq_sync_secret` | only for the pg_cron fallback |
| `.dev.vars` only (optional) | `CF_DNS_TOKEN` | DNS:Edit token for `scripts/resend-dns.mjs`; remove the line before `secret bulk` |
| Each machine | `~/.hq/config.json` | `url`, `ingestKey`, `machine`, optional `ignoreFolders` |

Provider tokens are never environment variables. They are pasted in Connections and stored encrypted in `accounts.secret_enc`.

### Rotating a secret

- `HQ_MASTER_KEY`: cannot be rotated in place; stored tokens would no longer decrypt. Use Settings → Data → Delete everything, set the new key on the Worker and the Edge Function, and reconnect your accounts.
- `HQ_SYNC_SECRET`: set the new value on the Worker, the Edge Function and (if used) Vault.
- `HQ_INGEST_KEY`: set the new value on the Worker, then rerun the agent installer on each machine.
- Google client secret, Resend key: Settings → Setup keys.

## Local development

```bash
npm run dev          # Vite on 5173 + wrangler dev on 8787
```

- http://localhost:5173/?mock=1 shows the app with sample data and no backend.
- http://localhost:8787 runs the real Worker with `.dev.vars` against your Supabase project. Add `http://localhost:8787/api/auth/google/callback` and `http://localhost:8787/api/accounts/google/callback` as redirect URIs on the Google client for this to work.
- Sync function locally: `npx supabase start`, put the secrets in `supabase/functions/.env`, then `npx supabase functions serve sync --no-verify-jwt --env-file supabase/functions/.env`.

## Test checklist

Sign-in
- [ ] The origin shows the sign-in card. Google sign-in with your address lands on Overview.
- [ ] A different Google account is refused with "is not allowed to sign in".
- [ ] Settings shows a 30-day session. "Sign out others" ends the session on another device.

Connections and sync
- [ ] Each added account shows "Synced Xs ago" within a minute. The sidebar chip says "All sources synced · N accounts · M providers".
- [ ] A wrong token shows an Error pill with the provider's message. Manage → new token fixes it.
- [ ] Settings → Sync → 15 minutes shifts the next sync times.
- [ ] Settings → Data → Clear cached data empties the tables for a moment, then they refill.

Views
- [ ] Domains: every zone, DNS record counts, renewal date for Registrar domains, Workers and tunnels.
- [ ] Sites: Netlify sites with last deploy state and build time. A failed deploy shows red and appears in the Overview note.
- [ ] Databases: Supabase projects with Healthy or Paused, size, auth users, advisor count.
- [ ] Revenue: Stripe and PayPal 30-day totals, subscriptions, next payout, by-day chart.
- [ ] App stores: App Store versions and review states; Google Play ratings and reviews.
- [ ] Calendar: today's events from every connected Google account. Mail: Important tab plus one tab per address.
- [ ] Claude usage: API spend by workspace if Anthropic is connected. After installing the agent on a machine, the Claude Code block fills in.
- [ ] The account switcher filters tables to one account. The command palette (Ctrl/Cmd+K) finds a domain, a site, a task and a mail subject.
- [ ] Light/dark toggle persists. The phone layout works at 375 px.

Projects, tasks, history
- [ ] Add a task and tick it done. It moves to Done and a "Done: ..." history line appears.
- [ ] Link a zone and a site to a project. The next deploy of that site shows in the project's history.
- [ ] End a Claude Code session in a folder named like a project. Within a minute the project's history shows the summary and tasks. A session in an unknown folder appears under Unsorted on the History page and can be mapped with one click.

Alerts
- [ ] Push a broken build to a linked Netlify site. An email arrives (immediately if the project is Live, otherwise after quiet hours end). A second failure of the same deploy does not email twice.
- [ ] Settings → Notifications → turn off "Failed deploys". No email on the next failure.

Data
- [ ] Settings → Data → Export downloads a JSON file with projects, tasks, history, usage and account labels, but no tokens.
- [ ] Settings → Data → Delete everything (type DELETE) removes every row including tokens and signs you out.
