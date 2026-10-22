"""HD-пакет Fixpoint → текстовая модель COLMAP (камеры и позы, без точек) + сетка для OpenMVS TextureMesh.
py -3.9 to_colmap.py <пакет> <рабочая папка> <сетка.glb>"""
import sys, os, json, shutil, numpy as np, trimesh
d, w, mesh_src = sys.argv[1], sys.argv[2], sys.argv[3]
os.makedirs(w + '/sparse', exist_ok=True)
if os.path.exists(w + '/images'): shutil.rmtree(w + '/images')
shutil.copytree(d + '/images', w + '/images')
m = json.load(open(d + '/transforms.json'))
def quat(R):   # матрица поворота → (w, x, y, z)
    t = np.trace(R)
    if t > 0:
        s = np.sqrt(t + 1) * 2; return [0.25 * s, (R[2, 1] - R[1, 2]) / s, (R[0, 2] - R[2, 0]) / s, (R[1, 0] - R[0, 1]) / s]
    i = int(np.argmax(np.diag(R)))
    if i == 0:
        s = np.sqrt(1 + R[0, 0] - R[1, 1] - R[2, 2]) * 2; return [(R[2, 1] - R[1, 2]) / s, 0.25 * s, (R[0, 1] + R[1, 0]) / s, (R[0, 2] + R[2, 0]) / s]
    if i == 1:
        s = np.sqrt(1 + R[1, 1] - R[0, 0] - R[2, 2]) * 2; return [(R[0, 2] - R[2, 0]) / s, (R[0, 1] + R[1, 0]) / s, 0.25 * s, (R[1, 2] + R[2, 1]) / s]
    s = np.sqrt(1 + R[2, 2] - R[0, 0] - R[1, 1]) * 2; return [(R[1, 0] - R[0, 1]) / s, (R[0, 2] + R[2, 0]) / s, (R[1, 2] + R[2, 1]) / s, 0.25 * s]
cams, imgs = [], []
for k, f in enumerate(m['frames'], 1):
    cams.append(f"{k} PINHOLE {f['w']} {f['h']} {f['fl_x']} {f['fl_y']} {f['cx']} {f['cy']}")
    c2w = np.array(f['transform_matrix']) @ np.diag([1, -1, -1, 1])   # ARKit/OpenGL → OpenCV
    w2c = np.linalg.inv(c2w); R, t = w2c[:3, :3], w2c[:3, 3]
    q = quat(R)
    imgs.append(f"{k} {q[0]} {q[1]} {q[2]} {q[3]} {t[0]} {t[1]} {t[2]} {k} {os.path.basename(f['file_path'])}\n\n")   # вторая строка кадра — его 2D-точки (у нас нет)
open(w + '/sparse/cameras.txt', 'w').write('\n'.join(cams) + '\n')
open(w + '/sparse/images.txt', 'w').write(''.join(imgs))
open(w + '/sparse/points3D.txt', 'w').write('')
lm = trimesh.load(mesh_src)
g = list(lm.geometry.values())[0] if hasattr(lm, 'geometry') else lm
g = trimesh.Trimesh(vertices=g.vertices, faces=g.faces, process=True)   # склеить вершины, без UV
g.export(w + '/mesh.ply')
print('frames', len(m['frames']), 'mesh', len(g.vertices), len(g.faces))
