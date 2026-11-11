'use strict';

const { selectedRules } = require('./route-presets');

// Пресеты DNS: серверы и режим (обычный / DoH)
const DNS_PRESETS = {
  system: null,
  cloudflare: { servers: ['1.1.1.1', '1.0.0.1'], doh: ['https://1.1.1.1/dns-query', 'https://1.0.0.1/dns-query'] },
  google: { servers: ['8.8.8.8', '8.4.4.4'], doh: ['https://dns.google/dns-query', 'https://dns.googleapis.com/dns-query'] },
  quad9: { servers: ['9.9.9.9', '149.112.112.112'], doh: ['https://dns.quad9.net/dns-query'] },
  yandex: { servers: ['77.88.8.8', '77.88.8.1'], doh: ['https://common.dot.dns.yandex.net/dns-query'] },
};

function dnsServersFor(preset, custom) {
  const list = [];
  if (preset === 'custom') {
    for (const s of String(custom || '').split(/[\s,;]+/)) {
      const v = s.trim();
      if (v) list.push(v);
    }
  } else if (DNS_PRESETS[preset]) {
    list.push(...DNS_PRESETS[preset].servers);
  }
  return [...new Set(list)];
}

function streamSettings(p) {
  const net = p.network === 'h2' ? 'http' : (p.network || 'tcp');
  const ss = { network: net, security: p.security || 'none' };

  if (ss.security === 'tls') {
    ss.tlsSettings = {
      serverName: p.sni || p.host || undefined,
      allowInsecure: !!p.allowInsecure,
      fingerprint: p.fp || 'chrome',
      alpn: p.alpn ? String(p.alpn).split(',') : undefined,
    };
  } else if (ss.security === 'reality') {
    ss.realitySettings = {
      serverName: p.sni,
      fingerprint: p.fp || 'chrome',
      publicKey: p.pbk,
      shortId: p.sid || '',
      spiderX: p.spx || '',
    };
  }

  if (net === 'ws') {
    ss.wsSettings = { path: p.path || '/', headers: p.host ? { Host: p.host } : undefined };
  } else if (net === 'grpc') {
    ss.grpcSettings = { serviceName: p.serviceName || p.path || '', multiMode: p.mode === 'multi' };
  } else if (net === 'httpupgrade') {
    ss.httpupgradeSettings = { path: p.path || '/', host: p.host || undefined };
  } else if (net === 'xhttp' || net === 'splithttp') {
    ss.network = 'xhttp';
    ss.xhttpSettings = { path: p.path || '/', host: p.host || undefined, mode: p.mode || 'auto' };
  } else if (net === 'http') {
    ss.httpSettings = { path: p.path || '/', host: p.host ? String(p.host).split(',') : undefined };
  } else if (net === 'tcp' && p.headerType === 'http') {
    ss.tcpSettings = {
      header: {
        type: 'http',
        request: { path: [p.path || '/'], headers: p.host ? { Host: String(p.host).split(',') } : undefined },
      },
    };
  }
  return ss;
}

function buildOutbound(s) {
  const p = s.params;
  let o;
  switch (s.protocol) {
    case 'vless':
      o = { protocol: 'vless', settings: { vnext: [{ address: s.host, port: s.port,
        users: [{ id: p.id, encryption: p.encryption || 'none', flow: p.flow || undefined }] }] } };
      break;
    case 'vmess':
      o = { protocol: 'vmess', settings: { vnext: [{ address: s.host, port: s.port,
        users: [{ id: p.id, alterId: p.aid || 0, security: p.scy || 'auto' }] }] } };
      break;
    case 'trojan':
      o = { protocol: 'trojan', settings: { servers: [{ address: s.host, port: s.port, password: p.password }] } };
      break;
    case 'shadowsocks':
      o = { protocol: 'shadowsocks', settings: { servers: [{ address: s.host, port: s.port,
        method: p.method, password: p.password }] } };
      break;
    default:
      throw new Error('протокол не поддерживается: ' + s.protocol);
  }
  o.tag = 'proxy';
  if (s.protocol !== 'shadowsocks') o.streamSettings = streamSettings(p);
  return o;
}

// TUN-инбаунд Xray: весь трафик системы уходит в туннель.
// autoSystemRoutingTable — маршруты в таблицу ОС, autoOutboundsInterface —
// собственный трафик Xray идёт мимо туннеля (иначе получается петля).
function buildTunInbound(sniffing) {
  return {
    tag: 'tun', protocol: 'tun',
    settings: {
      name: 'MarinBox',
      desc: 'MarinVPN',
      mtu: 1500,
      gateway: ['10.0.0.1/16', 'fc00::1/64'],
      dns: ['1.1.1.1', '8.8.8.8'],
      autoSystemRoutingTable: ['0.0.0.0/0', '::/0'],
      autoOutboundsInterface: 'auto',
      // Только misconfigtun: фильтр "dns" запрещает резолверу обращаться
      // к обычным DNS-серверам и в этом случае ломает разрешение имён.
      autoSystemWfpBlockLeak: ['misconfigtun'],
    },
    sniffing,
  };
}

function buildConfig(server, {
  socksPort = 10808, httpPort = 10809, logLevel = 'warning', logPath, bypassDomains = [], bypassIps = [],
  routePresets = [], tun = false, appRules = [], categories = [],
  dnsPreset = 'system', dnsCustom = '', dnsDoh = false,
} = {}) {
  const sniffing = { enabled: true, destOverride: ['http', 'tls', 'quic'] };
  const rules = [];

  // 1. Правила по приложениям — самое специфичное, поэтому первыми
  for (const item of Array.isArray(appRules) ? appRules : []) {
    const process = String(item.process || '').trim();
    if (!process) continue;
    const tag = item.mode === 'direct' ? 'direct' : item.mode === 'block' ? 'block' : 'proxy';
    rules.push({ type: 'field', process: [process], outboundTag: tag });
  }

  // 2. DNS-запросы — в модуль DNS Xray (если включено)
  const dnsServers = dnsServersFor(dnsPreset, dnsCustom);
  const useDnsModule = dnsDoh && dnsServers.length > 0;
  if (useDnsModule) rules.push({ type: 'field', port: 53, outboundTag: 'dns-out' });

  // 3. Свои исключения
  if (bypassDomains.length) rules.push({ type: 'field', domain: bypassDomains.map((domain) => `domain:${domain}`), outboundTag: 'direct' });
  if (bypassIps.length) rules.push({ type: 'field', ip: bypassIps, outboundTag: 'direct' });

  // 4. Готовые пресеты
  for (const preset of selectedRules(routePresets)) {
    const rule = { type: 'field', outboundTag: preset.outboundTag };
    if (preset.domain && preset.domain.length) rule.domain = preset.domain;
    if (preset.ip && preset.ip.length) rule.ip = preset.ip;
    rules.push(rule);
  }

  // 5. Категории из каталога geosite: сначала блокировки, потом «напрямую»
  const cats = Array.isArray(categories) ? categories : [];
  const catBlock = cats.filter((c) => c.mode === 'block').map((c) => `geosite:${c.name}`);
  const catDirect = cats.filter((c) => c.mode === 'direct').map((c) => `geosite:${c.name}`);
  if (catBlock.length) rules.push({ type: 'field', domain: catBlock, outboundTag: 'block' });
  if (catDirect.length) rules.push({ type: 'field', domain: catDirect, outboundTag: 'direct' });

  rules.push({ type: 'field', ip: ['geoip:private'], outboundTag: 'direct' });

  const inbounds = [
    { tag: 'socks', listen: '127.0.0.1', port: socksPort, protocol: 'socks',
      settings: { udp: true, auth: 'noauth' }, sniffing },
    { tag: 'http', listen: '127.0.0.1', port: httpPort, protocol: 'http', sniffing },
  ];
  if (tun) {
    const inbound = buildTunInbound(sniffing);
    if (dnsServers.length) inbound.settings.dns = dnsServers;
    if (useDnsModule) inbound.settings.autoSystemWfpBlockLeak = ['dns', 'misconfigtun'];
    inbounds.unshift(inbound);
  }
  const outbounds = [
    buildOutbound(server),
    { tag: 'direct', protocol: 'freedom' },
    { tag: 'block', protocol: 'blackhole' },
  ];
  const config = {
    log: {
      loglevel: ['debug', 'info', 'warning', 'error', 'none'].includes(logLevel) ? logLevel : 'warning',
      error: logPath,
    },
    inbounds,
    outbounds,
    routing: {
      domainStrategy: 'IPIfNonMatch',
      rules,
    },
  };
  if (useDnsModule) {
    const preset = DNS_PRESETS[dnsPreset];
    const servers = dnsPreset === 'custom'
      ? (dnsServers.find((s) => s.includes('://')) ? dnsServers : dnsServers.map((s) => `https://${s}/dns-query`))
      : (preset && preset.doh ? preset.doh : dnsServers.map((s) => `https://${s}/dns-query`));
    config.dns = { servers, queryStrategy: 'UseIP' };
    outbounds.push({ tag: 'dns-out', protocol: 'dns' });
  }
  return config;
}

module.exports = { buildConfig, buildOutbound, buildTunInbound, DNS_PRESETS, dnsServersFor };
