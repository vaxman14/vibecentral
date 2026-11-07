#!/usr/bin/env bash
# Installs the HQ Claude Code hook + usage agent on macOS (current user only).
#
#   - copies hq-session-end.mjs, hq-usage-agent.mjs, hq-hook-settings.mjs, CLAUDE-HQ-snippet.md to ~/.hq/
#   - writes ~/.hq/config.json  { url, ingestKey, machine }
#   - installs a launchd agent ~/Library/LaunchAgents/com.hq.usage-agent.plist (every 15 min, at login)
#   - merges the SessionEnd hook into ~/.claude/settings.json (keeps your other hooks; no jq needed)
#   - with --global: appends the HQ: block instructions to ~/.claude/CLAUDE.md
#   - ends with a ping and a dry run
#
# usage: bash scripts/install-hq-agent.sh [--url URL] [--key hqi_...] [--machine "Mac mini"] [--global]
#        bash scripts/install-hq-agent.sh --uninstall
set -euo pipefail

URL="" KEY="" MACHINE="" GLOBAL=0 UNINSTALL=0
while [ $# -gt 0 ]; do
  case "$1" in
    --url) URL="$2"; shift 2 ;;
    --key|--ingest-key) KEY="$2"; shift 2 ;;
    --machine) MACHINE="$2"; shift 2 ;;
    --global) GLOBAL=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HQ_DIR="$HOME/.hq"
CLAUDE_DIR="$HOME/.claude"
SETTINGS="$CLAUDE_DIR/settings.json"
CLAUDE_MD="$CLAUDE_DIR/CLAUDE.md"
CONFIG="$HQ_DIR/config.json"
LABEL="com.hq.usage-agent"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
FILES=(hq-session-end.mjs hq-usage-agent.mjs hq-hook-settings.mjs CLAUDE-HQ-snippet.md)

step() { printf '\n\033[36m== %s\033[0m\n' "$*"; }

# ---------------------------------------------------------------- node (absolute path: launchd and GUI apps have a minimal PATH)
NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then
  for c in /opt/homebrew/bin/node /usr/local/bin/node; do [ -x "$c" ] && NODE="$c" && break; done
fi
[ -n "$NODE" ] || { echo "node not found. Install Node.js 18+ (brew install node) and re-run." >&2; exit 1; }
NODE="$(cd "$(dirname "$NODE")" && pwd -P)/$(basename "$NODE")"   # resolve symlinked dirs (nvm, homebrew)
MAJOR="$("$NODE" -v | sed 's/^v//' | cut -d. -f1)"
[ "$MAJOR" -ge 18 ] || { echo "Node $MAJOR at $NODE; version 18+ required." >&2; exit 1; }
echo "node $("$NODE" -v) at $NODE"

# ---------------------------------------------------------------- uninstall
if [ "$UNINSTALL" = 1 ]; then
  step "Removing launchd agent"
  launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || launchctl unload "$PLIST" 2>/dev/null || true
  rm -f "$PLIST" && echo "removed $PLIST"
  step "Removing SessionEnd hook and CLAUDE.md section"
  HELPER="$HQ_DIR/hq-hook-settings.mjs"; [ -f "$HELPER" ] || HELPER="$HERE/hq-hook-settings.mjs"
  "$NODE" "$HELPER" --settings "$SETTINGS" --remove
  "$NODE" "$HELPER" --claude-md "$CLAUDE_MD" --remove
  printf '\nLeft in place (delete by hand if you want): %s (config.json holds the ingest key, usage-state.json the aggregates)\n' "$HQ_DIR"
  exit 0
fi

# ---------------------------------------------------------------- config
step "Config"
mkdir -p "$HQ_DIR"
read_cfg() { [ -f "$CONFIG" ] && "$NODE" -e 'try{const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(c[process.argv[2]]??""))}catch{}' "$CONFIG" "$1" || true; }
OLD_URL="$(read_cfg url)"; OLD_KEY="$(read_cfg ingestKey)"; OLD_MACHINE="$(read_cfg machine)"
if [ -z "$URL" ]; then read -r -p "Dashboard URL [${OLD_URL:-https://your-dashboard.example}]: " URL; URL="${URL:-${OLD_URL:-https://your-dashboard.example}}"; fi
if [ -z "$KEY" ]; then read -r -p "Ingest key (HQ_INGEST_KEY from .dev.vars)${OLD_KEY:+ [keep current]}: " KEY; KEY="${KEY:-$OLD_KEY}"; fi
[ -n "$KEY" ] || { echo "An ingest key is required." >&2; exit 1; }
# machine label defaults to this computer's name (rename it later in the dashboard: Connections → Claude Code)
if [ -z "$MACHINE" ]; then MACHINE="${OLD_MACHINE:-$(scutil --get ComputerName 2>/dev/null || hostname -s 2>/dev/null || hostname)}"; fi
# Write JSON with node so quoting is always right; keep ignoreFolders if already configured.
"$NODE" -e '
const fs=require("fs");const [file,url,key,machine]=process.argv.slice(1);
let old={};try{old=JSON.parse(fs.readFileSync(file,"utf8"))}catch{}
const cfg={url:url.replace(/\/+$/,""),ingestKey:key,machine};
if(Array.isArray(old.ignoreFolders))cfg.ignoreFolders=old.ignoreFolders;
fs.writeFileSync(file,JSON.stringify(cfg,null,2)+"\n");' "$CONFIG" "$URL" "$KEY" "$MACHINE"
chmod 600 "$CONFIG"
echo "wrote $CONFIG (machine: $MACHINE, url: $URL)"

# ---------------------------------------------------------------- files
step "Copying scripts to $HQ_DIR"
for f in "${FILES[@]}"; do
  if [ -f "$HERE/$f" ]; then
    cp "$HERE/$f" "$HQ_DIR/$f"; echo "  $f (local copy)"
  else
    # one-line install: fetch from the dashboard itself
    curl -fsSL "$URL/agent/$f" -o "$HQ_DIR/$f" || { echo "could not download $URL/agent/$f" >&2; exit 1; }
    echo "  $f (downloaded)"
  fi
done
HOOK="$HQ_DIR/hq-session-end.mjs"; AGENT="$HQ_DIR/hq-usage-agent.mjs"; HELPER="$HQ_DIR/hq-hook-settings.mjs"

# ---------------------------------------------------------------- launchd
step "Installing launchd agent $LABEL (every 15 minutes, at login)"
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$AGENT</string>
  </array>
  <key>WorkingDirectory</key><string>$HQ_DIR</string>
  <key>StartInterval</key><integer>900</integer>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>LowPriorityIO</key><true/>
  <key>StandardOutPath</key><string>$HQ_DIR/launchd.log</string>
  <key>StandardErrorPath</key><string>$HQ_DIR/launchd.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(dirname "$NODE"):/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HOME</key><string>$HOME</string>
  </dict>
</dict>
</plist>
PLIST
launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || launchctl unload "$PLIST" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || launchctl load "$PLIST"
echo "loaded $PLIST   (check: launchctl list | grep romanhq)"

# ---------------------------------------------------------------- hook
step "Merging SessionEnd hook into $SETTINGS"
HQ_HOOK_COMMAND="\"$NODE\" \"$HOOK\"" "$NODE" "$HELPER" --settings "$SETTINGS" --timeout 10
grep -q 'hq-session-end.mjs' "$SETTINGS" || { echo "hook not found in $SETTINGS after merge" >&2; exit 1; }
echo "verified: SessionEnd hook present in $SETTINGS"

# ---------------------------------------------------------------- CLAUDE.md
if [ "$GLOBAL" = 1 ]; then
  step "Adding the HQ: block instructions to $CLAUDE_MD"
  "$NODE" "$HELPER" --claude-md "$CLAUDE_MD" --snippet "$HQ_DIR/CLAUDE-HQ-snippet.md"
else
  printf '\n(skipped global CLAUDE.md; re-run with --global to add the HQ: block instructions, or paste scripts/CLAUDE-HQ-snippet.md into a project CLAUDE.md)\n'
fi

# ---------------------------------------------------------------- smoke test
step "Ping"
"$NODE" "$HOOK" --ping
step "Usage agent dry run (first lines)"
"$NODE" "$AGENT" --dry-run --verbose 2>&1 | head -40
printf '\n\033[32mDone. Logs: %s/usage-agent.log, %s/hook.log, %s/launchd.log\nRestart Claude Code (or the Claude desktop app) so it picks up the new hook.\033[0m\n' "$HQ_DIR" "$HQ_DIR" "$HQ_DIR"
