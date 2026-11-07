// Account switcher (#devBtn menu) built from MeDTO.accounts, grouped by provider like the mockup.
import { PROVIDERS } from '@shared/types.ts';
import type { Provider } from '@shared/types.ts';
import { esc } from '@shared/util.ts';
import { render } from './router.ts';
import { setFilter, state, $ } from './state.ts';

export function drawFilterLabel(): void {
  const f = state.filter.label;
  $('#devLbl').textContent = f.length > 22 ? f.slice(0, 21) + '…' : f;
}

export function initSwitcher(): void {
  drawFilterLabel();
  $('#devBtn').onclick = (e) => {
    e.stopPropagation();
    const L = $('#layer');
    if (L.innerHTML) { L.innerHTML = ''; return; }
    const accounts = state.me?.accounts ?? [];
    const groups = (Object.keys(PROVIDERS) as Provider[]).map((p) => ({ p, list: accounts.filter((a) => a.provider === p) })).filter((g) => g.list.length);
    L.innerHTML = `<div class="menu" role="menu"><div class="h">SHOW</div><button type="button" data-a="" data-l="All accounts"><span class="dot"></span>All accounts</button>${groups.map((g) => `<div class="h">${esc(PROVIDERS[g.p].name.toUpperCase())}</div>${g.list.map((a) => `<button type="button" data-a="${esc(a.id)}" data-l="${esc(PROVIDERS[g.p].name + ' · ' + a.label)}"><span class="dot"${a.status === 'ok' ? '' : ` style="background:var(--${a.status === 'pending' ? 'warning' : 'danger'})"`}></span>${esc(a.label)}</button>`).join('')}`).join('')}</div>`;
    L.querySelectorAll<HTMLButtonElement>('[data-a]').forEach((b) => (b.onclick = () => {
      setFilter({ accountId: b.dataset.a || null, label: b.dataset.l! });
      drawFilterLabel();
      L.innerHTML = '';
      render();
    }));
  };
  document.addEventListener('click', (e) => { const L = $('#layer'); if (L.querySelector('.menu') && !(e.target as HTMLElement).closest('.menu')) L.innerHTML = ''; });
}
