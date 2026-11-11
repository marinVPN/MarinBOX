'use strict';
// Публикация новой версии MarinBox.
//
//   node scripts/release.js             # сборка -> downloads\ -> webapp\release.json
//   node scripts/release.js --github    # + релиз в GitHub (нужен GITHUB_TOKEN)
//   node scripts/release.js --no-build  # без пересборки
//
// Токен GitHub: переменная окружения GITHUB_TOKEN (репозиторий — package.json -> marinbox.githubRepo).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const updater = require('../lib/updater');

const root = path.join(__dirname, '..');
const project = path.dirname(root);
const distDir = path.join(root, 'dist');
const downloadsDir = path.join(project, 'downloads');
const manifestPath = path.join(project, 'webapp', 'release.json');
const changelogPath = path.join(root, 'CHANGELOG.md');

const args = process.argv.slice(2);
const withBuild = !args.includes('--no-build');
const toGitHub = args.includes('--github');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = pkg.version;

function fail(message) {
  console.error('ОШИБКА: ' + message);
  process.exit(1);
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// npm через node: на Windows .cmd нельзя запускать без shell (защита Node 20+)
function npmRun(args) {
  const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  // npm_lifecycle_event=release заставил бы electron-builder публиковать самому
  const env = { ...process.env, npm_lifecycle_event: 'dist' };
  if (fs.existsSync(npmCli)) {
    return spawnSync(process.execPath, [npmCli, ...args], { stdio: 'inherit', cwd: root, env });
  }
  return spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, { stdio: 'inherit', cwd: root, shell: process.platform === 'win32', env });
}

function run(cmd, cmdArgs) {
  console.log(`> ${cmd} ${cmdArgs.join(' ')}`);
  const r = spawnSync(cmd, cmdArgs, { stdio: 'inherit', cwd: root });
  if (r.status !== 0) fail(`${cmd} завершился с кодом ${r.status}`);
}

// ───────────── GitHub Releases ─────────────
async function githubPublish({ repo, token, notes, file, fileName }) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': `MarinBox-Release/${version}`,
    Authorization: `Bearer ${token}`,
  };
  const tag = `v${version}`;
  const body = { tag_name: tag, name: `MarinBox ${version}`, body: notes, draft: false, prerelease: false };

  const listRes = await fetch(`https://api.github.com/repos/${repo}/releases`, { headers });
  if (!listRes.ok) fail(`GitHub: список релизов недоступен (${listRes.status}) ${await listRes.text()}`);
  const releases = await listRes.json();
  let release = releases.find((r) => r.tag_name === tag || r.name === body.name);

  if (release) {
    console.log(`Релиз ${tag} уже есть — обновляем.`);
    const upd = await fetch(`https://api.github.com/repos/${repo}/releases/${release.id}`, {
      method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!upd.ok) fail(`GitHub: не обновить релиз (${upd.status}) ${await upd.text()}`);
    release = await upd.json();
  } else {
    console.log(`Создаём релиз ${tag}.`);
    const create = await fetch(`https://api.github.com/repos/${repo}/releases`, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!create.ok) fail(`GitHub: не создать релиз (${create.status}) ${await create.text()}`);
    release = await create.json();
  }

  // Старые установщики удаляем: GitHub переименовывает «MarinBox Setup X.exe» в «MarinBox.Setup.X.exe»,
  // поэтому сверяемся по расширению, а не по точному имени.
  const stale = (release.assets || []).filter((a) => /\.exe$/i.test(String(a.name || '')));
  for (const asset of stale) {
    const del = await fetch(`https://api.github.com/repos/${repo}/releases/assets/${asset.id}`, { method: 'DELETE', headers });
    console.log(del.ok ? `Удалён старый файл ${asset.name}.` : `Не удалось удалить старый ${asset.name} (${del.status})`);
  }

  const uploadUrl = String(release.upload_url || '').replace('{?name,label}', '');
  console.log(`Загружаем ${fileName} (${(fs.statSync(file).size / 1048576).toFixed(1)} МБ)…`);
  const up = await fetch(`${uploadUrl}?name=${encodeURIComponent(fileName)}`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/octet-stream' },
    body: fs.readFileSync(file),
  });
  if (!up.ok) fail(`GitHub: не загрузить файл (${up.status}) ${await up.text()}`);
  const uploaded = await up.json();
  console.log(`Загружено: ${uploaded.browser_download_url}`);
  return uploaded.browser_download_url;
}

async function main() {
  // 1. Предупреждение, если версия уже опубликована
  let published = null;
  if (fs.existsSync(manifestPath)) {
    try { published = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { published = null; }
  }
  if (published && published.version === version && !toGitHub) {
    console.log(`Внимание: манифест уже на версии ${version}. Подними версию: npm version patch`);
  }

  // 2. Changelog
  const notes = fs.existsSync(changelogPath)
    ? updater.changelogSection(fs.readFileSync(changelogPath, 'utf8'), version)
    : '';
  if (!notes) console.warn(`В CHANGELOG.md нет раздела для версии ${version} — changelog будет пустым.`);

  // 3. Сборка
  if (withBuild) {
    console.log('> npm run dist');
    const r = npmRun(['run', 'dist']);
    if (r.status !== 0) fail(`npm run dist завершился с кодом ${r.status}`);
  }

  // 4. Установщик -> downloads\
  fs.mkdirSync(downloadsDir, { recursive: true });
  const candidates = fs.readdirSync(distDir).filter((f) => /^MarinBox Setup .*\.exe$/i.test(f)).sort();
  if (!candidates.length) fail('В dist\\ нет установщика. Соберите: npm run dist');
  const source = path.join(distDir, candidates[candidates.length - 1]);
  const fileName = `MarinBox Setup ${version}.exe`;
  const target = path.join(downloadsDir, fileName);
  fs.copyFileSync(source, target);
  console.log(`Установщик: ${target} (${(fs.statSync(target).size / 1048576).toFixed(1)} МБ)`);

  // 5. GitHub-релиз
  let githubUrl = '';
  if (toGitHub) {
    const repo = process.env.MARINBOX_GITHUB_REPO || (pkg.marinbox && pkg.marinbox.githubRepo) || '';
    const token = process.env.GITHUB_TOKEN || '';
    if (!repo) fail('Не указан репозиторий: package.json -> marinbox.githubRepo или MARINBOX_GITHUB_REPO');
    if (!token) fail('Нет токена: задайте GITHUB_TOKEN (токен с правом contents:write у репозитория)');
    githubUrl = await githubPublish({ repo, token, notes, file: target, fileName });
  }

  // 6. Манифест для запасного источника (свой сервер)
  const base = process.env.MARINVPN_PUBLIC_URL || 'https://marinvpn.best.mooo.com';
  const manifest = {
    version,
    url: githubUrl || `${base}/downloads/${encodeURIComponent(fileName)}`,
    notes,
    mandatory: false,
    sha256: sha256(target),
    size: fs.statSync(target).size,
    publishedAt: new Date().toISOString().slice(0, 10),
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  console.log('Манифест:', manifestPath);

  console.log('\nГотово.');
  if (toGitHub) {
    console.log(`Релиз v${version} опубликован в GitHub — клиенты увидят обновление автоматически.`);
  } else {
    console.log('Осталось залить на сервер: .\\deploy\\upload.ps1 -Server <ip> -User <user>');
  }
}

main().catch((e) => fail(e.message));
