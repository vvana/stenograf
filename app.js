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
  return `${room.name} — ${wallBaseName(room, side)}`;
}
// «верхняя стена» для стандартных 4 сторон, «стена 3» для произвольных многоугольников
function wallBaseName(room, side) {
  if (SIDE_NAMES[side]) return `${SIDE_NAMES[side]} стена`;
  const i = (room.wallIds || []).indexOf(side);
  return i >= 0 ? `стена ${i + 1}` : 'стена';
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
      if (parts[2] === 'calc') return await viewCalc(pid);
      if (parts[2] === 'ghost' && parts[3] && parts[4]) return await viewGhost(pid, parts[3], parts[4]);
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
  const t = e.target.closest('[data-nav]');
  if (t) nav(t.dataset.nav);
});

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
    const p = { id: uid(), name: name.trim(), created: Date.now() };
    await dbPut('projects', p);
    for (let i = 0; i < DEFAULT_STAGES.length; i++) {
      await dbPut('stages', { id: uid(), projectId: p.id, name: DEFAULT_STAGES[i], ord: i, status: 0 });
    }
    nav(`#/p/${p.id}`);
  };
  $('#export-all').onclick = exportBackup;
  $('#import-all').onclick = importBackup;
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
    const n = (p.marks || []).filter(m => m.type === 'point' && (m.layer || 'main') === 'main').length;
    if (n) points[p.wallKey] = (points[p.wallKey] || 0) + n;
  });

  app.innerHTML = `
    ${header(project.name, '#/',
      `<button class="iconbtn ${planState.edit ? 'active' : ''}" id="toggle-edit" title="Редактор схемы">✎</button>`)}
    <div class="plan-wrap">
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
          <button class="btn small-btn danger" id="del-room">Удалить</button>
        </span>
        <span id="vertex-tools" class="tools hidden">
          <label>Угол° <input id="v-angle" class="inp num" type="number" step="1" min="1" max="359"></label>
          <label>R, см <input id="v-radius" class="inp num" type="number" step="1" min="0" max="200"></label>
          <button class="btn small-btn danger" id="del-vertex">Убрать угол</button>
        </span>
        <span id="wall-tools" class="tools hidden">
          <label>Длина, м <input id="w-len" class="inp num" type="number" step="0.01" min="0.1" max="50"></label>
          <button class="btn small-btn" id="add-vertex">+ Угол на стене</button>
        </span>
        <span class="mut small" id="editor-hint">Тапните комнату. Тяните вершины за кружки, «+» на стене добавляет угол, тап по стене — задать длину.</span>
      </div>
      <div id="plan-box" class="plan-box"></div>
      <div id="plan-sheet" class="plan-sheet hidden"></div>
      <input type="file" id="underlay-file" accept="image/*" class="hidden-input">
      ${rooms.length === 0 && !planState.edit ? `
        <div class="empty">
          <div class="empty-ico">📐</div>
          <p><b>Схемы пока нет.</b></p>
          <p class="mut">Нажмите ✎ сверху и добавьте комнаты. Потом тапайте по стенам на схеме, чтобы прикреплять к ним фото.</p>
        </div>` : `<p class="mut small center pad-h">${planState.edit
          ? 'Режим редактора: комната — многоугольник до 10 углов. По умолчанию углы 90°, любой можно изменить.'
          : 'Тапните по стене или по плашке «Потолок»/«Пол» внутри комнаты. Цифра — сколько фото уже есть.'}</p>`}
    </div>
    ${bottomNav(pid, 'plan')}`;

  $('#toggle-edit').onclick = () => { planState.edit = !planState.edit; planState.selected = null; planState.sel = null; render(); };
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

function bottomNav(pid, active) {
  const item = (key, hash, ico, label) =>
    `<button class="nav-item ${active === key ? 'active' : ''}" data-nav="${hash}">
      <span class="nav-ico">${ico}</span>${label}</button>`;
  return `<nav class="bottomnav">
    ${item('plan', `#/p/${pid}`, '📐', 'Схема')}
    ${item('stages', `#/p/${pid}/stages`, '☑', 'Этапы')}
    ${item('more', `#/p/${pid}/more`, '⋯', 'Ещё')}
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
        <text class="room-label" x="${cx}" y="${planState.edit ? cy : cy - 0.55}">${esc(r.name)}</text>`;
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
      if (!planState.edit) {
        const compact = bb.w < 3 || bb.h < 2.8;
        const chips = [['c', 'Потолок', '⬆'], ['f', 'Пол', '⬇']];
        chips.forEach(([sf, name, ico], i) => {
          const key = `${r.id}:${sf}`;
          const cnt = counts[key] || 0;
          const ptsMark = points[key] ? ' ⚡' : '';
          if (compact) {
            const label = (cnt ? `${ico}${cnt}` : ico) + ptsMark;
            const cw2 = cnt ? 1.0 : 0.7;
            const chx = cx + (i === 0 ? -0.6 : 0.6);
            s += `<g class="surf ${cnt ? 'has' : ''}" data-wall="${key}">
              <rect x="${chx - cw2 / 2}" y="${cy + 0.2}" width="${cw2}" height="0.6" rx="0.3"/>
              <text x="${chx}" y="${cy + 0.5}">${label}</text>
              <rect class="surf-hit" x="${chx - 0.55}" y="${cy + 0.05}" width="1.1" height="0.9"/></g>`;
          } else {
            const label = (cnt ? `${name} · ${cnt}` : name) + ptsMark;
            const cw2 = Math.min(2.4, bb.w - 0.8);
            const chy = cy + (i === 0 ? 0.1 : 0.85);
            s += `<g class="surf ${cnt ? 'has' : ''}" data-wall="${key}">
              <rect x="${cx - cw2 / 2}" y="${chy - 0.3}" width="${cw2}" height="0.6" rx="0.3"/>
              <text x="${cx}" y="${chy}">${esc(label)}</text></g>`;
          }
        });
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
      ceilInp.oninput = () => {
        const v = parseFloat(ceilInp.value);
        if (v > 0) room.ceil = v; else delete room.ceil;
        clearTimeout(ceilInp._t); ceilInp._t = setTimeout(() => dbPut('rooms', room), 400);
      };
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
  function hideSheet() { sheet.classList.add('hidden'); sheet.innerHTML = ''; }

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

async function viewStages(pid) {
  const { project, stages, photos } = await loadProjectData(pid);
  if (!project) return nav('');
  const counts = {};
  photos.forEach(p => { counts[p.stageId] = (counts[p.stageId] || 0) + 1; });

  app.innerHTML = `
    ${header('Этапы ремонта', `#/p/${pid}`)}
    <div class="pad">
      <p class="mut small">Тапните статус, чтобы переключить. Стрелками меняйте порядок.</p>
      <div class="cards" id="stage-list">
        ${stages.map((s, i) => `
          <div class="card stage-row">
            <div class="stage-main">
              <div class="stage-name" data-rename="${s.id}">${esc(s.name)}</div>
              <div class="mut small">${counts[s.id] || 0} фото</div>
            </div>
            <button class="chip ${STATUS[s.status || 0].cls}" data-status="${s.id}">${STATUS[s.status || 0].t}</button>
            <div class="stage-arrows">
              <button class="iconbtn" data-up="${s.id}" ${i === 0 ? 'disabled' : ''}>↑</button>
              <button class="iconbtn" data-down="${s.id}" ${i === stages.length - 1 ? 'disabled' : ''}>↓</button>
              <button class="iconbtn danger" data-del="${s.id}">✕</button>
            </div>
          </div>`).join('')}
      </div>
      <button class="btn primary wide" id="add-stage">+ Добавить этап</button>
    </div>
    ${bottomNav(pid, 'stages')}`;

  $('#add-stage').onclick = async () => {
    const name = prompt('Название этапа:');
    if (!name || !name.trim()) return;
    const maxOrd = stages.length ? Math.max(...stages.map(s => s.ord)) : -1;
    await dbPut('stages', { id: uid(), projectId: pid, name: name.trim(), ord: maxOrd + 1, status: 0 });
    render();
  };

  $('#stage-list').addEventListener('click', async e => {
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
      ${stagesWithPhotos.length >= 2 ? `
        <button class="btn primary wide" data-nav="#/p/${pid}/cmp/${encodeURIComponent(wallKey)}">
          ⇆ Сравнить «до / после»</button>` : `
        <p class="mut small center">Добавьте фото минимум на двух этапах — появится сравнение «до/после».</p>`}
      ${isWallId(room, side) ? `
        <div class="card" style="margin-top:12px">
          <div class="stage-photos-head">
            <b>Проёмы на стене</b>
            <button class="btn small-btn" id="add-opening">+ Проём</button>
          </div>
          <div id="openings" class="openings">
            ${((room.openings || {})[side] || []).map((o, i) => `
              <span class="chip st0">${o.kind === 'door' ? '🚪 дверь' : '🪟 окно'} ${String(o.w).replace('.', ',')}×${String(o.h).replace('.', ',')} м
                <button class="chip-x" data-del-opening="${i}" title="Убрать">✕</button></span>`).join('') || '<span class="mut small">Нет проёмов — стена глухая</span>'}
          </div>
        </div>` : ''}
      <div class="cards">
        ${stages.map(s => {
          const list = byStage[s.id] || [];
          return `<div class="card stage-photos">
            <div class="stage-photos-head">
              <b>${esc(s.name)}</b>
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

  const addOp = $('#add-opening');
  if (addOp) {
    addOp.onclick = async () => {
      const t = prompt('Размер проёма: ширина и высота в метрах через пробел.\nДверь обычно 0,8 2,0; окно 1,4 1,4', '0,8 2,0');
      if (t === null) return;
      const nums = String(t).replace(/,/g, '.').match(/\d+(\.\d+)?/g);
      if (!nums || nums.length < 2) return toast('Нужно два числа: ширина и высота');
      const w = parseFloat(nums[0]), h = parseFloat(nums[1]);
      if (!(w > 0 && h > 0)) return toast('Размеры должны быть больше нуля');
      const kind = confirm('Это дверь? («Отмена» — окно)') ? 'door' : 'window';
      room.openings = room.openings || {};
      (room.openings[side] = room.openings[side] || []).push({ kind, w, h });
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
    toast(files.length > 1 ? `Сохраняю ${files.length} фото…` : 'Сохраняю фото…');
    let ok = 0;
    for (const file of files) {
      try {
        // для снимков из галереи берём реальную дату съёмки из EXIF
        const shot = fromCamera ? null : await readExifDate(file);
        const blob = await compressImage(file);
        await dbPut('photos', {
          id: uid(), projectId: pid, wallKey, stageId: pendingStage,
          blob, note: '', created: shot || file.lastModified || Date.now(),
        });
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
        onGhost: p => nav(`#/p/${pid}/ghost/${encodeURIComponent(wallKey)}/${p.id}`),
      });
    };
  });
}

// ожидаемые размеры поверхности из схемы: ширина × высота (для калибровки по 4 углам)
function wallSizeOf(room, side) {
  const ceil = room.ceil || 2.7;
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
        <div class="card">
          <b>${esc(project.name)}</b>
          <div class="mut small">${rooms.length} комн. · ${photos.length} фото</div>
        </div>
        <button class="btn primary wide" data-nav="#/p/${pid}/report">📋 Задание для мастеров</button>
        <button class="btn wide" data-nav="#/p/${pid}/calc">🧮 Площади и материалы</button>
        <button class="btn wide" id="rename-project">Переименовать объект</button>
        <button class="btn wide" id="export-all2">⬇ Резервная копия (все объекты)</button>
        <button class="btn danger wide" id="del-project">Удалить объект и все его данные</button>
      </div>
      <p class="mut small">Приложение работает офлайн, все данные — на устройстве. Резервная копия сохраняет всё (схемы, этапы, фото) в один файл, который можно импортировать на другом телефоне.</p>
    </div>
    ${bottomNav(pid, 'more')}`;

  $('#rename-project').onclick = async () => {
    const name = prompt('Название объекта:', project.name);
    if (!name || !name.trim()) return;
    project.name = name.trim();
    await dbPut('projects', project); render();
  };
  $('#export-all2').onclick = exportBackup;
  $('#del-project').onclick = async () => {
    if (!confirm(`Удалить объект «${project.name}» со всеми схемами и ${photos.length} фото? Это необратимо.`)) return;
    if (!confirm('Точно удалить? Восстановить будет нельзя.')) return;
    await dbDelWhere('photos', 'projectId', pid);
    await dbDelWhere('rooms', 'projectId', pid);
    await dbDelWhere('stages', 'projectId', pid);
    await dbDel('projects', pid);
    nav('');
  };
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

async function exportBackup() {
  toast('Готовлю копию…');
  const [projects, rooms, stages, photos] = await Promise.all([
    dbAll('projects'), dbAll('rooms'), dbAll('stages'), dbAll('photos'),
  ]);
  const photosOut = [];
  for (const p of photos) {
    const { blob, ...meta } = p;
    photosOut.push({ ...meta, data: await blobToDataURL(blob) });
  }
  const projectsOut = [];
  for (const p of projects) {
    if (p.plan && p.plan.blob) {
      const { blob, ...planMeta } = p.plan;
      projectsOut.push({ ...p, plan: { ...planMeta, data: await blobToDataURL(blob) } });
    } else projectsOut.push(p);
  }
  const payload = { app: 'stenograf', version: 1, exported: Date.now(), projects: projectsOut, rooms, stages, photos: photosOut };
  const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const d = new Date();
  a.download = `stenograf-backup-${d.toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  toast('Копия сохранена в загрузки');
}

function importBackup() {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = 'application/json,.json';
  inp.onchange = async () => {
    const file = inp.files && inp.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (data.app !== 'stenograf' || !Array.isArray(data.projects)) throw new Error('Это не файл копии Стенографа');
      if (!confirm(`Импортировать копию от ${fmtDate(data.exported || Date.now())}? Объекты: ${data.projects.length}, фото: ${(data.photos || []).length}. Существующие записи с теми же id будут перезаписаны.`)) return;
      toast('Импортирую…');
      for (const p of data.projects || []) {
        if (p.plan && p.plan.data) {
          const { data: planData, ...planMeta } = p.plan;
          p.plan = { ...planMeta, blob: await (await fetch(planData)).blob() };
        }
        await dbPut('projects', p);
      }
      for (const r of data.rooms || []) await dbPut('rooms', r);
      for (const s of data.stages || []) await dbPut('stages', s);
      for (const ph of data.photos || []) {
        const { data: dataUrl, ...meta } = ph;
        const blob = await (await fetch(dataUrl)).blob();
        await dbPut('photos', { ...meta, blob });
      }
      toast('Импорт завершён');
      render();
    } catch (err) {
      alert('Не удалось импортировать: ' + err.message);
    }
  };
  inp.click();
}

/* ---------- запуск ---------- */

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
