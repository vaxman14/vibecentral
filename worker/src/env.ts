export interface Env {
  ASSETS: Fetcher;
  APP_NAME?: string;          // shown in the UI, default "HQ"
  APP_ORIGIN?: string;        // optional; derived from the request when empty (workers.dev works)
  RP_ID?: string;             // optional; derived from APP_ORIGIN
  ALLOWED_GOOGLE_EMAILS?: string; // optional; empty = the first Google sign-in claims ownership
  OWNER_NAME?: string;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  HQ_MASTER_KEY: string;
  HQ_SYNC_SECRET: string;
  HQ_INGEST_KEY: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  RESEND_API_KEY?: string;
  ALERT_FROM?: string;
}

export type Vars = {
  userId: string;
  sessionId: string;
};
