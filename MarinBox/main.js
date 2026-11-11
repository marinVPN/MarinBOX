'use strict';
const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, clipboard, net: electronNet, screen, shell, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const tcp = require('net');
const { spawn, execFileSync } = require('child_process');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { parseSubscriptionBody } = require('./lib/parser');
const { buildConfig } = require('./lib/xray-config');
const { PRESETS } = require('./lib/route-presets');
const xrayUpd = require('./lib/xray-updater');
const updater = require('./lib/updater');
const sysproxy = require('./lib/sysproxy');

const PORTS = { socks: 10808, http: 10809 };
const DEFAULT_SETTINGS = { startup: false, tray: true, refresh: true, notify: true, autoUpdate: true, tun: false, routePresets: [], theme: 'dark', accent: '', pingType: 'proxy-get', healthCheck: true, healthInterval: 30, autoReconnect: true, reconnectAttempts: 5, reconnectDelay: 5, logLevel: 'warning', bypassDomains: '', bypassIps: '' };
let healthTimer = null;
let reconnectTimer = null;
let reconnectGeneration = 0;
let reconnectCount = 0;
let healthCheckBusy = false;
const PROXY_STR = `127.0.0.1:${PORTS.http}`;
const UA = 'MarinBox/1.0 (Windows)';
const ICON = path.join(__dirname, 'build', 'icon.png');
const TRAY_ICON = path.join(__dirname, 'build', 'tray@2x.png');
const APP_ID = 'com.marinvpn.marinbox';
const PKG = require('./package.json');
// Источник обновлений: 'github' (релизы GitHub) или 'custom' (свой манифест на сервере)
const UPDATE_CONFIG = {
  source: process.env.MARINBOX_UPDATE_SOURCE || (PKG.marinbox && PKG.marinbox.updateSource) || 'custom',
  repo: process.env.MARINBOX_GITHUB_REPO || (PKG.marinbox && PKG.marinbox.githubRepo) || '',
  token: process.env.GITHUB_TOKEN || '',
};
const UPDATE_MANIFEST_URL = 'https://marinvpn.best.mooo.com/api/desktop/app-update?platform=windows';
const PRESET_IDS = new Set(PRESETS.map((p) => p.id));

let win = null;
let tray = null;
let quitting = false;
let xray = null;
let xrayLog = '';
let pendingLink = null;
let store = { subs: [], selectedId: null };
let updateManifest = null;
let cabinetToken = null;
const CABINET_API = 'https://marinvpn.best.mooo.com';
let status = { state: 'disconnected', since: null, serverId: null, error: null };

// ───────────── хранилище ─────────────
const storePath = () => path.join(app.getPath('userData'), 'store.json');
const cfgPath = () => path.join(app.getPath('userData'), 'xray-config.json');
const logPath = () => path.join(app.getPath('userData'), 'xray.log');
const newId = () => crypto.randomBytes(4).toString('hex');
const settings = () => ({ ...DEFAULT_SETTINGS, ...(store.settings || {}) });

// ───────────── уведомления Windows ─────────────
function pushNotification(title, body) {
  if (settings().notify === false) return;
  if (!Notification.isSupported()) return;
  try { new Notification({ title, body, icon: ICON }).show(); } catch { /* ignore */ }
}
function cancelReconnect() {
  reconnectGeneration += 1;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  reconnectCount = 0;
}
function stopHealthMonitor() {
  if (healthTimer) clearInterval(healthTimer);
  healthTimer = null;
  healthCheckBusy = false;
}
function startHealthMonitor() {
  stopHealthMonitor();
  const cfg = settings();
  if (!cfg.healthCheck || status.state !== 'connected') return;
  let failures = 0;
  healthTimer = setInterval(async () => {
    if (healthCheckBusy || status.state !== 'connected') return;
    healthCheckBusy = true;
    try {
      if (await proxyPing('HEAD') == null) failures += 1;
      else failures = 0;
      if (failures >= 2 && status.state === 'connected') handleConnectionLoss('Проверка VPN не прошла');
    } finally { healthCheckBusy = false; }
  }, cfg.healthInterval * 1000);
}
function scheduleReconnect(id, reason) {
  const cfg = settings();
  if (!cfg.autoReconnect || !id || reconnectTimer || reconnectCount >= cfg.reconnectAttempts || quitting) return;
  reconnectCount += 1;
  const generation = reconnectGeneration;
  setStatus({ state: 'disconnected', since: null, serverId: id, error: `${reason}. Повтор ${reconnectCount}/${cfg.reconnectAttempts} через ${cfg.reconnectDelay} с` });
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    if (generation !== reconnectGeneration || quitting) return;
    try { await connect(id, { retry: true }); }
    catch (e) {
      if (generation === reconnectGeneration) scheduleReconnect(id, `Не удалось переподключиться: ${e.message}`);
    }
  }, cfg.reconnectDelay * 1000);
}
function handleConnectionLoss(reason) {
  const id = status.serverId;
  stopHealthMonitor();
  sysproxy.disableSync();
  const p = xray;
  xray = null;
  setStatus({ state: 'disconnected', since: null, serverId: id, error: reason });
  if (p) { try { p.kill(); } catch { /* ignore */ } }
  stopXrayElevated();
  pushNotification('MarinBox', `Соединение потеряно: ${reason}`);
  scheduleReconnect(id, reason);
}

function loadStore() {
  try {
    store = { ...store, ...JSON.parse(fs.readFileSync(storePath(), 'utf8')) };
  } catch {
    // Файл недоступен или повреждён (BOM, обрыв записи) — не затираем его молча,
    // а откладываем рядом, чтобы подписки можно было вытащить руками.
    try {
      if (fs.existsSync(storePath())) fs.copyFileSync(storePath(), storePath() + '.broken');
    } catch { /* ignore */ }
  }
}
function saveStore() {
  try { fs.writeFileSync(storePath(), JSON.stringify(store, null, 2)); } catch { /* ignore */ }
}

async function cabinetRequest(pathname, { method = 'GET', body } = {}) {
  const headers = { Accept: 'application/json' };
  if (cabinetToken) headers.Authorization = `Bearer ${cabinetToken}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let response;
  try {
    response = await electronNet.fetch(`${CABINET_API}${pathname}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
  } catch (error) {
    const detail = error?.message || String(error);
    throw new Error(`Не удалось связаться с сервером MarinVPN: ${detail}`);
  }
  let data;
  try { data = await response.json(); } catch { data = {}; }
  if (!response.ok) {
    const reason = data.error || `HTTP ${response.status}`;
    if (response.status >= 500) throw new Error(`${reason}. Проверьте лог бота: строку [WEBAPP ERROR] для ${pathname}.`);
    throw new Error(reason);
  }
  return data;
}
function publicState() { return { subs: store.subs, selectedId: store.selectedId, settings: settings(), status, version: updater.CURRENT_VERSION }; }
function notify() { saveStore(); send('state:changed', publicState()); }
function send(ch, payload) { if (win && !win.isDestroyed()) win.webContents.send(ch, payload); }
function findServer(id) {
  for (const s of store.subs) { const x = s.servers.find((v) => v.id === id); if (x) return x; }
  return null;
}

// ───────────── подписки ─────────────
function parseUserInfo(h) {
  if (!h) return null;
  const o = {};
  for (const part of h.split(';')) {
    const [k, v] = part.split('=').map((x) => x && x.trim());
    if (k && v !== undefined && !Number.isNaN(Number(v))) o[k] = Number(v);
  }
  return Object.keys(o).length ? o : null;
}

async function fetchSubscription(url) {
  const res = await electronNet.fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Сервер подписки ответил ${res.status}`);
  const servers = parseSubscriptionBody(await res.text());
  if (!servers.length) throw new Error('В подписке не найдено ни одного сервера');
  let name = res.headers.get('profile-title') || '';
  if (/^base64:/i.test(name)) name = Buffer.from(name.slice(7), 'base64').toString('utf8');
  if (!name) { try { name = new URL(url).hostname; } catch { name = 'Подписка'; } }
  const updateInterval = Number(res.headers.get('profile-update-interval')) || null;
  return {
    name, servers,
    userinfo: parseUserInfo(res.headers.get('subscription-userinfo')),
    updateInterval,
    updatedAt: Date.now(),
  };
}

async function addInput(text) {
  let t = String(text || '').trim();
  if (!t) throw new Error('Вставьте ссылку на подписку или ключ');
  const m = t.match(/^marinbox:\/\/add\/(.+)$/is);
  if (m) { try { t = decodeURIComponent(m[1]).trim(); } catch { t = m[1].trim(); } }

  if (/^https?:\/\/\S+$/i.test(t)) {
    const data = await fetchSubscription(t);
    const ex = store.subs.find((s) => s.url === t);
    const sub = { id: ex ? ex.id : newId(), url: t, ...data, updatedAt: Date.now() };
    if (ex) Object.assign(ex, sub); else store.subs.push(sub);
    if (!store.selectedId || !findServer(store.selectedId)) store.selectedId = sub.servers[0].id;
    return sub.id;
  }

  const servers = parseSubscriptionBody(t);
  if (!servers.length) throw new Error('Не удалось распознать ссылку');
  let man = store.subs.find((s) => s.id === 'manual');
  if (!man) {
    man = { id: 'manual', url: null, name: 'Мои ключи', servers: [], userinfo: null, updatedAt: Date.now() };
    store.subs.push(man);
  }
  for (const s of servers) if (!man.servers.some((x) => x.id === s.id)) man.servers.push(s);
  man.updatedAt = Date.now();
  if (!store.selectedId || !findServer(store.selectedId)) store.selectedId = servers[0].id;
  return 'manual';
}

async function refreshSub(id) {
  const sub = store.subs.find((s) => s.id === id);
  if (!sub || !sub.url) return;
  const data = await fetchSubscription(sub.url);
  Object.assign(sub, data, { updatedAt: Date.now() });
  if (!findServer(store.selectedId)) store.selectedId = sub.servers[0].id;
}

async function refreshAllQuiet() {
  for (const s of store.subs.filter((x) => x.url)) { try { await refreshSub(s.id); } catch { /* офлайн — ок */ } }
  notify();
}

// ───────────── пинг ─────────────
function tcpPing(host, port, timeout = 2500) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const s = tcp.connect({ host, port });
    let doneOnce = false;
    const done = (v) => { if (doneOnce) return; doneOnce = true; s.destroy(); resolve(v); };
    s.setTimeout(timeout, () => done(null));
    s.once('connect', () => done(Date.now() - t0));
    s.once('error', () => done(null));
  });
}

function proxyPing(method, timeout = 5000) {
  return new Promise((resolve) => {
    const req = electronNet.request({
      method,
      url: 'https://www.gstatic.com/generate_204',
      session: require('electron').session.defaultSession,
    });
    let settled = false;
    const timer = setTimeout(() => { req.abort(); finish(null); }, timeout);
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const started = Date.now();
    req.on('response', (res) => { res.on('data', () => {}); res.on('end', () => finish(Date.now() - started)); });
    req.on('error', () => finish(null));
    req.end();
  });
}

function icmpPing(host, timeout = 3000) {
  return new Promise((resolve) => {
    const windows = process.platform === 'win32';
    const args = windows ? ['-n', '1', '-w', String(timeout), host] : ['-c', '1', '-W', String(Math.ceil(timeout / 1000)), host];
    const child = spawn(windows ? 'ping.exe' : 'ping', args, { windowsHide: true });
    let output = '';
    const timer = setTimeout(() => { child.kill(); resolve(null); }, timeout + 500);
    child.stdout.on('data', (data) => { output = (output + data.toString()).slice(-4000); });
    child.once('error', () => { clearTimeout(timer); resolve(null); });
    child.once('close', (code) => {
      clearTimeout(timer);
      const match = output.match(/(?:time|время)[=<]\s*(\d+(?:[.,]\d+)?)\s*м?с?/i);
      resolve(code === 0 && match ? Number(match[1].replace(',', '.')) : null);
    });
  });
}

async function pingServer(server, type) {
  if (type === 'proxy-get' || type === 'proxy-head') return proxyPing(type === 'proxy-head' ? 'HEAD' : 'GET');
  if (type === 'icmp') return icmpPing(server.host);
  return tcpPing(server.host, server.port);
}

// ───────────── Xray ─────────────
// Приоритет у версии, скачанной из приложения (userData\core\v<версия>),
// вшитый в сборку бинарь — запасной вариант.
function bundledXrayPath() {
  const base = app.isPackaged ? path.join(process.resourcesPath, 'bin') : path.join(__dirname, 'bin');
  return path.join(base, process.platform === 'win32' ? 'xray.exe' : 'xray');
}
function xrayPath() {
  const user = xrayUpd.latestInstalledCore(app.getPath('userData'));
  return user ? user.exe : bundledXrayPath();
}
const lastLine = () => xrayLog.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() || '';

function startXray(bin, cfg) {
  return new Promise((resolve, reject) => {
    xrayLog = '';
    const dir = path.dirname(bin);
    const p = spawn(bin, ['run', '-config', cfg], {
      cwd: dir, windowsHide: true, env: { ...process.env, XRAY_LOCATION_ASSET: dir },
    });
    xray = p;
    let done = false;
    let timer = null;
    const finish = (err) => { if (done) return; done = true; clearTimeout(timer); err ? reject(err) : resolve(); };
    const onData = (d) => { xrayLog = (xrayLog + d.toString()).slice(-4000); if (/started/i.test(xrayLog)) finish(); };
    p.stdout.on('data', onData);
    p.stderr.on('data', onData);
    p.on('error', (e) => finish(new Error('Не удалось запустить xray: ' + e.message)));
    p.on('exit', (code) => {
      if (xray === p) xray = null;
      if (!done) return finish(new Error(lastLine() || `xray завершился (код ${code})`));
      if (status.state === 'connected') handleConnectionLoss('Соединение прервано: ' + (lastLine() || 'xray остановлен'));
    });
    timer = setTimeout(() => finish(), 2500);
  });
}

// ───────────── Xray с правами администратора (TUN) ─────────────
// TUN-инбаунду нужен Wintun, а создать адаптер может только администратор.
// Поэтому xray запускается elevated отдельным PowerShell, а MarinBox остаётся обычным.
// Управление остановкой — через файл-флаг: не-elevated процесс не может убить elevated.
let elevated = null;

const elevatedFiles = () => {
  const dir = app.getPath('userData');
  return {
    script: path.join(dir, 'run-xray-elevated.ps1'),
    stop: path.join(dir, 'xray-elevated.stop'),
    log: path.join(dir, 'xray-elevated.log'),
    err: path.join(dir, 'xray-elevated.err.log'),
  };
};

const processAlive = (pid) => {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
};

// Синхронная пауза (нужна в stopXrayElevated)
const sleepSync = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

// Экранирование строки для PowerShell
const psQuote = (value) => `'${String(value).replace(/'/g, "''")}'`;

function readTail(file, bytes = 4000) {
  try {
    const stat = fs.statSync(file);
    const start = Math.max(0, stat.size - bytes);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    return buf.toString('utf8');
  } catch { return ''; }
}

// Начало файла: там баннер Xray со словом "started"
function readHead(file, bytes = 4096) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(bytes);
    const read = fs.readSync(fd, buf, 0, bytes, 0);
    fs.closeSync(fd);
    return buf.toString('utf8', 0, read);
  } catch { return ''; }
}

function elevatedLog() {
  const f = elevatedFiles();
  return `${readTail(f.log)}\n${readTail(f.err)}`;
}

function startXrayElevated(bin, cfg) {
  return new Promise((resolve, reject) => {
    const f = elevatedFiles();
    const dir = path.dirname(bin);
    fs.writeFileSync(f.log, '');
    fs.writeFileSync(f.err, '');
    try { fs.unlinkSync(f.stop); } catch { /* нет файла — ок */ }
    // Обёртка: запускает xray, пишет вывод в лог, ждёт флага остановки
    // или смерти родителя (MarinBox), затем глушит xray.
    const script = [
      "$ErrorActionPreference = 'SilentlyContinue'",
      `$bin = ${psQuote(bin)}`,
      `$cfg = ${psQuote(cfg)}`,
      `$log = ${psQuote(f.log)}`,
      `$err = ${psQuote(f.err)}`,
      `$stop = ${psQuote(f.stop)}`,
      `$parent = ${process.pid}`,
      "if (Test-Path $stop) { Remove-Item $stop -Force }",
      `$p = Start-Process -FilePath $bin -ArgumentList @('run','-config',$cfg) -WorkingDirectory ${psQuote(dir)} -RedirectStandardOutput $log -RedirectStandardError $err -PassThru -WindowStyle Hidden`,
      "if (-not $p) { exit 1 }",
      "while ($true) {",
      "  if (Test-Path $stop) { break }",
      "  if (-not (Get-Process -Id $parent -ErrorAction SilentlyContinue)) { break }",
      "  if ($p.HasExited) { break }",
      "  Start-Sleep -Milliseconds 400",
      "}",
      "if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }",
      '',
    ].join('\r\n');
    // BOM обязателен: PowerShell 5.1 без него читает .ps1 в ANSI и ломает кириллицу в путях
    fs.writeFileSync(f.script, '\uFEFF' + script, 'utf8');

    const cmd = `Start-Process -FilePath 'powershell.exe' -Verb RunAs -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',${psQuote(f.script)} -PassThru | Select-Object -ExpandProperty Id`;
    let pid = null;
    try {
      const out = execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', cmd], { encoding: 'utf8', timeout: 120000, windowsHide: true });
      pid = Number(String(out).trim().split(/\s+/).pop());
      if (!Number.isFinite(pid) || pid <= 0) throw new Error('не удалось получить PID');
    } catch {
      reject(new Error('Нужны права администратора для TUN-режима. Подтвердите запрос UAC или запустите MarinBox от имени администратора.'));
      return;
    }
    elevated = { pid, stopFile: f.stop, log: f.log, err: f.err };
    xrayLog = '';

    const startedAt = Date.now();
    const timer = setInterval(() => {
      const log = elevatedLog();
      xrayLog = log.slice(-4000);
      // Баннер Xray печатается всегда, а строка "started" — только на уровне info.
      const head = readHead(f.log) + readHead(f.err);
      if (/started/i.test(head) || /^Xray\s+\d+\.\d+/m.test(head)) { clearInterval(timer); resolve(); return; }
      if (!processAlive(pid)) {
        clearInterval(timer);
        const err = log.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() || 'xray завершился';
        reject(new Error(err));
        return;
      }
      // как и в обычном режиме — считаем, что процесс поднялся, если он жив
      if (Date.now() - startedAt > 8000) { clearInterval(timer); resolve(); }
    }, 300);
  });
}

function stopXrayElevated() {
  if (!elevated) return;
  const { stopFile, pid } = elevated;
  elevated = null;
  try { fs.writeFileSync(stopFile, 'stop'); } catch { /* ignore */ }
  // ждём, пока обёртка убьёт xray и сама выйдет
  const deadline = Date.now() + 6000;
  while (processAlive(pid) && Date.now() < deadline) sleepSync(200);
  try { fs.unlinkSync(stopFile); } catch { /* ignore */ }
}

function setStatus(patch) {
  status = { ...status, ...patch };
  send('vpn:status', status);
  rebuildTray();
}

async function disconnect({ preserveReconnect = false } = {}) {
  stopHealthMonitor();
  if (!preserveReconnect) cancelReconnect();
  setStatus({ state: 'disconnected', since: null, error: null });
  sysproxy.disableSync();
  if (xray) { const p = xray; xray = null; try { p.kill(); } catch { /* ignore */ } }
  stopXrayElevated();
  try { fs.unlinkSync(cfgPath()); } catch { /* ignore */ }
}

async function connect(id, { retry = false } = {}) {
  if (status.state === 'connecting') return;
  if (!retry) cancelReconnect();
  const server = findServer(id);
  if (!server) throw new Error('Сервер не найден');
  if (xray || elevated || status.state === 'connected') await disconnect({ preserveReconnect: retry });
  setStatus({ state: 'connecting', serverId: id, error: null });
  try {
    const bin = xrayPath();
    if (!fs.existsSync(bin)) throw new Error('Не найден xray — запустите «npm run fetch-xray» (см. README)');
    const cfg = settings();
    const domains = String(cfg.bypassDomains || '').split(/[\s,;]+/).map((x) => x.trim().replace(/^\./, '')).filter((x) => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/i.test(x));
    const ips = String(cfg.bypassIps || '').split(/[\s,;]+/).map((x) => x.trim()).filter((x) => /^(?:\d{1,3}\.){3}\d{1,3}(?:\/\d{1,2})?$|^[0-9a-f:]+(?:\/\d{1,3})?$/i.test(x));
    fs.writeFileSync(cfgPath(), JSON.stringify(buildConfig(server, {
      ...PORTS, logLevel: cfg.logLevel, logPath: logPath(), bypassDomains: domains, bypassIps: ips,
      routePresets: cfg.routePresets || [], tun: !!cfg.tun,
    }), null, 2));
    if (cfg.tun) {
      // TUN: xray elevated, весь трафик системы в туннеле — системный прокси не нужен
      await startXrayElevated(bin, cfgPath());
      sysproxy.disableSync();
    } else {
      await startXray(bin, cfgPath());
      await sysproxy.enable(PROXY_STR);
    }
    cancelReconnect();
    setStatus({ state: 'connected', since: Date.now(), serverId: id, error: null });
    startHealthMonitor();
    pushNotification('MarinBox', retry ? `Соединение восстановлено: ${server.name}` : `Подключено: ${server.name}`);
  } catch (e) {
    await disconnect({ preserveReconnect: retry });
    setStatus({ error: e.message });
    pushNotification('MarinBox', `Не удалось подключиться: ${e.message}`);
    throw e;
  }
}

// ───────────── окно, трей, ссылки ─────────────
function showWin() { if (!win) return; if (win.isMinimized()) win.restore(); win.show(); win.focus(); }

function createWindow() {
  const cfg = settings();
  const theme = ['dark', 'light', 'system'].includes(cfg.theme) ? cfg.theme : 'dark';
  const accent = /^#[0-9a-f]{6}$/i.test(String(cfg.accent || '')) ? cfg.accent : '';
  win = new BrowserWindow({
    width: 920, height: 760, minWidth: 760, minHeight: 640,
    frame: false, backgroundColor: theme === 'light' ? '#eef1fb' : '#060a18', show: false, title: 'MarinBox',
    icon: ICON,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      // тема и акцент — до первой отрисовки, чтобы не было мигания
      additionalArguments: [`--marin-theme=${theme}`, `--marin-accent=${accent}`],
    },
  });
  win.setMenu(null);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  win.webContents.on('did-finish-load', () => {
    if (pendingLink) { const l = pendingLink; pendingLink = null; handleDeepLink(l); }
  });
  win.on('close', (e) => {
    if (quitting) return;
    if (store.settings?.tray !== false) { e.preventDefault(); win.hide(); }
    else { quitting = true; app.quit(); }
  });
}

// Значок трея: базовые 16 px, но с учётом масштаба экрана, чтобы не мылить.
function trayImage() {
  let scale = 1;
  try { scale = screen.getPrimaryDisplay().scaleFactor || 1; } catch { /* ignore */ }
  const size = Math.max(16, Math.round(16 * scale));
  return nativeImage.createFromPath(TRAY_ICON).resize({ width: size, height: size, quality: 'best' });
}

function rebuildTray() {
  if (!tray) return;
  const on = status.state === 'connected';
  tray.setToolTip(on ? 'MarinBox — подключено' : 'MarinBox');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Открыть MarinBox', click: showWin },
    {
      label: on ? 'Отключить' : 'Подключить',
      enabled: status.state !== 'connecting' && (on || !!store.selectedId),
      click: () => (on ? disconnect() : connect(store.selectedId).catch((e) => send('toast', e.message))),
    },
    { type: 'separator' },
    { label: 'Выход', click: () => { quitting = true; app.quit(); } },
  ]));
}

function handleDeepLink(link) {
  if (!win) { pendingLink = link; return; }
  addInput(link).then(() => notify()).catch((e) => send('toast', e.message));
}

function registerProtocol() {
  if (process.defaultApp) {
    if (process.argv.length >= 2) app.setAsDefaultProtocolClient('marinbox', process.execPath, [path.resolve(process.argv[1])]);
  } else {
    app.setAsDefaultProtocolClient('marinbox');
  }
}

// ───────────── автообновление ─────────────
async function fetchUpdateManifest() {
  if (UPDATE_CONFIG.source === 'github') {
    const repo = UPDATE_CONFIG.repo;
    if (!repo) throw new Error('Не указан GitHub-репозиторий (marinbox.githubRepo в package.json)');
    const headers = { Accept: 'application/vnd.github+json', 'User-Agent': `MarinBox/${updater.CURRENT_VERSION}` };
    if (UPDATE_CONFIG.token) headers.Authorization = `Bearer ${UPDATE_CONFIG.token}`;
    let res;
    try {
      res = await electronNet.fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers, signal: AbortSignal.timeout(15000) });
    } catch (error) {
      throw new Error(/abort|timeout|timed out/i.test(String(error?.message || error))
        ? 'GitHub не отвечает (таймаут)'
        : 'GitHub недоступен');
    }
    if (res.status === 404) {
      // 404 бывает и у несуществующего репозитория, и у репозитория без релизов
      try {
        const repoRes = await electronNet.fetch(`https://api.github.com/repos/${repo}`, { headers, signal: AbortSignal.timeout(10000) });
        if (repoRes.status === 404) throw new Error(`Репозиторий ${repo} не найден на GitHub`);
      } catch (error) {
        if (/не найден/.test(String(error?.message || ''))) throw error;
      }
      return null;
    }
    if (res.status === 403 || res.status === 429) throw new Error('GitHub временно ограничил запросы, попробуйте позже');
    if (!res.ok) throw new Error(`GitHub ответил ${res.status}`);
    return updater.githubManifest(await res.json());
  }
  let res;
  try {
    res = await electronNet.fetch(UPDATE_MANIFEST_URL, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
  } catch (error) {
    const text = String(error?.message || error);
    throw new Error(/abort|timeout|timed out/i.test(text)
      ? 'Сервер обновлений не отвечает (таймаут)'
      : 'Сервер обновлений недоступен');
  }
  if (res.status === 404 || res.status === 204) return null;
  if (!res.ok) throw new Error(`Сервер обновлений ответил ${res.status}`);
  return updater.normalizeManifest(await res.json());
}

// Локальный changelog из поставки приложения
function localChangelog(version = updater.CURRENT_VERSION) {
  const local = path.join(app.getAppPath(), 'CHANGELOG.md');
  if (!fs.existsSync(local)) return '';
  try { return updater.changelogSection(fs.readFileSync(local, 'utf8'), version); } catch { return ''; }
}

// Показать окно «Что нового» один раз на версию
function showChangelogOnce(version, notes) {
  if (!notes) return;
  if (store.lastShownVersion === version) return;
  store.lastShownVersion = version;
  saveStore();
  send('changelog:show', { version, notes });
}

async function checkUpdatesInBackground() {
  if (settings().autoUpdate === false) return;
  const current = updater.CURRENT_VERSION;
  let manifest = null;
  try { manifest = await fetchUpdateManifest(); } catch { /* сервер недоступен — тихо */ }
  if (manifest) {
    if (manifest.version === current) {
      showChangelogOnce(current, manifest.notes || localChangelog(current));
      return;
    }
    if (updater.isNewer(manifest.version, current)) {
      updateManifest = manifest;
      send('update:available', { current, ...manifest });
      pushNotification('MarinBox', `Доступно обновление ${manifest.version}. Скачать — в настройках.`);
      return;
    }
  }
  // Сервер недоступен — показываем changelog из поставки
  showChangelogOnce(current, localChangelog(current));
}

// Проверка обновлений по расписанию, а не только при запуске
function scheduleUpdateChecks() {
  const timer = setInterval(checkUpdatesInBackground, 6 * 60 * 60 * 1000);
  if (timer.unref) timer.unref();
}

// ───────────── обновление Xray-core ─────────────
function xrayVersion(bin) {
  try {
    const out = execFileSync(bin, ['version'], { encoding: 'utf8', timeout: 15000, windowsHide: true });
    return xrayUpd.versionFromOutput(out);
  } catch { return ''; }
}

async function fetchXrayRelease() {
  const res = await electronNet.fetch(xrayUpd.API_URL, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': `MarinBox/${updater.CURRENT_VERSION}` },
    signal: AbortSignal.timeout(20000),
  });
  if (res.status === 404) throw new Error('Релизы Xray-core не найдены');
  if (!res.ok) throw new Error(`GitHub ответил ${res.status}`);
  return xrayUpd.parseRelease(await res.json());
}

// Скачивает архив, распаковывает в userData\core\v<версия> и проверяет, что ядро запускается
async function installXrayCore() {
  const release = await fetchXrayRelease();
  const userData = app.getPath('userData');
  const exeName = process.platform === 'win32' ? 'xray.exe' : 'xray';
  const dir = xrayUpd.coreDir(userData, release.version);
  const target = path.join(dir, exeName);
  if (fs.existsSync(target)) return { version: release.version, dir, already: true };

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xray-core-'));
  const zip = path.join(tmp, 'xray.zip');
  try {
    const res = await electronNet.fetch(release.url, { signal: AbortSignal.timeout(900000) });
    if (!res.ok) throw new Error(`Не удалось скачать Xray: HTTP ${res.status}`);
    const total = Number(res.headers.get('content-length')) || release.size || 0;
    let received = 0;
    const counter = new Transform({
      transform(chunk, _enc, cb) {
        received += chunk.length;
        send('update:progress', { received, total, what: 'xray' });
        cb(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(res.body), counter, fs.createWriteStream(zip));

    const out = path.join(tmp, 'out');
    fs.mkdirSync(out, { recursive: true });
    if (process.platform === 'win32') {
      execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
        `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${out.replace(/'/g, "''")}' -Force`],
      { timeout: 120000, windowsHide: true });
    } else {
      execFileSync('unzip', ['-o', zip, '-d', out], { timeout: 120000 });
    }

    fs.mkdirSync(dir, { recursive: true });
    for (const name of [exeName, 'geoip.dat', 'geosite.dat']) {
      const src = path.join(out, name);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, name));
    }
    if (!fs.existsSync(target)) throw new Error('В архиве нет исполняемого файла xray');
    const version = xrayVersion(target);
    if (!version) throw new Error('Скачанное ядро не запускается');
    return { version, dir };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// Оставляем только две последние версии ядра
function pruneOldCores(keep = 2) {
  const list = xrayUpd.listInstalledCores(app.getPath('userData'));
  for (const old of list.slice(keep)) {
    try { fs.rmSync(old.dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// ───────────── IPC ─────────────
const handle = (ch, fn) => ipcMain.handle(ch, async (_e, ...a) => {
  try { return { ok: true, data: await fn(...a) }; } catch (e) { return { ok: false, error: e.message || String(e) }; }
});

function setupIpc() {
  handle('state:get', async () => publicState());
  handle('cabinet:login-start', async () => cabinetRequest('/api/desktop/login/start', { method: 'POST', body: {} }));
  handle('cabinet:login-exchange', async (code) => {
    const result = await cabinetRequest('/api/desktop/login/exchange', { method: 'POST', body: { code: String(code || '').trim() } });
    if (!result.token) throw new Error('Сервер не вернул токен сессии');
    cabinetToken = result.token;
    store.cabinetToken = cabinetToken;
    saveStore();
    return cabinetRequest('/api/desktop/status');
  });
  handle('cabinet:get', async () => {
    if (!cabinetToken) throw new Error('Подключите аккаунт MarinVPN через Telegram-бота');
    try { return await cabinetRequest('/api/desktop/status'); }
    catch (error) {
      if (/401|authorization/i.test(error.message)) { cabinetToken = null; delete store.cabinetToken; saveStore(); }
      throw error;
    }
  });
  handle('cabinet:action', async (action, payload = {}) => {
    if (!cabinetToken) throw new Error('Сначала подключите аккаунт MarinVPN');
    const actions = {
      payments: ['/api/payments', 'GET'],
      subscriptionStatus: ['/api/subscription/status', 'GET'],
      referral: ['/api/referral', 'POST'],
      dailyBonus: ['/api/daily-bonus', 'POST'],
      trial: ['/api/trial', 'POST'],
      promo: ['/api/promo', 'POST'],
      reissue: ['/api/subscription/reissue', 'POST'],
      rename: ['/api/subscription/rename', 'POST'],
      payment: ['/api/payment', 'POST'],
      paymentStatus: ['/api/payment/status', 'POST'],
      topup: ['/api/topup', 'POST'],
    };
    const spec = actions[action];
    if (!spec) throw new Error('Неизвестное действие кабинета');
    const result = await cabinetRequest(spec[0], { method: spec[1], body: spec[1] === 'POST' ? payload : undefined });
    if ((action === 'payment' || action === 'topup') && result.url) {
      const paymentUrl = new URL(result.url);
      if (paymentUrl.protocol !== 'https:') throw new Error('Платёжная ссылка должна использовать HTTPS');
      await shell.openExternal(paymentUrl.toString());
    }
    return result;
  });
  handle('external:open', async (target) => {
    let url;
    try { url = new URL(String(target || '')); } catch { throw new Error('Некорректная ссылка'); }
    if (url.protocol !== 'https:' || !['t.me', 'telegram.me'].includes(url.hostname)) throw new Error('Разрешены только ссылки Telegram по HTTPS');
    await shell.openExternal(url.toString());
    return true;
  });
  handle('cabinet:logout', async () => {
    try { if (cabinetToken) await cabinetRequest('/api/desktop/login/revoke', { method: 'POST', body: {} }); }
    finally { cabinetToken = null; delete store.cabinetToken; saveStore(); }
    return true;
  });
  handle('settings:save', async (settings) => {
    const pingTypes = ['proxy-get', 'proxy-head', 'tcp', 'icmp'];
    const bounded = (value, fallback, min, max) => Math.min(max, Math.max(min, Number.isFinite(Number(value)) ? Math.round(Number(value)) : fallback));
    const allowed = {
      ...DEFAULT_SETTINGS,
      startup: !!settings?.startup,
      tray: !!settings?.tray,
      refresh: !!settings?.refresh,
      notify: settings?.notify !== false,
      autoUpdate: settings?.autoUpdate !== false,
      tun: !!settings?.tun,
      theme: ['dark', 'light', 'system'].includes(settings?.theme) ? settings.theme : 'dark',
      accent: /^#[0-9a-f]{6}$/i.test(String(settings?.accent || '')) ? String(settings.accent).toLowerCase() : '',
      routePresets: Array.isArray(settings?.routePresets)
        ? settings.routePresets.filter((id) => PRESET_IDS.has(id)).slice(0, PRESET_IDS.size)
        : [],
      pingType: pingTypes.includes(settings?.pingType) ? settings.pingType : 'proxy-get',
      healthCheck: settings?.healthCheck !== false,
      healthInterval: bounded(settings?.healthInterval, DEFAULT_SETTINGS.healthInterval, 10, 600),
      autoReconnect: settings?.autoReconnect !== false,
      reconnectAttempts: bounded(settings?.reconnectAttempts, DEFAULT_SETTINGS.reconnectAttempts, 1, 20),
      reconnectDelay: bounded(settings?.reconnectDelay, DEFAULT_SETTINGS.reconnectDelay, 1, 120),
      logLevel: ['debug', 'info', 'warning', 'error', 'none'].includes(settings?.logLevel) ? settings.logLevel : 'warning',
      bypassDomains: String(settings?.bypassDomains || '').slice(0, 4000),
      bypassIps: String(settings?.bypassIps || '').slice(0, 4000),
    };
    const tunChanged = !!store.settings?.tun !== allowed.tun;
    store.settings = allowed;
    app.setLoginItemSettings({ openAtLogin: allowed.startup });
    if (status.state === 'connected') startHealthMonitor();
    notify();
    // Режим туннеля меняется только при переподключении
    if (tunChanged && status.state === 'connected') {
      const id = status.serverId || store.selectedId;
      disconnect().then(() => connect(id)).catch((e) => send('toast', e.message));
    }
    return allowed;
  });
  handle('sub:add', async (text) => { const id = await addInput(text); notify(); return id; });
  handle('sub:refresh', async (id) => { await refreshSub(id); notify(); });
  handle('sub:remove', async (id) => {
    const sub = store.subs.find((s) => s.id === id);
    if (sub && sub.servers.some((s) => s.id === status.serverId) && status.state !== 'disconnected') await disconnect();
    store.subs = store.subs.filter((s) => s.id !== id);
    if (!findServer(store.selectedId)) store.selectedId = (store.subs[0] && store.subs[0].servers[0] || {}).id || null;
    notify();
  });
  handle('server:select', async (id) => { if (findServer(id)) { store.selectedId = id; notify(); } });
  handle('ping:all', async (subId, requestedType) => {
    const sub = store.subs.find((s) => s.id === subId);
    const type = ['proxy-get', 'proxy-head', 'tcp', 'icmp'].includes(requestedType)
      ? requestedType : (store.settings?.pingType || 'proxy-get');
    const out = {};
    if (sub) await Promise.all(sub.servers.map(async (s) => { out[s.id] = await pingServer(s, type); }));
    return out;
  });
  handle('vpn:connect', async (id) => connect(id));
  handle('vpn:disconnect', async () => disconnect());
  handle('clipboard:read', async () => clipboard.readText());
  handle('clipboard:write', async (value) => { clipboard.writeText(String(value || '').slice(0, 10000)); return true; });
  handle('log:open', async () => {
    if (!fs.existsSync(logPath())) fs.writeFileSync(logPath(), 'Xray log is empty.\n');
    const error = await shell.openPath(logPath());
    if (error) throw new Error(error);
    return true;
  });
  handle('route:presets', async () => PRESETS.map(({ id, label, hint }) => ({ id, label, hint })));
  handle('xray:check', async () => {
    const current = xrayVersion(xrayPath());
    const release = await fetchXrayRelease();
    const hasUpdate = updater.compareVersions(release.version, current) > 0;
    return { current, latest: release.version, hasUpdate, notes: release.notes, size: release.size };
  });
  handle('xray:update', async () => {
    const result = await installXrayCore();
    pruneOldCores();
    // если VPN был подключён — перезапускаем с новым ядром
    if (status.state === 'connected') {
      const id = status.serverId || store.selectedId;
      await disconnect();
      await connect(id).catch((e) => send('toast', e.message));
    }
    return result;
  });
  handle('changelog:get', async () => {
    const current = updater.CURRENT_VERSION;
    // Сначала локальный CHANGELOG.md — он есть в приложении, поэтому окно открывается мгновенно
    let notes = localChangelog(current);
    if (!notes) {
      try {
        const manifest = await fetchUpdateManifest();
        if (manifest && manifest.version === current) notes = manifest.notes || '';
      } catch { /* сервер недоступен — пусто */ }
    }
    return { version: current, notes };
  });
  handle('update:check', async () => {
    const current = updater.CURRENT_VERSION;
    const manifest = await fetchUpdateManifest();
    if (!manifest) return { current, hasUpdate: false, latest: current, notes: '' };
    const hasUpdate = updater.isNewer(manifest.version, current);
    if (hasUpdate) updateManifest = manifest;
    return { current, hasUpdate, ...manifest };
  });
  handle('update:download', async () => {
    const manifest = updateManifest || await fetchUpdateManifest();
    if (!manifest) throw new Error('Сервер обновлений не нашёл релиз');
    if (!updater.isNewer(manifest.version, updater.CURRENT_VERSION)) throw new Error('Уже установлена свежая версия');
    const dir = path.join(app.getPath('userData'), 'updates');
    fs.mkdirSync(dir, { recursive: true });
    const dest = updater.installerPath(app.getPath('userData'), manifest.version);
    const res = await electronNet.fetch(manifest.url, { signal: AbortSignal.timeout(900000) });
    if (!res.ok) throw new Error(`Не удалось скачать обновление: HTTP ${res.status}`);
    const total = Number(res.headers.get('content-length')) || manifest.size || 0;
    let received = 0;
    const counter = new Transform({
      transform(chunk, _enc, cb) {
        received += chunk.length;
        send('update:progress', { received, total });
        cb(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(res.body), counter, fs.createWriteStream(dest));
    return { path: dest, version: manifest.version, size: received };
  });
  handle('update:install', async (filePath) => {
    const target = String(filePath || '');
    if (!target || !fs.existsSync(target)) throw new Error('Файл установщика не найден');
    await disconnect();
    quitting = true;
    const child = spawn(target, ['/S'], { detached: true, stdio: 'ignore' });
    child.unref();
    setTimeout(() => app.quit(), 800);
    return true;
  });

  ipcMain.on('win:min', () => win && win.minimize());
  ipcMain.on('win:hide', () => win && win.hide());
}

// ───────────── запуск ─────────────
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    showWin();
    const l = argv.find((a) => /^marinbox:/i.test(a));
    if (l) handleDeepLink(l);
  });

  app.whenReady().then(async () => {
    app.setAppUserModelId(APP_ID);
    registerProtocol();
    loadStore();
    cabinetToken = typeof store.cabinetToken === 'string' ? store.cabinetToken : null;
    setupIpc();
    await sysproxy.cleanupStale(PROXY_STR);
    pendingLink = process.argv.find((a) => /^marinbox:/i.test(a)) || null;
    createWindow();
    tray = new Tray(trayImage());
    tray.on('click', showWin);
    rebuildTray();
    app.setLoginItemSettings({ openAtLogin: !!(store.settings && store.settings.startup) });
    if (!store.settings || store.settings.refresh !== false) refreshAllQuiet();
    checkUpdatesInBackground();
    scheduleUpdateChecks();
  });

  app.on('before-quit', () => {
    quitting = true;
    stopHealthMonitor();
    cancelReconnect();
    sysproxy.disableSync();
    if (xray) { try { xray.kill(); } catch { /* ignore */ } }
    stopXrayElevated();
    try { fs.unlinkSync(cfgPath()); } catch { /* ignore */ }
  });

  app.on('window-all-closed', () => { /* живём в трее */ });
}
