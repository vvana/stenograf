"""Проверка текстурированной сетки: точки с поверхности с цветом из текстуры → вид с камеры кадра рядом с фото + виды снаружи.
py -3.9 check_textured.py <obj> <пакет> <out.jpg>"""
import sys, json, numpy as np, trimesh
from PIL import Image
obj, d, out = sys.argv[1], sys.argv[2], sys.argv[3]
sc = trimesh.load(obj)
P, C = [], []
for g in (sc.geometry.values() if hasattr(sc, 'geometry') else [sc]):
    tex = np.asarray(g.visual.material.image.convert('RGB'))
    H, W = tex.shape[:2]
    pts, fi = trimesh.sample.sample_surface(g, 3_000_000)
    bary = trimesh.triangles.points_to_barycentric(g.triangles[fi], pts)
    uv = (g.visual.uv[g.faces[fi]] * bary[:, :, None]).sum(1)
    x = np.clip((uv[:, 0] * (W - 1)).astype(int), 0, W - 1); y = np.clip(((1 - uv[:, 1]) * (H - 1)).astype(int), 0, H - 1)
    P.append(pts); C.append(tex[y, x])
P = np.concatenate(P); C = np.concatenate(C)
m = json.load(open(d + '/transforms.json'))
Wr, Hr = 640, 480
def render(c2w_gl, fx, fy, cx, cy, clip_top=None):
    w2c = np.linalg.inv(c2w_gl)
    pts, col = P, C
    if clip_top is not None: k = pts[:, 1] < clip_top; pts, col = pts[k], col[k]
    pc = pts @ w2c[:3, :3].T + w2c[:3, 3]
    z = -pc[:, 2]; ok = z > 0.05
    u = (fx * pc[:, 0] / np.where(ok, z, 1) + cx).astype(int); v = (cy - fy * pc[:, 1] / np.where(ok, z, 1)).astype(int)
    ok &= (u >= 0) & (u < Wr) & (v >= 0) & (v < Hr)
    u, v, z, col = u[ok], v[ok], z[ok], col[ok]
    o = np.argsort(-z); img = np.full((Hr, Wr, 3), 255, np.uint8); img[v[o], u[o]] = col[o]
    return img
rows = []
for fi in (10, 60, 110):
    f = m['frames'][fi]; k = Wr / f['w']
    ph = np.array(Image.open(d + '/' + f['file_path']).convert('RGB').resize((Wr, Hr)))
    rows.append(np.concatenate([ph, render(np.array(f['transform_matrix']), f['fl_x'] * k, f['fl_y'] * k, f['cx'] * k, f['cy'] * k)], 1))
cams = np.array([np.array(f['transform_matrix'])[:3, 3] for f in m['frames']]); c = cams.mean(0)
top = np.percentile(P[:, 1], 97)
def look(eye, at):
    z = eye - at; z /= np.linalg.norm(z); x = np.cross([0, 1, 0], z); x /= np.linalg.norm(x); y = np.cross(z, x)
    M = np.eye(4); M[:3, 0], M[:3, 1], M[:3, 2], M[:3, 3] = x, y, z, eye; return M
outs = [render(look(c + np.array([np.cos(a) * 4.5, 4.0, np.sin(a) * 4.5]), c - np.array([0, 0.8, 0])), 430, 430, Wr / 2, Hr / 2, top - 0.15) for a in (0.6, 3.8)]
rows.append(np.concatenate(outs, 1))
Image.fromarray(np.concatenate(rows, 0)).save(out, quality=88)
print('ok', len(P))
