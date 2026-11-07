// Account dialogs shared by Connections and Settings → Connections: manage (rename / sync / reconnect / remove) and add (from FORMS).
import { FORMS } from '@shared/forms.ts';
import type { FormField } from '@shared/forms.ts';
import { PROVIDERS } from '@shared/types.ts';
import type { AccountDTO, Provider } from '@shared/types.ts';
import { ago, esc } from '@shared/util.ts';
import { del, invalidate, patch, post } from './api.ts';
import { confirmDialog, f, openDialog, toast } from './dialogs.ts';
import { pill } from './ui.ts';

export const bustAccounts = (): void => invalidate('/api/connections', '/api/me', '/api/overview', '/api/search');

export function manageAccountDialog(a: AccountDTO, onDone: () => void): void {
  const P = PROVIDERS[a.provider];
  const status = a.status === 'ok' ? pill('Connected') : a.status === 'pending' ? pill('Pending') : pill(a.status === 'expired' ? 'Expired' : 'Error', a.lastError ?? undefined);
  openDialog({
    title: `${P.name} · ${a.label}`,
    body: `<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">${status}<span class="sub">Synced ${esc(ago(a.lastSyncAt))}${a.lastSyncMs != null ? ` in ${Math.round(a.lastSyncMs / 100) / 10}s` : ''}${a.nextSyncAt ? ` · next ${esc(ago(a.nextSyncAt).replace(' ago', ''))}` : ''}</span></div>
      ${a.lastError ? `<div class="note" style="margin:0">${esc(a.lastError)}</div>` : ''}
      ${a.meta.email ? `<p class="muted" style="margin:0">${esc(a.meta.email)}</p>` : ''}
      ${f('Label', `<input class="in" id="ma-label" value="${esc(a.label)}">`)}
      <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="act" type="button" id="ma-sync">Sync now</button>${a.provider === 'google' ? `<a class="act" href="/api/accounts/google/connect/start?accountId=${encodeURIComponent(a.id)}${a.meta.email ? `&email=${encodeURIComponent(a.meta.email)}` : ''}" style="display:inline-block">Reconnect</a>` : ''}<button class="act danger" type="button" id="ma-del" style="margin-left:auto">Remove…</button></div>`,
    primary: { label: 'Save', onClick: async (dlg) => {
      const label = dlg.q<HTMLInputElement>('#ma-label').value.trim(); if (!label) { toast('Label is required', 'bad'); return; }
      if (label !== a.label) await patch(`/api/accounts/${a.id}`, { label });
      bustAccounts(); dlg.close(); onDone();
    } },
    onOpen: (dlg) => {
      dlg.q<HTMLButtonElement>('#ma-sync').onclick = async () => {
        try { dlg.busy(true); await post(`/api/accounts/${a.id}/sync`); toast('Sync requested'); bustAccounts(); } catch (e) { toast(String((e as Error).message), 'bad'); } finally { dlg.busy(false); }
      };
      dlg.q<HTMLButtonElement>('#ma-del').onclick = async () => {
        dlg.close();
        if (!(await confirmDialog('Remove account', `Remove <b>${esc(P.name)} · ${esc(a.label)}</b>? Its token is deleted and its synced data disappears from the dashboard.`, 'Remove'))) return;
        try { await del(`/api/accounts/${a.id}`); bustAccounts(); toast('Account removed'); onDone(); } catch (e) { toast(String((e as Error).message), 'bad'); }
      };
    },
  });
}

const ctl = (x: FormField, id: string): string => x.multiline
  ? `<textarea class="in" id="${id}" placeholder="${esc(x.placeholder ?? '')}" spellcheck="false"></textarea>`
  : `<input class="in" id="${id}" type="${x.secret ? 'password' : 'text'}" placeholder="${esc(x.placeholder ?? '')}" autocomplete="off" spellcheck="false">`;

export function addAccountDialog(provider: Provider, onDone: () => void): void {
  const P = PROVIDERS[provider], F = FORMS[provider];
  if (F.oauth) {
    openDialog({
      title: `Add ${P.name} account`,
      body: `<p class="muted" style="margin:0">${esc(F.help)}</p><a class="btn" href="/api/accounts/google/connect/start" style="text-align:center;display:block">Connect with Google</a>`,
      cancel: 'Close',
    });
    return;
  }
  const body = f('Label', `<input class="in" id="aa-label" placeholder="${esc(P.multi ? 'e.g. Work' : P.name)}">`)
    + F.fields.map((x) => `<label class="f"><span>${esc(x.label)}${x.optional ? ' (optional)' : ''}</span>${ctl(x, 'aa-' + x.key)}<span>${esc(x.hint)}</span></label>`).join('')
    + F.metaFields.map((x) => `<label class="f"><span>${esc(x.label)}${x.optional ? ' (optional)' : ''}</span>${ctl(x, 'am-' + x.key)}<span>${esc(x.hint)}</span></label>`).join('')
    + `<p class="sub" style="margin:0">${esc(F.help)}</p>`;
  openDialog({
    title: `Add ${P.name} account`,
    body,
    primary: { label: 'Connect', onClick: async (dlg) => {
      const label = dlg.q<HTMLInputElement>('#aa-label').value.trim(); if (!label) { toast('Give the account a label', 'bad'); return; }
      const secrets: Record<string, string> = { provider };
      for (const x of F.fields) {
        const v = dlg.q<HTMLInputElement | HTMLTextAreaElement>('#aa-' + x.key).value.trim();
        if (!v && !x.optional) { toast(`${x.label} is required`, 'bad'); return; }
        if (v) secrets[x.key] = v;
      }
      const meta: Record<string, string> = {};
      for (const x of F.metaFields) {
        const v = dlg.q<HTMLInputElement | HTMLTextAreaElement>('#am-' + x.key).value.trim();
        if (!v && !x.optional) { toast(`${x.label} is required`, 'bad'); return; }
        if (v) meta[x.key] = v;
      }
      await post('/api/accounts', { provider, label, secrets, meta });
      bustAccounts(); dlg.close(); toast('Account added, first sync started'); onDone();
    } },
  });
}
