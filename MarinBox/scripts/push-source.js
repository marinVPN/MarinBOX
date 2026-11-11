'use strict';
// Заливает исходники MarinBox в GitHub-репозиторий через Contents API.
//   node scripts/push-source.js
// Нужен токен с правом Contents: Read and write (GITHUB_TOKEN).
// node_modules, bin и dist не заливаем — они не нужны в репозитории.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const project = path.dirname(root);
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const repo = process.env.MARINBOX_GITHUB_REPO || (pkg.marinbox && pkg.marinbox.githubRepo) || '';
const token = process.env.GITHUB_TOKEN || '';

if (!repo) { console.error('Не указан репозиторий (package.json -> marinbox.githubRepo)'); process.exit(1); }
if (!token) { console.error('Нет GITHUB_TOKEN'); process.exit(1); }

const SKIP_DIRS = new Set(['node_modules', 'bin', 'dist', '.git', '.vscode']);
const SKIP_FILES = new Set(['package-lock.json']);

function collect(dir, base = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      out.push(...collect(path.join(dir, entry.name), path.join(base, entry.name)));
    } else {
      if (SKIP_FILES.has(entry.name)) continue;
      out.push(path.join(base, entry.name));
    }
  }
  return out;
}

const files = collect(root);
const headers = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'MarinBox-Release',
  Authorization: `Bearer ${token}`,
};

async function putFile(relPath, content) {
  const url = `https://api.github.com/repos/${repo}/contents/${relPath.split(path.sep).map(encodeURIComponent).join('/')}`;
  // узнаём, есть ли файл уже (нужен sha для обновления)
  let sha = null;
  const existing = await fetch(url, { headers });
  if (existing.ok) sha = (await existing.json()).sha;
  else if (existing.status !== 404) throw new Error(`GET ${relPath} -> ${existing.status}`);

  const body = JSON.stringify({
    message: `chore: обновление MarinBox (${relPath.split(path.sep).join('/')})`,
    content: Buffer.from(content).toString('base64'),
    branch: 'main',
    ...(sha ? { sha } : {}),
  });
  const res = await fetch(url, { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' }, body });
  if (!res.ok) throw new Error(`PUT ${relPath} -> ${res.status} ${await res.text()}`);
  return res.status === 201 ? 'создан' : 'обновлён';
}

(async () => {
  console.log(`Репозиторий: ${repo}`);
  console.log(`Файлов к загрузке: ${files.length}`);

  // 1. README репозитория — он же создаёт первый коммит в пустом репозитории
  const readme = `# MarinBox

Windows-клиент MarinVPN: подписки и ключи vless/vmess/trojan/ss, системный прокси и TUN-режим,
пресеты маршрутизации, уведомления и автообновление.

## Релизы

Обновления публикуются здесь, в разделе **Releases**. Клиент сам проверяет последний релиз
и предлагает обновление с changelog.

\`\`\`powershell
cd MarinBox
npm version patch
npm run release -- --github   # нужна переменная GITHUB_TOKEN
\`\`\`

Сборка и разработка — в папке \`MarinBox/\`.
`;
  console.log(`README.md — ${await putFile('README.md', readme)}`);

  // 2. Исходники
  let done = 0;
  for (const rel of files) {
    const content = fs.readFileSync(path.join(root, rel));
    const status = await putFile(path.join('MarinBox', rel), content);
    done++;
    console.log(`  ${status}: MarinBox/${rel.split(path.sep).join('/')}`);
  }

  // 3. Главная страница репозитория (лежит в MarinBox\docs\repo-README.md)
  const readmeFile = path.join(root, 'docs', 'repo-README.md');
  if (fs.existsSync(readmeFile)) {
    console.log(`README.md — ${await putFile('README.md', fs.readFileSync(readmeFile))}`);
  }
  console.log(`\nГотово: ${done} файлов в ${repo}.`);
})().catch((e) => { console.error('ОШИБКА: ' + e.message); process.exit(1); });
