import Foundation
import UIKit
import RoomPlan
import simd

/// Пол и потолок из кадров обхода — ровным снимком «сверху» (ортофото).
/// По ходу обхода телефон копит уменьшенные кадры с позой камеры. В конце по каждой комнате сетка точек
/// на плоскости пола (и потолка) в осях AR-сессии: цвет точки — из кадра, где она видна лучше всего
/// (в поле зрения, не по касательной, ближе к центру кадра и к камере). Мебель на пол «проецируется» пятном,
/// но в 3D её всё равно закрывают коробки мебели.

struct OrthoRoom {
    let wallIds: [String]
    let minX: Float, maxX: Float, minZ: Float, maxZ: Float
    let floorY: Float, ceilY: Float
}

struct OrthoInput: @unchecked Sendable {
    let rooms: [OrthoRoom]
    let frames: [KeyFrame]
}

func orthoRooms(_ rooms: [CapturedRoom]) -> [OrthoRoom] {
    var out: [OrthoRoom] = []
    for room in rooms where room.walls.count >= 3 {
        var floorY = Float.greatestFiniteMagnitude, ceilY = -Float.greatestFiniteMagnitude
        var minX = Float.greatestFiniteMagnitude, maxX = -Float.greatestFiniteMagnitude
        var minZ = Float.greatestFiniteMagnitude, maxZ = -Float.greatestFiniteMagnitude
        for w in room.walls {
            let t = w.transform
            let c = simd_float3(t.columns.3.x, t.columns.3.y, t.columns.3.z)
            let hw = w.dimensions.x / 2, hh = w.dimensions.y / 2
            floorY = min(floorY, c.y - hh); ceilY = max(ceilY, c.y + hh)
            let ax = simd_normalize(simd_float3(t.columns.0.x, t.columns.0.y, t.columns.0.z))
            for e in [c - ax * hw, c + ax * hw] { minX = min(minX, e.x); maxX = max(maxX, e.x); minZ = min(minZ, e.z); maxZ = max(maxZ, e.z) }
        }
        out.append(OrthoRoom(wallIds: room.walls.map { $0.identifier.uuidString },
                             minX: minX, maxX: maxX, minZ: minZ, maxZ: maxZ, floorY: floorY, ceilY: ceilY))
    }
    return out
}

/// Ортофото горизонтальной плоскости y = planeY по габариту комнаты. Пиксель (i, j) ↔ точка мира
/// (minX + (i + 0.5) / k, planeY, minZ + (j + 0.5) / k). up = true — нормаль вверх (пол).
func buildOrtho(room: OrthoRoom, frames: [KeyFrame], planeY: Float, up: Bool, base: (UInt8, UInt8, UInt8)) -> (jpeg: Data, w: Int, h: Int, k: Float, filled: Float)? {
    let spanX = room.maxX - room.minX, spanZ = room.maxZ - room.minZ
    guard spanX > 0.5, spanZ > 0.5 else { return nil }
    let k: Float = min(150, 2048 / max(spanX, spanZ))          // пикселей на метр
    let W = Int(spanX * k), H = Int(spanZ * k)
    let n = simd_float3(0, up ? 1 : -1, 0)
    var pix = [UInt8](repeating: 0, count: W * H * 4)
    var filledRows = [Int](repeating: 0, count: H)
    pix.withUnsafeMutableBufferPointer { buf in
        let dst = buf.baseAddress!
        filledRows.withUnsafeMutableBufferPointer { fr in
            let frBase = fr.baseAddress!
            DispatchQueue.concurrentPerform(iterations: H) { j in
                let z = room.minZ + (Float(j) + 0.5) / k
                var filled = 0
                for i in 0..<W {
                    let P = simd_float3(room.minX + (Float(i) + 0.5) / k, planeY, z)
                    var bestScore: Float = -10
                    var bestK = -1
                    var bx: Float = 0, by: Float = 0
                    for (q, kf) in frames.enumerated() {
                        let v: simd_float3 = P - kf.pos
                        let dist = simd_length(v)
                        if dist < 0.3 || dist > 6 { continue }
                        let dir: simd_float3 = v / dist
                        let fwdDot = simd_dot(dir, kf.fwd)
                        if fwdDot < 0.55 { continue }
                        let facing = -simd_dot(dir, n)              // плоскость лицом к камере, не по касательной
                        if facing < 0.25 { continue }
                        let gain: Float = facing * 2 + fwdDot
                        let score: Float = gain - dist * 0.25
                        if score <= bestScore { continue }
                        let pc = kf.transformInv * simd_float4(P.x, P.y, P.z, 1)
                        let zc = -pc.z
                        if zc <= 0.05 { continue }
                        let x = kf.fx * (pc.x / zc) + kf.cx
                        let y = kf.cy - kf.fy * (pc.y / zc)
                        if x < 0.5 || y < 0.5 || x > Float(kf.w) - 1.5 || y > Float(kf.h) - 1.5 { continue }
                        bestScore = score; bestK = q; bx = x; by = y
                    }
                    let o = (j * W + i) * 4
                    if bestK < 0 {
                        dst[o] = base.0; dst[o + 1] = base.1; dst[o + 2] = base.2; dst[o + 3] = 255
                        continue
                    }
                    filled += 1
                    let kf = frames[bestK]
                    let x0 = Int(bx - 0.5), y0 = Int(by - 0.5)
                    let fx = bx - 0.5 - Float(x0), fy = by - 0.5 - Float(y0)
                    kf.rgba.withUnsafeBufferPointer { src in
                        let r0 = (y0 * kf.w + x0) * 4, r1 = r0 + kf.w * 4
                        for ch in 0..<3 {
                            let a = Float(src[r0 + ch]) * (1 - fx) + Float(src[r0 + 4 + ch]) * fx
                            let b = Float(src[r1 + ch]) * (1 - fx) + Float(src[r1 + 4 + ch]) * fx
                            dst[o + ch] = UInt8(max(0, min(255, a * (1 - fy) + b * fy)))
                        }
                    }
                    dst[o + 3] = 255
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
    return (jpeg, W, H, k, filled)
}

/// Пол и потолок всех комнат: [{walls, surface: "f"|"c", jpeg, minX, minZ, k, w, h, filled}].
/// Поверхность, снятая меньше чем на 30% габарита, пропускается (габарит Г-образной комнаты больше её площади).
func buildOrthos(_ input: OrthoInput) -> [[String: Any]] {
    var out: [[String: Any]] = []
    for room in input.rooms {
        let planes: [(String, Float, Bool, (UInt8, UInt8, UInt8))] = [("f", room.floorY, true, (185, 178, 166)),
                                                                      ("c", room.ceilY, false, (233, 229, 221))]
        for (surface, y, up, base) in planes {
            guard let r = buildOrtho(room: room, frames: input.frames, planeY: y, up: up, base: base), r.filled >= 0.3 else { continue }
            out.append(["walls": room.wallIds, "surface": surface, "jpeg": r.jpeg.base64EncodedString(),
                        "minX": room.minX, "minZ": room.minZ, "k": r.k, "w": r.w, "h": r.h, "filled": r.filled])
        }
    }
    return out
}
