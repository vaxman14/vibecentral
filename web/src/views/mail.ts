import type { MailDTO } from '@shared/types.ts';
import { cached } from '../api.ts';
import type { ViewFn } from '../router.ts';
import { byAcct } from '../state.ts';
import { esc, when } from '../ui.ts';

export const mail: ViewFn = async (ctx) => {
  const d = await cached<MailDTO>('/api/mail');
  if (!ctx.alive()) return;
  const tabs: { k: string; l: string }[] = [{ k: 'important', l: 'Important' }, { k: 'all', l: 'All inboxes' }, ...d.accounts.map((a) => ({ k: a.id, l: a.email }))];
  const pick = (k: string) => {
    const base = byAcct(d.items);
    return k === 'important' ? base.filter((m) => m.important) : k === 'all' ? base : base.filter((m) => m.accountId === k);
  };
  const list = (k: string) => {
    const items = pick(k);
    return items.length ? `<div class="list">${items.map((m) => `<div class="li"${m.unread ? '' : ' style="opacity:.8"'}><span class="src" style="background:${esc(m.color)}26;color:${esc(m.color)}">${esc(m.initial)}</span><div><b style="font-weight:600">${esc(m.from)}</b> <span class="muted">${esc(m.subject)}</span><div class="meta">${esc(m.account)}${m.snippet ? `<span>·</span><span>${esc(m.snippet)}</span>` : ''}</div></div><span class="when">${esc(when(m.at))}</span></div>`).join('')}</div>` : '<p class="muted" style="margin:0">Nothing here.</p>';
  };
  ctx.root.innerHTML = `<div class="tabs" id="mailTabs">${tabs.map((t, i) => `<button type="button" class="${i ? '' : 'on'}" data-k="${esc(t.k)}">${esc(t.l)}</button>`).join('')}</div><div class="card" id="mailBox">${list('important')}</div>`;
  const tt = ctx.root.querySelector('#mailTabs')!, box = ctx.root.querySelector('#mailBox')!;
  tt.querySelectorAll<HTMLButtonElement>('button').forEach((b) => (b.onclick = () => { tt.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); box.innerHTML = list(b.dataset.k!); }));
};
