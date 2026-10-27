import Foundation
import simd

/// Сетка из глубины лидара оставленных кадров (2026-10-27, «делаем как на компе»): вместо сетки ARKit (5–10 см, для AR —
/// на тонких и блестящих предметах «мятая фольга») — своя, как make_mesh.py на компьютере. Порт tools/hdmesh/depth_mesher.py
/// (эталон проверен на пакете 1614: совпадает с Open3D). Шаги:
/// 1) TSDF в разреженных блоках 8³ (вокс 2 см для LiDAR-скана, 3 см для обхода; усечение 3 вокселя; глубина 0,1–4,5 м);
/// 2) Surface Nets: вершина — в ячейке со сменой знака (среднее пересечений рёбер), на каждое ребро решётки со сменой знака — квад;
///    нормали — в сторону свободного пространства (к камере), как требует выбор кадров TextureBuilder;
/// 3) мелкие связные куски (< max(2000, 1% крупнейшего)) прочь; 4) Taubin 5 (λ 0,5 / μ −0,53);
/// 5) большие плоскости (стены, пол, потолок, столешницы) сглаживаются сильно — порт tools/hdmesh/smooth_planes.py.
enum DepthMesher {
    struct Mesh { var V: [simd_float3]; var F: [SIMD3<Int32>] }

    static let B: Int32 = 8                 // сторона блока в вокселях
    static let maxBlocks = 40_000           // ≈ 160 МБ (tsdf + вес Float); больше — не выделяем (память телефона)

    /// nil — не из чего (нет кадров с глубиной или пустая поверхность). progress — 0…1, не на главном потоке.
    static func build(frames: [TexFrame], voxel: Float, progress: ((Float) -> Void)? = nil) -> Mesh? {
        let tr = 3 * voxel, dMin: Float = 0.1, dMax: Float = 4.5
        let withDepth = frames.filter { $0.depth != nil }
        guard !withDepth.isEmpty else { return nil }
        var index: [SIMD3<Int32>: Int] = [:]          // блок → номер
        var keys: [SIMD3<Int32>] = []
        var tsdf: [Float] = [], wgt: [Float] = []
        let n3 = Int(B * B * B)
        let bSize = voxel * Float(B)

        // ---------- 1. интеграция ----------
        for (fi, f) in withDepth.enumerated() {
            guard let dep = TextureBuilder.loadDepth(f.depth) else { continue }
            let w = dep.w, h = dep.h
            let kd = Float(w) / Float(f.dW)
            let fx = f.dfx * kd, fy = f.dfy * kd, cx = f.dcx * kd, cy = f.dcy * kd
            let c2w = f.dc2w, w2c = f.dc2w.inverse
            let org = simd_float3(c2w.columns.3.x, c2w.columns.3.y, c2w.columns.3.z)
            // блоки около точек глубины этого кадра (точка и ± усечение вдоль луча)
            var touched = Set<SIMD3<Int32>>()
            var y = 0
            while y < h {
                var x = 0
                while x < w {
                    let d = Float(dep.mm[y * w + x]) / 1000
                    if d > dMin && d < dMax {
                        let pc = simd_float4((Float(x) + 0.5 - cx) / fx * d, -(Float(y) + 0.5 - cy) / fy * d, -d, 1)
                        let pw4 = c2w * pc
                        let p = simd_float3(pw4.x, pw4.y, pw4.z)
                        let dir = simd_normalize(p - org)
                        for s in [-tr, 0, tr] {
                            let q = (p + dir * s) / bSize
                            touched.insert(SIMD3(Int32(q.x.rounded(.down)), Int32(q.y.rounded(.down)), Int32(q.z.rounded(.down))))
                        }
                    }
                    x += 2
                }
                y += 2
            }
            for k in touched where index[k] == nil {
                guard keys.count < maxBlocks else { break }
                index[k] = keys.count; keys.append(k)
                tsdf.append(contentsOf: repeatElement(1, count: n3)); wgt.append(contentsOf: repeatElement(0, count: n3))
            }
            // каждый воксель затронутых блоков: проекция в карту глубины, sdf = D − z по оси взгляда
            dep.mm.withUnsafeBufferPointer { mm in
                tsdf.withUnsafeMutableBufferPointer { T in
                    wgt.withUnsafeMutableBufferPointer { Wt in
                        for k in touched {
                            guard let bi = index[k] else { continue }
                            let base = bi * n3
                            for lz in 0..<B { for ly in 0..<B { for lx in 0..<B {
                                let g = k &* B &+ SIMD3(lx, ly, lz)
                                let pw = simd_float4(Float(g.x) * voxel, Float(g.y) * voxel, Float(g.z) * voxel, 1)
                                let pc = w2c * pw
                                let z = -pc.z
                                if z < dMin { continue }
                                let u = Int((fx * pc.x / z + cx).rounded(.down)), v = Int((-fy * pc.y / z + cy).rounded(.down))
                                if u < 0 || v < 0 || u >= w || v >= h { continue }
                                let D = Float(mm[v * w + u]) / 1000
                                if D < dMin || D > dMax { continue }
                                let sdf = D - z
                                if sdf < -tr { continue }
                                let t = min(1, sdf / tr)
                                let i = base + Int((lz * B + ly) * B + lx)
                                let wo = Wt[i]
                                T[i] = (T[i] * wo + t) / (wo + 1); Wt[i] = wo + 1
                            } } }
                        }
                    }
                }
            }
            progress?(0.6 * Float(fi + 1) / Float(withDepth.count))
        }
        guard !keys.isEmpty else { return nil }

        // значение узла решётки g (глобальный номер вокселя); вес 0 — не наблюдался
        func node(_ g: SIMD3<Int32>) -> (s: Float, w: Float) {
            let k = SIMD3(g.x >> 3, g.y >> 3, g.z >> 3)          // B = 8: сдвиг = деление с округлением вниз (и для отрицательных)
            guard let bi = index[k] else { return (1, 0) }
            let l = g & SIMD3(repeating: 7)
            let i = bi * n3 + Int((l.z * B + l.y) * B + l.x)
            return (tsdf[i], wgt[i])
        }

        // ---------- 2. Surface Nets ----------
        let c8: [SIMD3<Int32>] = [SIMD3(0,0,0), SIMD3(1,0,0), SIMD3(0,1,0), SIMD3(1,1,0), SIMD3(0,0,1), SIMD3(1,0,1), SIMD3(0,1,1), SIMD3(1,1,1)]
        var edges: [(Int, Int)] = []
        for p in 0..<8 { for q in (p + 1)..<8 {
            let d = c8[q] &- c8[p]
            if abs(d.x) + abs(d.y) + abs(d.z) == 1 { edges.append((p, q)) }
        } }
        var cellVid: [SIMD3<Int32>: Int32] = [:]
        var V: [simd_float3] = []
        var s = [Float](repeating: 0, count: 8)
        for k in keys {
            for lz in 0..<B { for ly in 0..<B { for lx in 0..<B {
                let g = k &* B &+ SIMD3(lx, ly, lz)
                var ok = true, neg = 0
                for c in 0..<8 {
                    let nd = node(g &+ c8[c])
                    if nd.w <= 0 { ok = false; break }
                    s[c] = nd.s; if nd.s < 0 { neg += 1 }
                }
                if !ok || neg == 0 || neg == 8 { continue }
                var acc = simd_float3.zero; var cnt: Float = 0
                for (p, q) in edges where (s[p] < 0) != (s[q] < 0) {
                    let t = s[p] / (s[p] - s[q])
                    let pp = simd_float3(Float(c8[p].x), Float(c8[p].y), Float(c8[p].z))
                    let qq = simd_float3(Float(c8[q].x), Float(c8[q].y), Float(c8[q].z))
                    acc += pp + t * (qq - pp); cnt += 1
                }
                let gl = simd_float3(Float(g.x), Float(g.y), Float(g.z)) + acc / cnt
                cellVid[g] = Int32(V.count)
                V.append(gl * voxel)
            } } }
        }
        progress?(0.7)
        var F: [SIMD3<Int32>] = []
        let ax3: [SIMD3<Int32>] = [SIMD3(1,0,0), SIMD3(0,1,0), SIMD3(0,0,1)]
        for k in keys {
            for lz in 0..<B { for ly in 0..<B { for lx in 0..<B {
                let g = k &* B &+ SIMD3(lx, ly, lz)
                let a = node(g)
                if a.w <= 0 { continue }
                for ax in 0..<3 {
                    let b = node(g &+ ax3[ax])
                    if b.w <= 0 || (a.s < 0) == (b.s < 0) { continue }
                    let o1 = ax3[(ax + 1) % 3], o2 = ax3[(ax + 2) % 3]
                    guard let q0 = cellVid[g], let q1 = cellVid[g &- o1], let q2 = cellVid[g &- o1 &- o2], let q3 = cellVid[g &- o2] else { continue }
                    // внутри (−) у начала ребра → поверхность смотрит в +ax; (q0,q1,q2) даёт нормаль o1 × o2 = +ax
                    if a.s < 0 { F.append(SIMD3(q0, q1, q2)); F.append(SIMD3(q0, q2, q3)) }
                    else { F.append(SIMD3(q0, q2, q1)); F.append(SIMD3(q0, q3, q2)) }
                }
            } } }
        }
        index = [:]; tsdf = []; wgt = []; cellVid = [:]     // объём больше не нужен — память
        guard !F.isEmpty else { return nil }
        progress?(0.8)

        // ---------- 3. мелкие связные куски прочь ----------
        var par = [Int32](0..<Int32(V.count))
        func find(_ x: Int32) -> Int32 {
            var x = x
            while par[Int(x)] != x { par[Int(x)] = par[Int(par[Int(x)])]; x = par[Int(x)] }
            return x
        }
        for f in F {
            let ra = find(f.x), rb = find(f.y); par[Int(rb)] = ra
            let rc = find(f.z); par[Int(rc)] = ra
        }
        let root = (0..<V.count).map { find(Int32($0)) }
        var compFaces: [Int32: Int] = [:]
        for f in F { compFaces[root[Int(f.x)], default: 0] += 1 }
        let minFaces = max(2000, Int(Double(compFaces.values.max() ?? 0) * 0.01))
        F = F.filter { compFaces[root[Int($0.x)]]! >= minFaces }
        var remap = [Int32](repeating: -1, count: V.count)
        var V2: [simd_float3] = []
        for f in F { for i in [f.x, f.y, f.z] where remap[Int(i)] < 0 { remap[Int(i)] = Int32(V2.count); V2.append(V[Int(i)]) } }
        F = F.map { SIMD3(remap[Int($0.x)], remap[Int($0.y)], remap[Int($0.z)]) }
        V = V2
        guard !F.isEmpty else { return nil }

        // ---------- 4. Taubin 5 ----------
        var nb = [[Int32]](repeating: [], count: V.count)
        func link(_ a: Int32, _ b: Int32) { if !nb[Int(a)].contains(b) { nb[Int(a)].append(b) } }
        for f in F { link(f.x, f.y); link(f.x, f.z); link(f.y, f.x); link(f.y, f.z); link(f.z, f.x); link(f.z, f.y) }
        var avg = [simd_float3](repeating: .zero, count: V.count)
        for _ in 0..<5 {
            for lam: Float in [0.5, -0.53] {
                for i in 0..<V.count {
                    let l = nb[i]
                    if l.isEmpty { avg[i] = V[i]; continue }
                    var s = simd_float3.zero
                    for j in l { s += V[Int(j)] }
                    avg[i] = s / Float(l.count)
                }
                for i in 0..<V.count { V[i] += lam * (avg[i] - V[i]) }
            }
        }
        progress?(0.9)
        smoothPlanes(&V, F: F, nb: nb)
        progress?(1)
        return Mesh(V: V, F: F)
    }

    /// Порт smooth_planes.py (2026-10-27): RANSAC-плоскости по вершинам; вершина «плоская», если близко к плоскости (2 см)
    /// и её нормаль почти совпадает с нормалью плоскости (cos > 0,9) — боковины предметов не попадают; только крупные связные куски;
    /// отступ 2 кольца от края плоской области (рёбра предметов не трогаем); Taubin 40 только по плоским вершинам (ядро — вес 1,
    /// кольцо вокруг ядра — 0,5). На телефоне RANSAC оценивает кандидатов по выборке 2000 вершин (на компьютере — по всем).
    static func smoothPlanes(_ V: inout [simd_float3], F: [SIMD3<Int32>], nb: [[Int32]], iters: Int = 40, dist: Float = 0.02, cosMin: Float = 0.9) {
        let n = V.count
        guard n >= 3000 else { return }
        // нормали вершин — по копии с дополнительным сглаживанием (у шумной сетки свои нормали прыгают)
        var Vs = V
        var tmp = [simd_float3](repeating: .zero, count: n)
        for _ in 0..<5 {
            for lam: Float in [0.5, -0.53] {
                for i in 0..<n {
                    let l = nb[i]
                    if l.isEmpty { tmp[i] = Vs[i]; continue }
                    var s = simd_float3.zero
                    for j in l { s += Vs[Int(j)] }
                    tmp[i] = s / Float(l.count)
                }
                for i in 0..<n { Vs[i] += lam * (tmp[i] - Vs[i]) }
            }
        }
        var N = [simd_float3](repeating: .zero, count: n)
        for f in F {
            let a = Vs[Int(f.x)], b = Vs[Int(f.y)], c = Vs[Int(f.z)]
            let fn = simd_cross(b - a, c - a)
            N[Int(f.x)] += fn; N[Int(f.y)] += fn; N[Int(f.z)] += fn
        }
        for i in 0..<n { let l = simd_length(N[i]); N[i] = l > 1e-12 ? N[i] / l : .zero }

        var flat = [Bool](repeating: false, count: n), free = [Bool](repeating: true, count: n)
        var rng = SystemRandomNumberGenerator()
        for _ in 0..<16 {
            let idx = (0..<n).filter { free[$0] }
            if idx.count < 3000 { break }
            let sample = (0..<min(2000, idx.count)).map { _ in idx[Int.random(in: 0..<idx.count, using: &rng)] }
            var best: (nrm: simd_float3, d: Float, cnt: Int)? = nil
            for _ in 0..<2000 {
                let a = V[idx.randomElement(using: &rng)!], b = V[idx.randomElement(using: &rng)!], c = V[idx.randomElement(using: &rng)!]
                var nn = simd_cross(b - a, c - a); let l = simd_length(nn)
                if l < 1e-9 { continue }
                nn /= l
                let d = -simd_dot(nn, a)
                var cnt = 0
                for j in sample where abs(simd_dot(nn, V[j]) + d) < dist { cnt += 1 }
                if best == nil || cnt > best!.cnt { best = (nn, d, cnt) }
            }
            guard let pl = best else { break }
            let inl = idx.reduce(0) { $0 + (abs(simd_dot(pl.nrm, V[$1]) + pl.d) < dist ? 1 : 0) }
            if Float(inl) < 0.02 * Float(n) { break }
            var cand = [Bool](repeating: false, count: n)
            for j in idx where abs(simd_dot(pl.nrm, V[j]) + pl.d) < dist && abs(simd_dot(N[j], pl.nrm)) > cosMin { cand[j] = true }
            // только крупные связные куски плоскости (случайные совпадения с мебелью — прочь)
            var comp = [Int32](repeating: -1, count: n)
            let minSize = max(500, Int(0.002 * Float(n)))
            for s0 in 0..<n where cand[s0] && comp[s0] < 0 {
                var stack = [Int32(s0)], members: [Int32] = []
                comp[s0] = Int32(s0)
                while let v = stack.popLast() {
                    members.append(v)
                    for u in nb[Int(v)] where cand[Int(u)] && comp[Int(u)] < 0 { comp[Int(u)] = Int32(s0); stack.append(u) }
                }
                if members.count >= minSize { for v in members { flat[Int(v)] = true } }
            }
            for j in 0..<n where cand[j] { free[j] = false }
        }
        // отступ от края: из ядра убираем вершины, у которых в пределах 2 колец есть неплоские
        var core = flat
        for _ in 0..<2 {
            let prev = core
            for i in 0..<n where prev[i] { if nb[i].contains(where: { !prev[Int($0)] }) { core[i] = false } }
        }
        var w = [Float](repeating: 0, count: n)
        var any = false
        for i in 0..<n {
            if core[i] { w[i] = 1; any = true }
            else if flat[i] && nb[i].contains(where: { core[Int($0)] }) { w[i] = 0.5 }
        }
        guard any else { return }
        for _ in 0..<iters {
            for lam: Float in [0.5, -0.53] {
                for i in 0..<n where w[i] > 0 {
                    let l = nb[i]
                    var s = simd_float3.zero
                    for j in l { s += V[Int(j)] }
                    tmp[i] = s / Float(l.count)
                }
                for i in 0..<n where w[i] > 0 { V[i] += lam * w[i] * (tmp[i] - V[i]) }
            }
        }
    }
}
