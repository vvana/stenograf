/* Fixpoint — 3D-тур: «кукольный домик» из схемы и фото, вид изнутри */
'use strict';

const tourState = { mode: 'house', stage: 'all', roomId: null, photos: false };
const FLOOR_COLORS = [0xe3cfae, 0xd8d6d0, 0xead9bd, 0xcfc6b6, 0xe6dfd2, 0xdcc7a4]; // светлое дерево и светло-серый — спокойные полы, как в планировщиках
const WALL_T = 0.12; // толщина стен на «домике», м
const TEX_W = 768;

function threeReady() {
  if (window.THREE) return Promise.resolve(window.THREE);
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('3D-библиотека не загрузилась')), 8000);
    window.addEventListener('three-ready', () => { clearTimeout(t); res(window.THREE); }, { once: true });
  });
}

// фото поверхности для выбранного этапа: последнее на этом этапе, иначе с предыдущих
function pickPhoto(photos, key, stages, stageId) {
  const ordOf = id => { const s = stages.find(x => x.id === id); return s ? s.ord : -1; };
  const maxOrd = stageId === 'all' ? Infinity : ordOf(stageId);
  const list = photos.filter(p => p.wallKey === key && ordOf(p.stageId) <= maxOrd);
  list.sort((a, b) => (ordOf(b.stageId) - ordOf(a.stageId)) || (b.created - a.created));
  return list[0] || null;
}

function canvasTexture(THREE, canvas) {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  t.userData.mimeType = 'image/jpeg'; // при экспорте в GLB — JPEG, а не PNG: файл в разы меньше
  return t;
}

// текстура стены: выпрямляем фото по калибровке (4 угла) либо кадрируем под пропорции стены
async function surfaceTexture(THREE, photo, w, h) {
  const bmp = await createImageBitmap(photo.blob);
  const W = TEX_W, H = Math.max(64, Math.min(2048, Math.round(W * h / w)));
  const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
  const g = canvas.getContext('2d');
  const c = photo.calib;
  if (c && c.type === 'quad') {
    const Hm = solveHomography([[0, 0], [c.w, 0], [c.w, c.h], [0, c.h]], c.pts.map(p => [p[0] * bmp.width, p[1] * bmp.height]));
    if (Hm) {
      const sc = document.createElement('canvas'); sc.width = bmp.width; sc.height = bmp.height;
      sc.getContext('2d').drawImage(bmp, 0, 0);
      const sd = sc.getContext('2d').getImageData(0, 0, bmp.width, bmp.height).data;
      const out = g.createImageData(W, H), od = out.data;
      const bw = bmp.width, bh = bmp.height;
      for (let y = 0; y < H; y++) {
        const my = (y + 0.5) / H * c.h;
        for (let x = 0; x < W; x++) {
          const [sx, sy] = applyH(Hm, (x + 0.5) / W * c.w, my);
          const ix = sx | 0, iy = sy | 0, o = (y * W + x) * 4;
          if (sx >= 0 && sy >= 0 && ix < bw && iy < bh) {
            const i = (iy * bw + ix) * 4;
            od[o] = sd[i]; od[o + 1] = sd[i + 1]; od[o + 2] = sd[i + 2]; od[o + 3] = 255;
          } else { od[o] = 205; od[o + 1] = 200; od[o + 2] = 192; od[o + 3] = 255; }
        }
      }
      g.putImageData(out, 0, 0);
      bmp.close();
      return canvasTexture(THREE, canvas);
    }
  }
  const ar = W / H, br = bmp.width / bmp.height;
  let sw = bmp.width, sh = bmp.height;
  if (br > ar) sw = bmp.height * ar; else sh = bmp.width / ar;
  g.drawImage(bmp, (bmp.width - sw) / 2, (bmp.height - sh) / 2, sw, sh, 0, 0, W, H);
  bmp.close();
  return canvasTexture(THREE, canvas);
}

async function viewTour(pid, roomId = null) {
  const { project, rooms, stages, photos } = await loadProjectData(pid);
  if (!project) return nav('');
  if (roomId && rooms.some(r => r.id === roomId)) { tourState.roomId = roomId; if (tourState.mode === 'house') tourState.mode = 'inside'; }
  if (!tourState.roomId || !rooms.some(r => r.id === tourState.roomId)) tourState.roomId = rooms[0] ? rooms[0].id : null;
  if (tourState.stage !== 'all' && !stages.some(s => s.id === tourState.stage)) tourState.stage = 'all';
  if (tourState.mode === 'hd' && !(project.hdScan && project.hdScan.blob)) tourState.mode = 'house';
  const orbitMode = () => tourState.mode === 'house' || tourState.mode === 'final' || tourState.mode === 'hd';

  app.innerHTML = `
    ${header('3D', false)}
    <div class="tour">
      <canvas id="tour-canvas"></canvas>
      <div class="tour-top">
        <div class="tour-row">
          ${photos.length ? '' : '<div class="inp tour-nophoto">Фото пока нет</div>'}
          ${photos.length ? `<select class="inp" id="tour-stage">
            <option value="all" ${tourState.stage === 'all' ? 'selected' : ''}>Сейчас — последние фото</option>
            ${stages.map(s => `<option value="${s.id}" ${tourState.stage === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}
          </select>
          <button id="tour-photos" class="tour-switch ${tourState.photos ? 'active' : ''}" title="Фото выбранного этапа на стенах" aria-label="Фото этапа на стенах"><span class="sw-track"><span class="sw-knob"></span></span></button>` : ''}
        </div>
        <div class="tour-modes">
          <button data-mode="house" class="${tourState.mode === 'house' ? 'active' : ''}">${I('tour')}Объект</button>
          <button data-mode="inside" class="${tourState.mode === 'inside' ? 'active' : ''}">${I('eye')}Внутри</button>
          ${project.hdScan && project.hdScan.blob ? `<button data-mode="hd" class="${tourState.mode === 'hd' ? 'active' : ''}">${I('flag')}HD</button>` : ''}
          ${project.finalScan && project.finalScan.blob ? `<button data-mode="final" class="${tourState.mode === 'final' ? 'active' : ''}">${I('flag')}Финал</button>` : ''}
          ${'' /* кнопка «RoomPlan» (оригинальная модель USDZ, просмотр и AR) убрана по просьбе пользователя 2026-10-09; модели по-прежнему сохраняются */}
        </div>
      </div>
      <div class="tour-bottom">
        <button id="tour-glb" class="tour-ico tour-glb hidden" title="Экспорт 3D-модели (GLB) — для Blender, дизайнеров, сайтов" aria-label="Экспорт GLB">${ICONS.download}<span>GLB</span></button>
        <div class="tour-plan" id="tour-plan"></div>
      </div>
      <div class="tour-msg hidden" id="tour-msg"></div>
    </div>
    ${bottomNav(pid, 'tour')}`;

  const msg = $('#tour-msg'), hint = document.createElement('div'); // поясняющий текст на экране не показываем (просьба пользователя)
  const say = t => { msg.textContent = t; msg.classList.toggle('hidden', !t); };
  if (!rooms.length) { say('Сначала нарисуйте схему — тур строится из комнат и их фото.'); return; }

  let THREE;
  try { THREE = await threeReady(); } catch (err) { say(err.message + '. Проверьте соединение и обновите страницу.'); return; }

  /* ---------- сцена ---------- */
  const canvas = $('#tour-canvas');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  const dark = false; // приложение всегда светлое
  renderer.setClearColor(0xe3e7ec); // светло-серый холодный фон — белые стены на нём читаются (как у RoomSketcher/Floorplanner)
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, 1, 0.05, 500);

  const bbAll = rooms.map(roomBBox);
  const minX = Math.min(...bbAll.map(b => b.x)), maxX = Math.max(...bbAll.map(b => b.x + b.w));
  const minZ = Math.min(...bbAll.map(b => b.y)), maxZ = Math.max(...bbAll.map(b => b.y + b.h));
  const centerAll = new THREE.Vector3((minX + maxX) / 2, 0.6, (minZ + maxZ) / 2);
  const span = Math.max(maxX - minX, maxZ - minZ, 4);

  scene.add(new THREE.HemisphereLight(0xffffff, 0xd8d2c8, 1.3));
  scene.add(new THREE.AmbientLight(0xffffff, 0.55));
  const sun = new THREE.DirectionalLight(0xffffff, 0.6);
  sun.position.set(centerAll.x - span * 0.5, span * 1.6, centerAll.z + span * 0.7);
  sun.target.position.copy(centerAll); scene.add(sun.target);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.radius = 4;
  sun.shadow.bias = -0.0005;
  Object.assign(sun.shadow.camera, { left: -span, right: span, top: span, bottom: -span, near: 0.5, far: span * 5 });
  scene.add(sun);
  // мягкая тень под моделью — квартира «стоит» на фоне, а не сливается с ним
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(span * 6, span * 6), new THREE.ShadowMaterial({ opacity: 0.18 }));
  ground.rotation.x = -Math.PI / 2; ground.position.set(centerAll.x, -0.02, centerAll.z); ground.receiveShadow = true;
  scene.add(ground);
  const wallSolid = new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0x6e6e6e, side: THREE.DoubleSide }); // белые, наружные грани чуть затенены
  const wallCap = new THREE.MeshBasicMaterial({ color: 0x6b7178 }); // верх стены — тёмный «разрез», как на чертеже
  const wallCapTop = new THREE.MeshBasicMaterial({ color: 0x6b7178, side: THREE.DoubleSide });
  const doorMat = new THREE.MeshLambertMaterial({ color: 0xdcc3a0 });
  const glassMat = new THREE.MeshLambertMaterial({ color: 0xe4f1f8, transparent: true, opacity: 0.6 });
  const plainFloors = [], solidWalls = [];
  const greyMat = new THREE.MeshBasicMaterial({ color: dark ? 0x3a3d43 : 0xcfc9bf, side: THREE.FrontSide });
  const floorMat = new THREE.MeshBasicMaterial({ color: dark ? 0x2b2e33 : 0xb9b2a6, side: THREE.FrontSide });
  const ceilMat = new THREE.MeshBasicMaterial({ color: dark ? 0x44474d : 0xe9e5dd, side: THREE.FrontSide });
  const lineMat = new THREE.LineBasicMaterial({ color: 0xd6cfc3 });
  const furnMat = new THREE.MeshLambertMaterial({ color: 0xd9d8e6 });
  const furnLine = new THREE.LineBasicMaterial({ color: 0xb4b2c6 });

  const surfaces = []; // { key, mesh, w, h }
  const ceilings = [], mirrors = [];
  const roomInfo = {};
  for (const r of rooms) {
    const ring = roomRing(r);                       // контур со скруглениями, h — высота потолка в точке
    const ceil = Math.max(...ring.map(p => p.h));
    const ringArr = ring.map(p => [p.x, p.y]);
    const pts = ring.map(p => new THREE.Vector2(p.x, p.y));
    const tris = THREE.ShapeUtils.triangulateShape(pts, []);
    const bb = roomBBox(r);
    // горизонтальный (или наклонный — при разной высоте) многоугольник; wantUp — нормаль вверх (пол) или вниз (потолок)
    const mkPoly = (yOf, wantUp) => {
      const pos = [], uv = [];
      let idx = [];
      ring.forEach(p => { pos.push(p.x, yOf(p), p.y); uv.push((p.x - bb.x) / (bb.w || 1), 1 - (p.y - bb.y) / (bb.h || 1)); });
      tris.forEach(t => idx.push(t[0], t[1], t[2]));
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      geo.setIndex(idx); geo.computeVertexNormals();
      if ((geo.attributes.normal.getY(0) > 0) !== wantUp) {
        idx = []; tris.forEach(t => idx.push(t[0], t[2], t[1]));
        geo.setIndex(idx); geo.computeVertexNormals();
      }
      return geo;
    };
    const floor = new THREE.Mesh(mkPoly(() => 0, true), floorMat.clone());
    const ceiling = new THREE.Mesh(mkPoly(p => p.h, false), ceilMat.clone());
    scene.add(floor); scene.add(ceiling);
    ceilings.push(ceiling);
    // цветной пол «как на плане» (чуть ниже фото-пола, чтобы не мерцать)
    const plain = new THREE.Mesh(mkPoly(() => -0.004, true), new THREE.MeshLambertMaterial({ color: FLOOR_COLORS[rooms.indexOf(r) % FLOOR_COLORS.length] }));
    plain.receiveShadow = true;
    scene.add(plain); plainFloors.push(plain);

    // ориентация по стене: X вдоль стены (a→b), Y вверх, Z = X×Y (горизонтальная нормаль)
    const basisQ = (ux, uy) => new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(
      new THREE.Vector3(ux, 0, uy), new THREE.Vector3(0, 1, 0), new THREE.Vector3(-uy, 0, ux)));
    const outOff = WALL_T / 2 + 0.003;
    const cs = roomCorners(r);
    const edges = roomEdges(r);
    edges.forEach((e, i) => {
      const tS = cs[i].t, tE = e.len - cs[(i + 1) % edges.length].t;
      const outN = [-e.nx, -e.ny];
      // верх стены на участке [tS, tE]: [[t, h]]
      const prof = wallTop(r, e.id).map(([f, h]) => [f * e.len, h]);
      const hAt = t => wallHAt(r, e.id, t / e.len);
      const top = [[tS, hAt(tS)], ...prof.filter(([t]) => t > tS + 0.005 && t < tE - 0.005), [tE, hAt(tE)]];
      const minTop = (x0, x1) => Math.min(hAt(x0), hAt(x1), ...top.filter(([t]) => t >= x0 && t <= x1).map(q => q[1]));
      const ops = ((r.openings || {})[e.id] || []).filter(o => o.kind !== 'mirror' && o.w > 0 && o.h > 0)
        .map(o => { const x = o.x != null ? o.x : (e.len - o.w) / 2; const y = o.y != null ? o.y : (o.kind === 'door' ? 0 : 1); return { kind: o.kind, passage: !!o.passage, x0: Math.max(tS + 0.02, x), x1: Math.min(tE - 0.02, x + o.w), y0: Math.max(0, y), y1: y + o.h }; })
        .filter(o => o.x1 - o.x0 > 0.05)
        .sort((a, b) => a.x0 - b.x0);
      // контур стены: низ с вырезами дверей, верх по профилю, окна — отверстия
      const shape = new THREE.Shape();
      shape.moveTo(tS, 0);
      let cursor = tS;
      const fills = [];
      for (const o of ops) {
        if (o.x0 < cursor + 0.01) continue;
        const lim = minTop(o.x0, o.x1) - 0.02;
        const y1 = Math.min(o.y1, lim);
        if (o.y0 < 0.05) {
          shape.lineTo(o.x0, 0); shape.lineTo(o.x0, y1); shape.lineTo(o.x1, y1); shape.lineTo(o.x1, 0);
          cursor = o.x1;
          fills.push({ ...o, y0: 0, y1 });
        } else if (y1 - o.y0 > 0.05) {
          const hole = new THREE.Path();
          hole.moveTo(o.x0, o.y0); hole.lineTo(o.x1, o.y0); hole.lineTo(o.x1, y1); hole.lineTo(o.x0, y1); hole.lineTo(o.x0, o.y0);
          shape.holes.push(hole);
          cursor = o.x1;
          fills.push({ ...o, y1 });
        }
      }
      shape.lineTo(tE, 0);
      for (let k = top.length - 1; k >= 0; k--) shape.lineTo(top[k][0], top[k][1]);
      const geo = new THREE.ExtrudeGeometry(shape, { depth: WALL_T, bevelEnabled: false, curveSegments: 1 });
      const zOut = (-e.uy * outN[0] + e.ux * outN[1]) > 0;
      geo.translate(0, 0, zOut ? 0.003 : -(WALL_T + 0.003));
      const wall = new THREE.Mesh(geo, wallSolid);
      wall.castShadow = true;
      wall.position.set(e.a[0], 0, e.a[1]);
      wall.quaternion.copy(basisQ(e.ux, e.uy));
      scene.add(wall); solidWalls.push(wall);
      // сам проём: дверь — тонкая створка, окно — стекло
      for (const o of fills) {
        if (o.passage) continue; // проход без полотна
        const fill = new THREE.Mesh(new THREE.BoxGeometry(o.x1 - o.x0, o.y1 - o.y0, o.kind === 'door' ? 0.03 : 0.02), o.kind === 'door' ? doorMat : glassMat);
        const tc = (o.x0 + o.x1) / 2;
        fill.position.set(e.a[0] + e.ux * tc + outN[0] * outOff, (o.y0 + o.y1) / 2, e.a[1] + e.uy * tc + outN[1] * outOff);
        fill.quaternion.copy(basisQ(e.ux, e.uy));
        scene.add(fill); solidWalls.push(fill);
      }
      // «крышка» стены — тёмная лента одной ширины по профилю верха; в острых углах встык со соседней (как рама),
      // поэтому вдоль всей комнаты ширина одинаковая, без уступов на стыках
      const CAP_IN = 0.002, CAP_OUT = WALL_T + 0.004;
      const miter = (vi, eA, eB) => {   // вершина vi между стенами eA → eB: направление и длина «усов»
        const oA = [-eA.nx, -eA.ny], oB = [-eB.nx, -eB.ny];
        let mx = oA[0] + oB[0], my = oA[1] + oB[1]; const ml = Math.hypot(mx, my) || 1; mx /= ml; my /= ml;
        const k = 1 / Math.max(0.25, mx * oB[0] + my * oB[1]);
        return d => [r.pts[vi][0] + mx * d * k, r.pts[vi][1] + my * d * k];
      };
      const nE = edges.length, prevE = edges[(i - 1 + nE) % nE], nextE = edges[(i + 1) % nE];
      const atStart = cs[i].t > 0 ? null : miter(i, prevE, e);
      const atEnd = cs[(i + 1) % nE].t > 0 ? null : miter((i + 1) % nE, e, nextE);
      const capPos = [], capIdx = [];
      const edgePt = (t, d) => [e.a[0] + e.ux * t + outN[0] * d, e.a[1] + e.uy * t + outN[1] * d];
      // на каждую точку профиля 4 вершины: верх внутр./наруж. и низ внутр./наруж. — лента с бортиками до верха стены,
      // иначе под острым углом в щель между лентой и стеной виден светлый верх стены
      top.forEach(([t, h], k) => {
        const end = k === 0 ? atStart : k === top.length - 1 ? atEnd : null;
        const pin = end ? end(CAP_IN) : edgePt(t, CAP_IN), pout = end ? end(CAP_OUT) : edgePt(t, CAP_OUT);
        const y = h + 0.013, y0 = h - 0.004;
        capPos.push(pin[0], y, pin[1], pout[0], y, pout[1], pin[0], y0, pin[1], pout[0], y0, pout[1]);
        if (k && Math.abs(t - top[k - 1][0]) > 1e-4) {
          const q = 4 * k, p = q - 4;
          capIdx.push(p, p + 1, q, p + 1, q + 1, q);                 // верх
          capIdx.push(p + 1, p + 3, q + 1, p + 3, q + 3, q + 1);     // бортик снаружи
          capIdx.push(p, q, p + 2, p + 2, q, q + 2);                 // бортик внутри
        }
      });
      if (capIdx.length) {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(capPos, 3));
        g.setIndex(capIdx); g.computeVertexNormals();
        const cap = new THREE.Mesh(g, wallCapTop);
        scene.add(cap); solidWalls.push(cap);
      }
    });
    // внешние углы: стены выдавлены наружу от контура, в выпуклом углу остаётся «вырез» — закрываем столбиком
    const area = polyArea(r.pts);
    const T = WALL_T + 0.003;
    edges.forEach((e2, i) => {
      if (cs[i].t > 0) return; // скруглённый угол строится дугой
      const e1 = edges[(i - 1 + edges.length) % edges.length];
      const turn = e1.ux * e2.uy - e1.uy * e2.ux;
      if (turn * area <= 0 || Math.abs(turn) < 1e-3) return; // вогнутый угол или прямая — стены и так сходятся
      const V = r.pts[i], n1 = [-e1.nx, -e1.ny], n2 = [-e2.nx, -e2.ny];
      const P1 = [V[0] + n1[0] * T, V[1] + n1[1] * T], P3 = [V[0] + n2[0] * T, V[1] + n2[1] * T];
      // точка пересечения наружных граней (усовое соединение)
      const den = e1.ux * e2.uy - e1.uy * e2.ux;
      const t = ((P3[0] - P1[0]) * e2.uy - (P3[1] - P1[1]) * e2.ux) / den;
      let M = [P1[0] + e1.ux * t, P1[1] + e1.uy * t];
      if (Math.hypot(M[0] - V[0], M[1] - V[1]) > T * 4) M = [P1[0] + P3[0] - V[0], P1[1] + P3[1] - V[1]];
      const h = Math.max(wallHAt(r, e1.id, 1), wallHAt(r, e2.id, 0)) + 0.012;
      const shape = new THREE.Shape([V, P1, M, P3].map(q => new THREE.Vector2(q[0], -q[1])));
      const geo = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false });
      geo.rotateX(-Math.PI / 2);
      const post = new THREE.Mesh(geo, [wallCap, wallSolid]);
      post.castShadow = true;
      scene.add(post); solidWalls.push(post);
    });
    // скруглённые углы: стена по дуге одним телом (внутренняя и наружная кривые) — без зазубрин на стыках
    cs.forEach((c, i) => {
      if (!(c.t > 0)) return;
      const N = 24, arc = [];
      for (let k = 0; k <= N; k++) arc.push(bezier2(c.A, c.V, c.B, k / N));
      const nrm = arc.map((p, k) => {
        const a = arc[Math.max(0, k - 1)], b = arc[Math.min(N, k + 1)];
        const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
        return [-(b[1] - a[1]) / L, (b[0] - a[0]) / L];
      });
      const m = arc[N >> 1], mn = nrm[N >> 1];
      const sgn = pointInPoly([m[0] + mn[0] * 0.02, m[1] + mn[1] * 0.02], ringArr) ? -1 : 1;
      const off = d => arc.map((p, k) => new THREE.Vector2(p[0] + sgn * nrm[k][0] * d, -(p[1] + sgn * nrm[k][1] * d)));
      const shape = new THREE.Shape([...off(0.003), ...off(T).reverse()]);
      const h = Math.min(wallHAt(r, edges[(i - 1 + edges.length) % edges.length].id, 1), wallHAt(r, edges[i].id, 0));
      const geo = new THREE.ExtrudeGeometry(shape, { depth: h + 0.012, bevelEnabled: false, curveSegments: 1 });
      geo.rotateX(-Math.PI / 2);
      const wall = new THREE.Mesh(geo, [wallCap, wallSolid]);
      wall.castShadow = true;
      scene.add(wall); solidWalls.push(wall);
    });
    surfaces.push({ key: `${r.id}:f`, mesh: floor, w: bb.w, h: bb.h, base: floorMat });
    surfaces.push({ key: `${r.id}:c`, mesh: ceiling, w: bb.w, h: bb.h, base: ceilMat });

    // поверхности для фото: форма стены по профилю (без скруглённых концов), текстура — по всей стене
    edges.forEach((e, i) => {
      const tS = cs[i].t, tE = e.len - cs[(i + 1) % edges.length].t;
      const H = wallMaxH(r, e.id);
      const yaw = Math.atan2(e.nx, e.ny);
      const sx = Math.cos(yaw) * e.ux - Math.sin(yaw) * e.uy; // +1: локальная X идёт от a к b
      const hAt = t => wallHAt(r, e.id, t / e.len);
      const prof = wallTop(r, e.id).map(([f, h]) => [f * e.len, h]).filter(([t]) => t > tS + 0.005 && t < tE - 0.005);
      const outline = [[tS, 0], [tE, 0], [tE, hAt(tE)], ...prof.reverse(), [tS, hAt(tS)]];
      const geo = new THREE.ShapeGeometry(new THREE.Shape(outline.map(([t, h]) => new THREE.Vector2(sx * (t - e.len / 2), h - H / 2))));
      const pos = geo.attributes.position, uv = geo.attributes.uv;
      for (let k = 0; k < pos.count; k++) uv.setXY(k, (pos.getX(k) + e.len / 2) / e.len, (pos.getY(k) + H / 2) / H);
      uv.needsUpdate = true;
      const mesh = new THREE.Mesh(geo, greyMat.clone());
      mesh.position.set(e.mid[0], H / 2, e.mid[1]);
      mesh.rotation.y = yaw; // нормаль внутрь комнаты; локальная ось X — слева направо для зрителя внутри
      scene.add(mesh);
      surfaces.push({ key: `${r.id}:${e.id}`, mesh, w: e.len, h: H, base: greyMat });
      // проёмы и зеркала: дочерние плоскости на стене (локально: X слева направо, Y снизу вверх от пола)
      for (const o of ((r.openings || {})[e.id] || [])) {
        if (!(o.w > 0 && o.h > 0)) continue;
        const ox = o.x != null ? o.x : (e.len - o.w) / 2;
        const oy = o.y != null ? o.y : (o.kind === 'door' ? 0 : 1);
        const w = Math.min(o.w, e.len), h = Math.min(o.h, H);
        const lx = -e.len / 2 + ox + w / 2, ly = -H / 2 + oy + h / 2;
        let child;
        if (o.kind === 'mirror' && window.THREE_Reflector) {
          child = new window.THREE_Reflector(new THREE.PlaneGeometry(w, h), { textureWidth: 512, textureHeight: 512, color: 0xb8c4c8, clipBias: 0.003 });
          mirrors.push(child);
        } else if (o.kind === 'mirror') {
          child = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: 0xb8c4c8 }));
        } else if (o.kind === 'window') {
          child = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: 0x9fc9ea, transparent: true, opacity: 0.75 }));
        } else {
          child = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: dark ? 0x5a4636 : 0x7a5a42 }));
        }
        child.position.set(lx, ly, 0.012);
        mesh.add(child);
      }
    });
    // рёбра: контур пола, потолка и вертикали
    const lp = [];
    ring.forEach((p, i) => {
      const q = ring[(i + 1) % ring.length];
      lp.push(p.x, 0, p.y, q.x, 0, q.y, p.x, p.h, p.y, q.x, q.h, q.y);
      if (p.corner) lp.push(p.x, 0, p.y, p.x, p.h, p.y);
    });
    const lg = new THREE.BufferGeometry(); lg.setAttribute('position', new THREE.Float32BufferAttribute(lp, 3));
    scene.add(new THREE.LineSegments(lg, lineMat));
    // мебель из скана лидаром — светлые блоки с контуром, как в предпросмотре RoomPlan
    for (const o of r.objects || []) {
      const geo = new THREE.BoxGeometry(o.w, o.h, o.d);
      const box = new THREE.Mesh(geo, furnMat);
      box.position.set(o.x, o.z + o.h / 2, o.y);
      box.rotation.y = -o.ang;
      box.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo), furnLine));
      box.castShadow = true; box.receiveShadow = true;
      scene.add(box);
    }
    const c = roomCenter(r);
    roomInfo[r.id] = { center: new THREE.Vector3(c[0], 1.55, c[1]), ceil, name: r.name };
  }

  /* ---------- текстуры по этапу ---------- */
  const texCache = new Map();
  let applyToken = 0;
  async function applyStage() {
    const token = ++applyToken;
    for (const s of surfaces) {
      if (token !== applyToken) return;
      const photo = pickPhoto(photos, s.key, stages, tourState.stage);
      if (!photo) { s.mesh.material = s.base.clone(); continue; }
      const ck = `${photo.id}:${s.w.toFixed(2)}x${s.h.toFixed(2)}`;
      let tex = texCache.get(ck);
      if (!tex) {
        try { tex = await surfaceTexture(THREE, photo, s.w, s.h); texCache.set(ck, tex); }
        catch { s.mesh.material = s.base.clone(); continue; }
        if (token !== applyToken) return;
      }
      s.mesh.material = new THREE.MeshBasicMaterial({ map: tex, side: THREE.FrontSide });
    }
    updateHint();
  }

  /* ---------- финальный скан (окрашенная сетка) ---------- */
  let finalMesh = null;
  async function loadFinal() {
    if (finalMesh || !(project.finalScan && project.finalScan.blob) || !window.THREE_PLYLoader) return;
    try {
      const buf = await project.finalScan.blob.arrayBuffer();
      const geo = new window.THREE_PLYLoader().parse(buf);
      geo.computeVertexNormals();
      const mat = new THREE.MeshLambertMaterial({ vertexColors: geo.hasAttribute('color'), side: THREE.DoubleSide });
      finalMesh = new THREE.Mesh(geo, mat);
      // из координат ARKit (X, Y вверх, Z) в план: тот же поворот+сдвиг, что применялся к комнатам
      const tr = project.finalScan.transform || { ang: 0, ox: 0, oy: 0 };
      // план: x = X·cos − Z·sin + ox, z = X·sin + Z·cos + oy ; высота Y остаётся
      finalMesh.rotation.y = -tr.ang;
      finalMesh.position.set(tr.ox, 0, tr.oy);
      finalMesh.visible = false;
      scene.add(finalMesh);
    } catch (err) { console.error(err); say('Не удалось открыть финальный скан'); }
  }

  /* ---------- HD-скан: Gaussian splatting, обученный на компьютере по HD-пакету ---------- */
  let hdViewer = null, hdCenter = null, hdLoading = null;
  function loadHD() {
    if (hdViewer || hdLoading || !(project.hdScan && project.hdScan.blob)) return hdLoading || Promise.resolve();
    hdLoading = (async () => {
      say('Загружаю HD-модель…');
      try {
        const GS = await import('./vendor/gaussian-splats-3d.module.js');
        const fmt = { ply: GS.SceneFormat.Ply, spz: GS.SceneFormat.Spz, splat: GS.SceneFormat.Splat, ksplat: GS.SceneFormat.KSplat }[project.hdScan.format] ?? GS.SceneFormat.Ply;
        const v = new GS.DropInViewer({ sharedMemoryForWorkers: false, gpuAcceleratedSort: false, dynamicScene: false, sceneRevealMode: GS.SceneRevealMode.Instant });
        const url = URL.createObjectURL(project.hdScan.blob);
        // пакет снят в координатах AR-сессии финального скана → тот же поворот и сдвиг, что у сетки «Финал»
        const tr = project.finalScan && project.finalScan.transform || { ang: 0, ox: 0, oy: 0 };
        v.rotation.y = -tr.ang; v.position.set(tr.ox, 0, tr.oy);
        if (project.hdScan.flip) v.rotation.x = Math.PI;   // модель из программ с осью Y вниз
        try { await v.addSplatScene(url, { format: fmt, showLoadingUI: false, progressiveLoad: false, splatAlphaRemovalThreshold: 5 }); }
        finally { URL.revokeObjectURL(url); }
        scene.add(v); v.updateMatrixWorld(true);
        // центр модели по выборке сплатов — вокруг него крутится камера (если модель не совпала с планом, всё равно в кадре)
        const sb = v.getSplatScene(0).splatBuffer, n = sb.getSplatCount(), step = Math.max(1, Math.floor(n / 3000));
        const xs = [], ys = [], zs = [], p = new THREE.Vector3();
        for (let i = 0; i < n; i += step) { sb.getSplatCenter(i, p); p.applyMatrix4(v.matrixWorld); xs.push(p.x); ys.push(p.y); zs.push(p.z); }
        const med = a => { a.sort((x, y) => x - y); return a[Math.floor(a.length / 2)] || 0; };
        hdCenter = new THREE.Vector3(med(xs), med(ys), med(zs));
        hdViewer = v; say('');
      } catch (err) { console.error(err); say('Не удалось открыть HD-модель: ' + err.message); }
      hdLoading = null;
    })();
    return hdLoading;
  }

  /* ---------- камера и управление ---------- */
  const orbit = { theta: Math.PI * 0.15, phi: 0.38, radius: span * 1.55, target: centerAll.clone() };
  const look = { yaw: 0, pitch: 0 };
  function placeCamera() {
    if (orbitMode()) {
      const { theta, phi, radius } = orbit;
      const target = tourState.mode === 'hd' && hdCenter ? hdCenter : orbit.target;
      camera.position.set(target.x + radius * Math.sin(phi) * Math.sin(theta), target.y + radius * Math.cos(phi), target.z + radius * Math.sin(phi) * Math.cos(theta));
      camera.lookAt(target);
    } else if (tourState.mode === 'inside') {
      const ri = roomInfo[tourState.roomId];
      if (tourState.eye && tourState.eye.room === tourState.roomId && ri) camera.position.set(tourState.eye.x, ri.center.y, tourState.eye.z);
      else if (ri) camera.position.copy(ri.center);
      camera.rotation.set(0, 0, 0, 'YXZ');
      camera.rotation.y = look.yaw; camera.rotation.x = look.pitch;
    }
  }
  function resize() {
    const r = canvas.parentElement.getBoundingClientRect();
    const w = Math.max(1, Math.floor(r.width)), h = Math.max(1, Math.floor(r.height));
    renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.updateProjectionMatrix();
    // стартовый масштаб: квартира целиком помещается в свободную часть экрана (ниже кнопок сверху, с полями по краям)
    if (!orbit.userZoom) orbit.radius = orbitMode() ? fitRadius(w, h) : span * 1.55 * Math.max(1, 0.85 / (w / h));
  }
  // подбор расстояния камеры: углы габарита квартиры (с высотой стен) должны попасть в кадр
  function fitRadius(w, h) {
    const box = canvas.parentElement.getBoundingClientRect(), top = canvas.parentElement.querySelector('.tour-top');
    const topPx = top ? top.getBoundingClientRect().bottom - box.top + 10 : 60;
    const nav = document.querySelector('.bottomnav'), navPx = nav ? box.bottom - nav.getBoundingClientRect().top : 0; // сцена уходит под нижнее меню
    const yTop = 1 - 2 * topPx / h, yBot = -1 + 2 * (navPx + 24) / h, xLim = 1 - 2 * 14 / w;
    const hMax = Math.max(2.5, ...rooms.map(roomCeil)), pad = 0.2, pts = [];
    for (const x of [minX - pad, maxX + pad]) for (const z of [minZ - pad, maxZ + pad]) for (const y of [0, hMax]) pts.push(new THREE.Vector3(x, y, z));
    const v = new THREE.Vector3(), saved = orbit.radius;
    const fits = rad => {
      orbit.radius = rad; placeCamera(); camera.updateMatrixWorld();
      return pts.every(p => { v.copy(p).project(camera); return v.z < 1 && Math.abs(v.x) <= xLim && v.y <= yTop && v.y >= yBot; });
    };
    let lo = span * 0.3, hi = span * 10;
    if (!fits(hi)) { orbit.radius = saved; return span * 1.55 * Math.max(1, 0.85 / (w / h)); }
    for (let i = 0; i < 30; i++) { const mid = (lo + hi) / 2; if (fits(mid)) hi = mid; else lo = mid; }
    return hi;
  }
  const pointers = new Map();
  let lastPinch = 0, lastAng = null;
  canvas.addEventListener('pointerdown', e => { pointers.set(e.pointerId, { x: e.clientX, y: e.clientY }); try { canvas.setPointerCapture(e.pointerId); } catch {} });
  canvas.addEventListener('pointermove', e => {
    const p = pointers.get(e.pointerId); if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      // поворот двумя пальцами
      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      if (lastAng !== null) {
        let da = ang - lastAng;
        if (da > Math.PI) da -= Math.PI * 2; else if (da < -Math.PI) da += Math.PI * 2;
        if (orbitMode()) orbit.theta += da; else look.yaw += da; // модель следует за пальцами
      }
      lastAng = ang;
      if (lastPinch) {
        if (orbitMode()) { orbit.userZoom = true; orbit.radius = Math.max(span * 0.3, Math.min(span * 6, orbit.radius * lastPinch / d)); }
        else { camera.fov = Math.max(30, Math.min(100, camera.fov * lastPinch / d)); camera.updateProjectionMatrix(); }
      }
      lastPinch = d; return;
    }
    if (orbitMode()) {
      orbit.theta -= dx * 0.006; orbit.phi = Math.max(0.12, Math.min(1.45, orbit.phi - dy * 0.005));
    } else {
      look.yaw += dx * 0.005; look.pitch = Math.max(-1.3, Math.min(1.3, look.pitch + dy * 0.005));
    }
  });
  const up = e => { pointers.delete(e.pointerId); if (pointers.size < 2) { lastPinch = 0; lastAng = null; } };
  canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    if (orbitMode()) { orbit.userZoom = true; orbit.radius = Math.max(span * 0.3, Math.min(span * 6, orbit.radius * (e.deltaY > 0 ? 1.1 : 0.9))); }
  }, { passive: false });

  /* ---------- мини-план ---------- */
  function drawPlan() {
    const pad = 0.4;
    const vb = `${minX - pad} ${minZ - pad} ${maxX - minX + pad * 2} ${maxZ - minZ + pad * 2}`;
    $('#tour-plan').innerHTML = `<svg viewBox="${vb}" preserveAspectRatio="xMidYMid meet">
      ${rooms.map(r => `<path class="tp-room ${r.id === tourState.roomId ? 'sel' : ''}" data-room="${r.id}" d="${roomPath(r)}"/>`).join('')}
      ${rooms.map(r => { const c = roomCenter(r); return `<text class="tp-label" x="${c[0]}" y="${c[1]}">${esc(r.name)}</text>`; }).join('')}
      <g id="tp-eye" style="display:none"><path id="tp-cone" class="tp-cone"/><circle class="tp-dot" r="${Math.max(0.12, span * 0.025)}"/></g>
    </svg>`;
  }
  // тап по мини-плану — встать в эту точку (в режиме «Объект» — зайти внутрь), тянуть — идти
  const planBox = $('#tour-plan');
  const planPt = e => {
    const svg = planBox.querySelector('svg'); if (!svg) return null;
    const m = svg.getScreenCTM(); if (!m) return null;
    const pt = svg.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY;
    const q = pt.matrixTransform(m.inverse());
    return [q.x, q.y];
  };
  const roomAtPt = q => rooms.find(r => pointInPoly(q, r.pts));
  function setEye(r, q) {
    const changed = r.id !== tourState.roomId;
    tourState.roomId = r.id;
    tourState.eye = { room: r.id, x: q[0], z: q[1] };
    if (orbitMode()) { look.pitch = 0; setMode('inside'); return; }
    if (changed) { drawPlan(); updateHint(); }
  }
  let eyeDrag = false;
  planBox.addEventListener('pointerdown', e => {
    const q = planPt(e); const r = q && roomAtPt(q);
    if (!r) return;
    e.preventDefault();
    eyeDrag = true;
    try { planBox.setPointerCapture(e.pointerId); } catch {}
    setEye(r, q);
  });
  planBox.addEventListener('pointermove', e => {
    if (!eyeDrag) return;
    const q = planPt(e); const r = q && roomAtPt(q);
    if (r) setEye(r, q);
  });
  const stopEye = () => { eyeDrag = false; };
  planBox.addEventListener('pointerup', stopEye);
  planBox.addEventListener('pointercancel', stopEye);
  // точка наблюдателя и конус взгляда — обновляются каждый кадр
  function updateEye() {
    const g = document.getElementById('tp-eye');
    if (!g) return;
    if (tourState.mode !== 'inside') { g.style.display = 'none'; return; }
    g.style.display = '';
    const pos = camera.position;
    g.setAttribute('transform', `translate(${pos.x} ${pos.z}) rotate(${-look.yaw * 180 / Math.PI})`);
    const half = Math.atan(Math.tan(camera.fov * Math.PI / 360) * camera.aspect);
    const L = Math.max(0.8, span * 0.22), sx = Math.sin(half) * L, sy = Math.cos(half) * L;
    const cone = document.getElementById('tp-cone');
    if (cone) cone.setAttribute('d', `M0 0 L${-sx} ${-sy} A${L} ${L} 0 0 1 ${sx} ${-sy} Z`);
  }
  function updateHint() {
    const ri = roomInfo[tourState.roomId];
    const name = ri ? ri.name : '';
    if (tourState.mode === 'house') hint.textContent = 'Крутите пальцем или двумя, щипок — масштаб. Тап по плану — встать в эту точку внутри.';
    else if (tourState.mode === 'inside') hint.textContent = `${name}: осмотритесь пальцем. Ведите точку на плане — чтобы перейти.`;
    if (tourState.mode === 'hd') hint.textContent = 'HD-скан. Крутите пальцем, щипок — масштаб.';
    if (tourState.mode === 'final') hint.textContent = `Финальный скан: ${project.finalScan ? (project.finalScan.vertices || 0) + ' вершин' : ''}. Крутите пальцем, щипок — масштаб.`;
    app.querySelectorAll('[data-mode]').forEach(b => b.classList.toggle('active', b.dataset.mode === tourState.mode));
    const pb = $('#tour-photos'); if (pb) pb.classList.toggle('active', tourState.photos);
    const isHD = tourState.mode === 'hd';
    const isFinal = tourState.mode === 'final' || isHD, isInside = tourState.mode === 'inside';
    const photosOn = isInside || tourState.photos;
    for (const c of ceilings) c.visible = isInside;                              // потолки только изнутри
    for (const s of surfaces) { const isFloor = s.key.endsWith(':f'), isCeil = s.key.endsWith(':c'); if (isCeil) continue; s.mesh.visible = !!(!isFinal && photosOn && (!isFloor || s.mesh.material.map)); } // visible строго true/false: three.js прячет объект только при visible === false
    for (const f of plainFloors) f.visible = !isFinal;
    for (const w of solidWalls) w.visible = !isFinal;
    if (finalMesh) finalMesh.visible = tourState.mode === 'final';
    if (hdViewer) hdViewer.visible = isHD;
  }
  function setMode(m) {
    tourState.mode = m;
    if (m === 'final') loadFinal().then(updateHint);
    if (m === 'hd') loadHD().then(updateHint);
    updateHint(); drawPlan();
  }
  app.querySelectorAll('[data-mode]').forEach(b => { b.onclick = () => { look.yaw = 0; look.pitch = 0; if (b.dataset.mode === 'inside') tourState.eye = null; setMode(b.dataset.mode); }; });
  const rpBtn = app.querySelector('#tour-rp');
  if (rpBtn) rpBtn.onclick = () => {
    const list = roomPlanModels(project, rooms);
    const open = m => openRoomPlanModel(m.blob, m.title).catch(err => alert(err.message));
    if (list.length === 1) { open(list[0]); return; }
    const host = document.createElement('div');
    host.className = 'plan-sheet tpl-sheet';
    host.innerHTML = `<div class="sh-title">Модель RoomPlan</div>
      <p class="mut small">Оригинальная модель Apple из скана: крутите пальцем, вкладка AR ставит её в комнату.</p>
      ${list.map((m, i) => `<button class="btn wide" data-rp="${i}">${esc(m.title)} <small class="mut">· ${fmtDate(m.at)}</small></button>`).join('')}
      <button class="btn ghost wide" data-rp="x">Отмена</button>`;
    document.body.appendChild(host);
    host.querySelectorAll('[data-rp]').forEach(b => b.onclick = () => { host.remove(); if (b.dataset.rp !== 'x') open(list[+b.dataset.rp]); });
  };
  const photosBtn = $('#tour-photos');
  if (photosBtn) photosBtn.onclick = () => { tourState.photos = !tourState.photos; updateHint(); };
  if ($('#tour-stage')) $('#tour-stage').onchange = e => { tourState.stage = e.target.value; applyStage(); };

  /* ---------- экспорт в GLB: стены, полы, потолки, проёмы, мебель, фото выбранного этапа ---------- */
  const glbBtn = $('#tour-glb');
  if (glbBtn) glbBtn.onclick = async () => {
    if (glbBtn.disabled) return;
    glbBtn.disabled = true; say('Готовлю 3D-модель…');
    const saved = [], temp = [];
    const setVis = (o, v) => { saved.push([o, o.visible, o.name]); o.visible = v; };
    let blob = null;
    try {
      const { GLTFExporter } = await import('./vendor/GLTFExporter.js');
      await applyStage();
      // свет, тень-подложка, финальный и HD-скан, зеркала-отражатели (свой шейдер) в файл не идут
      scene.traverse(o => { if (o.isLight || o === ground || o === finalMesh || o === hdViewer || mirrors.includes(o)) setVis(o, false); });
      for (const m of mirrors) { // вместо отражателя — простая серо-голубая плоскость
        const p = new THREE.Mesh(m.geometry, new THREE.MeshBasicMaterial({ color: 0xb8c4c8 }));
        p.position.copy(m.position); p.quaternion.copy(m.quaternion); p.name = 'Зеркало';
        m.parent.add(p); temp.push(p);
      }
      for (const w of solidWalls) { setVis(w, true); w.name = w.name || 'Стена'; }
      plainFloors.forEach((f, i) => { setVis(f, true); f.name = `${rooms[i].name} · пол`; });
      for (const s of surfaces) {
        const { roomId, side } = parseWallKey(s.key);
        const room = rooms.find(r => r.id === roomId);
        const isFloor = side === 'f', isCeil = side === 'c';
        // стены — всегда (на них висят двери и окна), фото-пол — только если есть фото
        setVis(s.mesh, isCeil || !isFloor || !!s.mesh.material.map);
        s.mesh.name = room ? (isFloor ? `${room.name} · пол (фото)` : isCeil ? `${room.name} · потолок` : wallLabel(room, side)) : s.key;
      }
      const buf = await new GLTFExporter().parseAsync(scene, { binary: true, onlyVisible: true, maxTextureSize: 2048 });
      blob = new Blob([buf], { type: 'model/gltf-binary' });
    } catch (err) {
      console.error(err); alert('Не удалось собрать модель: ' + err.message);
    } finally {
      temp.forEach(p => { p.parent.remove(p); p.material.dispose(); });
      for (let i = saved.length - 1; i >= 0; i--) { saved[i][0].visible = saved[i][1]; saved[i][0].name = saved[i][2]; }
      glbBtn.disabled = false; say(''); updateHint();
    }
    if (!blob) return;
    // отправка — отдельным тапом: после долгой сборки браузер уже не считает это действием пользователя и не откроет «Поделиться»
    const stageName = tourState.stage === 'all' ? 'последние фото' : (stages.find(s => s.id === tourState.stage) || {}).name || '';
    const file = `${(project.name || 'model').replace(/[\\/:*?"<>|]+/g, '_')}.glb`;
    const host = document.createElement('div');
    host.className = 'plan-sheet tpl-sheet';
    host.innerHTML = `<div class="sh-title">3D-модель готова</div>
      <p class="mut small">${esc(file)} · ${(blob.size / 1048576).toFixed(1).replace('.', ',')} МБ · фото: ${esc(stageName)}.<br>Формат GLB открывается в Blender, SketchUp, онлайн-просмотрщиках и на сайтах.</p>
      <button class="btn primary wide" data-glb="send">${I('share')}Отправить или сохранить</button>
      <button class="btn ghost wide" data-glb="x">Закрыть</button>`;
    document.body.appendChild(host);
    host.querySelector('[data-glb="send"]').onclick = async () => { host.remove(); await deliverFile(blob, file, `3D-модель: ${project.name}`); };
    host.querySelector('[data-glb="x"]').onclick = () => host.remove();
  };

  /* ---------- цикл ---------- */
  let alive = true;
  function frame() {
    if (!alive) return;
    placeCamera();
    updateEye();
    renderer.render(scene, camera);
    requestAnimationFrame(frame);
  }
  const ro = new ResizeObserver(resize); ro.observe(canvas.parentElement);
  resize(); setMode(tourState.mode); frame();
  applyStage();
  // экспорт GLB запускают из «Ещё»: открываем 3D и собираем модель текущей сцены (кнопка на экране 3D скрыта)
  if (tourState.exportGlb) { tourState.exportGlb = false; setTimeout(() => { if (glbBtn) glbBtn.click(); }, 400); }

  window.__tourDebug = () => ({ total: surfaces.length, textured: surfaces.filter(s => s.mesh.material.map).length, mirrors: mirrors.length, mode: tourState.mode, stage: tourState.stage, room: tourState.roomId, solidWalls: solidWalls.length, plainFloors: plainFloors.length, photos: tourState.photos, finalLoaded: !!finalMesh, wallPlanesVisible: surfaces.filter(s => !s.key.endsWith(':f') && !s.key.endsWith(':c') && s.mesh.visible).length, floors: plainFloors.map(f => ({ color: f.material.color.getHexString(), visible: f.visible, y: f.position.y, n: f.geometry.attributes.normal.getY(0) })), floorPlanes: surfaces.filter(s => s.key.endsWith(':f')).map(s => ({ key: s.key, visible: s.mesh.visible, map: !!s.mesh.material.map })) });
  window.__tourScene = scene;
  viewCleanup = () => {
    alive = false; ro.disconnect(); delete window.__tourDebug;
    texCache.forEach(t => t.dispose());
    mirrors.forEach(m => m.dispose && m.dispose());
    if (hdViewer) { scene.remove(hdViewer); hdViewer.dispose().catch(() => {}); }
    renderer.dispose();
  };
}
