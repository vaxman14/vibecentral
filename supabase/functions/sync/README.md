# `sync` Edge Function

Reads every connected provider (Cloudflare, Netlify, Supabase, Stripe, PayPal, Google, GitHub, App Store Connect, Google Play, Anthropic) and writes normalized rows into `snapshots`, `metrics`, `mail_items`, `cal_events` and `history`, then evaluates and emails alerts through Resend. It only ever reads from providers; see "Non-GET calls" below for the complete list of exceptions.

```
supabase/functions/
  sync/index.ts            runner: auth header, account selection, budgets, status/backoff, alerts
  sync/deno.json           import map (@supabase/supabase-js -> npm:) used by the CLI and `deno check`
  _shared/providers/*.ts   one read-only sync(ctx) per provider
  _shared/providers/ctx.ts SyncContext, writers, fetch + error classification helpers
  _shared/alerts.ts        evaluateAlerts / flushAlerts
  _shared/resend.ts        Resend POST
  _shared/links.ts         project_links -> project_id lookup
```

## Deploy

```bash
npx supabase login
npx supabase link --project-ref <project-ref>
npx supabase db push                                   # applies supabase/migrations/0001_init.sql
npx supabase functions deploy sync --no-verify-jwt     # same as: npm run functions:deploy
```

`verify_jwt = false` is also set in `supabase/config.toml` under `[functions.sync]`: the function authenticates callers with its own `x-hq-sync-key` header instead of a Supabase JWT.

## Secrets

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected by Supabase. Set the rest once (same values as the Worker's `.dev.vars`):

```bash
npx supabase secrets set \
  HQ_MASTER_KEY=… \
  HQ_SYNC_SECRET=… \
  RESEND_API_KEY=… \
  "ALERT_FROM=HQ <hq@yourdomain.com>" \
  GOOGLE_CLIENT_ID=… \
  GOOGLE_CLIENT_SECRET=…
```

| Secret | Used for |
|---|---|
| `HQ_MASTER_KEY` | AES-256-GCM key (32 bytes, base64) that decrypts `accounts.secret_enc`. Must equal the Worker's. |
| `HQ_SYNC_SECRET` | Value callers must send in `x-hq-sync-key`. Must equal the Worker's and the Vault secret below. |
| `RESEND_API_KEY`, `ALERT_FROM` | Alert emails. If unset, alerts are still recorded in `alerts` but stay `pending`. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Refreshing Gmail/Calendar access tokens for Google accounts. |

### Vault (for the pg_cron tick)

The migration schedules `hq_sync_tick()` every minute; it POSTs `{"source":"cron"}` to the function with the header. It reads two Vault secrets, which you create once in the SQL editor:

```sql
select vault.create_secret('https://<project-ref>.supabase.co', 'hq_project_url');
select vault.create_secret('<the same value as HQ_SYNC_SECRET>', 'hq_sync_secret');
```

Until both exist the tick is a no-op. To rotate: `select vault.update_secret(id, '<new value>') from vault.secrets where name = 'hq_sync_secret';`

## Request contract

`POST /functions/v1/sync` with header `x-hq-sync-key: <HQ_SYNC_SECRET>` and a JSON body:

| Body | Behavior |
|---|---|
| `{"source":"cron"}` (or empty) | Runs accounts whose `next_sync_at <= now()`, oldest first, at most 6 per call and at most one `google` account (Gmail is the slowest). |
| `{"accountId":"<uuid>"}` | Runs that account now regardless of schedule (the Worker uses this after adding/reconnecting an account). |
| `{"all":true}` | Marks every account due, then runs up to the limit; following cron ticks pick up the rest. |

Response:

```json
{ "ok": true, "source": "cron",
  "ran": [{ "accountId": "…", "provider": "netlify", "label": "Personal", "ok": true, "status": "ok", "ms": 1830, "error": null }],
  "skipped": 0,
  "alerts": { "created": 1, "considered": 4, "sent": 1, "failed": 0, "pending": 0 },
  "ms": 2140 }
```

Per account: a `sync_runs` row is opened, secrets are decrypted, the provider module runs with a 45 s budget (AbortController), data is upserted, and the account row gets `status='ok'`, `last_sync_at`, `last_sync_ms`, `next_sync_at = now + coalesce(accounts.sync_minutes, hq_user.sync_minutes)`. On failure `status` becomes `error` (or `expired` for 401/403/`invalid_grant`), `last_error` holds a short message for the UI, and `next_sync_at` backs off 5 → 15 → 60 minutes based on consecutive failed runs. Two accounts run concurrently; no new account is started after 90 s so the whole call stays under the free-tier 150 s limit. One account failing never stops the others.

## What gets written

`snapshots(account_id, kind)` — latest payload per account, shapes from `_shared/types.ts`:

| provider | kind → type |
|---|---|
| cloudflare | `zones` → `CfZone[]`, `workers` → `CfWorker[]`, `tunnels` → `CfTunnel[]` |
| netlify | `sites` → `NlSite[]`, `deploys` → `NlDeploy[]` (last 7 days) |
| supabase | `projects` → `SbProject[]` |
| stripe | `stripe` → `StripeSummary` |
| paypal | `paypal` → `PaypalSummary` |
| google | `google` → `GoogleSummary` (mail and events go to `mail_items` / `cal_events`) |
| github | `repos` → `GhRepo[]`, `pulls` → `GhPull[]`, `runs` → `GhRun[]` |
| appstore | `apps` → `AsApp[]` |
| googleplay | `apps` → `GpApp[]` |
| anthropic | `anthropic` → `AnthropicSummary` |

`metrics(account_id, kind, day)` — `traffic` (`TrafficDay`, 7 d), `deploys` (`DeployDay`, 7 d), `revenue` (`RevenueDay`, 30 d, Stripe and PayPal), `actions` (`ActionsDay`, 7 d), `spend` (`SpendDay`, 30 d). Days are `YYYY-MM-DD` in `hq_user.tz` (Anthropic buckets are UTC days).

`history` rows have `kind='provider'`, `source=<provider>`, a unique `fingerprint` (`nl:deploy:<id>`, `gh:pr:<repo>#<n>`, `gh:run:<id>`, `as:state:<appId>:<state>:<version>`, `cf:tunnel:…`, `cf:zone:…`, `sb:status:…`) and `project_id` resolved through `project_links` (domain → zone name, site → Netlify site id, database → Supabase ref, app → bundle id / package name, repo → owner/repo, worker → name, tunnel → id).

## Alerts

After the account loop, `evaluateAlerts` builds candidates and inserts them with `on conflict (fingerprint) do nothing`, so an alert is never sent twice:

| kind | fingerprint | gated by `hq_user.notifications` |
|---|---|---|
| `failed_deploy` | `failed_deploy:<deployId>` (Netlify error/failed in last 24 h; urgent when the linked project is stage 4 Live) | `failedDeploys` |
| `failed_run` | `failed_run:<runId>` (GitHub Actions failure on the default branch, last 24 h) | `failedDeploys` |
| `domain_expiry` | `domain_expiry:<domain>:<ISO week>` (Registrar expiry within 30 d; urgent ≤ 7 d) | `domainExpiry` |
| `app_review` | `app_review:<appId>:<state>:<version>` (App Store pending state changed) | `appReview` |
| `new_build` | `new_build:<appId>:<build>` | `newBuilds` |
| `new_revenue` | `new_revenue:<balanceTxnId>` (Stripe charge not in previous snapshot) | `newRevenue` |
| `token_failure` | `token_failure:<accountId>:<day>` (status `expired`, or 3 failed runs in a row) | `tokenFailure` |
| `sync_error` | `sync_error:<accountId>:<day>` | `syncErrors` |

During quiet hours non-urgent alerts are stored as `held` with `send_after = quietHoursEnd()`. `flushAlerts` sends everything `pending`/`held` whose `send_after <= now` through Resend (`[<app name>] <title>`, link to `https://romanvaxman.com/#<page>` or `#p-<projectId>`), marks `sent`/`failed`, and adds a `history` row of kind `alert` when the alert belongs to a project.

## Non-GET calls (complete list)

| provider | call | why |
|---|---|---|
| cloudflare | `POST /client/v4/graphql` | analytics query (zone traffic, Workers invocations); read-only |
| supabase | `POST /v1/projects/{ref}/database/query` | three SELECT-only statements (`pg_database_size`, `count(*) from auth.users`, storage size) |
| paypal | `POST /v1/oauth2/token` | client-credentials token |
| google | `POST https://oauth2.googleapis.com/token` | refresh-token grant |
| googleplay | `POST https://oauth2.googleapis.com/token` | service-account JWT exchange |
| appstore | none | the ES256 JWT is signed locally |
| alerts | `POST https://api.resend.com/emails` | sending the alert email |

Nothing else is ever POSTed, PATCHed or DELETEd on any provider. Google Play `edits.*` is never used.

## Test with curl

```bash
URL=https://<project-ref>.supabase.co/functions/v1/sync
KEY=<HQ_SYNC_SECRET>

# all due accounts (what cron sends)
curl -s -X POST "$URL" -H "x-hq-sync-key: $KEY" -H 'Content-Type: application/json' -d '{"source":"cron"}' | jq

# one account now
curl -s -X POST "$URL" -H "x-hq-sync-key: $KEY" -H 'Content-Type: application/json' -d '{"accountId":"<uuid>"}' | jq

# everything, ignoring schedules
curl -s -X POST "$URL" -H "x-hq-sync-key: $KEY" -H 'Content-Type: application/json' -d '{"all":true}' | jq

# wrong key -> 401 {"error":"unauthorized"}
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$URL" -H 'x-hq-sync-key: nope' -d '{}'
```

Locally: `npx supabase start`, put the secrets in `supabase/functions/.env`, run `npx supabase functions serve sync --no-verify-jwt --env-file supabase/functions/.env` and use `http://127.0.0.1:54321/functions/v1/sync` as `URL`. Logs: `npx supabase functions logs sync` or the dashboard.

## Type-checking

```bash
npx -y deno@2 check --config supabase/functions/sync/deno.json supabase/functions/sync/index.ts   # downloads a Deno binary once
npx tsc --noEmit -p supabase/functions/tsconfig.json                                               # Node fallback, no Deno needed
```

## Known gaps (fields set to null on purpose)

- `AsApp.rating` / `ratingCount`: the App Store Connect API has no aggregate rating endpoint (`customerReviews` are individual reviews).
- `GpApp.name`: the app title is only available through `edits.*` (a write call), so it stays null; `ratingCount` is not in the ratings overview CSV.
- `CfZone.expiresAt` / `autoRenew` are only filled for domains on Cloudflare Registrar; without the Registrar permission `registrar` is false everywhere.
- `SbProject.dbSizeBytes` / `authUsers` / `storageBytes` are null for paused projects (the SQL endpoint rejects them).
