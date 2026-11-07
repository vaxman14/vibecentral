import type { ClaudeDTO } from '@shared/types.ts';
import { ago, compact } from '@shared/util.ts';
import { cached } from '../api.ts';
import type { ViewFn } from '../router.ts';
import { chart, esc, stats, tbl } from '../ui.ts';

const tok = (n: number) => compact(n || 0);

export const claude: ViewFn = async (ctx) => {
  const d = await cached<ClaudeDTO>('/api/claude');
  if (!ctx.alive()) return;
  const a = d.api, s = d.subscription;
  ctx.root.innerHTML = `<h2>API</h2>
  ${a.connected ? '' : '<p class="muted" style="margin:-4px 0 12px;font-size:14px">No Claude admin key connected yet. Add one under Connections → Claude.</p>'}
  <div class="grid g4">${stats(a.stats, ['✦', '⇅', '⚡', '⌘'])}</div>
  <div class="card row"><h2>Spend by day</h2>${chart(a.byDay, 160)}</div>
  <div class="card"><h2>By workspace</h2>${a.workspaces.length ? tbl(['Workspace', 'Model', 'Requests', 'Spend'], a.workspaces.map((w) => [`<b>${esc(w.workspace)}</b>${w.org ? `<div class="sub">${esc(w.org)}</div>` : ''}`, `<span class="muted">${esc(w.models)}</span>`, `${tok(w.input)} in · ${tok(w.output)} out`, esc(w.spend)])) : '<p class="muted" style="margin:0">No workspace usage this month.</p>'}<p class="sub" style="margin:12px 0 0">From the Anthropic usage and cost API with an admin key. Claude plan usage isn't available through an API.</p></div>

  <h2 style="margin-top:28px">Subscription (Claude Code)</h2>
  ${s.connected ? '' : '<p class="muted" style="margin:-4px 0 12px;font-size:14px">No usage agent has reported yet. See docs/CLAUDE-CODE-SETUP.md.</p>'}
  <div class="grid g4">${stats(s.stats, ['✦', '⇅', '⚡', '⌁'])}</div>
  <div class="card row"><h2>Tokens by day</h2>${chart(s.byDay, 160)}</div>
  <div class="grid g3">
    <div class="card"><h2>By project</h2>${s.byProject.length ? tbl(['Project', 'In / out', 'Cache read'], s.byProject.map((p) => [`${p.projectId ? `<a href="#p-${esc(p.projectId)}" style="color:inherit"><b>${esc(p.project)}</b></a>` : `<b>${esc(p.project)}</b>`}<div class="sub">${esc(p.folder)}</div>`, `${tok(p.input)} · ${tok(p.output)}`, tok(p.cacheRead)])) : '<p class="muted" style="margin:0">Nothing yet.</p>'}</div>
    <div class="card"><h2>By model</h2>${s.byModel.length ? tbl(['Model', 'In / out', 'Cache read'], s.byModel.map((m) => [`<b>${esc(m.model)}</b>`, `${tok(m.input)} · ${tok(m.output)}`, tok(m.cacheRead)])) : '<p class="muted" style="margin:0">Nothing yet.</p>'}</div>
    <div class="card"><h2>By machine</h2>${s.byMachine.length ? tbl(['Machine', 'In / out', 'Cache read'], s.byMachine.map((m) => [`<b>${esc(m.machine)}</b>`, `${tok(m.input)} · ${tok(m.output)}`, tok(m.cacheRead)])) : '<p class="muted" style="margin:0">Nothing yet.</p>'}</div>
  </div>
  <div class="card row"><h2>Machines</h2>${s.machines.length ? `<div class="list">${s.machines.map((m) => `<div class="li"><span class="dot" style="margin-top:7px${Date.now() - new Date(m.lastSeen).getTime() > 86400000 * 2 ? ';background:var(--faint)' : ''}"></span><div>${esc(m.machine)}<div class="meta">${m.agentVersion ? `agent ${esc(m.agentVersion)}` : 'agent version unknown'}</div></div><span class="when">last seen ${esc(ago(m.lastSeen))}</span></div>`).join('')}</div>` : '<p class="muted" style="margin:0">No machines have reported.</p>'}<p class="sub" style="margin:12px 0 0">Range ${esc(s.range.from)} to ${esc(s.range.to)}, read from local Claude Code session files by the usage agent.</p></div>`;
};
