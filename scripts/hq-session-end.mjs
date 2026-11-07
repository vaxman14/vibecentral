#!/usr/bin/env node
// HQ - Claude Code SessionEnd hook.
//
// Claude Code runs this when a session ends (hook configured in ~/.claude/settings.json) and
// pipes JSON on stdin: { session_id, transcript_path, cwd, permission_mode, hook_event_name, reason }.
// We read the session transcript (JSONL), take the LAST assistant text, pull out the optional
// "HQ:" block (summary / done / open) and POST one SessionIngest to the dashboard.
//
// Guarantees: pure Node (>= 18, no dependencies), always exits 0, finishes fast (6 s network
// timeout, 9.5 s hard watchdog), never writes to stdout while running as a hook. Errors go to
// ~/.hq/hook.log (rotated at 1 MB).
//
// Manual modes (these DO print to stdout, they are for a human at a terminal):
//   node hq-session-end.mjs --ping        GET  /api/ingest/ping, print the result
//   node hq-session-end.mjs --test        POST a fake session for folder "hq-test", print the response
//   node hq-session-end.mjs --dry-run     parse stdin + transcript, print the payload, send nothing
//
// Config: ~/.hq/config.json  { url, ingestKey, machine, ignoreFolders? }
//         (HQ_HOME overrides the ~/.hq directory; HQ_URL / HQ_INGEST_KEY / HQ_MACHINE override fields)
//
// Privacy: only the final assistant message is read for the summary. Nothing else from the
// transcript (prompts, tool calls, file contents) leaves the machine.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const VERSION = '1.0.0';
const NETWORK_TIMEOUT_MS = 6000;
const WATCHDOG_MS = 9500;
const LOG_MAX_BYTES = 1024 * 1024;

const args = new Set(process.argv.slice(2));
const MODE_PING = args.has('--ping');
const MODE_TEST = args.has('--test');
const MODE_DRY = args.has('--dry-run');
const INTERACTIVE = MODE_PING || MODE_TEST || MODE_DRY;

// Never let the hook hang Claude Code: whatever happens, leave after WATCHDOG_MS.
const watchdog = setTimeout(() => {
  log('watchdog: exiting after ' + WATCHDOG_MS + ' ms');
  process.exit(0);
}, WATCHDOG_MS);
watchdog.unref();

// ---------------------------------------------------------------- config + logging

function hqHome() {
  return process.env.HQ_HOME || path.join(os.homedir(), '.hq');
}

function log(msg) {
  try {
    const dir = hqHome();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'hook.log');
    try {
      if (fs.statSync(file).size > LOG_MAX_BYTES) fs.renameSync(file, file + '.1');
    } catch { /* no log yet */ }
    fs.appendFileSync(file, `${new Date().toISOString()} ${msg}\n`);
  } catch { /* logging must never throw */ }
  if (INTERACTIVE) console.error(msg);
}

function loadConfig() {
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(path.join(hqHome(), 'config.json'), 'utf8').replace(/^\uFEFF/, '')) || {};
  } catch (e) {
    if (e && e.code !== 'ENOENT') log('config.json unreadable: ' + e.message);
  }
  const url = (process.env.HQ_URL || cfg.url || '').replace(/\/+$/, '');
  const ingestKey = process.env.HQ_INGEST_KEY || cfg.ingestKey || '';
  const machine = process.env.HQ_MACHINE || cfg.machine || os.hostname().replace(/\.local$/i, '');
  const ignoreFolders = Array.isArray(cfg.ignoreFolders) ? cfg.ignoreFolders.map((s) => String(s).toLowerCase()) : [];
  return { url, ingestKey, machine, ignoreFolders };
}

// ---------------------------------------------------------------- stdin

function readStdin(timeoutMs = 2000) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(data); } };
    const t = setTimeout(finish, timeoutMs);
    t.unref();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', () => { clearTimeout(t); finish(); });
    process.stdin.on('error', () => { clearTimeout(t); finish(); });
  });
}

// ---------------------------------------------------------------- transcript parsing

// Reads the JSONL transcript and returns:
//   { lastText, assistantMessages, cwd, gitBranch, sessionId }
// Assistant entries: type:"assistant", message.id, message.content[] (blocks), apiBlockIndex.
// Claude Code writes one line per content block of a message (same message.id), so blocks of
// the same message are re-assembled by apiBlockIndex before taking the text.
function parseTranscript(file) {
  const out = { lastText: '', assistantMessages: 0, cwd: null, gitBranch: null, sessionId: null };
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    log('transcript unreadable: ' + e.message);
    return out;
  }
  const messages = new Map(); // message.id -> { blocks: Map<index, text>, order }
  let order = 0;
  let start = 0;
  while (start < raw.length) {
    let end = raw.indexOf('\n', start);
    if (end === -1) end = raw.length;
    const line = raw.slice(start, end);
    start = end + 1;
    if (!line || !line.includes('"type":"assistant"')) {
      // Still cheap enough to pick up cwd/branch from any early line that has them.
      if (!out.cwd && line.includes('"cwd"')) {
        try {
          const o = JSON.parse(line);
          if (o && typeof o.cwd === 'string') out.cwd = o.cwd;
          if (o && o.gitBranch) out.gitBranch = o.gitBranch;
          if (o && o.sessionId) out.sessionId = o.sessionId;
        } catch { /* partial line */ }
      }
      continue;
    }
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (!o || o.type !== 'assistant' || !o.message) continue;
    if (o.isSidechain) continue; // sub-agent chatter, not the main conversation
    if (!out.cwd && typeof o.cwd === 'string') out.cwd = o.cwd;
    if (o.gitBranch) out.gitBranch = o.gitBranch;
    if (o.sessionId) out.sessionId = o.sessionId;
    const id = o.message.id || o.uuid || `line-${order}`;
    let m = messages.get(id);
    if (!m) { m = { blocks: new Map(), order: order++ }; messages.set(id, m); }
    const content = Array.isArray(o.message.content) ? o.message.content : [];
    const texts = content.filter((c) => c && c.type === 'text' && typeof c.text === 'string').map((c) => c.text);
    if (typeof o.apiBlockIndex === 'number') {
      if (texts.length) m.blocks.set(o.apiBlockIndex, texts.join('\n'));
    } else if (content.length) {
      // Whole-message line (older format / streaming snapshot): the latest snapshot wins.
      m.blocks = new Map(texts.map((t, i) => [i, t]));
    }
  }
  out.assistantMessages = messages.size;
  // Last message (by first appearance) that has any text.
  const ordered = [...messages.values()].sort((a, b) => a.order - b.order);
  for (let i = ordered.length - 1; i >= 0; i--) {
    const text = [...ordered[i].blocks.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]).join('\n').trim();
    if (text) { out.lastText = text; break; }
  }
  return out;
}

// ---------------------------------------------------------------- HQ block

function splitItems(value) {
  return value.split(';').map((s) => s.trim()).filter(Boolean);
}

// Returns { summary, done, open } or null when no HQ block is present.
function parseHqBlock(text) {
  const lines = text.replace(/\r/g, '').split('\n');
  let startIdx = -1;
  let inlineSummary = '';
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (/^hq:$/i.test(t)) { startIdx = i; inlineSummary = ''; }
    else {
      const m = /^hq:\s+(.+)$/i.exec(t);
      if (m && !/^(summary|done|open)\s*:/i.test(m[1])) { startIdx = i; inlineSummary = m[1].trim(); }
    }
  }
  if (startIdx === -1) return null;

  const result = { summary: inlineSummary, done: [], open: [] };
  let current = null;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t === '' || t.startsWith('```')) break; // block ends at a blank line or fence
    const kv = /^(summary|done|open)\s*:\s*(.*)$/i.exec(t);
    if (kv) {
      current = kv[1].toLowerCase();
      const value = kv[2].trim();
      if (current === 'summary') result.summary = value;
      else if (value) result[current].push(...splitItems(value));
      continue;
    }
    const bullet = /^[-*]\s+(.+)$/.exec(t);
    if (bullet && current && current !== 'summary') { result[current].push(bullet[1].trim()); continue; }
    if (current === 'summary' && !result.summary) { result.summary = t; continue; }
    // Unknown line inside the block: treat it as the end.
    break;
  }
  result.done = dedupe(result.done);
  result.open = dedupe(result.open);
  if (!result.summary && !result.done.length && !result.open.length) return null;
  return result;
}

function dedupe(arr) {
  const seen = new Set();
  return arr.filter((s) => { const k = s.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
}

// Strips the HQ block itself plus common markdown, then returns the first sentence (<= 140 chars).
function fallbackSummary(text) {
  let t = text.replace(/\r/g, '');
  t = t.replace(/^\s*hq:\s*$[\s\S]*?(?:\n\s*\n|$)/im, ' ');   // multi-line HQ block
  t = t.replace(/^\s*hq:\s.*$/im, ' ');                        // single-line HQ
  t = t.replace(/```[\s\S]*?```/g, ' ');                       // fenced code
  t = t.replace(/`([^`]*)`/g, '$1');                           // inline code
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');                 // images
  t = t.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');               // links
  // Headings are dropped entirely (otherwise "## Summary" bleeds into the first sentence);
  // if the message was nothing but headings, keep their text instead.
  const noHeadings = t.replace(/^\s{0,3}#{1,6}\s+.*$/gm, ' ');
  t = noHeadings.trim() ? noHeadings : t.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  t = t.replace(/^\s*[-*+]\s+/gm, '');                         // bullets
  t = t.replace(/^\s*\d+\.\s+/gm, '');                         // numbered lists
  t = t.replace(/^\s*>\s?/gm, '');                             // quotes
  t = t.replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, '$1');       // emphasis
  t = t.replace(/<[^>]+>/g, ' ');                              // html tags
  t = t.replace(/\s+/g, ' ').trim();
  if (!t) return '';
  const m = /^(.*?[.!?])(?:\s|$)/.exec(t);
  let s = m ? m[1] : t;
  // Guard against "e.g." style false sentence ends giving a 4-char summary.
  if (s.length < 20 && t.length > s.length) s = t;
  if (s.length > 140) s = s.slice(0, 139).replace(/\s+\S*$/, '') + '…';
  return s;
}

// ---------------------------------------------------------------- helpers

function basename(p) {
  if (!p) return '';
  const parts = String(p).split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

// ~/.claude/projects/C--Users-vaxma-Desktop-ClipForge/<id>.jsonl -> "ClipForge" (last '-' segment).
// Only a last resort: folders with '-' in their name decode ambiguously.
function folderFromTranscriptPath(transcriptPath) {
  if (!transcriptPath) return '';
  const dir = basename(path.dirname(transcriptPath));
  const seg = dir.split('-').filter(Boolean);
  return seg.length ? seg[seg.length - 1] : '';
}

function gitBranch(cwd) {
  if (!cwd) return null;
  try {
    const b = execFileSync('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
    }).trim();
    return b && b !== 'HEAD' ? b : null; // "HEAD" = detached, not useful
  } catch { return null; }
}

async function request(cfg, method, endpoint, body) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), NETWORK_TIMEOUT_MS);
  try {
    const res = await fetch(cfg.url + endpoint, {
      method,
      headers: {
        authorization: 'Bearer ' + cfg.ingestKey,
        'content-type': 'application/json',
        'user-agent': 'hq-session-end/' + VERSION,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, ok: res.ok, body: json ?? text };
  } catch (e) {
    // Surface the real reason (ENOTFOUND, ECONNREFUSED, AbortError...) instead of "fetch failed".
    const cause = e && e.cause && (e.cause.code || e.cause.message);
    throw new Error(`${method} ${cfg.url}${endpoint} failed: ${e && e.name === 'AbortError' ? 'timeout after ' + NETWORK_TIMEOUT_MS + ' ms' : e.message}${cause ? ' (' + cause + ')' : ''}`);
  } finally {
    clearTimeout(t);
  }
}

// ---------------------------------------------------------------- main

async function main() {
  const cfg = loadConfig();

  if (MODE_PING) {
    if (!cfg.ingestKey) { console.log('No ingestKey configured (' + path.join(hqHome(), 'config.json') + ')'); return; }
    const r = await request(cfg, 'GET', '/api/ingest/ping');
    console.log(`${cfg.url}/api/ingest/ping -> ${r.status}`, typeof r.body === 'string' ? r.body : JSON.stringify(r.body));
    return;
  }

  let payload;
  if (MODE_TEST) {
    payload = {
      type: 'session',
      machine: cfg.machine,
      folder: 'hq-test',
      cwd: path.join(os.homedir(), 'hq-test'),
      branch: 'main',
      sessionId: 'test-' + Date.now().toString(36),
      endedAt: new Date().toISOString(),
      summary: 'Test session posted by hq-session-end.mjs --test',
      done: ['Verified the SessionEnd hook can reach the dashboard'],
      open: ['Delete this test entry from the History page'],
      source: 'hq-block',
    };
  } else {
    const stdinText = await readStdin();
    let hook = {};
    if (stdinText.trim()) {
      try { hook = JSON.parse(stdinText); } catch (e) { log('stdin is not JSON: ' + e.message); }
    }
    const transcriptPath = hook.transcript_path || '';
    const t = transcriptPath ? parseTranscript(transcriptPath) : { lastText: '', assistantMessages: 0, cwd: null, gitBranch: null, sessionId: null };

    const cwd = hook.cwd || t.cwd || '';
    const folder = basename(cwd) || folderFromTranscriptPath(transcriptPath) || 'unknown';
    const sessionId = hook.session_id || t.sessionId || basename(transcriptPath).replace(/\.jsonl$/i, '') || ('unknown-' + Date.now());

    if (t.assistantMessages < 2) {
      log(`skip session ${sessionId} (${folder}): only ${t.assistantMessages} assistant message(s)`);
      if (MODE_DRY) console.log(JSON.stringify({ skipped: 'fewer than 2 assistant messages', folder, sessionId }, null, 2));
      return;
    }
    if (cfg.ignoreFolders.includes(folder.toLowerCase())) {
      log(`skip session ${sessionId}: folder "${folder}" is in ignoreFolders`);
      if (MODE_DRY) console.log(JSON.stringify({ skipped: 'ignoreFolders', folder, sessionId }, null, 2));
      return;
    }

    const block = parseHqBlock(t.lastText);
    const summary = (block && block.summary) || fallbackSummary(t.lastText) || '(no summary)';
    payload = {
      type: 'session',
      machine: cfg.machine,
      folder,
      cwd: cwd || undefined,
      branch: gitBranch(cwd) || (t.gitBranch && t.gitBranch !== 'HEAD' ? t.gitBranch : null),
      sessionId,
      endedAt: new Date().toISOString(),
      summary,
      done: block ? block.done : [],
      open: block ? block.open : [],
      source: block ? 'hq-block' : 'last-message',
    };
    if (hook.reason) log(`session ${sessionId} (${folder}) ended: ${hook.reason}`);
  }

  if (MODE_DRY) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  if (!cfg.ingestKey) {
    log('no ingestKey configured; session not sent (' + payload.folder + ')');
    if (INTERACTIVE) console.log('No ingestKey configured (' + path.join(hqHome(), 'config.json') + ')');
    return;
  }
  const r = await request(cfg, 'POST', '/api/ingest', payload);
  const summaryLine = `POST /api/ingest session ${payload.sessionId} (${payload.folder}, ${payload.source}) -> ${r.status} ${typeof r.body === 'string' ? r.body.slice(0, 200) : JSON.stringify(r.body)}`;
  if (!r.ok) log(summaryLine); else log(summaryLine.slice(0, 300));
  if (INTERACTIVE) console.log(summaryLine);
}

main()
  .catch((e) => log('error: ' + (e && e.message || e)))
  .finally(() => { clearTimeout(watchdog); process.exit(0); });
