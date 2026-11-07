-- HQ schema. Everything lives in public with RLS enabled and no policies,
-- so only the service role (Worker + Edge Functions) can read or write.
create extension if not exists pgcrypto;
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ---------- the one user ----------
create table if not exists hq_user (
  id uuid primary key default gen_random_uuid(),
  name text not null default '',
  emails text[] not null default '{}',   -- filled by the first Google sign-in (or ALLOWED_GOOGLE_EMAILS)
  tz text not null default 'America/Los_Angeles',
  start_page text not null default 'overview',
  session_days int not null default 30,
  sync_minutes int not null default 5,
  mail_lookback_days int not null default 14,
  pull_sessions boolean not null default true,
  theme text not null default 'dark',
  density text not null default 'comfortable',
  quiet_start text not null default '22:00',
  quiet_end text not null default '08:00',
  notifications jsonb not null default '{"failedDeploys":true,"domainExpiry":true,"appReview":true,"newRevenue":false,"tokenFailure":true,"syncErrors":false,"newBuilds":false}'::jsonb,
  alert_to text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists passkeys (
  id text primary key,                 -- credential id, base64url
  user_id uuid not null references hq_user(id) on delete cascade,
  public_key text not null,            -- base64url COSE key
  counter bigint not null default 0,
  transports text[] not null default '{}',
  device_type text,
  backed_up boolean not null default false,
  label text not null default 'Passkey',
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);

create table if not exists webauthn_challenges (
  id uuid primary key default gen_random_uuid(),
  challenge text not null,
  kind text not null check (kind in ('register','login')),
  expires_at timestamptz not null
);

create table if not exists sessions (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  user_id uuid not null references hq_user(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  last_seen_at timestamptz not null default now(),
  user_agent text,
  ip text,
  device_label text,
  method text not null default 'google' check (method in ('google','passkey'))
);

create table if not exists oauth_states (
  state text primary key,
  kind text not null check (kind in ('signin','connect','reconnect')),
  provider text not null default 'google',
  account_id uuid,
  data jsonb not null default '{}'::jsonb,
  expires_at timestamptz not null
);

-- ---------- providers & accounts ----------
create table if not exists accounts (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('cloudflare','netlify','supabase','stripe','paypal','google','github','appstore','googleplay','anthropic')),
  label text not null,
  secret_enc text,                      -- AES-256-GCM blob of a JSON object with the provider secrets
  meta jsonb not null default '{}'::jsonb, -- non-secret config: emails, account ids, bucket, org name
  status text not null default 'pending' check (status in ('pending','ok','error','expired')),
  last_sync_at timestamptz,
  last_sync_ms int,
  last_error text,
  next_sync_at timestamptz not null default now(),
  sync_minutes int,                     -- null = use hq_user.sync_minutes
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists accounts_due on accounts(next_sync_at);

create table if not exists sync_runs (
  id bigserial primary key,
  account_id uuid not null references accounts(id) on delete cascade,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  ok boolean,
  error text,
  duration_ms int
);
create index if not exists sync_runs_acct on sync_runs(account_id, started_at desc);

-- Latest normalized payload per account per kind (zones, dns, workers, tunnels, sites, deploys, projects, ...).
create table if not exists snapshots (
  account_id uuid not null references accounts(id) on delete cascade,
  kind text not null,
  data jsonb not null,
  fetched_at timestamptz not null default now(),
  primary key (account_id, kind)
);

-- Per-day series for charts (traffic, deploys, revenue, api spend, ...).
create table if not exists metrics (
  account_id uuid not null references accounts(id) on delete cascade,
  kind text not null,
  day date not null,
  values jsonb not null,
  primary key (account_id, kind, day)
);

-- Mail headers only. Bodies are never stored.
create table if not exists mail_items (
  account_id uuid not null references accounts(id) on delete cascade,
  message_id text not null,
  thread_id text,
  from_name text,
  from_email text,
  subject text,
  snippet text,
  received_at timestamptz not null,
  important boolean not null default false,
  unread boolean not null default true,
  labels text[] not null default '{}',
  primary key (account_id, message_id)
);
create index if not exists mail_recent on mail_items(received_at desc);

create table if not exists cal_events (
  account_id uuid not null references accounts(id) on delete cascade,
  event_id text not null,
  calendar_id text not null,
  calendar_name text,
  color text,
  title text not null,
  starts_at timestamptz not null,
  ends_at timestamptz,
  all_day boolean not null default false,
  primary key (account_id, event_id)
);
create index if not exists cal_upcoming on cal_events(starts_at);

-- ---------- projects, tasks, history ----------
create table if not exists projects (
  id text primary key,                 -- slug
  name text not null,
  color text not null default '#B9A5FF',
  stage int not null default 0 check (stage between 0 and 4), -- Idea, Building, Beta, Review, Live
  blurb text not null default '',
  sort int not null default 100,
  archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Things linked to a project: a Cloudflare zone, a Netlify site, a Supabase project, a store app, a GitHub repo, a Stripe account...
create table if not exists project_links (
  id uuid primary key default gen_random_uuid(),
  project_id text not null references projects(id) on delete cascade,
  kind text not null check (kind in ('domain','site','database','app','repo','account','worker','tunnel')),
  account_id uuid references accounts(id) on delete cascade,
  ref text not null,                   -- zone name, site id, project ref, bundle id / package name, owner/repo
  label text not null,
  created_at timestamptz not null default now(),
  unique (project_id, kind, ref)
);

create table if not exists tasks (
  id uuid primary key default gen_random_uuid(),
  project_id text not null references projects(id) on delete cascade,
  title text not null,
  done boolean not null default false,
  due_label text,                      -- free text: Today, This week, Nov 10, Waiting on you
  source text not null default 'manual' check (source in ('manual','session')),
  session_id text,
  machine text,
  created_at timestamptz not null default now(),
  done_at timestamptz,
  updated_at timestamptz not null default now()
);
create index if not exists tasks_proj on tasks(project_id, done, created_at desc);

create table if not exists history (
  id uuid primary key default gen_random_uuid(),
  project_id text references projects(id) on delete cascade, -- null = unsorted (session from an unmapped folder)
  kind text not null check (kind in ('manual','session','provider','alert','system')),
  title text not null,
  detail text,
  occurred_at timestamptz not null default now(),
  source text,                         -- provider name, 'claude-code', 'you'
  machine text,
  branch text,
  session_id text,
  folder text,
  fingerprint text unique,             -- dedupe key for provider events and session posts
  created_at timestamptz not null default now()
);
create index if not exists history_proj on history(project_id, occurred_at desc);
create index if not exists history_recent on history(occurred_at desc);

-- Folder -> project mapping used by the session hook and the usage agent. Unmapped rows are the "Unsorted" list.
create table if not exists folder_map (
  id uuid primary key default gen_random_uuid(),
  folder_key text not null unique,     -- normalized folder name (lowercase, no spaces/dashes)
  folder_name text not null,           -- as seen
  machine text,
  project_id text references projects(id) on delete set null,
  sessions int not null default 0,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now()
);

-- ---------- Claude Code subscription usage (counts only) ----------
create table if not exists usage_daily (
  day date not null,
  machine text not null,
  folder_key text not null,
  folder_name text not null,
  model text not null,
  input_tokens bigint not null default 0,
  output_tokens bigint not null default 0,
  cache_read_tokens bigint not null default 0,
  cache_write_tokens bigint not null default 0,
  messages int not null default 0,
  sessions int not null default 0,
  updated_at timestamptz not null default now(),
  primary key (day, machine, folder_key, model)
);

create table if not exists agent_heartbeats (
  machine text primary key,
  last_seen timestamptz not null default now(),
  agent_version text,
  files_tracked int
);

-- ---------- alerts ----------
create table if not exists alerts (
  id uuid primary key default gen_random_uuid(),
  fingerprint text not null unique,
  kind text not null,                  -- failed_deploy, domain_expiry, app_review, token_failure, sync_error, new_revenue, new_build
  urgent boolean not null default false,
  title text not null,
  body text not null,
  project_id text references projects(id) on delete set null,
  account_id uuid references accounts(id) on delete set null,
  created_at timestamptz not null default now(),
  send_after timestamptz not null default now(),
  sent_at timestamptz,
  status text not null default 'pending' check (status in ('pending','held','sent','failed','suppressed')),
  error text
);
create index if not exists alerts_pending on alerts(status, send_after);

-- ---------- RLS: lock everything to the service role ----------
do $$ declare t text; begin
  for t in select tablename from pg_tables where schemaname='public' loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

-- ---------- seed ----------
insert into hq_user default values;

-- no seed projects: add yours under Projects

-- ---------- sync tick: every minute, call the sync Edge Function ----------
-- Before this works, store two secrets in Vault (run once in the SQL editor):
--   select vault.create_secret('https://<project-ref>.supabase.co', 'hq_project_url');
--   select vault.create_secret('<the same value as HQ_SYNC_SECRET>', 'hq_sync_secret');
create or replace function hq_sync_tick() returns void language plpgsql security definer as $$
declare url text; key text; begin
  select decrypted_secret into url from vault.decrypted_secrets where name='hq_project_url' limit 1;
  select decrypted_secret into key from vault.decrypted_secrets where name='hq_sync_secret' limit 1;
  if url is null or key is null then return; end if;
  perform net.http_post(
    url := url || '/functions/v1/sync',
    headers := jsonb_build_object('Content-Type','application/json','x-hq-sync-key',key),
    body := '{"source":"cron"}'::jsonb,
    timeout_milliseconds := 140000);
end $$;

select cron.schedule('hq-sync-tick', '* * * * *', 'select hq_sync_tick()');

-- housekeeping: expired challenges/states/sessions, old sync runs
select cron.schedule('hq-housekeeping', '17 * * * *', $$
  delete from webauthn_challenges where expires_at < now();
  delete from oauth_states where expires_at < now();
  delete from sessions where expires_at < now();
  delete from sync_runs where started_at < now() - interval '14 days';
  delete from mail_items where received_at < now() - interval '60 days';
  delete from cal_events where starts_at < now() - interval '30 days';
$$);

-- used by Settings → Data & export → Delete everything
create or replace function hq_truncate(tbl text) returns void language plpgsql security definer as $$
begin
  if tbl !~ '^[a-z_]+$' then raise exception 'bad table'; end if;
  execute format('delete from public.%I', tbl);
end $$;
revoke all on function hq_truncate(text) from public, anon, authenticated;
