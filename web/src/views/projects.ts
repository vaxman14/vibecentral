import { STAGES } from '@shared/types.ts';
import type { ProjectDTO } from '@shared/types.ts';
import { ago } from '@shared/util.ts';
import { cached, invalidate, post } from '../api.ts';
import { f, openDialog, toast } from '../dialogs.ts';
import type { ViewFn } from '../router.ts';
import { esc, pi, stages } from '../ui.ts';
import type { ValueEl } from '../ui.ts';

export const COLORS = ['#B9A5FF', '#F5C542', '#42D9D0', '#67D391', '#F08CC6', '#AEB5FF', '#E8AE48', '#FF94A7'];

export function projCards(P: ProjectDTO[], s: number): string {
  const list = P.filter((p) => s < 0 || p.stage === s);
  if (!list.length) return `<div class="card"><p class="muted" style="margin:0">${P.length ? 'No projects in this stage.' : 'No projects yet. Create one with “+ New project”.'}</p></div>`;
  return list.map((p) => `<div class="card proj lift" data-p="${esc(p.id)}" tabindex="0"><div class="ph">${pi(p)}<div><h4>${esc(p.name)}</h4><div class="sub">${STAGES[p.stage]} · updated ${ago(p.updatedAt)}</div></div></div><p>${esc(p.blurb)}</p>${stages(p.stage)}<p><b style="color:var(--text);font-weight:600">Latest:</b> ${esc(p.latest?.title ?? 'No updates yet')}</p><div class="meta"><span>${p.open} open</span><span>·</span><span>${p.done} done</span>${p.domains.length ? `<span>·</span><span>${esc(p.domains.join(', '))}</span>` : ''}</div></div>`).join('');
}

export function wireProjCards(root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>('[data-p]').forEach((c) => {
    c.onclick = () => (location.hash = 'p-' + c.dataset.p);
    c.onkeydown = (e) => { if (e.key === 'Enter') c.click(); };
  });
}

export const stageSelect = (id: string, cur: number): string =>
  `<select class="in" id="${id}">${STAGES.map((s, i) => `<option value="${i}"${i === cur ? ' selected' : ''}>${s}</option>`).join('')}</select>`;

export const colorSelect = (id: string, cur: string): string =>
  `<div style="display:flex;gap:8px;align-items:center"><input type="color" class="in" id="${id}" value="${esc(cur)}" style="padding:2px 4px;width:48px;height:36px"><span class="sub">or pick:</span>${COLORS.map((c) => `<button type="button" class="chk" data-c="${c}" style="background:${c};border-color:${c};width:18px;height:18px;border-radius:50%" aria-label="${c}"></button>`).join('')}</div>`;

export function wireColorSelect(root: HTMLElement, id: string): void {
  const inp = root.querySelector<HTMLInputElement>('#' + id)!;
  root.querySelectorAll<HTMLButtonElement>('[data-c]').forEach((b) => (b.onclick = () => (inp.value = b.dataset.c!)));
}

export function newProjectDialog(onDone: () => void): void {
  openDialog({
    title: 'New project',
    body: f('Name', '<input class="in" id="np-name" placeholder="Project name">') + f('Color', colorSelect('np-color', COLORS[Math.floor(Math.random() * COLORS.length)])) + f('Stage', stageSelect('np-stage', 0)) + f('Blurb', '<input class="in" id="np-blurb" placeholder="One line about it">'),
    primary: {
      label: 'Create',
      onClick: async (dlg) => {
        const name = dlg.q<HTMLInputElement>('#np-name').value.trim();
        if (!name) { toast('Give it a name', 'bad'); return; }
        await post('/api/projects', { name, color: dlg.q<HTMLInputElement>('#np-color').value, stage: +dlg.q<ValueEl>('#np-stage').value, blurb: dlg.q<HTMLInputElement>('#np-blurb').value.trim() });
        invalidate('/api/projects', '/api/overview', '/api/me', '/api/search');
        dlg.close(); toast('Project created'); onDone();
      },
    },
    onOpen: (dlg) => wireColorSelect(dlg.el, 'np-color'),
  });
}

export const projects: ViewFn = async (ctx) => {
  const P = await cached<ProjectDTO[]>('/api/projects');
  if (!ctx.alive()) return;
  ctx.root.innerHTML = `<div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start"><div class="tabs" id="stageTabs">${['All', ...STAGES].map((s, i) => `<button type="button" class="${i ? '' : 'on'}" data-s="${i - 1}">${s}</button>`).join('')}</div><button class="act" type="button" id="newProj" style="margin-bottom:14px;white-space:nowrap">+ New project</button></div>
  <div class="grid g3" id="projGrid">${projCards(P, -1)}</div>`;
  const st = ctx.root.querySelector('#stageTabs')!, grid = ctx.root.querySelector<HTMLElement>('#projGrid')!;
  st.querySelectorAll<HTMLButtonElement>('button').forEach((b) => (b.onclick = () => { st.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); grid.innerHTML = projCards(P, +b.dataset.s!); wireProjCards(grid); }));
  wireProjCards(grid);
  ctx.root.querySelector<HTMLButtonElement>('#newProj')!.onclick = () => newProjectDialog(ctx.refresh);
};
