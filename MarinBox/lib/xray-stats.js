'use strict';
// Живая статистика Xray через его gRPC API (HandlerService/QueryStats).
// Свой минимальный клиент: node:http2 + protobuf вручную — без grpc-пакетов.
//
// В конфиге Xray должно быть:
//   "api": { "tag": "api", "services": ["HandlerService"] },
//   "stats": {},
//   "policy": { "system": { "statsOutboundUplink": true, "statsOutboundDownlink": true } },
//   плюс inbound с тегом "api" и протоколом "grpc".

const http2 = require('http2');

const API_HOST = '127.0.0.1';
const API_PORT = 10000;

// ── protobuf: нам нужно только два сообщения ──

function varint(value) {
  const bytes = [];
  let v = BigInt(value);
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) byte |= 0x80;
    bytes.push(byte);
  } while (v > 0n);
  return Buffer.from(bytes);
}

function readVarint(buf, pos) {
  let result = 0n;
  let shift = 0n;
  let byte;
  do {
    byte = buf[pos++];
    result |= BigInt(byte & 0x7f) << shift;
    shift += 7n;
  } while (byte & 0x80);
  return [result, pos];
}

// QueryStatsRequest { repeated string pattern = 1; bool reset = 2; }
function encodeQueryStats(patterns, reset = false) {
  const parts = [];
  for (const p of patterns) parts.push(Buffer.concat([Buffer.from([0x0a]), varint(Buffer.byteLength(p)), Buffer.from(p, 'utf8')]));
  if (reset) parts.push(Buffer.from([0x10, 0x01]));
  return Buffer.concat(parts);
}

// Stat { string name = 1; int64 value = 2; }
function decodeStats(buf) {
  const out = [];
  let pos = 0;
  while (pos < buf.length) {
    let tag;
    [tag, pos] = readVarint(buf, pos);
    const field = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    if (wire !== 2) break;
    let len;
    [len, pos] = readVarint(buf, pos);
    const end = pos + Number(len);
    let name = '';
    let value = 0n;
    while (pos < end) {
      let t;
      [t, pos] = readVarint(buf, pos);
      const f = Number(t >> 3n);
      const w = Number(t & 7n);
      if (f === 1 && w === 2) {
        let l;
        [l, pos] = readVarint(buf, pos);
        name = buf.toString('utf8', pos, pos + Number(l));
        pos += Number(l);
      } else if (f === 2 && w === 0) {
        [value, pos] = readVarint(buf, pos);
      } else if (w === 2) {
        let l;
        [l, pos] = readVarint(buf, pos);
        pos += Number(l);
      } else break;
    }
    pos = end;
    out.push({ name, value: Number(value) });
  }
  return out;
}

function grpcFrame(payload) {
  const head = Buffer.alloc(5);
  head[0] = 0; // без сжатия
  head.writeUInt32BE(payload.length, 1);
  return Buffer.concat([head, payload]);
}

function parseGrpcFrames(buf) {
  const messages = [];
  let pos = 0;
  while (pos + 5 <= buf.length) {
    const len = buf.readUInt32BE(pos + 1);
    const body = buf.subarray(pos + 5, pos + 5 + len);
    messages.push(body);
    pos += 5 + len;
  }
  return messages;
}

// Запрос статистики. Возвращает { 'outbound>>>proxy>>>traffic>>>uplink': 123, ... }
function queryStats(patterns, { host = API_HOST, port = API_PORT, timeout = 5000, service = 'xray.app.stats.command.StatsService' } = {}) {
  return new Promise((resolve, reject) => {
    const client = http2.connect(`http://${host}:${port}`);
    let done = false;
    const finish = (err, data) => {
      if (done) return;
      done = true;
      try { client.close(); } catch { /* ignore */ }
      err ? reject(err) : resolve(data);
    };
    const timer = setTimeout(() => finish(new Error('таймаут запроса статистики')), timeout);
    client.on('error', (e) => { clearTimeout(timer); finish(e); });
    const req = client.request({
      ':method': 'POST',
      ':path': `/${service}/QueryStats`,
      ':authority': `${host}:${port}`,
      'content-type': 'application/grpc+proto',
      te: 'trailers',
      'grpc-accept-encoding': 'identity',
    });
    const chunks = [];
    req.on('response', (headers) => {
      if (headers['grpc-status'] && headers['grpc-status'] !== '0') {
        clearTimeout(timer);
        finish(new Error('gRPC ошибка: ' + headers['grpc-message']));
      }
    });
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('error', (e) => { clearTimeout(timer); finish(e); });
    req.on('end', () => {
      clearTimeout(timer);
      try {
        const frames = parseGrpcFrames(Buffer.concat(chunks));
        const stats = frames.length ? decodeStats(frames[0]) : [];
        const map = {};
        for (const s of stats) map[s.name] = s.value;
        finish(null, map);
      } catch (e) { finish(e); }
    });
    req.end(grpcFrame(encodeQueryStats(patterns)));
  });
}

// Разбор имени статистики: outbound>>>proxy>>>traffic>>>uplink
function parseStatName(name) {
  const parts = name.split('>>>');
  return {
    kind: parts[0],          // inbound / outbound
    tag: parts[1],            // тег outbound
    metric: parts[2],         // traffic
    direction: parts[3],      // uplink / downlink
  };
}

module.exports = { queryStats, parseStatName, encodeQueryStats, decodeStats, API_HOST, API_PORT };
