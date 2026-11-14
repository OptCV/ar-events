import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * Build: emits into out/p0/webxr so the probe ships inside the P0 device lab (run `npm run p0:build`).
 * Dev:   serves out/p0 as public dir so `../images`, `../glb` resolve. Use with `adb reverse tcp:5173 tcp:5173`
 *        and open http://localhost:5173 on the phone (localhost counts as a secure context).
 */
export default defineConfig(({ command }) => ({
  root: here('.'),
  base: './',
  publicDir: command === 'serve' ? here('../../out/p0') : false,
  build: {
    outDir: here('../../out/p0/webxr'),
    emptyOutDir: true,
    target: 'es2022',
    chunkSizeWarningLimit: 900, // three.js
  },
  server: { port: 5173, strictPort: true },
}));
