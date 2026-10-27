"""Эталон для DepthMesher.swift (телефон): сетка из глубины HD-пакета без Open3D — то же, что make_mesh.py, своими силами.
TSDF (вокс 2 см, усечение 3 вокселя, глубина до 4,5 м) → Surface Nets (вершина в ячейке со сменой знака, квад на ребро) →
мелкие связные куски прочь (< max(2000, 1% крупнейшего)) → Taubin 5. Нормали треугольников — в сторону свободного пространства (к камере).
Код намеренно «по шагам», как в Swift: проверяем здесь — переносим один в один.
py -3.9 depth_mesher.py <пакет> <out.ply> [вокс=0.02]"""
import sys, json, time, numpy as np
from PIL import Image
from hdpkg import depth_view

d, out = sys.argv[1], sys.argv[2]
VOX = float(sys.argv[3]) if len(sys.argv) > 3 else 0.02
TR = 3 * VOX; DMAX = 4.5
t0 = time.time()
m = json.load(open(d + '/transforms.json'))
frames = [f for f in m['frames'] if f.get('depth_file_path')]

# ---------- рамка объёма по точкам глубины (на телефоне — разреженные блоки, здесь плотный объём для проверки) ----------
def frame_points(f, step):
    dep = np.asarray(Image.open(d + '/' + f['depth_file_path'])).astype(np.float32) / 1000.0
    h, w = dep.shape
    T, fx, fy, cx, cy, W, _ = depth_view(f); k = w / W
    ys, xs = np.mgrid[0:h:step, 0:w:step]
    z = dep[ys, xs]; ok = (z > 0.1) & (z < DMAX)
    x = (xs[ok] + 0.5 - cx * k) / (fx * k) * z[ok]; y = -(ys[ok] + 0.5 - cy * k) / (fy * k) * z[ok]
    pc = np.stack([x, y, -z[ok], np.ones_like(x)], 1)
    return (pc @ np.array(T).T)[:, :3]
P = np.concatenate([frame_points(f, 8) for f in frames])
lo = np.percentile(P, 0.5, 0) - 0.2; hi = np.percentile(P, 99.5, 0) + 0.2
dims = np.ceil((hi - lo) / VOX).astype(int) + 1
print('объём', dims, f'{np.prod(dims) / 1e6:.1f} млн вокселей', flush=True)
tsdf = np.ones(dims, np.float32); wgt = np.zeros(dims, np.float32)
gi = np.stack(np.meshgrid(*[np.arange(n) for n in dims], indexing='ij'), -1).reshape(-1, 3)
G = lo + (gi + 0.0) * VOX                                                      # центр вокселя = узел решётки

# ---------- интеграция: проекция вокселя в карту глубины, sdf = D − z (по оси взгляда) ----------
for n, f in enumerate(frames):
    dep = np.asarray(Image.open(d + '/' + f['depth_file_path'])).astype(np.float32) / 1000.0
    h, w = dep.shape
    T, fx, fy, cx, cy, W, _ = depth_view(f); k = w / W
    w2c = np.linalg.inv(np.array(T))
    pc = G @ w2c[:3, :3].T + w2c[:3, 3]
    z = -pc[:, 2]; ok = z > 0.1
    u = np.floor(fx * k * pc[:, 0] / np.where(ok, z, 1) + cx * k).astype(int)
    v = np.floor(-fy * k * pc[:, 1] / np.where(ok, z, 1) + cy * k).astype(int)
    ok &= (u >= 0) & (u < w) & (v >= 0) & (v < h)
    idx = np.where(ok)[0]
    D = dep[v[idx], u[idx]]
    sdf = D - z[idx]
    good = (D > 0.1) & (D < DMAX) & (sdf > -TR)
    idx = idx[good]; t = np.minimum(1, sdf[good] / TR)
    fl = np.unravel_index(idx, dims)
    wo = wgt[fl]; tsdf[fl] = (tsdf[fl] * wo + t) / (wo + 1); wgt[fl] = wo + 1
print(f'интеграция {time.time() - t0:.0f}s', flush=True)

# ---------- Surface Nets ----------
S = tsdf; Wt = wgt > 0
nx, ny, nz = dims
# ячейка (i,j,k) — куб с углами (i..i+1, j..j+1, k..k+1); вершина — среднее пересечений по 12 рёбрам
c8 = [(a, b, c) for a in (0, 1) for b in (0, 1) for c in (0, 1)]
cs = [S[a:nx - 1 + a, b:ny - 1 + b, c:nz - 1 + c] for a, b, c in c8]
cw = [Wt[a:nx - 1 + a, b:ny - 1 + b, c:nz - 1 + c] for a, b, c in c8]
allw = np.logical_and.reduce(cw)
neg = np.stack([x < 0 for x in cs]); anyneg = neg.any(0); allneg = neg.all(0)
cell = allw & anyneg & ~allneg
ci = np.argwhere(cell)
edges = [(p, q) for p in range(8) for q in range(p + 1, 8) if sum(abs(np.array(c8[p]) - np.array(c8[q]))) == 1]
acc = np.zeros((len(ci), 3)); cnt = np.zeros(len(ci))
for p, q in edges:
    sp = cs[p][tuple(ci.T)]; sq = cs[q][tuple(ci.T)]
    ch = (sp < 0) != (sq < 0)
    tt = sp / np.where(ch, sp - sq, 1)
    pp = np.array(c8[p]); qq = np.array(c8[q])
    acc[ch] += pp + tt[ch, None] * (qq - pp); cnt[ch] += 1
Vg = ci + acc / cnt[:, None]
V = lo + Vg * VOX
vid = -np.ones((nx - 1, ny - 1, nz - 1), np.int64); vid[tuple(ci.T)] = np.arange(len(ci))
F = []
for ax in range(3):
    # ребро решётки от узла g к g+e_ax со сменой знака; четыре ячейки вокруг него
    e = np.eye(3, dtype=int)[ax]; o1 = np.eye(3, dtype=int)[(ax + 1) % 3]; o2 = np.eye(3, dtype=int)[(ax + 2) % 3]
    a0 = S[:nx - e[0], :ny - e[1], :nz - e[2]]; a1 = S[e[0]:, e[1]:, e[2]:]
    w0 = Wt[:nx - e[0], :ny - e[1], :nz - e[2]] & Wt[e[0]:, e[1]:, e[2]:]
    ch = w0 & ((a0 < 0) != (a1 < 0))
    g = np.argwhere(ch)
    g = g[(g[:, (ax + 1) % 3] >= 1) & (g[:, (ax + 2) % 3] >= 1)]
    def cv(off):
        c = g - off
        okc = (c >= 0).all(1) & (c[:, 0] < nx - 1) & (c[:, 1] < ny - 1) & (c[:, 2] < nz - 1)
        r = -np.ones(len(g), np.int64); r[okc] = vid[tuple(c[okc].T)]; return r
    q0 = cv(0 * o1); q1 = cv(o1); q2 = cv(o1 + o2); q3 = cv(o2)
    okq = (q0 >= 0) & (q1 >= 0) & (q2 >= 0) & (q3 >= 0)
    flip = (a0[tuple(g.T)] < 0)[okq]                  # знак у начала ребра: внутри (−) → поверхность смотрит в +ax
    q0, q1, q2, q3 = q0[okq], q1[okq], q2[okq], q3[okq]
    t1 = np.where(flip[:, None], np.stack([q0, q1, q2], 1), np.stack([q0, q2, q1], 1))
    t2 = np.where(flip[:, None], np.stack([q0, q2, q3], 1), np.stack([q0, q3, q2], 1))
    F += [t1, t2]
F = np.concatenate(F)
print(f'surface nets: вершин {len(V)}, треуг. {len(F)}, {time.time() - t0:.0f}s', flush=True)

# ---------- связные куски (union-find по вершинам) ----------
par = np.arange(len(V))
def find(x):
    while par[x] != x: par[x] = par[par[x]]; x = par[x]
    return x
for a, b, c in F:
    ra, rb, rc = find(a), find(b), find(c)
    par[rb] = ra; par[find(rc)] = ra
root = np.array([find(i) for i in range(len(V))])
fr = root[F[:, 0]]
u_, inv, cnts = np.unique(fr, return_inverse=True, return_counts=True)
keep = cnts[inv] >= max(2000, cnts.max() * 0.01)
F = F[keep]
used = np.zeros(len(V), bool); used[F.ravel()] = True
remap = -np.ones(len(V), np.int64); remap[used] = np.arange(used.sum())
V = V[used]; F = remap[F]
print(f'после чистки: вершин {len(V)}, треуг. {len(F)}', flush=True)

# ---------- Taubin 5 (λ 0,5 / μ −0,53, равные веса соседей) ----------
nb = [set() for _ in range(len(V))]
for a, b, c in F:
    nb[a].update((b, c)); nb[b].update((a, c)); nb[c].update((a, b))
nbl = [np.fromiter(s, np.int64) for s in nb]
for _ in range(5):
    for lam in (0.5, -0.53):
        avg = np.array([V[l].mean(0) if len(l) else V[i] for i, l in enumerate(nbl)])
        V = V + lam * (avg - V)

# проверка ориентации: нормаль к камере у видимых треугольников
f0 = frames[len(frames) // 2]; T0 = np.array(depth_view(f0)[0]); cam = T0[:3, 3]
fc = V[F].mean(1); fn = np.cross(V[F[:, 1]] - V[F[:, 0]], V[F[:, 2]] - V[F[:, 0]])
near = np.linalg.norm(fc - cam, axis=1) < 1.5
print('доля треугольников рядом с камерой, смотрящих к ней:', ((fn[near] * (cam - fc[near])).sum(1) > 0).mean().round(3))

with open(out, 'wb') as fo:
    fo.write(f'ply\nformat binary_little_endian 1.0\nelement vertex {len(V)}\nproperty float x\nproperty float y\nproperty float z\n'
             f'element face {len(F)}\nproperty list uchar int vertex_indices\nend_header\n'.encode())
    fo.write(V.astype('<f4').tobytes())
    fb = np.zeros(len(F), dtype=[('n', 'u1'), ('i', '<i4', 3)]); fb['n'] = 3; fb['i'] = F
    fo.write(fb.tobytes())
print(f'готово {out}: {len(F)} треуг., {time.time() - t0:.0f}s')
