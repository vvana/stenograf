/* Стенограф — 3D-тур: «кукольный домик» из схемы и фото, вид изнутри, панорамы 360° */
'use strict';

const tourState = { mode: 'house', stage: 'all', roomId: null };
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

  app.innerHTML = `
    ${header('3D-тур', `#/p/${pid}`)}
    <div class="tour">
      <canvas id="tour-canvas"></canvas>
      <div class="tour-top">
        <select class="inp" id="tour-stage">
          <option value="all" ${tourState.stage === 'all' ? 'selected' : ''}>Сейчас — последние фото</option>
          ${stages.map(s => `<option value="${s.id}" ${tourState.stage === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}
        </select>
        <div class="tour-modes">
          <button data-mode="house" class="${tourState.mode === 'house' ? 'active' : ''}">🏠 Домик</button>
          <button data-mode="inside" class="${tourState.mode === 'inside' ? 'active' : ''}">👁 Внутри</button>
          <button data-mode="pano" class="${tourState.mode === 'pano' ? 'active' : ''}">🌐 360°</button>
        </div>
      </div>
      <div class="tour-bottom">
        <div class="tour-hint" id="tour-hint"></div>
        <div class="tour-plan" id="tour-plan"></div>
      </div>
      <div class="tour-msg hidden" id="tour-msg"></div>
    </div>
    ${bottomNav(pid, 'tour')}`;

  const msg = $('#tour-msg'), hint = $('#tour-hint');
  const say = t => { msg.textContent = t; msg.classList.toggle('hidden', !t); };
  if (!rooms.length) { say('Сначала нарисуйте схему — тур строится из комнат и их фото.'); return; }

  let THREE;
  try { THREE = await threeReady(); } catch (err) { say(err.message + '. Проверьте соединение и обновите страницу.'); return; }

  /* ---------- сцена ---------- */
  const canvas = $('#tour-canvas');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  renderer.setClearColor(dark ? 0x1b1d21 : 0xe6e2da);
  const scene = new THREE.Scene();
  const panoScene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, 1, 0.05, 500);
  const panoCam = new THREE.PerspectiveCamera(75, 1, 0.1, 200);

  const bbAll = rooms.map(roomBBox);
  const minX = Math.min(...bbAll.map(b => b.x)), maxX = Math.max(...bbAll.map(b => b.x + b.w));
  const minZ = Math.min(...bbAll.map(b => b.y)), maxZ = Math.max(...bbAll.map(b => b.y + b.h));
  const centerAll = new THREE.Vector3((minX + maxX) / 2, 0.6, (minZ + maxZ) / 2);
  const span = Math.max(maxX - minX, maxZ - minZ, 4);

  const greyMat = new THREE.MeshBasicMaterial({ color: dark ? 0x3a3d43 : 0xcfc9bf, side: THREE.FrontSide });
  const floorMat = new THREE.MeshBasicMaterial({ color: dark ? 0x2b2e33 : 0xb9b2a6, side: THREE.FrontSide });
  const ceilMat = new THREE.MeshBasicMaterial({ color: dark ? 0x44474d : 0xe9e5dd, side: THREE.FrontSide });
  const lineMat = new THREE.LineBasicMaterial({ color: dark ? 0x9a9a9a : 0x555555 });

  const surfaces = []; // { key, mesh, w, h }
  const ceilings = [], mirrors = [];
  const roomInfo = {};
  for (const r of rooms) {
    const ceil = roomCeil(r);
    const pts = r.pts.map(p => new THREE.Vector2(p[0], p[1]));
    const tris = THREE.ShapeUtils.triangulateShape(pts, []);
    const bb = roomBBox(r);
    // горизонтальный многоугольник; wantUp — нормаль вверх (пол) или вниз (потолок), порядок вершин проверяем по нормали
    const mkPoly = (y, wantUp) => {
      const pos = [], uv = [];
      let idx = [];
      pts.forEach(p => { pos.push(p.x, y, p.y); uv.push((p.x - bb.x) / (bb.w || 1), 1 - (p.y - bb.y) / (bb.h || 1)); });
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
    const floor = new THREE.Mesh(mkPoly(0, true), floorMat.clone());
    const ceiling = new THREE.Mesh(mkPoly(ceil, false), ceilMat.clone());
    scene.add(floor); scene.add(ceiling);
    ceilings.push(ceiling);
    surfaces.push({ key: `${r.id}:f`, mesh: floor, w: bb.w, h: bb.h, base: floorMat });
    surfaces.push({ key: `${r.id}:c`, mesh: ceiling, w: bb.w, h: bb.h, base: ceilMat });

    for (const e of roomEdges(r)) {
      const geo = new THREE.PlaneGeometry(e.len, ceil);
      const mesh = new THREE.Mesh(geo, greyMat.clone());
      mesh.position.set(e.mid[0], ceil / 2, e.mid[1]);
      mesh.rotation.y = Math.atan2(e.nx, e.ny); // нормаль внутрь комнаты; локальная ось X — слева направо для зрителя внутри
      scene.add(mesh);
      surfaces.push({ key: `${r.id}:${e.id}`, mesh, w: e.len, h: ceil, base: greyMat });
      // проёмы и зеркала: дочерние плоскости на стене (локально: X слева направо, Y снизу вверх от пола)
      for (const o of ((r.openings || {})[e.id] || [])) {
        if (!(o.w > 0 && o.h > 0)) continue;
        const ox = o.x != null ? o.x : (e.len - o.w) / 2;
        const oy = o.y != null ? o.y : (o.kind === 'door' ? 0 : 1);
        const w = Math.min(o.w, e.len), h = Math.min(o.h, ceil);
        const lx = -e.len / 2 + ox + w / 2, ly = -ceil / 2 + oy + h / 2;
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
    }
    // рёбра: контур пола, потолка и вертикали
    const lp = [];
    r.pts.forEach((p, i) => {
      const q = r.pts[(i + 1) % r.pts.length];
      lp.push(p[0], 0, p[1], q[0], 0, q[1], p[0], ceil, p[1], q[0], ceil, q[1], p[0], 0, p[1], p[0], ceil, p[1]);
    });
    const lg = new THREE.BufferGeometry(); lg.setAttribute('position', new THREE.Float32BufferAttribute(lp, 3));
    scene.add(new THREE.LineSegments(lg, lineMat));
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
    await applyPano();
  }

  /* ---------- панорама ---------- */
  let panoMesh = null, panoAvailable = false;
  async function applyPano() {
    if (panoMesh) { panoScene.remove(panoMesh); panoMesh.geometry.dispose(); panoMesh.material.map?.dispose(); panoMesh = null; }
    panoAvailable = false;
    const photo = tourState.roomId ? pickPhoto(photos, `${tourState.roomId}:p`, stages, tourState.stage) : null;
    if (!photo) { updateHint(); return; }
    try {
      const bmp = await createImageBitmap(photo.blob);
      const aspect = bmp.width / bmp.height;
      const cvs = document.createElement('canvas');
      const cw = Math.min(4096, bmp.width); cvs.width = cw; cvs.height = Math.round(cw / aspect);
      cvs.getContext('2d').drawImage(bmp, 0, 0, cvs.width, cvs.height); bmp.close();
      const tex = canvasTexture(THREE, cvs);
      const full = aspect > 1.85 && aspect < 2.15;
      const vfov = full ? Math.PI : 65 * Math.PI / 180;
      const hfov = full ? Math.PI * 2 : Math.min(Math.PI * 2, vfov * aspect);
      const geo = new THREE.SphereGeometry(50, 64, 32, Math.PI / 2 - hfov / 2, hfov, Math.PI / 2 - vfov / 2, vfov);
      geo.scale(-1, 1, 1);
      panoMesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: tex }));
      panoScene.add(panoMesh);
      panoAvailable = true;
    } catch { panoAvailable = false; }
    updateHint();
  }

  /* ---------- камера и управление ---------- */
  const orbit = { theta: Math.PI * 0.15, phi: 0.95, radius: span * 1.4, target: centerAll.clone() };
  const look = { yaw: 0, pitch: 0 };
  function placeCamera() {
    if (tourState.mode === 'house') {
      const { theta, phi, radius, target } = orbit;
      camera.position.set(target.x + radius * Math.sin(phi) * Math.sin(theta), target.y + radius * Math.cos(phi), target.z + radius * Math.sin(phi) * Math.cos(theta));
      camera.lookAt(target);
    } else if (tourState.mode === 'inside') {
      const ri = roomInfo[tourState.roomId];
      if (ri) camera.position.copy(ri.center);
      camera.rotation.set(0, 0, 0, 'YXZ');
      camera.rotation.y = look.yaw; camera.rotation.x = look.pitch;
    } else {
      panoCam.position.set(0, 0, 0);
      panoCam.rotation.set(0, 0, 0, 'YXZ');
      panoCam.rotation.y = look.yaw; panoCam.rotation.x = look.pitch;
    }
  }
  function resize() {
    const r = canvas.parentElement.getBoundingClientRect();
    const w = Math.max(1, Math.floor(r.width)), h = Math.max(1, Math.floor(r.height));
    renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.updateProjectionMatrix();
    panoCam.aspect = w / h; panoCam.updateProjectionMatrix();
  }
  const pointers = new Map();
  let lastPinch = 0;
  canvas.addEventListener('pointerdown', e => { pointers.set(e.pointerId, { x: e.clientX, y: e.clientY }); try { canvas.setPointerCapture(e.pointerId); } catch {} });
  canvas.addEventListener('pointermove', e => {
    const p = pointers.get(e.pointerId); if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (lastPinch) {
        if (tourState.mode === 'house') orbit.radius = Math.max(span * 0.3, Math.min(span * 4, orbit.radius * lastPinch / d));
        else { const cam = tourState.mode === 'pano' ? panoCam : camera; cam.fov = Math.max(30, Math.min(100, cam.fov * lastPinch / d)); cam.updateProjectionMatrix(); }
      }
      lastPinch = d; return;
    }
    if (tourState.mode === 'house') {
      orbit.theta -= dx * 0.006; orbit.phi = Math.max(0.12, Math.min(1.45, orbit.phi - dy * 0.005));
    } else {
      look.yaw += dx * 0.005; look.pitch = Math.max(-1.3, Math.min(1.3, look.pitch + dy * 0.005));
    }
  });
  const up = e => { pointers.delete(e.pointerId); if (pointers.size < 2) lastPinch = 0; };
  canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    if (tourState.mode === 'house') orbit.radius = Math.max(span * 0.3, Math.min(span * 4, orbit.radius * (e.deltaY > 0 ? 1.1 : 0.9)));
  }, { passive: false });

  /* ---------- мини-план ---------- */
  function drawPlan() {
    const pad = 0.4;
    const vb = `${minX - pad} ${minZ - pad} ${maxX - minX + pad * 2} ${maxZ - minZ + pad * 2}`;
    $('#tour-plan').innerHTML = `<svg viewBox="${vb}" preserveAspectRatio="xMidYMid meet">
      ${rooms.map(r => `<path class="tp-room ${r.id === tourState.roomId ? 'sel' : ''}" data-room="${r.id}" d="${roomPath(r)}"/>`).join('')}
      ${rooms.map(r => { const c = roomCenter(r); return `<text class="tp-label" x="${c[0]}" y="${c[1]}">${esc(r.name)}</text>`; }).join('')}
    </svg>`;
    $('#tour-plan').querySelectorAll('[data-room]').forEach(el => {
      el.onclick = () => {
        tourState.roomId = el.dataset.room;
        if (tourState.mode === 'house') tourState.mode = 'inside';
        look.yaw = 0; look.pitch = 0;
        setMode(tourState.mode);
        applyPano();
      };
    });
  }
  function updateHint() {
    const ri = roomInfo[tourState.roomId];
    const name = ri ? ri.name : '';
    if (tourState.mode === 'house') hint.textContent = 'Крутите пальцем, щипок — масштаб. Тап по комнате на плане — зайти внутрь.';
    else if (tourState.mode === 'inside') hint.textContent = `${name}: осмотритесь пальцем. Серые стены — фото ещё нет.`;
    else hint.textContent = panoAvailable ? `${name}: панорама 360°` : `${name}: панорамы для этого этапа нет — снимите её штатной камерой (режим «Панорама») и добавьте на экране «🌐 Панорама» комнаты.`;
    app.querySelectorAll('[data-mode]').forEach(b => b.classList.toggle('active', b.dataset.mode === tourState.mode));
    for (const c of ceilings) c.visible = tourState.mode !== 'house';
  }
  function setMode(m) {
    tourState.mode = m;
    updateHint(); drawPlan();
  }
  app.querySelectorAll('[data-mode]').forEach(b => { b.onclick = () => { look.yaw = 0; look.pitch = 0; setMode(b.dataset.mode); }; });
  $('#tour-stage').onchange = e => { tourState.stage = e.target.value; applyStage(); };

  /* ---------- цикл ---------- */
  let alive = true;
  function frame() {
    if (!alive) return;
    placeCamera();
    if (tourState.mode === 'pano' && panoAvailable) renderer.render(panoScene, panoCam);
    else renderer.render(scene, camera);
    requestAnimationFrame(frame);
  }
  const ro = new ResizeObserver(resize); ro.observe(canvas.parentElement);
  resize(); setMode(tourState.mode); frame();
  applyStage();

  window.__tourDebug = () => ({ total: surfaces.length, textured: surfaces.filter(s => s.mesh.material.map).length, mirrors: mirrors.length, pano: panoAvailable, mode: tourState.mode, stage: tourState.stage, room: tourState.roomId });
  viewCleanup = () => {
    alive = false; ro.disconnect(); delete window.__tourDebug;
    texCache.forEach(t => t.dispose());
    mirrors.forEach(m => m.dispose && m.dispose());
    renderer.dispose();
  };
}
