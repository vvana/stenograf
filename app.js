/* Стенограф — фотодневник ремонта: стены × этапы, слайдер «до/после» */
'use strict';

/* ---------- утилиты ---------- */

const $ = sel => document.querySelector(sel);
const app = document.getElementById('app');

const SIDES = ['n', 'e', 's', 'w'];
const SIDE_NAMES = { n: 'верхняя', e: 'правая', s: 'нижняя', w: 'левая' };
const STATUS = [
  { t: 'не начато', cls: 'st0' },
  { t: 'в работе', cls: 'st1' },
  { t: 'готово', cls: 'st2' },
];
const DEFAULT_STAGES = [
  'Исходное состояние', 'Демонтаж', 'Черновые работы', 'Электрика',
  'Сантехника', 'Штукатурка', 'Шпаклёвка', 'Чистовая отделка', 'Готово',
];

let liveURLs = [];
function newURL(blob) { const u = URL.createObjectURL(blob); liveURLs.push(u); return u; }
function freeURLs() { liveURLs.forEach(u => URL.revokeObjectURL(u)); liveURLs = []; }

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtDate(ts) {
  return new Date(ts).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' });
}

let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

function wallLabel(room, side) {
  const custom = room.labels && room.labels[side];
  if (custom) return custom;
  if (side === 'c') return `${room.name} — потолок`;
  if (side === 'f') return `${room.name} — пол`;
  if (side === 'p') return `${room.name} — панорама 360°`;
  return `${room.name} — ${wallBaseName(room, side)}`;
}
// «верхняя стена» для стандартных 4 сторон, «стена 3» для произвольных многоугольников
function wallBaseName(room, side) {
  if (SIDE_NAMES[side]) return `${SIDE_NAMES[side]} стена`;
  const i = (room.wallIds || []).indexOf(side);
  return i >= 0 ? `стена ${i + 1}` : 'стена';
}

// имя/роль для подписи фото и пометок (хранится на устройстве)
function userName(ask = false) {
  let n = '';
  try { n = localStorage.getItem('stenograf.user') || ''; } catch {}
  if (!n && ask) {
    const t = prompt('Как вас подписывать на фото и пометках? Например «Сергей, электрик»', '');
    if (t && t.trim()) { n = t.trim(); try { localStorage.setItem('stenograf.user', n); } catch {} }
  }
  return n;
}

function parseWallKey(key) {
  const i = key.lastIndexOf(':');
  return { roomId: key.slice(0, i), side: key.slice(i + 1) };
}

async function loadProjectData(pid) {
  const [project, rooms, stages, photos] = await Promise.all([
    dbGet('projects', pid),
    dbAll('rooms', 'projectId', pid),
    dbAll('stages', 'projectId', pid),
    dbAll('photos', 'projectId', pid),
  ]);
  stages.sort((a, b) => a.ord - b.ord);
  rooms.sort((a, b) => (a.created || 0) - (b.created || 0));
  for (const r of rooms) {
    normalizeRoom(r);
    if (r._migrated) { delete r._migrated; await dbPut('rooms', r); }
  }
  return { project, rooms, stages, photos };
}

/* ---------- сжатие фото ---------- */

async function compressImage(file, maxDim = 1600, quality = 0.85) {
  let bmp;
  try {
    bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    bmp = await createImageBitmap(file);
  }
  const k = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * k), h = Math.round(bmp.height * k);
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
  bmp.close();
  const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', quality));
  return blob || file;
}

/* ---------- EXIF: дата съёмки из JPEG ---------- */

async function readExifDate(file) {
  try {
    const dv = new DataView(await file.slice(0, 256 * 1024).arrayBuffer());
    if (dv.byteLength < 4 || dv.getUint16(0) !== 0xFFD8) return null;
    let off = 2;
    while (off + 4 <= dv.byteLength) {
      if (dv.getUint8(off) !== 0xFF) break;
      const marker = dv.getUint8(off + 1), len = dv.getUint16(off + 2);
      if (marker === 0xE1 && dv.getUint32(off + 4) === 0x45786966) { // "Exif"
        const tiff = off + 10;
        const little = dv.getUint16(tiff) === 0x4949;
        const g16 = p => dv.getUint16(p, little), g32 = p => dv.getUint32(p, little);
        const readTag = (ifd, want) => {
          const n = g16(ifd);
          for (let i = 0; i < n; i++) {
            const e = ifd + 2 + i * 12;
            if (g16(e) !== want) continue;
            const type = g16(e + 2), cnt = g32(e + 4);
            if (type === 4) return g32(e + 8);
            if (type === 3) return g16(e + 8);
            if (type === 2) {
              const p = cnt > 4 ? tiff + g32(e + 8) : e + 8;
              let s = '';
              for (let k = 0; k < cnt - 1 && p + k < dv.byteLength; k++) s += String.fromCharCode(dv.getUint8(p + k));
              return s;
            }
            return null;
          }
          return null;
        };
        const ifd0 = tiff + g32(tiff + 4);
        const exifIfd = readTag(ifd0, 0x8769);
        let str = exifIfd ? readTag(tiff + exifIfd, 0x9003) : null; // DateTimeOriginal
        if (!str) str = readTag(ifd0, 0x0132);                       // DateTime
        const m = typeof str === 'string' && /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(str);
        return m ? new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : null;
      }
      if (marker === 0xDA) break; // начало данных изображения
      off += 2 + len;
    }
  } catch { /* не JPEG или битый EXIF */ }
  return null;
}

/* ---------- роутер ---------- */

window.addEventListener('hashchange', render);

function nav(hash) { location.hash = hash; }

let viewCleanup = null; // экран может оставить функцию уборки (остановить камеру и т.п.)

async function render() {
  freeURLs();
  app.style.paddingBottom = '';
  planState.furnList = false;
  if (viewCleanup) { try { viewCleanup(); } catch {} viewCleanup = null; }
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  try {
    if (parts.length === 0) return await viewProjects();
    if (parts[0] === 'p' && parts[1]) {
      const pid = parts[1];
      if (parts[2] === 'stages') return await viewStages(pid);
      if (parts[2] === 'more') return await viewMore(pid);
      if (parts[2] === 'w' && parts[3]) return await viewWall(pid, parts[3]);
      if (parts[2] === 'cmp' && parts[3]) return await viewCompare(pid, parts[3]);
      if (parts[2] === 'report') return await viewReport(pid);
      if (parts[2] === 'verify') return await viewVerify(pid);
      if (parts[2] === 'calc') return await viewCalc(pid);
      if (parts[2] === 'ghost' && parts[3] && parts[4]) return await viewGhost(pid, parts[3], parts[4]);
      if (parts[2] === 'tour') return await viewTour(pid, parts[3] || null);
      return await viewPlan(pid);
    }
    return await viewProjects();
  } catch (err) {
    console.error(err);
    app.innerHTML = `<div class="pad"><h2>Ошибка</h2><p class="mut">${esc(err.message)}</p>
      <button class="btn" onclick="location.hash=''">На главную</button></div>`;
  }
}

function header(title, backHash, right = '') {
  return `<header class="topbar">
    ${backHash !== null ? `<button class="iconbtn" data-nav="${esc(backHash)}" aria-label="Назад">←</button>` : '<span class="logo">⌂</span>'}
    <h1>${esc(title)}</h1>
    <div class="topbar-right">${right}</div>
  </header>`;
}

app.addEventListener('click', e => {
  if (e.target.closest('[data-nonav]')) return;
  const t = e.target.closest('[data-nav]');
  if (t) nav(t.dataset.nav);
});

/* ---------- удаление объекта и схемы ---------- */

async function deleteProject(pid) {
  const project = await dbGet('projects', pid);
  if (!project) return false;
  const photos = await dbAll('photos', 'projectId', pid);
  const rooms = await dbAll('rooms', 'projectId', pid);
  if (!confirm(`Удалить объект «${project.name}»?
Комнат: ${rooms.length}, фото: ${photos.length}. Удалятся схема, этапы и все фото.`)) return false;
  if (!confirm('Точно удалить? Восстановить будет нельзя (только из резервной копии).')) return false;
  await dbDelWhere('photos', 'projectId', pid);
  await dbDelWhere('rooms', 'projectId', pid);
  await dbDelWhere('stages', 'projectId', pid);
  await dbDel('projects', pid);
  toast(`Объект «${project.name}» удалён`);
  return true;
}

// очистить схему: комнаты и всё, что к ним привязано (фото стен, потолка, пола, панорамы), модели скана; этапы остаются
async function clearPlan(pid) {
  const project = await dbGet('projects', pid);
  const rooms = await dbAll('rooms', 'projectId', pid);
  if (!rooms.length && !(project && (project.plan || project.usdz || project.finalScan))) { toast('Схема и так пустая'); return false; }
  const ids = new Set(rooms.map(r => r.id));
  const photos = (await dbAll('photos', 'projectId', pid)).filter(p => ids.has(String(p.wallKey).split(':')[0]));
  if (!confirm(`Удалить схему объекта «${project.name}»?
Комнат: ${rooms.length}${photos.length ? `, вместе с ними удалятся ${photos.length} фото стен, потолков, полов и панорам` : ''}.
Этапы останутся.`)) return false;
  if (photos.length && !confirm(`Точно удалить ${photos.length} фото? Восстановить будет нельзя (только из резервной копии).`)) return false;
  for (const p of photos) await dbDel('photos', p.id);
  for (const r of rooms) await dbDel('rooms', r.id);
  delete project.usdz; delete project.usdzAt; delete project.finalScan;
  if (project.plan && confirm('Подложку (план БТИ / скан) тоже удалить?')) delete project.plan;
  await dbPut('projects', project);
  planState.selected = null; planState.sel = null; planState.mode = null; planState.tmp = [];
  toast('Схема удалена');
  return true;
}

/* ---------- экран: список объектов ---------- */

async function viewProjects() {
  const projects = await dbAll('projects');
  projects.sort((a, b) => b.created - a.created);
  const photosAll = await dbAll('photos');
  const counts = {};
  photosAll.forEach(p => { counts[p.projectId] = (counts[p.projectId] || 0) + 1; });

  app.innerHTML = `
    ${header('Стенограф', null)}
    <div class="pad">
      ${projects.length === 0 ? `
        <div class="empty">
          <div class="empty-ico">🏗️</div>
          <p><b>Пока нет ни одного объекта.</b></p>
          <p class="mut">Объект — это квартира или дом, где идёт ремонт. Добавьте первый, нарисуйте схему и фиксируйте каждую стену по этапам.</p>
        </div>` : ''}
      <div class="cards">
        ${projects.map(p => `
          <div class="card project-card" data-nav="#/p/${p.id}">
            <button class="card-del" data-nonav data-del="${p.id}" title="Удалить объект" aria-label="Удалить объект">🗑</button>
            <div class="project-name">${esc(p.name)}</div>
            <div class="mut small">${counts[p.id] || 0} фото · создан ${fmtDate(p.created)}</div>
          </div>`).join('')}
      </div>
      <button class="btn primary wide" id="add-project">+ Новый объект</button>
      <div class="backup-row">
        <button class="btn ghost" id="export-all">⬇ Резервная копия</button>
        <button class="btn ghost" id="import-all">⬆ Импорт копии</button>
      </div>
      <p class="mut small center">Данные хранятся только на этом устройстве.<br>Периодически сохраняйте резервную копию.</p>
    </div>`;

  $('#add-project').onclick = async () => {
    const name = prompt('Название объекта (например, «Квартира на Ленина»):');
    if (!name || !name.trim()) return;
    templateSheet(async tpl => {
      const p = { id: uid(), name: name.trim(), created: Date.now(), template: tpl ? tpl.id : 'custom' };
      await dbPut('projects', p);
      await createStagesFromTemplate(p.id, tpl);
      nav(`#/p/${p.id}`);
    });
  };
  $('#export-all').onclick = exportBackup;
  $('#import-all').onclick = importBackup;
  app.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => { if (await deleteProject(b.dataset.del)) render(); });
}

/* ---------- экран: план квартиры ---------- */

const MAX_CORNERS = 10;
// sel: {type:'vertex'|'wall', i}; mode: null | 'trace' (обводка комнаты) | 'scale' (масштаб подложки) | 'underlay' (сдвиг подложки)
const planState = { edit: false, selected: null, sel: null, mode: null, tmp: [], underlayHidden: false };

/* --- геометрия комнаты-многоугольника ---
   room.pts = [[x, y, r?], ...] в метрах по часовой/против — как нарисовал пользователь; r — радиус скругления угла (м)
   room.wallIds[i] — стабильный id стены от pts[i] к pts[i+1]; wallKey = roomId:wallId */

function normalizeRoom(r) {
  if (!Array.isArray(r.pts) && r.w != null) {
    // миграция старых прямоугольных комнат; id стен n/e/s/w сохраняются — фото не отвязываются
    r.pts = [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]];
    r.wallIds = ['n', 'e', 's', 'w'];
    delete r.x; delete r.y; delete r.w; delete r.h;
    r._migrated = true;
  }
  if (!Array.isArray(r.pts) || r.pts.length < 3) {
    r.pts = [[1, 1], [5, 1], [5, 4.5], [1, 4.5]];
    r.wallIds = ['n', 'e', 's', 'w'];
    r._migrated = true;
  }
  if (!Array.isArray(r.wallIds) || r.wallIds.length !== r.pts.length) {
    r.wallIds = r.pts.map((_, i) => (r.wallIds && r.wallIds[i]) || newWallId());
    r._migrated = true;
  }
  return r;
}
function newWallId() { return 'k' + uid().replace(/-/g, '').slice(0, 6); }

function roomBBox(r) {
  const xs = r.pts.map(p => p[0]), ys = r.pts.map(p => p[1]);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}
function polyArea(pts) {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}
function roomArea(r) { return Math.abs(polyArea(r.pts)); }
function pointInPoly(p, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}
function roomCenter(r) {
  const pts = r.pts, A = polyArea(pts);
  const bb = roomBBox(r), bc = [bb.x + bb.w / 2, bb.y + bb.h / 2];
  if (Math.abs(A) < 1e-9) return bc;
  let cx = 0, cy = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const f = a[0] * b[1] - b[0] * a[1];
    cx += (a[0] + b[0]) * f; cy += (a[1] + b[1]) * f;
  }
  const c = [cx / (6 * A), cy / (6 * A)];
  if (pointInPoly(c, pts)) return c;
  return pointInPoly(bc, pts) ? bc : c;
}
function roomEdges(r) {
  const n = r.pts.length, out = [];
  for (let i = 0; i < n; i++) {
    const a = r.pts[i], b = r.pts[(i + 1) % n];
    const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy) || 1e-9;
    let nx = -dy / len, ny = dx / len;
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    if (!pointInPoly([mid[0] + nx * 0.05, mid[1] + ny * 0.05], r.pts)) { nx = -nx; ny = -ny; }
    out.push({ i, id: r.wallIds[i], a, b, len, mid, nx, ny, ux: dx / len, uy: dy / len });
  }
  return out;
}
function roomEdge(r, wallId) { return roomEdges(r).find(e => e.id === wallId) || null; }
function isWallId(r, id) { return (r.wallIds || []).includes(id); }
function isStandardRoom(r) { return r.pts.length === 4 && r.wallIds.every(id => SIDE_NAMES[id]); }

// внутренний угол в вершине i, градусы
function cornerAngle(r, i) {
  const n = r.pts.length, P = r.pts[(i - 1 + n) % n], V = r.pts[i], N = r.pts[(i + 1) % n];
  const a1 = Math.atan2(P[1] - V[1], P[0] - V[0]), a2 = Math.atan2(N[1] - V[1], N[0] - V[0]);
  let d = Math.abs(a1 - a2);
  if (d > Math.PI) d = 2 * Math.PI - d;
  const bx = Math.cos(a1) + Math.cos(a2), by = Math.sin(a1) + Math.sin(a2);
  const bl = Math.hypot(bx, by) || 1e-9;
  const deg = d * 180 / Math.PI;
  return pointInPoly([V[0] + bx / bl * 0.05, V[1] + by / bl * 0.05], r.pts) ? deg : 360 - deg;
}
// задать угол в вершине i: поворачиваем следующую вершину вокруг неё, длина стены сохраняется
function setCornerAngle(r, i, deg) {
  const n = r.pts.length, P = r.pts[(i - 1 + n) % n], V = r.pts[i], N = r.pts[(i + 1) % n];
  const len = Math.hypot(N[0] - V[0], N[1] - V[1]);
  const aP = Math.atan2(P[1] - V[1], P[0] - V[0]);
  const rad = deg * Math.PI / 180;
  const cand = [aP + rad, aP - rad].map(a => [cm(V[0] + Math.cos(a) * len), cm(V[1] + Math.sin(a) * len), ...N.slice(2)]);
  // из двух зеркальных вариантов берём тот, при котором внутренний угол действительно равен заданному
  const idx = (i + 1) % n;
  const err = cand.map(c => { r.pts[idx] = c; return Math.abs(cornerAngle(r, i) - deg); });
  r.pts[idx] = err[0] <= err[1] ? cand[0] : cand[1];
}
// задать длину стены i: сдвигаем её конечную вершину вдоль стены
function setWallLength(r, i, len) {
  const n = r.pts.length, A = r.pts[i], B = r.pts[(i + 1) % n];
  const d = Math.hypot(B[0] - A[0], B[1] - A[1]) || 1e-9;
  r.pts[(i + 1) % n] = [cm(A[0] + (B[0] - A[0]) / d * len), cm(A[1] + (B[1] - A[1]) / d * len), ...B.slice(2)];
}
const cm = v => Math.round(v * 100) / 100;

// контур комнаты со скруглёнными углами (радиус хранится третьим числом вершины)
function roomPath(r) {
  const pts = r.pts, n = pts.length;
  let d = '';
  for (let i = 0; i < n; i++) {
    const V = pts[i], rad = V[2] || 0;
    if (rad > 0) {
      const P = pts[(i - 1 + n) % n], N = pts[(i + 1) % n];
      const dP = [P[0] - V[0], P[1] - V[1]], dN = [N[0] - V[0], N[1] - V[1]];
      const lP = Math.hypot(dP[0], dP[1]) || 1e-9, lN = Math.hypot(dN[0], dN[1]) || 1e-9;
      let ang = cornerAngle(r, i); if (ang > 180) ang = 360 - ang;
      const t = Math.min(rad / Math.tan(ang / 2 * Math.PI / 180), lP / 2, lN / 2);
      const A = [V[0] + dP[0] / lP * t, V[1] + dP[1] / lP * t], B = [V[0] + dN[0] / lN * t, V[1] + dN[1] / lN * t];
      d += `${i ? 'L' : 'M'}${A[0]} ${A[1]} Q${V[0]} ${V[1]} ${B[0]} ${B[1]} `;
    } else {
      d += `${i ? 'L' : 'M'}${V[0]} ${V[1]} `;
    }
  }
  return d + 'Z';
}

async function viewPlan(pid) {
  const { project, rooms, photos } = await loadProjectData(pid);
  if (!project) return nav('');
  const counts = {}, points = {};
  photos.forEach(p => {
    counts[p.wallKey] = (counts[p.wallKey] || 0) + 1;
    const n = (p.marks || []).filter(m => (m.type === 'point' || m.type === 'conduit') && (m.layer || 'main') === 'main').length;
    if (n) points[p.wallKey] = (points[p.wallKey] || 0) + n;
  });

  app.innerHTML = `
    ${header(project.name, '#/')}
    <div class="plan-wrap">
      <div class="plan-actions">
        <button class="pa-btn hidden" id="lidar-walk" title="Обход этапа: автосъёмка стен лидаром">
          <svg viewBox="0 0 24 24"><circle cx="13" cy="4" r="2"/><path d="M11 21l2-6-2.5-3 1-4 3 3h3M12.5 8l-3 2-1 3M13 15l3 2v4"/></svg><span>Обход этапа</span></button>
        <button class="pa-btn hidden" id="lidar-apt" title="Квартира целиком: обмер / финальный скан">
          <svg viewBox="0 0 24 24"><path d="M4 21V6l8-3v18M12 21V9l8 3v9M2.5 21h19M7 8.5h2M7 12.5h2M7 16.5h2M15 14h2M15 17.5h2"/></svg><span>Вся квартира</span></button>
        <button class="pa-btn ${planState.edit ? 'active' : ''}" id="toggle-edit" title="Редактор схемы">
          <svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16v4z"/><path d="M13.5 6.5l4 4"/></svg><span>${planState.edit ? 'Готово' : 'Редактор'}</span></button>
      </div>
      <div id="editor-bar" class="editor-bar ${planState.edit ? '' : 'hidden'}">
        <span id="create-tools" class="tools">
          <button class="btn small-btn" id="add-room">+ Комната</button>
          <button class="btn small-btn" id="trace-room" title="Обвести комнату тапами по углам">✏ Обвести</button>
          <button class="btn small-btn" id="wizard-room" title="Ввести стены по обмеру">📏 По обмеру</button>
          <button class="btn small-btn" id="underlay-menu" title="План БТИ / скан как подложка">🗺 Подложка</button>
        </span>
        <span id="mode-tools" class="tools hidden">
          <span id="mode-text" class="small"></span>
          <button class="btn small-btn primary" id="mode-done">Готово</button>
          <button class="btn small-btn" id="mode-cancel">Отмена</button>
        </span>
        <span id="room-tools" class="tools hidden">
          <input id="room-name" class="inp" placeholder="Название комнаты">
          <input id="room-ceil" class="inp num" type="number" step="0.05" min="2" max="6" placeholder="h, м" title="Высота потолка, м">
          <button class="btn small-btn hidden" id="room-furn">🛋 Мебель</button>
          <button class="btn small-btn danger" id="del-room">Удалить</button>
        </span>
        <span id="vertex-tools" class="tools hidden">
          <label>Угол° <input id="v-angle" class="inp num" type="number" step="1" min="1" max="359"></label>
          <label>R, см <input id="v-radius" class="inp num" type="number" step="1" min="0" max="200"></label>
          <button class="btn small-btn danger" id="del-vertex">Убрать угол</button>
        </span>
        <span id="wall-tools" class="tools hidden">
          <label>Длина, м <input id="w-len" class="inp num" type="number" step="0.01" min="0.1" max="50"></label>
          <label>h, м <input id="w-h" class="inp num" type="number" step="0.01" min="1" max="10" title="Высота этой стены"></label>
          <button class="btn small-btn" id="add-vertex">+ Угол на стене</button>
        </span>
        <span class="mut small" id="editor-hint">Тапните комнату. Тяните вершины за кружки, «+» на стене добавляет угол, тап по стене — задать длину.</span>
      </div>
      <div id="lidar-row" class="lidar-row hidden"><button class="btn primary wide" id="lidar-measure" title="Обмер комнаты лидаром (RoomPlan)"><span class="btn-ico">${ICONS.scan}</span>Обмер комнаты лидаром</button></div>
      <div class="plan-frame">
        <div id="plan-box" class="plan-box"></div>
        ${rooms.length || (project.plan && project.plan.blob) ? '<button class="plan-trash" id="clear-plan" title="Удалить схему" aria-label="Удалить схему">🗑</button>' : ''}
      </div>
      <div id="plan-sheet" class="plan-sheet hidden"></div>
      <input type="file" id="underlay-file" accept="image/*" class="hidden-input">
      ${rooms.length === 0 && !planState.edit ? `
        <div class="empty">
          <div class="empty-ico">📐</div>
          <p><b>Схемы пока нет.</b></p>
          <p class="mut">Нажмите ✎ сверху и добавьте комнаты. Потом тапайте по стенам на схеме, чтобы прикреплять к ним фото.</p>
        </div>` : `<p class="mut small center pad-h">${planState.edit
          ? 'Режим редактора: комната — многоугольник до 10 углов. По умолчанию углы 90°, любой можно изменить.'
          : 'Тап по стене — её фото по этапам. Тап внутри комнаты — потолок, пол, панорама 360°.'}</p>`}
    </div>
    ${bottomNav(pid, 'plan')}`;

  $('#toggle-edit').onclick = () => { planState.edit = !planState.edit; planState.selected = null; planState.sel = null; render(); };
  const clearBtn = $('#clear-plan');
  if (clearBtn) clearBtn.onclick = async () => { if (await clearPlan(pid)) render(); };
  if (planState.edit) {
    $('#add-room').onclick = async () => {
      const t = prompt('Размеры комнаты, м: ширина и глубина через пробел (например 4,2 3,1). Пусто — 4 × 3,5', '');
      if (t === null) return;
      const nums = String(t).replace(/,/g, '.').match(/\d+(\.\d+)?/g) || [];
      const w = parseFloat(nums[0]) > 0 ? parseFloat(nums[0]) : 4;
      const h = parseFloat(nums[1]) > 0 ? parseFloat(nums[1]) : 3.5;
      const [x, y] = freeSpot(rooms, w, h);
      await createRoom(pid, rooms, [[x, y], [x + w, y], [x + w, y + h], [x, y + h]], null);
    };
  }
  setupPlan(pid, rooms, counts, points, project);
}

// свободное место под новую комнату: справа от уже нарисованных
function freeSpot(rooms, w, h) {
  if (!rooms.length) return [1, 1];
  const bbs = rooms.map(roomBBox);
  const right = Math.max(...bbs.map(b => b.x + b.w));
  const top = Math.min(...bbs.map(b => b.y));
  return [cm(right + 0.6), cm(top)];
}

// 4 угла, все стены горизонтальны/вертикальны → стандартный прямоугольник n/e/s/w (обход по часовой с верхнего левого)
/* ---------- мебель из скана на схеме: условные знаки ---------- */
const FURN_TYPES = ['bed', 'sofa', 'chair', 'table', 'storage', 'refrigerator', 'stove', 'oven', 'dishwasher', 'washerDryer', 'sink', 'toilet', 'bathtub', 'television', 'fireplace', 'stairs'];
const furnAttr = (o, re) => re.test((o.attrs || []).join(' '));
function furnName(o) {
  const base = (typeof OBJECT_NAMES !== 'undefined' && OBJECT_NAMES[o.cat]) || o.cat || 'Предмет';
  if (o.cat === 'table') return furnAttr(o, /coffee/i) ? 'Журнальный стол' : furnAttr(o, /circular|elliptic/i) ? 'Стол круглый' : base;
  if (o.cat === 'chair') return furnAttr(o, /stool/i) ? 'Табурет' : furnAttr(o, /swivel/i) ? 'Кресло офисное' : base;
  if (o.cat === 'sofa') return furnAttr(o, /l.?shaped/i) ? 'Диван угловой' : furnAttr(o, /single/i) ? 'Кресло' : base;
  if (o.cat === 'storage') return furnAttr(o, /shelf/i) ? 'Стеллаж' : base;
  return base;
}
// какая длинная сторона предмета у стены — там «спинка» (изголовье, спинка дивана, бачок унитаза)
function furnBackFlip(o, r) {
  const yd = [-Math.sin(o.ang), Math.cos(o.ang)];
  const side = s => {
    const p = [o.x + yd[0] * s * o.d / 2, o.y + yd[1] * s * o.d / 2];
    let m = Infinity;
    for (const e of roomEdges(r)) {
      const t = Math.max(0, Math.min(e.len, (p[0] - e.a[0]) * e.ux + (p[1] - e.a[1]) * e.uy));
      m = Math.min(m, Math.hypot(p[0] - (e.a[0] + e.ux * t), p[1] - (e.a[1] + e.uy * t)));
    }
    return m;
  };
  return side(1) < side(-1); // true — спинка со стороны +y, зеркалим знак
}
// знак в локальных координатах: x вдоль ширины w, y вдоль глубины d, спинка при y = -d/2
function furnSymbol(o) {
  const w = o.w, d = o.d, x0 = -w / 2, y0 = -d / 2;
  const R = (x, y, ww, hh, cls = 'furn2', rx = 0.03) => `<rect class="${cls}" x="${x}" y="${y}" width="${Math.max(0.01, ww)}" height="${Math.max(0.01, hh)}" rx="${rx}"/>`;
  const L = (xa, ya, xb, yb) => `<line class="furn-l" x1="${xa}" y1="${ya}" x2="${xb}" y2="${yb}"/>`;
  const E = (cx, cy, rx, ry, cls = 'furn-l') => `<ellipse class="${cls}" cx="${cx}" cy="${cy}" rx="${Math.max(0.01, rx)}" ry="${Math.max(0.01, ry)}"/>`;
  let s = '';
  switch (o.cat) {
    case 'bed': {
      s += R(x0, y0, w, d);
      const ph = Math.min(0.3, d * 0.18), m = 0.08;
      if (w > 1.2) { const pw = (w - 3 * m) / 2; s += R(x0 + m, y0 + m, pw, ph, 'furn3') + R(x0 + 2 * m + pw, y0 + m, pw, ph, 'furn3'); }
      else s += R(x0 + m, y0 + m, w - 2 * m, ph, 'furn3');
      const by = y0 + m + ph + Math.min(0.25, d * 0.12);
      s += L(x0, by, x0 + w, by) + L(x0 + w * 0.55, by, x0 + w, by + Math.min(0.35, d * 0.2));
      break;
    }
    case 'sofa': {
      const bt = Math.min(0.25, d * 0.28), aw = Math.min(0.2, w * 0.12);
      s += R(x0, y0, w, d) + R(x0, y0, w, bt, 'furn3', 0.02) + R(x0, y0 + bt, aw, d - bt, 'furn3', 0.02) + R(x0 + w - aw, y0 + bt, aw, d - bt, 'furn3', 0.02);
      const n = w - 2 * aw > 1.5 ? 3 : 2, sw = (w - 2 * aw) / n;
      for (let k = 1; k < n; k++) s += L(x0 + aw + sw * k, y0 + bt, x0 + aw + sw * k, y0 + d);
      break;
    }
    case 'chair':
      if (furnAttr(o, /stool/i)) s += E(0, 0, w / 2, d / 2, 'furn2');
      else s += R(x0, y0, w, d, 'furn2', 0.05) + R(x0, y0, w, Math.min(0.1, d * 0.2), 'furn3', 0.02);
      break;
    case 'table':
      s += furnAttr(o, /circular|elliptic/i) ? E(0, 0, w / 2, d / 2, 'furn2') : R(x0, y0, w, d, 'furn2', 0.02);
      break;
    case 'storage':
      s += R(x0, y0, w, d, 'furn2', 0.01);
      if (furnAttr(o, /shelf/i)) { s += L(x0, y0 + d / 3, x0 + w, y0 + d / 3) + L(x0, y0 + 2 * d / 3, x0 + w, y0 + 2 * d / 3); }
      else s += L(x0, y0, x0 + w, y0 + d) + L(x0 + w, y0, x0, y0 + d);
      break;
    case 'stove': {
      s += R(x0, y0, w, d, 'furn2', 0.01);
      const rr = Math.min(w, d) * 0.16;
      for (const [fx, fy] of [[-0.25, -0.22], [0.25, -0.22], [-0.25, 0.22], [0.25, 0.22]]) s += E(fx * w, fy * d, rr, rr);
      break;
    }
    case 'washerDryer':
      s += R(x0, y0, w, d, 'furn2', 0.01) + E(0, 0.05 * d, Math.min(w, d) * 0.32, Math.min(w, d) * 0.32);
      break;
    case 'sink':
      s += R(x0, y0, w, d, 'furn2', 0.02) + E(0, d * 0.08, w * 0.34, d * 0.3) + E(0, y0 + d * 0.12, 0.025, 0.025, 'furn4');
      break;
    case 'toilet': {
      const th = Math.min(0.2, d * 0.3);
      s += R(x0, y0, w, th, 'furn2', 0.02) + E(0, y0 + th + (d - th) / 2, w * 0.42, (d - th) / 2 * 0.95, 'furn2');
      break;
    }
    case 'bathtub':
      s += R(x0, y0, w, d, 'furn2', 0.04) + R(x0 + 0.07, y0 + 0.07, w - 0.14, d - 0.14, 'furn3', Math.min(w, d) * 0.25) + E(x0 + w * 0.12, 0, 0.03, 0.03, 'furn4');
      break;
    case 'television':
      s += R(x0, y0, w, d, 'furn5', 0.01);
      break;
    case 'stairs': {
      s += R(x0, y0, w, d, 'furn2', 0.01);
      for (let y = y0 + 0.28; y < y0 + d - 0.05; y += 0.28) s += L(x0, y, x0 + w, y);
      break;
    }
    default:
      s += R(x0, y0, w, d, 'furn2', 0.02);
      if (o.cat === 'oven' || o.cat === 'fireplace' || o.cat === 'refrigerator' || o.cat === 'dishwasher') s += R(x0 + w * 0.12, y0 + d * 0.15, w * 0.76, d * 0.7, 'furn3', 0.02);
  }
  return s;
}
const FURN_SHORT = { refrigerator: 'Хол.', oven: 'Дух.', dishwasher: 'ПММ', washerDryer: 'СМ', fireplace: 'Камин', television: 'ТВ' };
function furnSvg(o, r, num) {
  const deg = o.ang * 180 / Math.PI;
  const flip = furnBackFlip(o, r) ? ' scale(1 -1)' : '';
  let s = `<g class="furn-g" transform="translate(${o.x} ${o.y}) rotate(${deg})"><g transform="${flip.trim() || 'translate(0 0)'}">${furnSymbol(o)}</g></g>`;
  let label = num != null ? String(num) : FURN_SHORT[o.cat] || (o.cat === 'storage' && !furnAttr(o, /shelf/i) ? '' : '');
  if (label) {
    let td = deg % 360; if (td < 0) td += 360;
    if (td > 90 && td < 270) td -= 180;
    if (num != null) td = 0; // номера — всегда ровно
    const fs = num != null ? 0.26 : Math.min(0.16, Math.max(0.09, Math.min(o.w, o.d) * 0.35));
    s += `<text class="${num != null ? 'furn-num' : 'furn-t'}" style="font-size:${fs}px" transform="translate(${o.x} ${o.y}) rotate(${td})">${esc(label)}</text>`;
  }
  return s;
}

function standardizeRect(pts) {
  if (pts.length !== 4) return null;
  const axis = pts.every((p, i) => { const q = pts[(i + 1) % 4]; return Math.abs(p[0] - q[0]) < 0.05 || Math.abs(p[1] - q[1]) < 0.05; });
  if (!axis) return null;
  let arr = pts.map(p => p.slice());
  if (polyArea(arr) < 0) arr.reverse();           // по часовой на экране (y вниз) — положительная площадь
  let k = 0;
  for (let i = 1; i < 4; i++) if (arr[i][0] + arr[i][1] < arr[k][0] + arr[k][1]) k = i;
  return [...arr.slice(k), ...arr.slice(0, k)];
}

async function createRoom(pid, rooms, pts, name) {
  const std = standardizeRect(pts);
  const room = {
    id: uid(), projectId: pid, name: name || ('Комната ' + (rooms.length + 1)),
    pts: (std || pts).map(p => [cm(p[0]), cm(p[1]), ...p.slice(2)]),
    wallIds: std ? ['n', 'e', 's', 'w'] : pts.map(() => newWallId()),
    labels: {}, created: Date.now(),
  };
  await dbPut('rooms', room);
  planState.selected = room.id; planState.sel = null; planState.mode = null; planState.tmp = [];
  render();
  return room;
}

// линейные значки (цвет — currentColor), читаются лучше эмодзи
const svgIco = d => `<svg viewBox="0 0 24 24">${d}</svg>`;
const ICONS = {
  plan: svgIco('<rect x="3" y="4" width="18" height="16" rx="1.5"/><path d="M3 12h8v8M11 4v4M15 12h6"/>'),
  stages: svgIco('<path d="M9 6h11M9 12h11M9 18h11"/><path d="M3.5 6l1.5 1.5L7.5 5M3.5 12l1.5 1.5L7.5 11"/><circle cx="5" cy="18" r="1.3"/>'),
  tour: svgIco('<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z"/><path d="M4 7.5l8 4.5 8-4.5M12 12v9"/>'),
  more: svgIco('<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>'),
  scan: svgIco('<path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3"/><path d="M8 12h8M12 8v8" opacity=".9"/>'),
};

function bottomNav(pid, active) {
  const item = (key, hash, ico, label) =>
    `<button class="nav-item ${active === key ? 'active' : ''}" data-nav="${hash}">
      <span class="nav-ico">${ico}</span>${label}</button>`;
  return `<nav class="bottomnav">
    ${item('plan', `#/p/${pid}`, ICONS.plan, 'Схема')}
    ${item('stages', `#/p/${pid}/stages`, ICONS.stages, 'Этапы')}
    ${item('tour', `#/p/${pid}/tour`, ICONS.tour, '3D-тур')}
    ${item('more', `#/p/${pid}/more`, ICONS.more, 'Ещё')}
  </nav>`;
}

function setupPlan(pid, rooms, counts, points = {}, project = null) {
  const box = $('#plan-box');
  if (!box) return;
  const plan = project && project.plan && project.plan.blob ? project.plan : null;
  const planURL = plan ? newURL(plan.blob) : null;

  let minX = 0, minY = 0, maxX = 8, maxY = 8;
  if (rooms.length) {
    const bbs = rooms.map(roomBBox);
    minX = Math.min(...bbs.map(b => b.x)) - 1;
    minY = Math.min(...bbs.map(b => b.y)) - 1;
    maxX = Math.max(...bbs.map(b => b.x + b.w)) + 1;
    maxY = Math.max(...bbs.map(b => b.y + b.h)) + 1;
  }
  if (plan && planState.edit && !planState.underlayHidden) {
    // в редакторе подложка должна быть видна целиком
    minX = Math.min(minX, plan.ox - 0.5); minY = Math.min(minY, plan.oy - 0.5);
    maxX = Math.max(maxX, plan.ox + plan.w * plan.k + 0.5); maxY = Math.max(maxY, plan.oy + plan.h * plan.k + 0.5);
  }
  if (planState.edit) { maxX += 2; maxY += 2; }
  const vb = { x: minX, y: minY, w: Math.max(maxX - minX, 6), h: Math.max(maxY - minY, 6) };

  box.innerHTML = `<svg id="plan" viewBox="${vb.x} ${vb.y} ${vb.w} ${vb.h}" preserveAspectRatio="xMidYMid meet"></svg>`;
  const svg = $('#plan');
  const selRoom = () => rooms.find(r => r.id === planState.selected);

  function draw() {
    let s = '';
    if (planURL && !planState.underlayHidden) {
      s += `<image class="underlay ${planState.edit ? 'edit' : ''}" href="${planURL}" x="${plan.ox}" y="${plan.oy}" width="${plan.w * plan.k}" height="${plan.h * plan.k}" preserveAspectRatio="none"/>`;
    }
    if (planState.edit) {
      s += '<g class="grid">';
      for (let gx = Math.ceil(vb.x); gx <= vb.x + vb.w; gx++) s += `<line x1="${gx}" y1="${vb.y}" x2="${gx}" y2="${vb.y + vb.h}"/>`;
      for (let gy = Math.ceil(vb.y); gy <= vb.y + vb.h; gy++) s += `<line x1="${vb.x}" y1="${gy}" x2="${vb.x + vb.w}" y2="${gy}"/>`;
      s += '</g>';
    }
    for (const r of rooms) {
      const sel = planState.selected === r.id;
      const [cx, cy] = roomCenter(r);
      const bb = roomBBox(r);
      const path = roomPath(r);
      const edges = roomEdges(r);
      const showNums = !isStandardRoom(r);
      s += `<g>
        <path class="room ${sel ? 'sel' : ''}" data-drag="move" data-room="${r.id}" d="${path}"/>
        <path class="wall-outline" d="${path}"/>
        ${(r.objects || []).map((o, k) => furnSvg(o, r, planState.edit && sel && planState.furnList ? k + 1 : null)).join('')}
        <text class="room-label" x="${cx}" y="${cy}">${esc(r.name)}</text>
        ${r.wallTop && Object.keys(r.wallTop).length ? `<text class="room-label room-h" x="${cx}" y="${cy - 0.45}">${roomHeightText(r)}</text>` : ''}`;
      for (const e of edges) {
        const key = `${r.id}:${e.id}`;
        const cnt = counts[key] || 0;
        if (!planState.edit) {
          s += `<line class="wall-hit" data-wall="${key}" x1="${e.a[0]}" y1="${e.a[1]}" x2="${e.b[0]}" y2="${e.b[1]}"/>`;
          if (showNums) {
            s += `<text class="wall-num" x="${e.mid[0] + e.nx * 0.22}" y="${e.mid[1] + e.ny * 0.22}">${e.i + 1}</text>`;
          }
          if (cnt > 0) {
            const off = showNums ? 0.6 : 0.45;
            const bx = e.mid[0] + e.nx * off, by = e.mid[1] + e.ny * off;
            s += `<g class="badge" data-wall="${key}"><circle cx="${bx}" cy="${by}" r="0.32"/><text x="${bx}" y="${by}">${cnt}</text></g>`;
            if (points[key]) {
              const px2 = bx + e.ux * 0.8, py2 = by + e.uy * 0.8;
              s += `<g class="badge pts" data-wall="${key}"><circle cx="${px2}" cy="${py2}" r="0.32"/><text x="${px2}" y="${py2}">⚡${points[key]}</text></g>`;
            }
          }
        } else if (sel) {
          const ws = planState.sel && planState.sel.type === 'wall' && planState.sel.i === e.i;
          s += `<line class="wall-hit edit ${ws ? 'sel' : ''}" data-edge="${e.i}" x1="${e.a[0]}" y1="${e.a[1]}" x2="${e.b[0]}" y2="${e.b[1]}"/>`;
          if (ws) s += `<text class="wall-len" x="${e.mid[0] + e.nx * 0.3}" y="${e.mid[1] + e.ny * 0.3}">${e.len.toFixed(2).replace('.', ',')} м</text>`;
        }
      }
      // проёмы как на архитектурном плане: окно — вставка в стене, дверь — разрыв, полотно и дуга открывания, проход — разрыв
      for (const e of edges) {
        for (const o of ((r.openings || {})[e.id] || [])) {
          if (o.kind === 'mirror' || !(o.w > 0)) continue;
          const t0 = Math.max(0, o.x != null ? o.x : (e.len - o.w) / 2), t1 = Math.min(e.len, t0 + o.w);
          if (t1 - t0 < 0.05) continue;
          const P = t => [e.a[0] + e.ux * t, e.a[1] + e.uy * t];
          const [ax, ay] = P(t0), [bx, by] = P(t1);
          const deg = Math.atan2(e.uy, e.ux) * 180 / Math.PI;
          const gap = `<rect class="op-gap" x="0" y="-0.075" width="${t1 - t0}" height="0.15" transform="translate(${ax} ${ay}) rotate(${deg})"/>`;
          if (o.kind === 'window') {
            s += `<g transform="translate(${ax} ${ay}) rotate(${deg})"><rect class="op-win" x="0" y="-0.075" width="${t1 - t0}" height="0.15"/><line class="op-win-l" x1="0" y1="0" x2="${t1 - t0}" y2="0"/></g>`;
          } else if (o.passage) {
            s += gap + `<line class="op-jamb" x1="${ax - e.nx * 0.08}" y1="${ay - e.ny * 0.08}" x2="${ax + e.nx * 0.08}" y2="${ay + e.ny * 0.08}"/><line class="op-jamb" x1="${bx - e.nx * 0.08}" y1="${by - e.ny * 0.08}" x2="${bx + e.nx * 0.08}" y2="${by + e.ny * 0.08}"/>`;
          } else {
            const w = t1 - t0, lx = ax + e.nx * w, ly = ay + e.ny * w;
            const sweep = (e.nx * e.uy - e.ny * e.ux) > 0 ? 1 : 0;
            s += gap + `<line class="op-leaf" x1="${ax}" y1="${ay}" x2="${lx}" y2="${ly}"/><path class="op-arc" d="M${lx} ${ly} A${w} ${w} 0 0 ${sweep} ${bx} ${by}"/>`;
          }
        }
      }
      // размеры стен — снаружи комнаты вдоль стены; у стен со своей высотой — ещё и высота
      for (const e of edges) {
        if (planState.edit && sel && planState.sel && planState.sel.type === 'wall' && planState.sel.i === e.i) continue;
        if (e.len < 0.25) continue;
        let deg = Math.atan2(e.uy, e.ux) * 180 / Math.PI;
        if (deg > 90.5) deg -= 180; else if (deg <= -89.5) deg += 180;
        const x = e.mid[0] - e.nx * 0.3, y = e.mid[1] - e.ny * 0.3;
        let txt = fmtM(e.len);
        if (r.wallTop && r.wallTop[e.id]) {
          const hs = wallTop(r, e.id).map(q => q[1]);
          const h0 = hs[0], h1 = hs[hs.length - 1], lo = Math.min(...hs), hi = Math.max(...hs);
          txt += hi - lo < 0.015 ? ` · h ${fmtM(hi)}` : (Math.abs(Math.min(h0, h1) - lo) < 0.005 && Math.abs(Math.max(h0, h1) - hi) < 0.005 && !hs.some((h, k) => k && Math.abs(h - hs[k - 1]) > 0.005 && Math.abs(wallTop(r, e.id)[k][0] - wallTop(r, e.id)[k - 1][0]) < 1e-3) ? ` · h ${fmtM(h0)}→${fmtM(h1)}` : ` · h ${fmtM(lo)}–${fmtM(hi)}`);
        }
        const fs = Math.min(0.26, Math.max(0.14, e.len * 0.12));
        s += `<text class="wall-dim" style="font-size:${fs}px" transform="translate(${x} ${y}) rotate(${deg})">${txt}</text>`;
      }
      // радиусы скруглённых углов
      r.pts.forEach((V, i) => {
        if (!(V[2] > 0)) return;
        const P = r.pts[(i - 1 + r.pts.length) % r.pts.length], N = r.pts[(i + 1) % r.pts.length];
        const lp = Math.hypot(P[0] - V[0], P[1] - V[1]) || 1, ln = Math.hypot(N[0] - V[0], N[1] - V[1]) || 1;
        let bx = (P[0] - V[0]) / lp + (N[0] - V[0]) / ln, by = (P[1] - V[1]) / lp + (N[1] - V[1]) / ln;
        const bl = Math.hypot(bx, by) || 1; bx /= bl; by /= bl;
        const d = V[2] * 0.42 + 0.4;
        s += `<text class="wall-dim" style="font-size:0.2px" x="${V[0] + bx * d}" y="${V[1] + by * d}">R ${fmtM(V[2])}</text>`;
      });
      if (!planState.edit) {
        // пол, потолок, панорама — в меню по тапу внутри комнаты; здесь только счётчик, если фото уже есть
        const extra = [['c', '⬆'], ['f', '⬇'], ['p', '360°']]
          .map(([sf, ico]) => { const n = counts[`${r.id}:${sf}`] || 0; return n ? `${ico} ${n}` : ''; }).filter(Boolean);
        if (extra.length) s += `<text class="room-cnt" x="${cx}" y="${cy + 0.42}">${extra.join('   ')}</text>`;
      }
      if (planState.edit && sel) {
        if (r.pts.length < MAX_CORNERS) {
          for (const e of edges) {
            s += `<g class="handle add" data-add="${e.i}"><circle cx="${e.mid[0]}" cy="${e.mid[1]}" r="0.24"/><text x="${e.mid[0]}" y="${e.mid[1]}">+</text></g>`;
          }
        }
        r.pts.forEach((p, i) => {
          const vs = planState.sel && planState.sel.type === 'vertex' && planState.sel.i === i;
          s += `<circle class="handle v ${vs ? 'sel' : ''}" data-drag="vertex" data-i="${i}" cx="${p[0]}" cy="${p[1]}" r="0.3"/>`;
          if (vs) {
            const a = Math.round(cornerAngle(r, i));
            s += `<text class="wall-len" x="${p[0] + 0.4}" y="${p[1] - 0.4}">${a}°</text>`;
          }
        });
      }
      s += '</g>';
    }
    // временные точки режимов: обводка комнаты / масштаб подложки
    const tmp = planState.tmp;
    if (planState.mode === 'trace' && tmp.length) {
      s += `<polyline class="trace-line" points="${tmp.map(p => p.join(',')).join(' ')}"/>`;
      tmp.forEach((p, i) => { s += `<circle class="handle v ${i === 0 ? 'first' : ''}" cx="${p[0]}" cy="${p[1]}" r="${i === 0 ? 0.36 : 0.26}"/>`; });
    }
    if (planState.mode === 'scale') {
      tmp.forEach((p, i) => { s += `<g class="handle scale"><circle cx="${p[0]}" cy="${p[1]}" r="0.3"/><text x="${p[0]}" y="${p[1]}">${i + 1}</text></g>`; });
      if (tmp.length === 2) s += `<line class="trace-line" x1="${tmp[0][0]}" y1="${tmp[0][1]}" x2="${tmp[1][0]}" y2="${tmp[1][1]}"/>`;
    }
    svg.innerHTML = s;
  }
  draw();

  function toWorld(e) {
    return new DOMPoint(e.clientX, e.clientY).matrixTransform(svg.getScreenCTM().inverse());
  }
  const snap = v => Math.round(v * 10) / 10;

  let drag = null;

  svg.addEventListener('pointerdown', e => {
    if (!planState.edit) {
      const wallEl = e.target.closest('[data-wall]');
      if (wallEl) drag = { kind: 'tap-wall', key: wallEl.dataset.wall, sx: e.clientX, sy: e.clientY, moved: false };
      else {
        const roomEl = e.target.closest('[data-room]');
        if (roomEl) drag = { kind: 'tap-room', id: roomEl.dataset.room, sx: e.clientX, sy: e.clientY, moved: false };
      }
      return;
    }
    e.preventDefault();
    if (planState.mode === 'trace' || planState.mode === 'scale') {
      drag = { kind: 'tap-mode', sx: e.clientX, sy: e.clientY, moved: false, world: toWorld(e) };
      return;
    }
    if (planState.mode === 'underlay' && plan) {
      drag = { kind: 'underlay', start: toWorld(e), orig: { ox: plan.ox, oy: plan.oy }, moved: false };
      try { svg.setPointerCapture(e.pointerId); } catch {}
      return;
    }
    const addEl = e.target.closest('[data-add]');
    const edgeEl = e.target.closest('[data-edge]');
    const t = e.target.closest('[data-drag]');
    const room = selRoom();
    if (addEl && room) { drag = { kind: 'tap-add', i: +addEl.dataset.add, sx: e.clientX, sy: e.clientY, moved: false }; return; }
    if (edgeEl && room) { drag = { kind: 'tap-edge', i: +edgeEl.dataset.edge, sx: e.clientX, sy: e.clientY, moved: false }; return; }
    if (!t) {
      if (planState.selected !== null || planState.sel) { planState.selected = null; planState.sel = null; updateTools(); draw(); }
      return;
    }
    if (t.dataset.drag === 'vertex') {
      const i = +t.dataset.i;
      drag = { kind: 'vertex', room, i, start: toWorld(e), orig: room.pts[i].slice(), moved: false };
    } else {
      const rm = rooms.find(r => r.id === t.dataset.room);
      if (!rm) return;
      if (planState.selected !== rm.id) { planState.selected = rm.id; planState.sel = null; updateTools(); }
      drag = { kind: 'move', room: rm, start: toWorld(e), orig: rm.pts.map(p => p.slice()), moved: false };
    }
    try { svg.setPointerCapture(e.pointerId); } catch {}
    draw();
  });

  svg.addEventListener('pointermove', e => {
    if (!drag) return;
    if (drag.kind.startsWith('tap')) {
      if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 8) drag.moved = true;
      return;
    }
    const p = toWorld(e);
    const dx = p.x - drag.start.x, dy = p.y - drag.start.y;
    if (Math.abs(dx) + Math.abs(dy) > 0.05) drag.moved = true;
    if (drag.kind === 'underlay') {
      plan.ox = cm(drag.orig.ox + dx); plan.oy = cm(drag.orig.oy + dy);
    } else if (drag.kind === 'move') {
      const sx = snap(dx), sy = snap(dy);
      drag.room.pts = drag.orig.map(o => [cm(o[0] + sx), cm(o[1] + sy), ...o.slice(2)]);
    } else {
      const r = drag.room, n = r.pts.length;
      let x = snap(drag.orig[0] + dx), y = snap(drag.orig[1] + dy);
      // подтяжка к прямому углу: выравниваем по соседним вершинам
      const P = r.pts[(drag.i - 1 + n) % n], N = r.pts[(drag.i + 1) % n];
      if (Math.abs(x - P[0]) < 0.2) x = P[0]; else if (Math.abs(x - N[0]) < 0.2) x = N[0];
      if (Math.abs(y - P[1]) < 0.2) y = P[1]; else if (Math.abs(y - N[1]) < 0.2) y = N[1];
      r.pts[drag.i] = [x, y, ...drag.orig.slice(2)];
    }
    draw();
  });

  svg.addEventListener('pointerup', async e => {
    if (!drag) return;
    const d = drag; drag = null;
    if (d.kind === 'tap-wall') { if (!d.moved) nav(`#/p/${pid}/w/${encodeURIComponent(d.key)}`); return; }
    if (d.kind === 'tap-room') { if (!d.moved) roomMenu(d.id); return; }
    if (d.kind === 'tap-mode') { if (!d.moved) await modeTap(d.world); return; }
    if (d.kind === 'underlay') { if (d.moved) await dbPut('projects', project); return; }
    const room = selRoom();
    if (d.kind === 'tap-add') { if (!d.moved && room) await insertVertex(room, d.i); return; }
    if (d.kind === 'tap-edge') { if (!d.moved) { planState.sel = { type: 'wall', i: d.i }; updateTools(); draw(); } return; }
    if (d.kind === 'vertex' && !d.moved) { planState.sel = { type: 'vertex', i: d.i }; updateTools(); draw(); return; }
    if (d.moved) { await dbPut('rooms', d.room); updateTools(); }
  });
  svg.addEventListener('pointercancel', () => { drag = null; });

  async function insertVertex(room, i) {
    if (room.pts.length >= MAX_CORNERS) return toast(`Максимум ${MAX_CORNERS} углов`);
    const e = roomEdges(room)[i];
    room.pts.splice(i + 1, 0, [cm(e.mid[0]), cm(e.mid[1])]);
    room.wallIds.splice(i + 1, 0, newWallId());
    planState.sel = { type: 'vertex', i: i + 1 };
    await dbPut('rooms', room);
    updateTools(); draw();
  }

  async function deleteVertex(room, i) {
    if (room.pts.length <= 3) return toast('У комнаты должно остаться хотя бы 3 угла');
    const n = room.pts.length;
    const keep = room.wallIds[(i - 1 + n) % n], drop = room.wallIds[i];
    // стена «drop» сливается со стеной «keep»: фото и проёмы переезжают, ничего не теряется
    const photos = (await dbAll('photos', 'wallKey', `${room.id}:${drop}`));
    for (const p of photos) { p.wallKey = `${room.id}:${keep}`; await dbPut('photos', p); }
    if (room.openings && room.openings[drop]) {
      room.openings[keep] = [...(room.openings[keep] || []), ...room.openings[drop]];
      delete room.openings[drop];
    }
    if (room.labels) delete room.labels[drop];
    room.pts.splice(i, 1);
    room.wallIds.splice(i, 1);
    planState.sel = null;
    await dbPut('rooms', room);
    if (photos.length) toast(`${photos.length} фото перенесены на соседнюю стену`);
    updateTools(); draw();
  }

  /* --- режимы: обводка, масштаб подложки, сдвиг подложки --- */
  const MODE_TEXT = {
    trace: () => planState.tmp.length
      ? `Углов: ${planState.tmp.length}. Тапните следующий угол; тап по первому или «Готово» — замкнуть.`
      : 'Тапайте углы комнаты по порядку (по подложке или по сетке).',
    scale: () => planState.tmp.length ? 'Тапните второй конец известного отрезка' : 'Тапните первый конец стены с известной длиной',
    underlay: () => 'Тяните подложку пальцем, чтобы совместить с сеткой. «Готово» — закончить.',
  };
  function setMode(m) {
    planState.mode = m; planState.tmp = [];
    if (m) { planState.selected = null; planState.sel = null; }
    updateTools(); draw();
  }
  async function modeTap(w) {
    const tmp = planState.tmp;
    if (planState.mode === 'scale') {
      tmp.push([w.x, w.y]); draw(); updateTools();
      if (tmp.length < 2) return;
      const d = Math.hypot(tmp[1][0] - tmp[0][0], tmp[1][1] - tmp[0][1]);
      const t = prompt('Реальная длина этого отрезка, м:', '');
      const L = parseFloat(String(t || '').replace(',', '.'));
      if (L > 0 && d > 0.01) {
        const ratio = L / d;
        plan.k *= ratio;
        plan.ox = cm(tmp[0][0] - (tmp[0][0] - plan.ox) * ratio);
        plan.oy = cm(tmp[0][1] - (tmp[0][1] - plan.oy) * ratio);
        await dbPut('projects', project);
        toast('Масштаб подложки задан');
      }
      planState.mode = null; planState.tmp = [];
      render();
      return;
    }
    if (planState.mode === 'trace') {
      let p = [Math.round(w.x * 20) / 20, Math.round(w.y * 20) / 20];
      if (tmp.length >= 3 && Math.hypot(p[0] - tmp[0][0], p[1] - tmp[0][1]) < 0.35) return finishTrace();
      if (tmp.length >= MAX_CORNERS) return toast(`Максимум ${MAX_CORNERS} углов — нажмите «Готово»`);
      const P = tmp[tmp.length - 1];
      if (P) { // лёгкая подтяжка к прямым углам
        if (Math.abs(p[0] - P[0]) < 0.12) p[0] = P[0];
        if (Math.abs(p[1] - P[1]) < 0.12) p[1] = P[1];
      }
      tmp.push(p); draw(); updateTools();
    }
  }
  async function finishTrace() {
    const tmp = planState.tmp;
    if (tmp.length < 3) return toast('Нужно хотя бы 3 угла');
    const name = prompt('Название комнаты:', 'Комната ' + (rooms.length + 1));
    if (name === null) return;
    await createRoom(pid, rooms, tmp.map(p => p.slice()), name.trim() || null);
  }

  function updateTools() {
    const roomTools = $('#room-tools'), vTools = $('#vertex-tools'), wTools = $('#wall-tools'), hint = $('#editor-hint');
    if (!roomTools) return;
    const mode = planState.mode;
    $('#mode-tools').classList.toggle('hidden', !mode);
    $('#create-tools').classList.toggle('hidden', !!mode);
    if (mode) {
      $('#mode-text').textContent = MODE_TEXT[mode]();
      $('#mode-done').classList.toggle('hidden', mode === 'scale');
      roomTools.classList.add('hidden'); vTools.classList.add('hidden'); wTools.classList.add('hidden'); hint.classList.add('hidden');
      return;
    }
    const room = selRoom();
    const sel = room ? planState.sel : null;
    roomTools.classList.toggle('hidden', !room || !!sel);
    vTools.classList.toggle('hidden', !(sel && sel.type === 'vertex'));
    wTools.classList.toggle('hidden', !(sel && sel.type === 'wall'));
    hint.classList.toggle('hidden', !!room);
    if (!room) return;

    if (!sel) {
      const inp = $('#room-name');
      inp.value = room.name;
      inp.oninput = () => {
        room.name = inp.value;
        clearTimeout(inp._t); inp._t = setTimeout(() => dbPut('rooms', room), 400);
        draw();
      };
      const ceilInp = $('#room-ceil');
      ceilInp.value = room.ceil || '';
      if (room.wallTop && Object.keys(room.wallTop).length) ceilInp.title = `Высота потолка. У части стен своя высота по обмеру (${roomHeightText(room)}) — её меняют у стены`;
      ceilInp.oninput = () => {
        const v = parseFloat(ceilInp.value);
        if (v > 0) room.ceil = v; else delete room.ceil;
        clearTimeout(ceilInp._t); ceilInp._t = setTimeout(() => dbPut('rooms', room), 400);
      };
      const furnBtn = $('#room-furn');
      furnBtn.classList.toggle('hidden', !(room.objects && room.objects.length));
      furnBtn.textContent = `🛋 Мебель (${(room.objects || []).length})`;
      furnBtn.onclick = () => furnitureSheet(room);
      $('#del-room').onclick = async () => {
        const photos = (await dbAll('photos', 'projectId', pid)).filter(p => p.wallKey.startsWith(room.id + ':'));
        const msg = photos.length
          ? `Удалить комнату «${room.name}»? Вместе с ней удалятся ${photos.length} фото её стен!`
          : `Удалить комнату «${room.name}»?`;
        if (!confirm(msg)) return;
        for (const p of photos) await dbDel('photos', p.id);
        await dbDel('rooms', room.id);
        planState.selected = null; planState.sel = null;
        render();
      };
    } else if (sel.type === 'vertex') {
      const i = sel.i;
      const ang = $('#v-angle'), rad = $('#v-radius');
      ang.value = Math.round(cornerAngle(room, i));
      rad.value = Math.round((room.pts[i][2] || 0) * 100);
      ang.onchange = async () => {
        const v = parseFloat(ang.value);
        if (!(v > 0 && v < 360)) return;
        setCornerAngle(room, i, v);
        await dbPut('rooms', room); draw();
      };
      rad.onchange = async () => {
        const v = parseFloat(rad.value);
        const p = room.pts[i];
        room.pts[i] = v > 0 ? [p[0], p[1], v / 100] : [p[0], p[1]];
        await dbPut('rooms', room); draw();
      };
      $('#del-vertex').onclick = () => deleteVertex(room, i);
    } else if (sel.type === 'wall') {
      const i = sel.i;
      const len = $('#w-len');
      len.value = roomEdges(room)[i].len.toFixed(2);
      len.onchange = async () => {
        const v = parseFloat(String(len.value).replace(',', '.'));
        if (!(v > 0)) return;
        setWallLength(room, i, v);
        await dbPut('rooms', room); draw();
      };
      const wh = $('#w-h'), wid = roomEdges(room)[i].id;
      wh.value = wallMaxH(room, wid).toFixed(2);
      if (!wallIsFlat(room, wid)) wh.title = 'Верх стены неровный (скос/короб по обмеру): ' + wallTop(room, wid).map(([f, h]) => `${Math.round(f * 100)}% → ${fmtM(h)}`).join(', ') + '. Новое значение сделает стену ровной.';
      wh.onchange = async () => {
        const v = parseFloat(String(wh.value).replace(',', '.'));
        if (!(v > 0)) return;
        room.wallTop = { ...(room.wallTop || {}) };
        if (Math.abs(v - roomCeil(room)) < 0.005) delete room.wallTop[wid]; else room.wallTop[wid] = [[0, cm(v)], [1, cm(v)]];
        await dbPut('rooms', room); draw();
      };
      $('#add-vertex').onclick = () => insertVertex(room, i);
    }
  }

  /* --- листы: подложка и мастер обмера --- */
  const sheet = $('#plan-sheet');
  function showSheet(html, wire) {
    sheet.innerHTML = html + '<button class="btn ghost wide" id="ps-cancel">Отмена</button>';
    sheet.classList.remove('hidden');
    sheet.querySelector('#ps-cancel').onclick = hideSheet;
    if (wire) wire(sheet);
  }
  function hideSheet() { sheet.classList.add('hidden'); sheet.classList.remove('furn-sheet'); sheet.innerHTML = ''; app.style.paddingBottom = ''; if (planState.furnList) { planState.furnList = false; draw(); } }

  // тап внутри комнаты: поверхности без стен — потолок, пол, панорама
  function roomMenu(roomId) {
    const r = rooms.find(x => x.id === roomId);
    if (!r) return;
    const cnt = sf => counts[`${r.id}:${sf}`] || 0;
    const item = (sf, ico, name) => `<button class="btn wide" data-go="${sf}">${ico} ${name}${cnt(sf) ? ` <small class="mut">· ${cnt(sf)} фото</small>` : ''}</button>`;
    showSheet(`<div class="sh-title">${esc(r.name)}</div>
      <p class="mut small">Фото стен — тап по стене на схеме.${r.measured === 'lidar' ? ' Комната обмерена лидаром.' : ''}</p>
      ${item('c', '⬆', 'Потолок')}${item('f', '⬇', 'Пол')}${item('p', '🌐', 'Панорама 360°')}`, sh => {
      sh.querySelectorAll('[data-go]').forEach(b => b.onclick = () => { hideSheet(); nav(`#/p/${pid}/w/${encodeURIComponent(r.id + ':' + b.dataset.go)}`); });
    });
  }

  // мебель комнаты: номера на схеме, смена типа (если RoomPlan ошибся) и удаление
  function furnitureSheet(room) {
    planState.furnList = true; draw();
    sheet.classList.add('furn-sheet');
    // комната должна быть видна над списком: даём странице запас снизу и прокручиваем к комнате
    app.style.paddingBottom = '60vh';
    const el = document.querySelector('#plan path.room.sel') || $('#plan-box'), top = document.querySelector('.topbar');
    window.scrollTo({ top: Math.max(0, el.getBoundingClientRect().top + scrollY - (top ? top.offsetHeight : 0) - 12) });
    const list = room.objects || [];
    showSheet(`<div class="sh-title">Мебель: ${esc(room.name)}</div>
      <p class="mut small">Распознано лидаром (RoomPlan). Номера — на схеме. Если тип определён неверно — выберите правильный.</p>
      ${list.map((o, k) => `<div class="furn-row">
        <b>${k + 1}</b>
        <select class="inp" data-ft="${k}">${FURN_TYPES.map(t => `<option value="${t}" ${t === o.cat ? 'selected' : ''}>${esc(OBJECT_NAMES[t] || t)}</option>`).join('')}</select>
        <span class="mut small">${fmtM(o.w)}×${fmtM(o.d)}${furnName(o) !== (OBJECT_NAMES[o.cat] || o.cat) ? `<br>${esc(furnName(o).toLowerCase())}` : ''}</span>
        <button class="iconbtn danger" data-fdel="${k}" title="Удалить">🗑</button>
      </div>`).join('') || '<p class="mut">Мебели нет.</p>'}`, sh => {
      sh.querySelectorAll('[data-ft]').forEach(s => s.onchange = async () => {
        const o = list[+s.dataset.ft]; o.cat = s.value; o.attrs = [];
        await dbPut('rooms', room); draw();
      });
      sh.querySelectorAll('[data-fdel]').forEach(b => b.onclick = async () => {
        const k = +b.dataset.fdel;
        if (!confirm(`Удалить «${furnName(list[k])}» со схемы и из 3D?`)) return;
        list.splice(k, 1); room.objects = list;
        await dbPut('rooms', room); hideSheet(); render();
      });
    });
  }

  function underlaySheet() {
    showSheet(`
      <div class="sh-title">Подложка: план БТИ, скан, фото плана</div>
      <p class="mut small">${plan ? `Загружена, масштаб ${(plan.w * plan.k).toFixed(1).replace('.', ',')} м по ширине.` : 'Загрузите план — и обводите комнаты по нему тапами.'}</p>
      <button class="btn wide" id="ps-load">🖼 ${plan ? 'Заменить план' : 'Загрузить план'}</button>
      ${plan ? `
        <button class="btn primary wide" id="ps-scale">📏 Задать масштаб (2 точки + длина)</button>
        <button class="btn wide" id="ps-move">✥ Подвинуть подложку</button>
        <button class="btn wide" id="ps-toggle">${planState.underlayHidden ? '👁 Показать' : '🙈 Скрыть'}</button>
        <button class="btn danger wide" id="ps-del">Удалить подложку</button>` : ''}`, s => {
      s.querySelector('#ps-load').onclick = () => { hideSheet(); $('#underlay-file').click(); };
      const q = id => s.querySelector(id);
      if (q('#ps-scale')) q('#ps-scale').onclick = () => { hideSheet(); setMode('scale'); };
      if (q('#ps-move')) q('#ps-move').onclick = () => { hideSheet(); setMode('underlay'); };
      if (q('#ps-toggle')) q('#ps-toggle').onclick = () => { planState.underlayHidden = !planState.underlayHidden; hideSheet(); render(); };
      if (q('#ps-del')) q('#ps-del').onclick = async () => {
        if (!confirm('Удалить подложку? Комнаты останутся.')) return;
        delete project.plan; await dbPut('projects', project); hideSheet(); render();
      };
    });
  }
  $('#underlay-file').onchange = async () => {
    const file = $('#underlay-file').files && $('#underlay-file').files[0];
    $('#underlay-file').value = '';
    if (!file) return;
    toast('Загружаю план…');
    try {
      const blob = await compressImage(file, 2000, 0.85);
      const bmp = await createImageBitmap(blob);
      const w = bmp.width, h = bmp.height; bmp.close();
      project.plan = { blob, w, h, k: 12 / w, ox: 0, oy: 0 }; // стартовый масштаб: 12 м по ширине
      planState.underlayHidden = false;
      await dbPut('projects', project);
      toast('План загружен. Теперь задайте масштаб по известной стене');
      planState.mode = 'scale'; planState.tmp = [];
      render();
    } catch (err) {
      console.error(err); toast('Не удалось открыть изображение');
    }
  };

  function wizardSheet() {
    const walls = [];
    const rowsHTML = () => walls.length
      ? `<ol class="wz-list">${walls.map((w, i) => `<li>Стена ${i + 1}: <b>${String(w.len).replace('.', ',')} м</b>, угол к следующей ${w.ang}°</li>`).join('')}</ol>`
      : '<p class="mut small">Идите вдоль стен по часовой стрелке. Угол — внутренний, между этой стеной и следующей (90 — прямой, 270 — внутренний выступ). Последняя стена замкнётся сама.</p>';
    showSheet(`
      <div class="sh-title">Комната по обмеру</div>
      <div id="wz-rows">${rowsHTML()}</div>
      <div class="wz-inputs">
        <label>Длина, м <input id="wz-len" class="inp" type="number" step="0.01" min="0.1" inputmode="decimal"></label>
        <label>Угол, ° <input id="wz-ang" class="inp" type="number" step="1" min="1" max="359" value="90" inputmode="numeric"></label>
      </div>
      <button class="btn wide" id="wz-add">+ Добавить стену</button>
      <button class="btn primary wide" id="wz-close">Замкнуть контур и создать комнату</button>`, s => {
      const lenI = s.querySelector('#wz-len'), angI = s.querySelector('#wz-ang');
      lenI.focus();
      s.querySelector('#wz-add').onclick = () => {
        const len = parseFloat(String(lenI.value).replace(',', '.')), ang = parseFloat(angI.value);
        if (!(len > 0)) return toast('Введите длину стены');
        if (!(ang > 0 && ang < 360)) return toast('Угол от 1 до 359°');
        if (walls.length >= MAX_CORNERS - 1) return toast(`Максимум ${MAX_CORNERS} углов`);
        walls.push({ len, ang });
        s.querySelector('#wz-rows').innerHTML = rowsHTML();
        lenI.value = ''; angI.value = '90'; lenI.focus();
      };
      s.querySelector('#wz-close').onclick = async () => {
        // незакрытый ввод в полях тоже считаем стеной
        const len = parseFloat(String(lenI.value).replace(',', '.')), ang = parseFloat(angI.value);
        if (len > 0 && ang > 0 && ang < 360 && walls.length < MAX_CORNERS - 1) walls.push({ len, ang });
        if (walls.length < 2) return toast('Нужно хотя бы две стены');
        const [x0, y0] = freeSpot(rooms, 1, 1);
        const pts = [[x0, y0]];
        let x = x0, y = y0, th = 0;
        for (const w of walls) {
          x += Math.cos(th) * w.len; y += Math.sin(th) * w.len;
          pts.push([cm(x), cm(y)]);
          th += (180 - w.ang) * Math.PI / 180; // поворот по часовой на экране
        }
        // замыкающая стена идёт от конца последней введённой стены к началу;
        // если пользователь ввёл и её — конец совпал с началом, дубликат убираем
        const last = pts[pts.length - 1];
        if (Math.hypot(last[0] - x0, last[1] - y0) < 0.05) pts.pop();
        if (pts.length < 3) return toast('Нужно хотя бы две стены');
        const name = prompt('Название комнаты:', 'Комната ' + (rooms.length + 1));
        if (name === null) return;
        hideSheet();
        await createRoom(pid, rooms, pts, name.trim() || null);
      };
    });
  }

  // лидар (только нативная iOS-версия на iPhone Pro)
  lidarAvailable().then(ok => {
    if (!ok) {
      if (Native.isNative && lidarDiag.error) toast('Модуль лидара не ответил — подробности в «Ещё → О приложении»');
      return;
    }
    const walkBtn = $('#lidar-walk'), measBtn = $('#lidar-measure'), aptBtn = $('#lidar-apt');
    if (walkBtn) {
      walkBtn.classList.remove('hidden');
      walkBtn.onclick = () => walkSheet();
    }
    if (aptBtn) {
      aptBtn.classList.remove('hidden');
      aptBtn.onclick = () => showSheet(`<div class="sh-title">Квартира целиком</div>
        <p class="mut small">Комнаты сканируются подряд в одной сессии: закончили комнату — «Следующая», перешли в другую. Существующие комнаты обновятся, новые добавятся.</p>
        <button class="btn primary wide" id="apt-measure"><span class="btn-ico">${ICONS.scan}</span>Обмер всей квартиры</button>
        <button class="btn wide" id="apt-final">🏁 Финальный скан (3D с текстурами)</button>`, sh => {
        sh.querySelector('#apt-measure').onclick = async () => { hideSheet(); try { await lidarApartment(pid, rooms, null); render(); } catch (err) { alert('Обмер не удался: ' + err.message); } };
        sh.querySelector('#apt-final').onclick = async () => {
          hideSheet();
          if (!confirm('Финальный скан лучше делать в конце ремонта: медленно обойдите все комнаты, поворачивая телефон ко всем поверхностям. Начать?')) return;
          try { await lidarFinal(pid, project, rooms); } catch (err) { alert('Скан не удался: ' + err.message); }
          render();
        };
      });
    }
    if (measBtn) {
      $('#lidar-row').classList.remove('hidden');
      const empty = $('.empty .mut');
      if (empty) empty.textContent = 'Нажмите «Обмер комнаты лидаром» и обойдите комнату вдоль стен — или «Редактор», чтобы нарисовать схему вручную.';
      measBtn.onclick = async () => {
        const room = selRoom();
        if (room && !confirm(`Переобмерить «${room.name}» лидаром? Схема комнаты заменится обмером, фото стен сохранятся.`)) return;
        try { await lidarMeasure(pid, rooms, room || null); render(); }
        catch (err) { alert('Обмер не удался: ' + err.message); }
      };
    }
  });
  async function walkSheet() {
    const stagesList = await dbAll('stages', 'projectId', pid);
    stagesList.sort((a, b) => a.ord - b.ord);
    let roomSel = rooms.length === 1 ? rooms[0] : null;
    const step2 = () => showSheet(`<div class="sh-title">Обход этапа: ${roomSel ? esc(roomSel.name) : 'вся квартира'}</div>
      <p class="mut small">Выберите этап — кадры стен снимутся сами и лягут на этот этап уже откалиброванными.</p>
      ${stagesList.map(s => `<button class="btn wide" data-stage="${s.id}">${esc(s.name)}</button>`).join('')}`, sh => {
      sh.querySelectorAll('[data-stage]').forEach(b => b.onclick = async () => {
        hideSheet();
        try {
          if (roomSel) await lidarWalk(pid, roomSel, b.dataset.stage);
          else await lidarApartment(pid, rooms, b.dataset.stage);
          render();
        } catch (err) { alert('Обход не удался: ' + err.message); }
      });
    });
    if (rooms.length === 1) return step2();
    showSheet(`<div class="sh-title">Обход этапа: что снимаем?</div>
      <button class="btn primary wide" data-room="*">🏢 Всю квартиру подряд</button>
      ${rooms.map(r => `<button class="btn wide" data-room="${r.id}">${esc(r.name)}</button>`).join('')}`, sh => {
      sh.querySelectorAll('[data-room]').forEach(b => b.onclick = () => { roomSel = b.dataset.room === '*' ? null : rooms.find(r => r.id === b.dataset.room); step2(); });
    });
  }

  if (planState.edit) {
    $('#trace-room').onclick = () => setMode('trace');
    $('#wizard-room').onclick = wizardSheet;
    $('#underlay-menu').onclick = underlaySheet;
    $('#mode-done').onclick = async () => {
      if (planState.mode === 'trace') return finishTrace();
      if (planState.mode === 'underlay') { await dbPut('projects', project); }
      planState.mode = null; planState.tmp = []; render();
    };
    $('#mode-cancel').onclick = () => { planState.mode = null; planState.tmp = []; render(); };
    updateTools();
  }
}

/* ---------- экран: этапы ---------- */

// режим выбора этапов (удаление нескольких); сбрасывается при уходе с экрана
const stageSel = { pid: null, on: false, ids: new Set() };

async function viewStages(pid) {
  const { project, stages, photos } = await loadProjectData(pid);
  if (!project) return nav('');
  if (stageSel.pid !== pid) { stageSel.pid = pid; stageSel.on = false; stageSel.ids.clear(); }
  for (const id of [...stageSel.ids]) if (!stages.some(s => s.id === id)) stageSel.ids.delete(id);
  const counts = {};
  photos.forEach(p => { counts[p.stageId] = (counts[p.stageId] || 0) + 1; });

  app.innerHTML = `
    ${header('Этапы ремонта', `#/p/${pid}`)}
    <div class="pad">
      <div class="stage-toolbar">
        <p class="mut small">${stageSel.on ? 'Отметьте этапы, которые нужно удалить.' : 'Порядок — перетаскивайте за ⠿. Статус — тап по плашке. Название — тап по нему.'}</p>
        ${stages.length ? `<button class="btn small-btn" id="stage-select">${stageSel.on ? 'Готово' : '☑ Выбрать'}</button>` : ''}
      </div>
      <div class="cards ${stageSel.on ? 'selecting' : ''}" id="stage-list">
        ${stages.map(s => `
          <div class="card stage-row ${stageSel.ids.has(s.id) ? 'picked' : ''}" data-id="${s.id}">
            ${stageSel.on
              ? `<span class="stage-check" data-pick="${s.id}">${stageSel.ids.has(s.id) ? '☑' : '☐'}</span>`
              : `<span class="drag-handle" title="Перетащите, чтобы поменять порядок" aria-label="Переместить">⠿</span>`}
            <div class="stage-main" ${stageSel.on ? `data-pick="${s.id}"` : ''}>
              <div class="stage-name" ${stageSel.on ? '' : `data-rename="${s.id}"`}>${esc(s.name)}</div>
              <div class="mut small stage-sub">${counts[s.id] || 0} фото${s.hint ? ` · <span class="stage-hint">${esc(s.hint)}</span>` : ''}</div>
            </div>
            ${stageSel.on ? '' : `<button class="chip ${STATUS[s.status || 0].cls}" data-status="${s.id}">${STATUS[s.status || 0].t}</button>`}
          </div>`).join('')}
      </div>
      ${stageSel.on ? '' : `<button class="btn primary wide" id="add-stage">+ Добавить этап</button>
      <button class="btn wide" id="apply-template">📋 Взять этапы из шаблона</button>`}
    </div>
    ${stageSel.on ? `<div class="sel-bar">
      <button class="btn small-btn" id="sel-all">${stageSel.ids.size === stages.length ? 'Снять все' : 'Все'}</button>
      <button class="btn small-btn danger" id="sel-del" ${stageSel.ids.size ? '' : 'disabled'}>🗑 Удалить${stageSel.ids.size ? ` (${stageSel.ids.size})` : ''}</button>
      <button class="btn small-btn" id="sel-cancel">Отмена</button>
    </div>` : ''}
    ${bottomNav(pid, 'stages')}`;

  const selBtn = $('#stage-select');
  if (selBtn) selBtn.onclick = () => { stageSel.on = !stageSel.on; stageSel.ids.clear(); render(); };
  if (stageSel.on) {
    $('#sel-cancel').onclick = () => { stageSel.on = false; stageSel.ids.clear(); render(); };
    $('#sel-all').onclick = () => {
      if (stageSel.ids.size === stages.length) stageSel.ids.clear(); else stages.forEach(s => stageSel.ids.add(s.id));
      render();
    };
    $('#sel-del').onclick = async () => {
      const chosen = stages.filter(s => stageSel.ids.has(s.id));
      if (!chosen.length) return;
      const ph = photos.filter(p => stageSel.ids.has(p.stageId));
      const names = chosen.slice(0, 6).map(s => '• ' + s.name).join('\n') + (chosen.length > 6 ? `\n… и ещё ${chosen.length - 6}` : '');
      if (!confirm(`Удалить этапы (${chosen.length})?\n${names}${ph.length ? `\n\nВместе с ними удалятся ${ph.length} фото!` : ''}`)) return;
      if (ph.length && !confirm(`Точно удалить ${ph.length} фото? Восстановить будет нельзя (только из резервной копии).`)) return;
      for (const p of ph) await dbDel('photos', p.id);
      for (const s of chosen) await dbDel('stages', s.id);
      const rest = stages.filter(s => !stageSel.ids.has(s.id));
      for (let i = 0; i < rest.length; i++) if (rest[i].ord !== i) { rest[i].ord = i; await dbPut('stages', rest[i]); }
      stageSel.on = false; stageSel.ids.clear();
      toast(`Удалено этапов: ${chosen.length}`);
      render();
    };
  }

  // перетаскивание этапов за ⠿
  const list = $('#stage-list');
  let drag = null;
  const rowTop = row => row.getBoundingClientRect().top - (drag && drag.row === row ? drag.dy : 0);
  list.addEventListener('pointerdown', e => {
    const h = e.target.closest('.drag-handle');
    if (!h) return;
    e.preventDefault();
    const row = h.closest('.stage-row');
    h.setPointerCapture(e.pointerId);
    drag = { row, h, startY: e.clientY, dy: 0, scroll: 0 };
    row.classList.add('dragging');
  });
  const moveDrag = clientY => {
    if (!drag) return;
    const { row } = drag;
    const shift = (el, before) => {
      const t0 = rowTop(row);
      if (before) list.insertBefore(row, el); else list.insertBefore(el, row);
      row.style.transform = 'none';
      const t1 = row.getBoundingClientRect().top;
      drag.startY += t1 - t0; drag.dy = 0;
    };
    // быстрый рывок — проскакиваем сразу несколько этапов
    for (let guard = 0; guard < 50; guard++) {
      const dy = clientY - drag.startY;
      const prev = row.previousElementSibling, next = row.nextElementSibling;
      if (next && dy > next.offsetHeight / 2 + 5) shift(next, false);
      else if (prev && dy < -(prev.offsetHeight / 2 + 5)) shift(prev, true);
      else break;
    }
    drag.dy = clientY - drag.startY;
    row.style.transform = `translateY(${drag.dy}px)`;
  };
  list.addEventListener('pointermove', e => {
    if (!drag) return;
    drag.lastY = e.clientY;
    moveDrag(e.clientY);
    // автопрокрутка у краёв экрана
    const edge = e.clientY < 110 ? -1 : e.clientY > innerHeight - 130 ? 1 : 0;
    if (edge && !drag.timer) {
      drag.timer = setInterval(() => {
        if (!drag) return;
        const y0 = scrollY; scrollBy(0, edge * 10);
        drag.startY -= scrollY - y0;
        moveDrag(drag.lastY);
      }, 16);
    } else if (!edge && drag.timer) { clearInterval(drag.timer); drag.timer = null; }
  });
  const endDrag = async () => {
    if (!drag) return;
    const { row } = drag;
    if (drag.timer) clearInterval(drag.timer);
    row.classList.remove('dragging'); row.style.transform = '';
    drag = null;
    const order = [...list.querySelectorAll('.stage-row')].map(r => r.dataset.id);
    let changed = 0;
    for (let i = 0; i < order.length; i++) {
      const s = stages.find(x => x.id === order[i]);
      if (s && s.ord !== i) { s.ord = i; await dbPut('stages', s); changed++; }
    }
    if (changed) render();
  };
  list.addEventListener('pointerup', endDrag);
  list.addEventListener('pointercancel', endDrag);

  if (!stageSel.on) $('#apply-template').onclick = () => templateSheet(async tpl => {
    const withPhotos = stages.filter(s => counts[s.id]);
    const msg = withPhotos.length
      ? `Этапы без фото заменятся шаблоном, ${withPhotos.length} этапов с фото останутся в конце списка. Продолжить?`
      : 'Заменить текущий список этапов шаблоном?';
    if (!confirm(msg)) return;
    for (const s of stages) if (!counts[s.id]) await dbDel('stages', s.id);
    await createStagesFromTemplate(pid, tpl);
    const list = tpl && tpl.stages ? tpl.stages.length : DEFAULT_STAGES.length;
    withPhotos.forEach(async (s, i) => { s.ord = list + i; await dbPut('stages', s); });
    setTimeout(render, 200);
  });
  if (!stageSel.on) $('#add-stage').onclick = async () => {
    const name = prompt('Название этапа:');
    if (!name || !name.trim()) return;
    const maxOrd = stages.length ? Math.max(...stages.map(s => s.ord)) : -1;
    await dbPut('stages', { id: uid(), projectId: pid, name: name.trim(), ord: maxOrd + 1, status: 0 });
    render();
  };

  $('#stage-list').addEventListener('click', async e => {
    if (stageSel.on) {
      const row = e.target.closest('.stage-row');
      if (!row) return;
      const id = row.dataset.id;
      if (stageSel.ids.has(id)) stageSel.ids.delete(id); else stageSel.ids.add(id);
      render();
      return;
    }
    const b = e.target.closest('button, [data-rename]');
    if (!b) return;
    const find = id => stages.find(s => s.id === id);
    if (b.dataset.status) {
      const s = find(b.dataset.status);
      s.status = ((s.status || 0) + 1) % 3;
      await dbPut('stages', s); render();
    } else if (b.dataset.up || b.dataset.down) {
      const id = b.dataset.up || b.dataset.down;
      const i = stages.findIndex(s => s.id === id);
      const j = b.dataset.up ? i - 1 : i + 1;
      if (j < 0 || j >= stages.length) return;
      [stages[i].ord, stages[j].ord] = [stages[j].ord, stages[i].ord];
      await dbPut('stages', stages[i]); await dbPut('stages', stages[j]); render();
    } else if (b.dataset.del) {
      const s = find(b.dataset.del);
      const cnt = photos.filter(p => p.stageId === s.id).length;
      const msg = cnt
        ? `Удалить этап «${s.name}»? Вместе с ним удалятся ${cnt} фото!`
        : `Удалить этап «${s.name}»?`;
      if (!confirm(msg)) return;
      for (const p of photos.filter(p => p.stageId === s.id)) await dbDel('photos', p.id);
      await dbDel('stages', s.id); render();
    } else if (b.dataset.rename) {
      const s = find(b.dataset.rename);
      const name = prompt('Название этапа:', s.name);
      if (!name || !name.trim()) return;
      s.name = name.trim();
      await dbPut('stages', s); render();
    }
  });
}

/* ---------- экран: стена ---------- */

async function viewWall(pid, wallKey) {
  const { project, rooms, stages, photos } = await loadProjectData(pid);
  if (!project) return nav('');
  const { roomId, side } = parseWallKey(wallKey);
  const room = rooms.find(r => r.id === roomId);
  if (!room) { toast('Стена не найдена'); return nav(`#/p/${pid}`); }
  const wallPhotos = photos.filter(p => p.wallKey === wallKey);
  const byStage = {};
  wallPhotos.forEach(p => { (byStage[p.stageId] = byStage[p.stageId] || []).push(p); });
  Object.values(byStage).forEach(list => list.sort((a, b) => a.created - b.created));
  const stagesWithPhotos = stages.filter(s => byStage[s.id] && byStage[s.id].length);

  app.innerHTML = `
    ${header(wallLabel(room, side), `#/p/${pid}`,
      `<button class="iconbtn" id="rename-wall" title="Переименовать стену">✎</button>`)}
    <div class="pad">
      ${side === 'p' ? `
        <p class="mut small">Снимите комнату из центра штатной камерой в режиме «Панорама» (или 360°-камерой) и добавьте снимок через «Галерея» на нужный этап. Смотреть — в 3D-туре.</p>
        <button class="btn primary wide" id="open-pano" ${wallPhotos.length ? '' : 'disabled'}>🌐 Открыть панораму в туре</button>` : stagesWithPhotos.length >= 2 ? `
        <button class="btn primary wide" data-nav="#/p/${pid}/cmp/${encodeURIComponent(wallKey)}">
          ⇆ Сравнить «до / после»</button>` : `
        <p class="mut small center">Добавьте фото минимум на двух этапах — появится сравнение «до/после».</p>`}
      ${isWallId(room, side) ? `
        <div class="card" style="margin-top:12px">
          <div class="stage-photos-head">
            <b>Проёмы и зеркала</b>
            <button class="btn small-btn" id="add-opening">+ Добавить</button>
          </div>
          <div id="openings" class="openings">
            ${((room.openings || {})[side] || []).map((o, i) => `
              <span class="chip st0">${OPENING_KINDS[o.kind] ? OPENING_KINDS[o.kind].label : o.kind} ${String(o.w).replace('.', ',')}×${String(o.h).replace('.', ',')} м${o.x != null ? ` · слева ${String(o.x).replace('.', ',')}` : ''}
                <button class="chip-x" data-del-opening="${i}" title="Убрать">✕</button></span>`).join('') || '<span class="mut small">Нет проёмов — стена глухая</span>'}
          </div>
          <p class="mut small">Зеркало в 3D-туре отражает комнату по-настоящему — снимать его с отражением не нужно.</p>
        </div>` : ''}
      <div class="cards">
        ${stages.map(s => {
          const list = byStage[s.id] || [];
          return `<div class="card stage-photos">
            <div class="stage-photos-head">
              <b>${esc(s.name)}</b>${s.hint ? `<span class="hint-i" title="${esc(s.hint)}" data-hint="${esc(s.hint)}">ⓘ</span>` : ''}
              <span class="btn-pair">
                <button class="btn small-btn" data-shoot="${s.id}">📷 Снять</button>
                <button class="btn small-btn" data-pick="${s.id}">🖼 Галерея</button>
              </span>
            </div>
            ${list.length ? `<div class="thumbs">
              ${list.map(p => {
                const n = (p.marks || []).length;
                return `<div class="thumb-wrap" data-view="${p.id}">
                  <img class="thumb" src="${newURL(p.blob)}" alt="">
                  ${p.calib ? '<span class="thumb-badge calib">📏</span>' : ''}
                  ${n ? `<span class="thumb-badge">${n}</span>` : ''}
                </div>`;
              }).join('')}
            </div>` : `<div class="mut small">Нет фото</div>`}
          </div>`;
        }).join('')}
      </div>
    </div>
    <input type="file" id="cam" accept="image/*" capture="environment" class="hidden-input">
    <input type="file" id="gal" accept="image/*" multiple class="hidden-input">
    <div id="viewer" class="viewer hidden"></div>`;

  $('#rename-wall').onclick = async () => {
    const name = prompt('Название поверхности:', wallLabel(room, side));
    if (!name || !name.trim()) return;
    room.labels = room.labels || {};
    room.labels[side] = name.trim();
    await dbPut('rooms', room); render();
  };

  const openPano = $('#open-pano');
  if (openPano) openPano.onclick = () => { tourState.mode = 'pano'; nav(`#/p/${pid}/tour/${roomId}`); };

  app.querySelectorAll('[data-hint]').forEach(el => { el.onclick = () => toast(el.dataset.hint); });

  const addOp = $('#add-opening');
  if (addOp) {
    addOp.onclick = async () => {
      const kt = prompt('Что добавить? д — дверь, о — окно, з — зеркало', 'д');
      if (kt === null) return;
      const kind = { 'д': 'door', 'd': 'door', 'о': 'window', 'o': 'window', 'з': 'mirror', 'z': 'mirror', 'm': 'mirror' }[String(kt).trim().toLowerCase()[0]] || 'door';
      const def = OPENING_KINDS[kind];
      const t = prompt(`${def.label}: ширина и высота в метрах, затем (необязательно) отступ от левого угла и высота от пола.\nНапример: ${def.example}`, def.example);
      if (t === null) return;
      const nums = (String(t).replace(/,/g, '.').match(/\d+(\.\d+)?/g) || []).map(Number);
      if (nums.length < 2) return toast('Нужно хотя бы два числа: ширина и высота');
      const [w, h] = nums;
      if (!(w > 0 && h > 0)) return toast('Размеры должны быть больше нуля');
      const edge = roomEdge(room, side);
      const x = nums[2] != null ? nums[2] : cm(Math.max(0, ((edge ? edge.len : w) - w) / 2)); // по умолчанию — по центру стены
      const y = nums[3] != null ? nums[3] : def.y;
      room.openings = room.openings || {};
      (room.openings[side] = room.openings[side] || []).push({ kind, w, h, x, y });
      await dbPut('rooms', room); render();
    };
    app.querySelectorAll('[data-del-opening]').forEach(b => {
      b.onclick = async () => {
        room.openings[side].splice(+b.dataset.delOpening, 1);
        await dbPut('rooms', room); render();
      };
    });
  }

  const cam = $('#cam'), gal = $('#gal');
  let pendingStage = null;
  app.querySelectorAll('[data-shoot]').forEach(b => {
    b.onclick = () => { pendingStage = b.dataset.shoot; cam.click(); };
  });
  app.querySelectorAll('[data-pick]').forEach(b => {
    b.onclick = () => { pendingStage = b.dataset.pick; gal.click(); };
  });
  const importFiles = async (files, fromCamera) => {
    if (!files.length || !pendingStage) return;
    const by = userName(true);
    toast(files.length > 1 ? `Сохраняю ${files.length} фото…` : 'Сохраняю фото…');
    let ok = 0;
    for (const file of files) {
      try {
        // для снимков из галереи берём реальную дату съёмки из EXIF
        const shot = fromCamera ? null : await readExifDate(file);
        const blob = await compressImage(file);
        const rec = {
          id: uid(), projectId: pid, wallKey, stageId: pendingStage,
          blob, note: '', created: shot || file.lastModified || Date.now(), by,
        };
        await sealPhoto(rec, { source: fromCamera ? 'camera' : 'gallery' });
        await dbPut('photos', rec);
        ok++;
      } catch (err) {
        console.error(err);
        toast(`Не удалось открыть ${file.name}`);
      }
    }
    if (ok) toast(ok > 1 ? `Добавлено ${ok} фото` : 'Фото добавлено');
    render();
  };
  cam.onchange = () => { const f = [...cam.files]; cam.value = ''; importFiles(f, true); };
  gal.onchange = () => { const f = [...gal.files]; gal.value = ''; importFiles(f, false); };

  app.querySelectorAll('[data-view]').forEach(el => {
    el.onclick = () => {
      const photo = wallPhotos.find(p => p.id === el.dataset.view);
      if (!photo) return;
      openPhotoEditor(photo, {
        stages,
        wallTitle: wallLabel(room, side),
        wallSize: wallSizeOf(room, side),
        onClose: render,
        onGhost: async p => {
          if (await lidarAvailable()) {
            try { await lidarGhost(p, wallSizeOf(room, side)); } catch (err) { alert('AR-призрак не удался: ' + err.message); }
            return;
          }
          nav(`#/p/${pid}/ghost/${encodeURIComponent(wallKey)}/${p.id}`);
        },
      });
    };
  });
}

// проёмы и зеркала на стене: подпись, высота от пола по умолчанию, пример ввода
const OPENING_KINDS = {
  door: { label: '🚪 дверь', y: 0, example: '0,8 2,0' },
  window: { label: '🪟 окно', y: 0.9, example: '1,4 1,4 0,6 0,9' },
  mirror: { label: '🪞 зеркало', y: 1.0, example: '1,2 0,8 0,5 1,0' },
};

// ожидаемые размеры поверхности из схемы: ширина × высота (для калибровки по 4 углам)
function wallSizeOf(room, side) {
  const ceil = room.ceil || 2.7;
  if (side === 'p') return { w: null, h: null };
  if (side === 'c' || side === 'f') { const bb = roomBBox(room); return { w: cm(bb.w), h: cm(bb.h) }; }
  const e = roomEdge(room, side);
  return { w: e ? cm(e.len) : null, h: ceil };
}

/* ---------- экран: сравнение «до/после» ---------- */

const cmpState = { wallKey: null, a: null, b: null, pa: null, pb: null };

async function viewCompare(pid, wallKey) {
  const { project, rooms, stages, photos } = await loadProjectData(pid);
  if (!project) return nav('');
  const { roomId, side } = parseWallKey(wallKey);
  const room = rooms.find(r => r.id === roomId);
  if (!room) return nav(`#/p/${pid}`);

  const byStage = {};
  photos.filter(p => p.wallKey === wallKey)
    .forEach(p => { (byStage[p.stageId] = byStage[p.stageId] || []).push(p); });
  Object.values(byStage).forEach(list => list.sort((a, b) => b.created - a.created)); // свежие первыми
  const avail = stages.filter(s => byStage[s.id] && byStage[s.id].length);
  if (avail.length < 2) { toast('Нужны фото минимум на двух этапах'); return nav(`#/p/${pid}/w/${encodeURIComponent(wallKey)}`); }

  if (cmpState.wallKey !== wallKey) {
    Object.assign(cmpState, {
      wallKey, a: avail[0].id, b: avail[avail.length - 1].id, pa: null, pb: null,
    });
  }
  if (!byStage[cmpState.a]) cmpState.a = avail[0].id;
  if (!byStage[cmpState.b]) cmpState.b = avail[avail.length - 1].id;
  const photoOf = (stageId, chosenId) =>
    byStage[stageId].find(p => p.id === chosenId) || byStage[stageId][0];
  const pa = photoOf(cmpState.a, cmpState.pa);
  const pb = photoOf(cmpState.b, cmpState.pb);
  const stageName = id => { const s = stages.find(x => x.id === id); return s ? s.name : '?'; };

  const sel = (which, cur) => `
    <select class="inp cmp-sel" id="sel-${which}">
      ${avail.map(s => `<option value="${s.id}" ${s.id === cur ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}
    </select>`;
  const strip = (which, stageId, chosen) => byStage[stageId].length < 2 ? '' : `
    <div class="thumbs mini">
      ${byStage[stageId].map(p => `<img class="thumb mini ${p.id === chosen.id ? 'sel' : ''}"
        src="${newURL(p.blob)}" data-pick="${which}:${p.id}" alt="">`).join('')}
    </div>`;

  app.innerHTML = `
    ${header('До / после', `#/p/${pid}/w/${encodeURIComponent(wallKey)}`)}
    <div class="pad">
      <p class="center"><b>${esc(wallLabel(room, side))}</b></p>
      <div class="cmp-selects">
        <div class="cmp-col"><span class="mut small">Слева (до)</span>${sel('a', cmpState.a)}${strip('a', cmpState.a, pa)}</div>
        <div class="cmp-col"><span class="mut small">Справа (после)</span>${sel('b', cmpState.b)}${strip('b', cmpState.b, pb)}</div>
      </div>
      <div class="cmp" id="cmp">
        <img class="cmp-img" src="${newURL(pb.blob)}" alt="">
        <img class="cmp-img cmp-top" id="cmp-top" src="${newURL(pa.blob)}" alt="">
        <div class="cmp-handle" id="cmp-handle"><div class="cmp-knob">⇆</div></div>
        <span class="cmp-tag left">${esc(stageName(cmpState.a))}</span>
        <span class="cmp-tag right">${esc(stageName(cmpState.b))}</span>
      </div>
      <p class="mut small center">Тяните шторку пальцем влево-вправо</p>
    </div>`;

  $('#sel-a').onchange = e => { cmpState.a = e.target.value; cmpState.pa = null; render(); };
  $('#sel-b').onchange = e => { cmpState.b = e.target.value; cmpState.pb = null; render(); };
  app.querySelectorAll('[data-pick]').forEach(img => {
    img.onclick = () => {
      const [which, id] = img.dataset.pick.split(':');
      if (which === 'a') cmpState.pa = id; else cmpState.pb = id;
      render();
    };
  });

  const box = $('#cmp'), top = $('#cmp-top'), handle = $('#cmp-handle');
  let pos = 50;
  const apply = () => {
    top.style.clipPath = `inset(0 ${100 - pos}% 0 0)`;
    handle.style.left = pos + '%';
  };
  apply();
  let dragging = false;
  const move = e => {
    if (!dragging) return;
    const r = box.getBoundingClientRect();
    pos = Math.max(0, Math.min(100, (e.clientX - r.left) / r.width * 100));
    apply();
  };
  box.addEventListener('pointerdown', e => {
    dragging = true;
    try { box.setPointerCapture(e.pointerId); } catch {}
    move(e);
    e.preventDefault();
  });
  box.addEventListener('pointermove', move);
  box.addEventListener('pointerup', () => { dragging = false; });
  box.addEventListener('pointercancel', () => { dragging = false; });
}

/* ---------- экран: ещё ---------- */

async function viewMore(pid) {
  const { project, rooms, photos } = await loadProjectData(pid);
  if (!project) return nav('');

  app.innerHTML = `
    ${header('Ещё', `#/p/${pid}`)}
    <div class="pad">
      <div class="cards">
        <div class="card proj-name-card">
          <div class="proj-name-row"><b>${esc(project.name)}</b><button class="iconbtn" id="rename-project" title="Переименовать объект" aria-label="Переименовать объект">✏️</button></div>
          <div class="mut small">${rooms.length} комн. · ${photos.length} фото</div>
        </div>
        <button class="btn primary wide" data-nav="#/p/${pid}/report">📋 Задание для мастеров</button>
        <button class="btn wide" data-nav="#/p/${pid}/verify">🔒 Подлинность фото</button>
        <button class="btn wide" data-nav="#/p/${pid}/calc">🧮 Площади и материалы</button>
        <div class="card">
          <b>Команда объекта</b>
          <p class="mut small">Пока без сервера: обмен файлами. Владелец отправляет схему, рабочие снимают и отправляют фото обратно — при импорте всё сливается без дублей.</p>
          <button class="btn wide" id="share-plan">📤 Отправить схему коллегам (без фото)</button>
          <button class="btn wide" id="share-project">📤 Отправить объект с фото</button>
          <button class="btn wide" id="import-here">⬆ Импорт: схема или фото от коллег</button>
          <button class="btn ghost wide" id="set-name">👤 Подпись: ${esc(userName() || 'не задана')}</button>
        </div>
        <button class="btn danger wide" id="del-project">Удалить объект и все его данные</button>
      </div>
      <p class="mut small">Приложение работает офлайн, все данные — на устройстве. Резервная копия всех объектов — на главном экране; копия этого объекта — «Отправить объект с фото».</p>
      <details class="about"><summary>ℹ️ О приложении</summary><div class="mut small" id="diag" style="overflow-wrap:anywhere">Проверяю модуль лидара…</div></details>
    </div>
    ${bottomNav(pid, 'more')}`;

  nativeDiagnostics().then(d => {
    const el = $('#diag');
    if (el) el.innerHTML = Object.entries(d).map(([k, v]) => `<div><b>${esc(k)}:</b> ${esc(v)}</div>`).join('');
  }).catch(err => { const el = $('#diag'); if (el) el.textContent = 'Диагностика упала: ' + err.message; });
  $('#rename-project').onclick = async () => {
    const name = prompt('Название объекта:', project.name);
    if (!name || !name.trim()) return;
    project.name = name.trim();
    await dbPut('projects', project); render();
  };
  $('#share-plan').onclick = () => exportProject(pid, false);
  $('#share-project').onclick = () => exportProject(pid, true);
  $('#import-here').onclick = importBackup;
  $('#set-name').onclick = () => {
    const t = prompt('Ваше имя и роль (подпись на фото и пометках):', userName());
    if (t === null) return;
    try { localStorage.setItem('stenograf.user', t.trim()); } catch {}
    render();
  };
  $('#del-project').onclick = async () => { if (await deleteProject(pid)) nav(''); };
}

/* ---------- резервная копия ---------- */

function blobToDataURL(blob) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.onerror = () => rej(fr.error);
    fr.readAsDataURL(blob);
  });
}

// файл обмена: kind = 'backup' (всё), 'plan' (схема объекта без фото), 'photos' (объект с фото от участника)
async function buildExport(kind, projects, rooms, stages, photos) {
  const photosOut = [];
  for (const p of photos) {
    const { blob, original, ...meta } = p;
    const rec = { ...meta, data: await blobToDataURL(blob) };
    if (original) rec.originalData = await blobToDataURL(original);
    photosOut.push(rec);
  }
  const projectsOut = [];
  for (const p of projects) {
    const rec = { ...p };
    if (p.plan && p.plan.blob) { const { blob, ...planMeta } = p.plan; rec.plan = { ...planMeta, data: await blobToDataURL(blob) }; }
    if (p.finalScan && p.finalScan.blob) { const { blob, ...m } = p.finalScan; rec.finalScan = { ...m, data: await blobToDataURL(blob) }; }
    if (p.usdz) { delete rec.usdz; rec.usdzData = await blobToDataURL(p.usdz); }
    projectsOut.push(rec);
  }
  const roomsOut = [];
  for (const r of rooms) {
    const { usdz, ...rest } = r;
    roomsOut.push(usdz ? { ...rest, usdzData: await blobToDataURL(usdz) } : rest);
  }
  const payload = { app: 'stenograf', version: 2, kind, exported: Date.now(), by: userName(), projects: projectsOut, rooms: roomsOut, stages, photos: photosOut };
  return new Blob([JSON.stringify(payload)], { type: 'application/json' });
}

// отдать файл: через системное «Поделиться» (телефон) или скачиванием (ПК)
async function deliverFile(blob, name, title) {
  const file = new File([blob], name, { type: blob.type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title }); return; } catch (err) { if (err && err.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  toast('Файл сохранён в загрузки');
}

async function exportBackup() {
  toast('Готовлю копию…');
  const [projects, rooms, stages, photos] = await Promise.all([
    dbAll('projects'), dbAll('rooms'), dbAll('stages'), dbAll('photos'),
  ]);
  const blob = await buildExport('backup', projects, rooms, stages, photos);
  await deliverFile(blob, `stenograf-backup-${new Date().toISOString().slice(0, 10)}.json`, 'Резервная копия Стенографа');
}

async function exportProject(pid, withPhotos) {
  const { project, rooms, stages, photos } = await loadProjectData(pid);
  if (!project) return;
  toast(withPhotos ? 'Готовлю объект с фото…' : 'Готовлю схему…');
  const blob = await buildExport(withPhotos ? 'photos' : 'plan', [project], rooms, stages, withPhotos ? photos : []);
  const base = slug(project.name);
  await deliverFile(blob, `${base}-${withPhotos ? 'photos' : 'plan'}.json`,
    withPhotos ? `${project.name} — фото` : `${project.name} — схема`);
}

function importBackup() {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = 'application/json,.json';
  inp.onchange = async () => {
    const file = inp.files && inp.files[0];
    if (!file) return;
    try {
      await importData(JSON.parse(await file.text()));
    } catch (err) {
      alert('Не удалось импортировать: ' + err.message);
    }
  };
  inp.click();
}

// слияние данных из файла обмена в локальную базу (см. buildExport про kind)
async function importData(data) {
      if (data.app !== 'stenograf' || !Array.isArray(data.projects)) throw new Error('Это не файл Стенографа');
      const kind = data.kind || 'backup';
      const KIND_TEXT = { backup: 'резервную копию', plan: 'схему объекта', photos: 'фото от участника' };
      const who = data.by ? ` от «${data.by}»` : '';
      if (!confirm(`Импортировать ${KIND_TEXT[kind] || 'файл'}${who} (${fmtDate(data.exported || Date.now())})?\nОбъекты: ${data.projects.length}, фото: ${(data.photos || []).length}.\n${kind === 'photos' ? 'Новые фото и пометки добавятся, ваши данные не тронутся.' : 'Схема и этапы обновятся, фото не удаляются.'}`)) return;
      toast('Импортирую…');
      // 'plan' и 'backup' — авторитетная схема: перезаписываем объект/комнаты/этапы.
      // 'photos' — от участника: объект/схему добавляем только если у нас их ещё нет.
      const authoritative = kind !== 'photos';
      let added = 0, merged = 0;
      for (const p of data.projects || []) {
        if (p.plan && p.plan.data) {
          const { data: planData, ...planMeta } = p.plan;
          p.plan = { ...planMeta, blob: await (await fetch(planData)).blob() };
        }
        if (p.finalScan && p.finalScan.data) {
          const { data: fd, ...m } = p.finalScan;
          p.finalScan = { ...m, blob: await (await fetch(fd)).blob() };
        }
        if (p.usdzData) { p.usdz = await (await fetch(p.usdzData)).blob(); delete p.usdzData; }
        if (authoritative || !(await dbGet('projects', p.id))) await dbPut('projects', p);
      }
      for (const r of data.rooms || []) {
        if (r.usdzData) { r.usdz = await (await fetch(r.usdzData)).blob(); delete r.usdzData; }
        if (authoritative || !(await dbGet('rooms', r.id))) await dbPut('rooms', r);
      }
      for (const s of data.stages || []) if (authoritative || !(await dbGet('stages', s.id))) await dbPut('stages', s);
      for (const ph of data.photos || []) {
        const { data: dataUrl, originalData, ...meta } = ph;
        const mine = await dbGet('photos', ph.id);
        if (!mine) {
          const blob = await (await fetch(dataUrl)).blob();
          const rec = { ...meta, blob };
          if (originalData) rec.original = await (await fetch(originalData)).blob();
          await dbPut('photos', rec); added++;
        } else {
          // фото уже есть — подливаем только новые пометки и статусы «сделано»
          const ids = new Set((mine.marks || []).map(m => m.id));
          let changed = false;
          for (const m of ph.marks || []) {
            if (!ids.has(m.id)) { (mine.marks = mine.marks || []).push(m); changed = true; }
            else { const mm = mine.marks.find(x => x.id === m.id); if (m.done && !mm.done) { Object.assign(mm, { done: true, doneBy: m.doneBy, doneAt: m.doneAt }); changed = true; } }
          }
          if (!mine.calib && ph.calib) { mine.calib = ph.calib; changed = true; }
          if (changed) { await dbPut('photos', mine); merged++; }
        }
      }
      toast(`Импорт завершён: новых фото ${added}, дополнено ${merged}`);
      render();
      return { added, merged };
}

/* ---------- запуск ---------- */

// на телефоне нет консоли — показываем ошибки на экране, чтобы по скриншоту было видно причину
(() => {
  const shown = new Set();
  const report = (msg, where) => {
    const text = String(msg || 'неизвестная ошибка') + (where ? ` (${where})` : '');
    if (shown.has(text)) return; shown.add(text);
    let bar = document.getElementById('err-bar');
    if (!bar) {
      bar = document.createElement('div'); bar.id = 'err-bar';
      bar.style.cssText = 'position:fixed;left:8px;right:8px;bottom:calc(70px + env(safe-area-inset-bottom));z-index:99;background:#8b1e1e;color:#fff;font:12px/1.35 system-ui;padding:8px 10px;border-radius:10px;max-height:30vh;overflow:auto;white-space:pre-wrap';
      bar.onclick = () => bar.remove();
      document.body.appendChild(bar);
    }
    bar.textContent = (bar.textContent ? bar.textContent + String.fromCharCode(10) : '⚠️ Ошибка (тап — скрыть):' + String.fromCharCode(10)) + text;
  };
  window.addEventListener('error', e => report(e.message, e.filename ? e.filename.split('/').pop() + ':' + e.lineno : ''));
  window.addEventListener('unhandledrejection', e => report(e.reason && (e.reason.message || e.reason), 'promise'));
})();

if ('serviceWorker' in navigator) {
  // если страницу уже обслуживал SW и он сменился на новый — перезагружаемся один раз,
  // чтобы подхватить свежие файлы, а не те, что отдал старый воркер
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController && !reloading) { reloading = true; location.reload(); }
  });
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}
if (navigator.storage && navigator.storage.persist) {
  navigator.storage.persist().catch(() => {});
}
render();
