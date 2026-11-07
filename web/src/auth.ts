// Sign-in screen and passkey helpers (@simplewebauthn/browser against /api/auth/*).
import { startAuthentication, startRegistration, browserSupportsWebAuthn } from '@simplewebauthn/browser';
import type { PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser';
import type { PasskeyDTO } from '@shared/types.ts';
import { esc } from '@shared/util.ts';
import { get, post } from './api.ts';

export interface AuthStatus { signedIn: boolean; hasPasskeys: boolean; allowedEmails: string[]; claimed?: boolean; branding?: { appName: string; host: string; origin: string; ownerName: string; contact: string } }

export const fetchStatus = (): Promise<AuthStatus> => get<AuthStatus>('/api/auth/status');

let shown = false;

export function showSignIn(status?: AuthStatus | null, error?: string): void {
  if (shown) return;
  shown = true;
  document.body.classList.add('signin');
  const err = error ?? new URLSearchParams(location.search).get('error') ?? '';
  const passkeys = false; // passkeys are not offered: Google sign-in is the only method
  void status; void browserSupportsWebAuthn;
  const b = status?.branding ?? { appName: 'HQ', host: location.host, origin: location.origin, ownerName: '', contact: '' };
  const owner = b.ownerName || 'its owner';
  const claimed = status?.claimed !== false;
  document.title = b.appName;
  const wrap = document.createElement('div');
  wrap.className = 'signin-wrap';
  wrap.innerHTML = `<div class="landing">
    <div class="landing-copy">
      <div class="brand"><div class="mk">${esc(b.appName[0]?.toUpperCase() || 'H')}</div><div>${esc(b.appName)}<small>${esc(b.host)}</small></div></div>
      <h1>A private dashboard for one person.</h1>
      <p>${esc(b.appName)} is ${esc(owner)}&rsquo;s personal, read-only view of their own projects and accounts: domains, sites, databases, revenue, app stores, mail, calendar and Claude usage, all in one place.</p>
      <p>It is not a product or a service. There is nothing to sign up for: only ${esc(owner)} can sign in, with an allow-listed Google account. Every other account is refused.</p>
      <p class="muted">Read-only everywhere. Tokens are stored encrypted. Nothing here can change a provider.</p>
    </div>
    <div class="card signin-card">
      <h2>Sign in</h2>
      <p class="sub">${claimed ? `Only ${esc(owner)}&rsquo;s own Google accounts can sign in.` : 'Fresh install: the first Google account to sign in becomes the owner.'}</p>
      ${err ? `<div class="note" id="signErr">${esc(err)}</div>` : '<div class="note" id="signErr" hidden></div>'}
      ${passkeys ? '<button class="btn" type="button" id="pkBtn">Continue with passkey</button>' : ''}
      <a class="btn" href="/api/auth/google/start?next=/" style="text-align:center;display:block">Sign in with Google</a>
    </div>
  </div>
  <footer class="landing-foot"><span>${esc(b.appName)}</span><span><a href="/privacy">Privacy policy</a> &middot; <a href="/terms">Terms of use</a>${b.contact ? ` &middot; <a href="mailto:${esc(b.contact)}">Contact</a>` : ''}</span></footer>`;
  document.body.appendChild(wrap);
  const btn = wrap.querySelector<HTMLButtonElement>('#pkBtn');
  const note = wrap.querySelector<HTMLElement>('#signErr')!;
  if (btn) btn.onclick = async () => {
    btn.disabled = true; btn.textContent = 'Waiting for your passkey…';
    try {
      await loginWithPasskey();
      reloadIntoApp();
    } catch (e) {
      note.hidden = false;
      note.textContent = e instanceof Error ? e.message : String(e);
      btn.disabled = false; btn.textContent = 'Continue with passkey';
    }
  };
}

/** Reload without the ?error= parameter. */
function reloadIntoApp(): void {
  const sp = new URLSearchParams(location.search);
  sp.delete('error');
  const qs = sp.toString();
  const url = location.pathname + (qs ? '?' + qs : '') + location.hash;
  if (url !== location.pathname + location.search + location.hash) location.replace(url);
  location.reload();
}

export async function loginWithPasskey(): Promise<void> {
  const { challengeId, options } = await post<{ challengeId: string; options: PublicKeyCredentialRequestOptionsJSON }>('/api/auth/passkey/login/options');
  const response = await startAuthentication({ optionsJSON: options });
  await post<{ ok: boolean }>('/api/auth/passkey/login/verify', { challengeId, response });
}

export async function registerPasskey(label: string): Promise<PasskeyDTO> {
  const { challengeId, options } = await post<{ challengeId: string; options: PublicKeyCredentialCreationOptionsJSON }>('/api/auth/passkey/register/options');
  const response = await startRegistration({ optionsJSON: options });
  return post<PasskeyDTO>('/api/auth/passkey/register/verify', { challengeId, response, label });
}

export function defaultPasskeyLabel(): string {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const p = nav.userAgentData?.platform;
  if (p) return p;
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows';
  if (/Android/.test(ua)) return 'Android';
  return 'This device';
}

export async function signOut(): Promise<void> {
  try { await post('/api/auth/signout'); } catch { /* ignore */ }
  location.reload();
}
