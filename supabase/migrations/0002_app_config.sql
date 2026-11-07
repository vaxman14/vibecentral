-- App-level keys that can be entered from Settings → Setup keys instead of env vars.
-- Values are AES-256-GCM encrypted with HQ_MASTER_KEY (same scheme as accounts.secret_enc).
-- Env vars remain the fallback; a row here wins over the env var of the same name.
create table if not exists app_config (
  key text primary key,          -- google_client_id, google_client_secret, resend_api_key, alert_from
  value_enc text not null,
  updated_at timestamptz not null default now()
);
alter table app_config enable row level security;
