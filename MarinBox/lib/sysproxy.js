'use strict';
// Включение/выключение системного прокси Windows (реестр + уведомление WinINet).
const { execFile, execFileSync } = require('child_process');

const WIN = process.platform === 'win32';
const KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
const OVERRIDE = 'localhost;127.*;10.*;172.16.*;172.17.*;172.18.*;172.19.*;172.2*;172.30.*;172.31.*;192.168.*;<local>';
const REFRESH = [
  '-NoProfile', '-NonInteractive', '-Command',
  "$s='[DllImport(\"wininet.dll\")] public static extern bool InternetSetOption(IntPtr h,int o,IntPtr b,int l);';" +
  '$t=Add-Type -MemberDefinition $s -Name W -Namespace N -PassThru;' +
  '$t::InternetSetOption([IntPtr]::Zero,39,[IntPtr]::Zero,0)|Out-Null;' +
  '$t::InternetSetOption([IntPtr]::Zero,37,[IntPtr]::Zero,0)|Out-Null',
];

let active = false;
let ours = null;
let prev = null;

const reg = (args) => new Promise((res, rej) =>
  execFile('reg', args, { windowsHide: true }, (e, out) => (e ? rej(e) : res(out))));
const regSync = (args) => execFileSync('reg', args, { windowsHide: true, stdio: 'pipe' });

async function query(name) {
  try {
    const out = await reg(['query', KEY, '/v', name]);
    const m = out.match(new RegExp(name + '\\s+REG_\\w+\\s+(.*)'));
    return m ? m[1].trim() : null;
  } catch { return null; }
}

function refreshSync() {
  try { execFileSync('powershell', REFRESH, { windowsHide: true, stdio: 'pipe', timeout: 8000 }); } catch { /* не критично */ }
}

async function enable(server) {
  if (!WIN) return;
  if (!prev) {
    prev = {
      enable: await query('ProxyEnable'),
      server: await query('ProxyServer'),
      override: await query('ProxyOverride'),
    };
  }
  ours = server;
  await reg(['add', KEY, '/v', 'ProxyServer', '/t', 'REG_SZ', '/d', server, '/f']);
  await reg(['add', KEY, '/v', 'ProxyOverride', '/t', 'REG_SZ', '/d', OVERRIDE, '/f']);
  await reg(['add', KEY, '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', '1', '/f']);
  active = true;
  await new Promise((res) => execFile('powershell', REFRESH, { windowsHide: true, timeout: 8000 }, () => res()));
}

function disableSync() {
  if (!WIN || !active) return;
  const restore = prev && prev.enable === '0x1' && prev.server && prev.server !== ours;
  try {
    if (restore) {
      regSync(['add', KEY, '/v', 'ProxyServer', '/t', 'REG_SZ', '/d', prev.server, '/f']);
      if (prev.override) regSync(['add', KEY, '/v', 'ProxyOverride', '/t', 'REG_SZ', '/d', prev.override, '/f']);
      regSync(['add', KEY, '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', '1', '/f']);
    } else {
      regSync(['add', KEY, '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', '0', '/f']);
    }
  } catch { /* ignore */ }
  refreshSync();
  active = false;
  prev = null;
}

// Если прошлый запуск упал и оставил наш прокси включённым — выключаем.
async function cleanupStale(serverStr) {
  if (!WIN) return;
  const en = await query('ProxyEnable');
  const sv = await query('ProxyServer');
  if (en === '0x1' && sv === serverStr) {
    active = true; ours = serverStr; prev = null;
    disableSync();
  }
}

module.exports = { enable, disableSync, cleanupStale };
