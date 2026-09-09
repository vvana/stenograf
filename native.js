/* Стенограф — нативный мост: Apple RoomPlan (обмер комнат лидаром, обход этапа с автопривязкой фото) */
'use strict';

const Native = (() => {
  const cap = window.Capacitor;
  const isNative = !!(cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform());
  const RP = isNative && cap.registerPlugin ? cap.registerPlugin('RoomPlan') : null;
  return { isNative, RP };
})();

let lidarSupportedCache = null;
async function lidarAvailable() {
  if (!Native.RP) return false;
  if (lidarSupportedCache === null) {
    try { lidarSupportedCache = !!(await Native.RP.isSupported()).supported; } catch { lidarSupportedCache = false; }
  }
  return lidarSupportedCache;
}

/* ---------- геометрия скана ---------- */

const median = arr => { const a = arr.slice().sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : 0; };
const dist2 = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);

function lineIntersect(p1, p2, p3, p4) {
  const d = (p1[0] - p2[0]) * (p3[1] - p4[1]) - (p1[1] - p2[1]) * (p3[0] - p4[0]);
  if (Math.abs(d) < 1e-6) return null;
  const a1 = Math.atan2(p2[1] - p1[1], p2[0] - p1[0]), a2 = Math.atan2(p4[1] - p3[1], p4[0] - p3[0]);
  let da = Math.abs(a1 - a2) % Math.PI; if (da > Math.PI / 2) da = Math.PI - da;
  if (da < 10 * Math.PI / 180) return null; // почти параллельны — пересечение нестабильно
  const t = ((p1[0] - p3[0]) * (p3[1] - p4[1]) - (p1[1] - p3[1]) * (p3[0] - p4[0])) / d;
  return [p1[0] + t * (p2[0] - p1[0]), p1[1] + t * (p2[1] - p1[1])];
}

// стены скана (отрезки в плане) → замкнутый многоугольник; chain[i] — стена от pts[i] к pts[i+1]
function scanToPolygon(scan) {
  const walls = (scan.walls || []).filter(w => w.w > 0.15)
    .map(w => ({ id: w.id, a: [w.x0, w.y0], b: [w.x1, w.y1], len: Math.hypot(w.x1 - w.x0, w.y1 - w.y0), h: w.h }));
  if (walls.length < 3) return null;
  walls.sort((p, q) => q.len - p.len);
  const used = new Set([walls[0].id]);
  const chain = [{ ...walls[0], rev: false }];
  while (chain.length < walls.length) {
    const last = chain[chain.length - 1];
    const end = last.rev ? last.a : last.b;
    let best = null;
    for (const w of walls) {
      if (used.has(w.id)) continue;
      const da = dist2(end, w.a), db = dist2(end, w.b);
      const d = Math.min(da, db);
      if (!best || d < best.d) best = { w, d, rev: db < da };
    }
    if (!best || best.d > 1.0) break;
    chain.push({ ...best.w, rev: best.rev }); used.add(best.w.id);
  }
  if (chain.length < 3) return null;
  const n = chain.length;
  const endsOf = c => c.rev ? [c.b, c.a] : [c.a, c.b];
  const pts = [];
  for (let i = 0; i < n; i++) {
    const [pA, pB] = endsOf(chain[(i - 1 + n) % n]);
    const [cA, cB] = endsOf(chain[i]);
    pts.push(lineIntersect(pA, pB, cA, cB) || [(pB[0] + cA[0]) / 2, (pB[1] + cA[1]) / 2]);
  }
  let res = { pts, chain, ceil: cm(median(walls.map(w => w.h))) || 2.7 };
  if (polyArea(pts) < 0) res = reversePolygon(res); // по часовой на экране — как рисует редактор
  return res;
}

// разворот обхода многоугольника с сохранением соответствия «вершина → стена»
function reversePolygon(res) {
  const n = res.pts.length;
  const pts = res.pts.slice().reverse();
  const chain = [];
  for (let j = 0; j < n; j++) {
    const old = res.chain[(2 * n - 2 - j) % n];
    chain.push({ ...old, rev: !old.rev });
  }
  return { ...res, pts, chain };
}

// проёмы скана → {wallIndex, kind, w, h, x, y}; x — от левого угла для зрителя внутри (начало стены в обходе по часовой)
function scanOpenings(scan, res) {
  const out = [];
  const floorY = scan.floorY || 0;
  const lists = [['door', scan.doors], ['window', scan.windows], ['window', scan.openings]];
  for (const [kind, list] of lists) {
    for (const o of list || []) {
      const i = res.chain.findIndex(c => c.id === o.parent);
      if (i < 0) continue;
      const c = res.chain[i];
      const dir = [c.b[0] - c.a[0], c.b[1] - c.a[1]];
      const t = ((o.cx - c.a[0]) * dir[0] + (o.cz - c.a[1]) * dir[1]) / (c.len || 1); // от конца a исходного отрезка
      const along = c.rev ? c.len - t : t;
      out.push({ wallIndex: i, kind, w: cm(o.w), h: cm(o.h), x: cm(Math.max(0, along - o.w / 2)), y: cm(Math.max(0, o.cy - o.h / 2 - floorY)) });
    }
  }
  return out;
}

/* ---------- совмещение скана с существующей комнатой ---------- */

function transformPts(pts, ang, cx, cy, tx, ty) {
  const ca = Math.cos(ang), sa = Math.sin(ang);
  return pts.map(p => { const x = p[0] - cx, y = p[1] - cy; return [x * ca - y * sa + tx, x * sa + y * ca + ty]; });
}
const centroidOf = pts => [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];
const edgesOf = pts => pts.map((p, i) => { const q = pts[(i + 1) % pts.length]; return { mid: [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2], ang: Math.atan2(q[1] - p[1], q[0] - p[0]), len: dist2(p, q) }; });
const angDiff = (a, b) => { let d = Math.abs(a - b) % (Math.PI * 2); if (d > Math.PI) d = Math.PI * 2 - d; return d; };

// точки проёмов комнаты в мировых координатах (для разрешения симметрии при совмещении)
function roomOpeningPts(room) {
  const out = [];
  for (const e of roomEdges(room)) for (const o of ((room.openings || {})[e.id] || [])) {
    if (o.kind === 'mirror') continue;
    const t = (o.x != null ? o.x : (e.len - o.w) / 2) + o.w / 2;
    out.push({ kind: o.kind, p: [e.a[0] + e.ux * t, e.a[1] + e.uy * t] });
  }
  return out;
}
// точки проёмов скана в координатах скана
function scanOpeningPts(scan, res) {
  return scanOpenings(scan, res).map(o => {
    const c = res.chain[o.wallIndex];
    const [a, b] = c.rev ? [c.b, c.a] : [c.a, c.b];
    const t = (o.x + o.w / 2) / (c.len || 1);
    return { kind: o.kind, p: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t] };
  });
}

// ищем поворот+сдвиг скана, при котором его стены (и проёмы) лучше всего ложатся на комнату
function alignScanToRoom(scanPts, roomPts, scanOps = [], roomOps = []) {
  const sc = centroidOf(scanPts), rc = centroidOf(roomPts);
  const se = edgesOf(scanPts), re = edgesOf(roomPts);
  const longest = se.reduce((m, e) => e.len > m.len ? e : m, se[0]);
  let best = null;
  for (const e of re) for (const extra of [0, Math.PI]) {
    const ang = e.ang - longest.ang + extra;
    const pts = transformPts(scanPts, ang, sc[0], sc[1], rc[0], rc[1]);
    const te = edgesOf(pts);
    let cost = 0;
    for (const a of te) {
      let m = Infinity;
      for (const b of re) if (angDiff(a.ang, b.ang) < 0.35) m = Math.min(m, dist2(a.mid, b.mid));
      cost += Math.min(m, 3) * a.len;
    }
    // проёмы: дверь должна оказаться там же, где дверь на схеме — снимает симметрию прямоугольника
    if (scanOps.length && roomOps.length) {
      const tp = transformPts(scanOps.map(o => o.p), ang, sc[0], sc[1], rc[0], rc[1]);
      scanOps.forEach((o, i) => {
        let m = 3;
        roomOps.forEach(r => { if (r.kind === o.kind) m = Math.min(m, dist2(tp[i], r.p)); });
        cost += m * 2;
      });
    }
    if (!best || cost < best.cost) best = { cost, ang, pts };
  }
  return best;
}

// применить скан: новая комната или переобмер существующей (id стен и фото сохраняются)
async function applyScan(pid, rooms, room, scan, name) {
  const res = scanToPolygon(scan);
  if (!res) throw new Error('В скане меньше трёх стен — обойдите комнату полностью');
  const openings = scanOpenings(scan, res);
  let pts, wallIds, idMap = {};
  if (room) {
    const al = alignScanToRoom(res.pts, room.pts, scanOpeningPts(scan, res), roomOpeningPts(room));
    pts = al.pts.map(p => [cm(p[0]), cm(p[1])]);
    const oldEdges = roomEdges(room), newE = edgesOf(pts);
    const takenOld = new Set();
    wallIds = newE.map(e => {
      let best = null;
      oldEdges.forEach(o => {
        if (takenOld.has(o.id)) return;
        const d = dist2(e.mid, o.mid), da = angDiff(e.ang, Math.atan2(o.b[1] - o.a[1], o.b[0] - o.a[0]));
        if (d < 0.6 && da < 0.35 && (!best || d < best.d)) best = { id: o.id, d };
      });
      if (best) { takenOld.add(best.id); return best.id; }
      return newWallId();
    });
    // фото/проёмы/названия стен, которых больше нет, переезжают на ближайшую новую стену
    const lost = oldEdges.filter(o => !takenOld.has(o.id));
    for (const o of lost) {
      let bi = 0, bd = Infinity;
      newE.forEach((e, i) => { const d = dist2(e.mid, o.mid); if (d < bd) { bd = d; bi = i; } });
      const to = wallIds[bi];
      for (const p of await dbAll('photos', 'wallKey', `${room.id}:${o.id}`)) { p.wallKey = `${room.id}:${to}`; await dbPut('photos', p); }
      if (room.openings && room.openings[o.id]) { room.openings[to] = [...(room.openings[to] || []), ...room.openings[o.id]]; delete room.openings[o.id]; }
      if (room.labels && room.labels[o.id]) { delete room.labels[o.id]; }
    }
    room.pts = pts; room.wallIds = wallIds; room.ceil = res.ceil; room.measured = 'lidar'; room.measuredAt = Date.now();
    // проёмы: заменяем двери/окна на обмеренные, зеркала оставляем
    const keepMirrors = {};
    for (const [k, list] of Object.entries(room.openings || {})) { const m = list.filter(x => x.kind === 'mirror'); if (m.length) keepMirrors[k] = m; }
    room.openings = keepMirrors;
    for (const o of openings) { const k = wallIds[o.wallIndex]; (room.openings[k] = room.openings[k] || []).push({ kind: o.kind, w: o.w, h: o.h, x: o.x, y: o.y }); }
    await dbPut('rooms', room);
  } else {
    // новая комната: самая длинная стена горизонтально, ставим на свободное место
    const se = edgesOf(res.pts);
    const longest = se.reduce((m, e) => e.len > m.len ? e : m, se[0]);
    const sc = centroidOf(res.pts);
    let p2 = transformPts(res.pts, -longest.ang, sc[0], sc[1], 0, 0);
    const minX = Math.min(...p2.map(p => p[0])), minY = Math.min(...p2.map(p => p[1]));
    const [fx, fy] = freeSpot(rooms, 1, 1);
    pts = p2.map(p => [cm(p[0] - minX + fx), cm(p[1] - minY + fy)]);
    const std = standardizeRect(pts);
    if (std) {
      // прямоугольник → стандартные стены n/e/s/w; перестраиваем соответствие «стена скана → сторона»
      const shifted = std.map(p => p.map(v => cm(v)));
      const map = {};
      const newE = edgesOf(shifted);
      const curE = edgesOf(pts);
      curE.forEach((e, i) => { let bi = 0, bd = Infinity; newE.forEach((n2, j) => { const d = dist2(e.mid, n2.mid); if (d < bd) { bd = d; bi = j; } }); map[i] = bi; });
      wallIds = ['n', 'e', 's', 'w'];
      const remap = openings.map(o => ({ ...o, wallIndex: map[o.wallIndex] }));
      openings.length = 0; openings.push(...remap);
      res.chain = res.chain.map((c, i) => ({ ...c, __to: map[i] }));
      pts = shifted;
    } else {
      wallIds = pts.map(() => newWallId());
    }
    room = {
      id: uid(), projectId: pid, name: name || ('Комната ' + (rooms.length + 1)),
      pts, wallIds, labels: {}, ceil: res.ceil, openings: {}, measured: 'lidar', measuredAt: Date.now(), created: Date.now(),
    };
    for (const o of openings) { const k = wallIds[o.wallIndex]; (room.openings[k] = room.openings[k] || []).push({ kind: o.kind, w: o.w, h: o.h, x: o.x, y: o.y }); }
    await dbPut('rooms', room);
  }
  res.chain.forEach((c, i) => { idMap[c.id] = wallIds[c.__to != null ? c.__to : i]; });
  return { room, idMap };
}

// соответствие «стена скана → стена комнаты» без изменения схемы (для обхода этапа)
function matchScanToRoom(room, scan) {
  const res = scanToPolygon(scan);
  if (!res) return {};
  const al = alignScanToRoom(res.pts, room.pts, scanOpeningPts(scan, res), roomOpeningPts(room));
  const newE = edgesOf(al.pts), oldEdges = roomEdges(room);
  const idMap = {};
  res.chain.forEach((c, i) => {
    const e = newE[i];
    let best = null;
    for (const o of oldEdges) {
      const d = dist2(e.mid, o.mid), da = angDiff(e.ang, Math.atan2(o.b[1] - o.a[1], o.b[0] - o.a[0]));
      if (d < 0.8 && da < 0.4 && (!best || d < best.d)) best = { id: o.id, d };
    }
    if (best) idMap[c.id] = best.id;
  });
  return idMap;
}

/* ---------- кадры обхода → фото с автокалибровкой ---------- */

async function framesToPhotos(pid, roomId, stageId, frames, idMap) {
  const by = userName(true);
  const byWall = {};
  for (const f of frames || []) {
    const wid = idMap[f.wall];
    if (!wid || !f.jpeg) continue;
    (byWall[wid] = byWall[wid] || []).push(f);
  }
  let n = 0;
  for (const [wid, list] of Object.entries(byWall)) {
    list.sort((a, b) => (b.full - a.full) || (b.score - a.score));
    const take = list.filter(f => f.full).length ? list.filter(f => f.full).slice(0, 2) : list.slice(0, 1);
    for (const f of take) {
      const blob = await (await fetch('data:image/jpeg;base64,' + f.jpeg)).blob();
      await dbPut('photos', {
        id: uid(), projectId: pid, wallKey: `${roomId}:${wid}`, stageId, blob, note: '', created: Date.now(), by,
        calib: { type: 'quad', pts: f.corners, w: cm(f.w), h: cm(f.h) }, marks: [], source: 'lidar',
      });
      n++;
    }
  }
  return { photos: n, walls: Object.keys(byWall).length };
}

/* ---------- сценарии ---------- */

async function lidarMeasure(pid, rooms, room) {
  let scan;
  try { scan = await Native.RP.scan({ mode: 'measure' }); }
  catch (err) { if (String(err && err.message).includes('cancelled')) return null; throw err; }
  const name = room ? null : (prompt('Название комнаты:', 'Комната ' + (rooms.length + 1)) || null);
  const { room: r } = await applyScan(pid, rooms, room, scan, name);
  toast(`Обмер: ${r.pts.length} стен, потолок ${String(r.ceil).replace('.', ',')} м`);
  return r;
}

async function lidarWalk(pid, room, stageId) {
  let scan;
  try { scan = await Native.RP.scan({ mode: 'walk' }); }
  catch (err) { if (String(err && err.message).includes('cancelled')) return null; throw err; }
  const idMap = matchScanToRoom(room, scan);
  const r = await framesToPhotos(pid, room.id, stageId, scan.frames, idMap);
  const unmatched = (scan.walls || []).filter(w => !idMap[w.id]).length;
  toast(`Обход: ${r.photos} фото на ${r.walls} стен${unmatched ? ` · ${unmatched} стен не совпали со схемой` : ''}`);
  return r;
}
