# Contributing

Issues and pull requests are welcome. Vibe Central is a small, single-user tool, so please keep changes small and in the spirit of the project: read-only, self-hosted, no telemetry.

## Run it locally

```bash
git clone https://github.com/vaxman14/vibecentral
cd hq
npm install
npm run dev
```

`npm run dev` starts Vite (the web app, port 5173) and `wrangler dev` (the Worker, port 8787) together.

- Open http://localhost:5173/?mock=1 to browse the app with sample data. No sign-in, no Supabase, no tokens. The fixtures live in `web/src/mock.ts` and are tree-shaken from production builds.
- Without `?mock=1` the web app talks to the Worker on port 8787, which needs a filled `.dev.vars` (copy `.dev.vars.example`) and a real Supabase project. See [docs/DEPLOY.md](docs/DEPLOY.md).

On Windows PowerShell the `npm.ps1` wrapper is blocked by the default execution policy. Use `npm.cmd run dev`, or run the commands from Git Bash.

## Type checks

```bash
npm run typecheck                                                                         # Worker + web (tsc)
npx tsc --noEmit -p supabase/functions/tsconfig.json                                      # sync Edge Function, Node-side check
npx -y deno@2 check --config supabase/functions/sync/deno.json supabase/functions/sync/index.ts   # sync Edge Function under Deno
```

There is no test suite. Please run the type checks before opening a pull request and describe how you verified the change by hand.

## Ground rules

- **Connectors stay read-only.** A provider module may only call GET endpoints. The only exceptions are token exchanges and read-only POST analytics or SELECT queries that have no GET equivalent. Every exception is listed in `supabase/functions/sync/README.md` under "Non-GET calls" and in [docs/PROVIDERS.md](docs/PROVIDERS.md). If your change adds one, add it to both lists and explain why there is no GET alternative. Pull requests that write to a provider will not be merged.
- **No telemetry.** Vibe Central never phones home. Pull requests that add analytics, crash reporting, update checks or any call to a server the user does not run will not be merged.
- **Least privilege.** When a provider lets you scope a token, document the minimum scope in `docs/PROVIDERS.md` and in the form hint in `supabase/functions/_shared/forms.ts`.
- **Secrets never leave the server.** Provider tokens are encrypted at rest and decrypted only inside the sync function. Do not add API routes that return them, not even masked, beyond the existing "Setup keys" preview.
- **One user.** Do not add multi-tenant features, roles or sign-up. That is out of scope by design.

## Where things live

| Folder | What |
|---|---|
| `web/` | The app (Vite + TypeScript, no framework) |
| `worker/` | Cloudflare Worker: Google sign-in, API, ingest endpoint, cron trigger |
| `supabase/migrations/` | Postgres schema |
| `supabase/functions/sync/` | The sync Edge Function and its README |
| `supabase/functions/_shared/` | Types, forms, crypto, alerts, one provider module per connector |
| `scripts/` | Setup wizard, Claude Code hook and usage agent, installers |
| `docs/` | Deploy, providers, Claude Code setup, API contract |

## Style

Short sentences, plain words. Match the code around you. Comments explain why, not what.
