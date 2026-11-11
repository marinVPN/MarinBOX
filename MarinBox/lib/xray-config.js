'use strict';

const { selectedRules } = require('./route-presets');

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
  routePresets = [], tun = false,
} = {}) {
  const sniffing = { enabled: true, destOverride: ['http', 'tls', 'quic'] };
  const rules = [];
  if (bypassDomains.length) rules.push({ type: 'field', domain: bypassDomains.map((domain) => `domain:${domain}`), outboundTag: 'direct' });
  if (bypassIps.length) rules.push({ type: 'field', ip: bypassIps, outboundTag: 'direct' });
  for (const preset of selectedRules(routePresets)) {
    const rule = { type: 'field', outboundTag: preset.outboundTag };
    if (preset.domain && preset.domain.length) rule.domain = preset.domain;
    if (preset.ip && preset.ip.length) rule.ip = preset.ip;
    rules.push(rule);
  }
  rules.push({ type: 'field', ip: ['geoip:private'], outboundTag: 'direct' });
  const inbounds = [
    { tag: 'socks', listen: '127.0.0.1', port: socksPort, protocol: 'socks',
      settings: { udp: true, auth: 'noauth' }, sniffing },
    { tag: 'http', listen: '127.0.0.1', port: httpPort, protocol: 'http', sniffing },
  ];
  if (tun) inbounds.unshift(buildTunInbound(sniffing));
  return {
    log: {
      loglevel: ['debug', 'info', 'warning', 'error', 'none'].includes(logLevel) ? logLevel : 'warning',
      error: logPath,
    },
    inbounds,
    outbounds: [
      buildOutbound(server),
      { tag: 'direct', protocol: 'freedom' },
      { tag: 'block', protocol: 'blackhole' },
    ],
    routing: {
      domainStrategy: 'IPIfNonMatch',
      rules,
    },
  };
}

module.exports = { buildConfig, buildOutbound, buildTunInbound };
