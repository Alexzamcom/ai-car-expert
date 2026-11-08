// Генерация PNG-иконок из public/icons/icon.svg (использует Playwright/Chromium).
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
import fs from 'node:fs';
import path from 'node:path';

const svg = fs.readFileSync(path.resolve('public/icons/icon.svg'), 'utf8');
const targets = [
  { file: 'icon-192.png', size: 192, pad: 0, bg: 'transparent' },
  { file: 'icon-512.png', size: 512, pad: 0, bg: 'transparent' },
  { file: 'apple-touch-icon.png', size: 180, pad: 0, bg: '#06080b', square: true },
  { file: 'icon-maskable-512.png', size: 512, pad: 0.12, bg: '#06080b', square: true },
];

const browser = await chromium.launch();
const page = await browser.newPage();
for (const t of targets) {
  await page.setViewportSize({ width: t.size, height: t.size });
  const inner = Math.round(t.size * (1 - t.pad * 2));
  const art = t.square ? svg.replace('rx="112"', 'rx="0"') : svg;
  await page.setContent(
    `<html><body style="margin:0;background:${t.bg};display:grid;place-items:center;width:${t.size}px;height:${t.size}px">` +
      `<div style="width:${inner}px;height:${inner}px">${art.replace('<svg ', '<svg width="100%" height="100%" ')}</div></body></html>`,
  );
  await page.screenshot({
    path: path.resolve('public/icons', t.file),
    omitBackground: t.bg === 'transparent',
  });
  console.log('✓', t.file);
}
await browser.close();
