import type { ProjectDTO, TaskDTO } from '@shared/types.ts';
import { cached, invalidate, patch, post } from '../api.ts';
import { f, openDialog, toast } from '../dialogs.ts';
import type { ViewFn } from '../router.ts';
import { esc, taskList, wireChecks } from '../ui.ts';
import type { ValueEl } from '../ui.ts';

const bust = () => invalidate('/api/tasks', '/api/projects', '/api/overview', '/api/me', '/api/search');

export function addTaskDialog(P: ProjectDTO[], onDone: () => void, projectId?: string): void {
  if (!P.length) { toast('Create a project first', 'bad'); return; }
  openDialog({
    title: 'Add task',
    body: f('Project', `<select class="in" id="t-proj">${P.map((p) => `<option value="${esc(p.id)}"${p.id === projectId ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}</select>`) + f('Title', '<input class="in" id="t-title" placeholder="What needs doing">') + f('Due label (optional)', '<input class="in" id="t-due" placeholder="Today, This week, Nov 12…">'),
    primary: { label: 'Add', onClick: async (dlg) => {
      const title = dlg.q<HTMLInputElement>('#t-title').value.trim(); if (!title) { toast('Title is required', 'bad'); return; }
      await post('/api/tasks', { projectId: dlg.q<ValueEl>('#t-proj').value, title, dueLabel: dlg.q<HTMLInputElement>('#t-due').value.trim() || undefined });
      bust(); dlg.close(); onDone();
    } },
  });
}

export const tasks: ViewFn = async (ctx) => {
  const [T, P] = await Promise.all([cached<TaskDTO[]>('/api/tasks?state=all'), cached<ProjectDTO[]>('/api/projects')]);
  if (!ctx.alive()) return;
  const open = T.filter((t) => !t.done), done = T.filter((t) => t.done);
  const list = (k: string) => { const l = k === 'all' ? T : k === 'done' ? done : open; return l.length ? taskList(l) : `<p class="muted" style="margin:0">${k === 'done' ? 'Nothing done yet.' : 'No tasks here.'}</p>`; };
  ctx.root.innerHTML = `<div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start"><div class="tabs" id="taskTabs"><button type="button" class="on" data-t="open">Open (${open.length})</button><button type="button" data-t="done">Done (${done.length})</button><button type="button" data-t="all">All</button></div><button class="act" type="button" id="addTask" style="margin-bottom:14px;white-space:nowrap">+ Add task</button></div><div class="card" id="taskBox">${list('open')}</div>`;
  const tt = ctx.root.querySelector('#taskTabs')!, box = ctx.root.querySelector<HTMLElement>('#taskBox')!;
  const wire = () => wireChecks(box, async (id, d) => {
    try { await patch(`/api/tasks/${id}`, { done: d }); bust(); ctx.refresh(); } catch (e) { toast(String((e as Error).message), 'bad'); }
  });
  tt.querySelectorAll<HTMLButtonElement>('button').forEach((b) => (b.onclick = () => { tt.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); box.innerHTML = list(b.dataset.t!); wire(); }));
  wire();
  ctx.root.querySelector<HTMLButtonElement>('#addTask')!.onclick = () => addTaskDialog(P, ctx.refresh);
};
