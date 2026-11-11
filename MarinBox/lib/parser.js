'use strict';
const crypto = require('crypto');

function b64(s) {
  s = String(s).replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64').toString('utf8');
}
const dec = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
const mkId = (raw) => crypto.createHash('sha1').update(raw).digest('hex').slice(0, 10);
const unbracket = (h) => h.replace(/^\[|\]$/g, '');
const truthy = (v) => v === '1' || v === 'true';

function stream(q) {
  return {
    network: q.type || 'tcp',
    security: q.security || 'none',
    sni: q.sni || q.peer,
    fp: q.fp,
    alpn: q.alpn,
    pbk: q.pbk,
    sid: q.sid,
    spx: q.spx,
    path: q.path,
    host: q.host,
    serviceName: q.serviceName,
    mode: q.mode,
    headerType: q.headerType,
    allowInsecure: truthy(q.allowInsecure) || truthy(q.insecure),
  };
}

function parseUrlLike(link) {
  const u = new URL(link);
  const host = unbracket(u.hostname);
  const port = Number(u.port) || 443;
  if (!host) throw new Error('пустой адрес сервера');
  const name = dec(u.hash.replace(/^#/, '')) || `${host}:${port}`;
  return { u, q: Object.fromEntries(u.searchParams), host, port, name };
}

function parseVless(link) {
  const { u, q, host, port, name } = parseUrlLike(link);
  return {
    protocol: 'vless', name, host, port,
    params: { id: dec(u.username), encryption: q.encryption || 'none', flow: q.flow, ...stream(q) },
  };
}

function parseTrojan(link) {
  const { u, q, host, port, name } = parseUrlLike(link);
  return {
    protocol: 'trojan', name, host, port,
    params: { password: dec(u.username), ...stream({ security: 'tls', ...q }) },
  };
}

function parseVmess(link) {
  const j = JSON.parse(b64(link.slice('vmess://'.length)));
  const port = Number(j.port);
  return {
    protocol: 'vmess',
    name: j.ps || `${j.add}:${port}`,
    host: j.add,
    port,
    params: {
      id: j.id, aid: Number(j.aid || 0), scy: j.scy || 'auto',
      network: j.net || 'tcp', security: j.tls === 'tls' ? 'tls' : 'none',
      sni: j.sni || j.host, fp: j.fp, alpn: j.alpn,
      path: j.path, host: j.host, serviceName: j.path, headerType: j.type,
      allowInsecure: false,
    },
  };
}

function parseSS(link) {
  let rest = link.slice('ss://'.length);
  let name = '';
  const h = rest.indexOf('#');
  if (h >= 0) { name = dec(rest.slice(h + 1)); rest = rest.slice(0, h); }
  const qi = rest.indexOf('?');
  if (qi >= 0) rest = rest.slice(0, qi);

  let userinfo, hostport;
  if (rest.includes('@')) {
    const at = rest.lastIndexOf('@');
    userinfo = rest.slice(0, at);
    hostport = rest.slice(at + 1);
    userinfo = userinfo.includes(':') ? dec(userinfo) : b64(dec(userinfo));
  } else {
    const d = b64(rest);
    const at = d.lastIndexOf('@');
    userinfo = d.slice(0, at);
    hostport = d.slice(at + 1);
  }
  const ci = userinfo.indexOf(':');
  const method = userinfo.slice(0, ci);
  const password = userinfo.slice(ci + 1);
  const pi = hostport.lastIndexOf(':');
  const host = unbracket(hostport.slice(0, pi));
  const port = Number(hostport.slice(pi + 1));
  if (!method || !host || !port) throw new Error('битая ss:// ссылка');
  return {
    protocol: 'shadowsocks', name: name || `${host}:${port}`, host, port,
    params: { method, password, network: 'tcp', security: 'none' },
  };
}

function parseLink(raw) {
  const link = String(raw).trim();
  let s;
  if (/^vless:\/\//i.test(link)) s = parseVless(link);
  else if (/^vmess:\/\//i.test(link)) s = parseVmess(link);
  else if (/^trojan:\/\//i.test(link)) s = parseTrojan(link);
  else if (/^ss:\/\//i.test(link)) s = parseSS(link);
  else throw new Error('неизвестный протокол');
  return { id: mkId(link), ...s, raw: link };
}

// Тело подписки: либо base64 от списка ссылок, либо сами ссылки построчно.
function parseSubscriptionBody(text) {
  let t = String(text).trim();
  if (!/:\/\//.test(t)) {
    try { t = b64(t); } catch { /* оставляем как есть */ }
  }
  const seen = new Set();
  const out = [];
  for (const line of t.split(/\r?\n/)) {
    const l = line.trim();
    if (!l) continue;
    try {
      const s = parseLink(l);
      if (!seen.has(s.id)) { seen.add(s.id); out.push(s); }
    } catch { /* пропускаем непонятные строки */ }
  }
  return out;
}

module.exports = { parseLink, parseSubscriptionBody };
