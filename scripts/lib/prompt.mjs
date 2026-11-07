// Shared terminal prompting for the setup scripts (setup.mjs, setup-secrets.mjs).
// Own line queue instead of readline: readline drops lines that arrive before a question is asked,
// which breaks pasting several values at once or piping answers in.
import { stdin, stdout } from 'node:process';

const queue = [];
let waiter = null;
let pending = '';
let rawMode = false;
let started = false;

function onData(chunk) {
  if (rawMode) return;
  pending += chunk;
  let i;
  while ((i = pending.search(/\r?\n/)) >= 0) {
    queue.push(pending.slice(0, i));
    pending = pending.slice(i + (pending[i] === '\r' && pending[i + 1] === '\n' ? 2 : 1));
  }
  if (waiter && queue.length) { const w = waiter; waiter = null; w(queue.shift()); }
}
function onEnd() {
  if (pending) queue.push(pending);
  pending = '';
  if (waiter) { const w = waiter; waiter = null; w(queue.shift() ?? ''); }
}

/** Start listening on stdin. Called lazily by ask(); safe to call more than once. */
export function start() {
  if (started) return;
  started = true;
  stdin.setEncoding('utf8');
  stdin.on('data', onData);
  stdin.on('end', onEnd);
  stdin.resume();
}
/** Stop reading stdin so a child process (wrangler login, supabase link…) can own the terminal. */
export function pause() { if (started) stdin.pause(); }
/** Resume reading after a child process has finished. */
export function resume() { if (started) stdin.resume(); }
/** Release stdin so the process can exit. */
export function stop() { if (started) stdin.pause(); }

function nextLine() {
  return new Promise((resolve) => {
    if (queue.length) return resolve(queue.shift());
    waiter = resolve;
  });
}

/** Ask a visible question; returns the trimmed answer. */
export async function ask(q) {
  start();
  stdout.write(q);
  return (await nextLine()).trim();
}

/** Ask with hidden input (paste works). Falls back to ask() when stdin is not a TTY. */
export async function askHidden(q) {
  start();
  if (!stdin.isTTY) return ask(q);
  stdout.write(q);
  return new Promise((resolve) => {
    let buf = '';
    const onRaw = (s) => {
      for (const c of s) {
        if (c === '\r' || c === '\n') {
          stdin.setRawMode(false); rawMode = false; stdin.removeListener('data', onRaw); stdout.write('\n');
          resolve(buf.trim()); return;
        }
        if (c === '\u0003') { stdout.write('\n'); process.exit(130); }
        if (c === '\u007f' || c === '\b') { buf = buf.slice(0, -1); continue; }
        buf += c;
      }
    };
    rawMode = true; stdin.setRawMode(true); stdin.on('data', onRaw);
  });
}

/** Short masked form of a secret for "keep ••••" hints. Never prints the whole value. */
export const mask = (v) => (!v ? '' : v.length <= 8 ? '••••' : v.slice(0, 4) + '…' + v.slice(-3));

export const isTTY = !!stdin.isTTY;
