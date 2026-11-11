// Готовит конфигурацию ИИ-прокси для развёртывания из GitHub Actions:
// находит или создаёт хранилище KV для лимитов и пишет server/ai-proxy/wrangler.ci.toml
// (базовый wrangler.toml + привязка USAGE + REQUIRE_KV=1, чтобы без хранилища сервер не тратил деньги).
// Секретов не читает и не выводит. Запуск: node scripts/ai-proxy-config.mjs (нужны CLOUDFLARE_API_TOKEN и CLOUDFLARE_ACCOUNT_ID).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const DIR = path.resolve('server/ai-proxy');
const NS = 'ai-car-expert-usage';
const wrangler = (args) => execFileSync('npx', ['--yes', 'wrangler@4.152.0', ...args], { cwd: DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });

export function withKv(base, id) {
  if (!/^[0-9a-f]{32}$/.test(id)) throw new Error('Некорректный id KV');
  const vars = base.replace(/^\[vars\]\s*$/m, '[vars]\nREQUIRE_KV = "1"');
  if (vars === base) throw new Error('В wrangler.toml нет секции [vars]');
  return `${vars.trimEnd()}\n\n[[kv_namespaces]]\nbinding = "USAGE"\nid = "${id}"\n`;
}

function findNamespace() {
  const out = wrangler(['kv', 'namespace', 'list']);
  const list = JSON.parse(out.slice(out.indexOf('[')));
  return list.find((n) => n.title === NS || n.title.endsWith(`-${NS}`))?.id;
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  let id = findNamespace();
  if (!id) {
    wrangler(['kv', 'namespace', 'create', NS]);
    id = findNamespace();
  }
  if (!id) throw new Error('Не удалось создать хранилище KV');
  const base = fs.readFileSync(path.join(DIR, 'wrangler.toml'), 'utf8');
  fs.writeFileSync(path.join(DIR, 'wrangler.ci.toml'), withKv(base, id));
  console.log(`KV ${NS}: ${id}`);
}
