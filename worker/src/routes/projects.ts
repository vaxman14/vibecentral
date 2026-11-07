import { Hono } from 'hono';
import type { Env, Vars } from '../env.ts';
import { db, many, one, HttpError, type Db } from '../db.ts';
import type { HistoryDTO, ProjectDTO, ProjectLinkDTO, TaskDTO, UnsortedDTO } from '@shared/types.ts';
import { PROVIDERS } from '@shared/types.ts';
import { folderKey } from '@shared/util.ts';
import { loadAccounts, type AccountRow } from './me.ts';
import { linkables } from '../views/linkables.ts';

export const projectRoutes = new Hono<{ Bindings: Env; Variables: Vars }>();

export interface ProjectRow { id: string; name: string; color: string; stage: number; blurb: string; sort: number; archived: boolean; created_at: string; updated_at: string }
export interface LinkRow { id: string; project_id: string; kind: string; account_id: string | null; ref: string; label: string }
export interface TaskRow { id: string; project_id: string; title: string; done: boolean; due_label: string | null; source: string; created_at: string; done_at: string | null }
export interface HistoryRow { id: string; project_id: string | null; kind: string; title: string; detail: string | null; occurred_at: string; source: string | null; machine: string | null; branch: string | null; folder: string | null }

export const accountLabel = (a: AccountRow | undefined) => (a ? `${PROVIDERS[a.provider as keyof typeof PROVIDERS]?.name ?? a.provider} · ${a.label}` : null);

export function slugify(name: string): string {
  return name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'project';
}

export async function loadProjects(d: Db, includeArchived = false): Promise<ProjectDTO[]> {
  let q = d.from('projects').select('*').order('sort').order('name');
  if (!includeArchived) q = q.eq('archived', false);
  const [projects, links, tasks, latest, accounts] = await Promise.all([
    many<ProjectRow>(q, 'projects'),
    many<LinkRow>(d.from('project_links').select('*'), 'links'),
    many<{ project_id: string; done: boolean }>(d.from('tasks').select('project_id,done'), 'tasks'),
    many<{ project_id: string; title: string; occurred_at: string }>(d.from('history').select('project_id,title,occurred_at').not('project_id', 'is', null).order('occurred_at', { ascending: false }).limit(400), 'history'),
    loadAccounts(d),
  ]);
  const acc = new Map(accounts.map((a) => [a.id, a]));
  return projects.map((p) => {
    const pl = links.filter((l) => l.project_id === p.id);
    const t = tasks.filter((x) => x.project_id === p.id);
    const last = latest.find((h) => h.project_id === p.id);
    const accLabels = [...new Set(pl.map((l) => accountLabel(l.account_id ? acc.get(l.account_id) : undefined) ?? (l.kind === 'account' ? l.label : null)).filter(Boolean) as string[])];
    return {
      id: p.id, name: p.name, color: p.color, stage: p.stage, blurb: p.blurb, sort: p.sort, archived: p.archived,
      open: t.filter((x) => !x.done).length, done: t.filter((x) => x.done).length,
      domains: pl.filter((l) => l.kind === 'domain').map((l) => l.label),
      accounts: accLabels,
      links: pl.map((l) => linkDTO(l, acc)),
      latest: last ? { title: last.title, at: last.occurred_at } : null,
      updatedAt: last?.occurred_at ?? p.updated_at,
    };
  });
}

const linkDTO = (l: LinkRow, acc: Map<string, AccountRow>): ProjectLinkDTO => ({ id: l.id, kind: l.kind, accountId: l.account_id, accountLabel: accountLabel(l.account_id ? acc.get(l.account_id) : undefined), ref: l.ref, label: l.label });

export function taskDTO(t: TaskRow, projects: Map<string, ProjectRow>): TaskDTO {
  const p = projects.get(t.project_id);
  return { id: t.id, projectId: t.project_id, projectName: p?.name ?? t.project_id, projectColor: p?.color ?? '#B9A5FF', title: t.title, done: t.done, dueLabel: t.due_label, source: t.source, createdAt: t.created_at, doneAt: t.done_at };
}
export function historyDTO(h: HistoryRow, projects: Map<string, ProjectRow>): HistoryDTO {
  const p = h.project_id ? projects.get(h.project_id) : undefined;
  return { id: h.id, projectId: h.project_id, projectName: p?.name ?? null, projectColor: p?.color ?? null, kind: h.kind, title: h.title, detail: h.detail, at: h.occurred_at, source: h.source, machine: h.machine, branch: h.branch, folder: h.folder };
}
export async function projectMap(d: Db): Promise<Map<string, ProjectRow>> {
  return new Map((await many<ProjectRow>(d.from('projects').select('*'), 'projects')).map((p) => [p.id, p]));
}

// ---------- projects ----------
projectRoutes.get('/projects', async (c) => c.json(await loadProjects(db(c.env), c.req.query('archived') === '1')));

projectRoutes.post('/projects', async (c) => {
  const b = await c.req.json<{ name: string; color?: string; stage?: number; blurb?: string }>();
  const name = String(b.name ?? '').trim();
  if (!name) throw new HttpError(400, 'name is required');
  const d = db(c.env);
  let id = slugify(name);
  const taken = await many<{ id: string }>(d.from('projects').select('id').like('id', `${id}%`), 'ids');
  if (taken.some((t) => t.id === id)) id = `${id}-${taken.length + 1}`;
  const maxSort = (await many<{ sort: number }>(d.from('projects').select('sort').order('sort', { ascending: false }).limit(1), 'sort'))[0]?.sort ?? 0;
  await many(d.from('projects').insert({ id, name, color: /^#[0-9a-f]{6}$/i.test(b.color ?? '') ? b.color : '#B9A5FF', stage: clampStage(b.stage), blurb: String(b.blurb ?? '').slice(0, 300), sort: maxSort + 10 }).select('id'), 'create project');
  await d.from('history').insert({ project_id: id, kind: 'system', title: 'Project created', source: 'you', fingerprint: `created:${id}` });
  // adopt any unsorted folder that matches the new name
  await d.from('folder_map').update({ project_id: id }).is('project_id', null).eq('folder_key', folderKey(name));
  return c.json((await loadProjects(d)).find((p) => p.id === id));
});

const clampStage = (s: unknown) => Math.max(0, Math.min(4, Number.isFinite(Number(s)) ? Math.round(Number(s)) : 0));

projectRoutes.get('/projects/:id', async (c) => {
  const d = db(c.env);
  const id = c.req.param('id');
  const projects = await loadProjects(d, true);
  const project = projects.find((p) => p.id === id);
  if (!project) throw new HttpError(404, 'project not found');
  const pm = await projectMap(d);
  const [tasks, history] = await Promise.all([
    many<TaskRow>(d.from('tasks').select('*').eq('project_id', id).order('done').order('created_at', { ascending: false }), 'tasks'),
    many<HistoryRow>(d.from('history').select('*').eq('project_id', id).order('occurred_at', { ascending: false }).limit(200), 'history'),
  ]);
  return c.json({ project, tasks: tasks.map((t) => taskDTO(t, pm)), history: history.map((h) => historyDTO(h, pm)) });
});

projectRoutes.patch('/projects/:id', async (c) => {
  const b = await c.req.json<Partial<{ name: string; color: string; stage: number; blurb: string; sort: number; archived: boolean }>>();
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (b.name !== undefined) { const n = String(b.name).trim(); if (!n) throw new HttpError(400, 'name cannot be empty'); patch.name = n.slice(0, 80); }
  if (b.color !== undefined) { if (!/^#[0-9a-f]{6}$/i.test(b.color)) throw new HttpError(400, 'color must be #rrggbb'); patch.color = b.color; }
  if (b.stage !== undefined) patch.stage = clampStage(b.stage);
  if (b.blurb !== undefined) patch.blurb = String(b.blurb).slice(0, 300);
  if (b.sort !== undefined) patch.sort = Number(b.sort) || 100;
  if (b.archived !== undefined) patch.archived = !!b.archived;
  const d = db(c.env);
  const id = c.req.param('id');
  const before = await one<ProjectRow>(d.from('projects').select('*').eq('id', id).single(), 'project');
  if (!before) throw new HttpError(404, 'project not found');
  await many(d.from('projects').update(patch).eq('id', id).select('id'), 'update project');
  if (b.stage !== undefined && clampStage(b.stage) !== before.stage) {
    const STAGES = ['Idea', 'Building', 'Beta', 'Review', 'Live'];
    await d.from('history').insert({ project_id: id, kind: 'manual', title: `Stage set to ${STAGES[clampStage(b.stage)]}`, source: 'you' });
  }
  return c.json((await loadProjects(d, true)).find((p) => p.id === id));
});

projectRoutes.delete('/projects/:id', async (c) => {
  await many(db(c.env).from('projects').delete().eq('id', c.req.param('id')).select('id'), 'delete project');
  return c.json({ ok: true });
});

// ---------- links ----------
projectRoutes.get('/linkables', async (c) => c.json(await linkables(db(c.env))));

projectRoutes.post('/projects/:id/links', async (c) => {
  const b = await c.req.json<{ kind: string; accountId: string | null; ref: string; label: string }>();
  if (!['domain', 'site', 'database', 'app', 'repo', 'account', 'worker', 'tunnel'].includes(b.kind)) throw new HttpError(400, 'bad link kind');
  if (!b.ref || !b.label) throw new HttpError(400, 'ref and label are required');
  const d = db(c.env);
  const pid = c.req.param('id');
  const row = await one<LinkRow>(d.from('project_links').upsert({ project_id: pid, kind: b.kind, account_id: b.accountId || null, ref: String(b.ref), label: String(b.label).slice(0, 120) }, { onConflict: 'project_id,kind,ref' }).select('*').single(), 'link');
  await d.from('history').insert({ project_id: pid, kind: 'manual', title: `Linked ${b.kind}: ${b.label}`, source: 'you' });
  // attach past provider events for this ref that have no project yet
  await d.from('history').update({ project_id: pid }).is('project_id', null).eq('kind', 'provider').eq('folder', String(b.ref));
  const acc = new Map((await loadAccounts(d)).map((a) => [a.id, a]));
  return c.json(linkDTO(row!, acc));
});

projectRoutes.delete('/projects/:id/links/:linkId', async (c) => {
  await many(db(c.env).from('project_links').delete().eq('id', c.req.param('linkId')).eq('project_id', c.req.param('id')).select('id'), 'unlink');
  return c.json({ ok: true });
});

// ---------- tasks ----------
projectRoutes.get('/tasks', async (c) => {
  const d = db(c.env);
  const state = c.req.query('state') || 'open';
  let q = d.from('tasks').select('*').order('done').order('created_at', { ascending: false }).limit(500);
  if (state === 'open') q = q.eq('done', false);
  if (state === 'done') q = q.eq('done', true);
  if (c.req.query('projectId')) q = q.eq('project_id', c.req.query('projectId')!);
  const [rows, pm] = await Promise.all([many<TaskRow>(q, 'tasks'), projectMap(d)]);
  return c.json(rows.map((t) => taskDTO(t, pm)));
});

projectRoutes.post('/tasks', async (c) => {
  const b = await c.req.json<{ projectId: string; title: string; dueLabel?: string }>();
  const title = String(b.title ?? '').trim();
  if (!title) throw new HttpError(400, 'title is required');
  const d = db(c.env);
  const pm = await projectMap(d);
  if (!pm.has(b.projectId)) throw new HttpError(400, 'unknown project');
  const row = await one<TaskRow>(d.from('tasks').insert({ project_id: b.projectId, title: title.slice(0, 200), due_label: b.dueLabel ? String(b.dueLabel).slice(0, 40) : null }).select('*').single(), 'create task');
  return c.json(taskDTO(row!, pm));
});

projectRoutes.patch('/tasks/:id', async (c) => {
  const b = await c.req.json<Partial<{ title: string; done: boolean; dueLabel: string | null; projectId: string }>>();
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (b.title !== undefined) { const t = String(b.title).trim(); if (!t) throw new HttpError(400, 'title cannot be empty'); patch.title = t.slice(0, 200); }
  if (b.done !== undefined) { patch.done = !!b.done; patch.done_at = b.done ? new Date().toISOString() : null; }
  if (b.dueLabel !== undefined) patch.due_label = b.dueLabel ? String(b.dueLabel).slice(0, 40) : null;
  if (b.projectId !== undefined) patch.project_id = b.projectId;
  const d = db(c.env);
  const pm = await projectMap(d);
  if (b.projectId !== undefined && !pm.has(b.projectId)) throw new HttpError(400, 'unknown project');
  const row = await one<TaskRow>(d.from('tasks').update(patch).eq('id', c.req.param('id')).select('*').single(), 'update task');
  if (!row) throw new HttpError(404, 'task not found');
  if (b.done === true) await d.from('history').insert({ project_id: row.project_id, kind: 'manual', title: `Done: ${row.title}`, source: 'you' });
  return c.json(taskDTO(row, pm));
});

projectRoutes.delete('/tasks/:id', async (c) => {
  await many(db(c.env).from('tasks').delete().eq('id', c.req.param('id')).select('id'), 'delete task');
  return c.json({ ok: true });
});

// ---------- history ----------
projectRoutes.get('/history', async (c) => {
  const d = db(c.env);
  const limit = Math.min(1000, Number(c.req.query('limit')) || 300);
  let q = d.from('history').select('*').order('occurred_at', { ascending: false }).limit(limit);
  if (c.req.query('projectId')) q = q.eq('project_id', c.req.query('projectId')!);
  if (c.req.query('kind')) q = q.eq('kind', c.req.query('kind')!);
  const [rows, pm] = await Promise.all([many<HistoryRow>(q, 'history'), projectMap(d)]);
  return c.json(rows.map((h) => historyDTO(h, pm)));
});

projectRoutes.post('/history', async (c) => {
  const b = await c.req.json<{ projectId: string; title: string; detail?: string }>();
  const title = String(b.title ?? '').trim();
  if (!title) throw new HttpError(400, 'title is required');
  const d = db(c.env);
  const pm = await projectMap(d);
  if (!pm.has(b.projectId)) throw new HttpError(400, 'unknown project');
  const row = await one<HistoryRow>(d.from('history').insert({ project_id: b.projectId, kind: 'manual', title: title.slice(0, 200), detail: b.detail ? String(b.detail).slice(0, 2000) : null, source: 'you' }).select('*').single(), 'add update');
  return c.json(historyDTO(row!, pm));
});

// ---------- unsorted folders ----------
interface FolderRow { id: string; folder_key: string; folder_name: string; machine: string | null; project_id: string | null; sessions: number; last_seen: string }
const unsortedDTO = (f: FolderRow): UnsortedDTO => ({ id: f.id, folderKey: f.folder_key, folderName: f.folder_name, machine: f.machine, sessions: f.sessions, lastSeen: f.last_seen, projectId: f.project_id });

projectRoutes.get('/unsorted', async (c) => {
  const rows = await many<FolderRow>(db(c.env).from('folder_map').select('*').is('project_id', null).order('last_seen', { ascending: false }), 'unsorted');
  return c.json(rows.map(unsortedDTO));
});

projectRoutes.get('/folders', async (c) => {
  const rows = await many<FolderRow>(db(c.env).from('folder_map').select('*').order('last_seen', { ascending: false }), 'folders');
  return c.json(rows.map(unsortedDTO));
});

projectRoutes.patch('/unsorted/:id', async (c) => {
  const b = await c.req.json<{ projectId: string | null }>();
  const d = db(c.env);
  const f = await one<FolderRow>(d.from('folder_map').select('*').eq('id', c.req.param('id')).single(), 'folder');
  if (!f) throw new HttpError(404, 'folder not found');
  if (b.projectId) {
    const pm = await projectMap(d);
    if (!pm.has(b.projectId)) throw new HttpError(400, 'unknown project');
  }
  const row = await one<FolderRow>(d.from('folder_map').update({ project_id: b.projectId || null }).eq('id', f.id).select('*').single(), 'map folder');
  if (b.projectId) {
    // move the folder's session history and tasks over
    await d.from('history').update({ project_id: b.projectId }).is('project_id', null).eq('folder', f.folder_name);
    await d.from('history').update({ project_id: b.projectId }).is('project_id', null).eq('folder', f.folder_key);
  }
  return c.json(unsortedDTO(row!));
});
