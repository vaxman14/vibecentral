// Provider registry: one read-only sync(ctx) per provider.
import type { Provider } from '../types.ts';
import type { ProviderSync } from './ctx.ts';
import { sync as cloudflare } from './cloudflare.ts';
import { sync as netlify } from './netlify.ts';
import { sync as supabase } from './supabase.ts';
import { sync as stripe } from './stripe.ts';
import { sync as paypal } from './paypal.ts';
import { sync as google } from './google.ts';
import { sync as github } from './github.ts';
import { sync as appstore } from './appstore.ts';
import { sync as googleplay } from './googleplay.ts';
import { sync as anthropic } from './anthropic.ts';

export const PROVIDER_SYNC: Record<Provider, ProviderSync> = {
  cloudflare, netlify, supabase, stripe, paypal, google, github, appstore, googleplay, anthropic,
};

/** snapshots.kind values each provider writes (the Worker reads these). */
export const SNAPSHOT_KINDS: Record<Provider, string[]> = {
  cloudflare: ['zones', 'workers', 'tunnels'],
  netlify: ['sites', 'deploys'],
  supabase: ['projects'],
  stripe: ['stripe'],
  paypal: ['paypal'],
  google: ['google'],
  github: ['repos', 'pulls', 'runs'],
  appstore: ['apps'],
  googleplay: ['apps'],
  anthropic: ['anthropic'],
};

/** metrics.kind values: traffic (TrafficDay), deploys (DeployDay), revenue (RevenueDay), actions (ActionsDay), spend (SpendDay). */
export const METRIC_KINDS = ['traffic', 'deploys', 'revenue', 'actions', 'spend'] as const;
