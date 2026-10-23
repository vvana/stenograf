"""Прототип текстурирования «как у Polycam» для переноса на телефон: сетка лидара ARKit (points.ply из HD-пакета) +
кадры с позами и глубиной → GLB с атласом. Без OpenMVS; кадры обрабатываются по одному (на телефоне — то же, память не растёт).
1) выбор кадра для каждого треугольника: виден (глубина лидара этого кадра), прямо, близко, ближе к центру кадра;
   сглаживание выбора по соседям (меньше лоскутов);
2) атлас: каждой паре треугольников — квадратная клетка S×S, треугольник — половина клетки (с зазором, без затекания);
3) растеризация: точка клетки → точка треугольника → проекция в выбранный кадр → цвет (билинейно);
4) выравнивание яркости: эталон вершины — среднее по кадрам, где видна; поправка в углах (эталон / цвет выбранного кадра),
   барицентрически по треугольнику.
py -3.9 mesh_texture.py <пакет> <сетка.ply> <out.glb> [размер атласа=4096]"""
import sys, os, json, time, struct, numpy as np, trimesh, cv2
from PIL import Image
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from hdpkg import depth_view

d, mesh_path, out = sys.argv[1], sys.argv[2], sys.argv[3]
N = int(sys.argv[4]) if len(sys.argv) > 4 else 4096
LONG = 1536          # кадры для текстуры — до 1536 по длинной стороне
SMALL = 480          # кадры для эталона яркости
t0 = time.time()
mesh = trimesh.load(mesh_path, process=False)
V = np.asarray(mesh.vertices, np.float64); F = np.asarray(mesh.faces, np.int64)
nF, nV = len(F), len(V)
fn = np.cross(V[F[:, 1]] - V[F[:, 0]], V[F[:, 2]] - V[F[:, 0]]); fa = np.linalg.norm(fn, axis=1); fn /= np.maximum(fa, 1e-12)[:, None]
fc = V[F].mean(1)
m = json.load(open(d + '/transforms.json'))
frames = [f for f in m['frames'] if f.get('depth_file_path')]
nI = len(frames)
print(f'сетка {nF} треуг., кадров {nI}', flush=True)

def cam(f, scale_w):
    c2w = np.array(f['transform_matrix']) @ np.diag([1, -1, -1, 1]); w2c = np.linalg.inv(c2w)
    k = scale_w / f['w']
    return w2c, f['fl_x'] * k, f['fl_y'] * k, f['cx'] * k, f['cy'] * k

def project(P, w2c, fx, fy, cx, cy):
    pc = P @ w2c[:3, :3].T + w2c[:3, 3]; z = pc[:, 2]; zz = np.where(z > 1e-3, z, 1e-3)
    return fx * pc[:, 0] / zz + cx, fy * pc[:, 1] / zz + cy, z, pc

# ---------- 1. оценка каждого кадра для каждого треугольника (нужны только позы и глубина) ----------
score = np.zeros((nF, nI), np.float32)
for i, f in enumerate(frames):
    dep = np.asarray(Image.open(d + '/' + f['depth_file_path'])).astype(np.float32) / 1000.0
    dh, dw = dep.shape
    W = f['w']; H = f['h']
    w2c, fx, fy, cx, cy = cam(f, W)
    u, v, z, pc = project(fc, w2c, fx, fy, cx, cy)
    # все три вершины в кадре (с запасом от края 2%)
    uu, vv, zv, _ = project(V, w2c, fx, fy, cx, cy)
    inv = (zv > 0.15) & (uu > 0.02 * W) & (uu < 0.98 * W) & (vv > 0.02 * H) & (vv < 0.98 * H)
    ok = inv[F].all(1) & (z > 0.15) & (z < 6)
    # не загорожено: глубина лидара в центре треугольника (камера глубины этого кадра)
    DT, dfx, dfy, dcx, dcy, DW, DH = depth_view(f)
    dw2c = np.linalg.inv(np.array(DT) @ np.diag([1, -1, -1, 1])); kd = dw / DW
    du, dv, dz, _ = project(fc, dw2c, dfx * kd, dfy * kd, dcx * kd, dcy * kd)
    di = np.clip(du.astype(int), 0, dw - 1); dj = np.clip(dv.astype(int), 0, dh - 1)
    dd = dep[dj, di]
    ok &= (dd > 0) & (np.abs(dz - dd) < 0.03 + 0.02 * dz)
    view = -(pc / np.linalg.norm(pc, axis=1, keepdims=True)) @ w2c[:3, :3]          # из точки к камере (мир)
    cosv = (fn * view).sum(1)
    ok &= cosv > 0.25
    r2 = ((u - W / 2) / (W / 2)) ** 2 + ((v - H / 2) / (H / 2)) ** 2
    s = cosv ** 2 * np.clip(1 - 0.5 * r2, 0.1, 1) / np.maximum(z, 0.5)
    score[:, i] = np.where(ok, s, 0)
best = score.argmax(1); bests = score.max(1); seen = bests > 0
print(f'выбор кадров: видно {seen.mean():.1%} треугольников', f'{time.time() - t0:.0f}s', flush=True)

# сглаживание выбора: если кадр соседей почти так же хорош (≥ 70% лучшего) — берём его (меньше швов)
adj = mesh.face_adjacency
for it in range(4):
    cand = np.full((nF, 3), -1)
    cnt = np.zeros(nF, int)
    for a, b in ((adj[:, 0], adj[:, 1]), (adj[:, 1], adj[:, 0])):
        for x, y in zip(a, b):
            if cnt[x] < 3: cand[x, cnt[x]] = best[y]; cnt[x] += 1
    changed = 0
    for fi in np.where(seen)[0]:
        c = cand[fi][cand[fi] >= 0]
        if not len(c): continue
        vals, counts = np.unique(c, return_counts=True)
        top = vals[counts.argmax()]
        if top != best[fi] and counts.max() >= 2 and score[fi, top] >= 0.7 * bests[fi]:
            best[fi] = top; changed += 1
    print(f'  сглаживание {it + 1}: сменили {changed}', flush=True)
    if not changed: break

# ---------- 2. атлас: клетка S×S на пару треугольников ----------
# раскладка по соседству: треугольники, близкие в пространстве, — в соседних клетках атласа (иначе мип-уровни при отдалении
# смешивают краски несвязанных клеток — «рябь»). Порядок — кривая Мортона по центрам (сетка 2 см), клетки — Z-порядком
# внутри блоков 16×16, блоки — по строкам.
cells = (nF + 1) // 2
B = 16
G = int(np.ceil(np.sqrt(cells) / B)) * B
S = N // G
print(f'атлас {N}x{N}, клетка {S}px', flush=True)
def part1by2(x):
    x = x.astype(np.uint64) & np.uint64(0x1fffff)
    x = (x | (x << np.uint64(32))) & np.uint64(0x1f00000000ffff)
    x = (x | (x << np.uint64(16))) & np.uint64(0x1f0000ff0000ff)
    x = (x | (x << np.uint64(8))) & np.uint64(0x100f00f00f00f00f)
    x = (x | (x << np.uint64(4))) & np.uint64(0x10c30c30c30c30c3)
    x = (x | (x << np.uint64(2))) & np.uint64(0x1249249249249249)
    return x
q = np.floor((fc - fc.min(0)) / 0.02).astype(np.int64)
order = np.argsort(part1by2(q[:, 0]) | (part1by2(q[:, 1]) << np.uint64(1)) | (part1by2(q[:, 2]) << np.uint64(2)), kind='stable')
rank = np.empty(nF, np.int64); rank[order] = np.arange(nF)
cell = rank // 2; half = rank % 2
def deinter(w):   # 8 бит → (x, y) Z-порядка
    x = np.zeros_like(w); y = np.zeros_like(w)
    for b in range(4):
        x |= ((w >> (2 * b)) & 1) << b; y |= ((w >> (2 * b + 1)) & 1) << b
    return x, y
blk = cell // (B * B); wx, wy = deinter(cell % (B * B))
ox = ((blk % (G // B)) * B + wx) * S; oy = ((blk // (G // B)) * B + wy) * S
# углы треугольников в клетке (непрерывные пиксели): нижняя половина и верхняя — с зазором 1,5 px по диагонали
T1 = np.array([[1, 1], [S - 2, 1], [1, S - 2]], float)                # x + y ≤ S − 1
T2 = np.array([[S - 1, 2.5], [S - 1, S - 1], [2.5, S - 1]], float)    # x + y ≥ S + 1.5
tri_uv = np.where(half[:, None, None] == 0, T1[None], T2[None]) + np.stack([ox, oy], 1)[:, None, :]
UV = tri_uv / N

# шаблон текселей клетки: свои тексели половины + барицентрические координаты (с выходом за край — дилатация)
def template(T, own):
    ys, xs = np.mgrid[0:S, 0:S]; cxs = xs + 0.5; cys = ys + 0.5
    m_ = own(cxs, cys)
    P = np.stack([cxs[m_], cys[m_]], 1)
    a, b, c = T
    M = np.array([b - a, c - a]).T; Mi = np.linalg.inv(M)
    l12 = (P - a) @ Mi.T
    bar = np.c_[1 - l12.sum(1), l12]
    bar = np.clip(bar, -0.05, 1.05); bar /= bar.sum(1, keepdims=True)
    return xs[m_], ys[m_], bar
tx1, ty1, tb1 = template(T1, lambda x, y: (x + y) <= S - 1 + 1e-6)
tx2, ty2, tb2 = template(T2, lambda x, y: (x + y) >= S - 1e-6)

atlas = np.zeros((N, N, 3), np.float32)
filled = np.zeros((N, N), bool)

# ---------- 3. растеризация + накопление эталона яркости (кадры по одному) ----------
ref = np.zeros((nV, 3)); refw = np.zeros(nV)
corner = np.full((nF, 3, 3), np.nan)          # цвет выбранного кадра в углах (для поправки)
for i, f in enumerate(frames):
    im = Image.open(d + '/' + f['file_path']).convert('RGB')
    sc = LONG / max(im.size); img = np.asarray(im.resize((round(im.size[0] * sc), round(im.size[1] * sc)), Image.BILINEAR)).astype(np.float32)
    ih, iw = img.shape[:2]
    small = cv2.GaussianBlur(cv2.resize(img, (SMALL, round(SMALL * ih / iw))), (0, 0), 1.5); sh, sw = small.shape[:2]
    w2c, fx, fy, cx, cy = cam(f, iw)
    # эталон: вершины, видимые в этом кадре (через треугольники с ненулевой оценкой)
    vis_f = score[:, i] > 0
    vv_ = np.unique(F[vis_f])
    if len(vv_):
        pu, pv, pz, _ = project(V[vv_], w2c, fx, fy, cx, cy)
        su = np.clip(pu * sw / iw, 0, sw - 1).astype(int); sv = np.clip(pv * sh / ih, 0, sh - 1).astype(int)
        wv = np.zeros(nV); np.maximum.at(wv, F[vis_f].ravel(), np.repeat(score[vis_f, i], 3))
        ref[vv_] += wv[vv_, None] * small[sv, su]; refw[vv_] += wv[vv_]
    sel = np.where(seen & (best == i))[0]
    if not len(sel): continue
    # цвет выбранного кадра в углах
    pu, pv, _, _ = project(V[F[sel]].reshape(-1, 3), w2c, fx, fy, cx, cy)
    su = np.clip(pu * sw / iw, 0, sw - 1).astype(int); sv = np.clip(pv * sh / ih, 0, sh - 1).astype(int)
    corner[sel] = small[sv, su].reshape(-1, 3, 3)
    for h, (tx, ty, tb) in enumerate(((tx1, ty1, tb1), (tx2, ty2, tb2))):
        fs = sel[half[sel] == h]
        if not len(fs): continue
        P = np.einsum('tk,fkd->ftd', tb, V[F[fs]])                          # (nf, T, 3)
        pu, pv, _, _ = project(P.reshape(-1, 3), w2c, fx, fy, cx, cy)
        x0 = np.clip(np.floor(pu - 0.5).astype(int), 0, iw - 2); y0 = np.clip(np.floor(pv - 0.5).astype(int), 0, ih - 2)
        ax = np.clip(pu - 0.5 - x0, 0, 1)[:, None]; ay = np.clip(pv - 0.5 - y0, 0, 1)[:, None]
        col = (img[y0, x0] * (1 - ax) + img[y0, x0 + 1] * ax) * (1 - ay) + (img[y0 + 1, x0] * (1 - ax) + img[y0 + 1, x0 + 1] * ax) * ay
        X = (ox[fs][:, None] + tx[None]).ravel(); Y = (oy[fs][:, None] + ty[None]).ravel()
        atlas[Y, X] = col; filled[Y, X] = True
print(f'растеризация {time.time() - t0:.0f}s', flush=True)

# ---------- 4. выравнивание яркости ----------
R = np.where(refw[:, None] > 0, ref / np.maximum(refw, 1e-9)[:, None], np.nan)
rc = R[F]                                                                   # (nF,3,3)
gain = (rc + 6) / (corner + 6)
gain = np.where(np.isfinite(gain), np.clip(gain, 0.5, 2.0), 1.0)
for h, (tx, ty, tb) in enumerate(((tx1, ty1, tb1), (tx2, ty2, tb2))):
    fs = np.where(seen & (half == h))[0]
    G_ = np.einsum('tk,fkc->ftc', tb, gain[fs])                             # (nf, T, 3)
    X = (ox[fs][:, None] + tx[None]).ravel(); Y = (oy[fs][:, None] + ty[None]).ravel()
    atlas[Y, X] *= G_.reshape(-1, 3)
# треугольники без кадра — эталонным цветом вершин (или серым)
uns = np.where(~seen)[0]
for h, (tx, ty, tb) in enumerate(((tx1, ty1, tb1), (tx2, ty2, tb2))):
    fs = uns[half[uns] == h]
    if not len(fs): continue
    C = np.nan_to_num(rc[fs], nan=170.0)
    col = np.einsum('tk,fkc->ftc', tb, C)
    X = (ox[fs][:, None] + tx[None]).ravel(); Y = (oy[fs][:, None] + ty[None]).ravel()
    atlas[Y, X] = col.reshape(-1, 3)
print(f'без кадра {len(uns)} треуг. ({len(uns) / nF:.1%})', flush=True)
atlas_img = Image.fromarray(np.clip(atlas, 0, 255).astype(np.uint8))

# ---------- GLB: вершины по углам (UV у каждого угла свои), без освещения, не металл, выборка без мип-карт ----------
pos = V[F].reshape(-1, 3).astype(np.float32)
uvs = UV.reshape(-1, 2).astype(np.float32)
idx = np.arange(len(pos), dtype=np.uint32)
import io as _io
jb = _io.BytesIO(); atlas_img.save(jb, 'JPEG', quality=88); jpg = jb.getvalue()
bufs = [pos.tobytes(), uvs.tobytes(), idx.tobytes(), jpg]
offs = []; blob = b''
for b in bufs:
    offs.append(len(blob)); blob += b + b'\0' * ((4 - len(b) % 4) % 4)
gl = {
    'asset': {'version': '2.0', 'generator': 'fixpoint mesh_texture'},
    'extensionsUsed': ['KHR_materials_unlit'],
    'scene': 0, 'scenes': [{'nodes': [0]}], 'nodes': [{'mesh': 0}],
    'meshes': [{'primitives': [{'attributes': {'POSITION': 0, 'TEXCOORD_0': 1}, 'indices': 2, 'material': 0}]}],
    'materials': [{'pbrMetallicRoughness': {'baseColorTexture': {'index': 0}, 'metallicFactor': 0, 'roughnessFactor': 1},
                   'extensions': {'KHR_materials_unlit': {}}, 'doubleSided': False}],
    'textures': [{'source': 0, 'sampler': 0}], 'samplers': [{'magFilter': 9729, 'minFilter': 9729}],
    'images': [{'bufferView': 3, 'mimeType': 'image/jpeg'}],
    'buffers': [{'byteLength': len(blob)}],
    'bufferViews': [{'buffer': 0, 'byteOffset': offs[0], 'byteLength': len(bufs[0]), 'target': 34962},
                    {'buffer': 0, 'byteOffset': offs[1], 'byteLength': len(bufs[1]), 'target': 34962},
                    {'buffer': 0, 'byteOffset': offs[2], 'byteLength': len(bufs[2]), 'target': 34963},
                    {'buffer': 0, 'byteOffset': offs[3], 'byteLength': len(bufs[3])}],
    'accessors': [{'bufferView': 0, 'componentType': 5126, 'count': len(pos), 'type': 'VEC3', 'min': pos.min(0).tolist(), 'max': pos.max(0).tolist()},
                  {'bufferView': 1, 'componentType': 5126, 'count': len(uvs), 'type': 'VEC2'},
                  {'bufferView': 2, 'componentType': 5125, 'count': len(idx), 'type': 'SCALAR'}],
}
js = json.dumps(gl, separators=(',', ':')).encode(); js += b' ' * ((4 - len(js) % 4) % 4)
with open(out, 'wb') as fo:
    fo.write(struct.pack('<III', 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(blob)))
    fo.write(struct.pack('<II', len(js), 0x4E4F534A)); fo.write(js)
    fo.write(struct.pack('<II', len(blob), 0x004E4942)); fo.write(blob)
print(f'готово {out} {os.path.getsize(out) / 1e6:.1f} МБ, {time.time() - t0:.0f}s', flush=True)
