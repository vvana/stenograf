import UIKit
import RoomPlan
import ARKit
import CoreImage
import simd

/// Экран сканирования: RoomCaptureView + наша панель «Отмена / Готово».
/// mode = "measure" — только геометрия; "walk" — плюс автоснимки стен (обход этапа).
@available(iOS 17.0, *)
final class RoomScanViewController: UIViewController, RoomCaptureViewDelegate, RoomCaptureSessionDelegate {

    enum ScanError: LocalizedError {
        case cancelled, failed(String)
        var errorDescription: String? {
            switch self {
            case .cancelled: return "cancelled"
            case .failed(let s): return s
            }
        }
    }

    private let mode: String
    private let maxDim: Int
    private let completion: (Result<[String: Any], Error>) -> Void
    private var finished = false

    private var captureView: RoomCaptureView!
    private var latestRoom: CapturedRoom?
    private var frames: [UUID: [WallFrame]] = [:]   // лучшие кадры по стенам
    private var pollTimer: Timer?
    private var lastTransform: simd_float4x4?
    private let ciContext = CIContext()
    private let statusLabel = UILabel()

    struct WallFrame {
        let score: Float
        let full: Bool
        let camPos: simd_float3
        let jpeg: Data
        let corners: [[Float]]   // 4 × [u, v] в выпрямленном (портретном) кадре: TL, TR, BR, BL для зрителя
        let w: Float
        let h: Float
    }

    init(mode: String, maxDim: Int, completion: @escaping (Result<[String: Any], Error>) -> Void) {
        self.mode = mode
        self.maxDim = maxDim
        self.completion = completion
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        captureView = RoomCaptureView(frame: view.bounds)
        captureView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        captureView.delegate = self
        captureView.captureSession.delegate = self
        view.addSubview(captureView)

        let bar = UIStackView()
        bar.axis = .horizontal
        bar.distribution = .fillEqually
        bar.spacing = 12
        bar.translatesAutoresizingMaskIntoConstraints = false
        let cancel = makeButton("Отмена", color: UIColor(white: 0.2, alpha: 0.85))
        cancel.addTarget(self, action: #selector(cancelTapped), for: .touchUpInside)
        let done = makeButton("Готово", color: UIColor(red: 0.91, green: 0.44, blue: 0.18, alpha: 1))
        done.addTarget(self, action: #selector(doneTapped), for: .touchUpInside)
        bar.addArrangedSubview(cancel)
        bar.addArrangedSubview(done)
        view.addSubview(bar)

        statusLabel.textColor = .white
        statusLabel.font = .systemFont(ofSize: 13, weight: .semibold)
        statusLabel.textAlignment = .center
        statusLabel.numberOfLines = 2
        statusLabel.backgroundColor = UIColor(white: 0, alpha: 0.45)
        statusLabel.layer.cornerRadius = 10
        statusLabel.clipsToBounds = true
        statusLabel.translatesAutoresizingMaskIntoConstraints = false
        statusLabel.text = mode == "walk"
            ? "Обход этапа: медленно ведите телефон вдоль стен — кадры снимутся сами"
            : "Обмер: обойдите комнату вдоль стен, заглядывая в углы"
        view.addSubview(statusLabel)

        NSLayoutConstraint.activate([
            bar.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 16),
            bar.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -16),
            bar.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -12),
            bar.heightAnchor.constraint(equalToConstant: 50),
            statusLabel.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 16),
            statusLabel.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -16),
            statusLabel.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 8),
            statusLabel.heightAnchor.constraint(greaterThanOrEqualToConstant: 40),
        ])
    }

    private func makeButton(_ title: String, color: UIColor) -> UIButton {
        let b = UIButton(type: .system)
        b.setTitle(title, for: .normal)
        b.setTitleColor(.white, for: .normal)
        b.titleLabel?.font = .systemFont(ofSize: 17, weight: .semibold)
        b.backgroundColor = color
        b.layer.cornerRadius = 14
        return b
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        var config = RoomCaptureSession.Configuration()
        config.isCoachingEnabled = true
        captureView.captureSession.run(configuration: config)
        if mode == "walk" {
            pollTimer = Timer.scheduledTimer(withTimeInterval: 0.4, repeats: true) { [weak self] _ in self?.pollFrame() }
        }
    }

    override var prefersStatusBarHidden: Bool { true }
    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { .portrait }

    @objc private func cancelTapped() {
        guard !finished else { return }
        finished = true
        pollTimer?.invalidate()
        captureView.captureSession.stop(pauseARSession: true)
        dismiss(animated: true) { self.completion(.failure(ScanError.cancelled)) }
    }

    @objc private func doneTapped() {
        pollTimer?.invalidate()
        statusLabel.text = "Обрабатываю скан…"
        captureView.captureSession.stop()   // → captureView(shouldPresent:) → captureView(didPresent:)
    }

    // MARK: RoomCaptureViewDelegate

    func captureView(shouldPresent roomDataForProcessing: CapturedRoomData, error: Error?) -> Bool {
        return true
    }

    func captureView(didPresent processedResult: CapturedRoom, error: Error?) {
        guard !finished else { return }
        finished = true
        if let error = error {
            dismiss(animated: true) { self.completion(.failure(ScanError.failed(error.localizedDescription))) }
            return
        }
        let dict = buildResult(processedResult)
        dismiss(animated: true) { self.completion(.success(dict)) }
    }

    // MARK: RoomCaptureSessionDelegate

    func captureSession(_ session: RoomCaptureSession, didUpdate room: CapturedRoom) {
        latestRoom = room
    }

    func captureSession(_ session: RoomCaptureSession, didEndWith data: CapturedRoomData, error: Error?) {
        if let error = error, !finished {
            finished = true
            pollTimer?.invalidate()
            dismiss(animated: true) { self.completion(.failure(ScanError.failed(error.localizedDescription))) }
        }
    }

    // MARK: геометрия

    private func xyz(_ c: simd_float4) -> simd_float3 { simd_float3(c.x, c.y, c.z) }

    /// Описание поверхности для JS: центр, оси, размеры, концы в плане (X, Z).
    private func surfaceDict(_ s: CapturedRoom.Surface) -> [String: Any] {
        let t = s.transform
        let c = xyz(t.columns.3)
        let ax = simd_normalize(xyz(t.columns.0))
        let ay = simd_normalize(xyz(t.columns.1))
        let az = simd_normalize(xyz(t.columns.2))
        let w = s.dimensions.x, h = s.dimensions.y
        let p0 = c - ax * (w / 2), p1 = c + ax * (w / 2)
        var d: [String: Any] = [
            "id": s.identifier.uuidString,
            "w": w, "h": h,
            "cx": c.x, "cy": c.y, "cz": c.z,
            "ax": ax.x, "ay": ax.y, "az": ax.z,
            "nx": az.x, "ny": az.y, "nz": az.z,
            "upx": ay.x, "upy": ay.y, "upz": ay.z,
            "x0": p0.x, "y0": p0.z, "x1": p1.x, "y1": p1.z,
            "confidence": confidenceName(s.confidence),
        ]
        if let parent = s.parentIdentifier { d["parent"] = parent.uuidString }
        return d
    }

    private func confidenceName(_ c: CapturedRoom.Confidence) -> String {
        switch c {
        case .high: return "high"
        case .medium: return "medium"
        default: return "low"
        }
    }

    private func buildResult(_ room: CapturedRoom) -> [String: Any] {
        var out: [String: Any] = ["mode": mode]
        out["walls"] = room.walls.map(surfaceDict)
        out["doors"] = room.doors.map(surfaceDict)
        out["windows"] = room.windows.map(surfaceDict)
        out["openings"] = room.openings.map(surfaceDict)
        // уровень пола — низ самой низкой стены
        let floorY = room.walls.map { xyz($0.transform.columns.3).y - $0.dimensions.y / 2 }.min() ?? 0
        out["floorY"] = floorY
        var fr: [[String: Any]] = []
        for (wallId, list) in frames {
            for f in list {
                fr.append([
                    "wall": wallId.uuidString,
                    "jpeg": f.jpeg.base64EncodedString(),
                    "corners": f.corners,
                    "w": f.w, "h": f.h,
                    "full": f.full, "score": f.score,
                ])
            }
        }
        out["frames"] = fr
        return out
    }

    // MARK: автоснимки стен (обход этапа)

    private func pollFrame() {
        guard let frame = captureView.captureSession.arSession.currentFrame,
              let room = latestRoom, !room.walls.isEmpty else { return }
        let cam = frame.camera
        guard cam.trackingState == .normal else { return }
        let T = cam.transform
        // стабильность: телефон почти не двигается между опросами
        if let last = lastTransform {
            let dp = simd_length(xyz(T.columns.3) - xyz(last.columns.3))
            let f1 = -xyz(T.columns.2), f0 = -xyz(last.columns.2)
            let dang = acos(max(-1, min(1, simd_dot(f1, f0))))
            lastTransform = T
            if dp > 0.05 || dang > 0.05 { return }
        } else { lastTransform = T; return }

        let camPos = xyz(T.columns.3)
        let fwd = simd_normalize(-xyz(T.columns.2))
        var best: (CapturedRoom.Surface, Float, Float)? = nil  // стена, score, дистанция
        for wall in room.walls {
            let t = wall.transform
            let c = xyz(t.columns.3)
            let ax = simd_normalize(xyz(t.columns.0)), ay = simd_normalize(xyz(t.columns.1)), n = simd_normalize(xyz(t.columns.2))
            let denom = simd_dot(fwd, n)
            if abs(denom) < 0.35 { continue }               // смотрим слишком вскользь (> ~70°)
            let dist = simd_dot(c - camPos, n) / denom
            if dist < 0.6 || dist > 7 { continue }
            let hit = camPos + fwd * dist
            let lx = simd_dot(hit - c, ax), ly = simd_dot(hit - c, ay)
            if abs(lx) > wall.dimensions.x / 2 || abs(ly) > wall.dimensions.y / 2 { continue }
            let frontal = abs(denom)                          // 1 — в лоб
            let centered = 1 - min(1, abs(lx) / max(0.1, wall.dimensions.x / 2))
            let score = frontal * 0.7 + centered * 0.3
            if best == nil || score > best!.1 { best = (wall, score, dist) }
        }
        guard let (wall, score0, _) = best else { return }

        // проекция углов стены в кадр
        let t = wall.transform
        let c = xyz(t.columns.3)
        let ax = simd_normalize(xyz(t.columns.0)), ay = simd_normalize(xyz(t.columns.1))
        let w = wall.dimensions.x, h = wall.dimensions.y
        let corners3 = [c - ax * (w/2) + ay * (h/2), c + ax * (w/2) + ay * (h/2), c + ax * (w/2) - ay * (h/2), c - ax * (w/2) - ay * (h/2)]
        let view = T.inverse
        let K = cam.intrinsics
        let res = cam.imageResolution
        var pts: [[Float]] = []
        var allInside = true
        for p in corners3 {
            let pc4 = view * simd_float4(p.x, p.y, p.z, 1)
            let z = -pc4.z
            if z <= 0.05 { return }                          // угол за камерой — кадр не годится
            let px = K.columns.0.x * (pc4.x / z) + K.columns.2.x
            let py = K.columns.2.y - K.columns.1.y * (pc4.y / z)
            let u = px / Float(res.width), v = py / Float(res.height)
            if u < -0.15 || u > 1.15 || v < -0.15 || v > 1.15 { allInside = false }
            // кадр поворачиваем в портрет (90° по часовой): u' = 1 - v, v' = u
            pts.append([1 - v, u])
        }
        let full = allInside
        let score = score0 + (full ? 0.3 : 0)
        // TL, TR, BR, BL для зрителя: две верхние — с меньшим v', среди них левая — с меньшим u'
        let sorted = pts.sorted { $0[1] < $1[1] }
        let top = Array(sorted[0..<2]).sorted { $0[0] < $1[0] }
        let bottom = Array(sorted[2..<4]).sorted { $0[0] < $1[0] }
        let ordered = [top[0], top[1], bottom[1], bottom[0]]

        // уже есть кадр этой стены не хуже и с той же точки — пропускаем
        let existing = frames[wall.identifier] ?? []
        if existing.contains(where: { simd_length($0.camPos - camPos) < 0.7 && $0.score >= score }) { return }

        guard let jpeg = jpegData(from: frame.capturedImage) else { return }
        var list = existing.filter { simd_length($0.camPos - camPos) >= 0.7 || $0.score > score }
        list.append(WallFrame(score: score, full: full, camPos: camPos, jpeg: jpeg, corners: ordered, w: w, h: h))
        list.sort { $0.score > $1.score }
        if list.count > 2 { list = Array(list.prefix(2)) }
        frames[wall.identifier] = list
        DispatchQueue.main.async {
            let n = self.frames.values.reduce(0) { $0 + $1.count }
            self.statusLabel.text = "Снято кадров: \(n) · стен с фото: \(self.frames.count)"
        }
    }

    private func jpegData(from pixelBuffer: CVPixelBuffer) -> Data? {
        var img = CIImage(cvPixelBuffer: pixelBuffer).oriented(.right)   // портрет
        let longest = max(img.extent.width, img.extent.height)
        let k = CGFloat(maxDim) / longest
        if k < 1 { img = img.transformed(by: CGAffineTransform(scaleX: k, y: k)) }
        let cs = CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB()
        return ciContext.jpegRepresentation(of: img, colorSpace: cs, options: [kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: 0.85])
    }
}
