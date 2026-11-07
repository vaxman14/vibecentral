// Copies the agent scripts into the site so each machine can install with one line:
//   https://your-dashboard.example/agent/install.ps1 , /agent/install.sh , /agent/*.mjs
import { mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const files = {
  'install-hq-agent.ps1': 'install.ps1',
  'install-hq-agent.sh': 'install.sh',
  'hq-session-end.mjs': 'hq-session-end.mjs',
  'hq-usage-agent.mjs': 'hq-usage-agent.mjs',
  'hq-hook-settings.mjs': 'hq-hook-settings.mjs',
  'CLAUDE-HQ-snippet.md': 'CLAUDE-HQ-snippet.md',
};
for (const dir of [join(root, 'web', 'public', 'agent'), join(root, 'dist', 'web', 'agent')]) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  for (const [src, dst] of Object.entries(files)) copyFileSync(join(root, 'scripts', src), join(dir, dst));
}
// brand assets served by the app at /brand/* (favicon, touch icon, manifest icons, loading mark)
const brandSrc = join(root, 'assets', 'brand');
const brandFiles = ['favicon.ico', 'vibecentral-mark.svg', 'vibecentral-mark-animated.svg', 'png/vibecentral-mark-180.png', 'png/vibecentral-mark-192.png', 'png/vibecentral-mark-512.png'];
for (const dir of [join(root, 'web', 'public'), join(root, 'dist', 'web')]) {
  for (const f of brandFiles) {
    const dst = join(dir, 'brand', f);
    mkdirSync(join(dst, '..'), { recursive: true });
    copyFileSync(join(brandSrc, f), dst);
  }
  copyFileSync(join(brandSrc, 'favicon.ico'), join(dir, 'favicon.ico'));
}
console.log('agent scripts copied to web/public/agent and dist/web/agent; brand assets to /brand');
