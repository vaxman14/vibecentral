#!/usr/bin/env node
// One-time: register the sending domain in Resend and create its DNS records in Cloudflare, then ask Resend to verify.
// Usage: node scripts/resend-dns.mjs your-domain.com
// RESEND_API_KEY and CF_DNS_TOKEN (Cloudflare token with DNS:Edit on the zone) are read from .dev.vars or the environment.
import { readFileSync, existsSync } from 'node:fs';

const domain = process.argv[2];
if (!domain) { console.error('usage: node scripts/resend-dns.mjs <domain>'); process.exit(1); }
const vars = {};
if (existsSync('.dev.vars')) for (const line of readFileSync('.dev.vars', 'utf8').split(/\r?\n/)) { const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*(#.*)?$/); if (m) vars[m[1]] = m[2].replace(/^"|"$/g, ''); }
const RESEND = process.env.RESEND_API_KEY || vars.RESEND_API_KEY;
const CF = process.env.CF_DNS_TOKEN || vars.CF_DNS_TOKEN;
if (!RESEND) { console.error('RESEND_API_KEY missing'); process.exit(1); }
if (!CF) { console.error('CF_DNS_TOKEN missing (Cloudflare token with DNS:Edit on ' + domain + ')'); process.exit(1); }

const rs = async (path, init = {}) => {
  const r = await fetch('https://api.resend.com' + path, { ...init, headers: { authorization: `Bearer ${RESEND}`, 'content-type': 'application/json', ...(init.headers || {}) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok && r.status !== 422) throw new Error(`Resend ${path} → ${r.status} ${JSON.stringify(j)}`);
  return j;
};
const cf = async (path, init = {}) => {
  const r = await fetch('https://api.cloudflare.com/client/v4' + path, { ...init, headers: { authorization: `Bearer ${CF}`, 'content-type': 'application/json' } });
  const j = await r.json();
  if (!j.success) throw new Error(`Cloudflare ${path} → ${JSON.stringify(j.errors)}`);
  return j.result;
};

// 1. domain in Resend (reuse if it exists)
let dom = (await rs('/domains')).data?.find((d) => d.name === domain);
if (!dom) { dom = await rs('/domains', { method: 'POST', body: JSON.stringify({ name: domain, region: 'us-east-1' }) }); console.log('created Resend domain', dom.id); }
dom = await rs(`/domains/${dom.id}`);
console.log(`Resend domain ${domain}: ${dom.status}`);

// 2. zone in Cloudflare
const zone = (await cf(`/zones?name=${domain}`))[0];
if (!zone) throw new Error(`zone ${domain} not visible to this token`);
const existing = await cf(`/zones/${zone.id}/dns_records?per_page=500`);

for (const rec of dom.records) {
  const name = rec.name.endsWith(domain) ? rec.name : `${rec.name}.${domain}`;
  const type = rec.type.toUpperCase();
  const content = rec.value;
  const dup = existing.find((e) => e.type === type && e.name === name && (type !== 'MX' ? e.content === content : e.content === content.replace(/\.$/, '')));
  if (dup) { console.log(`= ${type} ${name} already present`); continue; }
  const body = { type, name, content, ttl: 1, proxied: false };
  if (type === 'MX') body.priority = Number(rec.priority ?? 10);
  await cf(`/zones/${zone.id}/dns_records`, { method: 'POST', body: JSON.stringify(body) });
  console.log(`+ ${type} ${name} → ${content.slice(0, 60)}${content.length > 60 ? '…' : ''}`);
}

// 3. verify
await rs(`/domains/${dom.id}/verify`, { method: 'POST' });
console.log('verification requested; Resend usually confirms within a few minutes. Check: https://resend.com/domains');
