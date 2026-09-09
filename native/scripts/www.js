// Копирует веб-приложение из корня репозитория в native/www для упаковки в Capacitor.
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const out = path.resolve(__dirname, '..', 'www');

const files = [
  'index.html', 'app.css', 'db.js', 'annot.js', 'extras.js', 'tour.js', 'native.js', 'app.js',
  'sw.js', 'manifest.webmanifest', 'icon.svg', 'icon-maskable.svg', 'apple-touch-icon.png',
];
const dirs = ['vendor'];

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
for (const f of files) {
  const src = path.join(root, f);
  if (!fs.existsSync(src)) { console.warn('skip missing', f); continue; }
  fs.copyFileSync(src, path.join(out, f));
}
for (const d of dirs) {
  fs.cpSync(path.join(root, d), path.join(out, d), { recursive: true });
}
console.log('www prepared:', fs.readdirSync(out).join(', '));
