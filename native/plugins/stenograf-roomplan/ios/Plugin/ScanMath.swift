import Foundation
import simd
import QuartzCore
import UIKit

/// Гомография 3×3 по четырём парам точек (DLT + Гаусс). nil — вырожденная конфигурация.
func solveHomography(src: [CGPoint], dst: [CGPoint]) -> [Double]? {
    guard src.count == 4, dst.count == 4 else { return nil }
    var A = [[Double]](repeating: [Double](repeating: 0, count: 8), count: 8)
    var b = [Double](repeating: 0, count: 8)
    for i in 0..<4 {
        let x = Double(src[i].x), y = Double(src[i].y)
        let X = Double(dst[i].x), Y = Double(dst[i].y)
        A[2 * i] = [x, y, 1, 0, 0, 0, -X * x, -X * y]; b[2 * i] = X
        A[2 * i + 1] = [0, 0, 0, x, y, 1, -Y * x, -Y * y]; b[2 * i + 1] = Y
    }
    for c in 0..<8 {
        var p = c
        for r in (c + 1)..<8 where abs(A[r][c]) > abs(A[p][c]) { p = r }
        A.swapAt(c, p); b.swapAt(c, p)
        if abs(A[c][c]) < 1e-12 { return nil }
        for r in 0..<8 where r != c {
            let f = A[r][c] / A[c][c]
            for k in c..<8 { A[r][k] -= f * A[c][k] }
            b[r] -= f * b[c]
        }
    }
    var h = [Double](repeating: 0, count: 9)
    for i in 0..<8 { h[i] = b[i] / A[i][i] }
    h[8] = 1
    return h
}

/// CATransform3D, переводящий прямоугольник слоя (anchorPoint 0,0) в четырёхугольник по гомографии.
func transform3D(fromHomography h: [Double]) -> CATransform3D {
    var t = CATransform3DIdentity
    t.m11 = CGFloat(h[0]); t.m12 = CGFloat(h[3]); t.m14 = CGFloat(h[6])
    t.m21 = CGFloat(h[1]); t.m22 = CGFloat(h[4]); t.m24 = CGFloat(h[7])
    t.m41 = CGFloat(h[2]); t.m42 = CGFloat(h[5]); t.m44 = CGFloat(h[8])
    return t
}

/// Кадр-ключ для раскраски сетки: уменьшенная RGBA-картинка в сенсорной ориентации + положение камеры.
struct KeyFrame {
    let transformInv: simd_float4x4   // world → camera
    let fx: Float, fy: Float, cx: Float, cy: Float   // intrinsics, пересчитанные под уменьшенный размер
    let w: Int, h: Int
    let rgba: [UInt8]
    let pos: simd_float3
    let fwd: simd_float3
}

/// Бинарный PLY (little-endian) с цветом вершин и гранями.
func plyData(positions: [simd_float3], colors: [SIMD3<UInt8>], faces: [UInt32]) -> Data {
    var header = "ply\nformat binary_little_endian 1.0\n"
    header += "element vertex \(positions.count)\n"
    header += "property float x\nproperty float y\nproperty float z\n"
    header += "property uchar red\nproperty uchar green\nproperty uchar blue\n"
    header += "element face \(faces.count / 3)\nproperty list uchar uint vertex_indices\nend_header\n"
    var data = Data(header.utf8)
    data.reserveCapacity(header.utf8.count + positions.count * 15 + (faces.count / 3) * 13)
    for i in 0..<positions.count {
        var p = positions[i]
        withUnsafeBytes(of: &p.x) { data.append(contentsOf: $0) }
        withUnsafeBytes(of: &p.y) { data.append(contentsOf: $0) }
        withUnsafeBytes(of: &p.z) { data.append(contentsOf: $0) }
        let c = colors[i]
        data.append(c.x); data.append(c.y); data.append(c.z)
    }
    var i = 0
    while i + 2 < faces.count {
        data.append(3)
        var a = faces[i], b = faces[i + 1], c = faces[i + 2]
        withUnsafeBytes(of: &a) { data.append(contentsOf: $0) }
        withUnsafeBytes(of: &b) { data.append(contentsOf: $0) }
        withUnsafeBytes(of: &c) { data.append(contentsOf: $0) }
        i += 3
    }
    return data
}

/// RGBA-байты уменьшенной копии CGImage.
func rgbaBytes(of image: CGImage, width: Int, height: Int) -> [UInt8]? {
    var bytes = [UInt8](repeating: 0, count: width * height * 4)
    let cs = CGColorSpaceCreateDeviceRGB()
    let ok: Bool = bytes.withUnsafeMutableBytes { buf -> Bool in
        guard let ctx = CGContext(data: buf.baseAddress, width: width, height: height, bitsPerComponent: 8,
                                  bytesPerRow: width * 4, space: cs,
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return false }
        ctx.interpolationQuality = .medium
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        return true
    }
    return ok ? bytes : nil
}
