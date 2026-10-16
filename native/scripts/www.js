// Копирует веб-приложение из корня репозитория в native/www для упаковки в Capacitor.
// Берём ВСЕ файлы приложения по расширениям (а не по ручному списку — однажды забытый файл уже сломал сборку),
// затем проверяем, что каждый <script src> и <link href> из index.html действительно попал в www.
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const out = path.resolve(__dirname, '..', 'www');

const EXT = new Set(['.html', '.js', '.css', '.webmanifest', '.svg', '.png', '.json']);
const SKIP = new Set(['MANUAL.html', 'package.json', 'package-lock.json']);
const DIRS = ['vendor'];

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const copied = [];
for (const f of fs.readdirSync(root)) {
  const src = path.join(root, f);
  if (!fs.statSync(src).isFile()) continue;
  if (SKIP.has(f) || !EXT.has(path.extname(f))) continue;
  fs.copyFileSync(src, path.join(out, f));
  copied.push(f);
}
for (const d of DIRS) {
  fs.cpSync(path.join(root, d), path.join(out, d), { recursive: true });
  copied.push(d + '/');
}

// версия сборки — короткий хеш коммита и дата; приложение показывает её строкой внизу «Ещё»
{
  let sha = (process.env.GITHUB_SHA || '').slice(0, 7);
  if (!sha) { try { sha = require('child_process').execSync('git rev-parse --short HEAD', { cwd: root }).toString().trim(); } catch { sha = 'local'; } }
  const date = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(path.join(out, 'version.js'), `window.FIXPOINT_BUILD = ${JSON.stringify({ sha, date })};\n`);
  const ip = path.join(out, 'index.html');
  fs.writeFileSync(ip, fs.readFileSync(ip, 'utf8').replace('<script src="ui.js"></script>', '<script src="version.js"></script>\n  <script src="ui.js"></script>'));
  copied.push('version.js (' + sha + ', ' + date + ')');
}

// проверка ссылок index.html
const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
const refs = [...html.matchAll(/(?:src|href)="([^"#?]+)"/g)].map(m => m[1])
  .filter(u => !/^(https?:|data:|mailto:)/.test(u))
  .concat([...html.matchAll(/from '(\.\/[^']+)'/g)].map(m => m[1]));
const missing = refs.filter(u => !fs.existsSync(path.join(out, u.replace(/^\.\//, ''))));
if (missing.length) {
  console.error('ОШИБКА: index.html ссылается на файлы, которых нет в сборке:', missing.join(', '));
  process.exit(1);
}
console.log('www prepared (' + copied.length + '):', copied.join(', '));
console.log('index.html references OK:', refs.length);
