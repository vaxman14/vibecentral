// Global client state: who is signed in, the account filter, and tiny helpers.
import type { MeDTO, Settings } from '@shared/types.ts';

export interface Filter { accountId: string | null; label: string }

const FILTER_KEY = 'hq-filter';

function loadFilter(): Filter {
  try {
    const raw = sessionStorage.getItem(FILTER_KEY);
    if (raw) {
      const f = JSON.parse(raw) as Filter;
      if (f && typeof f.label === 'string') return f;
    }
  } catch { /* ignore */ }
  return { accountId: null, label: 'All accounts' };
}

export const state: { me: MeDTO | null; filter: Filter } = {
  me: null,
  filter: loadFilter(),
};

export function setFilter(f: Filter): void {
  state.filter = f;
  try { sessionStorage.setItem(FILTER_KEY, JSON.stringify(f)); } catch { /* ignore */ }
}

export function settings(): Settings | null {
  return state.me?.settings ?? null;
}

/** Filter rows by the account switcher. Rows without an accountId pass through untouched. */
export function byAcct<T extends { accountId?: string | null }>(rows: T[]): T[] {
  const id = state.filter.accountId;
  if (!id) return rows;
  return rows.filter((r) => r.accountId == null || r.accountId === id);
}

export const $ = <T extends Element = HTMLElement>(s: string): T => document.querySelector(s) as T;
