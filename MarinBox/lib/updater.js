'use strict';
// Логика автообновления: сравнение версий и проверка манифеста релиза.
// Сетевые вызовы и загрузку файла делает main.js (там есть electron.net).

const path = require('path');

const CURRENT_VERSION = require('../package.json').version;

function parseVersion(value) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(value || ''));
  return m ? { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) } : null;
}

// -1 — a меньше b, 0 — равны, 1 — a новее b
function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return 0;
  for (const key of ['major', 'minor', 'patch']) {
    if (x[key] !== y[key]) return x[key] > y[key] ? 1 : -1;
  }
  return 0;
}

function isNewer(remote, local = CURRENT_VERSION) {
  return compareVersions(remote, local) > 0;
}

// Приводит ответ сервера к безопасному виду: только https-ссылка и обязательные поля.
function normalizeManifest(data) {
  if (!data || typeof data !== 'object') throw new Error('Сервер обновлений вернул некорректный ответ');
  const version = String(data.version || '').trim();
  if (!parseVersion(version)) throw new Error('Сервер обновлений не указал версию');
  const url = String(data.url || '').trim();
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('Сервер обновлений не указал ссылку на установщик'); }
  if (parsed.protocol !== 'https:') throw new Error('Ссылка на обновление должна быть по HTTPS');
  return {
    version,
    url,
    notes: String(data.notes || '').slice(0, 4000),
    mandatory: !!data.mandatory,
    sha256: /^[a-f0-9]{64}$/i.test(String(data.sha256 || '')) ? String(data.sha256).toLowerCase() : '',
    size: Number.isFinite(Number(data.size)) ? Number(data.size) : 0,
    publishedAt: String(data.publishedAt || '').slice(0, 40),
  };
}

// Куда класть скачанный установщик
function installerPath(userData, version) {
  return path.join(userData, 'updates', `MarinBox-Setup-${version}.exe`);
}

// Раздел CHANGELOG.md для конкретной версии: "## 1.2.0 — 01.11.2026" + строки под ним
function changelogSection(markdown, version) {
  const text = String(markdown || '').replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  const wanted = String(version).trim();
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = /^#{2,3}\s+v?(\d+\.\d+\.\d+)/.exec(lines[i].trim());
    if (m && m[1] === wanted) { start = i; break; }
  }
  if (start < 0) return '';
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{2,3}\s/.test(lines[i].trim())) break;
    out.push(lines[i]);
  }
  return out.join('\n').trim();
}

// Релиз GitHub -> наш манифест.
// Тег релиза = версия ("v1.0.1"), текст релиза = changelog, вложение = установщик.
function githubManifest(data) {
  if (!data || typeof data !== 'object') throw new Error('GitHub вернул некорректный ответ');
  const tag = String(data.tag_name || '').trim();
  const version = parseVersion(tag) ? tag.replace(/^v/i, '') : '';
  if (!version) throw new Error('В релизе GitHub не указан тег версии');
  const assets = Array.isArray(data.assets) ? data.assets : [];
  const exes = assets.filter((a) => /\.exe$/i.test(String(a.name || '')));
  const installer = exes.find((a) => !/portable|blockmap/i.test(String(a.name || ''))) || exes[0];
  if (!installer) throw new Error('В релизе GitHub нет установщика .exe');
  const url = String(installer.browser_download_url || '');
  if (!url.startsWith('https://')) throw new Error('Некорректная ссылка на установщик в релизе');
  return {
    version,
    url,
    notes: String(data.body || '').slice(0, 4000),
    mandatory: /!\[mandatory\]|<!--\s*mandatory\s*-->/i.test(String(data.body || '')),
    sha256: '',
    size: Number(installer.size) || 0,
    publishedAt: String(data.published_at || '').slice(0, 40),
  };
}

module.exports = {
  CURRENT_VERSION, parseVersion, compareVersions, isNewer, normalizeManifest,
  installerPath, changelogSection, githubManifest,
};
