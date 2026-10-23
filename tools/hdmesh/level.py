"""Выравнивание яркости текстуры OpenMVS по всем кадрам (вместо его сломанного seam leveling).
1) эталон на вершину: взвешенное среднее цвета по кадрам, где вершина видна (видимость — по глубине лидара);
2) поправка в каждом углу треугольника: эталон / цвет текстуры рядом с углом (сглаженный);
3) поправка плавно (барицентрически) растягивается по треугольнику на атласе и умножается на текстуру;
4) грани без кадра (оранжевые у OpenMVS) закрашиваются эталоном.
py -3.9 level.py <textured.obj> <пакет> <out.glb>"""
import sys, json, time, numpy as np, trimesh, cv2
from PIL import Image
sys.path.insert(0, __import__('os').path.dirname(__import__('os').path.abspath(__file__)))
from hdpkg import depth_view
obj, d, out = sys.argv[1], sys.argv[2], sys.argv[3]
t0 = time.time()
sc = trimesh.load(obj)
geoms = list(sc.geometry.values()) if hasattr(sc, 'geometry') else [sc]
m = json.load(open(d + '/transforms.json'))
frames = [f for f in m['frames'] if f.get('depth_file_path')]
IW, IH = 480, 360
EMPTY = [255, 0, 255]   # цвет пустых граней — задаётся TextureMesh --empty-color 16711935
# пурпурный после JPEG «плывёт»: красный и синий заметно выше зелёного
def is_empty(c): return (c[..., 0] - c[..., 1] > 90) & (c[..., 2] - c[..., 1] > 90)

# --- 1. эталонный цвет вершин ---
allV = np.concatenate([g.vertices for g in geoms]); allN = np.concatenate([g.vertex_normals for g in geoms])
acc = np.zeros((len(allV), 3)); wsum = np.zeros(len(allV))
for f in frames:
    img = cv2.GaussianBlur(np.asarray(Image.open(d + '/' + f['file_path']).convert('RGB').resize((IW, IH))), (0, 0), 1.5).astype(np.float32)
    dep = np.asarray(Image.open(d + '/' + f['depth_file_path'])).astype(np.float32) / 1000.0
    dh, dw = dep.shape
    c2w = np.array(f['transform_matrix']) @ np.diag([1, -1, -1, 1]); w2c = np.linalg.inv(c2w)
    pc = allV @ w2c[:3, :3].T + w2c[:3, 3]
    z = pc[:, 2]
    ok = z > 0.15
    k = IW / f['w']
    zz = np.where(ok, z, 1)
    u = f['fl_x'] * k * pc[:, 0] / zz + f['cx'] * k; v = f['fl_y'] * k * pc[:, 1] / zz + f['cy'] * k
    ok &= (u >= 0) & (u < IW - 1) & (v >= 0) & (v < IH - 1)
    # видимость — по глубине лидара; у кадра 12 Мп глубина от видеокадра со своей позой и интринсиками
    DT, dfx, dfy, dcx, dcy, DW, _ = depth_view(f); kd = dw / DW
    dw2c = np.linalg.inv(DT @ np.diag([1, -1, -1, 1])); pd = allV @ dw2c[:3, :3].T + dw2c[:3, 3]; zd = np.where(pd[:, 2] > 0.15, pd[:, 2], 1)
    du = np.clip((dfx * kd * pd[:, 0] / zd + dcx * kd).astype(int), 0, dw - 1); dv = np.clip((dfy * kd * pd[:, 1] / zd + dcy * kd).astype(int), 0, dh - 1)
    dd = dep[dv, du]
    ok &= (dd > 0) & (np.abs(pd[:, 2] - dd) < 0.04 + 0.03 * pd[:, 2])   # не загорожено
    view = -(pc / np.linalg.norm(pc, axis=1, keepdims=True)) @ w2c[:3, :3]   # из точки к камере, в мире
    cosang = np.abs((allN * view).sum(1))
    r2 = ((u - IW / 2) / (IW / 2)) ** 2 + ((v - IH / 2) / (IH / 2)) ** 2
    w = np.where(ok, cosang ** 2 * np.clip(1 - 0.6 * r2, 0.05, 1) / np.maximum(z, 0.3), 0)
    ui = np.clip(u.astype(int), 0, IW - 1); vi = np.clip(v.astype(int), 0, IH - 1)
    acc += w[:, None] * img[vi, ui]; wsum += w
ref = np.where(wsum[:, None] > 1e-6, acc / np.maximum(wsum, 1e-9)[:, None], np.nan)
print('reference', f'{np.isfinite(ref[:, 0]).mean():.2%} vertices', f'{time.time() - t0:.0f}s', flush=True)

# --- 2-4. поправка текстуры по атласам ---
off = 0
empties = []
for gi, g in enumerate(geoms):
    tex = np.asarray(g.visual.material.image.convert('RGB')).copy()
    H, W = tex.shape[:2]
    nV = len(g.vertices); R = ref[off:off + nV]; off += nV
    F = g.faces; UV = g.visual.uv
    P = np.stack([UV[:, 0] * W - 0.5, (1 - UV[:, 1]) * H - 0.5], 1)        # пиксельные координаты вершин в атласе
    tri = P[F]                                                             # (nF,3,2)
    # цвет текстуры у каждого угла: чуть внутрь треугольника, по сглаженной текстуре
    blur = cv2.blur(tex, (9, 9)).astype(np.float32)
    cen = tri.mean(1, keepdims=True); smp = 0.7 * tri + 0.3 * cen
    sx = np.clip(np.round(smp[..., 0]).astype(int), 0, W - 1); sy = np.clip(np.round(smp[..., 1]).astype(int), 0, H - 1)
    tc = blur[sy, sx]                                                      # (nF,3,3)
    orange = is_empty(tc)
    rc = R[F]                                                              # (nF,3,3) эталон углов
    gain = (rc + 6) / (tc + 6)
    gain = np.where(np.isfinite(gain) & ~orange[..., None], np.clip(gain, float(__import__("os").environ.get("GMIN", 0.55)), float(__import__("os").environ.get("GMAX", 1.8))), 1.0)
    # поправка — одна на вершину: у соседних треугольников в общей вершине она была разной (своя выборка текстуры у каждого угла),
    # и на резкой текстуре 12 Мп проступала сетка треугольников (пакет 1648). Вершины внутри куска текстуры общие,
    # а на швах кусков раздвоены — там поправки остаются разными, как и нужно
    ok = (np.isfinite(rc).all(-1) & ~orange).reshape(-1)
    vg = np.zeros((nV, 3)); vc = np.zeros(nV)
    np.add.at(vg, F.reshape(-1)[ok], gain.reshape(-1, 3)[ok]); np.add.at(vc, F.reshape(-1)[ok], 1)
    gain = np.where((vc > 0)[:, None], vg / np.maximum(vc, 1)[:, None], 1.0)[F]
    if __import__("os").environ.get("NOGAIN"): gain[:] = 1.0
    # карта: какой треугольник в каждом пикселе атласа
    idmap = np.zeros((H, W), np.int32)
    for i, t in enumerate(tri):
        cv2.fillConvexPoly(idmap, np.round(t).astype(np.int32), int(i + 1))
    ys, xs = np.nonzero(idmap)
    fid = idmap[ys, xs] - 1
    T = tri[fid]                                                           # барицентрические координаты пикселя
    v0 = T[:, 1] - T[:, 0]; v1 = T[:, 2] - T[:, 0]; v2 = np.stack([xs, ys], 1) - T[:, 0]
    d00 = (v0 * v0).sum(1); d01 = (v0 * v1).sum(1); d11 = (v1 * v1).sum(1); d20 = (v2 * v0).sum(1); d21 = (v2 * v1).sum(1)
    den = d00 * d11 - d01 * d01; den = np.where(np.abs(den) < 1e-9, 1e-9, den)
    b1 = (d11 * d20 - d01 * d21) / den; b2 = (d00 * d21 - d01 * d20) / den; b0 = 1 - b1 - b2
    B = np.clip(np.stack([b0, b1, b2], 1), 0, 1); B /= np.maximum(B.sum(1, keepdims=True), 1e-6)
    G = (B[:, :, None] * gain[fid]).sum(1)
    px = tex[ys, xs].astype(np.float32)
    isor = is_empty(px)
    refpx = (B[:, :, None] * np.nan_to_num(rc[fid], nan=-1)).sum(1)
    newpx = np.clip(px * G, 0, 255)
    fill = isor & (refpx.min(1) >= 0)
    newpx[fill] = refpx[fill]
    newpx[isor & ~fill] = 175
    tex[ys, xs] = newpx.astype(np.uint8)
    # грани без кадра у OpenMVS указывают в одну пурпурную точку атласа — убираем их (будут дыры, как у Polycam),
    # а остатки пурпурного в атласе (поля, швы) красим нейтральным серым
    tex[is_empty(tex.astype(np.int16))] = 175
    drop = orange.all(1)
    print("empty faces", int(drop.sum()), flush=True)
    if drop.any():
        # грани без кадра — отдельной сеткой с цветом вершин по эталону (среднее по кадрам), а не дырой
        ef = F[drop]
        col = np.nan_to_num(R, nan=175.0)
        empties.append(trimesh.Trimesh(vertices=g.vertices.copy(), faces=ef, process=False,
                                       vertex_colors=np.c_[np.clip(col, 0, 255).astype(np.uint8), np.full(len(col), 255, np.uint8)]))
        g.update_faces(~drop); g.remove_unreferenced_vertices()
    # сглаженные нормали: просмотрщики, которые не понимают «без освещения» (3dviewer), не рисуют складки на ровных стенах
    import trimesh.smoothing as _sm
    vn = g.vertex_normals.copy()
    adj = g.vertex_neighbors
    for _ in range(25):
        vn = np.array([vn[i] + vn[nb].sum(0) if len(nb) else vn[i] for i, nb in enumerate(adj)])
        vn /= np.maximum(np.linalg.norm(vn, axis=1, keepdims=True), 1e-9)
    g.vertex_normals = vn
    im = Image.fromarray(tex); im.format = 'JPEG'
    g.visual.material.image = im
    print('atlas', gi, f'{len(F)} faces, orange filled {fill.sum()}', f'{time.time() - t0:.0f}s', flush=True)
for e in empties:
    e.remove_unreferenced_vertices()
    sc.add_geometry(e) if hasattr(sc, 'add_geometry') else None
sc.export(out)
# без освещения (как показывает свои сканы Polycam): KHR_materials_unlit во всех материалах GLB
import json as _j, struct as _st
b = open(out, 'rb').read()
jl = _st.unpack('<I', b[12:16])[0]; js = _j.loads(b[20:20 + jl]); rest = b[20 + jl:]
# как у Polycam: не металл (по умолчанию в glTF metallic = 1 — в просмотрщиках без «unlit» стены выходят тёмными пятнами)
js.setdefault('materials', [])
for me in js.get('meshes', []):
    for pr in me['primitives']:
        if 'material' not in pr:                       # сетка с цветом вершин — тоже свой материал
            pr['material'] = len(js['materials']); js['materials'].append({'pbrMetallicRoughness': {}})
for mt in js['materials']:
    mt.setdefault('extensions', {})['KHR_materials_unlit'] = {}
    pr = mt.setdefault('pbrMetallicRoughness', {}); pr['metallicFactor'] = 0.0; pr['roughnessFactor'] = 1.0
    mt['doubleSided'] = False                     # снаружи стены прозрачны — комнату видно сверху и сбоку
js['extensionsUsed'] = sorted(set(js.get('extensionsUsed', []) + ['KHR_materials_unlit']))
nj = _j.dumps(js, separators=(',', ':')).encode(); nj += b' ' * ((4 - len(nj) % 4) % 4)
total = 12 + 8 + len(nj) + len(rest)
open(out, 'wb').write(b[:4] + _st.pack('<I', 2) + _st.pack('<I', total) + _st.pack('<I', len(nj)) + b'JSON' + nj + rest)
print('unlit', len(js.get('materials', [])), 'materials', flush=True)
print('done', f'{time.time() - t0:.0f}s', flush=True)
# по умолчанию — стандартная пометка KHR_materials_unlit (как у Polycam). EMISSIVE=1 — вариант для просмотрщиков,
# которые её не знают и освещают поверхность (3dviewer — пятна по наклону граней): текстура → emissive, свой цвет чёрный
import subprocess, os
if os.environ.get('EMISSIVE'): subprocess.run([sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'emissive.py'), out, out], check=True)
