"""Прижать большие плоскости (стены, пол, потолок) к идеальным: RANSAC по вершинам, вершины ближе 3 см и с нормалью
вдоль плоскости проецируются на неё. py -3.9 flatten.py <in.ply> <out.ply>"""
import sys, numpy as np, open3d as o3d
src, dst = sys.argv[1], sys.argv[2]
m = o3d.io.read_triangle_mesh(src); m.compute_vertex_normals()
V = np.asarray(m.vertices).copy(); N = np.asarray(m.vertex_normals)
free = np.ones(len(V), bool)
planes = 0
for _ in range(12):
    idx = np.where(free)[0]
    if len(idx) < 5000: break
    pc = o3d.geometry.PointCloud(o3d.utility.Vector3dVector(V[idx]))
    (a, b, c, d), inl = pc.segment_plane(distance_threshold=0.02, ransac_n=3, num_iterations=2000)
    n = np.array([a, b, c]); nn = np.linalg.norm(n); n /= nn; d /= nn
    if len(inl) < 0.03 * len(V): break   # плоскости кончились (остальное — мебель)
    dist = V @ n + d
    near = free & (np.abs(dist) < 0.03) & (np.abs(N @ n) > 0.85)
    # только связная крупная часть плоскости — не тащить к стене соседнюю мебель по случайному совпадению
    V[near] -= np.outer(dist[near], n)
    free &= ~near
    planes += 1
    print(f'plane {planes}: n={np.round(n, 2)} vertices {near.sum()}', flush=True)
m.vertices = o3d.utility.Vector3dVector(V)
m.compute_vertex_normals()
o3d.io.write_triangle_mesh(dst, m)
print('flattened', planes, 'planes', flush=True)
