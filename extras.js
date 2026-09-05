/* Стенограф — отчёт для мастеров, калькулятор материалов, «призрачная камера» */
'use strict';

const ALL_SIDES = ['n', 'e', 's', 'w', 'c', 'f'];
const DEFAULT_CEIL = 2.7;
const roomCeil = r => (r.ceil > 0 ? r.ceil : DEFAULT_CEIL);

/* ---------- отчёт: задание для мастеров ---------- */

async function viewReport(pid) {
  const { project, rooms, stages, photos } = await loadProjectData(pid);
  if (!project) return nav('');
  const hasMarks = p => (p.marks || []).some(m => (m.layer || 'main') === 'main');
  const items = [];
  for (const r of rooms) {
    for (const side of ALL_SIDES) {
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
        <div class="mut small">Разметка стен и точек · ${today} · Стенограф</div>
      </div>
      ${items.length === 0 ? `
        <div class="empty">
          <div class="empty-ico">📋</div>
          <p><b>Пока нет разметки.</b></p>
          <p class="mut">Откройте фото стены, поставьте точки 🔌 (розетки, выключатели, выводы воды) или размеры 📐 — они попадут в отчёт автоматически.</p>
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
                <figcaption class="mut small">${esc(stageName(stages, p.stageId))} · ${fmtDate(p.created)}${p.note ? ' · ' + esc(p.note) : ''}</figcaption>
                ${pointsTable(p)}
              </figure>`).join('')}
          </section>`).join('')}
        </div>`}
    </div>`;

  if (!items.length) return;

  // запекаем фото с разметкой
  const baked = [];
  for (const it of items) for (const p of it.list) {
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
      }
    } catch (err) {
      if (box) box.innerHTML = `<span class="mut small">Не удалось отрисовать</span>`;
    }
  }

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
    const pts = (p.marks || []).filter(m => m.type === 'point' && (m.layer || 'main') === 'main');
    const dims = (p.marks || []).filter(m => m.type === 'dim' && (m.layer || 'main') === 'main');
    if (!pts.length && !dims.length) return '';
    // измеритель для подписей — по естественному размеру фото, поэтому считаем через bakePhoto позже; здесь — по калибровке без размеров
    return `<ul class="report-list">
      ${pts.map(m => `<li>${kindOf(m.kind)[1]} <b>${esc(kindOf(m.kind)[2])}</b>${m.note ? ' — ' + esc(m.note) : ''}<span class="mut" data-ptlabel="${m.id}"></span></li>`).join('')}
      ${dims.length ? `<li>📐 Размеров на фото: ${dims.length}</li>` : ''}
    </ul>`;
  }
}

function sideTitle(room, side) {
  const custom = room.labels && room.labels[side];
  if (custom) return custom;
  if (side === 'c') return 'потолок';
  if (side === 'f') return 'пол';
  return `${SIDE_NAMES[side]} стена`;
}
function stageName(stages, id) { const s = stages.find(x => x.id === id); return s ? s.name : 'Этап'; }
function slug(s) { return String(s).toLowerCase().replace(/[^a-zа-яё0-9]+/gi, '-').replace(/^-|-$/g, '') || 'x'; }

function reportText(project, items, stages) {
  const lines = [`Задание — ${project.name}`];
  for (const it of items) {
    lines.push('', `${it.room.name} — ${sideTitle(it.room, it.side)}`);
    for (const p of it.list) {
      const pts = (p.marks || []).filter(m => m.type === 'point' && (m.layer || 'main') === 'main');
      for (const m of pts) lines.push(`  • ${kindOf(m.kind)[2]}${m.note ? ': ' + m.note : ''}`);
    }
  }
  lines.push('', 'Фото с разметкой — во вложении. Сделано в Стенографе.');
  return lines.join('\n');
}

/* ---------- калькулятор площадей и материалов ---------- */

const CALC_DEFAULTS = { wall: 'paint', floor: 'laminate', ceil: 'paint', plasterMm: 10, reserve: 10 };

function roomAreas(r) {
  const ceil = roomCeil(r);
  const perimeter = 2 * (r.w + r.h);
  const gross = perimeter * ceil;
  let openings = 0, doorsW = 0;
  for (const side of ['n', 'e', 's', 'w']) {
    for (const o of (r.openings && r.openings[side]) || []) {
      openings += o.w * o.h;
      if (o.kind === 'door') doorsW += o.w;
    }
  }
  return {
    ceil, perimeter, gross, openings,
    walls: Math.max(0, gross - openings),
    floor: r.w * r.h, ceiling: r.w * r.h,
    plinth: Math.max(0, perimeter - doorsW),
  };
}

function materials(tot, c) {
  const res = 1 + (c.reserve || 0) / 100;
  const out = [];
  const add = (name, qty, unit, hint) => out.push({ name, qty, unit, hint });
  if (c.wall !== 'none' && c.wall !== 'tile') {
    const plasterKg = tot.walls * (c.plasterMm || 0) * 0.9;
    if (plasterKg > 0) add('Штукатурка гипсовая (стены)', plasterKg, 'кг', `${Math.ceil(plasterKg / 30)} мешков по 30 кг, слой ${c.plasterMm} мм`);
    add('Шпаклёвка финишная (стены, 2 слоя)', tot.walls * 1.2, 'кг', `${Math.ceil(tot.walls * 1.2 / 20)} мешков по 20 кг`);
  }
  if (c.ceil === 'paint') add('Шпаклёвка финишная (потолок, 2 слоя)', tot.ceiling * 1.2, 'кг', '');
  const primed = (c.wall !== 'none' ? tot.walls : 0) + (c.ceil === 'paint' ? tot.ceiling : 0) + (c.floor === 'tile' ? tot.floor : 0);
  if (primed > 0) add('Грунтовка (2 слоя)', primed * 0.2, 'л', '');
  if (c.wall === 'paint') add('Краска для стен (2 слоя)', tot.walls * 0.25, 'л', `${Math.ceil(tot.walls * 0.25 / 2.5)} банок по 2,5 л`);
  if (c.ceil === 'paint') add('Краска для потолка (2 слоя)', tot.ceiling * 0.25, 'л', '');
  if (c.wall === 'wallpaper') add('Обои', Math.ceil(tot.walls / 5.3 * 1.15), 'рул.', 'рулон 0,53 × 10 м, +15 % на подгонку рисунка');
  if (c.wall === 'tile') add('Плитка на стены', tot.walls * res, 'м²', `с запасом ${c.reserve} %`);
  if (c.floor === 'laminate') add('Ламинат / кварцвинил', tot.floor * res, 'м²', `с запасом ${c.reserve} %`);
  if (c.floor === 'tile') add('Плитка на пол', tot.floor * res, 'м²', `с запасом ${c.reserve} %`);
  if (c.floor !== 'none') add('Плинтус', tot.plinth * 1.05, 'пог. м', 'периметр минус дверные проёмы, +5 %');
  return out;
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
  const sel = (id, opts, cur) => `<select class="inp" id="${id}">${opts.map(([v, t]) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${t}</option>`).join('')}</select>`;

  app.innerHTML = `
    ${header('Площади и материалы', `#/p/${pid}/more`)}
    <div class="pad">
      ${rooms.length === 0 ? `<div class="empty"><div class="empty-ico">🧮</div><p><b>Сначала нарисуйте схему.</b></p><p class="mut">Площади считаются по комнатам на схеме, проёмы задаются на экране стены.</p></div>` : `
      <div class="card">
        <div class="calc-table-wrap"><table class="calc-table">
          <thead><tr><th>Комната</th><th>Стены, м²</th><th>Пол, м²</th><th>Потолок</th></tr></thead>
          <tbody>
            ${areas.map(({ r, a }) => `<tr><td>${esc(r.name)}<div class="mut small">${f(r.w)}×${f(r.h)}, h ${f(a.ceil, 2)}${a.openings ? `, проёмы −${f(a.openings)} м²` : ''}</div></td>
              <td>${f(a.walls)}</td><td>${f(a.floor)}</td><td>${f(a.ceiling)}</td></tr>`).join('')}
          </tbody>
          <tfoot><tr><th>Итого</th><th>${f(tot.walls)}</th><th>${f(tot.floor)}</th><th>${f(tot.ceiling)}</th></tr></tfoot>
        </table></div>
        <p class="mut small">Стены — за вычетом проёмов. Высота потолка задаётся в редакторе схемы (по умолчанию ${DEFAULT_CEIL} м), проёмы — на экране стены.</p>
      </div>

      <div class="card">
        <b>Что делаем</b>
        <div class="calc-form">
          <label>Стены ${sel('c-wall', [['paint', 'Штукатурка + шпаклёвка + краска'], ['wallpaper', 'Штукатурка + шпаклёвка + обои'], ['tile', 'Плитка'], ['none', 'Не трогаем']], c.wall)}</label>
          <label>Пол ${sel('c-floor', [['laminate', 'Ламинат / кварцвинил'], ['tile', 'Плитка'], ['none', 'Не трогаем']], c.floor)}</label>
          <label>Потолок ${sel('c-ceil', [['paint', 'Шпаклёвка + краска'], ['none', 'Не трогаем (натяжной и т.п.)']], c.ceil)}</label>
          <label>Слой штукатурки, мм <input class="inp" id="c-plaster" type="number" min="0" max="50" step="1" value="${c.plasterMm}"></label>
          <label>Запас на подрезку, % <input class="inp" id="c-reserve" type="number" min="0" max="30" step="1" value="${c.reserve}"></label>
        </div>
      </div>

      <div class="card">
        <b>Ориентировочный расход</b>
        <ul class="mat-list">
          ${materials(tot, c).map(m => `<li><span>${esc(m.name)}</span><b>${f(m.qty)} ${m.unit}</b>${m.hint ? `<div class="mut small">${esc(m.hint)}</div>` : ''}</li>`).join('')}
        </ul>
        <p class="mut small">Нормы усреднённые (гипсовая штукатурка 9 кг/м² на 10 мм, шпаклёвка 1,2 кг/м², краска 0,25 л/м² в два слоя). Для закупки уточняйте по упаковке конкретного материала.</p>
      </div>`}
    </div>`;

  if (!rooms.length) return;
  const saveCalc = async () => {
    project.calc = {
      wall: $('#c-wall').value, floor: $('#c-floor').value, ceil: $('#c-ceil').value,
      plasterMm: +$('#c-plaster').value || 0, reserve: +$('#c-reserve').value || 0,
    };
    await dbPut('projects', project); render();
  };
  ['#c-wall', '#c-floor', '#c-ceil', '#c-plaster', '#c-reserve'].forEach(s => { $(s).onchange = saveCalc; });
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
