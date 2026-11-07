#!/usr/bin/env node
// Vibe Central - Claude Code subscription usage agent.
//
// Scans the local Claude Code transcripts (~/.claude/projects/**/*.jsonl), adds up the token
// usage that Claude Code already records on every assistant message, and sends per-day totals
// to the dashboard. A scheduler (Windows Task Scheduler / macOS launchd) runs it every 15 min;
// each run is one incremental pass.
//
// ---------------------------------------------------------------------------------------------
// PRIVACY: what this script reads vs. what it sends
//   A transcript line has to be JSON-parsed to reach message.usage, so the parser does see the
//   whole line in memory for a moment. It KEEPS and SENDS only:
//     - the numbers in message.usage (input / output / cache read / cache write tokens)
//     - message.model (e.g. "claude-opus-5-5")
//     - the timestamp -> local calendar day
//     - basename(cwd) -> folder name (e.g. "ClipForge"), never the full path
//     - sessionId -> only to COUNT distinct sessions per (day, folder, model); ids are not sent
//   It never stores or transmits prompts, assistant text, tool calls, tool results, file
//   contents, file paths or git branches. Search this file for "usage." and "row." to audit.
// ---------------------------------------------------------------------------------------------
//
// PLAN LIMITS (5-hour / weekly percentages) are deliberately NOT collected. Nothing supported
// exposes them: the transcripts contain tokens, not plan quota; the `claude` CLI has no
// machine-readable `/usage` output; and the Anthropic Admin/Usage APIs cover API-key usage, not
// Claude.ai subscriptions. Anything else would mean scraping claude.ai with a browser session,
// which breaks silently and is not something a background agent should do. If Anthropic ever
// ships an official endpoint, add it here as a separate heartbeat field.
//
// Dedupe: Claude Code appends several lines per assistant message (one per content block, and
// again as streaming progresses), all with the same message.id and a usage object that reflects
// the message so far. Each message.id is therefore counted ONCE using its LAST occurrence; if a
// later run sees an id again with different numbers, the difference is applied to the row.
//
// Incremental: ~/.hq/usage-state.json keeps per-file byte offset/size/mtime, the recent
// message ids (bounded, 20k), the full aggregate (so absolute totals can be re-sent) and a dirty
// set of rows that still need a successful send. A file that shrank or whose mtime went back is
// rescanned from byte 0 (the id set makes that safe).
//
// Flags: --once (default), --dry-run (print rows, send nothing), --reset (delete state),
//        --verbose. Env: HQ_HOME, HQ_URL, HQ_INGEST_KEY, HQ_MACHINE, HQ_CLAUDE_DIR.
// Requires Node >= 18, no dependencies.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const AGENT_VERSION = '1.0.0';
const STATE_VERSION = 1;
const CHUNK_ROWS = 500;
const SEEN_MAX = 20000;
const NETWORK_TIMEOUT_MS = 15000;
const READ_CHUNK = 1 << 20; // 1 MiB
const LOCK_STALE_MS = 10 * 60 * 1000;

const args = new Set(process.argv.slice(2));
const DRY = args.has('--dry-run');
const RESET = args.has('--reset');
const VERBOSE = args.has('--verbose') || args.has('-v');

const home = process.env.HQ_HOME || path.join(os.homedir(), '.hq');
const claudeDir = process.env.HQ_CLAUDE_DIR || path.join(os.homedir(), '.claude');
const projectsDir = path.join(claudeDir, 'projects');
const stateFile = path.join(home, 'usage-state.json');
const lockFile = path.join(home, 'usage-agent.lock');
const logFile = path.join(home, 'usage-agent.log');

// ---------------------------------------------------------------- logging

function log(msg) {
  const line = `${new Date().toISOString()} ${msg}`;
  try {
    fs.mkdirSync(home, { recursive: true });
    try { if (fs.statSync(logFile).size > 1024 * 1024) fs.renameSync(logFile, logFile + '.1'); } catch { /* none yet */ }
    fs.appendFileSync(logFile, line + '\n');
  } catch { /* never throw from logging */ }
  if (VERBOSE || DRY) console.error(line);
}
const debug = (msg) => { if (VERBOSE) console.error(msg); };

// ---------------------------------------------------------------- config

function loadConfig() {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8').replace(/^\uFEFF/, '')) || {}; }
  catch (e) { if (e.code !== 'ENOENT') log('config.json unreadable: ' + e.message); }
  return {
    url: (process.env.HQ_URL || cfg.url || '').replace(/\/+$/, ''),
    ingestKey: process.env.HQ_INGEST_KEY || cfg.ingestKey || '',
    machine: process.env.HQ_MACHINE || cfg.machine || os.hostname().replace(/\.local$/i, ''),
    ignoreFolders: Array.isArray(cfg.ignoreFolders) ? cfg.ignoreFolders.map((s) => String(s).toLowerCase()) : [],
  };
}

// ---------------------------------------------------------------- state

function emptyState() {
  return {
    version: STATE_VERSION,
    files: {},        // absPath -> { offset, size, mtimeMs, folder }  (folder = basename of the session's first cwd)
    seen: {},         // message.id -> [rowKey, input, output, cacheRead, cacheWrite]  (bounded, insertion order)
    rows: {},         // rowKey "day|folder|model" -> { day, folder, model, input, output, cacheRead, cacheWrite, messages, sessions: [] }
    dirty: [],        // rowKeys changed since the last successful send
    lastRunAt: null,
    lastSendAt: null,
  };
}

function loadState() {
  if (RESET) {
    try { fs.unlinkSync(stateFile); log('state reset'); } catch { /* nothing to delete */ }
    return emptyState();
  }
  try {
    const s = JSON.parse(fs.readFileSync(stateFile, 'utf8').replace(/^\uFEFF/, ''));
    if (!s || s.version !== STATE_VERSION) { log('state version mismatch, starting over'); return emptyState(); }
    return { ...emptyState(), ...s };
  } catch (e) {
    if (e.code !== 'ENOENT') log('state unreadable, starting over: ' + e.message);
    return emptyState();
  }
}

function saveState(state) {
  if (DRY) return;
  // Bound the seen-id map: drop the oldest entries beyond SEEN_MAX (object keys keep insertion order).
  const keys = Object.keys(state.seen);
  if (keys.length > SEEN_MAX) for (const k of keys.slice(0, keys.length - SEEN_MAX)) delete state.seen[k];
  fs.mkdirSync(home, { recursive: true });
  const tmp = stateFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, stateFile);
}

// ---------------------------------------------------------------- lock (skip if a previous run is still going)

function acquireLock() {
  fs.mkdirSync(home, { recursive: true });
  try {
    const prev = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    if (prev && Date.now() - prev.at < LOCK_STALE_MS) return false;
  } catch { /* no lock or unreadable */ }
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, at: Date.now() }));
  return true;
}
function releaseLock() { try { fs.unlinkSync(lockFile); } catch { /* ignore */ } }

// ---------------------------------------------------------------- transcript discovery

function listTranscripts(dir) {
  const out = [];
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
    }
  };
  walk(dir);
  // Parent session transcripts first (shallower paths), so sub-agent files can inherit their folder.
  const depth = (p) => p.split(/[\\/]+/).length;
  return out.sort((a, b) => depth(a) - depth(b) || a.localeCompare(b));
}

function basename(p) {
  const parts = String(p || '').split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

// Fallback when an entry carries no cwd: the project directory name under ~/.claude/projects is
// the cwd with separators replaced by '-', e.g. "C--Users-vaxma-Desktop-ClipForge". Take the last
// segment (ambiguous for folders containing '-', hence only a fallback).
function folderFromProjectDir(file) {
  const rel = path.relative(projectsDir, file).split(/[\\/]+/)[0] || '';
  const seg = rel.split('-').filter(Boolean);
  return seg.length ? seg[seg.length - 1] : 'unknown';
}

function parentFolder(state, file) {
  const rel = path.relative(projectsDir, file).split(/[\\/]+/);
  if (rel.length !== 4 || rel[2] !== 'subagents') return null;
  const parent = state.files[path.join(projectsDir, rel[0], rel[1] + '.jsonl')];
  return parent && parent.folder ? parent.folder : null;
}

function localDay(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ---------------------------------------------------------------- aggregation

function rowFor(state, key, day, folder, model) {
  let r = state.rows[key];
  if (!r) { r = state.rows[key] = { day, folder, model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0, sessions: [] }; }
  return r;
}
function markDirty(state, key) { if (!state.dirty.includes(key)) state.dirty.push(key); }

// One assistant transcript entry -> aggregate. Only numeric fields leave this function.
function ingestEntry(state, cfg, o, file, stats) {
  const m = o.message;
  if (!m || !m.usage || typeof m.usage !== 'object') return;
  const model = typeof m.model === 'string' ? m.model : 'unknown';
  if (model === '<synthetic>') return; // Claude Code's local placeholder messages, no real tokens
  const u = m.usage;
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const input = num(u.input_tokens);
  const output = num(u.output_tokens);
  const cacheRead = num(u.cache_read_input_tokens);
  const cacheWrite = num(u.cache_creation_input_tokens);
  const day = localDay(o.timestamp);
  if (!day) return;
  // Folder = basename of the SESSION's starting cwd. Claude Code rewrites `cwd` on every entry
  // when it cd's into a subdirectory, so per-entry cwd would scatter one session over
  // "src", "Tests", "win-x64"... The first cwd seen in a transcript file is the project root.
  // Sub-agent transcripts (<project>/<session>/subagents/*.jsonl) inherit the parent session's
  // folder, since a sub-agent may start in whatever subdirectory the main agent was in.
  const frec = state.files[file];
  if (!frec.folder) frec.folder = parentFolder(state, file) || basename(o.cwd) || folderFromProjectDir(file);
  const folder = frec.folder;
  if (cfg.ignoreFolders.includes(folder.toLowerCase())) return;
  const id = typeof m.id === 'string' && m.id ? m.id : (o.uuid ? 'u:' + o.uuid : null);
  if (!id) return;
  const key = `${day}|${folder}|${model}`;

  const prev = state.seen[id];
  if (prev) {
    // Same message again (another content block / later streaming snapshot). Only the last
    // occurrence counts: replace the previously counted numbers with these.
    const [pkey, pi, po, pcr, pcw] = prev;
    if (pkey === key && pi === input && po === output && pcr === cacheRead && pcw === cacheWrite) return;
    const pr = state.rows[pkey];
    if (pr) {
      pr.input -= pi; pr.output -= po; pr.cacheRead -= pcr; pr.cacheWrite -= pcw;
      if (pkey !== key) pr.messages -= 1;
      markDirty(state, pkey);
    }
    const r = rowFor(state, key, day, folder, model);
    r.input += input; r.output += output; r.cacheRead += cacheRead; r.cacheWrite += cacheWrite;
    if (pkey !== key) r.messages += 1;
    if (o.sessionId && !r.sessions.includes(o.sessionId)) r.sessions.push(o.sessionId);
    delete state.seen[id];                 // re-insert so it counts as recent
    state.seen[id] = [key, input, output, cacheRead, cacheWrite];
    markDirty(state, key);
    stats.updated++;
    return;
  }

  const r = rowFor(state, key, day, folder, model);
  r.input += input; r.output += output; r.cacheRead += cacheRead; r.cacheWrite += cacheWrite;
  r.messages += 1;
  if (o.sessionId && !r.sessions.includes(o.sessionId)) r.sessions.push(o.sessionId);
  state.seen[id] = [key, input, output, cacheRead, cacheWrite];
  markDirty(state, key);
  stats.messages++;
}

// Reads file from `from` to EOF, handing complete lines to onLine. Returns the byte offset just
// after the last complete line (a trailing partial line is left for the next run).
function readNewLines(file, from, onLine) {
  const fd = fs.openSync(file, 'r');
  try {
    let pos = from;
    let consumed = from;
    let carry = Buffer.alloc(0);
    const buf = Buffer.allocUnsafe(READ_CHUNK);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, READ_CHUNK, pos);
      if (n === 0) break;
      pos += n;
      const chunk = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : Buffer.from(buf.subarray(0, n));
      let start = 0;
      let nl;
      while ((nl = chunk.indexOf(10, start)) !== -1) {
        onLine(chunk, start, nl);
        start = nl + 1;
      }
      carry = chunk.subarray(start);
      consumed = pos - carry.length; // everything read so far minus the trailing partial line
    }
    // A last line with no trailing newline: take it only if it is complete JSON (Claude Code always
    // ends lines with '\n', so this mostly covers files edited by hand).
    if (carry.length) {
      try { JSON.parse(carry.toString('utf8')); onLine(carry, 0, carry.length); consumed = pos; } catch { /* partial, wait */ }
    }
    return consumed;
  } finally {
    fs.closeSync(fd);
  }
}

function scanFile(state, cfg, file, stats) {
  let st;
  try { st = fs.statSync(file); } catch { return; }
  const rec = state.files[file] || { offset: 0, size: 0, mtimeMs: 0, folder: null };
  state.files[file] = rec;
  let from = rec.offset;
  if (st.size < rec.size || st.mtimeMs < rec.mtimeMs || from > st.size) {
    debug(`rescan from 0 (shrank or mtime went back): ${file}`);
    from = 0;
  } else if (st.size === rec.size && st.mtimeMs === rec.mtimeMs) {
    return; // unchanged
  }
  const needle = Buffer.from('"type":"assistant"');
  const fileStats = { lines: 0, assistant: 0 };
  const onLine = (buf, start, end) => {
    fileStats.lines++;
    // Cheap pre-filter so we only JSON-parse assistant entries (lines can be >1 MB of tool output).
    const at = buf.indexOf(needle, start);
    if (at === -1 || at >= end) return;
    let o;
    try { o = JSON.parse(buf.toString('utf8', start, end)); } catch { return; }
    if (!o || o.type !== 'assistant') return;
    fileStats.assistant++;
    ingestEntry(state, cfg, o, file, stats);
  };
  const newOffset = readNewLines(file, from, onLine);
  state.files[file] = { offset: newOffset, size: st.size, mtimeMs: st.mtimeMs, folder: rec.folder };
  if (fileStats.lines) debug(`${path.relative(projectsDir, file)}: +${fileStats.lines} lines, ${fileStats.assistant} assistant entries`);
  stats.filesChanged++;
}

// ---------------------------------------------------------------- send

function rowsForKeys(state, keys) {
  return keys.map((k) => state.rows[k]).filter(Boolean).map((r) => ({
    day: r.day, folder: r.folder, model: r.model,
    input: r.input, output: r.output, cacheRead: r.cacheRead, cacheWrite: r.cacheWrite,
    messages: r.messages, sessions: r.sessions.length,   // count only; session ids stay local
  }));
}

async function post(cfg, body) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), NETWORK_TIMEOUT_MS);
  try {
    const res = await fetch(cfg.url + '/api/ingest', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + cfg.ingestKey, 'content-type': 'application/json', 'user-agent': 'hq-usage-agent/' + AGENT_VERSION },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text: text.slice(0, 300) };
  } finally { clearTimeout(t); }
}

async function sendDirty(state, cfg) {
  const keys = [...state.dirty];
  if (!keys.length) { debug('nothing to send'); return; }
  if (!cfg.ingestKey) { log(`no ingestKey configured; ${keys.length} row(s) kept dirty`); return; }
  const filesTracked = Object.keys(state.files).length;
  for (let i = 0; i < keys.length; i += CHUNK_ROWS) {
    const chunkKeys = keys.slice(i, i + CHUNK_ROWS);
    const payload = { type: 'usage', machine: cfg.machine, agentVersion: AGENT_VERSION, filesTracked, rows: rowsForKeys(state, chunkKeys) };
    let r;
    try { r = await post(cfg, payload); }
    catch (e) {
      const cause = e && e.cause && (e.cause.code || e.cause.message);
      r = { ok: false, status: 0, text: (e && e.name === 'AbortError' ? `timeout after ${NETWORK_TIMEOUT_MS} ms` : String(e && e.message || e)) + (cause ? ` (${cause})` : '') };
    }
    if (!r.ok) {
      log(`POST /api/ingest usage (${payload.rows.length} rows) failed: ${r.status} ${r.text}; will retry next run`);
      return; // keep everything from here on dirty
    }
    state.dirty = state.dirty.filter((k) => !chunkKeys.includes(k));
    state.lastSendAt = new Date().toISOString();
    saveState(state);
    log(`sent ${payload.rows.length} row(s) -> ${r.status} ${r.text}`);
  }
}

// ---------------------------------------------------------------- main

async function main() {
  const cfg = loadConfig();
  if (!acquireLock()) { log('another run is still active, skipping'); return; }
  try {
    const state = loadState();
    const files = listTranscripts(projectsDir);
    if (!files.length) log(`no transcripts under ${projectsDir}`);
    // Forget files that disappeared (their rows stay; the aggregate is cumulative).
    const present = new Set(files);
    for (const f of Object.keys(state.files)) if (!present.has(f)) delete state.files[f];

    const stats = { filesChanged: 0, messages: 0, updated: 0 };
    const t0 = Date.now();
    for (const f of files) {
      try { scanFile(state, cfg, f, stats); }
      catch (e) { log(`scan failed for ${f}: ${e.message}`); }
    }
    state.lastRunAt = new Date().toISOString();
    log(`scan: ${files.length} files, ${stats.filesChanged} changed, ${stats.messages} new messages, ${stats.updated} updated, ${state.dirty.length} dirty rows, ${Date.now() - t0} ms`);
    saveState(state);

    if (DRY) {
      const rows = rowsForKeys(state, state.dirty.length ? state.dirty : Object.keys(state.rows));
      rows.sort((a, b) => (b.day.localeCompare(a.day)) || ((b.input + b.output + b.cacheRead + b.cacheWrite) - (a.input + a.output + a.cacheRead + a.cacheWrite)));
      const tot = rows.reduce((t, r) => ({ input: t.input + r.input, output: t.output + r.output, cacheRead: t.cacheRead + r.cacheRead, cacheWrite: t.cacheWrite + r.cacheWrite, messages: t.messages + r.messages }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0 });
      console.log(JSON.stringify({ type: 'usage', machine: cfg.machine, agentVersion: AGENT_VERSION, filesTracked: Object.keys(state.files).length, rowCount: rows.length, totals: tot, rows }, null, 2));
      console.error('(dry run: nothing sent, state not written)');
      return;
    }
    await sendDirty(state, cfg);
    saveState(state);
  } finally {
    releaseLock();
  }
}

main().catch((e) => { log('fatal: ' + (e && e.stack || e)); process.exitCode = 1; });
