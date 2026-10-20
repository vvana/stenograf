import Foundation
import UIKit
import ARKit
import CoreImage
import simd
import AVFoundation
import ImageIO
import UniformTypeIdentifiers

/// HD-скан: полноразмерные кадры камеры + положение камеры из ARKit → пакет для обучения Gaussian splatting на компьютере.
/// Формат пакета — Nerfstudio (transforms.json + images/), его понимают Brush, Nerfstudio (splatfacto), gsplat, Postshot.
/// Координаты — мир AR-сессии (Y вверх, метры, камера смотрит вдоль −Z, как в OpenGL/Nerfstudio).
final class HDCapture: @unchecked Sendable {   // изменяется только с main; finish — после остановки съёмки
    struct Entry {
        let file: String
        let depth: String?                        // depth/frame_NNNNN.png — глубина лидара, мм (16 бит), 0 — нет данных
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
    private var sharpHistory: [Float] = []        // резкость последних кадров — порог «смазан» относительно обычной для этой комнаты
    private(set) var blurRejected = 0
    private(set) var depthFrames = 0
    let maxFrames = 1000  // ≈ 1 ГБ на квартиру (было 300 — пользователь: «300 точно мало»); влезет ли обучение Brush в 12 ГБ видеопамяти — не проверено
    var count: Int { entries.count }
    var last: Entry? { entries.last }

    init?() {
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let stamp = Int(Date().timeIntervalSince1970)
        dir = docs.appendingPathComponent("hd-capture-\(stamp)", isDirectory: true)
        imagesDir = dir.appendingPathComponent("images", isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: imagesDir, withIntermediateDirectories: true)
            try FileManager.default.createDirectory(at: dir.appendingPathComponent("depth", isDirectory: true), withIntermediateDirectories: true)
        } catch { return nil }
    }

    /// Вызывается из опроса кадров (main). true — кадр взят.
    func consider(frame: ARFrame, ciContext: CIContext) -> Bool {
        let cam = frame.camera
        guard cam.trackingState == .normal, entries.count < maxFrames, pending < 3 else { return false }
        let T = cam.transform
        let pos = simd_float3(T.columns.3.x, T.columns.3.y, T.columns.3.z)
        let fwd = simd_normalize(-simd_float3(T.columns.2.x, T.columns.2.y, T.columns.2.z))
        // телефон в движении между опросами (0,4 с) — кадр будет смазан, пропускаем
        // (2026-10-20 строже: было 12 см / 0,15 рад — модель по таким кадрам выходила мутной)
        if let p = prevPollT {
            let pp = simd_float3(p.columns.3.x, p.columns.3.y, p.columns.3.z)
            let pf = simd_normalize(-simd_float3(p.columns.2.x, p.columns.2.y, p.columns.2.z))
            prevPollT = T
            if simd_length(pos - pp) > 0.06 || acos(max(-1, min(1, simd_dot(fwd, pf)))) > 0.08 { return false }
        } else { prevPollT = T; return false }
        // новый ракурс: сдвиг ≥ 15 см или поворот ≥ 10°
        if let lp = lastPos, let lf = lastFwd {
            let moved = simd_length(pos - lp)
            let turned = acos(max(-1, min(1, simd_dot(fwd, lf))))
            if moved < 0.15 && turned < 0.17 { return false }
        }
        // резкость (энергия лапласиана по яркости): заметно ниже обычной для этой съёмки — кадр смазан, пропускаем
        let sharp = Self.sharpness(frame.capturedImage)
        sharpHistory.append(sharp); if sharpHistory.count > 40 { sharpHistory.removeFirst() }
        if sharpHistory.count >= 8 {
            let med = sharpHistory.sorted()[sharpHistory.count / 2]
            if sharp < med * 0.6 { blurRejected += 1; return false }
        }
        let ci = CIImage(cvPixelBuffer: frame.capturedImage)
        guard let cg = ciContext.createCGImage(ci, from: ci.extent) else { return false }   // копия — буфер ARKit не держим
        let K = cam.intrinsics
        let n = entries.count + 1
        let name = String(format: "images/frame_%05ld.jpg", n)
        // глубина лидара для кадра (та же ориентация, что у кадра; Nerfstudio растянет её до размера кадра)
        let depthName = String(format: "depth/frame_%05ld.png", n)
        let depthPNG = Self.depthPNG(frame)
        if depthPNG != nil { depthFrames += 1 }
        entries.append(Entry(file: name, depth: depthPNG != nil ? depthName : nil, c2w: T, fx: K.columns.0.x, fy: K.columns.1.y, cx: K.columns.2.x, cy: K.columns.2.y,
                             w: cg.width, h: cg.height))
        lastPos = pos; lastFwd = fwd
        pending += 1
        let url = dir.appendingPathComponent(name)
        queue.async { [weak self] in
            if let data = UIImage(cgImage: cg).jpegData(compressionQuality: 0.92) { try? data.write(to: url) }
            if let d = depthPNG, let self = self { try? d.write(to: self.dir.appendingPathComponent(depthName)) }
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
            var f: [String: Any] = ["file_path": e.file, "transform_matrix": rows,
                                    "fl_x": e.fx, "fl_y": e.fy, "cx": e.cx, "cy": e.cy, "w": e.w, "h": e.h]
            if let d = e.depth { f["depth_file_path"] = d }
            frames.append(f)
        }
        var root: [String: Any] = ["camera_model": "OPENCV", "k1": 0, "k2": 0, "p1": 0, "p2": 0, "frames": frames,
                                   "fixpoint": ["coords": "ARKit world, Y up, meters", "frames": entries.count, "depthFrames": depthFrames,
                                                "depthUnit": "mm (16-bit PNG, 0 = no data)", "blurRejected": blurRejected]]
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
        var files = ["transforms.json", "README.txt"] + entries.map { $0.file } + entries.compactMap { $0.depth }
        if pointsPLY != nil { files.append("points.ply") }
        try StoreZip.write(to: zipURL, base: dir, files: files)
        try? FileManager.default.removeItem(at: dir)
        return zipURL
    }

    func discard() { queue.sync {}; try? FileManager.default.removeItem(at: dir) }

    /// Резкость кадра: средний квадрат лапласиана яркости (плоскость Y кадра ARKit) по центральной части, шаг 4 px.
    static func sharpness(_ pb: CVPixelBuffer) -> Float {
        CVPixelBufferLockBaseAddress(pb, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(pb, .readOnly) }
        guard CVPixelBufferGetPlaneCount(pb) > 0, let base = CVPixelBufferGetBaseAddressOfPlane(pb, 0) else { return 0 }
        let w = CVPixelBufferGetWidthOfPlane(pb, 0), h = CVPixelBufferGetHeightOfPlane(pb, 0)
        let bpr = CVPixelBufferGetBytesPerRowOfPlane(pb, 0)
        let px = base.assumingMemoryBound(to: UInt8.self)
        var sum: Double = 0; var n = 0
        var y = h / 6
        while y < h - h / 6 {
            var x = w / 6
            let row = px + y * bpr
            while x < w - w / 6 {
                let c = Int(row[x]) * 4
                let l = Int(row[x - 1]) + Int(row[x + 1]) + Int((row - bpr)[x]) + Int((row + bpr)[x])
                let v = Double(c - l)
                sum += v * v; n += 1
                x += 4
            }
            y += 4
        }
        return n > 0 ? Float(sum / Double(n)) : 0
    }

    /// Глубина лидара кадра → 16-битный PNG в миллиметрах; точки с низкой уверенностью — 0 (нет данных).
    /// nil — в кадре нет sceneDepth (сессия RoomPlan могла его не включить).
    static func depthPNG(_ frame: ARFrame) -> Data? {
        guard let sd = frame.sceneDepth ?? frame.smoothedSceneDepth else { return nil }
        let dm = sd.depthMap
        CVPixelBufferLockBaseAddress(dm, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(dm, .readOnly) }
        guard let db = CVPixelBufferGetBaseAddress(dm) else { return nil }
        let w = CVPixelBufferGetWidth(dm), h = CVPixelBufferGetHeight(dm), dbpr = CVPixelBufferGetBytesPerRow(dm)
        var conf: UnsafeMutablePointer<UInt8>? = nil; var cbpr = 0
        if let cm = sd.confidenceMap {
            CVPixelBufferLockBaseAddress(cm, .readOnly)
            conf = CVPixelBufferGetBaseAddress(cm)?.assumingMemoryBound(to: UInt8.self)
            cbpr = CVPixelBufferGetBytesPerRow(cm)
        }
        defer { if let cm = sd.confidenceMap { CVPixelBufferUnlockBaseAddress(cm, .readOnly) } }
        var mm = [UInt16](repeating: 0, count: w * h)
        for y in 0..<h {
            let drow = (db + y * dbpr).assumingMemoryBound(to: Float32.self)
            for x in 0..<w {
                let d = drow[x]
                if let c = conf, c[y * cbpr + x] < UInt8(ARConfidenceLevel.medium.rawValue) { continue }
                if d.isFinite && d > 0.05 && d < 65 { mm[y * w + x] = UInt16(d * 1000) }
            }
        }
        let bytes = mm.withUnsafeBufferPointer { Data(buffer: $0) }
        guard let provider = CGDataProvider(data: bytes as CFData),
              let img = CGImage(width: w, height: h, bitsPerComponent: 16, bitsPerPixel: 16, bytesPerRow: w * 2,
                                space: CGColorSpaceCreateDeviceGray(),
                                bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.none.rawValue | CGBitmapInfo.byteOrder16Little.rawValue),
                                provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent) else { return nil }
        let out = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(out as CFMutableData, UTType.png.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(dest, img, nil)
        guard CGImageDestinationFinalize(dest) else { return nil }
        return out as Data
    }

    /// Экспозиция и баланс белого камеры AR-сессии: на время HD-съёмки — зафиксировать (иначе яркость и цвет
    /// гуляют от кадра к кадру, и обученная модель «мажет»); false — вернуть автомат.
    static func setCameraLocked(_ locked: Bool) {
        guard let dev = ARWorldTrackingConfiguration.configurableCaptureDeviceForPrimaryCamera else { return }
        do {
            try dev.lockForConfiguration()
            if locked {
                if dev.isExposureModeSupported(.locked) { dev.exposureMode = .locked }
                if dev.isWhiteBalanceModeSupported(.locked) { dev.whiteBalanceMode = .locked }
            } else {
                if dev.isExposureModeSupported(.continuousAutoExposure) { dev.exposureMode = .continuousAutoExposure }
                if dev.isWhiteBalanceModeSupported(.continuousAutoWhiteBalance) { dev.whiteBalanceMode = .continuousAutoWhiteBalance }
            }
            dev.unlockForConfiguration()
        } catch { }
    }

    static let readme = """
    Fixpoint — пакет HD-скана для обучения Gaussian splatting на компьютере

    Внутри: images/ (кадры камеры), depth/ (глубина лидара для каждого кадра, 16-битный PNG в миллиметрах, 0 — нет данных),
    transforms.json (положение камеры для каждого кадра, формат Nerfstudio), points.ply (облако точек лидара для старта обучения).

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
