import sys, numpy as np, trimesh, open3d as o3d
def stats(path, name):
    sc = trimesh.load(path, force='scene'); m = trimesh.util.concatenate([g.copy().apply_transform(sc.graph[n][0]) for n in sc.graph.nodes_geometry for g in [sc.geometry[sc.graph[n][1]]]])
    V, F = m.vertices, m.faces
    el = np.linalg.norm(V[m.edges_unique[:,0]] - V[m.edges_unique[:,1]], axis=1)
    pc = o3d.geometry.PointCloud(o3d.utility.Vector3dVector(V))
    (a,b,c,d), inl = pc.segment_plane(0.03, 3, 2000)
    n = np.array([a,b,c]); dist = np.abs(V[inl] @ n + d)
    fn = m.face_normals; fc = m.triangles_center
    onp = np.abs(fc @ n + d) < 0.02
    ang = np.degrees(np.arccos(np.clip(np.abs(fn[onp] @ n), 0, 1)))
    print(f'{name}: faces {len(F)}, edge median {np.median(el)*100:.1f} cm, plane {len(inl)} verts, dev median {np.median(dist)*1000:.1f} mm p90 {np.percentile(dist,90)*1000:.1f} mm, face tilt median {np.median(ang):.1f} p90 {np.percentile(ang,90):.1f} deg', flush=True)
for p in sys.argv[1:]:
    stats(p, p.split('/')[-1])
