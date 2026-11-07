import type { CalendarDTO, CalEventDTO } from '@shared/types.ts';
import { cached } from '../api.ts';
import type { ViewFn } from '../router.ts';
import { byAcct, $ } from '../state.ts';
import { dayName, esc, timeOf } from '../ui.ts';

const HIDE_KEY = 'hq-hidden-cals';
function hidden(): Set<string> { try { return new Set(JSON.parse(localStorage.getItem(HIDE_KEY) ?? '[]') as string[]); } catch { return new Set(); } }
function saveHidden(s: Set<string>): void { try { localStorage.setItem(HIDE_KEY, JSON.stringify([...s])); } catch { /* ignore */ } }

const row = (c: CalEventDTO, week: boolean) =>
  `<div class="li"><span class="dot" style="background:${esc(c.color)};margin-top:7px"></span><div><b style="font-weight:600">${esc(c.title)}</b><div class="meta">${esc(c.calendar)}</div></div><span class="when">${week ? esc(dayName(c.startsAt)) + ' · ' : ''}${c.allDay ? 'All day' : esc(timeOf(c.startsAt))}</span></div>`;

export const calendar: ViewFn = async (ctx) => {
  const d = await cached<CalendarDTO>('/api/calendar');
  if (!ctx.alive()) return;
  let tab: 'today' | 'week' = 'today';
  const visible = (list: CalEventDTO[]) => { const h = hidden(); return byAcct(list).filter((c) => !h.has(calKey(c))); };
  const calKey = (c: CalEventDTO) => d.calendars.find((k) => k.name === c.calendar && k.account === c.account)?.id ?? c.calendar;
  const draw = () => {
    const list = visible(tab === 'today' ? d.today : d.week);
    ctx.root.querySelector('#calBox')!.innerHTML = list.length ? `<div class="list">${list.map((c) => row(c, tab === 'week')).join('')}</div>` : `<p class="muted" style="margin:0">${tab === 'today' ? 'Nothing on the calendar today.' : 'Nothing this week.'}</p>`;
  };
  ctx.root.innerHTML = `<div class="tabs" id="calTabs"><button class="on" type="button" data-t="today">Today</button><button type="button" data-t="week">This week</button><button type="button" id="calMenu">All calendars ▾</button></div><div class="card" id="calBox"></div>`;
  draw();
  ctx.root.querySelectorAll<HTMLButtonElement>('#calTabs [data-t]').forEach((b) => (b.onclick = () => { ctx.root.querySelectorAll('#calTabs [data-t]').forEach((x) => x.classList.toggle('on', x === b)); tab = b.dataset.t as 'today' | 'week'; draw(); }));
  const mb = ctx.root.querySelector<HTMLButtonElement>('#calMenu')!;
  const drawMenu = () => {
    const L = $('#layer');
    const r = mb.getBoundingClientRect();
    const h = hidden();
    const cals = d.calendars;
    L.innerHTML = `<div class="menu" role="menu" style="right:auto;left:${Math.round(r.left + scrollX)}px;top:${Math.round(r.bottom + scrollY + 6)}px"><div class="h">CALENDARS</div>${cals.length ? cals.map((k) => `<button type="button" data-c="${esc(k.id)}"><span class="chk ${h.has(k.id) ? '' : 'done'}" style="border-color:${esc(k.color)};${h.has(k.id) ? '' : `background:${esc(k.color)}`}">${h.has(k.id) ? '' : '✓'}</span>${esc(k.name)}<small class="faint" style="margin-left:auto">${esc(k.account)}</small></button>`).join('') : '<p class="muted" style="padding:8px 10px;margin:0;font-size:13px">No calendars synced yet.</p>'}</div>`;
    L.querySelectorAll<HTMLButtonElement>('[data-c]').forEach((b) => (b.onclick = (ev) => {
      ev.stopPropagation();
      const s = hidden(); if (s.has(b.dataset.c!)) s.delete(b.dataset.c!); else s.add(b.dataset.c!); saveHidden(s);
      draw(); drawMenu();
    }));
  };
  mb.onclick = (e) => {
    e.stopPropagation();
    const L = $('#layer');
    if (L.querySelector('.menu')) { L.innerHTML = ''; return; }
    drawMenu();
  };
};
