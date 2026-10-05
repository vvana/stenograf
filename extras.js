/* Fixpoint — отчёт для мастеров, калькулятор материалов, «призрачная камера» */
'use strict';

const roomSurfaces = r => [...(r.wallIds || []), 'c', 'f'];
const DEFAULT_CEIL = 2.7;
const roomCeil = r => (r.ceil > 0 ? r.ceil : DEFAULT_CEIL);

/* ---------- высота стен: у каждой стены свой профиль верха ---------- */
// r.wallTop[wallId] = [[f, h], ...]: f — доля длины от начала стены (0..1), h — высота над полом, м.
// Две точки с одним f — ступенька (короб), разные h по краям — скос. Нет записи — стена ровная, высота roomCeil.
// шум лидара: RoomPlan у углов часто отдаёт потолок на 1–5 см ниже/выше — это не короб, в 3D даёт «ступеньки» на кромке
const TOP_NOISE = 0.05;
const wallTopCache = new WeakMap();
function wallTop(r, wallId) {
  const h = roomCeil(r);
  const p = r.wallTop && r.wallTop[wallId];
  if (!(p && p.length >= 2)) return [[0, h], [1, h]];
  let byRoom = wallTopCache.get(r);
  if (!byRoom) wallTopCache.set(r, byRoom = {});
  const hit = byRoom[wallId];
  if (hit && hit.src === p && hit.h === h) return hit.out;
  // близкие к общей высоте точки → общая высота; подряд идущие одинаковые высоты → одна полка
  let snapped = p.map(([f, y]) => [f, Math.abs(y - h) < TOP_NOISE ? h : y]);
  // перепад только у самого угла (последние 25 см стены) — тоже шум RoomPlan: продлеваем высоту изнутри стены
  const i = (r.wallIds || []).indexOf(wallId);
  const A = r.pts[i], B = r.pts[(i + 1) % r.pts.length];
  const len = A && B ? Math.hypot(B[0] - A[0], B[1] - A[1]) : 0;
  if (len > 0.8) {
    const e = 0.25 / len;
    const at = f => { for (let k = 1; k < snapped.length; k++) if (f <= snapped[k][0]) { const [f0, h0] = snapped[k - 1], [f1, h1] = snapped[k]; return f1 - f0 < 1e-6 ? h1 : h0 + (h1 - h0) * (f - f0) / (f1 - f0); } return snapped[snapped.length - 1][1]; };
    // ступенька = резкий перепад (круче 45°) на участке; плавный скос не трогаем
    const steep = (f0, f1) => snapped.some((q, k) => k && q[0] >= f0 - 1e-6 && snapped[k - 1][0] <= f1 + 1e-6
      && Math.abs(q[1] - snapped[k - 1][1]) > 0.005 && Math.abs(q[1] - snapped[k - 1][1]) > (q[0] - snapped[k - 1][0]) * len);
    const fixS = steep(0, e), fixE = steep(1 - e, 1);
    if (fixS || fixE) {
      const hs = at(e), he = at(1 - e);
      snapped = [...(fixS ? [[0, hs], [e, hs]] : snapped.filter(([f]) => f <= e)),
                 ...snapped.filter(([f]) => f > e && f < 1 - e),
                 ...(fixE ? [[1 - e, he], [1, he]] : snapped.filter(([f]) => f >= 1 - e))];
    }
  }
  const out = snapped.filter((q, k) => k === 0 || k === snapped.length - 1
    || !(snapped[k - 1][1] === q[1] && snapped[k + 1][1] === q[1]));
  const res = out.every(q => q[1] === h) ? [[0, h], [1, h]] : out;
  byRoom[wallId] = { src: p, h, out: res };
  return res;
}
function wallHAt(r, wallId, f) {
  const p = wallTop(r, wallId);
  if (f <= p[0][0]) return p[0][1];
  for (let k = 1; k < p.length; k++) {
    if (f <= p[k][0]) {
      const [f0, h0] = p[k - 1], [f1, h1] = p[k];
      return f1 - f0 < 1e-6 ? Math.min(h0, h1) : h0 + (h1 - h0) * (f - f0) / (f1 - f0);
    }
  }
  return p[p.length - 1][1];
}
const wallMaxH = (r, id) => Math.max(...wallTop(r, id).map(q => q[1]));
const wallIsFlat = (r, id) => { const hs = wallTop(r, id).map(q => q[1]); return Math.max(...hs) - Math.min(...hs) < 0.015; };
// площадь стены под профилем, м² (без вычета проёмов)
function wallGrossArea(r, e) {
  const p = wallTop(r, e.id);
  let s = 0;
  for (let k = 0; k + 1 < p.length; k++) s += (p[k + 1][0] - p[k][0]) * (p[k][1] + p[k + 1][1]) / 2;
  return s * e.len;
}
// диапазон высот комнаты: [мин, макс]
function roomHeightRange(r) {
  let lo = Infinity, hi = -Infinity;
  for (const e of roomEdges(r)) for (const [, h] of wallTop(r, e.id)) { lo = Math.min(lo, h); hi = Math.max(hi, h); }
  return lo === Infinity ? [roomCeil(r), roomCeil(r)] : [lo, hi];
}
const fmtM = v => v.toFixed(2).replace('.', ',');
function roomHeightText(r) {
  const [lo, hi] = roomHeightRange(r);
  return hi - lo < 0.015 ? `h ${fmtM(hi)}` : `h ${fmtM(lo)}–${fmtM(hi)}`;
}

/* ---------- радиусные углы: отступы и контур для 3D (как на схеме — квадратичная кривая) ---------- */
function roomCorners(r) {
  const n = r.pts.length, out = [];
  for (let i = 0; i < n; i++) {
    const V = r.pts[i], rad = V[2] || 0;
    if (!(rad > 0)) { out.push({ t: 0 }); continue; }
    const P = r.pts[(i - 1 + n) % n], N = r.pts[(i + 1) % n];
    const lP = Math.hypot(P[0] - V[0], P[1] - V[1]) || 1e-9, lN = Math.hypot(N[0] - V[0], N[1] - V[1]) || 1e-9;
    let ang = cornerAngle(r, i); if (ang > 180) ang = 360 - ang;
    const t = Math.min(rad / Math.tan(ang / 2 * Math.PI / 180), lP / 2, lN / 2);
    out.push({
      t, V,
      A: [V[0] + (P[0] - V[0]) / lP * t, V[1] + (P[1] - V[1]) / lP * t],
      B: [V[0] + (N[0] - V[0]) / lN * t, V[1] + (N[1] - V[1]) / lN * t],
    });
  }
  return out;
}
const bezier2 = (A, V, B, s) => [(1 - s) * (1 - s) * A[0] + 2 * (1 - s) * s * V[0] + s * s * B[0], (1 - s) * (1 - s) * A[1] + 2 * (1 - s) * s * V[1] + s * s * B[1]];
// контур пола/потолка: [{x, y, h, corner?, arc?}] — h высота потолка в точке; скругления и изломы профиля стен учтены
function roomRing(r, seg = 8) {
  const n = r.pts.length, cs = roomCorners(r), edges = roomEdges(r), out = [];
  for (let i = 0; i < n; i++) {
    const c = cs[i], V = r.pts[i];
    const hc = Math.min(wallHAt(r, edges[(i - 1 + n) % n].id, 1), wallHAt(r, edges[i].id, 0));
    if (c.t > 0) {
      for (let k = 0; k <= seg; k++) { const [x, y] = bezier2(c.A, V, c.B, k / seg); out.push({ x, y, h: hc, arc: i }); }
    } else out.push({ x: V[0], y: V[1], h: hc, corner: true });
    // изломы верха стены между углами (ступеньки, скосы)
    const e = edges[i], tS = c.t, tE = e.len - cs[(i + 1) % n].t;
    let last = null;
    for (const [f, h] of wallTop(r, e.id)) {
      const t = f * e.len;
      if (t <= tS + 0.01 || t >= tE - 0.01) continue;
      if (last && Math.abs(t - last.t) < 1e-3) { last.p.h = Math.min(last.p.h, h); continue; }
      const p = { x: e.a[0] + e.ux * t, y: e.a[1] + e.uy * t, h };
      out.push(p); last = { t, p };
    }
  }
  return out.filter((p, k) => { const q = out[(k + 1) % out.length]; return Math.hypot(p.x - q.x, p.y - q.y) > 1e-3; });
}

/* ---------- отчёт: задание для мастеров ---------- */

let reportTrade = 'all'; // фильтр отчёта по специальности

async function viewReport(pid) {
  const { project, rooms, stages, photos } = await loadProjectData(pid);
  if (!project) return nav('');
  const isMain = m => (m.layer || 'main') === 'main';
  const tradeOfMark = m => m.type === 'conduit' ? conduitOf(m.kind)[4] : m.type === 'point' ? tradeOf(m.kind) : null;
  const fits = m => reportTrade === 'all' ? true : ((m.type === 'point' || m.type === 'conduit') && tradeOfMark(m) === reportTrade);
  const hasMarks = p => (p.marks || []).some(m => isMain(m) && fits(m));
  const items = [];
  for (const r of rooms) {
    for (const side of roomSurfaces(r)) {
      const key = `${r.id}:${side}`;
      const list = photos.filter(p => p.wallKey === key && hasMarks(p)).sort((a, b) => a.created - b.created);
      if (list.length) items.push({ room: r, side, key, list });
    }
  }
  const today = fmtDate(Date.now());

  app.innerHTML = `
    ${header('Задание для мастеров', `#/p/${pid}/more`)}
    <div class="pad report" id="report">
      <div class="report-head">
        <h2>${esc(project.name)}</h2>
        <div class="mut small">${reportTrade === 'all' ? 'Разметка стен и точек' : 'Задание: ' + tradeName(reportTrade)} · ${today} · Fixpoint</div>
      </div>
      <div class="trade-filter no-print">
        <button class="chip ${reportTrade === 'all' ? 'st1' : 'st0'}" data-trade="all">Всё</button>
        ${TRADES.map(([t, n]) => `<button class="chip ${reportTrade === t ? 'st1' : 'st0'}" data-trade="${t}">${n}</button>`).join('')}
      </div>
      ${items.length === 0 ? `
        <div class="empty">
          <div class="empty-ico">📋</div>
          <p><b>Пока нет разметки.</b></p>
          <p class="mut">${reportTrade === 'all' ? 'Откройте фото стены, поставьте точки 🔌 (розетки, выключатели, выводы воды) или размеры 📐 — они попадут в отчёт автоматически.' : 'Для этой специальности точек пока нет.'}</p>
        </div>` : `
        <div class="report-actions no-print">
          <button class="btn primary" id="rep-share">📤 Поделиться</button>
          <button class="btn" id="rep-print">🖨 Печать / PDF</button>
        </div>
        <div id="rep-body">${items.map((it, i) => `
          <section class="report-item">
            <h3>${esc(it.room.name)} — ${esc(sideTitle(it.room, it.side))}</h3>
            ${it.list.map(p => `
              <figure class="report-fig" data-photo="${p.id}">
                <div class="report-img-box"><span class="mut small">Готовлю изображение…</span></div>
                <figcaption class="mut small">${esc(stageName(stages, p.stageId))} · ${fmtDate(p.created)}${p.by ? ' · ' + esc(p.by) : ''}${p.note ? ' · ' + esc(p.note) : ''}${p.seal ? `<br><span class="seal-line">🔒 ${new Date(p.seal.at).toLocaleString('ru-RU')}${p.seal.geo ? ' · 📍 ' + fmtGeo(p.seal.geo) : ''} · SHA-256 ${p.seal.sha256.slice(0, 12)}…</span>` : ''}</figcaption>
                ${pointsTable(p)}
              </figure>`).join('')}
          </section>`).join('')}
        </div>`}
    </div>`;

  app.querySelectorAll('[data-trade]').forEach(b => { b.onclick = () => { reportTrade = b.dataset.trade; render(); }; });
  if (!items.length) return;

  // запекаем фото с разметкой
  const baked = [];
  for (const it of items) for (const p of it.list) {
    if (!app.querySelector('#report')) return; // пользователь ушёл с экрана — прекращаем
    const box = app.querySelector(`[data-photo="${p.id}"] .report-img-box`);
    try {
      const canvas = await bakePhoto(p);
      const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.88));
      baked.push({ name: `${slug(it.room.name)}-${it.side}-${baked.length + 1}.jpg`, blob });
      if (box) box.innerHTML = `<img src="${newURL(blob)}" alt="">`;
      // положение точек на стене — только если фото откалибровано по 4 углам
      const meas = makeMeasurer(p, canvas.width, canvas.height);
      if (meas && meas.wall) {
        for (const m of (p.marks || []).filter(m => m.type === 'point')) {
          const el = app.querySelector(`[data-ptlabel="${m.id}"]`);
          const w = meas.wall(m.at);
          if (el) el.textContent = ` · h ${fmtLen(w.fromFloor)}, ${fmtLen(w.fromLeft)} от левого угла`;
        }
        for (const m of (p.marks || []).filter(m => m.type === 'conduit')) {
          const el = app.querySelector(`[data-cdlabel="${m.id}"]`);
          if (el) el.textContent = ' — ' + conduitLabel(m, meas).replace(conduitOf(m.kind)[2], '').replace(/^ · /, '');
        }
      }
    } catch (err) {
      if (box) box.innerHTML = `<span class="mut small">Не удалось отрисовать</span>`;
    }
  }

  if (!app.querySelector('#report')) return;
  $('#rep-print').onclick = () => window.print();
  $('#rep-share').onclick = async () => {
    const files = baked.map(b => new File([b.blob], b.name, { type: 'image/jpeg' }));
    const text = reportText(project, items, stages);
    if (navigator.canShare && navigator.canShare({ files })) {
      try { await navigator.share({ files, title: `Задание — ${project.name}`, text }); } catch { /* отмена */ }
    } else if (navigator.share) {
      try { await navigator.share({ title: `Задание — ${project.name}`, text }); } catch {}
    } else {
      await navigator.clipboard?.writeText(text).catch(() => {});
      toast('Поделиться недоступно — текст скопирован, картинки сохраните через Печать → PDF');
    }
  };

  function pointsTable(p) {
    const pts = (p.marks || []).filter(m => m.type === 'point' && isMain(m) && fits(m));
    const conduits = (p.marks || []).filter(m => m.type === 'conduit' && isMain(m) && fits(m));
    const dims = reportTrade === 'all' ? (p.marks || []).filter(m => m.type === 'dim' && isMain(m)) : [];
    if (!pts.length && !dims.length && !conduits.length) return '';
    return `<ul class="report-list">
      ${pts.map(m => `<li class="${m.done ? 'done' : ''}">${m.done ? '✅' : kindOf(m.kind)[1]} <b>${esc(kindOf(m.kind)[2])}</b>${m.note ? ' — ' + esc(m.note) : ''}<span class="mut" data-ptlabel="${m.id}"></span>${m.done && m.doneBy ? `<span class="mut"> · выполнил ${esc(m.doneBy)}</span>` : ''}</li>`).join('')}
      ${conduits.map(m => `<li><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${conduitOf(m.kind)[3]};margin-right:4px"></span><b>${esc(conduitOf(m.kind)[2])}</b><span class="mut" data-cdlabel="${m.id}"> — ${esc(conduitLabel(m, null).replace(conduitOf(m.kind)[2], '').replace(/^ · /, ''))}</span></li>`).join('')}
      ${dims.length ? `<li>📐 Размеров на фото: ${dims.length}</li>` : ''}
    </ul>`;
  }
}

function sideTitle(room, side) {
  const custom = room.labels && room.labels[side];
  if (custom) return custom;
  if (side === 'c') return 'потолок';
  if (side === 'f') return 'пол';
  return wallBaseName(room, side);
}
function stageName(stages, id) { const s = stages.find(x => x.id === id); return s ? s.name : 'Этап'; }
function slug(s) { return String(s).toLowerCase().replace(/[^a-zа-яё0-9]+/gi, '-').replace(/^-|-$/g, '') || 'x'; }

function reportText(project, items, stages) {
  const lines = [`Задание — ${project.name}`];
  for (const it of items) {
    lines.push('', `${it.room.name} — ${sideTitle(it.room, it.side)}`);
    for (const p of it.list) {
      const pts = (p.marks || []).filter(m => m.type === 'point' && (m.layer || 'main') === 'main' && (reportTrade === 'all' || tradeOf(m.kind) === reportTrade));
      for (const m of pts) lines.push(`  ${m.done ? '✅' : '•'} ${kindOf(m.kind)[2]}${m.note ? ': ' + m.note : ''}`);
      const cds = (p.marks || []).filter(m => m.type === 'conduit' && (m.layer || 'main') === 'main' && (reportTrade === 'all' || conduitOf(m.kind)[4] === reportTrade));
      for (const m of cds) lines.push(`  ▬ ${conduitLabel(m, null)}`);
    }
  }
  lines.push('', 'Фото с разметкой — во вложении. Сделано в Fixpoint.');
  return lines.join('\n');
}

/* ---------- подлинность фото: реестр печатей и проверка ---------- */

async function viewVerify(pid) {
  const { project, rooms, stages, photos } = await loadProjectData(pid);
  if (!project) return nav('');
  const sealed = photos.filter(p => p.seal);
  const unsealed = photos.length - sealed.length;
  photos.sort((a, b) => a.created - b.created);
  const roomOf = key => { const { roomId, side } = parseWallKey(key); const r = rooms.find(x => x.id === roomId); return r ? wallLabel(r, side) : key; };
  app.innerHTML = `
    ${header('Подлинность фото', `#/p/${pid}/more`)}
    <div class="pad report" id="verify">
      <div class="report-head">
        <h2>${esc(project.name)}</h2>
        <div class="mut small">Реестр печатей · ${fmtDate(Date.now())} · Fixpoint</div>
      </div>
      <p class="mut small">Каждое фото при добавлении получает печать: хеш SHA-256 содержимого, время, геометку (если разрешена) и автора. Если файл потом изменён — хеш не совпадёт. Реестр можно распечатать или переслать вместе с фото как доказательство «что и когда было снято».</p>
      <div class="card"><b>Фото: ${photos.length}</b> · с печатью ${sealed.length}${unsealed ? ` · без печати ${unsealed} (добавлены до этой версии)` : ''}<br><span id="vf-sum" class="mut small">Проверяю…</span></div>
      <div class="report-actions no-print">
        <button class="btn" id="vf-print">🖨 Печать / PDF</button>
        <button class="btn" id="vf-copy">📋 Скопировать реестр</button>
      </div>
      <div class="calc-table-wrap"><table class="calc-table seal-table">
        <thead><tr><th>Снято</th><th>Где</th><th>Этап</th><th>Автор</th><th>Гео</th><th>SHA-256</th><th>Статус</th></tr></thead>
        <tbody>${photos.map(p => `<tr data-id="${p.id}">
          <td>${new Date(p.created).toLocaleString('ru-RU')}</td>
          <td>${esc(roomOf(p.wallKey))}</td>
          <td>${esc(stageName(stages, p.stageId))}</td>
          <td>${esc(p.by || '')}</td>
          <td>${p.seal && p.seal.geo ? fmtGeo(p.seal.geo) : '—'}</td>
          <td><code>${p.seal ? p.seal.sha256.slice(0, 12) + '…' : '—'}</code></td>
          <td class="vf-state">${p.seal ? '…' : '<span class="mut">нет печати</span>'}</td></tr>`).join('')}</tbody>
      </table></div>
    </div>`;
  const stats = { ok: 0, edited: 0, broken: 0 };
  for (const p of sealed) {
    if (!app.querySelector('#verify')) return;
    const v = await verifySeal(p);
    stats[v.state] = (stats[v.state] || 0) + 1;
    const cell = app.querySelector(`tr[data-id="${p.id}"] .vf-state`);
    if (cell) cell.textContent = sealBadge(v.state);
  }
  const sum = app.querySelector('#vf-sum');
  if (sum) sum.textContent = `Подлинных: ${stats.ok} · изменённых (стирание, оригинал сохранён): ${stats.edited}${stats.broken ? ` · НЕ СОВПАДАЕТ: ${stats.broken}` : ''}`;
  $('#vf-print').onclick = () => window.print();
  $('#vf-copy').onclick = async () => {
    const lines = [`Реестр фото — ${project.name} — ${new Date().toLocaleString('ru-RU')}`];
    for (const p of photos) lines.push(`${new Date(p.created).toISOString()} | ${roomOf(p.wallKey)} | ${stageName(stages, p.stageId)} | ${p.by || ''} | ${p.seal && p.seal.geo ? fmtGeo(p.seal.geo) : '-'} | ${p.seal ? p.seal.sha256 : '-'}`);
    try { await navigator.clipboard.writeText(lines.join('\n')); toast('Реестр скопирован'); } catch { toast('Не удалось скопировать'); }
  };
}

/* ---------- калькулятор площадей и материалов ---------- */

const CALC_DEFAULTS = { plasterMm: 10, screedMm: 50, levelMm: 5, reserve: 10 };
// работы по стенам — галочками, в порядке выполнения
const WALL_WORKS = [['primer', 'Грунтовка'], ['plaster', 'Штукатурка'], ['putty', 'Шпаклёвка'], ['paint', 'Краска'], ['glass', 'Стеклохолст'], ['wallpaper', 'Обои'], ['tile', 'Плитка']];
// старый формат c.wall (один вариант из списка) → набор галочек
function calcWalls(c) {
  if (Array.isArray(c.walls)) return c.walls;
  return ({ paint: ['primer', 'plaster', 'putty', 'paint'], wallpaper: ['primer', 'plaster', 'putty', 'wallpaper'], tile: ['primer', 'tile'], none: [] })[c.wall] || ['primer', 'plaster', 'putty', 'paint'];
}
// работы по потолку — галочками; старый c.ceil (paint | none) → набор
const CEIL_WORKS = [['drywall', 'Гипсокартон'], ['primer', 'Грунтовка'], ['plaster', 'Штукатурка'], ['putty', 'Шпаклёвка'], ['paint', 'Краска']];
function calcCeils(c) {
  if (Array.isArray(c.ceils)) return c.ceils;
  return c.ceil === 'none' ? [] : ['primer', 'putty', 'paint'];
}
// работы по полу — галочками; старый c.floor (laminate | tile | none) → набор
const FLOOR_WORKS = [['screed', 'Стяжка'], ['waterproof', 'Гидроизоляция'], ['level', 'Ровнитель'], ['tile', 'Плитка'], ['laminate', 'Ламинат / кварцвинил'], ['board', 'Инженерная доска']];
function calcFloors(c) {
  if (Array.isArray(c.floors)) return c.floors;
  return ({ laminate: ['laminate'], tile: ['tile'], none: [] })[c.floor] || ['laminate'];
}

function roomAreas(r) {
  const ceil = roomCeil(r);
  const perimeter = roomEdges(r).reduce((s, e) => s + e.len, 0);
  const gross = roomEdges(r).reduce((s, e) => s + wallGrossArea(r, e), 0);
  const area = roomArea(r);
  let openings = 0, doorsW = 0;
  for (const side of Object.keys(r.openings || {})) {
    if (!isWallId(r, side)) continue;
    for (const o of r.openings[side] || []) {
      if (o.kind === 'mirror') continue; // зеркало висит на готовой стене, площадь не вычитаем
      openings += o.w * o.h;
      if (o.kind === 'door') doorsW += o.w;
    }
  }
  return {
    ceil, perimeter, gross, openings,
    walls: Math.max(0, gross - openings),
    floor: area, ceiling: area,
    plinth: Math.max(0, perimeter - doorsW),
  };
}

// работы по помещению: свои галочки (c.rooms[id]) или по умолчанию — санузел под плитку, остальные как в общих настройках
function calcRoomWorks(c, r) {
  const own = c.rooms && c.rooms[r.id];
  if (own) return { walls: own.walls || [], floors: own.floors || [], ceils: own.ceils || [] };
  if (roomKind(r).kind === 'bath') return { walls: ['primer', 'tile'], floors: ['waterproof', 'tile'], ceils: calcCeils(c) };
  return { walls: calcWalls(c), floors: calcFloors(c), ceils: calcCeils(c) };
}

// расход по всем помещениям: считаем по каждому с его площадями и работами, одинаковые материалы складываем
function materials(areas, c) {
  const by = new Map();
  for (const { r, a } of areas) {
    for (const m of roomMaterials(a, c, calcRoomWorks(c, r))) {
      const k = m.name + '|' + m.unit;
      const cur = by.get(k);
      if (cur) { cur.qty += m.qty; cur.rooms.push(r.name); } else by.set(k, { ...m, rooms: [r.name] });
    }
  }
  return [...by.values()];
}

function roomMaterials(tot, c, works) {
  const res = 1 + (c.reserve || 0) / 100;
  const out = [];
  const add = (name, qty, unit, hint) => out.push({ name, qty, unit, hint });
  const w = new Set(works.walls);
  if (w.has('plaster')) {
    const plasterKg = tot.walls * (c.plasterMm || 0) * 0.9;
    if (plasterKg > 0) add('Штукатурка гипсовая (стены)', plasterKg, 'кг', `слой ${c.plasterMm} мм`);
  }
  if (w.has('putty')) add('Шпаклёвка финишная (стены, 2 слоя)', tot.walls * 1.2, 'кг', '');
  const ce = new Set(works.ceils);
  if (ce.has('drywall')) add('Гипсокартон (потолок)', tot.ceiling * res, 'м²', `с запасом ${c.reserve} %; профиль и подвесы не считаются`);
  if (ce.has('plaster')) {
    const kg = tot.ceiling * (c.plasterMm || 0) * 0.9;
    if (kg > 0) add('Штукатурка гипсовая (потолок)', kg, 'кг', `слой ${c.plasterMm} мм`);
  }
  if (ce.has('putty')) add('Шпаклёвка финишная (потолок, 2 слоя)', tot.ceiling * 1.2, 'кг', '');
  const fl = new Set(works.floors);
  if (fl.has('screed')) {
    const kg = tot.floor * (c.screedMm || 0) * 2;
    if (kg > 0) add('Стяжка, пескобетон / ЦПС', kg, 'кг', `слой ${c.screedMm} мм`);
  }
  if (fl.has('waterproof')) {
    const wa = tot.floor + (tot.perimeter || 0) * 0.2;
    add('Гидроизоляция обмазочная (2 слоя)', wa * 2, 'кг', 'пол + заход на стены 20 см');
  }
  if (fl.has('level')) {
    const kg = tot.floor * (c.levelMm || 0) * 1.5;
    if (kg > 0) add('Ровнитель (наливной пол)', kg, 'кг', `слой ${c.levelMm} мм`);
  }
  const primed = (w.has('primer') ? tot.walls : 0) + (ce.has('primer') ? tot.ceiling : 0) + (fl.has('tile') || fl.has('level') ? tot.floor : 0);
  if (primed > 0) add('Грунтовка (2 слоя)', primed * 0.2, 'л', '');
  if (w.has('glass')) add('Стеклохолст', tot.walls * res, 'м²', `с запасом ${c.reserve} %`);
  if (w.has('paint')) add('Краска для стен (2 слоя)', tot.walls * 0.25, 'л', '');
  if (ce.has('paint')) add('Краска для потолка (2 слоя)', tot.ceiling * 0.25, 'л', '');
  if (w.has('wallpaper')) add('Обои', Math.ceil(tot.walls / 5.3 * 1.15), 'рул.', 'рулон 0,53 × 10 м, +15 % на подгонку рисунка');
  if (w.has('tile')) add('Плитка на стены', tot.walls * res, 'м²', `с запасом ${c.reserve} %`);
  if (fl.has('tile')) add('Плитка на пол', tot.floor * res, 'м²', `с запасом ${c.reserve} %`);
  if (fl.has('laminate')) add('Ламинат / кварцвинил', tot.floor * res, 'м²', `с запасом ${c.reserve} %`);
  if (fl.has('board')) add('Инженерная доска', tot.floor * res, 'м²', `с запасом ${c.reserve} %`);
  if (fl.has('tile') || fl.has('laminate') || fl.has('board')) add('Плинтус', tot.plinth * 1.05, 'пог. м', 'периметр минус дверные проёмы, +5 %');
  return out;
}

// поле со свёрнутым списком галочек: в поле — выбранное через запятую или «Не трогаем»
let calcOpen = null; // какой список раскрыт — переживает перерисовку после галочки
let calcRoomSel = null; // помещение, выбранное в «Что делаем»
function checkField(roomId, kind, title, works, sel, none) {
  const key = `${roomId}:${kind}`;
  const names = works.filter(([v]) => sel.includes(v)).map(([, t], i) => i ? t.toLowerCase() : t);
  const open = calcOpen === key;
  return `<div class="calc-group ${open ? 'open' : ''}" data-group="${key}"><span>${title}</span>
    <button type="button" class="inp calc-field ${names.length ? '' : 'none'}" data-toggle="${key}">${esc(names.join(', ') || none)}</button>
    <div class="calc-checks ${open ? '' : 'hidden'}">${works.map(([v, t]) => `<label class="calc-check"><input type="checkbox" data-room="${roomId}" data-k="${kind}" value="${v}" ${sel.includes(v) ? 'checked' : ''}>${t}</label>`).join('')}</div>
  </div>`;
}

async function viewCalc(pid) {
  const { project, rooms } = await loadProjectData(pid);
  if (!project) return nav('');
  const c = Object.assign({}, CALC_DEFAULTS, project.calc || {});
  const areas = rooms.map(r => ({ r, a: roomAreas(r) }));
  const tot = areas.reduce((t, { a }) => {
    for (const k of ['walls', 'floor', 'ceiling', 'openings', 'plinth', 'perimeter']) t[k] = (t[k] || 0) + a[k];
    return t;
  }, {});
  const f = (n, d = 1) => (Math.round(n * 10 ** d) / 10 ** d).toString().replace('.', ',');
  const works = Object.fromEntries(rooms.map(r => [r.id, calcRoomWorks(c, r)]));
  const any = (kind, v) => rooms.some(r => works[r.id][kind].includes(v));
  const sel = rooms.find(r => r.id === calcRoomSel) || rooms[0];
  if (sel) calcRoomSel = sel.id;

  app.innerHTML = `
    ${header('Площади и материалы', `#/p/${pid}/more`)}
    <div class="pad">
      ${rooms.length === 0 ? `<div class="empty"><div class="empty-ico">🧮</div><p><b>Сначала нарисуйте схему.</b></p><p class="mut">Площади считаются по комнатам на схеме, проёмы задаются на экране стены.</p></div>` : `
      <div class="card">
        <b>Что делаем</b>
        <div class="calc-form">
          <label>Помещение <select class="inp" id="c-room">${rooms.map(r => `<option value="${r.id}" ${r.id === sel.id ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select></label>
          ${checkField(sel.id, 'walls', 'Стены', WALL_WORKS, works[sel.id].walls, 'Не трогаем')}
          ${checkField(sel.id, 'floors', 'Пол', FLOOR_WORKS, works[sel.id].floors, 'Не трогаем')}
          ${checkField(sel.id, 'ceils', 'Потолок', CEIL_WORKS, works[sel.id].ceils, 'Не трогаем (натяжной и т.п.)')}
          <label class="${any('walls', 'plaster') || any('ceils', 'plaster') ? '' : 'hidden'}">Слой штукатурки, мм <input class="inp" id="c-plaster" type="number" min="0" max="50" step="1" value="${c.plasterMm}"></label>
          <label class="${any('floors', 'screed') ? '' : 'hidden'}">Толщина стяжки, мм <input class="inp" id="c-screed" type="number" min="0" max="150" step="5" value="${c.screedMm}"></label>
          <label class="${any('floors', 'level') ? '' : 'hidden'}">Слой ровнителя, мм <input class="inp" id="c-level" type="number" min="0" max="50" step="1" value="${c.levelMm}"></label>
          <label>Запас на подрезку, % <input class="inp" id="c-reserve" type="number" min="0" max="30" step="1" value="${c.reserve}"></label>
        </div>
      </div>

      <div class="card">
        <div class="calc-table-wrap"><table class="calc-table calc-areas">
          <thead><tr><th>Комната</th><th>Стены<br>м²</th><th>Пол<br>м²</th><th>Потолок<br>м²</th></tr></thead>
          <tbody>
            ${areas.map(({ r, a }) => `<tr><td>${esc(r.name)}<div class="mut small">периметр ${f(a.perimeter)} м, h ${f(a.ceil, 2)}</div></td>
              <td>${f(a.walls)}</td><td>${f(a.floor)}</td><td>${f(a.ceiling)}</td></tr>`).join('')}
          </tbody>
          <tfoot><tr><th>Итого</th><th>${f(tot.walls)}</th><th>${f(tot.floor)}</th><th>${f(tot.ceiling)}</th></tr></tfoot>
        </table></div>
        <p class="mut small">Стены — за вычетом проёмов. Высота потолка задаётся в редакторе схемы (по умолчанию ${DEFAULT_CEIL} м), проёмы — на экране стены.</p>
      </div>

      <div class="card">
        <b>Ориентировочный расход</b>
        <ul class="mat-list">
          ${materials(areas, c).map(m => { const where = rooms.length > 1 && m.rooms.length < rooms.length ? m.rooms.join(', ') : ''; const sub = [where, m.hint].filter(Boolean).join(' · '); return `<li><span>${esc(m.name)}</span><b>${f(m.qty)} ${m.unit}</b>${sub ? `<div class="mut small">${esc(sub)}</div>` : ''}</li>`; }).join('')}
        </ul>
        <details class="calc-norms"><summary class="mut small">Как считается</summary>
          <p class="mut small">Нормы усреднённые (гипсовая штукатурка 9 кг/м² на 10 мм, шпаклёвка 1,2 кг/м², краска 0,25 л/м² в два слоя, стяжка 2 кг/м² на 1 мм, ровнитель 1,5 кг/м² на 1 мм, гидроизоляция 1 кг/м² на слой). Для закупки уточняйте по упаковке конкретного материала.</p>
        </details>
      </div>
      <button class="btn wide calc-pdf" id="c-pdf">${I('download')}PDF: работы и материалы</button>`}
    </div>`;

  if (!rooms.length) return;
  const saveCalc = async () => {
    const roomsCalc = { ...(c.rooms || {}) };
    const got = kind => [...app.querySelectorAll(`[data-room="${sel.id}"][data-k="${kind}"]`)].filter(x => x.checked).map(x => x.value);
    roomsCalc[sel.id] = { walls: got('walls'), floors: got('floors'), ceils: got('ceils') };
    project.calc = {
      walls: calcWalls(c), floors: calcFloors(c), ceils: calcCeils(c), rooms: roomsCalc,
      plasterMm: +$('#c-plaster').value || 0, screedMm: +$('#c-screed').value || 0, levelMm: +$('#c-level').value || 0, reserve: +$('#c-reserve').value || 0,
    };
    await dbPut('projects', project); render();
  };
  app.querySelectorAll('[data-room][data-k]').forEach(x => { x.onchange = saveCalc; });
  const groups = [...app.querySelectorAll('[data-group]')];
  const showOpen = () => groups.forEach(g => { const o = g.dataset.group === calcOpen; g.classList.toggle('open', o); g.querySelector('.calc-checks').classList.toggle('hidden', !o); });
  app.querySelectorAll('[data-toggle]').forEach(b => { b.onclick = () => { calcOpen = calcOpen === b.dataset.toggle ? null : b.dataset.toggle; showOpen(); }; });
  // тап мимо раскрытого списка — свернуть
  app.querySelector('.calc-form').closest('.card').parentElement.addEventListener('click', e => {
    if (calcOpen && !e.target.closest('[data-group]')) { calcOpen = null; showOpen(); }
  });
  ['#c-plaster', '#c-screed', '#c-level', '#c-reserve'].forEach(s => { $(s).onchange = saveCalc; });
  $('#c-room').onchange = e => { calcRoomSel = e.target.value; calcOpen = null; render(); };
  $('#c-pdf').onclick = () => calcPdf(project, areas, c);
}

// PDF «Работы и материалы»: работы по помещениям с площадями + общий расход
function calcReportHtml(project, areas, c) {
  const f = (n, d = 1) => (Math.round(n * 10 ** d) / 10 ** d).toString().replace('.', ',');
  const list = (works, sel) => works.filter(([v]) => sel.includes(v)).map(([, t]) => t.toLowerCase()).join(', ') || '—';
  const many = areas.length > 1;
  const rows = areas.map(({ r, a }) => { const w = calcRoomWorks(c, r); return `<tr><td><b>${esc(r.name)}</b></td>
    <td>${f(a.walls)} м²<br>${esc(list(WALL_WORKS, w.walls))}</td>
    <td>${f(a.floor)} м²<br>${esc(list(FLOOR_WORKS, w.floors))}</td>
    <td>${f(a.ceiling)} м²<br>${esc(list(CEIL_WORKS, w.ceils))}</td></tr>`; }).join('');
  const mats = materials(areas, c).map(m => { const where = many && m.rooms.length < areas.length ? m.rooms.join(', ') : 'все'; return `<tr><td>${esc(m.name)}${m.hint ? `<br><small>${esc(m.hint)}</small>` : ''}</td><td class="n">${f(m.qty)} ${m.unit}</td>${many ? `<td>${esc(where)}</td>` : ''}</tr>`; }).join('');
  const date = new Date().toLocaleDateString('ru-RU');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(project.name)} — работы и материалы</title><style>
    body{font-family:-apple-system,Helvetica,Arial,sans-serif;font-size:11pt;color:#222;margin:0}
    h1{font-size:16pt;margin:0 0 2pt}h2{font-size:13pt;margin:16pt 0 6pt}.sub{color:#666;font-size:10pt;margin:0}
    table{width:100%;border-collapse:collapse}th,td{border:0.5pt solid #bbb;padding:4pt 6pt;text-align:left;vertical-align:top}
    th{background:#f1f1f1;font-weight:600}td.n{text-align:right;white-space:nowrap}small{color:#666}.note{color:#666;font-size:9pt;margin-top:8pt}
  </style></head><body>
    <h1>${esc(project.name)}: работы и материалы</h1><p class="sub">Fixpoint · ${date}</p>
    <h2>Работы по помещениям</h2>
    <table><tr><th>Помещение</th><th>Стены</th><th>Пол</th><th>Потолок</th></tr>${rows}</table>
    <p class="note">Площадь стен — за вычетом проёмов.${c.plasterMm && areas.some(({ r }) => { const w = calcRoomWorks(c, r); return w.walls.includes('plaster') || w.ceils.includes('plaster'); }) ? ` Слой штукатурки ${c.plasterMm} мм.` : ''} Запас на подрезку ${c.reserve} %.</p>
    <h2>Ориентировочный расход</h2>
    <table><tr><th>Материал</th><th>Количество</th>${many ? '<th>Где</th>' : ''}</tr>${mats || `<tr><td colspan="${many ? 3 : 2}">Работы не выбраны</td></tr>`}</table>
    <p class="note">Нормы усреднённые: гипсовая штукатурка 9 кг/м² на 10 мм, шпаклёвка 1,2 кг/м², краска 0,25 л/м² в два слоя, стяжка 2 кг/м² на 1 мм, ровнитель 1,5 кг/м² на 1 мм, гидроизоляция 1 кг/м² на слой. Для закупки уточняйте по упаковке конкретного материала.</p>
  </body></html>`;
}

async function calcPdf(project, areas, c) {
  const html = calcReportHtml(project, areas, c);
  const name = `${project.name || 'Объект'} — работы и материалы`;
  if (Native.RP && Native.RP.htmlPdf) {
    try { await Native.RP.htmlPdf({ html, name }); return; }
    catch (err) { if (!/not implemented|не реализ|UNIMPLEMENTED/i.test(String(err && (err.code || err.message)))) { alert('PDF не получился: ' + (err.message || err)); return; } }
  }
  // браузер (или старая сборка без метода): печать скрытой страницы → «Сохранить как PDF»
  const fr = document.createElement('iframe');
  fr.style.cssText = 'position:fixed;width:0;height:0;border:0;right:0;bottom:0';
  document.body.appendChild(fr);
  fr.srcdoc = html;
  fr.onload = () => { fr.contentWindow.focus(); fr.contentWindow.print(); setTimeout(() => fr.remove(), 60000); };
}

/* ---------- призрачная камера ---------- */

async function viewGhost(pid, wallKey, photoId) {
  const photo = await dbGet('photos', photoId);
  if (!photo) return nav(`#/p/${pid}/w/${encodeURIComponent(wallKey)}`);
  app.innerHTML = `
    <div class="ghostcam">
      <video id="gh-video" autoplay playsinline muted></video>
      <img id="gh-img" alt="">
      <div class="ghost-top">
        <button class="iconbtn light" data-nav="#/p/${pid}/w/${encodeURIComponent(wallKey)}">✕</button>
        <span>Совместите старое фото с тем, что видит камера</span>
      </div>
      <div class="ghost-bottom">
        <label>Прозрачность <input type="range" id="gh-op" min="5" max="95" value="50"></label>
        <label>Масштаб <input type="range" id="gh-sc" min="50" max="200" value="100"></label>
        <div id="gh-msg" class="small"></div>
      </div>
    </div>`;
  const img = $('#gh-img'), video = $('#gh-video'), msg = $('#gh-msg');
  const canvas = await bakePhoto(photo, { hidden: ['draft'] });
  img.src = canvas.toDataURL('image/jpeg', 0.85);
  $('#gh-op').oninput = e => { img.style.opacity = e.target.value / 100; };
  $('#gh-sc').oninput = e => { img.style.transform = `translate(-50%,-50%) scale(${e.target.value / 100})`; };
  img.style.opacity = 0.5;

  let stream = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
    video.srcObject = stream;
  } catch (err) {
    msg.textContent = 'Камера недоступна: ' + (err && err.name === 'NotAllowedError' ? 'нет разрешения' : (err.message || 'ошибка'));
  }
  viewCleanup = () => { if (stream) stream.getTracks().forEach(t => t.stop()); };
}
