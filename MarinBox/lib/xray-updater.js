'use strict';
// Обновление Xray-core из приложения: релиз берётся с GitHub (XTLS/Xray-core),
// ядро кладётся в пользовательскую папку userData\core\v<версия>\ и имеет приоритет
// над вшитым в сборку бинарём.
//
// Здесь только логика (выбор вложения, версии, пути) — сеть и распаковку делает main.js.
const fs = require('fs');
const path = require('path');

const REPO = 'XTLS/Xray-core';
const API_URL = `https://api.github.com/repos/${REPO}/releases/latest`;

function assetName(platform = process.platform, arch = process.arch) {
  if (platform !== 'win32') return `Xray-${platform === 'darwin' ? 'macos' : 'linux'}-64.zip`;
  if (arch === 'arm64') return 'Xray-windows-arm64-v8a.zip';
  if (arch === 'ia32') return 'Xray-windows-32.zip';
  return 'Xray-windows-64.zip';
}

// Тег релиза вида "v26.11.9" -> "26.11.9"
function versionFromTag(tag) {
  const m = /(\d+\.\d+\.\d+)/.exec(String(tag || ''));
  return m ? m[1] : '';
}

// Релиз GitHub -> { version, url, size, notes }
function parseRelease(release) {
  if (!release || typeof release !== 'object') throw new Error('GitHub вернул некорректный ответ');
  const version = versionFromTag(release.tag_name);
  if (!version) throw new Error('В релизе Xray-core не указан тег версии');
  const wanted = assetName();
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const asset = assets.find((a) => a.name === wanted)
    || assets.find((a) => new RegExp(`windows-64\\.zip$`, 'i').test(String(a.name || '')));
  if (!asset) throw new Error(`В релизе Xray-core нет ${wanted}`);
  const url = String(asset.browser_download_url || '');
  if (!url.startsWith('https://')) throw new Error('Некорректная ссылка на архив Xray');
  return { version, url, size: Number(asset.size) || 0, notes: String(release.body || '').slice(0, 4000) };
}

// Версия из вывода "Xray 26.10.31 (Xray, ...)"
function versionFromOutput(text) {
  const m = /Xray\s+v?(\d+\.\d+\.\d+)/i.exec(String(text || ''));
  return m ? m[1] : '';
}

// Куда кладём пользовательскую версию ядра
function coreDir(userData, version) {
  return path.join(userData, 'core', `v${version}`);
}

// Установленные пользовательские версии, от свежих к старым
function listInstalledCores(userData) {
  const root = path.join(userData, 'core');
  let dirs = [];
  try { dirs = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
  return dirs
    .filter((d) => d.isDirectory() && /^v\d+\.\d+\.\d+$/.test(d.name))
    .map((d) => ({
      version: d.name.slice(1),
      dir: path.join(root, d.name),
      exe: path.join(root, d.name, process.platform === 'win32' ? 'xray.exe' : 'xray'),
    }))
    .filter((c) => fs.existsSync(c.exe))
    .sort((a, b) => {
      const pa = a.version.split('.').map(Number);
      const pb = b.version.split('.').map(Number);
      for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pb[i] - pa[i];
      return 0;
    });
}

// Свежайшая пользовательская версия (или null)
function latestInstalledCore(userData) {
  return listInstalledCores(userData)[0] || null;
}

module.exports = {
  REPO, API_URL, assetName, versionFromTag, parseRelease, versionFromOutput,
  coreDir, listInstalledCores, latestInstalledCore,
};
