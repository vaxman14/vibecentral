// GitHub with a fine-grained read-only token. GET only.
import type { ActionsDay, GhPull, GhRepo, GhRun } from '../types.ts';
import { dayKey, lastNDays } from '../util.ts';
import { Collector, SyncError, addDay, daysAgo, hoursAgo, isExpired, mapLimit, num, str, strOrNull, type SyncContext, secretsFor } from './ctx.ts';

const API = 'https://api.github.com';
const TOP_REPOS = 15;

interface GhUser { login: string }
interface GhRepoRaw { full_name: string; name: string; private: boolean; default_branch: string; pushed_at: string | null; open_issues_count: number; stargazers_count: number; language: string | null; html_url: string; archived?: boolean; fork?: boolean }
interface GhPullRaw { number: number; title: string; user?: { login?: string } | null; created_at: string; updated_at: string; merged_at?: string | null; draft?: boolean; html_url: string; head?: { ref?: string } }
interface GhRunRaw { id: number; name?: string | null; display_title?: string; status: string; conclusion: string | null; head_branch: string | null; created_at: string; updated_at: string; html_url: string; event: string }

export async function sync(ctx: SyncContext): Promise<void> {
  const { token } = secretsFor(ctx, 'github');
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'hq-sync' };
  const get = <T>(path: string, label: string, allow?: number[]) => ctx.fetchJson<T>(`${API}${path}`, { headers, label, allow });

  const me = await get<GhUser>('/user', 'user');

  // ---- repos (3 pages max, most recently pushed first) ----
  const reposRaw: GhRepoRaw[] = [];
  for (let page = 1; page <= 3; page++) {
    const batch = await get<GhRepoRaw[]>(`/user/repos?per_page=100&sort=pushed&affiliation=owner&page=${page}`, 'repos');
    reposRaw.push(...(batch ?? []));
    if (!batch || batch.length < 100) break;
  }

  // ---- open PR counts across all repos in one search call ----
  const openPRsByRepo = new Map<string, number>();
  try {
    const q = encodeURIComponent(`is:pr is:open user:${me.login}`);
    const res = await get<{ items?: { repository_url: string }[]; total_count?: number }>(`/search/issues?q=${q}&per_page=100&advanced_search=true`, 'open PR search');
    for (const it of res.items ?? []) {
      const full = it.repository_url.replace(/^.*\/repos\//, '');
      openPRsByRepo.set(full, (openPRsByRepo.get(full) ?? 0) + 1);
    }
  } catch (e) { if (isExpired(e) && (e as { status?: number }).status === 401) throw e; ctx.log(`PR search failed: ${(e as Error).message}`); }

  const repos: GhRepo[] = reposRaw.map((r) => {
    const openPRs = openPRsByRepo.get(r.full_name) ?? 0;
    return {
      fullName: r.full_name, name: r.name, private: r.private, defaultBranch: r.default_branch, pushedAt: r.pushed_at ?? '',
      openIssues: Math.max(0, num(r.open_issues_count) - openPRs), openPRs, stars: num(r.stargazers_count), language: r.language, url: r.html_url,
    };
  });
  await ctx.writers.snapshot('repos', repos);

  // ---- details for the 15 most recently pushed repos ----
  const top = reposRaw.filter((r) => !r.archived).slice(0, TOP_REPOS);
  const weekAgo = daysAgo(ctx.now, 7);
  const dayAgo = hoursAgo(ctx.now, 24);
  const pulls: GhPull[] = [];
  const runs: GhRun[] = [];
  const part = new Collector('repos');
  await mapLimit(top, 5, async (r) => {
    const full = r.full_name;
    let any = false;
    try {
      const open = await get<GhPullRaw[]>(`/repos/${full}/pulls?state=open&per_page=20`, `pulls ${full}`);
      for (const p of open ?? []) pulls.push(toPull(p, full));
      any = true;
    } catch (e) { if (isExpired(e)) throw e; part.fail(e, `${full} pulls`); }
    try {
      const res = await get<{ workflow_runs?: GhRunRaw[] }>(`/repos/${full}/actions/runs?per_page=20`, `runs ${full}`, [404]);
      for (const w of res?.workflow_runs ?? []) {
        const run: GhRun = { repo: full, id: w.id, name: str(w.name ?? w.display_title, 'workflow'), status: w.status, conclusion: w.conclusion, branch: w.head_branch, createdAt: w.created_at, updatedAt: w.updated_at, url: w.html_url, event: w.event };
        runs.push(run);
        if (run.conclusion === 'failure' && new Date(run.updatedAt) >= weekAgo) {
          ctx.writers.event({ fingerprint: `gh:run:${run.id}`, title: `Actions run failed: ${r.name} · ${run.name}`, detail: `${run.branch ?? ''} · ${run.event}`.trim(), occurredAt: run.updatedAt, link: { kind: 'repo', ref: full } });
          if (run.branch === r.default_branch && new Date(run.updatedAt) >= dayAgo) {
            ctx.writers.alert({ kind: 'failed_run', fingerprint: `failed_run:${run.id}`, title: `Actions failed on ${r.name}`, body: `${run.name} failed on ${run.branch} (${run.event}).\n${run.url}`, link: { kind: 'repo', ref: full } });
          }
        }
      }
      any = true;
    } catch (e) { if (isExpired(e)) throw e; part.fail(e, `${full} runs`); }
    try {
      const closed = await get<GhPullRaw[]>(`/repos/${full}/pulls?state=closed&sort=updated&direction=desc&per_page=10`, `merged ${full}`);
      for (const p of closed ?? []) {
        if (p.merged_at && new Date(p.merged_at) >= weekAgo) {
          ctx.writers.event({ fingerprint: `gh:pr:${full}#${p.number}`, title: `Merged PR #${p.number}: ${p.title}`, detail: `${r.name} · ${p.user?.login ?? ''}`.trim(), occurredAt: p.merged_at, link: { kind: 'repo', ref: full } });
        }
      }
      any = true;
    } catch (e) { if (isExpired(e)) throw e; part.fail(e, `${full} merged`); }
    if (any) part.success();
  });
  if (top.length) part.assertSome();

  pulls.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  await ctx.writers.snapshot('pulls', pulls);
  await ctx.writers.snapshot('runs', runs);

  const perDay = new Map<string, ActionsDay>();
  for (const day of lastNDays(7, ctx.tz, ctx.now)) perDay.set(day, { runs: 0, failed: 0 });
  for (const run of runs) {
    if (new Date(run.createdAt) < weekAgo) continue;
    addDay(perDay, dayKey(run.createdAt, ctx.tz), { runs: 1, failed: run.conclusion === 'failure' ? 1 : 0 });
  }
  for (const [day, v] of perDay) ctx.writers.metric('actions', day, { ...v });
  if (part.errors.length) ctx.log(part.summary() ?? '');
  if (!reposRaw.length) throw new SyncError('GitHub: the token can see no repositories (check Repository access on the token)');
}

function toPull(p: GhPullRaw, repo: string): GhPull {
  return { repo, number: p.number, title: p.title, author: p.user?.login ?? '', createdAt: p.created_at, updatedAt: p.updated_at, draft: !!p.draft, url: p.html_url, headBranch: strOrNull(p.head?.ref) ?? '' };
}
