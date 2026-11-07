// Public pages rendered from the deployment's identity: landing copy lives in the web app, but the
// privacy policy and terms are served here so the owner's name, contact and domain are always current.
import { Hono } from 'hono';
import type { Env, Vars } from '../env.ts';
import { branding } from '../branding.ts';
import { esc } from '@shared/util.ts';

export const legalRoutes = new Hono<{ Bindings: Env; Variables: Vars }>();

const page = (title: string, desc: string, body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta name="description" content="${esc(desc)}"><link rel="stylesheet" href="/legal.css"></head>
<body><main class="legal">${body}</main></body></html>`;

const EFFECTIVE = 'November 7, 2026';

legalRoutes.get('/privacy', async (c) => {
  const b = await branding(c);
  const who = b.ownerName || 'the owner';
  const poss = b.ownerName ? `${esc(b.ownerName)}'s` : "the owner's";
  const html = page(`Privacy policy · ${b.appName}`, `Privacy policy for ${b.appName}, a private single-user dashboard at ${b.host}.`, `
  <a class="brand" href="/"><span class="mk">${esc(b.appName[0])}</span><span>${esc(b.appName)}<small>${esc(b.host)}</small></span></a>
  <h1>Privacy policy</h1>
  <p class="meta">Effective ${EFFECTIVE}</p>
  <h2>What ${esc(b.appName)} is</h2>
  <p>${esc(b.appName)} at ${esc(b.host)} is a private, personal dashboard operated by ${esc(who)}. It has exactly one user. It is not offered to the public, there is no sign-up, and no account other than ${poss} own can sign in. This policy exists so that the services the dashboard reads from, including Google, can see how data is handled.</p>
  <h2>What the dashboard reads</h2>
  <p>With read-only credentials that ${esc(who)} creates, the dashboard reads information from ${poss} own accounts at services such as Cloudflare, Netlify, Supabase, Stripe, PayPal, GitHub, App Store Connect, Google Play, Anthropic and Google. Nothing is ever written to any of these services.</p>
  <p>From Google, using the <code>gmail.readonly</code> and <code>calendar.readonly</code> scopes on ${poss} own accounts, the dashboard reads:</p>
  <ul>
    <li>Mail headers only: sender, subject, a short preview snippet, date, and label flags such as Important and Unread. Message bodies and attachments are never stored.</li>
    <li>Calendar events for the next two weeks: title, calendar name, start and end times.</li>
    <li>The account's email address and basic profile, used only to show which account the data belongs to.</li>
  </ul>
  <h2>How data is stored and protected</h2>
  <ul>
    <li>Data is stored in a database controlled by ${esc(who)} (a Supabase project) and served through Cloudflare. Alert emails, if enabled, are sent through Resend to ${poss} own address.</li>
    <li>Every access token and refresh token is encrypted at rest with AES-256-GCM. Keys are held only in the dashboard's server configuration.</li>
    <li>Mail metadata is kept for at most 60 days and calendar events for 30 days, then deleted automatically. Everything can be deleted at any time from Settings → Data &amp; export → Delete.</li>
    <li>Access requires sign-in with an allow-listed Google account. Sessions expire after 30 days by default.</li>
  </ul>
  <h2>Sharing</h2>
  <p>No data is sold, shared, transferred, or used for advertising, analytics, profiling, or training of any model. No third party receives it beyond the hosting and email providers named above, which process it only to run the dashboard.</p>
  <h2>Google API Services</h2>
  <p>${esc(b.appName)}'s use of information received from Google APIs adheres to the <a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>, including the Limited Use requirements. Google data is used only to display ${poss} own mail and calendar inside the dashboard, is never transferred to others, is never used for advertising, and is never read by a human except ${esc(who)}.</p>
  <h2>Revoking access</h2>
  <p>Google access can be revoked at any time at <a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a>, and every other token can be removed under Connections in the dashboard. Revoking a token stops all further reads immediately.</p>
  <h2>Contact</h2>
  <p>${esc(who)}${b.contact ? ` · <a href="mailto:${esc(b.contact)}">${esc(b.contact)}</a>` : ''}</p>
  <footer><span>${esc(b.appName)}</span><span><a href="/">Home</a> · <a href="/terms">Terms of use</a></span></footer>`);
  return c.html(html);
});

legalRoutes.get('/terms', async (c) => {
  const b = await branding(c);
  const who = b.ownerName || 'the owner';
  const poss = b.ownerName ? `${esc(b.ownerName)}'s` : "the owner's";
  const html = page(`Terms of use · ${b.appName}`, `Terms of use for ${b.appName}, a private single-user dashboard at ${b.host}.`, `
  <a class="brand" href="/"><span class="mk">${esc(b.appName[0])}</span><span>${esc(b.appName)}<small>${esc(b.host)}</small></span></a>
  <h1>Terms of use</h1>
  <p class="meta">Effective ${EFFECTIVE}</p>
  <h2>Private, single-user software</h2>
  <p>${esc(b.appName)} at ${esc(b.host)} is a personal tool operated by ${esc(who)} for ${poss} own use. It is not a product, a service, or an offer to anyone else. No accounts are created for other people, and any attempt to sign in with an account that is not ${poss} is refused.</p>
  <h2>Permitted use</h2>
  <p>Only ${esc(who)} may sign in to or use the dashboard. Visitors may read this page, the privacy policy, and the landing page. Nothing else is available to the public, and no one else is granted any right to access, copy, or use the dashboard or the data behind it.</p>
  <h2>Read-only by design</h2>
  <p>The dashboard only reads from the services it is connected to. It does not and cannot change, create, or delete anything in those services. Any action in a connected service must be taken in that service directly.</p>
  <h2>No warranty</h2>
  <p>The dashboard is provided as is, for personal use, without warranties of any kind. Figures shown are summaries pulled from third-party services and may lag or differ from those services' own records. The connected services are the source of truth.</p>
  <h2>Third-party services</h2>
  <p>Use of Google, Cloudflare, Netlify, Supabase, Stripe, PayPal, GitHub, Apple, and Anthropic data through the dashboard is subject to each of those services' own terms. The dashboard's use of Google user data is described in the <a href="/privacy">privacy policy</a>.</p>
  <h2>Changes</h2>
  <p>These terms may be updated at any time by replacing this page. The effective date above shows the current version.</p>
  <h2>Contact</h2>
  <p>${esc(who)}${b.contact ? ` · <a href="mailto:${esc(b.contact)}">${esc(b.contact)}</a>` : ''}</p>
  <footer><span>${esc(b.appName)}</span><span><a href="/">Home</a> · <a href="/privacy">Privacy policy</a></span></footer>`);
  return c.html(html);
});
