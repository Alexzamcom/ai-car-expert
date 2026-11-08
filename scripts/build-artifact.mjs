// Однофайловая сборка (JS и CSS встроены в HTML) для размещения как страницы claude.ai.
// node scripts/build-artifact.mjs <выходной файл>
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const out = process.argv[2] ?? 'dist-artifact/ai-car-expert.html';
execSync('npx vite build --mode artifact', { stdio: 'inherit' });
const dir = path.resolve('dist-artifact');
const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
const css = [...html.matchAll(/<link rel="stylesheet"[^>]*href="\.\/([^"]+)"[^>]*>/g)].map((m) => fs.readFileSync(path.join(dir, m[1]), 'utf8')).join('\n');
const js = [...html.matchAll(/<script type="module"[^>]*src="\.\/([^"]+)"[^>]*><\/script>/g)].map((m) => fs.readFileSync(path.join(dir, m[1]), 'utf8')).join('\n');
const page = `<title>AI Car Expert</title>
<meta name="theme-color" content="#06080b">
<meta name="color-scheme" content="dark">
<style>
${css}
</style>
<div id="root"></div>
<script type="module">
${js.replace(/<\/script/gi, '<\\/script')}
</script>
`;
fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
fs.writeFileSync(out, page);
console.log(`→ ${out} (${(page.length / 1024).toFixed(0)} КБ)`);
