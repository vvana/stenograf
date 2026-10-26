import Foundation
import ARKit
import ImageIO
import UIKit
import simd

/// Модель «как у Polycam» прямо на телефоне (2026-10-23, решение пользователя «делаем как у поликам»):
/// сетка лидара ARKit (ARMeshAnchor) + HD-кадры с позами и глубиной → GLB с атласом текстуры.
/// Алгоритм проверен прототипом на компьютере (tools/hdmesh/mesh_texture.py, пакет 1648):
/// 1) для каждого треугольника — лучший кадр (виден по глубине лидара этого кадра, прямо, близко, ближе к центру кадра),
///    сглаживание выбора по соседям; 2) атлас: клетка S×S на пару треугольников, треугольник — половина клетки с зазором;
/// 3) растеризация из выбранного кадра; 4) выравнивание яркости по эталону вершин (среднее по всем кадрам, где видна).
/// Кадры читаются с диска по одному — память не растёт с их числом.
extension Notification.Name {
    /// 3D-модель с текстурой собрана в фоне (userInfo: token, texModel / error, texFaces, texSeen, texBytes, seconds)
    static let fixpointTexModel = Notification.Name("fixpointTexModel")
}

/// вход в фоновую задачу (якоря ARKit — классы без Sendable; читаются только на чтение)
struct TexInput: @unchecked Sendable {
    let anchors: [ARMeshAnchor]
    let frames: [TexFrame]
}

struct TexFrame {
    let image: URL
    let depth: URL?
    let c2w: simd_float4x4          // ARKit: камера смотрит вдоль −Z, Y вверх
    let fx: Float, fy: Float, cx: Float, cy: Float, w: Int, h: Int
    let dc2w: simd_float4x4         // поза и интринсики карты глубины (у снимка 12 Мп — свои)
    let dfx: Float, dfy: Float, dcx: Float, dcy: Float, dW: Int
}

enum TextureBuilder {
    static let atlasSize = 4096
    static let longSide = 1536      // кадры для текстуры — до 1536 по длинной стороне

    /// Собрать GLB; nil — нечего (нет сетки или кадров). progress — доля 0…1 (на главном потоке не вызывается).
    static func build(anchors: [ARMeshAnchor], frames: [TexFrame], to url: URL, progress: ((Float) -> Void)? = nil) -> (faces: Int, seen: Int)? {
        // ---------- сетка в мировых координатах ----------
        var V: [simd_float3] = []
        var F: [SIMD3<Int32>] = []
        for a in anchors {
            let g = a.geometry, vs = g.vertices, fs = g.faces
            guard fs.indexCountPerPrimitive == 3 else { continue }
            let base = Int32(V.count)
            let vb = vs.buffer.contents().advanced(by: vs.offset)
            for i in 0..<vs.count {
                let v = vb.advanced(by: i * vs.stride).assumingMemoryBound(to: (Float, Float, Float).self).pointee
                let w = a.transform * simd_float4(v.0, v.1, v.2, 1)
                V.append(simd_float3(w.x, w.y, w.z))
            }
            let fb = fs.buffer.contents()
            for f in 0..<fs.count {
                let o = f * 3 * fs.bytesPerIndex
                if fs.bytesPerIndex == 4 {
                    let p = fb.advanced(by: o).assumingMemoryBound(to: UInt32.self)
                    F.append(SIMD3(base + Int32(p[0]), base + Int32(p[1]), base + Int32(p[2])))
                } else {
                    let p = fb.advanced(by: o).assumingMemoryBound(to: UInt16.self)
                    F.append(SIMD3(base + Int32(p[0]), base + Int32(p[1]), base + Int32(p[2])))
                }
            }
        }
        let nF = F.count, nV = V.count, nI = frames.count
        guard nF > 0, nI > 0 else { return nil }
        var fn = [simd_float3](repeating: .zero, count: nF), fc = [simd_float3](repeating: .zero, count: nF)
        for i in 0..<nF {
            let a = V[Int(F[i].x)], b = V[Int(F[i].y)], c = V[Int(F[i].z)]
            let n = simd_cross(b - a, c - a); let l = simd_length(n)
            fn[i] = l > 1e-12 ? n / l : .zero
            fc[i] = (a + b + c) / 3
        }

        // ---------- 1. оценка кадров: лучшие K на треугольник ----------
        let K = 6
        var topI = [Int32](repeating: -1, count: nF * K), topS = [Float](repeating: 0, count: nF * K)
        for (i, f) in frames.enumerated() {
            guard let dep = loadDepth(f.depth) else { continue }
            let w2c = f.c2w.inverse, dw2c = f.dc2w.inverse
            let kd = Float(dep.w) / Float(f.dW)
            let W = Float(f.w), H = Float(f.h)
            // вершины в кадре (с запасом 2% от края)
            var vin = [Bool](repeating: false, count: nV)
            for j in 0..<nV {
                let p = w2c * simd_float4(V[j], 1); let z = -p.z
                if z <= 0.15 { continue }
                let u = f.fx * p.x / z + f.cx, v = -f.fy * p.y / z + f.cy
                vin[j] = u > 0.02 * W && u < 0.98 * W && v > 0.02 * H && v < 0.98 * H
            }
            for t in 0..<nF {
                let tri = F[t]
                guard vin[Int(tri.x)], vin[Int(tri.y)], vin[Int(tri.z)] else { continue }
                let p = w2c * simd_float4(fc[t], 1); let z = -p.z
                guard z > 0.15, z < 6 else { continue }
                // не загорожено: глубина лидара этого кадра в центре треугольника
                let pd = dw2c * simd_float4(fc[t], 1); let zd = -pd.z
                guard zd > 0.1 else { continue }
                let du = Int(f.dfx * kd * pd.x / zd + f.dcx * kd), dv = Int(-f.dfy * kd * pd.y / zd + f.dcy * kd)
                guard du >= 0, du < dep.w, dv >= 0, dv < dep.h else { continue }
                let dd = Float(dep.mm[dv * dep.w + du]) / 1000
                guard dd > 0, abs(zd - dd) < 0.03 + 0.02 * zd else { continue }
                let viewW = simd_normalize(simd_float3(f.c2w.columns.3.x, f.c2w.columns.3.y, f.c2w.columns.3.z) - fc[t])
                let cosv = simd_dot(fn[t], viewW)
                guard cosv > 0.25 else { continue }
                let u = f.fx * p.x / z + f.cx, v = -f.fy * p.y / z + f.cy
                let r2 = pow((u - W / 2) / (W / 2), 2) + pow((v - H / 2) / (H / 2), 2)
                let s = cosv * cosv * max(0.1, min(1, 1 - 0.5 * r2)) / max(z, 0.5)
                // вставка в top-K
                let o = t * K
                var m = -1; var ms = s
                for k in 0..<K where topS[o + k] < ms { ms = topS[o + k]; m = k }
                if m >= 0 { topS[o + m] = s; topI[o + m] = Int32(i) }
            }
            progress?(0.3 * Float(i + 1) / Float(nI))
        }
        var best = [Int32](repeating: -1, count: nF), bestS = [Float](repeating: 0, count: nF)
        for t in 0..<nF {
            let o = t * K
            for k in 0..<K where topS[o + k] > bestS[t] { bestS[t] = topS[o + k]; best[t] = topI[o + k] }
        }
        func scoreOf(_ t: Int, _ i: Int32) -> Float {
            let o = t * K
            for k in 0..<K where topI[o + k] == i { return topS[o + k] }
            return 0
        }
        // соседи по рёбрам
        var edgeOwner: [Int64: Int32] = [:]; edgeOwner.reserveCapacity(nF * 2)
        var nb = [SIMD3<Int32>](repeating: SIMD3(-1, -1, -1), count: nF)
        func addNb(_ a: Int, _ b: Int32) { for k in 0..<3 where nb[a][k] < 0 { nb[a][k] = b; return } }
        for t in 0..<nF {
            let tri = F[t]
            for (x, y) in [(tri.x, tri.y), (tri.y, tri.z), (tri.z, tri.x)] {
                let key = Int64(min(x, y)) << 32 | Int64(max(x, y))
                if let o = edgeOwner[key] { addNb(t, o); addNb(Int(o), Int32(t)) } else { edgeOwner[key] = Int32(t) }
            }
        }
        // сглаживание выбора: кадр большинства соседей, если он почти так же хорош (≥ 70%)
        for _ in 0..<4 {
            var changed = 0
            for t in 0..<nF where best[t] >= 0 {
                let c = [nb[t].x, nb[t].y, nb[t].z].filter { $0 >= 0 }.map { best[Int($0)] }.filter { $0 >= 0 }
                guard c.count >= 2 else { continue }
                var top: Int32 = -1, cnt = 0
                for x in Set(c) { let n = c.filter { $0 == x }.count; if n > cnt { cnt = n; top = x } }
                if top != best[t] && cnt >= 2 && scoreOf(t, top) >= 0.7 * bestS[t] { best[t] = top; changed += 1 }
            }
            if changed == 0 { break }
        }

        // ---------- 2. атлас ----------
        let N = atlasSize
        let cells = (nF + 1) / 2
        // раскладка по соседству (как в прототипе): порядок — кривая Мортона по центрам (2 см), клетки — Z-порядком в блоках 16×16;
        // иначе мип-уровни при отдалении смешивают краски несвязанных клеток — модель издали «рябит»
        let Bk = 16
        let G = Int(ceil(sqrt(Double(cells)) / Double(Bk))) * Bk
        let S = max(6, N / G)
        func part1by2(_ v: UInt64) -> UInt64 {
            var x = v & 0x1fffff
            x = (x | (x << 32)) & 0x1f00000000ffff
            x = (x | (x << 16)) & 0x1f0000ff0000ff
            x = (x | (x << 8)) & 0x100f00f00f00f00f
            x = (x | (x << 4)) & 0x10c30c30c30c30c3
            x = (x | (x << 2)) & 0x1249249249249249
            return x
        }
        var mnC = simd_float3(repeating: .greatestFiniteMagnitude)
        for c in fc { mnC = simd_min(mnC, c) }
        var codes = [(UInt64, Int)](); codes.reserveCapacity(nF)
        for t in 0..<nF {
            let q = (fc[t] - mnC) / 0.02
            let code = part1by2(UInt64(max(0, q.x))) | (part1by2(UInt64(max(0, q.y))) << 1) | (part1by2(UInt64(max(0, q.z))) << 2)
            codes.append((code, t))
        }
        codes.sort { $0.0 < $1.0 }
        var rank = [Int](repeating: 0, count: nF)
        for (r, ct) in codes.enumerated() { rank[ct.1] = r }
        let T1: [simd_float2] = [simd_float2(1, 1), simd_float2(Float(S) - 2, 1), simd_float2(1, Float(S) - 2)]
        let T2: [simd_float2] = [simd_float2(Float(S) - 1, 2.5), simd_float2(Float(S) - 1, Float(S) - 1), simd_float2(2.5, Float(S) - 1)]
        // шаблон текселей половины клетки: (x, y, барицентрические)
        func template(_ T: [simd_float2], _ own: (Float, Float) -> Bool) -> [(Int, Int, simd_float3)] {
            var out: [(Int, Int, simd_float3)] = []
            let e1 = T[1] - T[0], e2 = T[2] - T[0]
            let det = e1.x * e2.y - e1.y * e2.x
            for y in 0..<S { for x in 0..<S {
                let cx = Float(x) + 0.5, cy = Float(y) + 0.5
                guard own(cx, cy) else { continue }
                let p = simd_float2(cx, cy) - T[0]
                let l1 = (p.x * e2.y - p.y * e2.x) / det, l2 = (e1.x * p.y - e1.y * p.x) / det
                var b = simd_float3(1 - l1 - l2, l1, l2)
                b = simd_clamp(b, simd_float3(repeating: -0.05), simd_float3(repeating: 1.05)); b /= (b.x + b.y + b.z)
                out.append((x, y, b))
            } }
            return out
        }
        let tpl = [template(T1) { $0 + $1 <= Float(S) - 1 + 1e-4 }, template(T2) { $0 + $1 >= Float(S) - 1e-4 }]
        var atlas = [UInt8](repeating: 170, count: N * N * 4)
        for i in stride(from: 3, to: atlas.count, by: 4) { atlas[i] = 255 }
        func cellOrigin(_ t: Int) -> (Int, Int) {
            let c = rank[t] / 2, blk = c / (Bk * Bk), w = c % (Bk * Bk)
            var wx = 0, wy = 0
            for b in 0..<4 { wx |= ((w >> (2 * b)) & 1) << b; wy |= ((w >> (2 * b + 1)) & 1) << b }
            return (((blk % (G / Bk)) * Bk + wx) * S, ((blk / (G / Bk)) * Bk + wy) * S)
        }

        // ---------- 3. растеризация + эталон яркости ----------
        var ref = [simd_float3](repeating: .zero, count: nV), refw = [Float](repeating: 0, count: nV)
        var corner = [simd_float3](repeating: simd_float3(repeating: -1), count: nF * 3)
        var byFrame = [[Int]](repeating: [], count: nI)
        for t in 0..<nF where best[t] >= 0 { byFrame[Int(best[t])].append(t) }
        var visByFrame = [[Int]](repeating: [], count: nI)   // треугольники, где кадр в top-K (для эталона)
        for t in 0..<nF { for k in 0..<K where topI[t * K + k] >= 0 { visByFrame[Int(topI[t * K + k])].append(t) } }
        for (i, f) in frames.enumerated() {
            guard !byFrame[i].isEmpty || !visByFrame[i].isEmpty, let img = loadRGB(f.image, maxSide: longSide) else { continue }
            let k = Float(img.w) / Float(f.w)
            let w2c = f.c2w.inverse
            func proj(_ P: simd_float3) -> simd_float2? {
                let p = w2c * simd_float4(P, 1); let z = -p.z
                if z <= 0.05 { return nil }
                return simd_float2(f.fx * k * p.x / z + f.cx * k, -f.fy * k * p.y / z + f.cy * k)
            }
            // эталон: усреднённый цвет (окно 5×5) в вершинах видимых треугольников, вес — оценка кадра
            var done = Set<Int32>()
            for t in visByFrame[i] {
                let s = scoreOf(t, Int32(i))
                for vi in [F[t].x, F[t].y, F[t].z] where !done.contains(vi) {
                    done.insert(vi)
                    if let q = proj(V[Int(vi)]), let c = img.avg(q.x, q.y, r: 2) { ref[Int(vi)] += s * c; refw[Int(vi)] += s }
                }
            }
            for t in byFrame[i] {
                let tri = [F[t].x, F[t].y, F[t].z]
                for (j, vi) in tri.enumerated() { if let q = proj(V[Int(vi)]), let c = img.avg(q.x, q.y, r: 2) { corner[t * 3 + j] = c } }
                let (ox, oy) = cellOrigin(t)
                let A = V[Int(tri[0])], B = V[Int(tri[1])], C = V[Int(tri[2])]
                for (x, y, b) in tpl[rank[t] % 2] {
                    let P = A * b.x + B * b.y + C * b.z
                    guard let q = proj(P), let c = img.bilinear(q.x, q.y) else { continue }
                    let o = ((oy + y) * N + ox + x) * 4
                    atlas[o] = UInt8(max(0, min(255, c.x))); atlas[o + 1] = UInt8(max(0, min(255, c.y))); atlas[o + 2] = UInt8(max(0, min(255, c.z)))
                }
            }
            progress?(0.3 + 0.6 * Float(i + 1) / Float(nI))
        }

        // ---------- 4. выравнивание яркости; без кадра — эталонный цвет ----------
        var seen = 0
        for t in 0..<nF {
            let tri = [F[t].x, F[t].y, F[t].z]
            let R = tri.map { refw[Int($0)] > 0 ? ref[Int($0)] / refw[Int($0)] : simd_float3(repeating: -1) }
            let (ox, oy) = cellOrigin(t)
            if best[t] >= 0 {
                seen += 1
                var g = [simd_float3](repeating: simd_float3(repeating: 1), count: 3)
                for j in 0..<3 where R[j].x >= 0 && corner[t * 3 + j].x >= 0 {
                    g[j] = simd_clamp((R[j] + 6) / (corner[t * 3 + j] + 6), simd_float3(repeating: 0.5), simd_float3(repeating: 2))
                }
                for (x, y, b) in tpl[rank[t] % 2] {
                    let gg = g[0] * b.x + g[1] * b.y + g[2] * b.z
                    let o = ((oy + y) * N + ox + x) * 4
                    atlas[o] = UInt8(max(0, min(255, Float(atlas[o]) * gg.x)))
                    atlas[o + 1] = UInt8(max(0, min(255, Float(atlas[o + 1]) * gg.y)))
                    atlas[o + 2] = UInt8(max(0, min(255, Float(atlas[o + 2]) * gg.z)))
                }
            } else {
                let C = R.map { $0.x >= 0 ? $0 : simd_float3(repeating: 170) }
                for (x, y, b) in tpl[rank[t] % 2] {
                    let c = C[0] * b.x + C[1] * b.y + C[2] * b.z
                    let o = ((oy + y) * N + ox + x) * 4
                    atlas[o] = UInt8(max(0, min(255, c.x))); atlas[o + 1] = UInt8(max(0, min(255, c.y))); atlas[o + 2] = UInt8(max(0, min(255, c.z)))
                }
            }
        }
        progress?(0.95)

        // ---------- GLB ----------
        guard let jpg = jpegFromRGBA(atlas, w: N, h: N, quality: 0.88) else { return nil }
        var pos = [Float](); pos.reserveCapacity(nF * 9)
        var uv = [Float](); uv.reserveCapacity(nF * 6)
        var mn = simd_float3(repeating: .greatestFiniteMagnitude), mx = simd_float3(repeating: -.greatestFiniteMagnitude)
        for t in 0..<nF {
            let (ox, oy) = cellOrigin(t)
            let T = rank[t] % 2 == 0 ? T1 : T2
            for (j, vi) in [F[t].x, F[t].y, F[t].z].enumerated() {
                let p = V[Int(vi)]; pos += [p.x, p.y, p.z]; mn = simd_min(mn, p); mx = simd_max(mx, p)
                uv += [(Float(ox) + T[j].x) / Float(N), (Float(oy) + T[j].y) / Float(N)]
            }
        }
        let idx = (0..<UInt32(nF * 3)).map { $0 }
        writeGLB(url: url, positions: pos, uvs: uv, indices: idx, jpeg: jpg, minP: mn, maxP: mx)
        progress?(1)
        return (nF, seen)
    }

    // MARK: чтение кадров

    struct RGB {
        let w: Int, h: Int, bytes: [UInt8], bpr: Int, ro: Int, go: Int, bo: Int, bpp: Int
        @inline(__always) func px(_ x: Int, _ y: Int) -> simd_float3 {
            let o = y * bpr + x * bpp
            return simd_float3(Float(bytes[o + ro]), Float(bytes[o + go]), Float(bytes[o + bo]))
        }
        func bilinear(_ u: Float, _ v: Float) -> simd_float3? {
            let fx = u - 0.5, fy = v - 0.5
            guard fx > -1, fy > -1, fx < Float(w), fy < Float(h) else { return nil }
            let x0 = max(0, min(w - 2, Int(floor(fx)))), y0 = max(0, min(h - 2, Int(floor(fy))))
            let ax = max(0, min(1, fx - Float(x0))), ay = max(0, min(1, fy - Float(y0)))
            let top = px(x0, y0) * (1 - ax) + px(x0 + 1, y0) * ax
            let bot = px(x0, y0 + 1) * (1 - ax) + px(x0 + 1, y0 + 1) * ax
            return top * (1 - ay) + bot * ay
        }
        func avg(_ u: Float, _ v: Float, r: Int) -> simd_float3? {
            let cx = Int(u), cy = Int(v)
            guard cx >= 0, cy >= 0, cx < w, cy < h else { return nil }
            var s = simd_float3.zero; var n: Float = 0
            for y in max(0, cy - r)...min(h - 1, cy + r) { for x in max(0, cx - r)...min(w - 1, cx + r) { s += px(x, y); n += 1 } }
            return n > 0 ? s / n : nil
        }
    }

    /// JPEG → уменьшенная копия (без поворота), пиксели напрямую из декодированного изображения (строка 0 — верх).
    static func loadRGB(_ url: URL, maxSide: Int) -> RGB? {
        guard let src = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
        let opts: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceThumbnailMaxPixelSize: maxSide,
                                     kCGImageSourceCreateThumbnailWithTransform: false]
        guard let img = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary) else { return nil }
        return rgb(of: img)
    }

    static func rgb(of img: CGImage) -> RGB? {
        // нестандартный формат — перерисовать в RGBA (через makeImage — порядок строк как у исходного)
        func redraw() -> RGB? {
            let w = img.width, h = img.height
            guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: CGColorSpaceCreateDeviceRGB(),
                                      bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return nil }
            ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
            guard let im2 = ctx.makeImage(), im2.bitsPerComponent == 8, im2.bitsPerPixel == 32,
                  let d = im2.dataProvider?.data as Data? else { return nil }
            return RGB(w: w, h: h, bytes: [UInt8](d), bpr: im2.bytesPerRow, ro: 0, go: 1, bo: 2, bpp: 4)
        }
        guard img.bitsPerComponent == 8, img.bitsPerPixel == 32 || img.bitsPerPixel == 24,
              let d = img.dataProvider?.data as Data? else { return redraw() }
        let bpp = img.bitsPerPixel / 8
        let little = img.bitmapInfo.contains(.byteOrder32Little)
        let a = img.alphaInfo
        let first = a == .first || a == .premultipliedFirst || a == .noneSkipFirst
        let none = a == .none
        var ro = 0, go = 1, bo = 2
        if bpp == 4 {
            switch (little, first) {
            case (false, false): (ro, go, bo) = (0, 1, 2)   // RGBA
            case (false, true): (ro, go, bo) = (1, 2, 3)    // ARGB
            case (true, true): (ro, go, bo) = (2, 1, 0)     // BGRA
            case (true, false): (ro, go, bo) = (3, 2, 1)    // ABGR
            }
        } else if !none { return redraw() }
        return RGB(w: img.width, h: img.height, bytes: [UInt8](d), bpr: img.bytesPerRow, ro: ro, go: go, bo: bo, bpp: bpp)
    }

    /// 16-битный PNG глубины (мм) — сырые значения из декодированного изображения.
    static func loadDepth(_ url: URL?) -> (w: Int, h: Int, mm: [UInt16])? {
        guard let url = url, let src = CGImageSourceCreateWithURL(url as CFURL, nil),
              let img = CGImageSourceCreateImageAtIndex(src, 0, nil), img.bitsPerComponent == 16,
              let d = img.dataProvider?.data as Data? else { return nil }
        let w = img.width, h = img.height, bpr = img.bytesPerRow, step = img.bitsPerPixel / 8
        let little = img.bitmapInfo.contains(.byteOrder16Little)
        var mm = [UInt16](repeating: 0, count: w * h)
        d.withUnsafeBytes { (b: UnsafeRawBufferPointer) in
            for y in 0..<h { for x in 0..<w {
                let o = y * bpr + x * step
                let hi = UInt16(b[o]), lo = UInt16(b[o + 1])
                mm[y * w + x] = little ? (lo << 8 | hi) : (hi << 8 | lo)
            } }
        }
        return (w, h, mm)
    }

    static func jpegFromRGBA(_ rgba: [UInt8], w: Int, h: Int, quality: CGFloat) -> Data? {
        guard let prov = CGDataProvider(data: Data(rgba) as CFData),
              let img = CGImage(width: w, height: h, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: w * 4, space: CGColorSpaceCreateDeviceRGB(),
                                bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue), provider: prov, decode: nil,
                                shouldInterpolate: false, intent: .defaultIntent) else { return nil }
        return UIImage(cgImage: img).jpegData(compressionQuality: quality)
    }

    // MARK: GLB (без освещения, не металл, выборка без мип-карт — приложение включает их само)

    static func writeGLB(url: URL, positions: [Float], uvs: [Float], indices: [UInt32], jpeg: Data, minP: simd_float3, maxP: simd_float3) {
        func bytes<T>(_ a: [T]) -> Data { a.withUnsafeBufferPointer { Data(buffer: $0) } }
        let parts = [bytes(positions), bytes(uvs), bytes(indices), jpeg]
        var bin = Data(); var offs: [Int] = []
        for p in parts { offs.append(bin.count); bin.append(p); while bin.count % 4 != 0 { bin.append(0) } }
        let n = positions.count / 3
        let json: [String: Any] = [
            "asset": ["version": "2.0", "generator": "Fixpoint TextureBuilder"],
            "extensionsUsed": ["KHR_materials_unlit"],
            "scene": 0, "scenes": [["nodes": [0]]], "nodes": [["mesh": 0]],
            "meshes": [["primitives": [["attributes": ["POSITION": 0, "TEXCOORD_0": 1], "indices": 2, "material": 0]]]],
            "materials": [["pbrMetallicRoughness": ["baseColorTexture": ["index": 0], "metallicFactor": 0, "roughnessFactor": 1],
                           "extensions": ["KHR_materials_unlit": [String: Any]()], "doubleSided": false]],
            "textures": [["source": 0, "sampler": 0]], "samplers": [["magFilter": 9729, "minFilter": 9729]],
            "images": [["bufferView": 3, "mimeType": "image/jpeg"]],
            "buffers": [["byteLength": bin.count]],
            "bufferViews": [["buffer": 0, "byteOffset": offs[0], "byteLength": parts[0].count, "target": 34962],
                            ["buffer": 0, "byteOffset": offs[1], "byteLength": parts[1].count, "target": 34962],
                            ["buffer": 0, "byteOffset": offs[2], "byteLength": parts[2].count, "target": 34963],
                            ["buffer": 0, "byteOffset": offs[3], "byteLength": parts[3].count]],
            "accessors": [["bufferView": 0, "componentType": 5126, "count": n, "type": "VEC3",
                           "min": [minP.x, minP.y, minP.z], "max": [maxP.x, maxP.y, maxP.z]],
                          ["bufferView": 1, "componentType": 5126, "count": n, "type": "VEC2"],
                          ["bufferView": 2, "componentType": 5125, "count": indices.count, "type": "SCALAR"]],
        ]
        guard var js = try? JSONSerialization.data(withJSONObject: json) else { return }
        while js.count % 4 != 0 { js.append(0x20) }
        var out = Data()
        func u32(_ v: Int) { var x = UInt32(v).littleEndian; out.append(Data(bytes: &x, count: 4)) }
        u32(0x46546C67); u32(2); u32(12 + 8 + js.count + 8 + bin.count)
        u32(js.count); u32(0x4E4F534A); out.append(js)
        u32(bin.count); u32(0x004E4942); out.append(bin)
        try? out.write(to: url, options: .atomic)
    }
}
