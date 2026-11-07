import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Env } from './env.ts';

export type Db = SupabaseClient;

export function db(env: Env): Db {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) throw new HttpError(500, 'Supabase is not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)');
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (input, init) => fetch(input, init) },
  });
}

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/** Unwrap a supabase-js result or throw an HttpError with a readable message. */
export function unwrap<T>(r: { data: T | null; error: { message: string; code?: string; details?: string } | null }, what = 'query'): T {
  if (r.error) throw new HttpError(500, `${what} failed: ${r.error.message}${r.error.details ? ' (' + r.error.details + ')' : ''}`);
  return r.data as T;
}

export async function one<T>(p: PromiseLike<any>, what = 'query'): Promise<T | null> {
  const r = (await p) as { data: T | null; error: any };
  if (r.error) {
    if (r.error.code === 'PGRST116') return null; // no rows
    throw new HttpError(500, `${what} failed: ${r.error.message}`);
  }
  return r.data;
}

export async function many<T>(p: PromiseLike<any>, what = 'query'): Promise<T[]> {
  const r = (await p) as { data: T[] | null; error: any };
  if (r.error) throw new HttpError(500, `${what} failed: ${r.error.message}`);
  return r.data ?? [];
}

/** The single hq_user row (created by the migration). */
export interface UserRow {
  id: string; name: string; emails: string[]; tz: string; start_page: string; session_days: number; sync_minutes: number;
  mail_lookback_days: number; pull_sessions: boolean; theme: string; density: string; quiet_start: string; quiet_end: string;
  notifications: Record<string, boolean>; alert_to: string; created_at: string; updated_at: string;
}
export async function getUser(d: Db): Promise<UserRow> {
  const u = await one<UserRow>(d.from('hq_user').select('*').limit(1).single(), 'load user');
  if (!u) {
    const created = await one<UserRow>(d.from('hq_user').insert({}).select('*').single(), 'create user');
    if (!created) throw new HttpError(500, 'could not create user row');
    return created;
  }
  return u;
}
