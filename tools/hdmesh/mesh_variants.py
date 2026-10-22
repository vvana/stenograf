"""Варианты сетки из глубины: размер ячейки TSDF, сглаживание, упрощение -> метрика гладкости (наклон граней на главной плоскости).
py -3.9 mesh_variants.py <пакет>"""
import sys, json, numpy as np, open3d as o3d
from PIL import Image
from hdpkg import depth_view
d = sys.argv[1]
m = json.load(open(d + '/transforms.json'))
frames = [f for f in m['frames'] if f.get('depth_file_path')]
def tsdf(voxel, trunc):
    vol = o3d.pipelines.integration.ScalableTSDFVolume(voxel_length=voxel, sdf_trunc=trunc, color_type=o3d.pipelines.integration.TSDFVolumeColorType.RGB8)
    for f in frames:
        dep = np.array(Image.open(d + '/' + f['depth_file_path'])).astype(np.uint16); h, w = dep.shape
        col = np.array(Image.open(d + '/' + f['file_path']).convert('RGB').resize((w, h)))
        T, fx, fy, cx, cy, W, _ = depth_view(f); k = w / W
        intr = o3d.camera.PinholeCameraIntrinsic(w, h, fx * k, fy * k, cx * k, cy * k)
        r = o3d.geometry.RGBDImage.create_from_color_and_depth(o3d.geometry.Image(col), o3d.geometry.Image(dep), depth_scale=1000.0, depth_trunc=4.5, convert_rgb_to_intensity=False)
        vol.integrate(r, intr, np.linalg.inv(T @ np.diag([1, -1, -1, 1])))
    mesh = vol.extract_triangle_mesh()
    cl, n_tri, _ = mesh.cluster_connected_triangles(); cl = np.asarray(cl); n_tri = np.asarray(n_tri)
    mesh.remove_triangles_by_mask(n_tri[cl] < max(2000, n_tri.max() * 0.01)); mesh.remove_unreferenced_vertices()
    return mesh
def metric(mesh):
    mesh.compute_triangle_normals(); V = np.asarray(mesh.vertices); T = np.asarray(mesh.triangles)
    pc = o3d.geometry.PointCloud(o3d.utility.Vector3dVector(V)); (a, b, c, dd), inl = pc.segment_plane(0.03, 3, 2000)
    n = np.array([a, b, c]); fc = V[T].mean(1); onp = np.abs(fc @ n + dd) < 0.02
    ang = np.degrees(np.arccos(np.clip(np.abs(np.asarray(mesh.triangle_normals)[onp] @ n), 0, 1)))
    return f'faces {len(T)}, tilt median {np.median(ang):.1f} p90 {np.percentile(ang, 90):.1f} deg'
for voxel, trunc in ((0.012, 0.05), (0.02, 0.06), (0.03, 0.09)):
    base = tsdf(voxel, trunc)
    print(f'voxel {voxel*100:.1f} cm raw: {metric(o3d.geometry.TriangleMesh(base))}', flush=True)
    for it in (10, 30, 60):
        s = base.filter_smooth_taubin(number_of_iterations=it)
        s2 = s.simplify_quadric_decimation(200000) if len(s.triangles) > 200000 else s
        print(f'  taubin {it} -> {metric(s2)}', flush=True)
        if voxel == 0.02 and it == 30: o3d.io.write_triangle_mesh('mesh1014_v2t30.ply', s2)
        if voxel == 0.03 and it == 30: o3d.io.write_triangle_mesh('mesh1014_v3t30.ply', s2)
