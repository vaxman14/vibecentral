import type { OverviewDTO } from '@shared/types.ts';
import { cached, patch, invalidate } from '../api.ts';
import type { ViewFn } from '../router.ts';
import { state } from '../state.ts';
import { chart, esc, greeting, histList, pill, STAGE_LABELS, stats, taskList, tbl, timeOf, wireChecks } from '../ui.ts';
import { toast } from '../dialogs.ts';

export const overview: ViewFn = async (ctx) => {
  const d = await cached<OverviewDTO>('/api/overview');
  if (!ctx.alive()) return;
  const name = d.greetingName || state.me?.user.name.split(' ')[0] || '';
  const today = d.today.filter((c) => !state.filter.accountId || c.accountId === state.filter.accountId);
  ctx.root.innerHTML = `
  <div class="hero"><h3>${esc(greeting())}, ${esc(name)}</h3><p>${esc(d.summary)}</p><div class="mark"><img src="/mascot.svg" alt=""></div></div>
  ${d.notes.length ? `<div class="note">⚑ ${d.notes.map((n) => esc(n).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')).join(' ')}</div>` : ''}
  <div class="grid g4">${stats(d.stats, ['▦', '✓', '$', '✦'])}</div>
  <div class="grid g2 row">
   <div class="card"><h2>Traffic across your domains</h2>${chart(d.traffic)}</div>
   <div class="card"><h2>System health</h2><div class="health">
    ${d.health.map((r) => `<div class="hrow"><span>${esc(r.label)}</span><span class="pill ${r.tone}">${esc(r.value)}</span></div>`).join('')}
   </div></div></div>
  <div class="grid g2 row">
   <div class="card"><h2>Projects</h2>${tbl(['Project', 'Stage', 'Open', 'Last update'], d.projects.slice(0, 6).map((p) => [`<a href="#p-${esc(p.id)}" style="color:inherit"><b>${esc(p.name)}</b></a>`, pill(STAGE_LABELS[p.stage] ?? ''), p.open, `<span class="muted">${esc(p.latest?.title ?? '—')}</span>`]))}</div>
   <div class="card"><h2>Today</h2>${today.length ? `<div class="list">${today.slice(0, 4).map((c) => `<div class="li"><span class="dot" style="background:${esc(c.color)};margin-top:7px"></span><div>${esc(c.title)}<div class="meta">${esc(c.calendar)}</div></div><span class="when">${c.allDay ? 'All day' : esc(timeOf(c.startsAt))}</span></div>`).join('')}</div>` : '<p class="muted" style="margin:0">Nothing on the calendar today.</p>'}</div></div>
  <div class="grid g11 row"><div class="card"><h2>Open tasks</h2>${d.openTasks.length ? taskList(d.openTasks, 5) : '<p class="muted" style="margin:0">No open tasks.</p>'}</div><div class="card"><h2>Recent history</h2>${d.history.length ? histList(d.history, 5) : '<p class="muted" style="margin:0">Nothing yet.</p>'}</div></div>`;
  wireChecks(ctx.root, async (id, done) => {
    try { await patch(`/api/tasks/${id}`, { done }); invalidate('/api/overview', '/api/tasks', '/api/projects', '/api/me'); ctx.refresh(); }
    catch (e) { toast(e instanceof Error ? e.message : String(e), 'bad'); }
  });
};
