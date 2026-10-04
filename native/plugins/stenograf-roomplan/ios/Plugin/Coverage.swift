import UIKit
import RoomPlan
import ARKit
import simd

/// Покрытие финального / HD-скана: какие участки стен, пола и потолка уже попали в снятые кадры.
/// Поверхности режутся на клетки ~40 см; клетка «снята», если её центр виден в кадре (в поле зрения, 0,3–5 м,
/// не по касательной). Перекрытия предметами не учитываются — это подсказка, а не точный расчёт.

struct CovView {
    let inv: simd_float4x4          // мир → камера
    let fx: Float, fy: Float, cx: Float, cy: Float
    let w: Float, h: Float
    let pos: simd_float3
}

struct CovCell {
    let center: simd_float3
    let corners: [simd_float3]       // 4 угла по порядку
}

struct CovSurface {
    let key: String                  // id для кеша
    let name: String                 // «Комната 2 · стена 3», «потолок»
    let room: Int                    // номер комнаты (1…)
    let isWall: Bool
    let normal: simd_float3
    let cells: [CovCell]
    let a: simd_float3, b: simd_float3   // для стены — концы по низу (мини-карта)
}

private let cellSize: Float = 0.4

private func col3(_ c: simd_float4) -> simd_float3 { simd_float3(c.x, c.y, c.z) }

/// Клетки прямоугольника: центр c, оси u (ширина w) и v (высота h).
private func gridCells(c: simd_float3, u: simd_float3, v: simd_float3, w: Float, h: Float,
                       keep: ((simd_float3) -> Bool)? = nil) -> [CovCell] {
    let nx = max(1, Int(ceil(w / cellSize))), ny = max(1, Int(ceil(h / cellSize)))
    let dx = w / Float(nx), dy = h / Float(ny)
    var out: [CovCell] = []
    for i in 0..<nx {
        for j in 0..<ny {
            let x0: Float = -w / 2 + Float(i) * dx
            let y0: Float = -h / 2 + Float(j) * dy
            let p00: simd_float3 = c + u * x0 + v * y0
            let p10: simd_float3 = p00 + u * dx
            let p11: simd_float3 = p10 + v * dy
            let p01: simd_float3 = p00 + v * dy
            let mid: simd_float3 = (p00 + p11) * 0.5
            if let k = keep, !k(mid) { continue }
            out.append(CovCell(center: mid, corners: [p00, p10, p11, p01]))
        }
    }
    return out
}

@available(iOS 17.0, *)
func coverageSurfaces(room: CapturedRoom, index: Int) -> [CovSurface] {
    var out: [CovSurface] = []
    var floorY: Float = .greatestFiniteMagnitude, topY: Float = -.greatestFiniteMagnitude
    var segs: [(simd_float2, simd_float2)] = []
    var longest: (Float, simd_float3) = (0, simd_float3(1, 0, 0))
    for (k, wall) in room.walls.enumerated() {
        let t = wall.transform
        let c = col3(t.columns.3)
        let u = simd_normalize(col3(t.columns.0))
        let v = simd_normalize(col3(t.columns.1))
        let n = simd_normalize(col3(t.columns.2))
        let w = wall.dimensions.x, h = wall.dimensions.y
        let bottom: simd_float3 = c - v * (h / 2)
        let a: simd_float3 = bottom - u * (w / 2)
        let b: simd_float3 = bottom + u * (w / 2)
        floorY = min(floorY, c.y - h / 2); topY = max(topY, c.y + h / 2)
        segs.append((simd_float2(a.x, a.z), simd_float2(b.x, b.z)))
        if w > longest.0 { longest = (w, u) }
        out.append(CovSurface(key: "\(index):\(wall.identifier.uuidString):\(Int(w * 20))x\(Int(h * 20))",
                              name: "Комната \(index) · стена \(k + 1)", room: index, isWall: true, normal: n,
                              cells: gridCells(c: c, u: u, v: v, w: w, h: h), a: a, b: b))
    }
    guard segs.count >= 3 else { return out }
    // пол и потолок: прямоугольник по стенам вдоль самой длинной стены, клетки только внутри контура
    let ux = simd_normalize(simd_float2(longest.1.x, longest.1.z))
    let vx = simd_float2(-ux.y, ux.x)
    var minU = Float.greatestFiniteMagnitude, maxU = -Float.greatestFiniteMagnitude
    var minV = Float.greatestFiniteMagnitude, maxV = -Float.greatestFiniteMagnitude
    for (p, q) in segs {
        for s in [p, q] {
            let du = simd_dot(s, ux), dv = simd_dot(s, vx)
            minU = min(minU, du); maxU = max(maxU, du); minV = min(minV, dv); maxV = max(maxV, dv)
        }
    }
    let inside: (simd_float3) -> Bool = { m in
        // луч вдоль +X: число пересечений с отрезками стен (порядок стен не важен)
        var hits = 0
        for (p, q) in segs {
            if (p.y > m.z) != (q.y > m.z) {
                let x: Float = p.x + (m.z - p.y) / (q.y - p.y) * (q.x - p.x)
                if x > m.x { hits += 1 }
            }
        }
        return hits % 2 == 1
    }
    let cu: Float = (minU + maxU) / 2, cv: Float = (minV + maxV) / 2
    let c2: simd_float2 = ux * cu + vx * cv
    let u3 = simd_float3(ux.x, 0, ux.y), v3 = simd_float3(vx.x, 0, vx.y)
    let wU = maxU - minU, wV = maxV - minV
    let floorC = simd_float3(c2.x, floorY, c2.y), ceilC = simd_float3(c2.x, topY, c2.y)
    out.append(CovSurface(key: "\(index):floor:\(Int(wU * 20))x\(Int(wV * 20))", name: "Комната \(index) · пол", room: index,
                          isWall: false, normal: simd_float3(0, 1, 0),
                          cells: gridCells(c: floorC, u: u3, v: v3, w: wU, h: wV, keep: inside), a: floorC, b: floorC))
    out.append(CovSurface(key: "\(index):ceil:\(Int(wU * 20))x\(Int(wV * 20))", name: "Комната \(index) · потолок", room: index,
                          isWall: false, normal: simd_float3(0, -1, 0),
                          cells: gridCells(c: ceilC, u: u3, v: v3, w: wU, h: wV, keep: inside), a: ceilC, b: ceilC))
    return out
}

/// Сколько кадров видят каждую клетку.
func coverageCounts(_ s: CovSurface, views: [CovView]) -> [Int] {
    var counts = [Int](repeating: 0, count: s.cells.count)
    for (i, cell) in s.cells.enumerated() {
        var n = 0
        for v in views {
            let d: simd_float3 = v.pos - cell.center
            let dist = simd_length(d)
            if dist < 0.3 || dist > 5 { continue }
            if abs(simd_dot(d / dist, s.normal)) < 0.2 { continue }        // почти по касательной
            let pc = v.inv * simd_float4(cell.center.x, cell.center.y, cell.center.z, 1)
            let z: Float = -pc.z
            if z <= 0.1 { continue }
            let px: Float = v.fx * (pc.x / z) + v.cx
            let py: Float = v.cy - v.fy * (pc.y / z)
            if px < v.w * 0.03 || py < v.h * 0.03 || px > v.w * 0.97 || py > v.h * 0.97 { continue }
            n += 1
        }
        counts[i] = n
    }
    return counts
}

/// Модель покрытия с кешем: пересчёт только при новых кадрах или изменении комнаты.
@available(iOS 17.0, *)
final class CoverageModel {
    var views: [CovView] = []
    let need: Int                                  // сколько кадров на клетку = «хорошо» (HD — 2, обычный — 1)
    private var cache: [String: (Int, [Int])] = [:]

    init(need: Int) { self.need = need }

    func add(_ v: CovView) { views.append(v) }

    func counts(_ s: CovSurface) -> [Int] {
        if let c = cache[s.key], c.0 == views.count { return c.1 }
        let c = coverageCounts(s, views: views)
        cache[s.key] = (views.count, c)
        return c
    }

    /// Доля клеток, снятых достаточным числом кадров.
    func fraction(_ s: CovSurface) -> Float {
        let c = counts(s)
        guard !c.isEmpty else { return 1 }
        return Float(c.filter { $0 >= need }.count) / Float(c.count)
    }
}

/// Подсветка в камере: красный — не снято, жёлтый — мало кадров (HD), зелёный — снято.
@available(iOS 17.0, *)
final class CoverageOverlayView: UIView {
    private let layers: [CAShapeLayer] = (0..<3).map { _ in CAShapeLayer() }
    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        let colors: [UIColor] = [UIColor(red: 0.95, green: 0.25, blue: 0.2, alpha: 0.22),
                                 UIColor(red: 1.0, green: 0.8, blue: 0.1, alpha: 0.26),
                                 UIColor(red: 0.2, green: 0.85, blue: 0.4, alpha: 0.24)]
        for (k, l) in layers.enumerated() {
            l.fillColor = colors[k].cgColor
            l.strokeColor = UIColor(white: 1, alpha: 0.18).cgColor
            l.lineWidth = 0.5
            layer.addSublayer(l)
        }
    }
    required init?(coder: NSCoder) { fatalError() }

    func update(camera cam: ARCamera, surfaces: [CovSurface], model: CoverageModel) {
        let size = bounds.size
        guard size.width > 0 else { return }
        let inv = cam.transform.inverse
        let paths = [UIBezierPath(), UIBezierPath(), UIBezierPath()]
        for s in surfaces {
            let c = model.counts(s)
            for (i, cell) in s.cells.enumerated() {
                var pts: [CGPoint] = []
                var ok = true
                for p in cell.corners {
                    let pc = inv * simd_float4(p.x, p.y, p.z, 1)
                    if -pc.z < 0.15 { ok = false; break }      // угол позади камеры — клетку не рисуем
                    pts.append(cam.projectPoint(p, orientation: .portrait, viewportSize: size))
                }
                guard ok, pts.count == 4 else { continue }
                let level = c[i] >= model.need ? 2 : (c[i] > 0 ? 1 : 0)
                let path = paths[level]
                path.move(to: pts[0]); path.addLine(to: pts[1]); path.addLine(to: pts[2]); path.addLine(to: pts[3]); path.close()
            }
        }
        CATransaction.begin(); CATransaction.setDisableActions(true)
        for (k, l) in layers.enumerated() { l.frame = bounds; l.path = paths[k].cgPath }
        CATransaction.commit()
    }

    func clear() { for l in layers { l.path = nil } }
}

/// Мини-карта сверху: стены всех комнат по цвету покрытия, точки съёмки, где вы сейчас.
@available(iOS 17.0, *)
final class CoverageMapView: UIView {
    var surfaces: [CovSurface] = []
    weak var model: CoverageModel?
    var camPos: simd_float3?
    var camFwd: simd_float3?

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = UIColor(white: 1, alpha: 0.85)
        layer.cornerRadius = 12
        clipsToBounds = true
        isOpaque = false
    }
    required init?(coder: NSCoder) { fatalError() }

    override func draw(_ rect: CGRect) {
        guard let g = UIGraphicsGetCurrentContext(), let model = model else { return }
        let walls = surfaces.filter { $0.isWall }
        var xs: [Float] = [], zs: [Float] = []
        for w in walls { xs += [w.a.x, w.b.x]; zs += [w.a.z, w.b.z] }
        if let p = camPos { xs.append(p.x); zs.append(p.z) }
        guard let minX = xs.min(), let maxX = xs.max(), let minZ = zs.min(), let maxZ = zs.max() else {
            let s = "Обмер стен…" as NSString
            s.draw(at: CGPoint(x: 10, y: rect.midY - 8), withAttributes: [.font: UIFont.systemFont(ofSize: 11), .foregroundColor: UIColor.gray])
            return
        }
        let pad: CGFloat = 12
        let span = CGFloat(max(maxX - minX, maxZ - minZ, 1))
        let k = (min(rect.width, rect.height) - pad * 2) / span
        let ox = rect.midX - CGFloat(minX + maxX) / 2 * k, oy = rect.midY - CGFloat(minZ + maxZ) / 2 * k
        let P = { (x: Float, z: Float) -> CGPoint in CGPoint(x: ox + CGFloat(x) * k, y: oy + CGFloat(z) * k) }
        // точки съёмки
        g.setFillColor(UIColor(white: 0.35, alpha: 0.5).cgColor)
        for v in model.views { let p = P(v.pos.x, v.pos.z); g.fillEllipse(in: CGRect(x: p.x - 1.5, y: p.y - 1.5, width: 3, height: 3)) }
        // стены по покрытию
        g.setLineWidth(4); g.setLineCap(.round)
        for w in walls {
            let f = model.fraction(w)
            let col: UIColor = f >= 0.7 ? UIColor(red: 0.18, green: 0.7, blue: 0.35, alpha: 1)
                : (f >= 0.3 ? UIColor(red: 0.95, green: 0.7, blue: 0.1, alpha: 1) : UIColor(red: 0.9, green: 0.25, blue: 0.2, alpha: 1))
            g.setStrokeColor(col.cgColor)
            g.move(to: P(w.a.x, w.a.z)); g.addLine(to: P(w.b.x, w.b.z)); g.strokePath()
        }
        // вы здесь
        if let p = camPos, let f = camFwd {
            let c = P(p.x, p.z)
            let d = simd_normalize(simd_float2(f.x, f.z))
            let tip = CGPoint(x: c.x + CGFloat(d.x) * 9, y: c.y + CGFloat(d.y) * 9)
            let l = CGPoint(x: c.x - CGFloat(d.y) * 5, y: c.y + CGFloat(d.x) * 5)
            let r = CGPoint(x: c.x + CGFloat(d.y) * 5, y: c.y - CGFloat(d.x) * 5)
            g.setFillColor(UIColor(red: 0.85, green: 0.37, blue: 0.09, alpha: 1).cgColor)
            g.move(to: tip); g.addLine(to: l); g.addLine(to: r); g.closePath(); g.fillPath()
        }
    }
}
