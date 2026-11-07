import type { HistoryDTO, ProjectDTO, UnsortedDTO } from '@shared/types.ts';
import { ago } from '@shared/util.ts';
import { cached, invalidate, patch } from '../api.ts';
import { toast } from '../dialogs.ts';
import type { ViewFn } from '../router.ts';
import { esc, histList } from '../ui.ts';
import type { ValueEl } from '../ui.ts';

export const history: ViewFn = async (ctx) => {
  const [H, U, P] = await Promise.all([cached<HistoryDTO[]>('/api/history?limit=200'), cached<UnsortedDTO[]>('/api/unsorted'), cached<ProjectDTO[]>('/api/projects')]);
  if (!ctx.alive()) return;
  const unsorted = U.filter((u) => !u.projectId);
  ctx.root.innerHTML = `${unsorted.length ? `<div class="card row" style="margin-top:0"><h2>Unsorted sessions</h2><p class="muted" style="margin:0 0 8px;font-size:14px">Claude Code folders that don't map to a project yet. Pick one and their history moves over.</p><div class="list">${unsorted.map((u) => `<div class="li"><span class="src" style="background:var(--pdb);color:var(--muted)">${esc(u.folderName[0] ?? '?')}</span><div><b style="font-weight:600">${esc(u.folderName)}</b><div class="meta"><span>${esc(u.machine ?? 'unknown machine')}</span><span>·</span><span>${u.sessions} session${u.sessions === 1 ? '' : 's'}</span><span>·</span><span>last seen ${esc(ago(u.lastSeen))}</span></div></div><select class="in" data-u="${esc(u.id)}" style="margin-left:auto;padding:6px 10px"><option value="">Assign to project…</option>${P.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select></div>`).join('')}</div></div>` : ''}
  <div class="card">${H.length ? histList(H) : '<p class="muted" style="margin:0">No history yet. Updates, deploys, merges and Claude Code sessions land here.</p>'}</div>`;
  ctx.root.querySelectorAll<ValueEl>('[data-u]').forEach((s) => (s.onchange = async () => {
    if (!s.value) return;
    s.disabled = true;
    try { await patch(`/api/unsorted/${s.dataset.u}`, { projectId: s.value }); invalidate('/api/unsorted', '/api/history', '/api/projects', '/api/tasks', '/api/overview', '/api/me', '/api/claude'); toast('Folder assigned'); ctx.refresh(); }
    catch (e) { s.disabled = false; toast(String((e as Error).message), 'bad'); }
  }));
};
