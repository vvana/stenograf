/* Стенограф — разметка фото: калибровка, размеры, заметки, наброски, точки для мастеров */
'use strict';

const MARK_KINDS = [
  ['socket', '🔌', 'Розетка'],
  ['switch', '🎛', 'Выключатель'],
  ['light', '💡', 'Светильник'],
  ['tv', '📺', 'ТВ / интернет'],
  ['water', '🚰', 'Вода'],
  ['sewer', '🕳', 'Канализация'],
  ['heat', '♨', 'Отопление'],
  ['other', '📍', 'Другое'],
];
const kindOf = k => MARK_KINDS.find(x => x[0] === k) || MARK_KINDS[MARK_KINDS.length - 1];

const LAYERS = [
  ['main', 'Разметка'],
  ['draft', 'Черновик'],
  ['calib', 'Калибровка'],
];

/* ---------- геометрия ---------- */

// гомография по 4 парам точек (DLT + Гаусс); возвращает 9 коэффициентов или null
function solveHomography(src, dst) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i], [X, Y] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -X * x, -X * y]); b.push(X);
    A.push([0, 0, 0, x, y, 1, -Y * x, -Y * y]); b.push(Y);
  }
  const n = 8;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]]; [b[c], b[p]] = [b[p], b[c]];
    if (Math.abs(A[c][c]) < 1e-12) return null;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  return [...b.map((v, i) => v / A[i][i]), 1];
}

function applyH(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}

// измеритель по калибровке фото; точки — нормированные [0..1, 0..1]
function makeMeasurer(photo, natW, natH) {
  const c = photo.calib;
  if (!c || !natW || !natH) return null;
  const px = p => [p[0] * natW, p[1] * natH];
  if (c.type === 'ruler') {
    const [a, b] = [px(c.a), px(c.b)];
    const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
    if (!d || !c.len) return null;
    const k = c.len / d;
    return {
      type: 'ruler',
      dist: (p, q) => { const [P, Q] = [px(p), px(q)]; return Math.hypot(P[0] - Q[0], P[1] - Q[1]) * k; },
      wall: null,
    };
  }
  if (c.type === 'quad') {
    const H = solveHomography(c.pts.map(px), [[0, 0], [c.w, 0], [c.w, c.h], [0, c.h]]);
    if (!H) return null;
    const map = p => { const [x, y] = px(p); return applyH(H, x, y); };
    return {
      type: 'quad', w: c.w, h: c.h,
      dist: (p, q) => { const P = map(p), Q = map(q); return Math.hypot(P[0] - Q[0], P[1] - Q[1]); },
      wall: p => { const [X, Y] = map(p); return { fromLeft: X, fromRight: c.w - X, fromFloor: c.h - Y, fromCeil: Y }; },
    };
  }
  return null;
}

function fmtLen(m) {
  if (!isFinite(m)) return '?';
  if (Math.abs(m) >= 1) return (Math.round(m * 100) / 100).toString().replace('.', ',') + ' м';
  return Math.round(m * 100) + ' см';
}

/* ---------- разметка → примитивы (не зависят от способа отрисовки) ---------- */

function pointLabel(m, measurer) {
  const k = kindOf(m.kind);
  let label = k[2];
  if (m.note) label += ': ' + m.note;
  if (measurer && measurer.wall) {
    const w = measurer.wall(m.at);
    label += ` · h ${fmtLen(w.fromFloor)}, ${fmtLen(w.fromLeft)} от лев. угла`;
  }
  return label;
}

function markPrimitives(photo, measurer, hidden = new Set()) {
  const out = [];
  if (photo.calib && !hidden.has('calib')) {
    const c = photo.calib;
    if (c.type === 'ruler') out.push({ type: 'line', a: c.a, b: c.b, cls: 'calib', label: 'эталон ' + fmtLen(c.len) });
    else out.push({ type: 'poly', pts: c.pts, closed: true, cls: 'calib', label: `стена ${fmtLen(c.w)} × ${fmtLen(c.h)}` });
  }
  for (const m of photo.marks || []) {
    const layer = m.layer || 'main';
    if (hidden.has(layer)) continue;
    const cls = layer === 'draft' ? 'draft' : 'main';
    if (m.type === 'dim') {
      const label = m.val ? fmtLen(m.val / 100) : measurer ? fmtLen(measurer.dist(m.a, m.b)) : '?';
      out.push({ type: 'dim', id: m.id, a: m.a, b: m.b, label, cls });
    } else if (m.type === 'text') {
      out.push({ type: 'text', id: m.id, at: m.at, label: m.text, cls });
    } else if (m.type === 'path') {
      out.push({ type: 'path', id: m.id, pts: m.pts, cls });
    } else if (m.type === 'point') {
      out.push({ type: 'point', id: m.id, at: m.at, ico: kindOf(m.kind)[1], label: pointLabel(m, measurer), cls });
    }
  }
  return out;
}

/* ---------- отрисовка в SVG (редактор) ---------- */

function primsToSVG(prims, W, H, tmpPts = []) {
  const P = p => [p[0] * W, p[1] * H];
  const lbl = (x, y, text, cls) =>
    `<text class="lbl ${cls}" x="${x}" y="${y}">${esc(text)}</text>`;
  let s = '';
  for (const pr of prims) {
    const g = pr.id ? `data-id="${pr.id}"` : '';
    if (pr.type === 'line' || pr.type === 'dim') {
      const [a, b] = [P(pr.a), P(pr.b)];
      const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
      s += `<g class="mk ${pr.cls}" ${g}>
        <line class="hit" x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}"/>
        <line class="ln" x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}"/>
        <circle class="end" cx="${a[0]}" cy="${a[1]}" r="4"/><circle class="end" cx="${b[0]}" cy="${b[1]}" r="4"/>
        ${lbl(mx, my - 8, pr.label, pr.cls)}</g>`;
    } else if (pr.type === 'poly') {
      const pts = pr.pts.map(P);
      const [x0, y0] = pts[0];
      s += `<g class="mk ${pr.cls}"><polygon class="ln" points="${pts.map(p => p.join(',')).join(' ')}"/>
        ${pts.map(p => `<circle class="end" cx="${p[0]}" cy="${p[1]}" r="4"/>`).join('')}
        ${lbl(x0 + 6, y0 - 8, pr.label, pr.cls)}</g>`;
    } else if (pr.type === 'path') {
      const pts = pr.pts.map(P);
      s += `<g class="mk ${pr.cls}" ${g}><polyline class="hit" points="${pts.map(p => p.join(',')).join(' ')}"/>
        <polyline class="ln" points="${pts.map(p => p.join(',')).join(' ')}"/></g>`;
    } else if (pr.type === 'text') {
      const [x, y] = P(pr.at);
      s += `<g class="mk ${pr.cls}" ${g}><circle class="hit" cx="${x}" cy="${y}" r="14"/>
        <circle class="dot" cx="${x}" cy="${y}" r="5"/>${lbl(x + 10, y + 5, pr.label, pr.cls)}</g>`;
    } else if (pr.type === 'point') {
      const [x, y] = P(pr.at);
      s += `<g class="mk ${pr.cls} pt" ${g}><circle class="hit" cx="${x}" cy="${y}" r="18"/>
        <circle class="pin" cx="${x}" cy="${y}" r="13"/>
        <text class="ico" x="${x}" y="${y}">${pr.ico}</text>${lbl(x + 17, y + 5, pr.label, pr.cls)}</g>`;
    }
  }
  tmpPts.forEach((p, i) => {
    const [x, y] = P(p);
    s += `<g class="mk tmp"><circle class="pin" cx="${x}" cy="${y}" r="9"/><text class="ico n" x="${x}" y="${y}">${i + 1}</text></g>`;
  });
  return s;
}

/* ---------- отрисовка в canvas (отчёт, призрачный слой) ---------- */

function drawPrimsCanvas(g, prims, W, H) {
  const k = Math.max(W, H) / 900;               // масштаб штрихов под размер картинки
  const P = p => [p[0] * W, p[1] * H];
  const colors = { main: '#ff7a1a', draft: '#ffd400', calib: '#3ec6ff' };
  const font = `bold ${Math.round(15 * k)}px system-ui, sans-serif`;
  const label = (x, y, text) => {
    g.font = font; g.textBaseline = 'middle';
    const w = g.measureText(text).width + 12 * k, h = 22 * k;
    g.fillStyle = 'rgba(0,0,0,.65)';
    g.fillRect(x, y - h / 2, w, h);
    g.fillStyle = '#fff'; g.fillText(text, x + 6 * k, y);
  };
  for (const pr of prims) {
    g.strokeStyle = colors[pr.cls] || colors.main; g.fillStyle = g.strokeStyle;
    g.lineWidth = 3 * k; g.lineCap = 'round'; g.lineJoin = 'round';
    g.setLineDash(pr.cls === 'calib' || pr.cls === 'draft' ? [8 * k, 6 * k] : []);
    if (pr.type === 'line' || pr.type === 'dim') {
      const [a, b] = [P(pr.a), P(pr.b)];
      g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.stroke();
      g.setLineDash([]);
      for (const p of [a, b]) { g.beginPath(); g.arc(p[0], p[1], 4 * k, 0, 7); g.fill(); }
      label((a[0] + b[0]) / 2 - 20 * k, (a[1] + b[1]) / 2 - 16 * k, pr.label);
    } else if (pr.type === 'poly') {
      const pts = pr.pts.map(P);
      g.beginPath(); pts.forEach((p, i) => i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1])); g.closePath(); g.stroke();
      g.setLineDash([]);
      label(pts[0][0] + 6 * k, pts[0][1] - 14 * k, pr.label);
    } else if (pr.type === 'path') {
      const pts = pr.pts.map(P);
      g.beginPath(); pts.forEach((p, i) => i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1])); g.stroke();
    } else if (pr.type === 'text') {
      const [x, y] = P(pr.at);
      g.setLineDash([]);
      g.beginPath(); g.arc(x, y, 5 * k, 0, 7); g.fill();
      label(x + 10 * k, y, pr.label);
    } else if (pr.type === 'point') {
      const [x, y] = P(pr.at);
      g.setLineDash([]);
      g.beginPath(); g.arc(x, y, 14 * k, 0, 7); g.fill();
      g.fillStyle = '#fff'; g.font = `${Math.round(15 * k)}px system-ui, sans-serif`;
      g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(pr.ico, x, y + 1 * k); g.textAlign = 'left';
      label(x + 18 * k, y, pr.label);
    }
  }
  g.setLineDash([]);
}

// фото + разметка → canvas (для отчёта и совмещения с камерой)
async function bakePhoto(photo, opts = {}) {
  const bmp = await createImageBitmap(photo.blob);
  const W = bmp.width, H = bmp.height;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const g = canvas.getContext('2d');
  g.drawImage(bmp, 0, 0);
  bmp.close();
  const hidden = new Set(opts.hidden || ['draft', 'calib']);
  drawPrimsCanvas(g, markPrimitives(photo, makeMeasurer(photo, W, H), hidden), W, H);
  return canvas;
}

/* ---------- редактор ---------- */

// ctx: { stages, wallSize: {w, h} | null, wallTitle, onClose }
function openPhotoEditor(photo, ctx) {
  const v = document.getElementById('viewer');
  photo.marks = photo.marks || [];
  const stage = ctx.stages.find(s => s.id === photo.stageId);
  const hidden = new Set();
  let tool = null, layer = 'main', tmp = [], pendingKind = null, drawing = null;
  let natW = 0, natH = 0, W = 0, H = 0, measurer = null;
  const url = newURL(photo.blob);

  v.classList.remove('hidden');
  v.innerHTML = `
    <div class="ed-top">
      <div class="ed-title">
        <b>${esc(stage ? stage.name : 'Этап')}</b>
        <div class="mut small">${esc(ctx.wallTitle || '')} · ${fmtDate(photo.created)}</div>
      </div>
      <button class="iconbtn light" id="ed-menu">⋯</button>
      <button class="iconbtn light" id="ed-close">✕</button>
    </div>
    <div class="ed-wrap" id="ed-wrap">
      <div class="ed-stage" id="ed-stage">
        <img id="ed-img" src="${url}" alt="">
        <svg id="ed-svg"></svg>
      </div>
    </div>
    <div class="ed-hint" id="ed-hint"></div>
    <div class="ed-tools" id="ed-tools">
      <button data-tool="calib" title="Калибровка">📏</button>
      <button data-tool="dim" title="Размер">📐</button>
      <button data-tool="text" title="Заметка">💬</button>
      <button data-tool="sketch" title="Набросок">✏️</button>
      <button data-tool="point" title="Точка">🔌</button>
      <span class="ed-sep"></span>
      <button id="ed-layer" title="Слой для новых пометок">${layer === 'draft' ? '📝 черновик' : '📌 разметка'}</button>
      <button data-tool="layers" title="Слои">👁</button>
      <button id="ed-undo" title="Отменить последнее">↶</button>
    </div>
    <div id="ed-sheet" class="ed-sheet hidden"></div>`;

  const img = v.querySelector('#ed-img'), svg = v.querySelector('#ed-svg');
  const stageEl = v.querySelector('#ed-stage'), wrap = v.querySelector('#ed-wrap');
  const hint = v.querySelector('#ed-hint'), sheet = v.querySelector('#ed-sheet');

  function layout() {
    if (!natW) return;
    const r = wrap.getBoundingClientRect();
    const k = Math.min(r.width / natW, r.height / natH);
    W = Math.floor(natW * k); H = Math.floor(natH * k);
    stageEl.style.width = W + 'px'; stageEl.style.height = H + 'px';
    svg.setAttribute('width', W); svg.setAttribute('height', H);
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    draw();
  }
  function draw() {
    measurer = makeMeasurer(photo, natW, natH);
    svg.innerHTML = primsToSVG(markPrimitives(photo, measurer, hidden), W, H, tmp)
      + (drawing ? `<polyline class="ln draw ${layer}" points="${drawing.map(p => (p[0] * W) + ',' + (p[1] * H)).join(' ')}"/>` : '');
  }
  img.onload = () => { natW = img.naturalWidth; natH = img.naturalHeight; layout(); };
  if (img.complete && img.naturalWidth) img.onload();
  const onResize = () => layout();
  window.addEventListener('resize', onResize);
  const ro = ('ResizeObserver' in window) ? new ResizeObserver(onResize) : null;
  if (ro) ro.observe(wrap);

  async function save() { await dbPut('photos', photo); draw(); }
  function close() {
    window.removeEventListener('resize', onResize);
    if (ro) ro.disconnect();
    v.classList.add('hidden'); v.innerHTML = '';
    if (ctx.onClose) ctx.onClose();
  }

  const HINTS = {
    null: measurer => measurer ? 'Тапните пометку, чтобы удалить. Выберите инструмент внизу.' : 'Сначала 📏 калибровка — тогда размеры будут в сантиметрах.',
    dim: () => tmp.length ? 'Тапните вторую точку отрезка' : 'Тапните первую точку отрезка',
    text: () => 'Тапните, где поставить заметку',
    sketch: () => 'Рисуйте пальцем. Наброски удобно вести в слое «черновик».',
    point: () => pendingKind ? `Тапните, где находится: ${kindOf(pendingKind)[2]}` : '',
    'calib-ruler': () => tmp.length ? 'Тапните второй конец эталона (рулетки)' : 'Тапните первый конец эталона (рулетки)',
    'calib-quad': () => ['Тапните ВЕРХНИЙ ЛЕВЫЙ угол стены', 'Теперь ВЕРХНИЙ ПРАВЫЙ угол', 'Теперь НИЖНИЙ ПРАВЫЙ угол', 'И НИЖНИЙ ЛЕВЫЙ угол'][tmp.length],
  };
  function setTool(t) {
    tool = t; tmp = [];
    v.querySelectorAll('#ed-tools [data-tool]').forEach(b => b.classList.toggle('active', b.dataset.tool === t || (t && t.startsWith('calib') && b.dataset.tool === 'calib')));
    updateHint(); draw();
  }
  function updateHint() {
    const h = HINTS[tool];
    hint.textContent = h ? h(measurer) : '';
    hint.classList.toggle('hidden', !hint.textContent);
  }

  function showSheet(html, wire) {
    sheet.innerHTML = html + `<button class="btn ghost wide" id="sh-cancel">Отмена</button>`;
    sheet.classList.remove('hidden');
    sheet.querySelector('#sh-cancel').onclick = hideSheet;
    if (wire) wire(sheet);
  }
  function hideSheet() { sheet.classList.add('hidden'); sheet.innerHTML = ''; }

  // --- инструменты ---
  v.querySelector('#ed-tools').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    const t = b.dataset.tool;
    if (t === 'calib') return sheetCalib();
    if (t === 'point') return sheetKinds();
    if (t === 'layers') return sheetLayers();
    if (t) return setTool(tool === t ? null : t);
    if (b.id === 'ed-layer') {
      layer = layer === 'main' ? 'draft' : 'main';
      b.textContent = layer === 'draft' ? '📝 черновик' : '📌 разметка';
      toast(layer === 'draft' ? 'Новые пометки — в черновик' : 'Новые пометки — в основной слой');
    }
    if (b.id === 'ed-undo') {
      if (tmp.length) { tmp.pop(); updateHint(); draw(); return; }
      if (photo.marks.length) { photo.marks.pop(); save(); toast('Отменено'); }
    }
  });

  function sheetCalib() {
    const c = photo.calib;
    showSheet(`
      <div class="sh-title">Калибровка фото</div>
      <p class="mut small">${c ? (c.type === 'quad' ? `Сейчас: стена ${fmtLen(c.w)} × ${fmtLen(c.h)} по 4 углам` : `Сейчас: эталон ${fmtLen(c.len)}`) : 'Без калибровки размеры можно вводить только вручную.'}</p>
      <button class="btn wide" id="sh-quad">▭ По 4 углам стены (точнее, работает под углом)</button>
      <button class="btn wide" id="sh-ruler">📏 По рулетке в кадре (2 точки)</button>
      ${c ? '<button class="btn danger wide" id="sh-reset">Сбросить калибровку</button>' : ''}`, s => {
      s.querySelector('#sh-quad').onclick = () => { hideSheet(); setTool('calib-quad'); };
      s.querySelector('#sh-ruler').onclick = () => { hideSheet(); setTool('calib-ruler'); };
      const r = s.querySelector('#sh-reset');
      if (r) r.onclick = () => { delete photo.calib; hideSheet(); save(); updateHint(); };
    });
  }
  function sheetKinds() {
    showSheet(`<div class="sh-title">Что отметить?</div>
      <div class="sh-grid">${MARK_KINDS.map(k => `<button class="btn" data-kind="${k[0]}">${k[1]} ${k[2]}</button>`).join('')}</div>`, s => {
      s.querySelectorAll('[data-kind]').forEach(b => b.onclick = () => { pendingKind = b.dataset.kind; hideSheet(); setTool('point'); });
    });
  }
  function sheetLayers() {
    const draftCount = photo.marks.filter(m => m.layer === 'draft').length;
    showSheet(`<div class="sh-title">Слои</div>
      ${LAYERS.map(([k, n]) => `<label class="sh-row"><input type="checkbox" data-layer="${k}" ${hidden.has(k) ? '' : 'checked'}> ${n}</label>`).join('')}
      <button class="btn danger wide" id="sh-clear-draft" ${draftCount ? '' : 'disabled'}>Удалить черновик (${draftCount})</button>`, s => {
      s.querySelectorAll('[data-layer]').forEach(cb => cb.onchange = () => {
        cb.checked ? hidden.delete(cb.dataset.layer) : hidden.add(cb.dataset.layer); draw();
      });
      s.querySelector('#sh-clear-draft').onclick = () => {
        if (!confirm(`Удалить все пометки черновика (${draftCount})?`)) return;
        photo.marks = photo.marks.filter(m => m.layer !== 'draft'); hideSheet(); save(); toast('Черновик очищен');
      };
    });
  }
  function sheetItem(id) {
    const m = photo.marks.find(x => x.id === id); if (!m) return;
    const names = { dim: 'Размер', text: 'Заметка', path: 'Набросок', point: 'Точка' };
    showSheet(`<div class="sh-title">${names[m.type] || 'Пометка'}${m.layer === 'draft' ? ' (черновик)' : ''}</div>
      ${m.type === 'text' || m.type === 'point' ? '<button class="btn wide" id="sh-edit">Изменить текст</button>' : ''}
      ${m.type === 'dim' ? '<button class="btn wide" id="sh-val">Ввести длину вручную</button>' : ''}
      <button class="btn wide" id="sh-move">Перенести в ${m.layer === 'draft' ? 'основной слой' : 'черновик'}</button>
      <button class="btn danger wide" id="sh-del">Удалить</button>`, s => {
      const e = s.querySelector('#sh-edit');
      if (e) e.onclick = () => {
        const t = prompt('Текст:', m.type === 'text' ? m.text : (m.note || ''));
        if (t === null) return;
        if (m.type === 'text') m.text = t.trim(); else m.note = t.trim();
        hideSheet(); save();
      };
      const vb = s.querySelector('#sh-val');
      if (vb) vb.onclick = () => {
        const t = prompt('Длина, см (пусто — считать по калибровке):', m.val || '');
        if (t === null) return;
        const n = parseFloat(String(t).replace(',', '.'));
        if (n > 0) m.val = n; else delete m.val;
        hideSheet(); save();
      };
      s.querySelector('#sh-move').onclick = () => { m.layer = m.layer === 'draft' ? 'main' : 'draft'; hideSheet(); save(); };
      s.querySelector('#sh-del').onclick = () => { photo.marks = photo.marks.filter(x => x.id !== id); hideSheet(); save(); };
    });
  }

  // --- указатель ---
  const norm = e => {
    const r = svg.getBoundingClientRect();
    return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))];
  };
  let down = null;
  svg.addEventListener('pointerdown', e => {
    e.preventDefault();
    down = { x: e.clientX, y: e.clientY, moved: false, target: e.target.closest('[data-id]') };
    if (tool === 'sketch') {
      drawing = [norm(e)];
      try { svg.setPointerCapture(e.pointerId); } catch {}
    }
  });
  svg.addEventListener('pointermove', e => {
    if (!down) return;
    if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) down.moved = true;
    if (drawing) { drawing.push(norm(e)); draw(); }
  });
  svg.addEventListener('pointerup', async e => {
    if (!down) return;
    const d = down; down = null;
    if (drawing) {
      const pts = drawing; drawing = null;
      if (pts.length > 2) { photo.marks.push({ id: uid(), type: 'path', layer, pts }); await save(); }
      else draw();
      return;
    }
    if (d.moved) return;
    const p = norm(e);
    if (!tool) {
      if (d.target) sheetItem(d.target.dataset.id);
      return;
    }
    if (tool === 'dim') {
      tmp.push(p);
      if (tmp.length === 2) {
        const m = { id: uid(), type: 'dim', layer, a: tmp[0], b: tmp[1] };
        if (!measurer) {
          const t = prompt('Нет калибровки. Длина отрезка, см:');
          const n = parseFloat(String(t || '').replace(',', '.'));
          if (n > 0) m.val = n;
        }
        photo.marks.push(m); tmp = []; await save();
      }
    } else if (tool === 'text') {
      const t = prompt('Заметка:');
      if (t && t.trim()) { photo.marks.push({ id: uid(), type: 'text', layer, at: p, text: t.trim() }); await save(); }
    } else if (tool === 'point') {
      if (!pendingKind) return sheetKinds();
      const t = prompt(`${kindOf(pendingKind)[2]} — комментарий (можно пусто):`, '');
      if (t === null) return;
      photo.marks.push({ id: uid(), type: 'point', layer, at: p, kind: pendingKind, note: t.trim() });
      await save();
    } else if (tool === 'calib-ruler') {
      tmp.push(p);
      if (tmp.length === 2) {
        const t = prompt('Длина эталона между точками, см:', '100');
        const n = parseFloat(String(t || '').replace(',', '.'));
        if (n > 0) { photo.calib = { type: 'ruler', a: tmp[0], b: tmp[1], len: n / 100 }; toast('Калибровка по эталону сохранена'); }
        tmp = []; setTool(null); await save(); updateHint();
        return;
      }
    } else if (tool === 'calib-quad') {
      tmp.push(p);
      if (tmp.length === 4) {
        const ws = ctx.wallSize || {};
        const tw = prompt('Ширина стены, м:', ws.w ? String(ws.w).replace('.', ',') : '');
        const w = parseFloat(String(tw || '').replace(',', '.'));
        const th = w > 0 ? prompt('Высота стены (потолка), м:', ws.h ? String(ws.h).replace('.', ',') : '2,7') : null;
        const h = parseFloat(String(th || '').replace(',', '.'));
        if (w > 0 && h > 0) { photo.calib = { type: 'quad', pts: tmp.slice(), w, h }; toast('Калибровка по 4 углам сохранена'); }
        tmp = []; setTool(null); await save(); updateHint();
        return;
      }
    }
    updateHint(); draw();
  });
  svg.addEventListener('pointercancel', () => { down = null; drawing = null; draw(); });

  // --- меню и закрытие ---
  v.querySelector('#ed-close').onclick = close;
  v.querySelector('#ed-menu').onclick = () => showSheet(`
    <div class="sh-title">Фото</div>
    <div class="viewer-note" id="sh-note">${photo.note ? esc(photo.note) : '<span class="mut">+ добавить заметку к фото</span>'}</div>
    <button class="btn wide" id="sh-ghost">👻 Совместить с камерой</button>
    <button class="btn danger wide" id="sh-delphoto">Удалить фото</button>`, s => {
    s.querySelector('#sh-note').onclick = async () => {
      const t = prompt('Заметка к фото:', photo.note || '');
      if (t === null) return;
      photo.note = t.trim(); hideSheet(); await save();
    };
    s.querySelector('#sh-ghost').onclick = () => { hideSheet(); if (ctx.onGhost) ctx.onGhost(photo); };
    s.querySelector('#sh-delphoto').onclick = async () => {
      if (!confirm('Удалить это фото безвозвратно?')) return;
      await dbDel('photos', photo.id); close();
    };
  });
  updateHint();
}
