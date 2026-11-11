'use strict';
// Проверяет, что собранные конфиги Xray валидны: пресеты маршрутизации, TUN-инбаунд,
// свои исключения. Запуск: npm run check:config
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { buildConfig } = require('../lib/xray-config');

const root = path.join(__dirname, '..');
const bin = path.join(root, 'bin', process.platform === 'win32' ? 'xray.exe' : 'xray');
if (!fs.existsSync(bin)) {
  console.error('Нет xray в bin\\ — выполните «npm run fetch-xray»');
  process.exit(1);
}

const server = {
  protocol: 'vless',
  host: 'example.com',
  port: 443,
  params: { id: '11111111-2222-3333-4444-555555555555', security: 'tls', sni: 'example.com', fp: 'chrome' },
};

const cases = [
  ['без пресетов', { routePresets: [] }],
  ['реклама + Россия + Discord', { routePresets: ['ads-block', 'ru-direct', 'discord-direct'] }],
  ['все пресеты', { routePresets: ['ru-direct', 'ads-block', 'trackers-block', 'porn-block', 'discord-direct', 'social-direct', 'youtube-direct', 'openai-direct'] }],
  ['TUN-режим', { routePresets: ['ru-direct'], tun: true }],
  ['свои исключения', { bypassDomains: ['example.com'], bypassIps: ['192.0.2.0/24'], routePresets: ['ads-block'] }],
];

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marinbox-cfg-'));
let failed = 0;
for (const [name, opts] of cases) {
  const cfg = buildConfig(server, { socksPort: 10808, httpPort: 10809, logLevel: 'warning', ...opts });
  const file = path.join(dir, 'c.json');
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
  const r = spawnSync(bin, ['run', '-test', '-c', file], { encoding: 'utf8' });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const ok = /Configuration OK/i.test(out);
  if (!ok) failed++;
  console.log(`${ok ? 'OK   ' : 'FAIL '} ${name}`);
  if (!ok) console.log('      ' + out.split(/\r?\n/).filter(Boolean).slice(-2).join('\n      '));
  if (opts.routePresets.length) {
    console.log('      правила: ' + cfg.routing.rules.map((x) => `${JSON.stringify(x.domain || x.ip)} -> ${x.outboundTag}`).join(', '));
  }
}
fs.rmSync(dir, { recursive: true, force: true });
console.log(failed ? `\n${failed} проверок провалилось` : '\nВсе конфиги валидны');
process.exit(failed ? 1 : 0);
