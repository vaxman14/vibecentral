import type { ConnectionsDTO } from '@shared/types.ts';
import { ago } from '@shared/util.ts';
import { addAccountDialog, manageAccountDialog } from '../accounts.ts';
import { cached } from '../api.ts';
import { openDialog, toast } from '../dialogs.ts';
import { del, get, invalidate, patch } from '../api.ts';
import type { ViewFn } from '../router.ts';
import { state } from '../state.ts';
import { esc, pill } from '../ui.ts';

export const connections: ViewFn = async (ctx) => {
  const d = await cached<ConnectionsDTO>('/api/connections');
  if (!ctx.alive()) return;
  if (ctx.query.has('connected')) { toast(`Google account connected: ${ctx.query.get('connected')}`); history.replaceState(null, '', '#connections'); }
  if (ctx.query.has('error')) { toast(ctx.query.get('error') || 'Connection failed', 'bad'); history.replaceState(null, '', '#connections'); }
  const sel = state.filter.accountId;
  ctx.root.innerHTML = `<div class="note" style="background:var(--si1b);color:var(--text)">Every connection is read-only. The dashboard stores each token encrypted and never writes to a provider.</div>
  <div class="grid g3">${claudeCodeCard(d)}${d.providers.map((c) => `<div class="card lift" style="display:flex;flex-direction:column;gap:10px"><div style="display:flex;gap:12px;align-items:center"><div class="si" style="width:40px;height:40px;border-radius:12px;display:grid;place-items:center;background:var(--si1b);color:var(--si1f);font-weight:700">${c.icon}</div><div><b>${esc(c.name)}</b><div class="sub">${esc(c.blurb)}</div></div></div><div class="list">${c.accounts.length ? c.accounts.map((a) => `<div class="li click" style="padding:7px 0" data-acct="${esc(a.id)}" role="button" tabindex="0"><span class="dot" style="margin-top:6px${a.status === 'ok' ? '' : a.status === 'pending' ? ';background:var(--warning)' : ';background:var(--danger)'}"></span><span${a.id === sel ? ' style="font-weight:600"' : ''}>${esc(a.label)}</span>${a.status === 'ok' ? '' : a.status === 'pending' ? pill('Pending') : pill(a.status === 'expired' ? 'Expired' : 'Error', a.lastError ?? undefined)}<span class="when">${a.lastSyncAt ? `Synced ${esc(ago(a.lastSyncAt))}` : 'Not synced yet'}</span></div>`).join('') : '<div class="li" style="padding:7px 0"><span class="muted">No accounts yet</span></div>'}</div><button class="act" type="button" style="align-self:flex-start" data-add="${c.provider}">+ Add account</button></div>`).join('')}</div>`;
  const all = d.providers.flatMap((p) => p.accounts);
  ctx.root.querySelectorAll<HTMLElement>('[data-acct]').forEach((r) => {
    const open = () => { const a = all.find((x) => x.id === r.dataset.acct); if (a) manageAccountDialog(a, ctx.refresh); };
    r.onclick = open; r.onkeydown = (e) => { if (e.key === 'Enter') open(); };
  });
  ctx.root.querySelectorAll<HTMLButtonElement>('[data-add]').forEach((b) => (b.onclick = () => addAccountDialog(b.dataset.add as ConnectionsDTO['providers'][number]['provider'], ctx.refresh)));
  const inst = ctx.root.querySelector<HTMLButtonElement>('#cc-install');
  if (inst) inst.onclick = installDialog;
  ctx.root.querySelectorAll<HTMLElement>('[data-machine]').forEach((r) => {
    const open = () => machineDialog(r.dataset.machine!, ctx.refresh);
    r.onclick = open; r.onkeydown = (e) => { if (e.key === 'Enter') open(); };
  });
};

function machineDialog(machine: string, refresh: () => void): void {
  openDialog({
    title: machine,
    body: `<p class="sub" style="margin:0 0 10px">Renaming moves this machine's usage and session history to the new name. Remove only drops it from the list (its usage stays under the old name).</p><div class="field" style="border:0;padding:0"><b>Name</b><span>Shown on the Claude usage page</span><div class="ctl"><input class="in" id="m-name" value="${esc(machine)}"></div></div>`,
    primary: { label: 'Rename', onClick: async (dlg) => {
      const name = dlg.q<HTMLInputElement>('#m-name').value.trim();
      if (!name || name === machine) { dlg.close(); return; }
      try { await patch(`/api/claude/machines/${encodeURIComponent(machine)}`, { name }); invalidate('/api/connections'); invalidate('/api/claude'); dlg.close(); toast('Renamed'); refresh(); } catch (e) { toast(String((e as Error).message), 'bad'); }
    } },
    extra: '<button class="act" type="button" data-rm style="color:var(--danger);border-color:var(--danger)">Remove</button>',
    onOpen: (dlg) => { dlg.el.querySelector<HTMLButtonElement>('[data-rm]')!.onclick = async () => {
      try { await del(`/api/claude/machines/${encodeURIComponent(machine)}`); invalidate('/api/connections'); invalidate('/api/claude'); dlg.close(); toast('Removed'); refresh(); } catch (e) { toast(String((e as Error).message), 'bad'); }
    }; },
  });
}

/** Claude Code (subscription) is a connection too: the local agent on each machine reports here. */
function claudeCodeCard(d: ConnectionsDTO): string {
  const m = d.claudeCode?.machines ?? [];
  const stale = (iso: string) => Date.now() - new Date(iso).getTime() > 40 * 60000; // agent runs every 15 min
  return `<div class="card lift" style="display:flex;flex-direction:column;gap:10px"><div style="display:flex;gap:12px;align-items:center"><div class="si" style="width:40px;height:40px;border-radius:12px;display:grid;place-items:center;background:var(--si1b);color:var(--si1f);font-weight:700">✦</div><div><b>Claude Code</b><div class="sub">Subscription usage and session updates from your machines</div></div></div><div class="list">${m.length ? m.map((x) => `<div class="li click" style="padding:7px 0" data-machine="${esc(x.machine)}" role="button" tabindex="0"><span class="dot" style="margin-top:6px${stale(x.lastSeen) ? ';background:var(--warning)' : ''}"></span><span>${esc(x.machine)}</span>${stale(x.lastSeen) ? pill('Quiet', 'The agent has not reported for a while') : ''}<span class="when">Reported ${esc(ago(x.lastSeen))}</span></div>`).join('') : '<div class="li" style="padding:7px 0"><span class="muted">No machine is reporting yet</span></div>'}</div><button class="act" type="button" style="align-self:flex-start" id="cc-install">+ Install on a machine</button></div>`;
}

async function installDialog(): Promise<void> {
  let key = '', url = location.origin;
  try { const r = await get<{ ingestKey: string | null; url: string }>('/api/setup/ingest-key'); key = r.ingestKey ?? ''; url = r.url || url; } catch (e) { toast(String((e as Error).message), 'bad'); return; }
  if (!key) { toast('HQ_INGEST_KEY is not set on the Worker', 'bad'); return; }
  const mac = `curl -fsSL ${url}/agent/install.sh | bash -s -- --url ${url} --key ${key} --global`;
  const win = `& ([scriptblock]::Create((irm ${url}/agent/install.ps1))) -Url ${url} -IngestKey ${key} -Global`;
  const block = (id: string, title: string, cmd: string, note: string) => `<p style="margin:12px 0 4px;font-weight:600;font-size:14px">${title}</p><p class="sub" style="margin:0 0 6px">${note}</p><div style="display:flex;gap:8px;align-items:flex-start"><textarea class="in" readonly rows="3" id="${id}" style="flex:1;font:12px var(--mono);resize:vertical">${esc(cmd)}</textarea><button class="act" type="button" data-copy="${id}">Copy</button></div>`;
  openDialog({
    title: 'Install the Claude Code agent',
    width: 680,
    body: `<p style="margin:0;font-size:14px" class="muted">One line per machine. It needs Node 18+ and installs two things: a SessionEnd hook that posts a one-line session summary with done/open tasks, and a usage agent that sends token counts every 15 minutes. Prompts and code never leave the machine. The key below is write-only.</p>${block('cc-mac', 'Mac (Terminal)', mac, 'Installs a launchd job and the hook; --global adds the HQ: block instruction to ~/.claude/CLAUDE.md. The machine shows up under its computer name.')}${block('cc-win', 'Windows (PowerShell)', win, 'Installs a Scheduled Task and the hook. Works with the default execution policy. The machine shows up under its computer name.')}<p class="sub" style="margin:12px 0 0">Test afterwards: <span class="mono">node ~/.hq/hq-session-end.mjs --ping</span> then <span class="mono">--test</span>. Uninstall: same command with -Uninstall / --uninstall.</p>`,
    cancel: 'Close',
    onOpen: (dlg) => dlg.el.querySelectorAll<HTMLButtonElement>('[data-copy]').forEach((b) => (b.onclick = async () => {
      const ta = dlg.el.querySelector<HTMLTextAreaElement>('#' + b.dataset.copy)!;
      try { await navigator.clipboard.writeText(ta.value); b.textContent = 'Copied'; setTimeout(() => (b.textContent = 'Copy'), 1500); } catch { ta.select(); }
    })),
  });
}
