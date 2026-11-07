import { STAGES } from '@shared/types.ts';
import type { HistoryDTO, ProjectDTO, TaskDTO } from '@shared/types.ts';
import { cached, del, invalidate, patch, post } from '../api.ts';
import { confirmDialog, f, openDialog, toast } from '../dialogs.ts';
import type { ViewFn } from '../router.ts';
import { esc, histList, pi, pill, stages, statCard, taskList, tbl, wireChecks } from '../ui.ts';
import type { ValueEl } from '../ui.ts';
import { colorSelect, stageSelect, wireColorSelect } from './projects.ts';

interface Detail { project: ProjectDTO; tasks: TaskDTO[]; history: HistoryDTO[] }
interface Linkable { kind: string; accountId: string | null; accountLabel: string | null; ref: string; label: string }

const bust = () => invalidate('/api/projects', '/api/tasks', '/api/history', '/api/overview', '/api/me', '/api/search');

export const project: ViewFn = async (ctx) => {
  const id = ctx.param;
  let d: Detail;
  try { d = await cached<Detail>(`/api/projects/${encodeURIComponent(id)}`); }
  catch (e) { if ((e as { status?: number }).status === 404) { location.replace('#projects'); return; } throw e; }
  if (!ctx.alive()) return;
  const p = d.project;
  ctx.setTitle(p.name);
  const ot = d.tasks;
  ctx.root.innerHTML = `
  <div class="card row" style="margin-top:0"><div class="proj" style="cursor:default"><div class="ph">${pi(p)}<div><h4 style="font-size:20px">${esc(p.name)}</h4><p>${esc(p.blurb)}</p></div><span style="margin-left:auto;display:flex;gap:8px;align-items:center">${pill(STAGES[p.stage])}<button class="act" type="button" id="editProj">Edit</button></span></div>${stages(p.stage)}<div class="meta">${STAGES.map((s, i) => `<span style="flex:1;${i === p.stage ? 'color:var(--text);font-weight:600' : ''}">${s}</span>`).join('')}</div></div></div>
  <div class="grid g4">${statCard(1, '✓', 'Open tasks', p.open, '', Math.min(100, p.open * 12), '')}${statCard(2, '✔', 'Done', p.done, '', Math.min(100, p.done * 2), 'All time')}${statCard(3, '◎', 'Domains', p.domains.length, '', p.domains.length * 40, p.domains.join(', ') || 'None')}${statCard(4, '⬡', 'Linked accounts', p.accounts.length, '', p.accounts.length * 30, 'Read-only')}</div>
  <div class="grid g11 row">
    <div class="card"><h2>Tasks</h2>${ot.length ? taskList(ot) : '<p class="muted" style="margin:0">No tasks yet.</p>'}<div class="addrow"><input class="in" id="newTask" placeholder="Add a task…"><button class="act" type="button" id="addTask">Add</button></div></div>
    <div class="card"><div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:12px"><h2 style="margin:0">History</h2><button class="act" type="button" id="addUpd">+ Update</button></div>${d.history.length ? histList(d.history) : '<p class="muted" style="margin:0">No history yet.</p>'}</div>
  </div>
  <div class="card"><div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:12px"><h2 style="margin:0">Linked accounts</h2><button class="act" type="button" id="addLink">+ Link</button></div>${p.links.length
    ? tbl(['Account', 'Kind', 'Access', ''], p.links.map((l) => [`<b>${esc(l.label)}</b>${l.accountLabel ? `<div class="sub">${esc(l.accountLabel)}</div>` : ''}`, `<span class="muted">${esc(l.kind)}</span>`, pill('Read-only'), `<button class="act" type="button" data-unlink="${esc(l.id)}">Remove</button>`]))
    : '<p class="muted" style="margin:0">Link a domain, site or database to see it here.</p>'}</div>`;

  const root = ctx.root;
  wireChecks(root, async (tid, done) => {
    try { await patch(`/api/tasks/${tid}`, { done }); bust(); ctx.refresh(); } catch (e) { toast(String((e as Error).message), 'bad'); }
  });

  // inline add task
  const inp = root.querySelector<HTMLInputElement>('#newTask')!;
  const add = async () => {
    const title = inp.value.trim(); if (!title) return;
    try { await post('/api/tasks', { projectId: p.id, title }); bust(); ctx.refresh(); } catch (e) { toast(String((e as Error).message), 'bad'); }
  };
  root.querySelector<HTMLButtonElement>('#addTask')!.onclick = add;
  inp.onkeydown = (e) => { if (e.key === 'Enter') add(); };

  // typed update
  root.querySelector<HTMLButtonElement>('#addUpd')!.onclick = () => openDialog({
    title: 'Add update',
    body: f('What happened', '<input class="in" id="u-title" placeholder="Shipped the thing">') + f('Detail (optional)', '<textarea class="in" id="u-detail"></textarea>'),
    primary: { label: 'Add', onClick: async (dlg) => {
      const title = dlg.q<HTMLInputElement>('#u-title').value.trim(); if (!title) { toast('Write a line first', 'bad'); return; }
      await post('/api/history', { projectId: p.id, title, detail: dlg.q<HTMLTextAreaElement>('#u-detail').value.trim() || undefined });
      bust(); dlg.close(); ctx.refresh();
    } },
  });

  // unlink
  root.querySelectorAll<HTMLButtonElement>('[data-unlink]').forEach((b) => (b.onclick = async () => {
    if (!(await confirmDialog('Remove link', 'Unlink this from the project? The account itself stays connected.', 'Remove'))) return;
    try { await del(`/api/projects/${p.id}/links/${b.dataset.unlink}`); bust(); ctx.refresh(); } catch (e) { toast(String((e as Error).message), 'bad'); }
  }));

  // link dialog
  root.querySelector<HTMLButtonElement>('#addLink')!.onclick = async () => {
    const dlg = openDialog({ title: 'Link to ' + p.name, body: '<input class="in" id="lk-q" placeholder="Search zones, sites, databases, apps, repos…" autocomplete="off"><div class="list" id="lk-list"><p class="muted" style="margin:0">Loading…</p></div>', cancel: 'Close', width: 640 });
    let items: Linkable[] = [];
    try { items = await cached<Linkable[]>('/api/linkables', 60_000); } catch (e) { dlg.q('#lk-list').innerHTML = `<p class="muted" style="margin:0">${esc((e as Error).message)}</p>`; return; }
    const linked = new Set(p.links.map((l) => `${l.kind}:${l.ref}`));
    const q = dlg.q<HTMLInputElement>('#lk-q'), list = dlg.q('#lk-list');
    const draw = () => {
      const s = q.value.toLowerCase();
      const vis = items.filter((i) => !s || i.label.toLowerCase().includes(s) || (i.accountLabel ?? '').toLowerCase().includes(s) || i.kind.toLowerCase().includes(s));
      const kinds = [...new Set(vis.map((i) => i.kind))];
      list.innerHTML = kinds.length ? kinds.map((k) => `<div class="h sec" style="padding:10px 0 4px">${esc(k.toUpperCase())}</div>${vis.filter((i) => i.kind === k).map((i, n) => {
        const done = linked.has(`${i.kind}:${i.ref}`);
        return `<div class="li" style="padding:7px 0"><div>${esc(i.label)}<div class="meta">${esc(i.accountLabel ?? '')}</div></div><button class="act" type="button" style="margin-left:auto" data-lk="${esc(k)}|${n}"${done ? ' disabled' : ''}>${done ? 'Linked' : 'Link'}</button></div>`;
      }).join('')}`).join('') : '<p class="muted" style="margin:0">Nothing matches.</p>';
      list.querySelectorAll<HTMLButtonElement>('[data-lk]').forEach((b) => (b.onclick = async () => {
        const [k, n] = b.dataset.lk!.split('|');
        const it = vis.filter((i) => i.kind === k)[+n];
        try {
          await post(`/api/projects/${p.id}/links`, { kind: it.kind, accountId: it.accountId, ref: it.ref, label: it.label });
          linked.add(`${it.kind}:${it.ref}`); b.textContent = 'Linked'; b.disabled = true; bust();
        } catch (e) { toast(String((e as Error).message), 'bad'); }
      }));
    };
    q.oninput = draw; draw();
    const obs = new MutationObserver(() => { if (!document.body.contains(dlg.el)) { obs.disconnect(); if (linked.size !== p.links.length) ctx.refresh(); } });
    obs.observe(dlg.el.parentElement!.parentElement!, { childList: true });
  };

  // edit / delete
  root.querySelector<HTMLButtonElement>('#editProj')!.onclick = () => openDialog({
    title: 'Edit project',
    body: f('Name', `<input class="in" id="ep-name" value="${esc(p.name)}">`) + f('Color', colorSelect('ep-color', p.color)) + f('Stage', stageSelect('ep-stage', p.stage)) + f('Blurb', `<input class="in" id="ep-blurb" value="${esc(p.blurb)}">`),
    extra: '<button class="act danger" type="button" id="ep-del" style="margin-right:auto">Delete project…</button>',
    primary: { label: 'Save', onClick: async (dlg) => {
      const name = dlg.q<HTMLInputElement>('#ep-name').value.trim(); if (!name) { toast('Name is required', 'bad'); return; }
      await patch(`/api/projects/${p.id}`, { name, color: dlg.q<HTMLInputElement>('#ep-color').value, stage: +dlg.q<ValueEl>('#ep-stage').value, blurb: dlg.q<HTMLInputElement>('#ep-blurb').value.trim() });
      bust(); dlg.close(); ctx.refresh();
    } },
    onOpen: (dlg) => {
      wireColorSelect(dlg.el, 'ep-color');
      dlg.q<HTMLButtonElement>('#ep-del').onclick = async () => {
        dlg.close();
        if (!(await confirmDialog('Delete project', `Delete <b>${esc(p.name)}</b> with its tasks, history and links? This cannot be undone.`, 'Delete project'))) return;
        try { await del(`/api/projects/${p.id}`); bust(); toast('Project deleted'); location.hash = 'projects'; } catch (e) { toast(String((e as Error).message), 'bad'); }
      };
    },
  });
};
