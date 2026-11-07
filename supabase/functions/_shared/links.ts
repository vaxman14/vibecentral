// project_links lookup: provider things (zone name, site id, project ref, bundle id, owner/repo, worker name,
// tunnel id) -> project_id. Loaded once per sync invocation.
import type { LinkRef } from './providers/ctx.ts';

export interface LinkRow { kind: string; ref: string; project_id: string; account_id: string | null }

export class LinkIndex {
  private readonly byKey = new Map<string, LinkRow[]>();
  constructor(rows: LinkRow[]) {
    for (const r of rows) {
      const k = key(r.kind, r.ref);
      const list = this.byKey.get(k) ?? [];
      list.push(r);
      this.byKey.set(k, list);
    }
  }
  /** Prefer a link on the same account; otherwise any project linked to that ref. */
  resolve(link: LinkRef | null | undefined, accountId?: string | null): string | null {
    if (!link) return null;
    const rows = this.byKey.get(key(link.kind, link.ref));
    if (!rows?.length) return null;
    return (rows.find((r) => accountId && r.account_id === accountId) ?? rows.find((r) => !r.account_id) ?? rows[0]).project_id;
  }
}

const key = (kind: string, ref: string) => `${kind}:${ref.trim().toLowerCase()}`;
