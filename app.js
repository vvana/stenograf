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
  return `${room.name} — ${SIDE_NAMES[side]} стена`;
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

/* ---------- роутер ---------- */

window.addEventListener('hashchange', render);

function nav(hash) { location.hash = hash; }

async function render() {
  freeURLs();
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  try {
    if (parts.length === 0) return await viewProjects();
    if (parts[0] === 'p' && parts[1]) {
      const pid = parts[1];
      if (parts[2] === 'stages') return await viewStages(pid);
      if (parts[2] === 'more') return await viewMore(pid);
      if (parts[2] === 'w' && parts[3]) return await viewWall(pid, parts[3]);
      if (parts[2] === 'cmp' && parts[3]) return await viewCompare(pid, parts[3]);
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

const planState = { edit: false, selected: null };

async function viewPlan(pid) {
  const { project, rooms, photos } = await loadProjectData(pid);
  if (!project) return nav('');
  const counts = {};
  photos.forEach(p => { counts[p.wallKey] = (counts[p.wallKey] || 0) + 1; });

  app.innerHTML = `
    ${header(project.name, '#/',
      `<button class="iconbtn ${planState.edit ? 'active' : ''}" id="toggle-edit" title="Редактор схемы">✎</button>`)}
    <div class="plan-wrap">
      <div id="editor-bar" class="editor-bar ${planState.edit ? '' : 'hidden'}">
        <button class="btn small-btn" id="add-room">+ Комната</button>
        <span id="room-tools" class="hidden">
          <input id="room-name" class="inp" placeholder="Название комнаты">
          <button class="btn small-btn danger" id="del-room">Удалить</button>
        </span>
        <span class="mut small" id="editor-hint">Тапните комнату, чтобы выбрать. Тяните за угол — размер.</span>
      </div>
      <div id="plan-box" class="plan-box"></div>
      ${rooms.length === 0 && !planState.edit ? `
        <div class="empty">
          <div class="empty-ico">📐</div>
          <p><b>Схемы пока нет.</b></p>
          <p class="mut">Нажмите ✎ сверху и добавьте комнаты. Потом тапайте по стенам на схеме, чтобы прикреплять к ним фото.</p>
        </div>` : `<p class="mut small center pad-h">${planState.edit
          ? 'Режим редактора: перетаскивайте комнаты, меняйте размер за угол.'
          : 'Тапните по стене или по плашке «Потолок»/«Пол» внутри комнаты. Цифра — сколько фото уже есть.'}</p>`}
    </div>
    ${bottomNav(pid, 'plan')}`;

  $('#toggle-edit').onclick = () => { planState.edit = !planState.edit; planState.selected = null; render(); };
  if (planState.edit) {
    $('#add-room').onclick = async () => {
      const n = rooms.length;
      const room = {
        id: uid(), projectId: pid, name: 'Комната ' + (n + 1),
        x: 1 + (n % 3) * 4.6, y: 1 + Math.floor(n / 3) * 4.2,
        w: 4, h: 3.5, labels: {}, created: Date.now(),
      };
      await dbPut('rooms', room);
      planState.selected = room.id;
      render();
    };
  }
  setupPlan(pid, rooms, counts);
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

function roomSideCoords(r, side) {
  switch (side) {
    case 'n': return [r.x, r.y, r.x + r.w, r.y];
    case 'e': return [r.x + r.w, r.y, r.x + r.w, r.y + r.h];
    case 's': return [r.x, r.y + r.h, r.x + r.w, r.y + r.h];
    case 'w': return [r.x, r.y, r.x, r.y + r.h];
  }
}

function badgePos(r, side) {
  const off = 0.45;
  switch (side) {
    case 'n': return [r.x + r.w / 2, r.y + off];
    case 'e': return [r.x + r.w - off, r.y + r.h / 2];
    case 's': return [r.x + r.w / 2, r.y + r.h - off];
    case 'w': return [r.x + off, r.y + r.h / 2];
  }
}

function setupPlan(pid, rooms, counts) {
  const box = $('#plan-box');
  if (!box) return;

  // стабильный viewBox на время сессии редактирования
  let minX = 0, minY = 0, maxX = 8, maxY = 8;
  if (rooms.length) {
    minX = Math.min(...rooms.map(r => r.x)) - 1;
    minY = Math.min(...rooms.map(r => r.y)) - 1;
    maxX = Math.max(...rooms.map(r => r.x + r.w)) + 1;
    maxY = Math.max(...rooms.map(r => r.y + r.h)) + 1;
  }
  if (planState.edit) { maxX += 2; maxY += 2; }
  const vb = { x: minX, y: minY, w: Math.max(maxX - minX, 6), h: Math.max(maxY - minY, 6) };

  box.innerHTML = `<svg id="plan" viewBox="${vb.x} ${vb.y} ${vb.w} ${vb.h}"
      preserveAspectRatio="xMidYMid meet"></svg>`;
  const svg = $('#plan');

  function draw() {
    let s = '';
    if (planState.edit) {
      // сетка 1 м
      s += '<g class="grid">';
      for (let gx = Math.ceil(vb.x); gx <= vb.x + vb.w; gx++)
        s += `<line x1="${gx}" y1="${vb.y}" x2="${gx}" y2="${vb.y + vb.h}"/>`;
      for (let gy = Math.ceil(vb.y); gy <= vb.y + vb.h; gy++)
        s += `<line x1="${vb.x}" y1="${gy}" x2="${vb.x + vb.w}" y2="${gy}"/>`;
      s += '</g>';
    }
    for (const r of rooms) {
      const sel = planState.selected === r.id;
      const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
      s += `<g>
        <rect class="room ${sel ? 'sel' : ''}" data-drag="move" data-room="${r.id}"
          x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" rx="0.06"/>
        <text class="room-label" x="${cx}" y="${planState.edit ? cy : cy - 0.55}">${esc(r.name)}</text>`;
      for (const side of SIDES) {
        const [x1, y1, x2, y2] = roomSideCoords(r, side);
        const key = `${r.id}:${side}`;
        const cnt = counts[key] || 0;
        s += `<line class="wall" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;
        if (!planState.edit) {
          s += `<line class="wall-hit" data-wall="${key}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;
          if (cnt > 0) {
            const [bx, by] = badgePos(r, side);
            s += `<g class="badge" data-wall="${key}">
              <circle cx="${bx}" cy="${by}" r="0.32"/>
              <text x="${bx}" y="${by}">${cnt}</text></g>`;
          }
        }
      }
      if (!planState.edit) {
        // плашки «Потолок» и «Пол»: в маленьких комнатах — компактные значки ⬆/⬇
        const compact = r.w < 3 || r.h < 2.8;
        const chips = [['c', 'Потолок', '⬆'], ['f', 'Пол', '⬇']];
        chips.forEach(([sf, name, ico], i) => {
          const key = `${r.id}:${sf}`;
          const cnt = counts[key] || 0;
          if (compact) {
            const label = cnt ? `${ico}${cnt}` : ico;
            const cw2 = cnt ? 1.0 : 0.7;
            const chx = cx + (i === 0 ? -0.6 : 0.6);
            s += `<g class="surf ${cnt ? 'has' : ''}" data-wall="${key}">
              <rect x="${chx - cw2 / 2}" y="${cy + 0.2}" width="${cw2}" height="0.6" rx="0.3"/>
              <text x="${chx}" y="${cy + 0.5}">${label}</text>
              <rect class="surf-hit" x="${chx - 0.55}" y="${cy + 0.05}" width="1.1" height="0.9"/></g>`;
          } else {
            const label = cnt ? `${name} · ${cnt}` : name;
            const cw2 = Math.min(2.4, r.w - 0.8);
            const chy = cy + (i === 0 ? 0.1 : 0.85);
            s += `<g class="surf ${cnt ? 'has' : ''}" data-wall="${key}">
              <rect x="${cx - cw2 / 2}" y="${chy - 0.3}" width="${cw2}" height="0.6" rx="0.3"/>
              <text x="${cx}" y="${chy}">${esc(label)}</text></g>`;
          }
        });
      }
      if (planState.edit && sel) {
        s += `<circle class="handle" data-drag="resize" data-room="${r.id}"
          cx="${r.x + r.w}" cy="${r.y + r.h}" r="0.38"/>`;
      }
      s += '</g>';
    }
    svg.innerHTML = s;
  }
  draw();

  function toWorld(e) {
    const pt = new DOMPoint(e.clientX, e.clientY);
    return pt.matrixTransform(svg.getScreenCTM().inverse());
  }
  const snap = v => Math.round(v * 10) / 10;

  let drag = null;

  svg.addEventListener('pointerdown', e => {
    const wallEl = e.target.closest('[data-wall]');
    if (wallEl && !planState.edit) {
      drag = { kind: 'tap-wall', key: wallEl.dataset.wall, sx: e.clientX, sy: e.clientY, moved: false };
      return;
    }
    if (!planState.edit) return;
    const t = e.target.closest('[data-drag]');
    if (!t) {
      if (planState.selected !== null) { planState.selected = null; updateTools(); draw(); }
      return;
    }
    e.preventDefault();
    const room = rooms.find(r => r.id === t.dataset.room);
    if (!room) return;
    if (planState.selected !== room.id) { planState.selected = room.id; updateTools(); }
    drag = { kind: t.dataset.drag, room, start: toWorld(e), orig: { ...room }, moved: false };
    try { svg.setPointerCapture(e.pointerId); } catch {}
    draw();
  });

  svg.addEventListener('pointermove', e => {
    if (!drag) return;
    if (drag.kind === 'tap-wall') {
      if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 8) drag.moved = true;
      return;
    }
    const p = toWorld(e);
    const dx = p.x - drag.start.x, dy = p.y - drag.start.y;
    if (Math.abs(dx) + Math.abs(dy) > 0.05) drag.moved = true;
    if (drag.kind === 'move') {
      drag.room.x = snap(drag.orig.x + dx);
      drag.room.y = snap(drag.orig.y + dy);
    } else {
      drag.room.w = Math.max(1, snap(drag.orig.w + dx));
      drag.room.h = Math.max(1, snap(drag.orig.h + dy));
    }
    draw();
  });

  svg.addEventListener('pointerup', async e => {
    if (!drag) return;
    const d = drag; drag = null;
    if (d.kind === 'tap-wall') {
      if (!d.moved) nav(`#/p/${pid}/w/${encodeURIComponent(d.key)}`);
      return;
    }
    if (d.moved) await dbPut('rooms', d.room);
  });
  svg.addEventListener('pointercancel', () => { drag = null; });

  function updateTools() {
    const tools = $('#room-tools'), hint = $('#editor-hint');
    if (!tools) return;
    const room = rooms.find(r => r.id === planState.selected);
    tools.classList.toggle('hidden', !room);
    if (hint) hint.classList.toggle('hidden', !!room);
    if (!room) return;
    const inp = $('#room-name');
    inp.value = room.name;
    inp.oninput = () => {
      room.name = inp.value;
      clearTimeout(inp._t);
      inp._t = setTimeout(() => dbPut('rooms', room), 400);
      draw();
    };
    $('#del-room').onclick = async () => {
      const photos = (await dbAll('photos', 'projectId', pid)).filter(p => p.wallKey.startsWith(room.id + ':'));
      const msg = photos.length
        ? `Удалить комнату «${room.name}»? Вместе с ней удалятся ${photos.length} фото её стен!`
        : `Удалить комнату «${room.name}»?`;
      if (!confirm(msg)) return;
      for (const p of photos) await dbDel('photos', p.id);
      await dbDel('rooms', room.id);
      planState.selected = null;
      render();
    };
  }
  if (planState.edit) updateTools();
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
      <div class="cards">
        ${stages.map(s => {
          const list = byStage[s.id] || [];
          return `<div class="card stage-photos">
            <div class="stage-photos-head">
              <b>${esc(s.name)}</b>
              <button class="btn small-btn" data-shoot="${s.id}">📷 Фото</button>
            </div>
            ${list.length ? `<div class="thumbs">
              ${list.map(p => `<img class="thumb" src="${newURL(p.blob)}" data-view="${p.id}" alt="">`).join('')}
            </div>` : `<div class="mut small">Нет фото</div>`}
          </div>`;
        }).join('')}
      </div>
    </div>
    <input type="file" id="cam" accept="image/*" capture="environment" class="hidden-input">
    <div id="viewer" class="viewer hidden"></div>`;

  $('#rename-wall').onclick = async () => {
    const name = prompt('Название поверхности:', wallLabel(room, side));
    if (!name || !name.trim()) return;
    room.labels = room.labels || {};
    room.labels[side] = name.trim();
    await dbPut('rooms', room); render();
  };

  const cam = $('#cam');
  let pendingStage = null;
  app.querySelectorAll('[data-shoot]').forEach(b => {
    b.onclick = () => { pendingStage = b.dataset.shoot; cam.click(); };
  });
  cam.onchange = async () => {
    const file = cam.files && cam.files[0];
    cam.value = '';
    if (!file || !pendingStage) return;
    toast('Сохраняю фото…');
    const blob = await compressImage(file);
    await dbPut('photos', {
      id: uid(), projectId: pid, wallKey, stageId: pendingStage,
      blob, note: '', created: Date.now(),
    });
    toast('Фото добавлено');
    render();
  };

  app.querySelectorAll('[data-view]').forEach(img => {
    img.onclick = () => openViewer(wallPhotos.find(p => p.id === img.dataset.view), stages);
  });
}

function openViewer(photo, stages) {
  if (!photo) return;
  const v = $('#viewer');
  const stage = stages.find(s => s.id === photo.stageId);
  v.classList.remove('hidden');
  v.innerHTML = `
    <div class="viewer-top">
      <div>
        <b>${esc(stage ? stage.name : 'Этап')}</b>
        <div class="mut small">${fmtDate(photo.created)}</div>
      </div>
      <button class="iconbtn light" id="v-close">✕</button>
    </div>
    <img src="${newURL(photo.blob)}" alt="">
    <div class="viewer-bottom">
      <div class="viewer-note" id="v-note">${photo.note ? esc(photo.note) : '<span class="mut">+ добавить заметку</span>'}</div>
      <button class="btn danger" id="v-del">Удалить фото</button>
    </div>`;
  $('#v-close').onclick = () => { v.classList.add('hidden'); v.innerHTML = ''; };
  $('#v-note').onclick = async () => {
    const note = prompt('Заметка к фото:', photo.note || '');
    if (note === null) return;
    photo.note = note.trim();
    await dbPut('photos', photo);
    render();
  };
  $('#v-del').onclick = async () => {
    if (!confirm('Удалить это фото безвозвратно?')) return;
    await dbDel('photos', photo.id);
    v.classList.add('hidden');
    render();
  };
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
  const payload = { app: 'stenograf', version: 1, exported: Date.now(), projects, rooms, stages, photos: photosOut };
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
      for (const p of data.projects || []) await dbPut('projects', p);
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
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}
if (navigator.storage && navigator.storage.persist) {
  navigator.storage.persist().catch(() => {});
}
render();
