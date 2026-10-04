import Foundation
import UIKit
import ARKit
import CoreImage
import simd

/// HD-скан: полноразмерные кадры камеры + положение камеры из ARKit → пакет для обучения Gaussian splatting на компьютере.
/// Формат пакета — Nerfstudio (transforms.json + images/), его понимают Brush, Nerfstudio (splatfacto), gsplat, Postshot.
/// Координаты — мир AR-сессии (Y вверх, метры, камера смотрит вдоль −Z, как в OpenGL/Nerfstudio).
final class HDCapture: @unchecked Sendable {   // изменяется только с main; finish — после остановки съёмки
    struct Entry {
        let file: String
        let c2w: simd_float4x4
        let fx: Float, fy: Float, cx: Float, cy: Float
        let w: Int, h: Int
    }

    let dir: URL
    private let imagesDir: URL
    private let queue = DispatchQueue(label: "fixpoint.hd.jpeg", qos: .userInitiated)
    private var entries: [Entry] = []
    private var pending = 0                       // кадров в очереди на JPEG (доступ только с main)
    private var lastPos: simd_float3?
    private var lastFwd: simd_float3?
    private var prevPollT: simd_float4x4?
    let maxFrames = 300   // ≈ 250–350 МБ: хватает на квартиру, Brush на 12 ГБ видеопамяти справляется
    var count: Int { entries.count }
    var last: Entry? { entries.last }

    init?() {
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let stamp = Int(Date().timeIntervalSince1970)
        dir = docs.appendingPathComponent("hd-capture-\(stamp)", isDirectory: true)
        imagesDir = dir.appendingPathComponent("images", isDirectory: true)
        do { try FileManager.default.createDirectory(at: imagesDir, withIntermediateDirectories: true) } catch { return nil }
    }

    /// Вызывается из опроса кадров (main). true — кадр взят.
    func consider(frame: ARFrame, ciContext: CIContext) -> Bool {
        let cam = frame.camera
        guard cam.trackingState == .normal, entries.count < maxFrames, pending < 3 else { return false }
        let T = cam.transform
        let pos = simd_float3(T.columns.3.x, T.columns.3.y, T.columns.3.z)
        let fwd = simd_normalize(-simd_float3(T.columns.2.x, T.columns.2.y, T.columns.2.z))
        // телефон в движении между опросами (0,4 с) — кадр будет смазан, пропускаем
        if let p = prevPollT {
            let pp = simd_float3(p.columns.3.x, p.columns.3.y, p.columns.3.z)
            let pf = simd_normalize(-simd_float3(p.columns.2.x, p.columns.2.y, p.columns.2.z))
            prevPollT = T
            if simd_length(pos - pp) > 0.12 || acos(max(-1, min(1, simd_dot(fwd, pf)))) > 0.15 { return false }
        } else { prevPollT = T; return false }
        // новый ракурс: сдвиг ≥ 15 см или поворот ≥ 10°
        if let lp = lastPos, let lf = lastFwd {
            let moved = simd_length(pos - lp)
            let turned = acos(max(-1, min(1, simd_dot(fwd, lf))))
            if moved < 0.15 && turned < 0.17 { return false }
        }
        let ci = CIImage(cvPixelBuffer: frame.capturedImage)
        guard let cg = ciContext.createCGImage(ci, from: ci.extent) else { return false }   // копия — буфер ARKit не держим
        let K = cam.intrinsics
        let name = String(format: "images/frame_%05ld.jpg", entries.count + 1)
        entries.append(Entry(file: name, c2w: T, fx: K.columns.0.x, fy: K.columns.1.y, cx: K.columns.2.x, cy: K.columns.2.y,
                             w: cg.width, h: cg.height))
        lastPos = pos; lastFwd = fwd
        pending += 1
        let url = dir.appendingPathComponent(name)
        queue.async { [weak self] in
            if let data = UIImage(cgImage: cg).jpegData(compressionQuality: 0.92) { try? data.write(to: url) }
            DispatchQueue.main.async { self?.pending -= 1 }
        }
        return true
    }

    /// Дописывает transforms.json, облако точек и инструкцию, упаковывает в ZIP. Возвращает путь к архиву.
    func finish(pointsPLY: Data?) throws -> URL {
        queue.sync {}   // дождаться записи всех JPEG
        var frames: [[String: Any]] = []
        for e in entries {
            let m = e.c2w
            // transform_matrix — построчно (row-major), как в Nerfstudio
            let rows: [[Float]] = (0..<4).map { r in (0..<4).map { c in m[c][r] } }
            frames.append(["file_path": e.file, "transform_matrix": rows,
                           "fl_x": e.fx, "fl_y": e.fy, "cx": e.cx, "cy": e.cy, "w": e.w, "h": e.h])
        }
        var root: [String: Any] = ["camera_model": "OPENCV", "k1": 0, "k2": 0, "p1": 0, "p2": 0, "frames": frames,
                                   "fixpoint": ["coords": "ARKit world, Y up, meters", "frames": entries.count]]
        if let f = entries.first { root["fl_x"] = f.fx; root["fl_y"] = f.fy; root["cx"] = f.cx; root["cy"] = f.cy; root["w"] = f.w; root["h"] = f.h }
        if let ply = pointsPLY {
            try ply.write(to: dir.appendingPathComponent("points.ply"))
            root["ply_file_path"] = "points.ply"
        }
        let json = try JSONSerialization.data(withJSONObject: root, options: [.prettyPrinted, .sortedKeys])
        try json.write(to: dir.appendingPathComponent("transforms.json"))
        try Data(Self.readme.utf8).write(to: dir.appendingPathComponent("README.txt"))

        let fmt = DateFormatter(); fmt.dateFormat = "yyyy-MM-dd-HHmm"
        let zipURL = dir.deletingLastPathComponent().appendingPathComponent("Fixpoint-HD-\(fmt.string(from: Date())).zip")
        var files = ["transforms.json", "README.txt"] + entries.map { $0.file }
        if pointsPLY != nil { files.append("points.ply") }
        try StoreZip.write(to: zipURL, base: dir, files: files)
        try? FileManager.default.removeItem(at: dir)
        return zipURL
    }

    func discard() { queue.sync {}; try? FileManager.default.removeItem(at: dir) }

    static let readme = """
    Fixpoint — пакет HD-скана для обучения Gaussian splatting на компьютере

    Внутри: images/ (кадры камеры), transforms.json (положение камеры для каждого кадра, формат Nerfstudio),
    points.ply (облако точек лидара для старта обучения).

    Проще всего — Brush (Windows, одна программа, работает на любой видеокарте):
      1. Скачайте Brush: https://github.com/ArthurBrussee/brush/releases
      2. Распакуйте этот архив в папку.
      3. В Brush: Load → выберите папку (или этот zip). Обучение пойдёт само; 20–30 тыс. шагов обычно достаточно.
      4. Export → сохраните .ply.
      5. Перенесите .ply на телефон и в Fixpoint откройте «Ещё → HD-скан → Загрузить результат».

    Альтернатива: Nerfstudio — ns-train splatfacto --data <папка> nerfstudio-data --orientation-method none --center-method none --auto-scale-poses False,
    затем ns-export gaussian-splat. С этими флагами модель останется в координатах скана и сама встанет на план.
    """
}

/// ZIP без сжатия (метод store): JPEG и так сжаты, а писать так быстро и без сторонних библиотек.
enum StoreZip {
    private static let crcTable: [UInt32] = (0..<256).map { i -> UInt32 in
        var c = UInt32(i)
        for _ in 0..<8 { c = (c & 1) != 0 ? 0xEDB88320 ^ (c >> 1) : c >> 1 }
        return c
    }
    static func crc32(_ data: Data) -> UInt32 {
        var c: UInt32 = 0xFFFFFFFF
        data.withUnsafeBytes { (buf: UnsafeRawBufferPointer) in
            for b in buf { c = crcTable[Int((c ^ UInt32(b)) & 0xFF)] ^ (c >> 8) }
        }
        return c ^ 0xFFFFFFFF
    }

    static func write(to url: URL, base: URL, files: [String]) throws {
        FileManager.default.createFile(atPath: url.path, contents: nil)
        let fh = try FileHandle(forWritingTo: url)
        defer { try? fh.close() }
        var central = Data()
        var offset: UInt32 = 0
        var n: UInt16 = 0
        func le16(_ v: UInt16) -> Data { withUnsafeBytes(of: v.littleEndian) { Data($0) } }
        func le32(_ v: UInt32) -> Data { withUnsafeBytes(of: v.littleEndian) { Data($0) } }
        for name in files {
            guard let data = try? Data(contentsOf: base.appendingPathComponent(name)) else { continue }
            let nameData = Data(name.utf8)
            let crc = crc32(data)
            let size = UInt32(data.count)
            var local = Data()
            local += le32(0x04034b50); local += le16(20); local += le16(0x0800); local += le16(0)   // версия, флаг UTF-8, store
            local += le16(0); local += le16(0x21)                                                   // время/дата (1980-01-01)
            local += le32(crc); local += le32(size); local += le32(size)
            local += le16(UInt16(nameData.count)); local += le16(0); local += nameData
            fh.write(local); fh.write(data)
            var cd = Data()
            cd += le32(0x02014b50); cd += le16(20); cd += le16(20); cd += le16(0x0800); cd += le16(0)
            cd += le16(0); cd += le16(0x21)
            cd += le32(crc); cd += le32(size); cd += le32(size)
            cd += le16(UInt16(nameData.count)); cd += le16(0); cd += le16(0); cd += le16(0); cd += le16(0)
            cd += le32(0); cd += le32(offset); cd += nameData
            central += cd
            offset += UInt32(local.count) + size
            n += 1
        }
        var end = Data()
        end += le32(0x06054b50); end += le16(0); end += le16(0); end += le16(n); end += le16(n)
        end += le32(UInt32(central.count)); end += le32(offset); end += le16(0)
        fh.write(central); fh.write(end)
    }
}
