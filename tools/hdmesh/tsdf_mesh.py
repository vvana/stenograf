"""HD-пакет Fixpoint → сетка комнаты с фото-текстурой (как лидарный режим Polycam).
1) TSDF: глубина лидара всех кадров усредняется в объёме (шум отдельных кадров гасится) → сетка;
2) чистка: только крупные связные куски, лёгкое сглаживание, упрощение;
3) UV-развёртка + проекция полноразмерных кадров на текстуру.
py -3.9 textured.py <папка пакета> <выход без расширения>"""
import sys, json, time, numpy as np, open3d as o3d, trimesh
from PIL import Image
from hdpkg import depth_view
d, out = sys.argv[1], sys.argv[2]   # out — путь .ply
t0 = time.time()
m = json.load(open(d + '/transforms.json'))
frames = [f for f in m['frames'] if f.get('depth_file_path')]
vol = o3d.pipelines.integration.ScalableTSDFVolume(voxel_length=0.012, sdf_trunc=0.05,
                                                   color_type=o3d.pipelines.integration.TSDFVolumeColorType.RGB8)
for f in frames:
    dep = np.array(Image.open(d + '/' + f['depth_file_path'])).astype(np.uint16)
    h, w = dep.shape
    col = np.array(Image.open(d + '/' + f['file_path']).convert('RGB').resize((w, h)))
    T, fx, fy, cx, cy, W, _ = depth_view(f); k = w / W
    intr = o3d.camera.PinholeCameraIntrinsic(w, h, fx * k, fy * k, cx * k, cy * k)
    r = o3d.geometry.RGBDImage.create_from_color_and_depth(o3d.geometry.Image(col), o3d.geometry.Image(dep),
                                                           depth_scale=1000.0, depth_trunc=4.5, convert_rgb_to_intensity=False)
    c2w = T @ np.diag([1, -1, -1, 1])
    vol.integrate(r, intr, np.linalg.inv(c2w))
mesh = vol.extract_triangle_mesh()
print('tsdf', len(mesh.triangles), f'{time.time() - t0:.0f}s', flush=True)
# крупные связные куски (отлетевшие обрывки — прочь)
cl, n_tri, _ = mesh.cluster_connected_triangles()
cl = np.asarray(cl); n_tri = np.asarray(n_tri)
mesh.remove_triangles_by_mask(n_tri[cl] < max(2000, n_tri.max() * 0.01))
mesh.remove_unreferenced_vertices()
mesh = mesh.filter_smooth_taubin(number_of_iterations=8)
mesh = mesh.simplify_quadric_decimation(400000)
for _ in range(4):   # UVAtlas требует многообразную сетку
    mesh.remove_degenerate_triangles(); mesh.remove_duplicated_triangles(); mesh.remove_duplicated_vertices()
    mesh.remove_non_manifold_edges(); mesh.remove_unreferenced_vertices()
    if mesh.is_edge_manifold() and mesh.is_vertex_manifold(): break
    bad = np.asarray(mesh.get_non_manifold_vertices())
    if len(bad): mesh.remove_vertices_by_index(bad)
print('manifold', mesh.is_edge_manifold(), mesh.is_vertex_manifold(), len(mesh.triangles), flush=True)
mesh.compute_vertex_normals()
print('clean', len(mesh.triangles), f'{time.time() - t0:.0f}s', flush=True)
o3d.io.write_triangle_mesh(out, mesh)
print('saved', len(mesh.triangles), flush=True)
