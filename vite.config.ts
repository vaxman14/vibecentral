import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: 'web',
  publicDir: 'public',
  build: { outDir: '../dist/web', emptyOutDir: true, sourcemap: false },
  resolve: { alias: { '@shared': fileURLToPath(new URL('./supabase/functions/_shared', import.meta.url)) } },
  server: { port: 5173, proxy: { '/api': 'http://localhost:8787' } },
});
