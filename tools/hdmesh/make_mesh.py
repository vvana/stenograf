"""Сетка комнаты из глубины HD-пакета: TSDF 2 см, Taubin 5, ≤ 300 тыс. граней (2026-10-23, пакет 1648: наличники и предметы
держат форму, пилы текстуры на рёбрах почти нет; ровность стен как у 3 см + Taubin 30). Затем smooth_planes: большие плоскости сглажены сильно (PLANES=0 — выключить).
Прежний вариант — VOXEL=0.03 TAUBIN=30 FACES=200000 PLANES=0.
py -3.9 make_mesh.py <пакет> <out.ply>"""
import sys, os, json, numpy as np, open3d as o3d
from PIL import Image
from hdpkg import depth_view
from smooth_planes import smooth_planes
d, out = sys.argv[1], sys.argv[2]
m = json.load(open(d + '/transforms.json'))
VOX = float(os.environ.get('VOXEL', 0.02)); TAU = int(os.environ.get('TAUBIN', 5)); NF = int(os.environ.get('FACES', 300000))
vol = o3d.pipelines.integration.ScalableTSDFVolume(voxel_length=VOX, sdf_trunc=VOX * 3, color_type=o3d.pipelines.integration.TSDFVolumeColorType.RGB8)
for f in m['frames']:
    if not f.get('depth_file_path'): continue
    dep = np.array(Image.open(d + '/' + f['depth_file_path'])).astype(np.uint16); h, w = dep.shape
    col = np.array(Image.open(d + '/' + f['file_path']).reduce(8).convert('RGB').resize((w, h)))
    T, fx, fy, cx, cy, W, _ = depth_view(f); k = w / W
    r = o3d.geometry.RGBDImage.create_from_color_and_depth(o3d.geometry.Image(col), o3d.geometry.Image(dep), depth_scale=1000.0, depth_trunc=4.5, convert_rgb_to_intensity=False)
    vol.integrate(r, o3d.camera.PinholeCameraIntrinsic(w, h, fx * k, fy * k, cx * k, cy * k), np.linalg.inv(T @ np.diag([1, -1, -1, 1])))
mesh = vol.extract_triangle_mesh()
cl, n_tri, _ = mesh.cluster_connected_triangles(); cl = np.asarray(cl); n_tri = np.asarray(n_tri)
mesh.remove_triangles_by_mask(n_tri[cl] < max(2000, n_tri.max() * 0.01)); mesh.remove_unreferenced_vertices()
if TAU: mesh = mesh.filter_smooth_taubin(number_of_iterations=TAU)
if len(mesh.triangles) > NF: mesh = mesh.simplify_quadric_decimation(NF)
# разная детализация (2026-10-23): стены, пол, потолок, столешницы — сильно сглажены, предметы и рельеф — как есть
if os.environ.get('PLANES', '1') != '0': mesh = smooth_planes(mesh)
mesh.compute_vertex_normals()
o3d.io.write_triangle_mesh(out, mesh)
print('mesh', len(mesh.triangles), 'faces')
