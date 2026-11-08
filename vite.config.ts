import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Генерирует service worker при сборке: в precache попадают все файлы
 * бандла и содержимое public/, версия кэша меняется с каждой сборкой.
 */
function serviceWorker(): Plugin {
  const listPublic = (dir: string, prefix = ''): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory()
        ? listPublic(path.join(dir, e.name), `${prefix}${e.name}/`)
        : [`${prefix}${e.name}`],
    );

  return {
    name: 'ace-service-worker',
    apply: 'build',
    generateBundle(_options, bundle) {
      const files = [
        './',
        ...Object.keys(bundle).filter((f) => !f.endsWith('.map')),
        ...listPublic(path.resolve('public')),
      ];
      const template = fs.readFileSync(path.resolve('pwa/sw-template.js'), 'utf8');
      const source = template
        .replace('__PRECACHE__', JSON.stringify(files, null, 2))
        .replace('__VERSION__', `ace-${Date.now().toString(36)}`);
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}

export default defineConfig({
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(process.env.npm_package_version ?? '0.1.0'),
  },
  plugins: [react(), serviceWorker()],
  build: {
    target: 'safari16',
    chunkSizeWarningLimit: 800,
  },
});
