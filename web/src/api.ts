// Typed fetch wrapper for the Worker API (docs/API.md). 401 hands over to the sign-in screen.
// In dev with ?mock=1 the requests are answered by fixtures (mock.ts, loaded lazily and tree-shaken from prod).

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';
type MockFn = (method: Method, path: string, body?: unknown) => Promise<unknown>;

let mock: MockFn | null = null;
let onUnauthorized: (() => void) | null = null;

export function setUnauthorizedHandler(fn: () => void): void { onUnauthorized = fn; }

export const isMock = (): boolean => mock !== null;

/** Must run once before the first request. */
export async function initApi(): Promise<void> {
  if (import.meta.env.DEV && new URLSearchParams(location.search).has('mock')) {
    const m = await import('./mock.ts');
    mock = m.mockRequest as MockFn;
  }
}

async function request<T>(method: Method, path: string, body?: unknown): Promise<T> {
  if (mock) return mock(method, path, body) as Promise<T>;
  const init: RequestInit = { method, credentials: 'same-origin', headers: {} };
  if (body !== undefined) {
    (init.headers as Record<string, string>)['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let res: Response;
  try { res = await fetch(path, init); } catch { throw new ApiError(0, 'Network error'); }
  if (res.status === 401 && !path.startsWith('/api/auth/')) {
    onUnauthorized?.();
    throw new ApiError(401, 'unauthorized');
  }
  const text = await res.text();
  let data: unknown = null;
  if (text) { try { data = JSON.parse(text); } catch { data = text; } }
  if (!res.ok) {
    const msg = (data && typeof data === 'object' && 'error' in data) ? String((data as { error: unknown }).error) : `${res.status} ${res.statusText}`;
    throw new ApiError(res.status, msg);
  }
  return data as T;
}

export const get = <T>(path: string) => request<T>('GET', path);
export const post = <T>(path: string, body?: unknown) => request<T>('POST', path, body);
export const patch = <T>(path: string, body?: unknown) => request<T>('PATCH', path, body);
export const del = <T>(path: string) => request<T>('DELETE', path);

// ---------- per-path in-memory cache (30s by default) ----------
const cache = new Map<string, { at: number; data: unknown; p?: Promise<unknown> }>();

export async function cached<T>(path: string, ttl = 30_000): Promise<T> {
  const hit = cache.get(path);
  const now = Date.now();
  if (hit && hit.data !== undefined && now - hit.at < ttl) return hit.data as T;
  if (hit?.p) return hit.p as Promise<T>;
  const p = get<T>(path).then((data) => { cache.set(path, { at: Date.now(), data }); return data; }, (e) => { cache.delete(path); throw e; });
  cache.set(path, { at: now, data: hit?.data, p });
  return p;
}

/** Drop cached entries whose path starts with any prefix (no args = everything). */
export function invalidate(...prefixes: string[]): void {
  if (!prefixes.length) { cache.clear(); return; }
  for (const k of [...cache.keys()]) if (prefixes.some((p) => k.startsWith(p))) cache.delete(k);
}
