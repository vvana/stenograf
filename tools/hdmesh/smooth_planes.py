"""Разная детализация: большие плоскости (стены, пол, потолок, столешницы) сглаживаются сильно, предметы и рельеф — нет.
1) RANSAC по вершинам находит плоскости (как flatten.py), но вершина считается «плоской» только если близко к плоскости
   и её нормаль (по слегка сглаженной копии) почти совпадает с нормалью плоскости — боковины наличников, предметы не попадают;
2) от границы плоской области отступаем на несколько колец вершин (рёбра предметов не трогаем);
3) Taubin только по плоским вершинам: шум лидара гасится, крупная форма стены (прогиб) остаётся — не проецируем на идеальную плоскость.
smooth_planes(mesh) -> mesh (Open3D), или py -3.9 smooth_planes.py <in.ply> <out.ply>"""
import sys, numpy as np, open3d as o3d, scipy.sparse as sp


def smooth_planes(mesh, iters=40, ring_margin=2, dist=0.02, cos_min=0.9, verbose=True):
    V = np.asarray(mesh.vertices).copy(); T = np.asarray(mesh.triangles)
    n = len(V)
    # соседство вершин
    i = np.concatenate([T[:, 0], T[:, 1], T[:, 2], T[:, 1], T[:, 2], T[:, 0]])
    j = np.concatenate([T[:, 1], T[:, 2], T[:, 0], T[:, 0], T[:, 1], T[:, 2]])
    A = sp.csr_matrix((np.ones(len(i)), (i, j)), shape=(n, n)); A.data[:] = 1
    deg = np.asarray(A.sum(1)).ravel(); Dinv = sp.diags(1 / np.maximum(deg, 1))
    W = Dinv @ A                                                     # среднее по соседям
    # нормали по копии со слабым сглаживанием — у шумной сетки свои нормали прыгают
    tmp = o3d.geometry.TriangleMesh(mesh).filter_smooth_taubin(number_of_iterations=10); tmp.compute_vertex_normals()
    N = np.asarray(tmp.vertex_normals)
    flat = np.zeros(n, bool); free = np.ones(n, bool); planes = 0
    for _ in range(16):
        idx = np.where(free)[0]
        if len(idx) < 3000: break
        pc = o3d.geometry.PointCloud(o3d.utility.Vector3dVector(V[idx]))
        (a, b, c, d), inl = pc.segment_plane(distance_threshold=dist, ransac_n=3, num_iterations=2000)
        nn = np.array([a, b, c]); s = np.linalg.norm(nn); nn /= s; d /= s
        if len(inl) < 0.02 * n: break
        cand = free & (np.abs(V @ nn + d) < dist) & (np.abs(N @ nn) > cos_min)
        # только крупные связные куски плоскости (случайные совпадения с мебелью — прочь)
        sub = A[cand][:, cand]
        k, lab = sp.csgraph.connected_components(sub, directed=False)
        sizes = np.bincount(lab); keep = sizes[lab] >= max(500, 0.002 * n)
        ci = np.where(cand)[0][keep]
        flat[ci] = True; free[np.where(cand)[0]] = False; planes += 1
        if verbose: print(f'  плоскость {planes}: n={np.round(nn, 2)} вершин {len(ci)}', flush=True)
    # отступ от границы: убираем вершины, у которых в пределах ring_margin колец есть неплоские
    core = flat.copy()
    for _ in range(ring_margin):
        core &= ~(A @ (~core).astype(float) > 0)
    # вес: ядро — 1, кольцо вокруг ядра внутри плоской области — 0,5 (плавный переход к рельефу)
    w = core.astype(float)
    w[flat & ~core & (A @ core.astype(float) > 0)] = 0.5
    lam, mu = 0.5, -0.53
    for _ in range(iters):
        for f in (lam, mu):
            V += (f * w)[:, None] * (W @ V - V)
    out = o3d.geometry.TriangleMesh(o3d.utility.Vector3dVector(V), o3d.utility.Vector3iVector(T))
    if mesh.has_vertex_colors(): out.vertex_colors = mesh.vertex_colors
    out.compute_vertex_normals()
    if verbose: print(f'плоскостей {planes}, сглажено вершин {int((w > 0).sum())} из {n}', flush=True)
    return out


if __name__ == '__main__':
    m = o3d.io.read_triangle_mesh(sys.argv[1])
    o3d.io.write_triangle_mesh(sys.argv[2], smooth_planes(m))
