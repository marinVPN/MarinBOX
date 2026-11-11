'use strict';
const assert = require('assert');
const { parseLink, parseSubscriptionBody } = require('../lib/parser');
const { buildConfig } = require('../lib/xray-config');
const { PRESETS, selectedRules } = require('../lib/route-presets');
const updater = require('../lib/updater');

const b64 = (s) => Buffer.from(s).toString('base64');

// VLESS + Reality
const vless = parseLink('vless://11111111-2222-3333-4444-555555555555@example.com:443?type=tcp&security=reality&pbk=PUBKEY&sid=ab12&sni=www.microsoft.com&fp=chrome&flow=xtls-rprx-vision#Marin%20NL');
assert.equal(vless.protocol, 'vless');
assert.equal(vless.name, 'Marin NL');
assert.equal(vless.host, 'example.com');
assert.equal(vless.port, 443);
assert.equal(vless.params.id, '11111111-2222-3333-4444-555555555555');
let cfg = buildConfig(vless);
let out = cfg.outbounds[0];
assert.equal(out.streamSettings.security, 'reality');
assert.equal(out.streamSettings.realitySettings.publicKey, 'PUBKEY');
assert.equal(out.streamSettings.realitySettings.shortId, 'ab12');
assert.equal(out.settings.vnext[0].users[0].flow, 'xtls-rprx-vision');

// VLESS + WS + TLS, IPv6-подобный и кириллическое имя
const ws = parseLink('vless://aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee@ws.example.com:8443?type=ws&security=tls&sni=ws.example.com&path=%2Fmarin&host=ws.example.com#%D0%A0%D0%BE%D1%81%D1%81%D0%B8%D1%8F');
assert.equal(ws.name, 'Россия');
out = buildConfig(ws).outbounds[0];
assert.equal(out.streamSettings.wsSettings.path, '/marin');
assert.equal(out.streamSettings.tlsSettings.serverName, 'ws.example.com');

// VMess
const vm = parseLink('vmess://' + b64(JSON.stringify({ v: '2', ps: 'VM', add: '9.9.9.9', port: '443', id: 'uuid-1', aid: '0', net: 'ws', tls: 'tls', path: '/v', host: 'h.example' })));
assert.equal(vm.protocol, 'vmess');
assert.equal(vm.port, 443);
assert.equal(buildConfig(vm).outbounds[0].streamSettings.network, 'ws');

// Trojan
const tr = parseLink('trojan://p%40ss@t.example.com:443?sni=t.example.com#TR');
assert.equal(tr.params.password, 'p@ss');
assert.equal(buildConfig(tr).outbounds[0].settings.servers[0].password, 'p@ss');
assert.equal(buildConfig(tr).outbounds[0].streamSettings.security, 'tls');

// Shadowsocks (оба формата)
const ss1 = parseLink('ss://' + b64('aes-256-gcm:secret') + '@1.2.3.4:8388#SS1');
assert.equal(ss1.params.method, 'aes-256-gcm');
assert.equal(ss1.params.password, 'secret');
assert.equal(ss1.port, 8388);
const ss2 = parseLink('ss://' + b64('chacha20-ietf-poly1305:pw@5.6.7.8:1234') + '#SS2');
assert.equal(ss2.host, '5.6.7.8');
assert.equal(ss2.port, 1234);

// Подписка: base64 и обычный текст, дубликаты отбрасываются
const lines = [vless.raw, vm.raw, tr.raw, ss1.raw, vless.raw, 'garbage://x'].join('\n');
assert.equal(parseSubscriptionBody(b64(lines)).length, 4);
assert.equal(parseSubscriptionBody(lines).length, 4);

// Конфиг: порты и маршрутизация
assert.equal(cfg.inbounds[0].port, 10808);
assert.equal(cfg.inbounds[1].port, 10809);
assert.deepEqual(cfg.routing.rules[0].ip, ['geoip:private']);
JSON.parse(JSON.stringify(cfg));

// Пресеты маршрутизации
const presetCfg = buildConfig(vless, { routePresets: ['ads-block', 'ru-direct', 'discord-direct'] });
const presetRules = presetCfg.routing.rules;
assert.equal(presetRules[0].outboundTag, 'block', 'реклама блокируется первой');
assert.deepEqual(presetRules[0].domain, ['geosite:category-ads-all']);
assert.ok(presetRules.some((r) => r.outboundTag === 'direct' && (r.domain || []).includes('geosite:category-ru')));
assert.ok(presetRules.some((r) => r.outboundTag === 'direct' && (r.ip || []).includes('geoip:ru')));
assert.ok(presetRules.some((r) => (r.domain || []).includes('geosite:discord')));
assert.equal(presetCfg.outbounds.find((o) => o.tag === 'block').protocol, 'blackhole');
assert.equal(selectedRules(['ads-block']).length, 1);
assert.equal(selectedRules([]).length, 0);
assert.equal(PRESETS.every((p) => p.id && p.label && p.hint), true);

// TUN-инбаунд
const tunCfg = buildConfig(vless, { tun: true });
const tun = tunCfg.inbounds[0];
assert.equal(tun.protocol, 'tun');
assert.deepEqual(tun.settings.autoSystemRoutingTable, ['0.0.0.0/0', '::/0']);
assert.equal(tun.settings.autoOutboundsInterface, 'auto');
assert.equal(tunCfg.inbounds.length, 3, 'TUN + socks + http');

// Автообновление: сравнение версий и проверка манифеста
assert.equal(updater.compareVersions('1.2.0', '1.1.9'), 1);
assert.equal(updater.compareVersions('1.1.0', '1.1.0'), 0);
assert.equal(updater.compareVersions('1.0.9', '1.1.0'), -1);
assert.equal(updater.isNewer('1.1.0', '1.0.0'), true);
assert.equal(updater.isNewer('1.0.0', '1.0.0'), false);
assert.throws(() => updater.normalizeManifest({ version: '1.1.0', url: 'http://example.com/a.exe' }), /HTTPS/);
assert.throws(() => updater.normalizeManifest({ url: 'https://example.com/a.exe' }), /версию/);
const manifest = updater.normalizeManifest({ version: '1.1.0', url: 'https://example.com/a.exe', notes: 'ок', mandatory: true });
assert.equal(manifest.version, '1.1.0');
assert.equal(manifest.mandatory, true);

// Релиз GitHub -> манифест: тег = версия, текст релиза = changelog, вложение = установщик
const gh = {
  tag_name: 'v1.2.0',
  body: '- Пункт 1\n- Пункт 2',
  published_at: '2026-11-12T10:00:00Z',
  assets: [{ name: 'MarinBox Setup 1.2.0.exe', browser_download_url: 'https://github.com/o/r/releases/download/v1.2.0/a.exe', size: 42 }],
};
const ghManifest = updater.githubManifest(gh);
assert.equal(ghManifest.version, '1.2.0');
assert.equal(ghManifest.size, 42);
assert.equal(ghManifest.notes, '- Пункт 1\n- Пункт 2');
assert.throws(() => updater.githubManifest({ tag_name: 'v1.2.0', assets: [] }), /установщика/);
assert.throws(() => updater.githubManifest({ assets: gh.assets }), /тег версии/);

console.log('OK: все проверки парсера, конфига, пресетов и обновлений пройдены');
