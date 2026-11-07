// One reusable dialog (reuses .pal-bg + .pal) plus toasts and a confirm helper.
import { esc } from '@shared/util.ts';

export interface DialogOpts {
  title: string;
  body: string;
  primary?: { label: string; danger?: boolean; onClick: (dlg: Dialog) => void | Promise<void> };
  cancel?: string | false;
  extra?: string;             // extra footer buttons (HTML), wired by the caller via dlg.el
  onOpen?: (dlg: Dialog) => void;
  width?: number;
}

export interface Dialog {
  el: HTMLElement;
  close: () => void;
  busy: (b: boolean) => void;
  q: <T extends Element = HTMLElement>(sel: string) => T;
}

let host: HTMLElement | null = null;
function getHost(): HTMLElement {
  if (!host) { host = document.createElement('div'); host.id = 'dlg'; document.body.appendChild(host); }
  return host;
}

export function closeDialog(): void { if (host) host.innerHTML = ''; }

export function openDialog(o: DialogOpts): Dialog {
  const H = getHost();
  const prevFocus = document.activeElement as HTMLElement | null;
  H.innerHTML = `<div class="pal-bg"><div class="pal" role="dialog" aria-modal="true" aria-label="${esc(o.title)}"${o.width ? ` style="width:${o.width}px"` : ''}>
    <div class="dlg-hd"><span>${esc(o.title)}</span><button class="act" type="button" data-x aria-label="Close">✕</button></div>
    <div class="dlg-body">${o.body}</div>
    <div class="dlg-ft">${o.extra ?? ''}${o.cancel === false ? '' : `<button class="act" type="button" data-cancel>${esc(o.cancel ?? 'Cancel')}</button>`}${o.primary ? `<button class="btn" type="button" data-ok${o.primary.danger ? ' style="background:var(--danger);color:#fff"' : ''}>${esc(o.primary.label)}</button>` : ''}</div>
  </div></div>`;
  const bg = H.firstElementChild as HTMLElement;
  const el = bg.firstElementChild as HTMLElement;
  const close = () => { H.innerHTML = ''; document.removeEventListener('keydown', onKey); prevFocus?.focus?.(); };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  const dlg: Dialog = {
    el, close,
    // the close (✕) and Cancel buttons stay usable while a request is in flight, so a hung request never traps the user
    busy: (b) => { el.querySelectorAll<HTMLButtonElement>('button:not([data-x]):not([data-cancel])').forEach((x) => (x.disabled = b)); },
    q: <T extends Element = HTMLElement>(sel: string) => el.querySelector(sel) as T,
  };
  bg.onclick = (e) => { if (e.target === bg) close(); };
  el.querySelector<HTMLButtonElement>('[data-x]')!.onclick = close;
  el.querySelector<HTMLButtonElement>('[data-cancel]')?.addEventListener('click', close);
  const ok = el.querySelector<HTMLButtonElement>('[data-ok]');
  if (ok && o.primary) {
    ok.onclick = async () => {
      try { dlg.busy(true); await o.primary!.onClick(dlg); } catch (e) { toast(e instanceof Error ? e.message : String(e), 'bad'); } finally { if (H.contains(el)) dlg.busy(false); }
    };
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') { e.preventDefault(); ok.click(); } });
  }
  document.addEventListener('keydown', onKey);
  o.onOpen?.(dlg);
  const first = el.querySelector<HTMLElement>('input,select,textarea,button:not([data-x])');
  first?.focus();
  return dlg;
}

/** A simple labelled form field for dialog bodies. */
export const f = (label: string, ctl: string): string => `<label class="f"><span>${esc(label)}</span>${ctl}</label>`;

export function confirmDialog(title: string, text: string, label = 'Delete', danger = true): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const d = openDialog({
      title,
      body: `<p style="margin:0">${text}</p>`,
      primary: { label, danger, onClick: (dlg) => { done = true; dlg.close(); resolve(true); } },
    });
    const obs = new MutationObserver(() => { if (!document.body.contains(d.el)) { obs.disconnect(); if (!done) resolve(false); } });
    obs.observe(getHost(), { childList: true });
  });
}

/* ---------- toasts ---------- */
export function toast(msg: string, kind: 'good' | 'bad' = 'good', ms = 2600): void {
  document.querySelectorAll('.toast').forEach((t) => t.remove());
  const t = document.createElement('div');
  t.className = 'toast';
  t.innerHTML = `<span class="pill ${kind}" style="padding:8px 14px;font-size:13px">${esc(msg)}</span>`;
  document.body.appendChild(t);
  setTimeout(() => { t.classList.add('gone'); setTimeout(() => t.remove(), 320); }, ms);
}

/** Show a "Saved" pill next to a control for 1.5s. */
export function flashSaved(ctl: Element | null): void {
  if (!ctl) return;
  const host = ctl.closest('.ctl') ?? ctl.parentElement;
  if (!host) return;
  host.querySelector('.saved')?.remove();
  const p = document.createElement('span');
  p.className = 'pill good saved';
  p.textContent = 'Saved';
  host.insertBefore(p, host.firstChild);
  setTimeout(() => p.remove(), 1500);
}
