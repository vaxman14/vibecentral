// Write-only ingest for the Claude Code session hook and the usage agent.
// Authenticated by HQ_INGEST_KEY (Bearer). Nothing here returns stored data.
import { Hono } from 'hono';
import type { Env, Vars } from '../env.ts';
import { db, getUser, many, one, HttpError, type Db } from '../db.ts';
import { safeEqual } from '@shared/crypto.ts';
import { folderKey } from '@shared/util.ts';
import type { SessionIngest, UsageIngest } from '@shared/types.ts';

export const ingestRoutes = new Hono<{ Bindings: Env; Variables: Vars }>();

ingestRoutes.use('*', async (c, next) => {
  const h = c.req.header('authorization') || '';
  const key = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  if (!c.env.HQ_INGEST_KEY || !key || !safeEqual(key, c.env.HQ_INGEST_KEY)) throw new HttpError(401, 'bad ingest key');
  await next();
});

ingestRoutes.get('/ping', (c) => c.json({ ok: true, machineHint: c.req.header('cf-connecting-ip') ? `reached ${new URL(c.req.url).host}` : 'local' }));

ingestRoutes.post('/', async (c) => {
  const body = (await c.req.json()) as SessionIngest | UsageIngest;
  if (body?.type === 'session') return c.json(await ingestSession(db(c.env), body));
  if (body?.type === 'usage') return c.json(await ingestUsage(db(c.env), body));
  throw new HttpError(400, 'type must be session or usage');
});

const clean = (s: unknown, max: number) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

async function resolveFolder(d: Db, folderName: string, machine: string | null) {
  const key = folderKey(folderName);
  if (!key) return { key, projectId: null as string | null, row: null as any };
  let row = await one<{ id: string; project_id: string | null; sessions: number }>(d.from('folder_map').select('id,project_id,sessions').eq('folder_key', key).maybeSingle(), 'folder');
  let projectId = row?.project_id ?? null;
  if (!projectId) {
    // auto-match by project id or name
    const projects = await many<{ id: string; name: string }>(d.from('projects').select('id,name'), 'projects');
    const hit = projects.find((p) => folderKey(p.id) === key || folderKey(p.name) === key);
    if (hit) projectId = hit.id;
  }
  const now = new Date().toISOString();
  if (row) {
    await d.from('folder_map').update({ project_id: projectId, last_seen: now, machine: machine ?? undefined, sessions: (row.sessions ?? 0) + 1 }).eq('id', row.id);
  } else {
    row = await one(d.from('folder_map').insert({ folder_key: key, folder_name: folderName, machine, project_id: projectId, sessions: 1 }).select('id,project_id,sessions').single(), 'folder');
  }
  return { key, projectId, row };
}

async function ingestSession(d: Db, b: SessionIngest) {
  const folderName = clean(b.folder, 80);
  if (!folderName || !b.sessionId) throw new HttpError(400, 'folder and sessionId are required');
  const machine = clean(b.machine, 40) || null;
  const { projectId } = await resolveFolder(d, folderName, machine);
  const user = await getUser(d);
  const summary = clean(b.summary, 240) || 'Claude Code session ended';
  const done = (Array.isArray(b.done) ? b.done : []).map((x) => clean(x, 200)).filter(Boolean).slice(0, 30);
  const open = (Array.isArray(b.open) ? b.open : []).map((x) => clean(x, 200)).filter(Boolean).slice(0, 30);
  const at = b.endedAt && !Number.isNaN(Date.parse(b.endedAt)) ? new Date(b.endedAt).toISOString() : new Date().toISOString();
  const detail = [done.length ? `Done: ${done.join('; ')}` : '', open.length ? `Open: ${open.join('; ')}` : ''].filter(Boolean).join('\n') || null;

  // history (idempotent per session). Hidden when "Pull Claude Code sessions" is off, but still recorded for mapping later.
  const kind = user.pull_sessions ? 'session' : 'system';
  const ins = await d.from('history').upsert({
    project_id: projectId, kind, title: summary, detail, occurred_at: at, source: 'claude-code', machine, branch: b.branch ? clean(b.branch, 80) : null,
    session_id: String(b.sessionId).slice(0, 80), folder: folderName, fingerprint: `session:${b.sessionId}`,
  }, { onConflict: 'fingerprint', ignoreDuplicates: false });
  if (ins.error) throw new HttpError(500, `history: ${ins.error.message}`);

  // tasks: only when mapped to a project
  let tasksDone = 0, tasksOpened = 0;
  if (projectId) {
    const existing = await many<{ id: string; title: string; done: boolean }>(d.from('tasks').select('id,title,done').eq('project_id', projectId), 'tasks');
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const byTitle = new Map(existing.map((t) => [norm(t.title), t]));
    for (const title of done) {
      const ex = byTitle.get(norm(title));
      if (ex) { if (!ex.done) { await d.from('tasks').update({ done: true, done_at: at, updated_at: at }).eq('id', ex.id); tasksDone++; } }
      else { await d.from('tasks').insert({ project_id: projectId, title, done: true, done_at: at, source: 'session', session_id: b.sessionId, machine }); tasksDone++; }
    }
    for (const title of open) {
      if (byTitle.has(norm(title))) continue;
      await d.from('tasks').insert({ project_id: projectId, title, done: false, source: 'session', session_id: b.sessionId, machine, due_label: 'Next' });
      tasksOpened++;
    }
  }
  return { ok: true, projectId, unsorted: !projectId, tasksDone, tasksOpened };
}

async function ingestUsage(d: Db, b: UsageIngest) {
  const machine = clean(b.machine, 40);
  if (!machine) throw new HttpError(400, 'machine is required');
  const rows = (Array.isArray(b.rows) ? b.rows : []).slice(0, 2000);
  const upserts = rows.map((r) => {
    const folderName = clean(r.folder, 80) || 'unknown';
    const n = (x: unknown) => Math.max(0, Math.round(Number(x) || 0));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(r.day))) throw new HttpError(400, `bad day ${r.day}`);
    return {
      day: r.day, machine, folder_key: folderKey(folderName) || 'unknown', folder_name: folderName, model: clean(r.model, 60) || 'unknown',
      input_tokens: n(r.input), output_tokens: n(r.output), cache_read_tokens: n(r.cacheRead), cache_write_tokens: n(r.cacheWrite),
      messages: n(r.messages), sessions: n(r.sessions), updated_at: new Date().toISOString(),
    };
  });
  for (let i = 0; i < upserts.length; i += 200) {
    const r = await d.from('usage_daily').upsert(upserts.slice(i, i + 200), { onConflict: 'day,machine,folder_key,model' });
    if (r.error) throw new HttpError(500, `usage: ${r.error.message}`);
  }
  // make sure every folder is known for mapping (without bumping session counts)
  const folders = new Map(upserts.map((u) => [u.folder_key, u.folder_name]));
  for (const [key, name] of folders) {
    const ex = await one<{ id: string }>(d.from('folder_map').select('id').eq('folder_key', key).maybeSingle(), 'folder');
    if (!ex) {
      const projects = await many<{ id: string; name: string }>(d.from('projects').select('id,name'), 'projects');
      const hit = projects.find((p) => folderKey(p.id) === key || folderKey(p.name) === key);
      await d.from('folder_map').insert({ folder_key: key, folder_name: name, machine, project_id: hit?.id ?? null, sessions: 0 });
    }
  }
  await d.from('agent_heartbeats').upsert({ machine, last_seen: new Date().toISOString(), agent_version: clean(b.agentVersion, 20) || null, files_tracked: Number(b.filesTracked) || null }, { onConflict: 'machine' });
  return { ok: true, rows: upserts.length };
}
