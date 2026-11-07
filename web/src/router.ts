// Hash routing exactly like the mockup: #overview, #projects, #p-<id>, #tasks, ... Start page from settings when the hash is empty.
import { state, $ } from './state.ts';
import { views } from './views/index.ts';
import { errorCard, esc, skeleton } from './ui.ts';

export const NAV: [string, string, string][] = [
  ['overview', '◈', 'Overview'], ['projects', '▦', 'Projects'], ['tasks', '✓', 'Tasks'], ['history', '☰', 'History'],
  ['domains', '◎', 'Domains & DNS'], ['sites', '◆', 'Sites & deploys'], ['databases', '▤', 'Databases'], ['revenue', '$', 'Revenue'], ['stores', '▸', 'App stores'],
  ['calendar', '▥', 'Calendar'], ['mail', '✉', 'Mail'], ['claude', '✦', 'Claude usage'], ['connections', '⬡', 'Connections'], ['prefs', '⚙', 'Settings'], ['help', '?', 'Help'],
];
export const TITLES: Record<string, string> = Object.fromEntries(NAV.map((n) => [n[0], n[2]]));

export interface ViewCtx {
  root: HTMLElement;
  alive: () => boolean;      // false once another render started
  param: string;             // project id for #p-<id>
  query: URLSearchParams;    // e.g. #connections?connected=…
  setTitle: (t: string) => void;
  refresh: () => void;       // re-render this view (after a mutation)
}
export type ViewFn = (ctx: ViewCtx) => Promise<void>;

export function parseHash(): { page: string; pid: string | null; query: URLSearchParams } {
  let raw = location.hash.slice(1);
  let qs = '';
  const qi = raw.indexOf('?');
  if (qi >= 0) { qs = raw.slice(qi + 1); raw = raw.slice(0, qi); }
  if (!raw) {
    const sp = (state.me?.settings.startPage ?? 'overview').toLowerCase().replace(/[^a-z]/g, '');
    raw = TITLES[sp] ? sp : 'overview';
  }
  let pid: string | null = null;
  if (raw.startsWith('p-')) { pid = raw.slice(2); raw = 'project'; }
  else if (!views[raw]) raw = 'overview';
  return { page: raw, pid, query: new URLSearchParams(qs) };
}

function navCount(key: string): number | undefined {
  const c = state.me?.counts;
  if (!c) return undefined;
  if (key === 'projects') return c.projects || undefined;
  if (key === 'tasks') return c.openTasks || undefined;
  if (key === 'mail') return c.mail || undefined;
  return undefined;
}

export function drawNav(active: string): void {
  $('#nav').innerHTML = NAV.map((n) => {
    const cnt = navCount(n[0]);
    return `<a href="#${n[0]}" class="${active === n[0] ? 'active' : ''}"><span class="icon">${n[1]}</span>${n[2]}${cnt ? `<span class="cnt">${cnt}</span>` : ''}</a>`;
  }).join('');
}

let seq = 0;

export async function render(): Promise<void> {
  const my = ++seq;
  const { page, pid, query } = parseHash();
  drawNav(pid ? 'projects' : page);
  $('#title').textContent = pid ? '' : TITLES[page];
  const root = $('#view');
  root.innerHTML = skeleton();
  window.scrollTo(0, 0);
  const ctx: ViewCtx = {
    root, param: pid ?? '', query,
    alive: () => my === seq,
    setTitle: (t) => { if (my === seq) $('#title').textContent = t; },
    refresh: () => { if (my === seq) render(); },
  };
  try {
    await views[page](ctx);
  } catch (e) {
    if (my !== seq) return;
    if ((e as { status?: number }).status === 401) return;
    root.innerHTML = errorCard(e);
    console.error(e);
  }
}

export const titleOf = (page: string): string => esc(TITLES[page] ?? page);
