# HQ API contract

All endpoints live on the Worker under `/api`. Responses are JSON. Errors: `{ "error": "message" }` with 4xx/5xx.
Browser calls carry the `hq_session` cookie (HttpOnly, Secure, SameSite=Lax). Unauthenticated calls to anything but `/api/auth/*` and `/api/ingest*` get `401 {error:"unauthorized"}`.
DTO names refer to `supabase/functions/_shared/types.ts`.

## Auth
| Method | Path | Body → Response |
|---|---|---|
| GET | /api/auth/status | → `{ signedIn, hasPasskeys, allowedEmails: string[] }` |
| GET | /api/auth/google/start?next=/ | 302 to Google (sign-in) |
| GET | /api/auth/google/callback | 302 to `/` (sets cookie) or `/login?error=…` |
| POST | /api/auth/passkey/login/options | → `{ challengeId, options }` (PublicKeyCredentialRequestOptionsJSON) |
| POST | /api/auth/passkey/login/verify | `{ challengeId, response }` → `{ ok: true }` (sets cookie) |
| POST | /api/auth/passkey/register/options | (signed in) → `{ challengeId, options }` (PublicKeyCredentialCreationOptionsJSON) |
| POST | /api/auth/passkey/register/verify | `{ challengeId, response, label }` → `PasskeyDTO` |
| GET | /api/auth/passkeys | → `PasskeyDTO[]` |
| PATCH | /api/auth/passkeys/:id | `{ label }` → `PasskeyDTO` |
| DELETE | /api/auth/passkeys/:id | → `{ ok }` |
| GET | /api/auth/sessions | → `SessionDTO[]` |
| POST | /api/auth/signout | → `{ ok }` (clears cookie) |
| POST | /api/auth/signout-others | → `{ ok, removed: number }` |

## Me and settings
| GET | /api/me | → `MeDTO` |
| PATCH | /api/settings | partial `Settings` → `Settings` |

## Views
| GET | /api/overview | → `OverviewDTO` |
| GET | /api/domains | → `DomainsDTO` |
| GET | /api/sites | → `SitesDTO` |
| GET | /api/databases | → `DatabasesDTO` |
| GET | /api/revenue | → `RevenueDTO` |
| GET | /api/stores | → `StoresDTO` |
| GET | /api/calendar | → `CalendarDTO` |
| GET | /api/mail | → `MailDTO` |
| GET | /api/claude | → `ClaudeDTO` |
| GET | /api/connections | → `ConnectionsDTO` |
| GET | /api/search | → `SearchItem[]` (palette index: pages are added client-side) |

Every row DTO that belongs to an account carries `accountId`; the account switcher filters client-side on it. Stats are recomputed client-side only where trivial (counts); otherwise shown unfiltered with the switcher label.

## Projects, tasks, history
| GET | /api/projects | → `ProjectDTO[]` (not archived, by sort) |
| POST | /api/projects | `{ name, color?, stage?, blurb? }` → `ProjectDTO` |
| GET | /api/projects/:id | → `{ project: ProjectDTO, tasks: TaskDTO[], history: HistoryDTO[] }` |
| PATCH | /api/projects/:id | `{ name?, color?, stage?, blurb?, sort?, archived? }` → `ProjectDTO` |
| DELETE | /api/projects/:id | → `{ ok }` (hard delete; cascades) |
| GET | /api/linkables | → `{ kind, accountId, accountLabel, ref, label }[]` everything linkable (zones, sites, Supabase projects, store apps, repos, workers, tunnels, accounts) |
| POST | /api/projects/:id/links | `{ kind, accountId, ref, label }` → `ProjectLinkDTO` |
| DELETE | /api/projects/:id/links/:linkId | → `{ ok }` |
| GET | /api/tasks?state=open\|done\|all&projectId= | → `TaskDTO[]` |
| POST | /api/tasks | `{ projectId, title, dueLabel? }` → `TaskDTO` |
| PATCH | /api/tasks/:id | `{ title?, done?, dueLabel?, projectId? }` → `TaskDTO` |
| DELETE | /api/tasks/:id | → `{ ok }` |
| GET | /api/history?projectId=&limit=&kind= | → `HistoryDTO[]` (project history also includes provider events for linked things) |
| POST | /api/history | `{ projectId, title, detail? }` → `HistoryDTO` (a typed update) |
| GET | /api/unsorted | → `UnsortedDTO[]` (folders from hooks/agent with no project) |
| PATCH | /api/unsorted/:id | `{ projectId }` → `UnsortedDTO` (maps folder, moves its history/tasks/usage) |

## Accounts (connections)
| POST | /api/accounts | `{ provider, label, secrets: {...per FORMS}, meta?: AccountMeta }` → `AccountDTO` (secrets encrypted, sync triggered) |
| PATCH | /api/accounts/:id | `{ label?, meta?, secrets? }` → `AccountDTO` |
| DELETE | /api/accounts/:id | → `{ ok }` |
| POST | /api/accounts/:id/sync | → `{ ok }` (asks the sync function to run this account now) |
| POST | /api/sync | → `{ ok }` (all due accounts now) |
| GET | /api/accounts/google/connect/start?accountId=&email= | 302 to Google consent (Gmail + Calendar read-only); `accountId` reconnects that account in place, `email` is the login hint |
| GET | /api/accounts/google/callback | 302 to `/#connections?connected=…` |
| GET | /api/accounts/:id/runs | → `{ startedAt, ok, error, durationMs }[]` last 20 |

## Data & export
| GET | /api/export | → JSON download of projects, tasks, history, links, folder map, usage, accounts (labels/meta only, no secrets), settings |
| POST | /api/data/clear-cache | → `{ ok }` (deletes snapshots, metrics, mail, calendar; keeps accounts; marks all due now) |
| POST | /api/data/delete | `{ confirm: "DELETE" }` → `{ ok }` (removes every table's rows incl. accounts/tokens; signs out) |

## Ingest (write-only key)
Header `Authorization: Bearer <HQ_INGEST_KEY>`. No cookie. The key can only write through these two endpoints and read nothing.
| GET | /api/ingest/ping | → `{ ok: true, machineHint }` |
| POST | /api/ingest | `SessionIngest` → `{ ok, projectId, unsorted }` ; `UsageIngest` → `{ ok, rows }` |

Session ingest rules: folder is normalized with `folderKey()`; a `folder_map` row is upserted; if it maps to a project (or a project id/name matches the key) the history row goes to that project and tasks are reconciled (done titles mark matching open tasks done or insert them done; open titles insert if not present). Otherwise history goes in with `project_id = null` and the folder shows in Unsorted. Fingerprint = `session:<sessionId>` (idempotent re-posts).
Usage ingest rules: each row upserts `usage_daily` on `(day, machine, folder_key, model)` with absolute totals.
