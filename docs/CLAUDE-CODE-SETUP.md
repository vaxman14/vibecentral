# Claude Code → HQ: the hook and the usage agent

Two small Node scripts run on each machine where you use Claude Code. They post to the dashboard's write-only ingest endpoint. Nothing is read back.

| Script | Runs when | Sends |
|---|---|---|
| `hq-session-end.mjs` | Claude Code **SessionEnd** hook, once per session | one `SessionIngest`: folder name, branch, one-line summary, done and open lists |
| `hq-usage-agent.mjs` | every 15 minutes (Task Scheduler on Windows, launchd on macOS) | `UsageIngest`: token totals per day, folder and model |

Both read `~/.hq/config.json`:

```json
{ "url": "https://hq.yourdomain.com", "ingestKey": "hqi_...", "machine": "Laptop", "ignoreFolders": ["scratch"] }
```

`machine` defaults to the hostname. `ignoreFolders` (optional) lists folder names to skip entirely. The environment variables `HQ_URL`, `HQ_INGEST_KEY` and `HQ_MACHINE` override the file; `HQ_HOME` moves the `~/.hq` directory (useful for testing).

## Prerequisites

- **Node.js 18 or newer** on the machine (`node -v`). The scripts have no dependencies.
- **The ingest key.** Connections → Claude Code → Install shows it. It is the Worker secret `HQ_INGEST_KEY`. It can only write sessions and usage rows; it cannot read anything from the dashboard.
- Claude Code in any form: the CLI, or the Claude desktop app's Code tab. Both read the same `~/.claude/settings.json`, fire the same hooks and write the same `~/.claude/projects/**/*.jsonl` transcripts.

## Install

Open **Connections → Claude Code → Install** in the dashboard and copy the line for your machine. The dashboard serves the installers itself at `<origin>/agent/install.sh` and `<origin>/agent/install.ps1`, with your origin and ingest key filled in.

macOS and Linux:

```bash
curl -fsSL https://hq.yourdomain.com/agent/install.sh | bash -s -- --url https://hq.yourdomain.com --key hqi_... --global
```

Windows PowerShell (works with the default execution policy):

```powershell
& ([scriptblock]::Create((irm https://hq.yourdomain.com/agent/install.ps1))) -Url https://hq.yourdomain.com -IngestKey hqi_... -Global
```

The machine shows up in the dashboard under its computer name. Pass `--machine "Name"` / `-Machine "Name"` to choose a different label, or rename it later from Connections → Claude Code. Drop `--global` / `-Global` if you do not want the `HQ:` block instruction added to your global `~/.claude/CLAUDE.md`.

You can also run the installers from a clone of the repo: `bash scripts/install-hq-agent.sh --url ... --key ...` or `powershell -ExecutionPolicy Bypass -File scripts\install-hq-agent.ps1 -Url ... -IngestKey ...`. Without arguments both prompt for the URL and key.

What the installer does, on both platforms:

1. Copies `hq-session-end.mjs`, `hq-usage-agent.mjs`, `hq-hook-settings.mjs` and `CLAUDE-HQ-snippet.md` to `~/.hq/`.
2. Writes `~/.hq/config.json` (mode 600 on macOS).
3. Installs the scheduler: `~/Library/LaunchAgents/com.hq.usage-agent.plist` (every 900 s, at login, with the absolute node path because launchd has a minimal `PATH`) on macOS; a Scheduled Task **"HQ usage agent"** on Windows (every 15 minutes, as you, while logged on, hidden, 10-minute limit, no admin rights).
4. Merges the SessionEnd hook into `~/.claude/settings.json`, keeping your other hooks. An existing HQ entry is updated in place, never duplicated.
5. With `--global` / `-Global`: appends the `HQ:` instructions to `~/.claude/CLAUDE.md` between `<!-- hq:start -->` and `<!-- hq:end -->` markers (idempotent).
6. Ends with a ping and a dry run so you see it working.

Restart Claude Code or the desktop app afterwards so it reloads `settings.json`.

### The hook entry

```json
{
  "hooks": {
    "SessionEnd": [
      { "hooks": [ { "type": "command", "command": "\"<abs node>\" \"<abs path>/hq-session-end.mjs\"", "timeout": 10 } ] }
    ]
  }
}
```

The absolute node path is used, not just `node`, because the desktop app may launch hooks with a minimal `PATH`.

### The `HQ:` block

The hook reads the last assistant message of the session. If it ends with this block, the summary, done and open lists are taken from it:

```
HQ:
summary: one line of what changed this session
done: task one; task two
open: still open or next step one; next step two
```

Rules: `summary` is one line, no markdown. `done` lists tasks finished this session; `open` lists what is still open or the next steps. Separate items with `;` or put each on its own `- ` line under the key. Omit `done` or `open` when empty. Skip the block for sessions that only answered a question.

`--global` puts these instructions in `~/.claude/CLAUDE.md` so Claude writes the block in every project. You can instead paste `~/.hq/CLAUDE-HQ-snippet.md` into one project's `CLAUDE.md`. Without the block the hook still posts: the summary becomes the first sentence (up to 140 characters) of the last assistant message with markdown stripped, and done and open are empty. The `source` field tells the two apart (`hq-block` or `last-message`).

## How folders map to projects

The dashboard normalizes the folder name: lowercase, alphanumerics only (`Shared Step` → `sharedstep`, `bananana.dev` → `banananadev`). A session or usage row lands on the project whose id or name normalizes to the same key, or that you mapped by hand. Unknown folders appear under **Unsorted** on the History page. One click maps a folder to a project and moves its history, tasks and usage along. The mapping is stored per folder key, not per path, so moving a folder does not break it.

Tasks from the `done` list mark matching open tasks done (or insert them as done); `open` items are added as open tasks if not already present.

## Test commands

```bash
node ~/.hq/hq-session-end.mjs --ping                 # GET /api/ingest/ping -> 200 {"ok":true,...}
node ~/.hq/hq-session-end.mjs --test                 # POST a fake session for folder "hq-test" (shows up in Unsorted)
node ~/.hq/hq-session-end.mjs --dry-run < hook.json  # parse a real transcript, print the payload, send nothing
node ~/.hq/hq-usage-agent.mjs --dry-run --verbose    # scan all transcripts, print rows and totals, send nothing
node ~/.hq/hq-usage-agent.mjs --verbose              # one real pass (what the scheduler runs)
node ~/.hq/hq-usage-agent.mjs --reset                # forget state and re-aggregate everything next run
```

`hook.json` for the dry run is what Claude Code pipes on stdin:
`{"session_id":"...","transcript_path":"~/.claude/projects/<dir>/<id>.jsonl","cwd":"/path/to/project","hook_event_name":"SessionEnd","reason":"exit"}`.

Logs: `~/.hq/hook.log` and `~/.hq/usage-agent.log` (both rotate at 1 MB), plus `~/.hq/launchd.log` on macOS. Check the scheduler on Windows with `Get-ScheduledTask -TaskName 'HQ usage agent' | Get-ScheduledTaskInfo`, on macOS with `launchctl list | grep com.hq`.

## What gets sent

**Session (hook), `SessionIngest`:**

| Field | Value |
|---|---|
| `machine` | the label from config |
| `folder` | basename of the session's working directory, for example `ClipForge` |
| `cwd` | the full working directory path |
| `branch` | `git rev-parse --abbrev-ref HEAD` in that directory, or the transcript's `gitBranch`; `null` when unknown |
| `sessionId` | Claude Code's session id (the server dedupes on it) |
| `endedAt` | ISO timestamp |
| `summary`, `done[]`, `open[]` | from the `HQ:` block, or the first sentence of the last message |
| `source` | `hq-block` or `last-message` |

The hook's `reason` (`exit`, `clear`, `logout`, ...) is written to `hook.log` only. Sessions with fewer than 2 assistant messages, or whose folder is in `ignoreFolders`, are skipped.

**Usage (agent), `UsageIngest`:** `machine`, `agentVersion`, `filesTracked` and rows of `{ day, folder, model, input, output, cacheRead, cacheWrite, messages, sessions }`. `day` is the machine's local calendar date. `folder` is the basename of the session's starting directory (sub-agent transcripts inherit it). `sessions` is a count of distinct session ids. Rows are absolute totals for (day, folder, model) on this machine and are re-sent whenever they change; the server upserts.

## What never gets sent

- Prompts, assistant text (other than the `HQ:` block or the first sentence of the final message), thinking, tool calls, tool results, file contents, diffs, environment variables.
- Transcript paths, full project paths in usage data, session ids in usage data (only counted).
- Anything from `~/.claude` other than the per-message numbers above.

The usage agent has to JSON-parse a transcript line to reach `message.usage`, so a whole line is in memory for a moment. Only the numbers, the model name, the day, the folder name and the session count are kept in `~/.hq/usage-state.json` or transmitted. The relevant code is `ingestEntry` and `rowsForKeys` in `hq-usage-agent.mjs`; search the file for `usage.` and `row.` to audit it.

## Plan limits (left out on purpose)

The agent does not report your Claude subscription's 5-hour or weekly usage percentages. There is no supported way to read them: the transcripts contain token counts, not plan quota; the `claude` CLI's `/usage` view has no machine-readable output; and Anthropic's Admin and Usage APIs cover API keys, not Claude.ai subscriptions. Scraping claude.ai with a browser session would break silently and is not something a background agent should do. If an official endpoint appears, it belongs in the agent as a separate heartbeat field.

## Dedupe and incremental scanning

Claude Code appends several JSONL lines per assistant message (one per content block, again as streaming progresses) that share one `message.id` and carry the message's usage so far. The agent counts each id once, using the last occurrence seen; if a later run sees an id again with different numbers it applies the difference. Per-file byte offsets (stored at the last complete newline) make each run incremental. A file that shrank or whose mtime went backwards is rescanned from zero, and a bounded set of recent ids (20k) keeps that from double counting. Rows that failed to send stay in a `dirty` set and are retried next run.

## Uninstall

macOS and Linux:

```bash
curl -fsSL https://hq.yourdomain.com/agent/install.sh | bash -s -- --uninstall
# or by hand:
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.hq.usage-agent.plist
rm ~/Library/LaunchAgents/com.hq.usage-agent.plist
node ~/.hq/hq-hook-settings.mjs --settings ~/.claude/settings.json --remove
node ~/.hq/hq-hook-settings.mjs --claude-md ~/.claude/CLAUDE.md --remove
rm -rf ~/.hq
```

Windows:

```powershell
# from a clone of the repo:
powershell -ExecutionPolicy Bypass -File scripts\install-hq-agent.ps1 -Uninstall
# or by hand:
Unregister-ScheduledTask -TaskName 'HQ usage agent' -Confirm:$false
node "$env:USERPROFILE\.hq\hq-hook-settings.mjs" --settings "$env:USERPROFILE\.claude\settings.json" --remove
node "$env:USERPROFILE\.hq\hq-hook-settings.mjs" --claude-md "$env:USERPROFILE\.claude\CLAUDE.md" --remove
Remove-Item -Recurse -Force "$env:USERPROFILE\.hq"
```

The uninstallers remove the scheduler, the hook and the CLAUDE.md section but leave `~/.hq` in place (it holds the ingest key and the usage aggregates); delete it by hand as shown. Each write to `settings.json` or `CLAUDE.md` leaves a `.bak` copy next to the file.

To stop one machine from reporting without uninstalling, delete it from Connections → Claude Code; its past rows stay until you clear cached data.
