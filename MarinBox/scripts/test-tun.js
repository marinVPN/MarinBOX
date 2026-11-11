// Дымовой тест TUN-инбаунда (запуск из папки MarinBox): node scripts/test-tun.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { buildTunInbound } = require('../lib/xray-config');

const root = path.join(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marinbox-tun-'));
const cfgPath = path.join(dir, 'config.json');
const logPath = path.join(dir, 'xray.log');
const sniffing = { enabled: true, destOverride: ['http', 'tls', 'quic'] };

const dnsServers = process.argv.slice(2);
const tun = buildTunInbound(sniffing);
if (dnsServers.length) tun.settings.dns = dnsServers;

const cfg = {
  log: { loglevel: 'info', error: logPath },
  inbounds: [
    tun,
    { tag: 'socks', listen: '127.0.0.1', port: 10898, protocol: 'socks', settings: { udp: true, auth: 'noauth' }, sniffing },
    { tag: 'http', listen: '127.0.0.1', port: 10897, protocol: 'http', sniffing },
  ],
  outbounds: [{ protocol: 'freedom', tag: 'direct' }],
  routing: { domainStrategy: 'IPIfNonMatch', rules: [{ type: 'field', ip: ['geoip:private'], outboundTag: 'direct' }] },
};
fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

const bin = path.join(root, 'bin', process.platform === 'win32' ? 'xray.exe' : 'xray');
const out = fs.openSync(logPath, 'w');
const child = spawn(bin, ['run', '-config', cfgPath], {
  cwd: path.join(root, 'bin'),
  windowsHide: true,
  env: { ...process.env, XRAY_LOCATION_ASSET: path.join(root, 'bin') },
  stdio: ['ignore', out, out],
});
console.log('xray pid:', child.pid, 'dns:', tun.settings.dns.join(','));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ps = (cmd) => {
  try { return execFileSync('powershell.exe', ['-NoProfile', '-Command', cmd], { encoding: 'utf8', timeout: 20000 }).trim(); }
  catch (e) { return 'ERR: ' + (e.stderr || e.message).toString().slice(0, 200); }
};

(async () => {
  await sleep(6000);
  console.log('\n--- лог xray (хвост) ---');
  console.log(fs.readFileSync(logPath, 'utf8').split(/\r?\n/).filter((l) => /192\.168\.1\.1:53|dns|error|fail|closed/i.test(l)).slice(-25).join('\n'));
  console.log('\n--- адаптер ---');
  console.log(ps("Get-NetAdapter | Where-Object { $_.InterfaceDescription -like '*MarinVPN*' } | Format-Table Name, InterfaceDescription, Status, ifIndex -AutoSize | Out-String"));
  console.log('--- маршрут по умолчанию ---');
  console.log(ps("Get-NetRoute -DestinationPrefix '0.0.0.0/0' | Format-Table ifIndex, NextHop, InterfaceAlias -AutoSize | Out-String"));
  console.log('--- интернет (обычный, через TUN) ---');
  console.log(ps("try { (Invoke-WebRequest -Uri 'https://api.ipify.org' -TimeoutSec 15 -UseBasicParsing).Content } catch { 'ERR: ' + $_.Exception.Message.Split([char]10)[0] }"));
  console.log('--- интернет (через локальный прокси xray) ---');
  console.log(ps("try { (Invoke-WebRequest -Uri 'https://api.ipify.org' -TimeoutSec 15 -Proxy 'http://127.0.0.1:10897' -UseBasicParsing).Content } catch { 'ERR: ' + $_.Exception.Message.Split([char]10)[0] }"));

  console.log('\n--- останавливаем xray ---');
  child.kill('SIGTERM');
  await sleep(4000);
  console.log('маршруты после остановки:');
  console.log(ps("Get-NetRoute -DestinationPrefix '0.0.0.0/0' | Format-Table ifIndex, NextHop, InterfaceAlias -AutoSize | Out-String"));
  console.log('интернет после остановки:');
  console.log(ps("try { (Invoke-WebRequest -Uri 'https://api.ipify.org' -TimeoutSec 15 -UseBasicParsing).Content } catch { 'ERR: ' + $_.Exception.Message.Split([char]10)[0] }"));
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(0);
})();
