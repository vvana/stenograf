/* Fixpoint — 3D-тур: «кукольный домик» из схемы и фото, вид изнутри */
'use strict';

const tourState = { mode: 'house', stage: 'all', roomId: null, photos: false, hdModel: null };   // hdModel — показать одну модель (id), null — все модели этапа
const FLOOR_COLORS = [0xe3cfae, 0xd8d6d0, 0xead9bd, 0xcfc6b6, 0xe6dfd2, 0xdcc7a4]; // светлое дерево и светло-серый — спокойные полы, как в планировщиках
const WALL_T = 0.12; // толщина стен на «домике», м
const TEX_W = 768;

/* ---------- стиль «визуализация планировки» (образцы пользователя 2026-10-14):
   белые стены с белым срезом, светлый дуб на полу, плитка в санузлах, мягкие тени, мебель из простых форм ---------- */
// паркетная доска / плитка на canvas: текстура на квадрат 2 × 2 м, повторяется по полу
// Полотно двери (канва 256×600, растягивается на проём): светло-серое, с наличником, три филёнки с двойным
// багетом (свет сверху-слева, тень снизу-справа) и хромированная ручка слева. Кешируется — одна на сцену.
let doorTexCache = null;
function doorTexture(THREE) {
  if (doorTexCache) return doorTexCache;
  const W = 256, H = 600, c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.fillStyle = '#a3a8b0'; g.fillRect(0, 0, W, H);                  // наличник
  g.fillStyle = '#b9bdc4'; g.fillRect(10, 8, W - 20, H - 8);         // полотно
  const bevel = (x, y, w, h, d, light, shade) => {                   // рамка багета: верх/лево светлее, низ/право темнее
    g.fillStyle = light; g.fillRect(x, y, w, d); g.fillRect(x, y, d, h);
    g.fillStyle = shade; g.fillRect(x, y + h - d, w, d); g.fillRect(x + w - d, y, d, h);
  };
  const panel = (y, h) => {
    const x = 42, w = W - 84;
    g.fillStyle = '#b4b8bf'; g.fillRect(x, y, w, h);
    bevel(x, y, w, h, 3, '#cfd2d7', '#979ca4');                       // внешний багет
    g.fillStyle = '#bcc0c6'; g.fillRect(x + 12, y + 12, w - 24, h - 24);
    bevel(x + 12, y + 12, w - 24, h - 24, 2, '#999ea6', '#d3d6da');   // внутренний — утоплен (свет и тень наоборот)
  };
  panel(36, 236); panel(318, 66); panel(430, 140);
  // ручка: розетка + нажимная ручка
  g.fillStyle = '#e9ebee'; g.beginPath(); g.arc(28, 300, 9, 0, Math.PI * 2); g.fill();
  g.strokeStyle = '#7d828a'; g.lineWidth = 1.5; g.stroke();
  g.fillStyle = '#dfe2e6'; g.fillRect(28, 296, 40, 8);
  g.strokeRect(28, 296, 40, 8);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  doorTexCache = t;
  return t;
}

function floorTexture(THREE, kind) {
  const c = document.createElement('canvas'); c.width = c.height = 512;
  const g = c.getContext('2d');
  let seed = kind === 'tile' ? 7 : 3; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  if (kind === 'tile') {   // плитка 30 см, светло-серая, тонкие швы
    const n = Math.round(2 / 0.3), sz = 512 / n;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      const v = 214 + Math.round(rnd() * 10);
      g.fillStyle = `rgb(${v},${v + 1},${v + 3})`; g.fillRect(i * sz, j * sz, sz, sz);
    }
    g.strokeStyle = 'rgba(150,150,155,.55)'; g.lineWidth = 2;
    for (let i = 0; i <= n; i++) { g.beginPath(); g.moveTo(i * sz, 0); g.lineTo(i * sz, 512); g.stroke(); g.beginPath(); g.moveTo(0, i * sz); g.lineTo(512, i * sz); g.stroke(); }
  } else {                 // светлый дуб: доски 18 см, длина 1,2 м вразбежку
    const rows = Math.round(2 / 0.18), rh = 512 / rows, len = 512 * 1.2 / 2;
    for (let j = 0; j < rows; j++) {
      const off = rnd() * len;
      for (let x = -off; x < 512; x += len) {
        const t = rnd(), r = 214 + t * 18, gg = 186 + t * 16, b = 146 + t * 14;
        g.fillStyle = `rgb(${r | 0},${gg | 0},${b | 0})`; g.fillRect(x, j * rh, len, rh);
        for (let k = 0; k < 6; k++) {   // волокна
          g.strokeStyle = `rgba(150,110,70,${0.05 + rnd() * 0.06})`; g.lineWidth = 1;
          const y = j * rh + rnd() * rh; g.beginPath(); g.moveTo(x, y); g.lineTo(x + len, y + (rnd() - 0.5) * 3); g.stroke();
        }
        g.fillStyle = 'rgba(120,90,60,.35)'; g.fillRect(x, j * rh, 1.5, rh);
      }
      g.fillStyle = 'rgba(120,90,60,.30)'; g.fillRect(0, j * rh, 512, 1.5);
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 4;
  if (THREE.SRGBColorSpace) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
// мебель из простых форм по категории RoomPlan: w — по x, h — по y, d — по z, низ на y = 0, спинка при z = −d/2
function furnitureModel(THREE, o, M) {
  const grp = new THREE.Group();
  const w = Math.max(0.1, o.w), h = Math.max(0.05, o.h), d = Math.max(0.1, o.d);
  const B = (bw, bh, bd, x, y, z, m) => { const mm = new THREE.Mesh(new THREE.BoxGeometry(Math.max(0.005, bw), Math.max(0.005, bh), Math.max(0.005, bd)), m); mm.position.set(x, y + bh / 2, z); mm.castShadow = mm.receiveShadow = true; grp.add(mm); return mm; };
  const C = (rad, ch, x, y, z, m, seg = 20) => { const mm = new THREE.Mesh(new THREE.CylinderGeometry(rad, rad, ch, seg), m); mm.position.set(x, y + ch / 2, z); mm.castShadow = mm.receiveShadow = true; grp.add(mm); return mm; };
  const legs = (top, inset, th, m) => { for (const sx of [-1, 1]) for (const sz of [-1, 1]) B(th, top, th, sx * (w / 2 - inset), 0, sz * (d / 2 - inset), m); };
  const attr = re => (o.attrs || []).some(a => re.test(a));
  const back = -d / 2;
  switch (o.cat) {
    case 'bed': {
      const fh = Math.min(0.3, h * 0.4);
      B(w, fh, d, 0, 0, 0, M.woodDark);                                   // основание
      B(w - 0.06, 0.2, d - 0.08, 0, fh, 0.02, M.linen);                   // матрас
      B(w, Math.max(h, 0.95), 0.08, 0, 0, back + 0.04, M.fabricGray);     // изголовье
      const n = w > 1.25 ? 2 : 1, pw = (w - 0.2) / n - 0.06;
      for (let k = 0; k < n; k++) B(pw, 0.12, 0.34, -w / 2 + 0.13 + pw / 2 + k * (pw + 0.06), fh + 0.2, back + 0.3, M.white);
      B(w - 0.02, 0.05, d * 0.55, 0, fh + 0.2, d / 2 - d * 0.55 / 2, M.blanket);   // покрывало
      break;
    }
    case 'sofa': {
      const seat = Math.min(0.45, h * 0.55), arm = Math.min(0.18, w * 0.12);
      B(w, seat * 0.55, d, 0, 0, 0, M.fabricLight);                       // основание
      B(w - 2 * arm, seat * 0.45, d - 0.22, 0, seat * 0.55, 0.11, M.fabric); // подушки сиденья
      B(w, Math.max(h, seat + 0.3), 0.22, 0, 0, back + 0.11, M.fabricLight); // спинка
      if (!attr(/single/i) || w > 0.6) { B(arm, seat + 0.18, d, -w / 2 + arm / 2, 0, 0, M.fabricLight); B(arm, seat + 0.18, d, w / 2 - arm / 2, 0, 0, M.fabricLight); }
      break;
    }
    case 'chair': {
      const seat = Math.min(0.47, h * 0.55);
      legs(seat - 0.04, 0.04, 0.035, M.woodDark);
      B(w, 0.05, d, 0, seat - 0.05, 0, attr(/stool/i) ? M.wood : M.white);
      if (!attr(/stool/i)) B(w, Math.max(0.3, h - seat), 0.04, 0, seat, back + 0.02, M.white);
      break;
    }
    case 'table': {
      const top = Math.max(0.35, h) - 0.04;
      if (attr(/circular|elliptic/i)) {
        const m = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.04, 40), M.woodLight);
        m.scale.set(w, 1, d); m.position.set(0, top + 0.02, 0); m.castShadow = m.receiveShadow = true; grp.add(m);
        C(0.05, top, 0, 0, 0, M.dark); C(Math.min(w, d) * 0.25, 0.02, 0, 0, 0, M.dark);
      } else {
        B(w, 0.04, d, 0, top, 0, M.woodLight);
        legs(top, 0.06, 0.04, M.white);
      }
      break;
    }
    case 'storage': {
      if (attr(/shelf/i)) {                                                 // стеллаж: боковины и полки
        B(0.03, h, d, -w / 2 + 0.015, 0, 0, M.white); B(0.03, h, d, w / 2 - 0.015, 0, 0, M.white);
        for (let y = 0; y <= h - 0.02; y += Math.max(0.3, h / 5)) B(w, 0.025, d, 0, y, 0, M.white);
        B(w, h, 0.01, 0, 0, back + 0.005, M.white);
      } else {                                                              // шкаф: корпус и двери
        B(w, h, d, 0, 0, 0, M.white);
        const n = Math.max(1, Math.round(w / 0.5));
        for (let k = 1; k < n; k++) B(0.008, h - 0.04, 0.005, -w / 2 + k * w / n, 0.02, d / 2 + 0.002, M.groove);
        for (let k = 0; k < n; k++) B(0.012, Math.min(0.25, h * 0.2), 0.02, -w / 2 + (k + (k % 2 ? 0.12 : 0.88)) * w / n, h * 0.45, d / 2 + 0.01, M.dark);
      }
      break;
    }
    case 'refrigerator':
      B(w, h, d, 0, 0, 0, M.steel); B(w - 0.02, 0.006, 0.005, 0, h * 0.62, d / 2 + 0.003, M.groove);
      B(0.02, h * 0.25, 0.03, w / 2 - 0.08, h * 0.65, d / 2 + 0.015, M.dark); break;
    case 'stove': case 'oven': case 'dishwasher': case 'washerDryer': {
      B(w, h, d, 0, 0, 0, M.white);
      if (o.cat === 'stove') { B(w - 0.02, 0.01, d - 0.02, 0, h, 0, M.dark); for (const sx of [-1, 1]) for (const sz of [-1, 1]) C(Math.min(w, d) * 0.11, 0.012, sx * w * 0.22, h + 0.004, sz * d * 0.2, M.steel); }
      if (o.cat === 'oven') B(w * 0.8, h * 0.45, 0.01, 0, h * 0.2, d / 2 + 0.005, M.dark);
      if (o.cat === 'washerDryer') { const m = C(Math.min(w, h) * 0.3, 0.02, 0, h * 0.45 - 0.01, d / 2 + 0.01, M.dark, 32); m.rotation.x = Math.PI / 2; m.position.y = h * 0.45; }
      if (o.cat === 'dishwasher') B(w - 0.03, 0.006, 0.005, 0, h * 0.85, d / 2 + 0.003, M.groove);
      break;
    }
    case 'sink': {
      B(w, Math.max(0.1, h - 0.06), d, 0, 0, 0, M.white);                   // тумба
      B(w + 0.02, 0.06, d + 0.02, 0, Math.max(0.1, h - 0.06), 0, M.ceramic);
      B(Math.min(w - 0.12, 0.5), 0.02, d * 0.55, 0, h - 0.01, 0.02, M.basin);
      break;
    }
    case 'toilet': {
      B(Math.min(w, 0.38), Math.min(h, 0.4), Math.min(d * 0.6, 0.45), 0, 0, 0.06, M.ceramic);           // чаша
      B(Math.min(w, 0.42), 0.04, Math.min(d * 0.6, 0.48), 0, Math.min(h, 0.4), 0.06, M.white);          // крышка
      B(Math.min(w, 0.4), Math.max(h, 0.75) - 0.35, 0.16, 0, 0.35, back + 0.08, M.ceramic);              // бачок
      break;
    }
    case 'bathtub': {
      B(w, h, d, 0, 0, 0, M.ceramic);
      B(w - 0.12, 0.012, d - 0.12, 0, h - 0.002, 0, M.basin);
      break;
    }
    case 'television':
      B(w, Math.max(0.3, h), 0.05, 0, Math.max(0, h * 0.0), back + 0.03, M.screen); break;
    case 'fireplace':
      B(w, h, d, 0, 0, 0, M.white); B(w * 0.5, h * 0.45, 0.01, 0, 0.1, d / 2 + 0.005, M.dark); break;
    case 'stairs': {
      const n = Math.max(3, Math.round(h / 0.18));
      for (let k = 0; k < n; k++) B(w, (k + 1) * h / n, d / n, 0, 0, -d / 2 + (k + 0.5) * d / n, M.woodLight);
      break;
    }
    default:
      B(w, h, d, 0, 0, 0, M.white);
  }
  return grp;
}

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

/* сборка 3D-сцены квартиры из схемы — без экрана и холста: её использует экран 3D и экспорт GLB с «Ещё» */
function buildTourScene(THREE, rooms) {
  const dark = false;
  const scene = new THREE.Scene();

  const bbAll = rooms.map(roomBBox);
  if (!bbAll.length) bbAll.push({ x: -2, y: -2, w: 4, h: 4 });   // схемы нет — только 3D-модель LiDAR-скана: условная площадка 4×4 м
  const minX = Math.min(...bbAll.map(b => b.x)), maxX = Math.max(...bbAll.map(b => b.x + b.w));
  const minZ = Math.min(...bbAll.map(b => b.y)), maxZ = Math.max(...bbAll.map(b => b.y + b.h));
  const centerAll = new THREE.Vector3((minX + maxX) / 2, 0.6, (minZ + maxZ) / 2);
  const span = Math.max(maxX - minX, maxZ - minZ, 4);

  // свет как на визуализациях планировок: мягкий рассеянный + солнце сбоку, стены отбрасывают тени в комнаты
  scene.add(new THREE.HemisphereLight(0xffffff, 0xd9d4cc, 1.15));
  scene.add(new THREE.AmbientLight(0xffffff, 0.45));
  const sun = new THREE.DirectionalLight(0xffffff, 1.05);
  sun.position.set(centerAll.x - span * 0.5, span * 1.6, centerAll.z + span * 0.7);
  sun.target.position.copy(centerAll); scene.add(sun.target);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.radius = 6;
  sun.shadow.bias = -0.0005;
  Object.assign(sun.shadow.camera, { left: -span, right: span, top: span, bottom: -span, near: 0.5, far: span * 5 });
  scene.add(sun);
  // мягкая тень под моделью — квартира «стоит» на фоне, а не сливается с ним
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(span * 6, span * 6), new THREE.ShadowMaterial({ opacity: 0.18 }));
  ground.rotation.x = -Math.PI / 2; ground.position.set(centerAll.x, -0.02, centerAll.z); ground.receiveShadow = true;
  scene.add(ground);
  const wallSolid = new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0x6e6e6e, side: THREE.DoubleSide }); // белые, наружные грани чуть затенены
  const wallGhost = new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0x6e6e6e, side: THREE.DoubleSide, transparent: true, opacity: 0.08, depthWrite: false });   // неснятая стена — еле заметна (просьба пользователя)
  // верх стены — белый срез, как на визуализациях планировок (раньше был тёмный «разрез» как на чертеже)
  const wallCap = new THREE.MeshBasicMaterial({ color: 0xf6f5f2 });
  const wallCapTop = new THREE.MeshBasicMaterial({ color: 0xf6f5f2, side: THREE.DoubleSide });
  // дверь — серое филёнчатое полотно по образцу пользователя (2026-10-20): три филёнки, наличник, хромированная ручка
  const doorTex = doorTexture(THREE);
  const doorFace = new THREE.MeshLambertMaterial({ map: doorTex, emissive: 0x4a4a4a, emissiveMap: doorTex });   // как у стен: в тени не темнеет до графита
  const doorEdge = new THREE.MeshLambertMaterial({ color: 0xa9aeb6, emissive: 0x3a3a3a });
  const doorMat = [doorEdge, doorEdge, doorEdge, doorEdge, doorFace, doorFace];   // BoxGeometry: ±x, ±y, +z, −z — полотно с обеих сторон
  const glassMat = new THREE.MeshLambertMaterial({ color: 0xe4f1f8, transparent: true, opacity: 0.6 });
  const plainFloors = [], solidWalls = [];
  const greyMat = new THREE.MeshBasicMaterial({ color: dark ? 0x3a3d43 : 0xcfc9bf, side: THREE.FrontSide });
  const floorMat = new THREE.MeshBasicMaterial({ color: dark ? 0x2b2e33 : 0xb9b2a6, side: THREE.FrontSide });
  const ceilMat = new THREE.MeshBasicMaterial({ color: dark ? 0x44474d : 0xe9e5dd, side: THREE.FrontSide });
  const lineMat = new THREE.LineBasicMaterial({ color: 0xd6cfc3 });
  const L = c => new THREE.MeshLambertMaterial({ color: c });
  const FM = { white: L(0xf4f3ef), linen: L(0xf7f6f2), fabric: L(0xd9d7d2), fabricLight: L(0xc9c7c2), fabricGray: L(0x8d9198),
    blanket: L(0x4d5d82), wood: L(0xb08a60), woodLight: L(0xd2b48c), woodDark: L(0x8a6646), dark: L(0x3d4046), groove: L(0xb9b6ae),
    steel: L(0xd3d6d9), ceramic: L(0xfdfdfb), basin: L(0xdfe6ea), screen: L(0x1e2125) };
  const floorTex = { wood: floorTexture(THREE, 'wood'), tile: floorTexture(THREE, 'tile') };

  const surfaces = []; // { key, mesh, w, h }
  const ceilings = [], mirrors = [];
  const roomInfo = {};
  const furniture = [];
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
    // пол как на визуализациях: светлый дуб, в санузле — плитка (текстура на 2 × 2 м, uv пола — доли габарита комнаты)
    const fTex = (typeof roomKind === 'function' && roomKind(r).kind === 'bath' ? floorTex.tile : floorTex.wood).clone();
    fTex.needsUpdate = true; fTex.repeat.set(Math.max(0.25, bb.w / 2), Math.max(0.25, bb.h / 2));
    const plain = new THREE.Mesh(mkPoly(() => -0.004, true), new THREE.MeshLambertMaterial({ map: fTex }));
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
      // не отсканированная стена (дорисована при обмере) — еле заметная, без тени и без «крышки»
      const ghost = (r.unscanned || []).includes(e.id);
      const wall = new THREE.Mesh(geo, ghost ? wallGhost : wallSolid);
      wall.castShadow = !ghost;
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
      if (capIdx.length && !ghost) {
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
          child = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: doorTexture(THREE) }));
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
    // мебель из скана лидаром — простые модели по категории (кровать с подушками, диван со спинкой, стол на ножках…)
    for (const o of r.objects || []) {
      const m = furnitureModel(THREE, o, FM);
      m.position.set(o.x, o.z || 0, o.y);
      m.rotation.y = -o.ang;
      if (typeof furnBackFlip === 'function' && furnBackFlip(o, r)) m.scale.z = -1;   // спинка — к ближайшей стене, как на схеме
      scene.add(m); furniture.push(m); m.name = typeof furnName === 'function' ? furnName(o) : (o.cat || 'Предмет');
    }
    const c = roomCenter(r);
    roomInfo[r.id] = { center: new THREE.Vector3(c[0], 1.55, c[1]), ceil, name: r.name };
  }

  return { scene, bbAll, minX, maxX, minZ, maxZ, centerAll, span, sun, ground, wallSolid, wallCap, wallCapTop, doorMat, glassMat, plainFloors, solidWalls, greyMat, floorMat, ceilMat, lineMat, FM, floorTex, surfaces, ceilings, mirrors, roomInfo, furniture };
}

async function viewTour(pid, roomId = null) {
  const { project, rooms, stages, scans, photos } = await loadProjectData(pid);
  if (!project) return nav('');
  const hdSrc = [...stages, ...scans];   // у кого бывают 3D-модели: этапы и LiDAR-сканы
  if (roomId && rooms.some(r => r.id === roomId)) { tourState.roomId = roomId; if (tourState.mode === 'house') tourState.mode = 'inside'; }
  if (!tourState.roomId || !rooms.some(r => r.id === tourState.roomId)) tourState.roomId = rooms[0] ? rooms[0].id : null;
  // пункта «Сейчас — последние фото» больше нет (просьба пользователя 2026-10-19): по умолчанию — последний этап, у которого есть фото
  // (на стене — фото этого этапа, а если его нет — последнее с предыдущих, т. е. то же «сейчас»)
  if (!hdSrc.some(s => s.id === tourState.stage)) {
    const withPh = stages.filter(s => photos.some(p => p.stageId === s.id));
    tourState.stage = (withPh[withPh.length - 1] || stages[stages.length - 1] || { id: 'all' }).id;
  }
  // HD-модель — у этапа: выбранный этап, если у него она есть, иначе последний этап с моделью
  // этап с сетками лидара из HD-обхода: выбранный, иначе последний такой
  const meshStage = () => { const ok = stages.filter(s => (s.meshScans || []).some(m => m.blob)); return ok.find(s => s.id === tourState.stage) || ok[ok.length - 1] || null; };
  const hdStage = () => { const ok = hdSrc.filter(s => stageHDModels(s).length); return ok.find(s => s.id === tourState.stage) || ok[ok.length - 1] || null; };
  if (tourState.mode === 'hd' && !hdStage()) tourState.mode = 'house';
  if (tourState.mode === 'final') tourState.mode = 'house';   // режима «Финал» больше нет в переключателе
  if (tourState.mode === 'hd' && !hdSrc.some(s => stageHDModels(s).length)) tourState.mode = 'house';   // моделей нет — к схеме
  if (tourState.mode !== 'hd' && scans.some(s => s.id === tourState.stage)) tourState.stage = (stages[stages.length - 1] || { id: 'all' }).id;   // LiDAR-скан — не этап
  if (!rooms.length && hdStage()) { tourState.mode = 'hd'; tourState.stage = hdStage().id; }   // схемы нет — только 3D-модель
  const orbitMode = () => tourState.mode === 'house' || tourState.mode === 'final' || tourState.mode === 'hd';

  app.innerHTML = `
    ${header('3D', false)}
    <div class="tour">
      <canvas id="tour-canvas"></canvas>
      <div class="tour-top">
        <div class="tour-row">
          ${photos.length || hdStage() ? '' : '<div class="inp tour-nophoto">Фото пока нет</div>'}
          ${photos.length || hdStage() ? `<div class="tour-dd" id="tour-dd">
            <button class="inp tour-dd-btn" id="tour-dd-btn" aria-haspopup="listbox"><span id="tour-dd-label"></span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button>
            <div class="tour-dd-list hidden" id="tour-dd-list" role="listbox"></div>
          </div>
          <select class="inp hidden" id="tour-stage" aria-hidden="true">
            ${stages.map(s => `<option value="${s.id}" ${tourState.stage === s.id && tourState.mode !== 'hd' ? 'selected' : ''}>${esc(s.name)}</option>` +
              (stageHDModels(s).length ? `<option value="hd:${s.id}" ${tourState.stage === s.id && tourState.mode === 'hd' ? 'selected' : ''}>3D-модель · ${esc(s.name)}</option>` : '')).join('')}
            ${scans.filter(s => stageHDModels(s).length).map(s => `<option value="hd:${s.id}" ${tourState.stage === s.id && tourState.mode === 'hd' ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}
          </select>
          <button id="tour-photos" class="tour-pic ${tourState.photos ? 'active' : ''}" title="Фото выбранного этапа на стенах" aria-label="Фото этапа на стенах">${I('image')}</button>` : ''}
        </div>
      </div>
      <!-- «Фото» и (в режиме 3D-модели) «Отправить» модель — одной стеклянной капсулой (2026-10-27, просьба пользователя) -->
      <div class="tour-shotcap lg-cap" id="tour-shotcap">
        <button id="tour-shot" class="tour-shot" title="Снимок 3D — посмотреть, нарисовать поверх, сохранить или отправить" aria-label="Снимок">${ICONS.camera}</button>
        <button id="tour-send" class="tour-shot" title="Отправить 3D-модель (GLB)" aria-label="Отправить модель">${ICONS.share}</button>${'' /* без надписей — только значки (просьба пользователя 2026-10-27) */}
      </div>
      <div class="tour-bottom">
        <div class="tour-modes ${rooms.length ? '' : 'hidden'}">   <!-- без схемы (только LiDAR-модель) «Объект» и «Внутри» не из чего строить -->
          <span class="seg-thumb" id="seg-thumb"></span>
          <button data-mode="house" class="${tourState.mode === 'house' ? 'active' : ''}">${I('tour')}<span>Объект</span></button>
          <button data-mode="inside" class="${tourState.mode === 'inside' ? 'active' : ''}">${I('person')}<span>Внутри</span></button>
          ${'' /* кнопки «HD» нет (просьба пользователя 2026-10-23): 3D-модели этапов — пунктами «… · 3D-модель» в списке этапов */}
          ${'' /* «Финал» (сетка лидара с телефона, stage.meshScans / project.finalScan) убран из 3D 2026-10-23 по просьбе пользователя — сетки по-прежнему сохраняются, код режима остался */}
          ${'' /* кнопка «RoomPlan» (оригинальная модель USDZ, просмотр и AR) убрана по просьбе пользователя 2026-10-09; модели по-прежнему сохраняются */}
        </div>
        <button id="tour-glb" class="tour-ico tour-glb hidden" title="Экспорт 3D-модели (GLB) — для Blender, дизайнеров, сайтов" aria-label="Экспорт GLB">${ICONS.download}<span>GLB</span></button>
        <div class="tour-plan ${rooms.length ? '' : 'hidden'}" id="tour-plan"></div>
      </div>
      <div class="tour-msg hidden" id="tour-msg"></div>
    </div>
    ${bottomNav(pid, 'tour')}`;

  const msg = $('#tour-msg'), hint = document.createElement('div'); // поясняющий текст на экране не показываем (просьба пользователя)
  const say = t => { msg.textContent = t; msg.classList.toggle('hidden', !t); };
  // без схемы открываем только 3D-модели (LiDAR Mode снимает без RoomPlan, схема ему не нужна)
  if (!rooms.length && !hdStage()) { say('Сначала нарисуйте схему — тур строится из комнат и их фото.'); return; }

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
  const camera = new THREE.PerspectiveCamera(60, 1, 0.05, 500);
  const { scene, bbAll, minX, maxX, minZ, maxZ, centerAll, span, sun, ground, wallSolid, wallCap, wallCapTop, doorMat, glassMat, plainFloors, solidWalls, greyMat, floorMat, ceilMat, lineMat, FM, floorTex, surfaces, ceilings, mirrors, roomInfo, furniture } = buildTourScene(THREE, rooms);
  const schemaExtras = [...furniture, ...mirrors];
  scene.traverse(o => { if (o.isLineSegments && o.material === lineMat) schemaExtras.push(o); });   // контур комнат

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

  /* ---------- финальный скан (окрашенная сетка лидара): сетки HD-обходов этапа по комнатам или старый project.finalScan ---------- */
  let finalMesh = null, finalOf = null, finalVerts = 0;
  async function loadFinal() {
    if (!window.THREE_PLYLoader) return;
    const ms = meshStage();
    const items = ms ? ms.meshScans.filter(m => m.blob) : (project.finalScan && project.finalScan.blob ? [project.finalScan] : []);
    const key = ms ? ms.id + ':' + items.map(m => m.id).join(',') : 'project';
    if (!items.length || (finalMesh && finalOf === key)) return;
    if (finalMesh) { scene.remove(finalMesh); finalMesh.traverse(o => { if (o.geometry) o.geometry.dispose(); }); }
    finalOf = key; finalVerts = 0;
    const group = new THREE.Group();
    for (const it of items) {
      try {
        const geo = new window.THREE_PLYLoader().parse(await it.blob.arrayBuffer());
        geo.computeVertexNormals();
        const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: geo.hasAttribute('color'), side: THREE.DoubleSide }));
        // из координат ARKit (X, Y вверх, Z) в план: тот же поворот+сдвиг, что применялся к комнатам
        const tr = it.transform || { ang: 0, ox: 0, oy: 0 };
        mesh.rotation.y = -tr.ang;
        mesh.position.set(tr.ox, 0, tr.oy);
        group.add(mesh);
        finalVerts += it.vertices || 0;
      } catch (err) { console.error(err); say('Не удалось открыть 3D-сетку' + (it.place ? ' «' + it.place + '»' : '')); }
    }
    group.visible = tourState.mode === 'final';
    scene.add(group);
    finalMesh = group;
  }

  /* ---------- HD-скан: Gaussian splatting, обученный на компьютере по HD-пакету ---------- */
  // модели этапа по комнатам (с 2026-10-20): каждая — свой DropInViewer со своим трансформом пакета
  let hdViewers = [], hdCenter = null, hdLoading = null, hdOf = null, hdBox = null;
  let hdViewer = null;   // первый из загруженных — признак «HD уже на сцене» для остального кода
  function loadHD() {
    const hs = hdStage();
    if (hdLoading || !hs) return hdLoading || Promise.resolve();
    const all = stageHDModels(hs);
    const list = tourState.hdModel ? all.filter(m => m.id === tourState.hdModel) : all;
    const pick = list.length ? list : all;
    const key = hs.id + ':' + pick.map(m => m.id).join(',');
    if (hdViewer && hdOf === key) return Promise.resolve();
    for (const v of hdViewers) { scene.remove(v); v.dispose().catch(() => {}); }   // выбран другой этап или другая модель
    hdViewers = []; hdViewer = null; hdCenter = null;
    hdOf = key;
    hdLoading = (async () => {
      const xs = [], ys = [], zs = [], p = new THREE.Vector3();
      const glbBox = new THREE.Box3();   // модели GLB (сканы) — их коробки целиком: по центру одному рамка выходила точкой (2026-10-28)
      let failed = 0;
      try {
        const GS = await import('./vendor/gaussian-splats-3d.module.js');
        for (let k = 0; k < pick.length; k++) {
          const scan = pick[k];
          say(pick.length > 1 ? `Загружаю HD-модели… ${k + 1} из ${pick.length}` : 'Загружаю HD-модель…');
          try {
            if (scan.format === 'glb') {
              // модель «как у Polycam» (сетка лидара + текстура из кадров), собранная телефоном после HD-обхода (2026-10-23)
              const { GLTFLoader } = await import('./vendor/GLTFLoader.js');
              const gltf = await new GLTFLoader().parseAsync(await scan.blob.arrayBuffer(), '');
              const g = new THREE.Group(); g.add(gltf.scene);
              gltf.scene.traverse(o => { if (o.isMesh) { const mp = o.material.map; if (mp) { mp.colorSpace = THREE.SRGBColorSpace; mp.anisotropy = 4; mp.minFilter = THREE.LinearMipmapLinearFilter; mp.generateMipmaps = true; mp.needsUpdate = true; } o.material = new THREE.MeshBasicMaterial({ map: mp }); } });
              const tr = scan.transform || { ang: 0, ox: 0, oy: 0 };
              g.rotation.y = -tr.ang; g.position.set(tr.ox, 0, tr.oy);
              g.dispose = async () => { g.traverse(o => { if (o.isMesh) { o.geometry.dispose(); if (o.material.map) o.material.map.dispose(); o.material.dispose(); } }); };
              scene.add(g); g.updateMatrixWorld(true);
              hdViewers.push(g);
              const box = new THREE.Box3().setFromObject(g), c = box.getCenter(new THREE.Vector3());
              glbBox.union(box);
              xs.push(c.x); ys.push(c.y); zs.push(c.z);
              continue;
            }
            const fmt = { ply: GS.SceneFormat.Ply, spz: GS.SceneFormat.Spz, splat: GS.SceneFormat.Splat, ksplat: GS.SceneFormat.KSplat }[scan.format] ?? GS.SceneFormat.Ply;
            const v = new GS.DropInViewer({ sharedMemoryForWorkers: false, gpuAcceleratedSort: false, dynamicScene: false, sceneRevealMode: GS.SceneRevealMode.Instant });
            const url = URL.createObjectURL(scan.blob);
            // пакет снят в координатах AR-сессии обхода → тот же поворот и сдвиг, которым обход лёг на схему
            const tr = scan.transform || (scan.id === 'legacy' ? hs.hdTransform || (stageHDCaps(hs)[0] || {}).transform : null) || { ang: 0, ox: 0, oy: 0 };
            v.rotation.y = -tr.ang; v.position.set(tr.ox, 0, tr.oy);
            if (scan.flip) v.rotation.x = Math.PI;   // модель из программ с осью Y вниз
            try { await v.addSplatScene(url, { format: fmt, showLoadingUI: false, progressiveLoad: false, splatAlphaRemovalThreshold: 5 }); }
            finally { URL.revokeObjectURL(url); }
            scene.add(v); v.updateMatrixWorld(true);
            hdViewers.push(v);
            // центр по выборке сплатов всех моделей — вокруг него крутится камера
            const sb = v.getSplatScene(0).splatBuffer, n = sb.getSplatCount(), step = Math.max(1, Math.floor(n / 3000));
            for (let i = 0; i < n; i += step) { sb.getSplatCenter(i, p); p.applyMatrix4(v.matrixWorld); xs.push(p.x); ys.push(p.y); zs.push(p.z); }
          } catch (err) { console.error(err); failed++; }
        }
        const med = a => { a.sort((x, y) => x - y); return a[Math.floor(a.length / 2)] || 0; };
        if (xs.length) hdCenter = new THREE.Vector3(med(xs), med(ys), med(zs));
        // рамка модели (без 2 % крайних точек) — где на экране «модель» для касаний (вращать или листать вкладки)
        const pc = (a, q) => { const b = a.slice().sort((x, y) => x - y); return b[Math.min(b.length - 1, Math.floor(b.length * q))]; };
        hdBox = xs.length ? new THREE.Box3(new THREE.Vector3(pc(xs, 0.02), pc(ys, 0.02), pc(zs, 0.02)), new THREE.Vector3(pc(xs, 0.98), pc(ys, 0.98), pc(zs, 0.98))) : null;
        if (!glbBox.isEmpty()) hdBox = hdBox ? hdBox.union(glbBox) : glbBox;
        hdViewer = hdViewers[0] || null;
        say(failed ? `Не открылось моделей: ${failed} из ${pick.length} (мало памяти?)` : '');
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
    camera.aspect = w / h;
    // «Объект»: картинка сдвинута вверх так, чтобы модель стояла по центру свободной части экрана —
    // между кнопками сверху и мини-планом снизу (иначе низ модели закрывался мини-планом)
    if (orbitMode()) { const f = freeArea(); camera.setViewOffset(w, h, 0, Math.round((f.bot - f.top) / 2), w, h); }
    else camera.clearViewOffset();
    camera.updateProjectionMatrix();
    // стартовый масштаб: квартира целиком помещается в свободную часть экрана (ниже кнопок сверху, с полями по краям)
    if (!orbit.userZoom) orbit.radius = orbitMode() ? fitRadius(w, h) : span * 1.55 * Math.max(1, 0.85 / (w / h));
  }
  // подбор расстояния камеры: углы габарита квартиры (с высотой стен) должны попасть в кадр
  // занятое сверху (кнопки) и снизу (мини-план над нижним меню), px от краёв сцены
  function freeArea() {
    const box = canvas.parentElement.getBoundingClientRect(), top = canvas.parentElement.querySelector('.tour-top');
    const plan = canvas.parentElement.querySelector('.tour-plan'), nav = document.querySelector('.bottomnav');
    const low = plan && plan.getBoundingClientRect().height ? plan : nav;   // сцена уходит под нижнее меню
    return { top: top ? top.getBoundingClientRect().bottom - box.top + 10 : 60, bot: low ? box.bottom - low.getBoundingClientRect().top + 10 : 24 };
  }
  function fitRadius(w, h) {
    const f = freeArea();
    const yTop = 1 - 2 * f.top / h, yBot = -1 + 2 * f.bot / h, xLim = 1 - 2 * 14 / w;
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
  // Касание вне модели (2026-10-28, просьба пользователя): в «Объекте» и на 3D-модели один палец вращает, только если коснулся
  // модели или рядом (запас 40 px); на пустом месте — не вращаем, и свайп листает вкладки (swipeNav в app.js спрашивает tourHitTest).
  // Два пальца (масштаб, поворот) — где угодно. «Внутри» — как раньше (вокруг сплошная комната).
  const modelRect = () => {
    let box;
    if (tourState.mode === 'hd') box = hdBox;
    else box = new THREE.Box3(new THREE.Vector3(minX, 0, minZ), new THREE.Vector3(maxX, Math.max(...rooms.map(r => roomCeil(r) || 2.7)), maxZ));
    if (!box) return null;
    const r = canvas.getBoundingClientRect();
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < 8; i++) {
      const v = new THREE.Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).project(camera);
      if (v.z > 1) return null;   // часть модели за камерой — считаем, что модель везде
      const sx = r.left + (v.x + 1) / 2 * r.width, sy = r.top + (1 - v.y) / 2 * r.height;
      x0 = Math.min(x0, sx); x1 = Math.max(x1, sx); y0 = Math.min(y0, sy); y1 = Math.max(y1, sy);
    }
    return { x0: x0 - 40, y0: y0 - 40, x1: x1 + 40, y1: y1 + 40 };
  };
  const onModel = (x, y) => {
    if (!orbitMode()) return true;
    const m = modelRect();
    return !m || (x >= m.x0 && x <= m.x1 && y >= m.y0 && y <= m.y1);
  };
  window.tourHitTest = onModel;
  const waiting = new Map();   // пальцы, поставленные вне модели: вращать не будем, но со вторым пальцем — масштаб
  canvas.addEventListener('pointerdown', e => {
    if (!pointers.size && !waiting.size && e.isPrimary && !onModel(e.clientX, e.clientY)) { waiting.set(e.pointerId, { x: e.clientX, y: e.clientY }); return; }
    for (const [id, p] of waiting) pointers.set(id, p);
    waiting.clear();
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY }); try { canvas.setPointerCapture(e.pointerId); } catch {}
  });
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
  const up = e => { pointers.delete(e.pointerId); waiting.delete(e.pointerId); if (pointers.size < 2) { lastPinch = 0; lastAng = null; } };
  canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    if (orbitMode()) { orbit.userZoom = true; orbit.radius = Math.max(span * 0.3, Math.min(span * 6, orbit.radius * (e.deltaY > 0 ? 1.1 : 0.9))); }
  }, { passive: false });

  /* ---------- мини-план ---------- */
  function drawPlan() {
    const pad = 0.4;
    const vb = `${minX - pad} ${minZ - pad} ${maxX - minX + pad * 2} ${maxZ - minZ + pad * 2}`;
    // подложка по форме квартиры: ширина 150 px, высота по пропорциям схемы (100–150 px) — без пустых полей
    const box = $('#tour-plan'), cs = getComputedStyle(box);
    const edge = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
    const inner = box.offsetWidth - (parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) + parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth));
    if (inner > 0) box.style.height = `${Math.round(Math.max(100, Math.min(150, inner * (maxZ - minZ + pad * 2) / (maxX - minX + pad * 2) + edge)))}px`;
    box.innerHTML = `<svg viewBox="${vb}" preserveAspectRatio="xMidYMid meet">
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
  // свой выпадающий список этапов (2026-10-23: системное окно iOS всплывало поверх поля — пользователь: «должен быть выпадающий список»)
  function syncDD() {
    const sel = $('#tour-stage'), lab = $('#tour-dd-label'), list = $('#tour-dd-list');
    if (!sel || !lab || !list) return;
    const cur = sel.options[sel.selectedIndex];
    lab.textContent = cur ? cur.text : '';
    list.innerHTML = [...sel.options].map(o => `<button class="tour-dd-item ${o.selected ? 'on' : ''}" data-v="${esc(o.value)}" role="option">` +
      `<span class="tour-dd-check">${o.selected ? '✓' : ''}</span><span>${esc(o.text)}</span></button>`).join('');
  }
  function updateHint() {
    syncDD();
    const ri = roomInfo[tourState.roomId];
    const name = ri ? ri.name : '';
    if (tourState.mode === 'house') hint.textContent = 'Крутите пальцем или двумя, щипок — масштаб. Тап по плану — встать в эту точку внутри.';
    else if (tourState.mode === 'inside') hint.textContent = `${name}: осмотритесь пальцем. Ведите точку на плане — чтобы перейти.`;
    if (tourState.mode === 'hd') hint.textContent = `3D-модель${hdStage() ? ': ' + hdStage().name : ''}. Крутите пальцем, щипок — масштаб.`;
    if (tourState.mode === 'final') hint.textContent = `3D-сетка лидара${meshStage() ? ': ' + meshStage().name : ''}${finalVerts ? ' · ' + finalVerts + ' вершин' : ''}. Крутите пальцем, щипок — масштаб.`;
    app.querySelectorAll('[data-mode]').forEach(b => b.classList.toggle('active', b.dataset.mode === tourState.mode));
    // стеклянный переключатель режимов: светлая «плашка» переезжает под выбранный режим
    const th = $('#seg-thumb'), act = app.querySelector('[data-mode].active');
    if (th && act) { th.style.width = `${act.offsetWidth}px`; th.style.transform = `translateX(${act.offsetLeft - 4}px)`; th.style.opacity = 1; }
    else if (th) th.style.opacity = 0;   // 3D-модель (выбрана в списке) — ни один из режимов не подсвечен
    const pb = $('#tour-photos'); if (pb) pb.classList.toggle('active', tourState.photos);
    const isHD = tourState.mode === 'hd';
    const isFinal = tourState.mode === 'final' || isHD, isInside = tourState.mode === 'inside';
    const photosOn = isInside || tourState.photos;
    for (const c of ceilings) c.visible = isInside;                              // потолки только изнутри
    for (const s of surfaces) { const isFloor = s.key.endsWith(':f'), isCeil = s.key.endsWith(':c'); if (isCeil) continue; s.mesh.visible = !!(!isFinal && photosOn && (!isFloor || s.mesh.material.map)); } // visible строго true/false: three.js прячет объект только при visible === false
    for (const f of plainFloors) f.visible = !isFinal;
    for (const w of solidWalls) w.visible = !isFinal;
    if (finalMesh) finalMesh.visible = tourState.mode === 'final';
    for (const v of hdViewers) v.visible = isHD;
    // 3D-модель (скан) — только она: контур комнат, мебель и зеркала схемы прячем (2026-10-27, «должен быть только скан»)
    for (const o of schemaExtras) o.visible = !isHD;
  }
  function setMode(m) {
    tourState.mode = m;
    const sel = $('#tour-stage');
    if (sel && m !== 'hd' && sel.value.startsWith('hd:')) sel.value = sel.value.slice(3);
    // из модели LiDAR-скана — к схеме: скан не этап, выбираем последний этап (иначе список сверху пустой)
    if (m !== 'hd' && scans.some(x => x.id === tourState.stage)) {
      tourState.stage = (stages[stages.length - 1] || { id: 'all' }).id;
      if (sel) sel.value = tourState.stage;
      applyStage();
    }
    syncDD();
    resize();   // сдвиг картинки вверх нужен только в «Объекте»
    if (m === 'final') loadFinal().then(updateHint);
    if (m === 'hd') loadHD().then(updateHint);
    updateHint(); drawPlan();
  }
  const pickMode = m => { look.yaw = 0; look.pitch = 0; if (m === 'inside') tourState.eye = null; setMode(m); };
  let segDragged = false;   // после перетаскивания плашки «клик» по кнопке под пальцем не нужен
  app.querySelectorAll('[data-mode]').forEach(b => { b.onclick = () => { if (segDragged) { segDragged = false; return; } pickMode(b.dataset.mode); }; });
  // переключатель режимов можно и перетаскивать: плашка едет за пальцем, по отпусканию встаёт под ближайший режим
  const seg = app.querySelector('.tour-modes'), segThumb = $('#seg-thumb');
  if (seg && segThumb) {
    let d = null;
    const btns = () => [...seg.querySelectorAll('[data-mode]')];
    seg.addEventListener('touchstart', e => e.stopPropagation(), { passive: true });   // не листать вкладки свайпом с переключателя
    seg.addEventListener('pointerdown', e => {
      const act = seg.querySelector('[data-mode].active');
      d = { x: e.clientX, from: act ? act.offsetLeft - 4 : 0, on: false, id: e.pointerId };
    });
    seg.addEventListener('pointermove', e => {
      if (!d || e.pointerId !== d.id) return;
      const dx = e.clientX - d.x;
      if (!d.on) { if (Math.abs(dx) < 6) return; d.on = true; try { seg.setPointerCapture(e.pointerId); } catch {} segThumb.style.transition = 'none'; }
      const max = seg.clientWidth - 8 - segThumb.offsetWidth;
      d.pos = Math.max(0, Math.min(max, d.from + dx));
      segThumb.style.transform = `translateX(${d.pos}px)`;
    });
    const end = e => {
      if (!d || e.pointerId !== d.id) return;
      const was = d; d = null;
      if (!was.on) return;
      segThumb.style.transition = '';
      const mid = was.pos + segThumb.offsetWidth / 2 + 4;
      const best = btns().reduce((a, b) => Math.abs(b.offsetLeft + b.offsetWidth / 2 - mid) < Math.abs(a.offsetLeft + a.offsetWidth / 2 - mid) ? b : a);
      segDragged = true; setTimeout(() => { segDragged = false; }, 350);
      if (best.dataset.mode === tourState.mode) updateHint(); else pickMode(best.dataset.mode);   // вернуть плашку на место или переключить
    };
    seg.addEventListener('pointerup', end);
    seg.addEventListener('pointercancel', end);
  }
  const rpBtn = app.querySelector('#tour-rp');
  if (rpBtn) rpBtn.onclick = () => {
    const list = roomPlanModels(project, rooms);
    const open = m => openRoomPlanModel(m.blob, m.title).catch(err => uiAlert(err.message));
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
  // «Фото»: снимок текущего вида 3D → редактор (нарисовать поверх, сохранить в «Фото», отправить)
  // «Отправить» (2026-10-27): на модели скана — её файл (несколько — спросить какую); в «Объект»/«Внутри» — 3D-модель схемы (GLB),
  // как была кнопка «3D-модель (GLB)» на экране «Объект» (оттуда убрана)
  $('#tour-send').onclick = async () => {
    if (tourState.mode !== 'hd') {
      const b = $('#tour-send'); if (b.disabled) return;
      b.disabled = true; say('Готовлю 3D-модель…');
      try { const r = await exportGlbModel(pid); if (r) showGlbDialog(r.blob, r.file, () => {}); }   // отправка — отдельным тапом в окне (после сборки «Поделиться» без жеста не откроется)
      catch (err) { console.error(err); uiAlert('Не удалось собрать модель: ' + (err && err.message || err)); }
      finally { b.disabled = false; say(''); }
      return;
    }
    const hs = hdStage(); if (!hs) return;
    const all = stageHDModels(hs), list = tourState.hdModel ? all.filter(m => m.id === tourState.hdModel) : all;
    let m = list[0];
    if (list.length > 1) {
      const id = await pickSheet('Какую модель отправить?', '', list.map(x => ({ html: esc(x.place || x.name || 'Модель'), value: x.id })));
      if (!id) return;
      m = list.find(x => x.id === id);
    }
    if (!m || !m.blob) return;
    const ext = m.format || ((m.name || '').split('.').pop()) || 'glb';
    try { await deliverFile(m.blob, `${slug(m.place || hs.name)}.${ext}`, m.place || hs.name); }
    catch (err) { uiAlert('Не удалось отправить: ' + (err && err.message || err)); }
  };
  $('#tour-shot').onclick = () => {
    renderer.render(scene, camera);                       // кадр рисуем прямо сейчас — буфер холста ещё не очищен
    const url = canvas.toDataURL('image/jpeg', 0.94);
    openShotEditor(url, `${project.name} — 3D`);
  };
  const photosBtn = $('#tour-photos');
  if (photosBtn) photosBtn.onclick = () => { tourState.photos = !tourState.photos; updateHint(); };
  if ($('#tour-dd-btn')) {
    const list = $('#tour-dd-list');
    const close = () => list.classList.add('hidden');
    $('#tour-dd-btn').onclick = e => { e.stopPropagation(); syncDD(); list.classList.toggle('hidden'); };
    list.onclick = e => {
      const it = e.target.closest('[data-v]'); if (!it) return;
      e.stopPropagation(); close();
      const sel = $('#tour-stage'); if (sel.value === it.dataset.v) return;
      sel.value = it.dataset.v; sel.dispatchEvent(new Event('change'));
    };
    app.querySelector('.tour').addEventListener('pointerdown', e => { if (!e.target.closest('#tour-dd')) close(); });
    syncDD();
  }
  if ($('#tour-stage')) $('#tour-stage').onchange = e => {
    const v = e.target.value;
    if (v.startsWith('hd:')) { tourState.stage = v.slice(3); applyStage(); look.yaw = 0; look.pitch = 0; setMode('hd'); return; }   // 3D-модель этапа
    tourState.stage = v; applyStage();
    if (tourState.mode === 'hd') pickMode('house');   // из модели — обратно к схеме этапа
  };

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
      scene.traverse(o => { if (o.isLight || o === ground || o === finalMesh || hdViewers.includes(o) || mirrors.includes(o)) setVis(o, false); });
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
      console.error(err); uiAlert('Не удалось собрать модель: ' + err.message);
    } finally {
      temp.forEach(p => { p.parent.remove(p); p.material.dispose(); });
      for (let i = saved.length - 1; i >= 0; i--) { saved[i][0].visible = saved[i][1]; saved[i][0].name = saved[i][2]; }
      glbBtn.disabled = false; say(''); updateHint();
    }
    if (!blob) return;
    // отправка — отдельным тапом: после долгой сборки браузер уже не считает это действием пользователя и не откроет «Поделиться»
    const stageName = tourState.stage === 'all' ? 'последние фото' : (stages.find(s => s.id === tourState.stage) || {}).name || '';
    const file = `${(project.name || 'model').replace(/[\\/:*?"<>|]+/g, '_')}.glb`;
    showGlbDialog(blob, file, () => {});
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


  window.__tourDebug = () => ({ total: surfaces.length, textured: surfaces.filter(s => s.mesh.material.map).length, mirrors: mirrors.length, mode: tourState.mode, stage: tourState.stage, room: tourState.roomId, solidWalls: solidWalls.length, plainFloors: plainFloors.length, photos: tourState.photos, finalLoaded: !!finalMesh, wallPlanesVisible: surfaces.filter(s => !s.key.endsWith(':f') && !s.key.endsWith(':c') && s.mesh.visible).length, floors: plainFloors.map(f => ({ color: f.material.color.getHexString(), visible: f.visible, y: f.position.y, n: f.geometry.attributes.normal.getY(0) })), floorPlanes: surfaces.filter(s => s.key.endsWith(':f')).map(s => ({ key: s.key, visible: s.mesh.visible, map: !!s.mesh.material.map })) });
  window.__tourScene = scene;
  viewCleanup = () => {
    alive = false; ro.disconnect(); delete window.__tourDebug;
    tourState.hdModel = null;   // «одна модель» — только для этого захода из «HD-скана»
    texCache.forEach(t => t.dispose());
    mirrors.forEach(m => m.dispose && m.dispose());
    for (const v of hdViewers) { scene.remove(v); v.dispose().catch(() => {}); }
    renderer.dispose();
  };
}

/* ---------- редактор снимка 3D (просьба пользователя 2026-10-14, по образцу «Разметки» iOS):
   сверху — назад, отменить, сохранить в «Фото», отправить; снизу — ручка, маркер, выделитель, ластик, цвет ---------- */
// Снимок схемы / 3D: на телефоне — нативный редактор (ShotEditorViewController, 2026-10-27): сверху наши кнопки «‹», ↶,
// сохранить в «Фото», «Поделиться»; рисование — палитрой Apple (кружок внизу, как в «Разметке»). Браузер и старые сборки — свой редактор ниже.
function openShotEditor(dataUrl, title) {
  if (Native.isNative && Native.RP && Native.RP.markupImage) {
    const t = new Date(), p2 = n => String(n).padStart(2, '0');
    const name = `${title} ${p2(t.getHours())}-${p2(t.getMinutes())}-${p2(t.getSeconds())}`;
    Native.RP.markupImage({ data: String(dataUrl).split(',')[1], name }).catch(err => {
      if (/not implemented|не реализ|UNIMPLEMENTED/i.test(String(err && (err.code || err.message)))) openShotEditorOwn(dataUrl, title);
      else uiAlert('Не удалось открыть снимок: ' + (err && err.message || err));
    });
    return;
  }
  openShotEditorOwn(dataUrl, title);
}

function openShotEditorOwn(dataUrl, title) {
  // инструменты «как в Разметке» iOS: чёрный корпус с бликом, кончик и поясок; цветной кончик — текущий цвет
  const body = (x, w, y) => `<rect x="${x}" y="${y}" width="${w}" height="${64 - y}" fill="url(#seBody)"/>`;
  const TOOLS = [
    ['pen', 'Ручка', `<path d="M5 18 L10 3 L15 18 Z" fill="url(#seBody)"/><path d="M8.3 8 L10 3 L11.7 8 Z" fill="currentColor"/>${body(5, 10, 18)}<rect x="5" y="30" width="10" height="2.4" fill="#fff"/>`],
    ['marker', 'Линер', `<rect x="9.2" y="2" width="1.6" height="6" fill="currentColor"/><path d="M8 8 h4 v4 h-4z" fill="#ddd"/><path d="M6 18 L8 12 h4 L14 18z" fill="url(#seBody)"/>${body(6, 8, 18)}<rect x="6" y="31" width="8" height="2.2" fill="#fff"/>`],
    ['hl', 'Выделитель', `<path d="M6 18 L7 9 L14 5 L14 18 Z" fill="currentColor"/>${body(5, 10, 18)}<rect x="5" y="28" width="10" height="7" fill="currentColor"/><text x="10" y="44" font-size="4.2" fill="#bbb" text-anchor="middle" font-family="system-ui">80</text>`],
    ['eraser', 'Ластик', `<rect x="5" y="4" width="10" height="60" rx="3" fill="url(#seBody)"/><rect x="5" y="4" width="10" height="12" rx="3" fill="#f39a9a"/><rect x="5" y="13" width="10" height="3" fill="#f39a9a"/>`],
    ['pencil', 'Карандаш', `<path d="M5 22 L10 3 L15 22 Z" fill="#4a4a4e"/><path d="M8.8 8 L10 3 L11.2 8 Z" fill="currentColor"/><path d="M6.5 16 L8 22 M10 12 L10 22 M13.5 16 L12 22" stroke="#2a2a2c" stroke-width=".6"/>${body(5, 10, 22)}`],
  ];
  const GRAD = '<defs><linearGradient id="seBody" x1="0" x2="1"><stop offset="0" stop-color="#3a3a3d"/><stop offset=".35" stop-color="#1c1c1e"/><stop offset=".7" stop-color="#111"/><stop offset="1" stop-color="#2a2a2c"/></linearGradient></defs>';
  const toolSvg = k => `<svg viewBox="0 0 20 64">${GRAD}${TOOLS.find(t => t[0] === k)[2]}</svg>`;
  // сохранённые цвета — на этом устройстве
  let saved = []; try { saved = JSON.parse(localStorage.getItem('fixpoint.colors') || '[]'); } catch {}
  const st = { tool: 'pen', color: '#e5332a', alpha: 1, strokes: [], cur: null, open: false, corner: 'left', picking: false };
  const el = document.createElement('div');
  el.className = 'shot-ed';
  el.innerHTML = `
    <div class="se-top">
      <button class="se-btn" data-a="back" aria-label="Назад"><svg viewBox="0 0 24 24" class="se-back"><path d="M15.5 4.5L8 12l7.5 7.5"/></svg></button>
      <span class="se-gap"></span>
      <button class="se-btn" data-a="undo" aria-label="Отменить" disabled><svg viewBox="0 0 24 24"><path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 010 11H11"/></svg></button>
      <div class="se-pill">
        <button class="se-btn" data-a="save" aria-label="Сохранить в Фото"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v9M8 12.5l4 4 4-4"/></svg></button>
        <button class="se-btn" data-a="share" aria-label="Отправить"><svg viewBox="0 0 24 24"><path d="M12 15V3M7.5 7.5L12 3l4.5 4.5"/><path d="M6 11H5a1 1 0 00-1 1v8a1 1 0 001 1h14a1 1 0 001-1v-8a1 1 0 00-1-1h-1"/></svg></button>
      </div>
    </div>
    <div class="se-stage"><div class="se-frame"><canvas class="se-base"></canvas><canvas class="se-ink"></canvas></div></div>
    <button class="se-mini" aria-label="Инструменты"></button>
    <div class="se-tools">
      <i class="se-grip" aria-label="Свернуть"></i>
      ${TOOLS.map(([k, n]) => `<button class="se-tool ${k === st.tool ? 'on' : ''}" data-t="${k}" aria-label="${n}">${toolSvg(k)}</button>`).join('')}
      <button class="se-color" aria-label="Цвет"><span></span></button>
    </div>
    <div class="se-dim"></div>
    <div class="se-cp">
      <div class="cp-head">
        <button class="cp-ico" data-cp="pick" aria-label="Пипетка"><svg viewBox="0 0 24 24"><path d="M14.5 4.5l5 5M17 2.5a2.1 2.1 0 013 3l-2 2-3-3z"/><path d="M15 7.5L6 16.5l-1.5 3.5 3.5-1.5 9-9"/></svg></button>
        <b>Цвета</b>
        <button class="cp-ico" data-cp="close" aria-label="Закрыть"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
      </div>
      <div class="cp-tabs"><button data-tab="grid" class="on">Сетка</button><button data-tab="spec">Спектр</button><button data-tab="sliders">Слайдеры</button></div>
      <div class="cp-body">
        <div class="cp-grid" data-pane="grid"></div>
        <canvas class="cp-spec hidden" data-pane="spec" width="300" height="200"></canvas>
        <div class="cp-sliders hidden" data-pane="sliders">
          ${['Красный', 'Зелёный', 'Синий'].map((n, i) => `<label>${n}<input type="range" min="0" max="255" data-ch="${i}"><output></output></label>`).join('')}
        </div>
      </div>
      <div class="cp-op"><span>НЕПРОЗРАЧНОСТЬ</span><div class="cp-op-row"><input type="range" min="5" max="100" value="100" class="cp-alpha"><output class="cp-alpha-v">100 %</output></div></div>
      <div class="cp-saved"><span class="cp-cur"></span><button class="cp-add" aria-label="Запомнить цвет">+</button><div class="cp-list"></div></div>
    </div>`;
  document.body.appendChild(el);
  const $e = s => el.querySelector(s);
  const base = $e('.se-base'), ink = $e('.se-ink'), frame = $e('.se-frame'), stage = $e('.se-stage');
  const bctx = base.getContext('2d'), ictx = ink.getContext('2d');
  const img = new Image();
  const fit = () => {
    const W = img.naturalWidth, H = img.naturalHeight; if (!W) return;
    const r = stage.getBoundingClientRect(), k = Math.min((r.width - 32) / W, (r.height - 6) / H);   // без полей сцены
    frame.style.width = `${W * k}px`; frame.style.height = `${H * k}px`;
  };
  img.onload = () => { base.width = ink.width = img.naturalWidth; base.height = ink.height = img.naturalHeight; bctx.drawImage(img, 0, 0); fit(); redraw(); };
  img.src = dataUrl;
  window.addEventListener('resize', fit);

  /* ---------- рисование ---------- */
  const W = () => base.width || 1000;
  const sizeOf = t => ({ pen: 0.007, marker: 0.004, hl: 0.032, eraser: 0.045, pencil: 0.005 }[t] * W());
  const drawStroke = s => {
    if (!s.pts.length) return;
    ictx.save();
    ictx.globalCompositeOperation = s.tool === 'eraser' ? 'destination-out' : 'source-over';
    ictx.globalAlpha = s.tool === 'eraser' ? 1 : s.alpha * (s.tool === 'hl' ? 0.4 : s.tool === 'pencil' ? 0.75 : 1);
    ictx.strokeStyle = s.tool === 'eraser' ? '#000' : s.color;
    ictx.lineWidth = s.size; ictx.lineCap = s.tool === 'hl' ? 'butt' : 'round'; ictx.lineJoin = 'round';
    ictx.beginPath(); ictx.moveTo(s.pts[0][0], s.pts[0][1]);
    if (s.pts.length === 1) ictx.lineTo(s.pts[0][0] + 0.1, s.pts[0][1]);
    for (let i = 1; i < s.pts.length; i++) ictx.lineTo(s.pts[i][0], s.pts[i][1]);
    ictx.stroke(); ictx.restore();
  };
  const redraw = () => {
    ictx.clearRect(0, 0, ink.width, ink.height);
    st.strokes.forEach(drawStroke); if (st.cur) drawStroke(st.cur);
    $e('[data-a="undo"]').disabled = !st.strokes.length;
  };
  const pos = e => { const r = ink.getBoundingClientRect(); return [(e.clientX - r.left) * ink.width / r.width, (e.clientY - r.top) * ink.height / r.height]; };
  ink.addEventListener('pointerdown', e => {
    e.preventDefault();
    if (st.picking) {   // пипетка: цвет со снимка
      const [x, y] = pos(e).map(Math.round); const d = bctx.getImageData(Math.max(0, x), Math.max(0, y), 1, 1).data;
      st.picking = false; el.classList.remove('picking'); setColor(rgbHex(d[0], d[1], d[2])); openPicker(true); return;
    }
    try { ink.setPointerCapture(e.pointerId); } catch {}
    st.cur = { tool: st.tool, color: st.color, alpha: st.alpha, size: sizeOf(st.tool), pts: [pos(e)] }; redraw();
  });
  ink.addEventListener('pointermove', e => { if (!st.cur) return; st.cur.pts.push(pos(e)); redraw(); });
  const end = () => { if (!st.cur) return; st.strokes.push(st.cur); st.cur = null; redraw(); };
  ink.addEventListener('pointerup', end); ink.addEventListener('pointercancel', end);

  /* ---------- панель инструментов: свёрнута в кружок в углу, тап — развернуть, ручка — свернуть, кружок можно перетащить в другой угол ---------- */
  const mini = $e('.se-mini'), tray = $e('.se-tools');
  const paint = () => {
    el.querySelectorAll('.se-tool').forEach(b => { b.classList.toggle('on', b.dataset.t === st.tool); b.style.color = st.color; });
    $e('.se-color span').style.background = st.color;
    mini.innerHTML = toolSvg(st.tool); mini.style.color = st.color;
    mini.classList.toggle('right', st.corner === 'right'); el.classList.toggle('mini-right', st.corner === 'right');
    // куда сжимается панель — на место кружка (clip-path), см. .se-tools в app.css
    const tr = tray.getBoundingClientRect(), mr = mini.getBoundingClientRect();
    if (tr.width && !mini.classList.contains('dragging')) tray.style.setProperty('--to-mini',
      `inset(${mr.top - tr.top}px ${tr.right - mr.right}px ${tr.bottom - mr.bottom}px ${mr.left - tr.left}px round ${mr.width / 2}px)`);
    el.classList.toggle('tray-open', st.open);
  };
  const setOpen = v => { st.open = v; paint(); };
  el.querySelectorAll('.se-tool').forEach(b => b.onclick = () => { st.tool = b.dataset.t; paint(); });
  $e('.se-grip').onclick = () => setOpen(false);
  // свернуть, как в «Разметке» iOS: взять панель у края и провести к другому краю — край едет за пальцем,
  // панель сжимается в кружок в том углу, куда тянули (дальше трети ширины или рывком), иначе возвращается
  let tg = null, swallowClick = false;
  tray.addEventListener('pointerdown', e => { tg = { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId, dir: 0, w: tray.getBoundingClientRect().width }; });
  tray.addEventListener('pointermove', e => {
    if (!tg || e.pointerId !== tg.id) return;
    const dx = e.clientX - tg.x;
    if (!tg.dir) {
      if (Math.abs(dx) < 10 || Math.abs(dx) < Math.abs(e.clientY - tg.y)) return;
      tg.dir = dx > 0 ? 1 : -1; tray.classList.add('dragging'); try { tray.setPointerCapture(e.pointerId); } catch {}
    }
    const d = Math.max(0, Math.min(tg.w - 94, dx * tg.dir));
    tray.style.clipPath = tg.dir > 0 ? `inset(0 0 0 ${d}px round 52px)` : `inset(0 ${d}px 0 0 round 52px)`;
  });
  const trayEnd = e => {
    const g = tg; tg = null;
    if (!g || !g.dir) return;
    swallowClick = true; setTimeout(() => { swallowClick = false; }, 300);
    const dx = (e.clientX - g.x) * g.dir, v = dx / Math.max(1, performance.now() - g.t);
    tray.classList.remove('dragging');
    if (dx > g.w / 3 || v > 0.6) { st.corner = g.dir > 0 ? 'right' : 'left'; st.open = false; paint(); }
    tray.style.clipPath = '';
  };
  tray.addEventListener('pointerup', trayEnd); tray.addEventListener('pointercancel', trayEnd);
  tray.addEventListener('click', e => { if (swallowClick) { e.stopPropagation(); e.preventDefault(); } }, true);
  // кружок: тап — развернуть; перетаскивание — едет точно за пальцем (без анимации), по отпусканию плавно встаёт в ближайший нижний угол
  let md = null;
  mini.addEventListener('pointerdown', e => {
    const r = mini.getBoundingClientRect();
    md = { x: e.clientX, y: e.clientY, moved: false, r };
    try { mini.setPointerCapture(e.pointerId); } catch {}
  });
  mini.addEventListener('pointermove', e => {
    if (!md) return;
    const dx = e.clientX - md.x, dy = e.clientY - md.y;
    if (!md.moved && Math.hypot(dx, dy) > 6) { md.moved = true; mini.classList.add('dragging'); }
    if (md.moved) {
      const cx = Math.max(-md.r.left + 6, Math.min(innerWidth - md.r.right - 6, dx));
      const cy = Math.max(-md.r.top + 60, Math.min(0, dy) + Math.max(0, dy) * 0.15);   // вниз — с сопротивлением
      mini.style.transform = `translate(${cx}px, ${cy}px) scale(1.06)`;
    }
  });
  const miniEnd = e => {
    if (!md) return;
    const g = md; md = null;
    if (!g.moved) { if (e.type === 'pointerup') setOpen(true); return; }
    // FLIP: запоминаем, где кружок сейчас, переставляем в угол и плавно доводим
    const now = mini.getBoundingClientRect();
    st.corner = now.left + now.width / 2 > innerWidth / 2 ? 'right' : 'left'; paint();
    mini.style.transform = '';
    const to = mini.getBoundingClientRect();
    mini.style.transform = `translate(${now.left - to.left}px, ${now.top - to.top}px)`;
    mini.getBoundingClientRect();
    mini.classList.remove('dragging');
    requestAnimationFrame(() => { mini.style.transform = ''; });
  };
  mini.addEventListener('pointerup', miniEnd); mini.addEventListener('pointercancel', miniEnd);

  /* ---------- окно «Цвета»: сетка, спектр, слайдеры, непрозрачность, пипетка, сохранённые цвета ---------- */
  const hex2 = v => Math.round(v).toString(16).padStart(2, '0');
  const rgbHex = (r, g, b) => '#' + hex2(r) + hex2(g) + hex2(b);
  const hexRgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  const hsl = (h, s, l) => { s /= 100; l /= 100; const k = n => (n + h / 30) % 12, a = s * Math.min(l, 1 - l); const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1)); return rgbHex(f(0) * 255, f(8) * 255, f(4) * 255); };
  // сетка как у Apple: верхний ряд — серые, дальше 12 оттенков от тёмного к светлому
  const HUES = [195, 215, 240, 265, 290, 330, 5, 18, 32, 45, 58, 85];
  const gridColors = [];
  for (let i = 0; i < 12; i++) { const v = 255 - i * 255 / 11; gridColors.push(rgbHex(v, v, v)); }
  for (let row = 0; row < 9; row++) for (const h of HUES) gridColors.push(hsl(h, row < 2 ? 100 : 92 - row * 3, 10 + row * 9.5));
  $e('.cp-grid').innerHTML = gridColors.map(c => `<i data-c="${c}" style="background:${c}"></i>`).join('');
  const spec = $e('.cp-spec'), sctx = spec.getContext('2d');
  for (let x = 0; x < 300; x++) for (let y = 0; y < 200; y += 4) { sctx.fillStyle = hsl(x * 1.2, 100, 95 - y * 0.45); sctx.fillRect(x, y, 1, 4); }
  const setColor = c => {
    st.color = c; if (st.tool === 'eraser') st.tool = 'pen';
    $e('.cp-cur').style.background = c;
    el.querySelectorAll('.cp-grid i').forEach(i => i.classList.toggle('on', i.dataset.c === c));
    const rgb = hexRgb(c);
    el.querySelectorAll('[data-ch]').forEach(s => { s.value = rgb[+s.dataset.ch]; s.nextElementSibling.textContent = rgb[+s.dataset.ch]; });
    $e('.cp-alpha').style.setProperty('--c', c);
    paint();
  };
  const renderSaved = () => { $e('.cp-list').innerHTML = saved.map(c => `<i data-c="${c}" style="background:${c}"></i>`).join(''); };
  const openPicker = v => { el.classList.toggle('cp-open', v); };
  $e('.se-color').onclick = () => openPicker(true);
  $e('[data-cp="close"]').onclick = () => openPicker(false);
  $e('.se-dim').onclick = () => openPicker(false);
  $e('[data-cp="pick"]').onclick = () => { openPicker(false); st.picking = true; el.classList.add('picking'); toast('Тапните по снимку — возьму цвет'); };
  el.querySelectorAll('.cp-tabs button').forEach(b => b.onclick = () => {
    el.querySelectorAll('.cp-tabs button').forEach(x => x.classList.toggle('on', x === b));
    el.querySelectorAll('[data-pane]').forEach(p => p.classList.toggle('hidden', p.dataset.pane !== b.dataset.tab));
  });
  $e('.cp-grid').onclick = e => { const i = e.target.closest('[data-c]'); if (i) setColor(i.dataset.c); };
  $e('.cp-list').onclick = e => { const i = e.target.closest('[data-c]'); if (i) setColor(i.dataset.c); };
  const specPick = e => { const r = spec.getBoundingClientRect(); const x = Math.max(0, Math.min(299, (e.clientX - r.left) * 300 / r.width)), y = Math.max(0, Math.min(199, (e.clientY - r.top) * 200 / r.height)); const d = sctx.getImageData(x | 0, y | 0, 1, 1).data; setColor(rgbHex(d[0], d[1], d[2])); };
  spec.addEventListener('pointerdown', e => { specPick(e); try { spec.setPointerCapture(e.pointerId); } catch {} spec.onpointermove = specPick; });
  spec.addEventListener('pointerup', () => { spec.onpointermove = null; });
  el.querySelectorAll('[data-ch]').forEach(s => s.oninput = () => { const rgb = [...el.querySelectorAll('[data-ch]')].map(x => +x.value); setColor(rgbHex(...rgb)); });
  $e('.cp-alpha').oninput = e => { st.alpha = +e.target.value / 100; $e('.cp-alpha-v').textContent = `${e.target.value} %`; };
  $e('.cp-add').onclick = () => {
    saved = [st.color, ...saved.filter(c => c !== st.color)].slice(0, 12);
    try { localStorage.setItem('fixpoint.colors', JSON.stringify(saved)); } catch {}
    renderSaved();
  };
  renderSaved(); setColor(st.color);

  /* ---------- итог: снимок + рисунок; сохранить в «Фото», отправить ---------- */
  const result = () => new Promise(res => {
    const c = document.createElement('canvas'); c.width = base.width; c.height = base.height;
    const g = c.getContext('2d'); g.drawImage(base, 0, 0); g.drawImage(ink, 0, 0);
    c.toBlob(b => res(b), 'image/jpeg', 0.92);
  });
  const fileName = () => `Fixpoint-3D-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.jpg`;
  const close = () => { window.removeEventListener('resize', fit); el.remove(); };
  $e('[data-a="back"]').onclick = close;
  $e('[data-a="undo"]').onclick = () => { st.strokes.pop(); redraw(); };
  $e('[data-a="save"]').onclick = async () => {
    const blob = await result();
    if (Native.RP && Native.RP.saveImage) {
      try {
        const b64 = await new Promise((ok, no) => { const fr = new FileReader(); fr.onload = () => ok(String(fr.result).split(',')[1]); fr.onerror = no; fr.readAsDataURL(blob); });
        await Native.RP.saveImage({ data: b64 }); toast('Сохранено в «Фото»');
      } catch (err) {
        // нет доступа к «Фото» — сразу предлагаем открыть настройки приложения (там пункт «Фото»)
        if (/denied|доступа/i.test(String(err && (err.code || err.message) || err)) && Native.RP.openSettings) {
          if (await uiDialog({ text: 'Нет доступа к «Фото». Откройте настройки Fixpoint → «Фото» и выберите «Добавлять фото» или «Полный доступ».', ok: 'Открыть настройки', cancel: 'Отмена' }))
            Native.RP.openSettings().catch(() => {});
        } else uiAlert('Не удалось сохранить: ' + (err && err.message || err));
      }
      return;
    }
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = fileName(); a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000); toast('Снимок сохранён');
  };
  $e('[data-a="share"]').onclick = async () => deliverFile(await result(), fileName());   // только картинка, без подписи (просьба пользователя)
}

/* ---------- экспорт 3D-модели (GLB) прямо с «Ещё», без экрана 3D и без фото (просьба пользователя 2026-10-15) ---------- */
async function exportGlbModel(pid) {
  const { project, rooms } = await loadProjectData(pid);
  if (!rooms.length) return uiAlert('Схема пуста — сначала обмерьте или нарисуйте комнаты.');
  const THREE = await threeReady();
  const { GLTFExporter } = await import('./vendor/GLTFExporter.js');
  const S = buildTourScene(THREE, rooms);
  // в файл — только сама модель, как её видно в 3D: стены с проёмами, полы, двери, окна, мебель; без фото, света, потолков и вспомогательных линий
  const keep = new Set([...S.solidWalls, ...S.plainFloors, ...S.furniture]);
  S.scene.traverse(o => { if (o.isMesh || o.isLine || o.isLineSegments || o.isLight) o.visible = false; });
  const show = o => { o.visible = true; o.traverse(c => { c.visible = true; }); };
  keep.forEach(show);
  S.solidWalls.forEach(w => { w.name = w.name || 'Стена'; });
  S.plainFloors.forEach((f, i) => { f.name = `${rooms[i].name} · пол`; });
  const buf = await new GLTFExporter().parseAsync(S.scene, { binary: true, onlyVisible: true, maxTextureSize: 1024 });
  const blob = new Blob([buf], { type: 'model/gltf-binary' });
  S.scene.traverse(o => { if (o.geometry) o.geometry.dispose(); });
  return { blob, file: `${(project.name || 'model').replace(/[\\/:*?"<>|]+/g, '_')}.glb` };
}

// окно «3D-модель готова» — жидким стеклом; кнопки-значки: ✕ закрыть, сохранить (в «Файлы» на iPhone), отправить
function showGlbDialog(blob, file, onDone) {
  const back = document.createElement('div');
  back.className = 'ui-dlg-back';
  const host = document.createElement('div');
  host.className = 'ui-dlg glb-dlg';
  host.innerHTML = `<div class="sh-title">3D-модель готова</div>
    <p class="mut small">${esc(file)} · ${(blob.size / 1048576).toFixed(1).replace('.', ',')} МБ<br>Формат GLB открывается в Blender, SketchUp, онлайн-просмотрщиках и на сайтах.</p>
    <div class="glb-btns">
      <button class="round-btn" data-glb="x" aria-label="Закрыть"><svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
      <button class="round-btn" data-glb="save" aria-label="Сохранить"><svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v9M8 12.5l4 4 4-4"/></svg></button>
      <button class="round-btn go" data-glb="send" aria-label="Отправить"><svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V3M7.5 7.5L12 3l4.5 4.5"/><path d="M6 11H5a1 1 0 00-1 1v8a1 1 0 001 1h14a1 1 0 001-1v-8a1 1 0 00-1-1h-1"/></svg></button>
    </div>`;
  back.appendChild(host); document.body.appendChild(back);
  requestAnimationFrame(() => back.classList.add('on'));
  const done = () => { back.classList.remove('on'); setTimeout(() => back.remove(), 180); onDone && onDone(); };
  host.querySelector('[data-glb="x"]').onclick = done;
  host.querySelector('[data-glb="send"]').onclick = async () => { await deliverFile(blob, file); done(); };
  host.querySelector('[data-glb="save"]').onclick = async () => {
    if (Native.RP && Native.RP.saveFile) {   // на iPhone — системное окно «Сохранить в Файлы»: куда сохранить, выбирает пользователь
      try {
        const b64 = await new Promise((ok, no) => { const fr = new FileReader(); fr.onload = () => ok(String(fr.result).split(',')[1]); fr.onerror = no; fr.readAsDataURL(blob); });
        let r = null;
        try { r = await Native.RP.saveFileAs({ name: file, data: b64 }); }
        catch (e) {   // старая сборка без saveFileAs — как раньше, в «Файлы» → «На iPhone» → Fixpoint
          if (!/not implemented|unimplemented|не реализ/i.test(String(e && (e.code || e.message) || e))) throw e;
          await Native.RP.saveFile({ name: file, data: b64 });
          toast('Сохранено: «Файлы» → «На iPhone» → Fixpoint');
          return done();
        }
        if (!r || !r.saved) return;   // отмена в окне выбора папки — остаёмся в окне «модель готова»
        toast('Сохранено');
      } catch (err) { uiAlert('Не удалось сохранить: ' + (err && err.message || err)); return; }
    } else {
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = file; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 60000); toast('Файл сохранён');
    }
    done();
  };
}
