// Rendering helpers ported from the mockup (statCard, tbl, pill, stages, area, lists, fields).
import { STAGES } from '@shared/types.ts';
import type { HistoryDTO, SeriesDTO, StatDTO, TaskDTO } from '@shared/types.ts';
import { esc } from '@shared/util.ts';

export { esc };

const TONES: Record<string, string> = {
  ready: 'good', published: 'good', live: 'good', active: 'good', healthy: 'good', connected: 'good', ok: 'good', success: 'good', approved: 'good', ready_for_sale: 'good', active_healthy: 'good', completed: 'good',
  building: 'warn', enqueued: 'warn', processing: 'warn', expiring: 'warn', waiting: 'warn', 'in review': 'warn', pending: 'warn', waiting_for_review: 'warn', in_review: 'warn', pending_developer_release: 'warn', new: 'warn', beta: 'warn', idea: 'warn', review: 'warn', queued: 'warn', in_progress: 'warn',
  failed: 'bad', error: 'bad', expired: 'bad', rejected: 'bad', failure: 'bad', cancelled: 'bad',
  paused: 'dim', inactive: 'dim', dim: 'dim',
};

export function tone(s: string | null | undefined): string {
  if (!s) return 'dim';
  return TONES[String(s).toLowerCase()] ?? 'dim';
}

export function pill(s: string | null | undefined, title?: string): string {
  const t = s ?? '—';
  return `<span class="pill ${tone(t)}"${title ? ` title="${esc(title)}"` : ''}>${esc(t)}</span>`;
}

export const stages = (i: number): string =>
  `<div class="stages" title="${STAGES[i] ?? ''}">${STAGES.map((_, k) => `<i class="${k <= i ? 'on' : ''}"></i>`).join('')}</div>`;

export const pi = (p: { name: string; color: string }): string =>
  `<div class="pi" style="background:${esc(p.color)}26;color:${esc(p.color)}">${esc(p.name[0] ?? '?')}</div>`;

/* ---------- charts (ported verbatim, with guards for empty / all-zero series) ---------- */
export function area(series: { c: string; d: number[] }[], labels: string[], h = 180): string {
  const W = 600, H = h, pl = 34, pb = 22, pt = 10;
  const raw = Math.max(0, ...series.flatMap((s) => s.d.map((v) => Number(v) || 0)));
  const max = (raw || 1) * 1.15;
  const n = Math.max(labels.length, 2);
  const x = (i: number) => pl + (W - pl - 8) * i / (n - 1), y = (v: number) => pt + (H - pt - pb) * (1 - v / max);
  let g = '';
  for (let k = 0; k <= 3; k++) { const v = max * k / 3, yy = y(v); g += `<line x1="${pl}" x2="${W - 8}" y1="${yy}" y2="${yy}" stroke="var(--border)"/><text x="${pl - 6}" y="${yy + 4}" text-anchor="end">${Math.round(v)}</text>`; }
  labels.forEach((l, i) => { if (i % 2 === 0 || i === labels.length - 1) g += `<text x="${x(i)}" y="${H - 4}" text-anchor="middle">${esc(l)}</text>`; });
  series.forEach((s) => {
    if (!s.d.length) return;
    const pts = s.d.map((v, i) => `${x(i)},${y(Number(v) || 0)}`).join(' ');
    g += `<polygon points="${pl},${y(0)} ${pts} ${x(s.d.length - 1)},${y(0)}" fill="${s.c}" opacity=".12"/><polyline points="${pts}" fill="none" stroke="${s.c}" stroke-width="2.2" stroke-linejoin="round"/><circle cx="${x(s.d.length - 1)}" cy="${y(Number(s.d.at(-1)) || 0)}" r="4" fill="${s.c}"/>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Chart">${g}</svg>`;
}

/** Legend + chart from a SeriesDTO. */
export function chart(s: SeriesDTO, h = 180): string {
  const legend = `<div class="legend">${s.series.map((x) => `<span><i style="background:var(--chart${x.color})"></i>${esc(x.name)}</span>`).join('')}</div>`;
  return legend + area(s.series.map((x) => ({ c: `var(--chart${x.color})`, d: x.data })), s.labels, h);
}

/* ---------- cards, tables, lists ---------- */
export const statCard = (i: number, ic: string, l: string, v: string | number, u: string | undefined, pct: number, s: string): string =>
  `<div class="card stat lift ${i === 1 ? 'first' : ''}"><div class="si" style="background:var(--si${i}b);color:var(--si${i}f)">${ic}</div><div class="lbl">${esc(l)}</div><div class="val">${esc(v)}${u ? ` <small>${esc(u)}</small>` : ''}</div><div class="ubar"><i style="width:${Math.max(0, Math.min(100, pct || 0))}%"></i></div><div class="sub">${esc(s)}</div></div>`;

export const stats = (list: StatDTO[], icons: string[]): string =>
  list.slice(0, 4).map((s, i) => statCard(i + 1, icons[i] ?? '•', s.label, s.value, s.unit, s.pct, s.sub)).join('');

export const tbl = (heads: string[], rows: (string | number)[][]): string =>
  `<div class="tw"><table><thead><tr>${heads.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;

export const taskList = (list: TaskDTO[], lim?: number): string =>
  `<div class="list">${list.slice(0, lim || 999).map((t) => `<div class="li ${t.done ? 'done' : ''}" data-task="${esc(t.id)}"><span class="chk ${t.done ? 'done' : ''}" role="checkbox" aria-checked="${t.done}" tabindex="0" title="${t.done ? 'Mark open' : 'Mark done'}">${t.done ? '✓' : ''}</span><div><span class="t">${esc(t.title)}</span><div class="meta"><span style="color:${esc(t.projectColor)}">● ${esc(t.projectName)}</span></div></div><span class="when">${esc(t.dueLabel ?? '')}</span></div>`).join('')}</div>`;

export const histList = (list: HistoryDTO[], lim?: number): string =>
  `<div class="list">${list.slice(0, lim || 999).map((h) => {
    const name = h.projectName ?? h.folder ?? 'Unsorted', color = h.projectColor ?? '#7E7994';
    return `<div class="li"><span class="src" style="background:${esc(color)}26;color:${esc(color)}">${esc(name[0] ?? '?')}</span><div>${esc(h.title)}<div class="meta">${esc(name)}${h.detail ? `<span>·</span><span>${esc(h.detail)}</span>` : ''}</div></div><span class="when">${esc(when(h.at))}</span></div>`;
  }).join('')}</div>`;

export const sw = (on: boolean, id?: string): string =>
  `<button type="button" class="sw ${on ? 'on' : ''}" role="switch" aria-checked="${on}"${id ? ` id="${id}"` : ''}></button>`;

export const fld = (b: string, s: string, ctl: string): string =>
  `<div class="field"><b>${b}</b><span>${s}</span><div class="ctl">${ctl}</div></div>`;

export const skeleton = (): string => `<div class="card"><p class="muted" style="margin:0">Loading…</p></div>`;
export const errorCard = (e: unknown): string => `<div class="card"><p class="muted" style="margin:0">Could not load: ${esc(e instanceof Error ? e.message : String(e))}</p></div>`;

/* ---------- formatting ---------- */
export const dash = (n: number | string | null | undefined): string => (n === null || n === undefined || n === '' ? '—' : typeof n === 'number' ? n.toLocaleString('en-US') : String(n));

export function timeOf(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

/** "8:24 PM" for today, "Nov 6" for this year, "Nov 6, 2025" otherwise. */
export function when(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso); if (isNaN(d.getTime())) return String(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return timeOf(iso);
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function dateOf(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export const dayName = (iso: string): string => new Date(iso).toLocaleDateString('en-US', { weekday: 'short' });

export function greeting(): string {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

export const STAGE_LABELS = ['Idea', 'Building', 'Beta', 'In review', 'Live'];

/** Wire task checkboxes inside root; `onToggle` receives the task id and the new done state. */
export function wireChecks(root: HTMLElement, onToggle: (id: string, done: boolean) => void): void {
  root.querySelectorAll<HTMLElement>('[data-task] .chk').forEach((c) => {
    const row = c.closest<HTMLElement>('[data-task]')!;
    const fire = () => onToggle(row.dataset.task!, !c.classList.contains('done'));
    c.onclick = (e) => { e.stopPropagation(); fire(); };
    c.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fire(); } };
  });
}

/** <select>/<input> typed by value only (workers-types' Element.remove() clashes with DOM HTMLSelectElement). */
export type ValueEl = HTMLElement & { value: string; disabled: boolean };
