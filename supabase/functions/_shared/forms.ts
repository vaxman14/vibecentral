// Add-account form definitions. The web app renders these; the Worker validates against them.
import type { Provider } from './types.ts';

export interface FormField { key: string; label: string; hint: string; secret: boolean; multiline?: boolean; optional?: boolean; placeholder?: string }
export interface ProviderForm { oauth?: boolean; fields: FormField[]; metaFields: FormField[]; help: string }

export const FORMS: Record<Provider, ProviderForm> = {
  cloudflare: {
    fields: [{ key: 'apiToken', label: 'API token', hint: 'My Profile → API Tokens → Create Custom Token, read-only permissions', secret: true }],
    metaFields: [],
    help: 'One token can cover both accounts if they share a login. Zones, DNS, Workers, tunnels, analytics and Registrar are read.',
  },
  netlify: {
    fields: [{ key: 'accessToken', label: 'Personal access token', hint: 'User settings → Applications → Personal access tokens', secret: true }],
    metaFields: [],
    help: 'Netlify tokens have no scopes. Vibe Central only ever calls GET endpoints.',
  },
  supabase: {
    fields: [{ key: 'accessToken', label: 'Access token', hint: 'supabase.com/dashboard/account/tokens', secret: true }],
    metaFields: [],
    help: 'One token per Supabase login. Projects, health, advisors, and SELECT-only queries for size and auth users.',
  },
  stripe: {
    fields: [{ key: 'restrictedKey', label: 'Restricted key (rk_live_…)', hint: 'Developers → API keys → Create restricted key, Read permissions only', secret: true }],
    metaFields: [],
    help: 'Read on Balance, Balance transactions, Charges, Payment intents, Customers, Subscriptions, Invoices, Payouts, Products, Prices.',
  },
  paypal: {
    fields: [
      { key: 'clientId', label: 'Client ID', hint: 'developer.paypal.com → Apps & Credentials → Live', secret: false },
      { key: 'clientSecret', label: 'Secret', hint: 'Same app, Secret key', secret: true },
    ],
    metaFields: [],
    help: 'Enable Transaction Search on the app. Balances and transactions are read with the Reporting API.',
  },
  google: {
    oauth: true,
    fields: [],
    metaFields: [],
    help: 'Signs you in with Google and asks for read-only Gmail and Calendar. Three accounts, one at a time.',
  },
  github: {
    fields: [{ key: 'token', label: 'Fine-grained token (github_pat_…)', hint: 'Settings → Developer settings → Fine-grained tokens, read-only permissions', secret: true }],
    metaFields: [],
    help: 'Metadata, Contents, Pull requests, Actions and Issues: Read.',
  },
  appstore: {
    fields: [
      { key: 'issuerId', label: 'Issuer ID', hint: 'Users and Access → Integrations → App Store Connect API', secret: false },
      { key: 'keyId', label: 'Key ID', hint: 'The team key you generated', secret: false },
      { key: 'privateKeyP8', label: 'Private key (.p8 contents)', hint: 'Paste the whole file, including BEGIN/END lines', secret: true, multiline: true },
    ],
    metaFields: [],
    help: 'Apps, versions, review states, builds, TestFlight and ratings are read. Role Developer is enough.',
  },
  googleplay: {
    fields: [{ key: 'serviceAccountJson', label: 'Service account JSON', hint: 'Paste the whole key file', secret: true, multiline: true }],
    metaFields: [{ key: 'reportsBucket', label: 'Reports bucket', hint: 'Play Console → Download reports → the gs://pubsite_prod_rev_… id (without gs://)', secret: false, placeholder: 'pubsite_prod_rev_0123456789' }],
    help: 'Strictly read-only: ratings and installs from the reports bucket, reviews from the Reviews API. Release status is not read (it would need a write call).',
  },
  anthropic: {
    fields: [{ key: 'adminKey', label: 'Admin key (sk-ant-admin…)', hint: 'console.anthropic.com → Settings → Organization → Admin keys', secret: true }],
    metaFields: [],
    help: 'Only the usage report, cost report and workspace list are called.',
  },
};
