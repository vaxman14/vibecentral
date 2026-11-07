#!/usr/bin/env node
// HQ - installer helper (pure Node, no jq). Used by install-hq-agent.ps1 / .sh.
//
//   Merge the SessionEnd hook into Claude Code's settings.json without touching other hooks:
//     node hq-hook-settings.mjs --settings ~/.claude/settings.json --command '<cmd>' [--timeout 10]
//   Remove it again:
//     node hq-hook-settings.mjs --settings ~/.claude/settings.json --remove
//
//   Append the HQ block instructions to a CLAUDE.md (idempotent, marker-delimited):
//     node hq-hook-settings.mjs --claude-md ~/.claude/CLAUDE.md --snippet CLAUDE-HQ-snippet.md
//   Remove them:
//     node hq-hook-settings.mjs --claude-md ~/.claude/CLAUDE.md --remove
//
// "Ours" = any command hook whose command mentions hq-session-end.mjs. On merge, an existing
// one is updated in place (path or timeout may have changed) instead of adding a duplicate.

import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const opt = (name, dflt) => { const i = argv.indexOf(name); return i === -1 ? dflt : argv[i + 1]; };
const has = (name) => argv.includes(name);

const MARK_START = '<!-- hq:start -->';
const MARK_END = '<!-- hq:end -->';
const OURS = /hq-session-end\.mjs/i;

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch (e) {
    if (e.code === 'ENOENT') return {};
    throw new Error(`${file} is not valid JSON (${e.message}). Fix it by hand, then re-run.`);
  }
}

function writeFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) fs.copyFileSync(file, file + '.bak'); // one-step undo
  fs.writeFileSync(file, text);
}

function mergeHook(settingsFile, command, timeout) {
  const s = readJson(settingsFile);
  if (typeof s !== 'object' || s === null || Array.isArray(s)) throw new Error('settings.json root must be an object');
  s.hooks = s.hooks && typeof s.hooks === 'object' ? s.hooks : {};
  const groups = Array.isArray(s.hooks.SessionEnd) ? s.hooks.SessionEnd : [];
  const ours = { type: 'command', command, timeout };
  let replaced = 0;
  for (const g of groups) {
    if (!g || !Array.isArray(g.hooks)) continue;
    g.hooks = g.hooks.map((h) => (h && h.type === 'command' && OURS.test(String(h.command || '')) ? (replaced++, ours) : h));
  }
  if (replaced === 0) groups.push({ hooks: [ours] });
  s.hooks.SessionEnd = groups;
  writeFile(settingsFile, JSON.stringify(s, null, 2) + '\n');
  console.log(replaced ? `updated existing SessionEnd hook in ${settingsFile}` : `added SessionEnd hook to ${settingsFile}`);
}

function removeHook(settingsFile) {
  if (!fs.existsSync(settingsFile)) { console.log('no settings.json, nothing to remove'); return; }
  const s = readJson(settingsFile);
  const groups = s.hooks && Array.isArray(s.hooks.SessionEnd) ? s.hooks.SessionEnd : [];
  let removed = 0;
  const kept = groups.map((g) => {
    if (!g || !Array.isArray(g.hooks)) return g;
    const hooks = g.hooks.filter((h) => { const mine = h && OURS.test(String(h.command || '')); if (mine) removed++; return !mine; });
    return { ...g, hooks };
  }).filter((g) => !g || !Array.isArray(g.hooks) || g.hooks.length > 0);
  if (!removed) { console.log('SessionEnd hook for HQ not present'); return; }
  if (kept.length) s.hooks.SessionEnd = kept; else delete s.hooks.SessionEnd;
  if (s.hooks && Object.keys(s.hooks).length === 0) delete s.hooks;
  writeFile(settingsFile, JSON.stringify(s, null, 2) + '\n');
  console.log(`removed ${removed} SessionEnd hook(s) from ${settingsFile}`);
}

function appendSnippet(mdFile, snippetFile) {
  const snippet = fs.readFileSync(snippetFile, 'utf8').trim();
  const block = `${MARK_START}\n${snippet}\n${MARK_END}\n`;
  let text = fs.existsSync(mdFile) ? fs.readFileSync(mdFile, 'utf8') : '';
  const re = new RegExp(`${MARK_START}[\\s\\S]*?${MARK_END}\\n?`);
  if (re.test(text)) {
    const next = text.replace(re, block);
    if (next === text) { console.log(`${mdFile} already up to date`); return; }
    writeFile(mdFile, next);
    console.log(`updated HQ section in ${mdFile}`);
    return;
  }
  writeFile(mdFile, (text && !text.endsWith('\n') ? text + '\n' : text) + (text ? '\n' : '') + block);
  console.log(`appended HQ section to ${mdFile}`);
}

function removeSnippet(mdFile) {
  if (!fs.existsSync(mdFile)) { console.log('no CLAUDE.md, nothing to remove'); return; }
  const text = fs.readFileSync(mdFile, 'utf8');
  const re = new RegExp(`\\n?${MARK_START}[\\s\\S]*?${MARK_END}\\n?`);
  if (!re.test(text)) { console.log('HQ section not present in ' + mdFile); return; }
  writeFile(mdFile, text.replace(re, '\n').replace(/\n{3,}/g, '\n\n'));
  console.log(`removed HQ section from ${mdFile}`);
}

try {
  const settings = opt('--settings');
  const claudeMd = opt('--claude-md');
  if (settings) {
    if (has('--remove')) removeHook(settings);
    else {
      // Windows PowerShell 5.1 cannot pass an argument containing double quotes to node intact,
      // so installers may hand the command over in HQ_HOOK_COMMAND instead of --command.
      const command = opt('--command') || process.env.HQ_HOOK_COMMAND;
      if (!command) throw new Error('--command (or env HQ_HOOK_COMMAND) is required');
      mergeHook(settings, command, Number(opt('--timeout', '10')) || 10);
    }
  } else if (claudeMd) {
    if (has('--remove')) removeSnippet(claudeMd);
    else {
      const snippet = opt('--snippet');
      if (!snippet) throw new Error('--snippet <file> is required');
      appendSnippet(claudeMd, snippet);
    }
  } else {
    console.error('usage: hq-hook-settings.mjs --settings <file> (--command <cmd> [--timeout n] | --remove)\n       hq-hook-settings.mjs --claude-md <file> (--snippet <file> | --remove)');
    process.exit(2);
  }
} catch (e) {
  console.error('hq-hook-settings: ' + e.message);
  process.exit(1);
}
