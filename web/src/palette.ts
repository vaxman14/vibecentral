// Command palette (Cmd/Ctrl+K), exactly as the mockup. Items = NAV pages + /api/search results (cached 60s).
import type { SearchItem } from '@shared/types.ts';
import { esc } from '@shared/util.ts';
import { cached } from './api.ts';
import { NAV } from './router.ts';
import { $ } from './state.ts';

const PAGES: SearchItem[] = NAV.map((n) => ({ t: n[2], k: 'Page', h: '#' + n[0], i: n[1] }));

export function openPal(): void {
  const L = $('#layer');
  L.innerHTML = `<div class="pal-bg"><div class="pal" role="dialog" aria-label="Search"><input id="palIn" placeholder="Search projects, domains, tasks, mail…" autocomplete="off"><div class="res" id="palRes"></div></div></div>`;
  const inp = $<HTMLInputElement>('#palIn'), res = $('#palRes');
  let sel = 0, cur: SearchItem[] = [], ITEMS: SearchItem[] = PAGES;
  const go = (h: string) => { location.hash = h; L.innerHTML = ''; };
  const draw = () => {
    const q = inp.value.toLowerCase();
    cur = ITEMS.filter((x) => x.t.toLowerCase().includes(q)).slice(0, 12);
    sel = Math.max(0, Math.min(sel, cur.length - 1));
    res.innerHTML = cur.length
      ? cur.map((x, i) => `<button type="button" class="${i === sel ? 'sel' : ''}" data-h="${esc(x.h)}"><span class="faint">${x.i}</span>${esc(x.t)}${x.sub ? ` <span class="faint">${esc(x.sub)}</span>` : ''}<small>${esc(x.k)}</small></button>`).join('')
      : '<p class="muted" style="padding:10px 12px;margin:0;font-size:14px">Nothing matches that.</p>';
    res.querySelectorAll<HTMLButtonElement>('button').forEach((b) => (b.onclick = () => go(b.dataset.h!)));
  };
  inp.oninput = () => { sel = 0; draw(); };
  inp.onkeydown = (e) => {
    if (e.key === 'ArrowDown') { sel = Math.min(sel + 1, cur.length - 1); draw(); e.preventDefault(); }
    if (e.key === 'ArrowUp') { sel = Math.max(sel - 1, 0); draw(); e.preventDefault(); }
    if (e.key === 'Enter' && cur[sel]) go(cur[sel].h);
    if (e.key === 'Escape') L.innerHTML = '';
  };
  L.querySelector<HTMLElement>('.pal-bg')!.onclick = (e) => { if ((e.target as HTMLElement).classList.contains('pal-bg')) L.innerHTML = ''; };
  draw(); inp.focus();
  cached<SearchItem[]>('/api/search', 60_000).then((items) => {
    if (!document.body.contains(inp)) return;
    ITEMS = [...PAGES, ...(Array.isArray(items) ? items : [])];
    draw();
  }).catch(() => { /* pages still work */ });
}

export function initPalette(): void {
  $('#openPal').onclick = openPal;
  window.addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPal(); } });
}
