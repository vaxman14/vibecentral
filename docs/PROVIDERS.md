# Providers: tokens, permissions, what is read

One section per connector. Each says which token to create (the click path), the minimum permissions, what Vibe Central reads, which non-GET calls exist and why, and what it cannot show.

General rules that hold for every provider:

- Tokens are pasted under **Connections → Add account** and stored AES-256-GCM encrypted in Postgres. They are decrypted only inside the `sync` Edge Function, never returned by the API, and never logged.
- The sync runs every 5 minutes per account by default (Settings → Sync). Everything you see is a snapshot; the provider is the source of truth.
- Only GET calls, with these exceptions, all read-only in effect: OAuth token exchanges (PayPal, Google, Google Play), the Cloudflare GraphQL analytics query, and the Supabase SQL endpoint with three fixed SELECT statements. Nothing is ever created, changed or deleted on a provider. Google Play `edits.*` is never used.
- A 401, 403 or `invalid_grant` marks the account **Expired** and, if enabled, sends one "token failure" email per day. Fix it under Connections → Manage → new token.
- You can add several accounts of the same provider (two Cloudflare logins, three Stripe accounts, ...). The account switcher in the top bar filters every page to one of them.

Quick reference:

| Provider | Credential | Can it be scoped read-only? | Non-GET calls |
|---|---|---|---|
| Cloudflare | API token | Yes | GraphQL analytics (POST, read-only) |
| Netlify | Personal access token | No (Netlify tokens have no scopes) | none |
| Supabase | Personal access token | No (Management API tokens are full access) | SQL endpoint, SELECT only |
| Stripe | Restricted key | Yes | none |
| PayPal | REST app client ID + secret | Partly (Transaction Search only) | OAuth token exchange |
| Google | OAuth consent (your own client) | Yes (read-only scopes) | OAuth token refresh |
| GitHub | Fine-grained token | Yes | none |
| App Store Connect | API key (.p8) | Partly (role Developer) | none |
| Google Play | Service account JSON | Partly (view-only permissions) | OAuth JWT exchange |
| Anthropic | Admin API key | No (admin keys are full admin) | none |

---

## Cloudflare

**Create the token:** Cloudflare dashboard → My Profile → API Tokens → Create Token → Create Custom Token.

**Permissions (all Read):**

| Scope | Permission | Needed for |
|---|---|---|
| Account | Account Settings: Read | listing your accounts |
| Account | Workers Scripts: Read | Workers list |
| Account | Cloudflare Tunnel: Read | tunnels |
| Account | Account Analytics: Read | Workers invocation counts (GraphQL) |
| Account | Registrar: Read | domain expiry and auto-renew (optional, see below) |
| Zone | Zone: Read | zones |
| Zone | DNS: Read | DNS record counts |
| Zone | Analytics: Read | 7-day traffic, visitors, threats (GraphQL) |

Account Resources: include every account you want to see. Zone Resources: all zones. One token covers every account the login can reach; you can restrict it to specific account ids under the account's Manage dialog later.

**What is read:** accounts; zones with status, plan, DNS record count; 7 days of requests, unique visitors, threats and bytes per zone; Workers with routes and 24-hour requests and errors; tunnels with status and connection count; Registrar domains with expiry date and auto-renew.

**Endpoints:** `GET /accounts`, `GET /zones`, `GET /zones/{id}/dns_records` (count only), `GET /accounts/{id}/workers/scripts`, `GET /accounts/{id}/cfd_tunnel`, `GET /accounts/{id}/registrar/domains`, and `POST /client/v4/graphql` for the two analytics queries (zone traffic by day, Workers invocations). The GraphQL endpoint is POST because that is how GraphQL works; the queries only read.

**Known gaps:** without Registrar: Read every zone shows `registrar: false` and no expiry. Domains registered elsewhere never show an expiry. Zone analytics on the Free plan are sampled by Cloudflare.

**Alerts fed:** domain expiring within 30 days (urgent within 7).

## Netlify

**Create the token:** app.netlify.com → User settings → Applications → Personal access tokens → New access token.

**Permissions:** none to choose. Netlify personal access tokens have no scopes and act as you. Vibe Central only ever calls GET endpoints with it, but the token itself could do anything your account can. Keep that in mind, and revoke it from the same page if you stop using Vibe Central.

**What is read:** sites (name, URL, custom domain, team, repo) and the last 15 deploys of each site from the last 7 days: state, branch, title, build time, error message.

**Endpoints:** `GET /api/v1/sites`, `GET /api/v1/sites/{id}/deploys`.

**Known gaps:** none worth noting. Deploys older than 7 days are not fetched.

**Alerts fed:** failed deploy (urgent when the linked project is in stage Live).

## Supabase

**Create the token:** supabase.com/dashboard/account/tokens → Generate new token.

**Permissions:** none to choose. Supabase Management API tokens are full access for your login. Vibe Central only reads, but the token could manage every project. Same advice as Netlify: one token per login, revoke it when you stop.

**What is read:** organizations; projects with region, status, created date; health of db, auth, storage and rest; security and performance advisor counts and titles; database size, auth user count and storage size.

**Endpoints:** `GET /v1/organizations`, `GET /v1/projects`, `GET /v1/projects/{ref}/health`, `GET /v1/projects/{ref}/advisors/{security|performance}`, and `POST /v1/projects/{ref}/database/query` with exactly these three statements:

```sql
select pg_database_size(current_database()) as bytes
select count(*)::bigint as n from auth.users
select coalesce(sum((metadata->>'size')::bigint),0)::bigint as bytes from storage.objects
```

The SQL endpoint is POST because the Management API has no GET for these numbers. The statements are constants in `supabase/functions/_shared/providers/supabase.ts`; nothing is interpolated into them.

**Known gaps:** paused projects return null for size and user count (the SQL endpoint rejects them). Vibe Central's own Supabase project appears in the list like any other.

## Stripe

**Create the key:** Stripe dashboard → Developers → API keys → Create restricted key.

**Permissions (all Read):** Balance, Balance transactions, Charges, Payment intents, Customers, Subscriptions, Invoices, Payouts, Products, Prices. Everything else None. Use the live key (`rk_live_...`) for real numbers.

**What is read:** account name and currency; available and pending balance; 30 days of balance transactions (revenue, refunds, payouts, adjustments) by day; active subscriptions with customer, product, amount, interval; the next payout.

**Endpoints:** `GET /v1/account`, `GET /v1/balance`, `GET /v1/balance_transactions`, `GET /v1/subscriptions?status=active`, `GET /v1/payouts`, `GET /v1/products/{id}`.

**Known gaps:** revenue is computed from balance transactions of type `charge` and `payment`, minus refunds. Connect platforms are not traversed.

**Alerts fed:** new revenue (optional, off by default).

## PayPal

**Create the credentials:** developer.paypal.com → Apps & Credentials → Live → Create App. Copy the Client ID and the Secret.

**Permissions:** on the app, enable **Transaction Search** under Features. Nothing else is needed. PayPal apps cannot be made strictly read-only, but with only Transaction Search enabled the app can read reports and not move money.

**What is read:** balances per currency; the last 31 days of transactions with type, amount, status and description.

**Endpoints:** `POST /v1/oauth2/token` (client-credentials grant; the only way to get a bearer token), `GET /v1/reporting/balances`, `GET /v1/reporting/transactions`.

**Known gaps:** PayPal's reporting data lags by up to a few hours. Sandbox credentials are not supported.

## Google (Gmail and Calendar)

Google is different: there is no token to paste. You create your own OAuth client once, and then click **Connect with Google** per address. Read-only scopes only: `gmail.readonly` and `calendar.readonly`, plus `openid email profile` to know which address connected.

**Create the OAuth client:**

1. console.cloud.google.com → create a project (any name).
2. APIs & Services → Library → enable **Gmail API** and **Google Calendar API**.
3. APIs & Services → OAuth consent screen (Google Auth Platform) → Audience: **External**. Fill in the app name and support email.
4. Branding needs three URLs. Vibe Central serves them: home `https://<your-origin>/`, privacy `https://<your-origin>/privacy`, terms `https://<your-origin>/terms`.
5. Add the scopes above under Data access.
6. Credentials → Create credentials → OAuth client ID → Web application. Authorized redirect URIs:
   - `https://<your-origin>/api/auth/google/callback` (sign-in)
   - `https://<your-origin>/api/accounts/google/callback` (connect Gmail and Calendar)
   - the same two on `http://localhost:8787` if you run the Worker locally
7. Copy the Client ID and Client Secret into the setup wizard, or paste them later under Settings → Setup keys.

**Testing vs published:** in **Testing** mode you add your own addresses as test users and refresh tokens expire after 7 days, so you reconnect weekly. If you **Publish** the app without going through verification, Google shows a one-time "unverified app" warning at consent time and tokens then persist. For a single-user dashboard the unverified published mode is the practical choice. Verification is not needed because only you use the client.

**What is read:** Gmail message headers (From, Subject, Date) and the snippet for messages in the lookback window (14 days by default), excluding Promotions and Social; the unread Important count; the calendar list and events for today and the current week.

**Endpoints:** `POST https://oauth2.googleapis.com/token` (refresh-token grant), `GET gmail/v1/users/me/profile`, `GET gmail/v1/users/me/messages`, `GET gmail/v1/users/me/messages/{id}?format=metadata`, `GET calendar/v3/users/me/calendarList`, `GET calendar/v3/calendars/{id}/events`.

**Known gaps:** message bodies are never fetched; only headers and Google's own snippet. Gmail is the slowest provider, so the sync runs at most one Google account per tick.

## GitHub

**Create the token:** github.com → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token. Resource owner: you. Repository access: all repositories (or the ones you want to see).

**Permissions (all Read-only):** Metadata, Contents, Pull requests, Actions, Issues.

**What is read:** your repositories (up to 300, most recently pushed first): default branch, stars, language, open issues and PR counts; for the 15 most recently pushed repos, open pull requests, recently closed pull requests and the last 20 Actions runs; failed runs per day for 7 days.

**Endpoints:** `GET /user`, `GET /user/repos`, `GET /search/issues` (open PR counts in one call), `GET /repos/{owner}/{repo}/pulls`, `GET /repos/{owner}/{repo}/actions/runs`.

**Known gaps:** organization repositories you do not own are not listed (affiliation is `owner`). Actions and PR detail cover the 15 most active repos only.

**Alerts fed:** failed Actions run on the default branch (counted under "failed deploys").

## App Store Connect

**Create the key:** appstoreconnect.apple.com → Users and Access → Integrations → App Store Connect API → Team Keys → Generate API Key. Role **Developer** is enough. Download the `.p8` once (Apple only lets you download it once), note the Key ID and the Issuer ID at the top of the page.

**Permissions:** App Store Connect keys are scoped by role, not by endpoint. Developer is the lowest role that can read apps, versions and builds. Vibe Central signs the ES256 JWT locally with the `.p8`; the key never leaves the sync function.

**What is read:** apps (name, bundle id, SKU, platforms); the live version and state; the pending version and its review state; the latest build and its processing state; the TestFlight beta review state of that build.

**Endpoints:** `GET /v1/apps`, `GET /v1/apps/{id}/appStoreVersions`, `GET /v1/apps/{id}/builds`, `GET /v1/builds/{id}/betaAppReviewSubmission`. No non-GET calls.

**Known gaps:** there is no aggregate star rating in the App Store Connect API (`customerReviews` are individual reviews), so the rating column stays empty for App Store apps. Sales and downloads are not read.

**Alerts fed:** app review state change; new build (optional).

## Google Play

**Create the credentials:**

1. In a Google Cloud project: IAM & Admin → Service Accounts → Create service account. Create a JSON key and download it.
2. Play Console → Users and permissions → Invite new users → the service account's email. Account permissions: **View app information and download bulk reports**. Under app permissions, grant **View app information** for the apps you want. "View financial data" is not needed. Do not grant any "Release" or "Manage" permission.
3. Play Console → Download reports → Statistics → copy the bucket id shown in the "Copy Cloud Storage URI" line. It looks like `pubsite_prod_rev_0123456789`. Paste it without `gs://` in the Reports bucket field.

**What is read:** from the reports bucket (Cloud Storage, read-only scope): monthly ratings, installs and crashes CSVs per package; from the Reviews API: the latest 20 reviews per app.

**Endpoints:** `POST https://oauth2.googleapis.com/token` (service-account JWT exchange), `GET storage/v1/b/{bucket}/o` (list), `GET storage/v1/b/{bucket}/o/{name}?alt=media` (download CSV), `GET androidpublisher/v3/applications/{package}/reviews`.

**Known gaps:** the release status (in review, rolled out, halted) is not shown because reading it requires `edits.insert`, which is a write call; Vibe Central does not make it. The app title is only available through the same `edits.*` API, so apps are listed by package name. The ratings overview CSV has no rating count. Report CSVs are produced by Google once a day.

## Anthropic (Claude API usage and cost)

**Create the key:** console.anthropic.com → Settings → Organization → Admin keys → Create admin key.

**Permissions:** none to choose. Admin keys are full organization admin by design: Anthropic exposes the usage and cost reports only through the Admin API, and admin keys cannot be scoped. This is the one connector whose credential is more powerful than what Vibe Central does with it. Vibe Central calls four read endpoints and nothing else; audit `supabase/functions/_shared/providers/anthropic.ts` if you want to check. If that trade-off is not acceptable, skip this connector. It is optional.

**What is read:** organization name; workspaces; 30 days of cost by day, workspace and model; 30 days of token usage (input, output, cache read, cache write) by model.

**Endpoints:** `GET /v1/organizations/me`, `GET /v1/organizations/workspaces`, `GET /v1/organizations/cost_report`, `GET /v1/organizations/usage_report/messages`.

**Known gaps:** this covers API-key usage billed to your organization. It does not cover a Claude Pro or Max subscription. Subscription usage from Claude Code comes from the local usage agent instead; see [CLAUDE-CODE-SETUP.md](CLAUDE-CODE-SETUP.md). Plan limits (5-hour and weekly percentages) are not available through any supported API and are not shown.

---

## Resend (alert emails, not a connector)

Alerts are optional. Without a Resend key they are still recorded in the database and shown in project history, but no email goes out.

**Create the key:** resend.com → API Keys → Create API Key, permission **Sending access** only, restricted to your sending domain. Verify a sending domain under Domains (DKIM, SPF, MX records). Then set `RESEND_API_KEY` and `ALERT_FROM` (for example `Vibe Central <vibe@yourdomain.com>`) in the wizard or under Settings → Setup keys.

**The only call:** `POST https://api.resend.com/emails`. Alert kinds, dedupe fingerprints and quiet hours are described in `supabase/functions/sync/README.md`.
