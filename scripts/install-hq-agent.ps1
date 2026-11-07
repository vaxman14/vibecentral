<#
.SYNOPSIS
  Installs the Vibe Central Claude Code hook + usage agent on this Windows PC (current user only).

.DESCRIPTION
  - copies hq-session-end.mjs, hq-usage-agent.mjs, hq-hook-settings.mjs, CLAUDE-HQ-snippet.md to %USERPROFILE%\.hq\
  - writes %USERPROFILE%\.hq\config.json  { url, ingestKey, machine }
  - registers the Scheduled Task "Vibe Central usage agent" (every 15 min, hidden, runs as you while logged on)
  - merges the SessionEnd hook into %USERPROFILE%\.claude\settings.json (keeps your other hooks)
  - with -Global: appends the HQ: block instructions to %USERPROFILE%\.claude\CLAUDE.md
  - ends with a ping and a dry run so you can see it works

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\install-hq-agent.ps1 -Url https://your-dashboard.example -IngestKey hqi_... -Machine "Windows PC" -Global

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\install-hq-agent.ps1 -Uninstall
#>
[CmdletBinding()]
param(
  [string]$Url,
  [string]$IngestKey,
  [string]$Machine,
  [switch]$Global,
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$TaskName   = 'Vibe Central usage agent'
$HqDir      = Join-Path $env:USERPROFILE '.hq'
$ClaudeDir  = Join-Path $env:USERPROFILE '.claude'
$Settings   = Join-Path $ClaudeDir 'settings.json'
$ClaudeMd   = Join-Path $ClaudeDir 'CLAUDE.md'
$ConfigFile = Join-Path $HqDir 'config.json'
$Files      = @('hq-session-end.mjs', 'hq-usage-agent.mjs', 'hq-hook-settings.mjs', 'CLAUDE-HQ-snippet.md')

function Step($msg) { Write-Host "`n== $msg" -ForegroundColor Cyan }
function Fwd($p) { return ($p -replace '\\', '/') }   # forward slashes work in cmd, bash and Node alike

# ---------------------------------------------------------------- node
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) { throw 'node was not found on PATH. Install Node.js 18 or newer (https://nodejs.org) and re-run.' }
$NodeExe = $nodeCmd.Source
$nodeMajor = [int]((& $NodeExe -v).TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 18) { throw "Node $nodeMajor found at $NodeExe; version 18 or newer is required." }
Write-Host "node $(& $NodeExe -v) at $NodeExe"

# ---------------------------------------------------------------- uninstall
if ($Uninstall) {
  Step 'Removing scheduled task'
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "removed task '$TaskName'"
  } else { Write-Host 'task not present' }

  Step 'Removing SessionEnd hook and CLAUDE.md section'
  $helper = Join-Path $HqDir 'hq-hook-settings.mjs'
  if (-not (Test-Path $helper)) { $helper = Join-Path $PSScriptRoot 'hq-hook-settings.mjs' }
  & $NodeExe $helper --settings $Settings --remove
  & $NodeExe $helper --claude-md $ClaudeMd --remove

  Write-Host "`nLeft in place (delete by hand if you want): $HqDir  (config.json holds the ingest key, usage-state.json the aggregates)" -ForegroundColor Yellow
  return
}

# ---------------------------------------------------------------- config
Step 'Config'
$existing = @{}
if (Test-Path $ConfigFile) {
  try { $existing = Get-Content $ConfigFile -Raw | ConvertFrom-Json } catch { Write-Warning "existing config.json is not valid JSON; it will be replaced" }
}
if (-not $Url)       { $Url = Read-Host "Dashboard URL [$( if ($existing.url) { $existing.url } else { 'https://your-dashboard.example' } )]" }
if (-not $Url)       { $Url = if ($existing.url) { $existing.url } else { 'https://your-dashboard.example' } }
if (-not $IngestKey) { $IngestKey = Read-Host "Ingest key (HQ_INGEST_KEY from .dev.vars)$( if ($existing.ingestKey) { ' [keep current]' } )" }
if (-not $IngestKey) { $IngestKey = $existing.ingestKey }
if (-not $IngestKey) { throw 'An ingest key is required.' }
# machine label defaults to this computer's name (rename it later in the dashboard: Connections → Claude Code)
if (-not $Machine)   { $Machine = if ($existing.machine) { $existing.machine } else { $env:COMPUTERNAME } }

New-Item -ItemType Directory -Force -Path $HqDir | Out-Null
$config = [ordered]@{ url = $Url.TrimEnd('/'); ingestKey = $IngestKey; machine = $Machine }
if ($existing.ignoreFolders) { $config.ignoreFolders = @($existing.ignoreFolders) }
# UTF-8 without BOM (Windows PowerShell 5.1's -Encoding utf8 adds one, which JSON.parse rejects)
[System.IO.File]::WriteAllText($ConfigFile, ($config | ConvertTo-Json -Depth 4), (New-Object System.Text.UTF8Encoding($false)))
Write-Host "wrote $ConfigFile (machine: $Machine, url: $($config.url))"

# ---------------------------------------------------------------- files
Step "Copying scripts to $HqDir"
foreach ($f in $Files) {
  $src = if ($PSScriptRoot) { Join-Path $PSScriptRoot $f } else { '' }
  if ($src -and (Test-Path $src)) {
    Copy-Item $src (Join-Path $HqDir $f) -Force
    Write-Host "  $f (local copy)"
  } else {
    # one-line install: fetch from the dashboard itself
    $uri = "$($config.url)/agent/$f"
    Invoke-WebRequest -Uri $uri -OutFile (Join-Path $HqDir $f) -UseBasicParsing
    Write-Host "  $f (downloaded)"
  }
}
$HookScript  = Join-Path $HqDir 'hq-session-end.mjs'
$AgentScript = Join-Path $HqDir 'hq-usage-agent.mjs'
$Helper      = Join-Path $HqDir 'hq-hook-settings.mjs'

# ---------------------------------------------------------------- scheduled task
Step "Registering scheduled task '$TaskName' (every 15 minutes)"
# conhost --headless runs node without flashing a console window; the task runs only while you are logged on.
$conhost = Join-Path $env:SystemRoot 'System32\conhost.exe'
if (Test-Path $conhost) {
  $action = New-ScheduledTaskAction -Execute $conhost -Argument "--headless `"$NodeExe`" `"$AgentScript`"" -WorkingDirectory $HqDir
} else {
  $action = New-ScheduledTaskAction -Execute $NodeExe -Argument "`"$AgentScript`"" -WorkingDirectory $HqDir
}
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 15)
$settings = New-ScheduledTaskSettingsSet -Hidden -StartWhenAvailable -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
  -Description 'Sends Claude Code token usage (numbers only, never content) to the Vibe Central dashboard.' -Force | Out-Null
Write-Host "registered. Inspect with: Get-ScheduledTask -TaskName '$TaskName' | Get-ScheduledTaskInfo"

# ---------------------------------------------------------------- hook
Step "Merging SessionEnd hook into $Settings"
$hookCommand = "`"$(Fwd $NodeExe)`" `"$(Fwd $HookScript)`""
# passed through the environment: PowerShell 5.1 strips the embedded quotes when they are an argument
$env:HQ_HOOK_COMMAND = $hookCommand
& $NodeExe $Helper --settings $Settings --timeout 10
if ($LASTEXITCODE -ne 0) { throw 'hook merge failed (see message above)' }
Remove-Item Env:HQ_HOOK_COMMAND -ErrorAction SilentlyContinue
$written = Get-Content $Settings -Raw -ErrorAction SilentlyContinue
if (-not $written -or $written -notmatch 'hq-session-end\.mjs') { throw "hook not found in $Settings after merge" }
if ($written -notmatch [regex]::Escape((Fwd $NodeExe))) { throw "hook command in $Settings does not contain the node path; merge went wrong" }
Write-Host "verified: SessionEnd hook present in $Settings"

# ---------------------------------------------------------------- CLAUDE.md
if ($Global) {
  Step "Adding the HQ: block instructions to $ClaudeMd"
  & $NodeExe $Helper --claude-md $ClaudeMd --snippet (Join-Path $HqDir 'CLAUDE-HQ-snippet.md')
} else {
  Write-Host "`n(skipped global CLAUDE.md; re-run with -Global to add the HQ: block instructions, or paste scripts\CLAUDE-HQ-snippet.md into a project CLAUDE.md)" -ForegroundColor DarkGray
}

# ---------------------------------------------------------------- smoke test
# Windows PowerShell 5.1 turns any stderr line from a native command into a terminating error when
# $ErrorActionPreference is Stop, so the smoke tests run with Continue and are allowed to fail.
$ErrorActionPreference = 'Continue'
Step 'Ping'
& $NodeExe $HookScript --ping

Step 'Usage agent dry run (first lines)'
& $NodeExe $AgentScript --dry-run --verbose 2>&1 | ForEach-Object { "$_" } | Select-Object -First 40
$ErrorActionPreference = 'Stop'

Step 'Kicking off the first real usage run in the background'
Start-ScheduledTask -TaskName $TaskName
Write-Host "Done. Logs: $HqDir\usage-agent.log and $HqDir\hook.log" -ForegroundColor Green
Write-Host 'Restart Claude Code (or the Claude desktop app) so it picks up the new hook.' -ForegroundColor Green
