import Foundation
import UIKit
import RoomPlan
import simd

/// Автопанорама комнаты из кадров обхода.
/// Кадры снимаются по ходу обхода со всех сторон (уменьшенные, с позой камеры). В конце для каждой комнаты
/// из точки внутри неё «выпускаем» луч на каждый пиксель равнопромежуточной панорамы, находим, куда он
/// попадает (стена RoomPlan, пол или потолок), и берём цвет этой точки из кадра, где она видна лучше всего.
/// Так параллакс от того, что телефон ходил по комнате, на стенах/полу/потолке почти не заметен;
/// мебель и предметы на плоскость не попадают и могут «плыть».

struct PanoPlane {
    let center: simd_float3
    let ax: simd_float3, ay: simd_float3, n: simd_float3   // оси стены и нормаль внутрь комнаты
    let hw: Float, hh: Float
}

struct PanoRoom {
    let wallIds: [String]
    let walls: [PanoPlane]
    let eye: simd_float3          // откуда «снята» панорама
    let floorY: Float, ceilY: Float
}

struct PanoInput: @unchecked Sendable {
    let rooms: [PanoRoom]
    let frames: [KeyFrame]
}

/// Комнаты RoomPlan → геометрия для панорамы. Точка съёмки — ближайшая к центру комнаты позиция телефона
/// (реальная точка внутри комнаты, в том числе в Г-образной), высота — медиана высоты телефона.
func panoRooms(_ rooms: [CapturedRoom], frames: [KeyFrame]) -> [PanoRoom] {
    var out: [PanoRoom] = []
    for room in rooms where room.walls.count >= 3 {
        var planes: [PanoPlane] = []
        var floorY = Float.greatestFiniteMagnitude, ceilY = -Float.greatestFiniteMagnitude
        var minX = Float.greatestFiniteMagnitude, maxX = -Float.greatestFiniteMagnitude
        var minZ = Float.greatestFiniteMagnitude, maxZ = -Float.greatestFiniteMagnitude
        var sum = simd_float3(0, 0, 0)
        for w in room.walls {
            let t = w.transform
            let c = simd_float3(t.columns.3.x, t.columns.3.y, t.columns.3.z)
            let hw = w.dimensions.x / 2, hh = w.dimensions.y / 2
            floorY = min(floorY, c.y - hh); ceilY = max(ceilY, c.y + hh)
            let ax = simd_normalize(simd_float3(t.columns.0.x, t.columns.0.y, t.columns.0.z))
            for e in [c - ax * hw, c + ax * hw] { minX = min(minX, e.x); maxX = max(maxX, e.x); minZ = min(minZ, e.z); maxZ = max(maxZ, e.z) }
            sum += c
        }
        let mid = sum / Float(room.walls.count)
        for w in room.walls {
            let t = w.transform
            let c = simd_float3(t.columns.3.x, t.columns.3.y, t.columns.3.z)
            let ax = simd_normalize(simd_float3(t.columns.0.x, t.columns.0.y, t.columns.0.z))
            let ay = simd_normalize(simd_float3(t.columns.1.x, t.columns.1.y, t.columns.1.z))
            var n = simd_normalize(simd_float3(t.columns.2.x, t.columns.2.y, t.columns.2.z))
            if simd_dot(n, mid - c) < 0 { n = -n }
            planes.append(PanoPlane(center: c, ax: ax, ay: ay, n: n, hw: w.dimensions.x / 2, hh: w.dimensions.y / 2))
        }
        // кадры, снятые внутри габарита комнаты
        let inside = frames.filter { $0.pos.x > minX && $0.pos.x < maxX && $0.pos.z > minZ && $0.pos.z < maxZ }
        guard inside.count >= 4 else { continue }
        let ys = inside.map { $0.pos.y }.sorted()
        let eyeY = ys[ys.count / 2]
        let target = simd_float2(mid.x, mid.z)
        let near = inside.min { simd_length(simd_float2($0.pos.x, $0.pos.z) - target) < simd_length(simd_float2($1.pos.x, $1.pos.z) - target) }!
        out.append(PanoRoom(wallIds: room.walls.map { $0.identifier.uuidString }, walls: planes,
                            eye: simd_float3(near.pos.x, eyeY, near.pos.z), floorY: floorY, ceilY: ceilY))
    }
    return out
}

/// Равнопромежуточная панорама W×2W/2 → JPEG. Столбец u ↔ азимут мира α = atan2(z, x): u = (α + π/2) / 2π
/// (так её разворачивает 3D-тур; поворот к схеме — сдвигом столбцов в JS). Строка 0 — зенит.
func buildPanorama(room: PanoRoom, frames: [KeyFrame], width W: Int = 2048) -> (jpeg: Data, filled: Float)? {
    let H = W / 2
    var pix = [UInt8](repeating: 0, count: W * H * 4)
    var filledRows = [Int](repeating: 0, count: H)
    let C = room.eye
    // штраф за то, что кадр снят далеко от точки панорамы (меньше параллакса на предметах) — один раз на кадр
    let farPenalty: [Float] = frames.map { simd_length($0.pos - C) * 0.15 }
    pix.withUnsafeMutableBufferPointer { buf in
        let base = buf.baseAddress!
        filledRows.withUnsafeMutableBufferPointer { fr in
            let frBase = fr.baseAddress!
            DispatchQueue.concurrentPerform(iterations: H) { j in
                let theta = Float.pi * (Float(j) + 0.5) / Float(H)
                let st = sin(theta), ct = cos(theta)
                var filled = 0
                for i in 0..<W {
                    let alpha = 2 * Float.pi * (Float(i) + 0.5) / Float(W) - Float.pi / 2
                    let d = simd_float3(st * cos(alpha), ct, st * sin(alpha))
                    // куда попадает луч: ближайшая стена / пол / потолок
                    var tBest = Float.greatestFiniteMagnitude
                    var nBest = -d
                    for p in room.walls {
                        let den = simd_dot(d, p.n)
                        if den > -1e-4 { continue }                       // стена должна смотреть на нас
                        let t = simd_dot(p.center - C, p.n) / den
                        if t <= 0.05 || t >= tBest { continue }
                        let hit: simd_float3 = C + d * t
                        let l: simd_float3 = hit - p.center
                        if abs(simd_dot(l, p.ax)) > p.hw + 0.03 || abs(simd_dot(l, p.ay)) > p.hh + 0.03 { continue }
                        tBest = t; nBest = p.n
                    }
                    if d.y < -1e-4 { let t = (room.floorY - C.y) / d.y; if t > 0 && t < tBest { tBest = t; nBest = simd_float3(0, 1, 0) } }
                    if d.y > 1e-4 { let t = (room.ceilY - C.y) / d.y; if t > 0 && t < tBest { tBest = t; nBest = simd_float3(0, -1, 0) } }
                    if tBest == Float.greatestFiniteMagnitude { tBest = 3 }
                    let P = C + d * tBest
                    // лучший кадр: точка в поле зрения, поверхность к камере лицом, ближе к центру кадра и ближе к точке
                    var bestScore: Float = -10
                    var bestK = -1
                    var bx: Float = 0, by: Float = 0
                    for (k, kf) in frames.enumerated() {
                        let v = P - kf.pos
                        let dist = simd_length(v)
                        if dist < 0.2 || dist > 7 { continue }
                        let dir = v / dist
                        let fwdDot = simd_dot(dir, kf.fwd)
                        if fwdDot < 0.55 { continue }
                        let facing = -simd_dot(dir, nBest)
                        if facing < 0.08 { continue }
                        let gain: Float = fwdDot * 1.5 + facing
                        let score: Float = gain - dist * 0.12 - farPenalty[k]
                        if score <= bestScore { continue }
                        let pc = kf.transformInv * simd_float4(P.x, P.y, P.z, 1)
                        let z = -pc.z
                        if z <= 0.05 { continue }
                        let x = kf.fx * (pc.x / z) + kf.cx
                        let y = kf.cy - kf.fy * (pc.y / z)
                        if x < 0.5 || y < 0.5 || x > Float(kf.w) - 1.5 || y > Float(kf.h) - 1.5 { continue }
                        bestScore = score; bestK = k; bx = x; by = y
                    }
                    let o = (j * W + i) * 4
                    if bestK < 0 {
                        base[o] = 200; base[o + 1] = 200; base[o + 2] = 200; base[o + 3] = 255
                        continue
                    }
                    filled += 1
                    // билинейная выборка
                    let kf = frames[bestK]
                    let x0 = Int(bx - 0.5), y0 = Int(by - 0.5)
                    let fx = bx - 0.5 - Float(x0), fy = by - 0.5 - Float(y0)
                    kf.rgba.withUnsafeBufferPointer { src in
                        let r0 = (y0 * kf.w + x0) * 4, r1 = r0 + kf.w * 4
                        for ch in 0..<3 {
                            let a = Float(src[r0 + ch]) * (1 - fx) + Float(src[r0 + 4 + ch]) * fx
                            let b = Float(src[r1 + ch]) * (1 - fx) + Float(src[r1 + 4 + ch]) * fx
                            base[o + ch] = UInt8(max(0, min(255, a * (1 - fy) + b * fy)))
                        }
                    }
                    base[o + 3] = 255
                }
                frBase[j] = filled
            }
        }
    }
    let filled = Float(filledRows.reduce(0, +)) / Float(W * H)
    let cs = CGColorSpaceCreateDeviceRGB()
    guard let provider = CGDataProvider(data: Data(pix) as CFData),
          let cg = CGImage(width: W, height: H, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: W * 4, space: cs,
                           bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue),
                           provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent),
          let jpeg = UIImage(cgImage: cg).jpegData(compressionQuality: 0.85) else { return nil }
    return (jpeg, filled)
}

/// Все панорамы обхода: [{walls: [id стен комнаты], jpeg, filled}] — комнаты, где снято меньше 35% сферы, пропускаем.
func buildPanoramas(_ input: PanoInput) -> [[String: Any]] {
    var out: [[String: Any]] = []
    for room in input.rooms {
        guard let r = buildPanorama(room: room, frames: input.frames), r.filled >= 0.35 else { continue }
        out.append(["walls": room.wallIds, "jpeg": r.jpeg.base64EncodedString(), "filled": r.filled])
    }
    return out
}
