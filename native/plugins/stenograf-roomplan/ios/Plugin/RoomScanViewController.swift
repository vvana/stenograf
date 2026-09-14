import UIKit
import RoomPlan
import ARKit
import CoreImage
import simd

/// Экран сканирования: RoomCaptureView + наша панель кнопок.
/// mode: "measure" — геометрия одной комнаты; "walk" — плюс автоснимки стен;
///       "multi"   — несколько комнат подряд в одной AR-сессии (StructureBuilder), кадры по флагу;
///       "final"   — как multi, плюс окрашенная 3D-сетка (финальный скан);
///       "ghost"   — AR-призрак: старое фото стены приклеивается к ней в живой картинке.
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
    private let wantFrames: Bool
    private let overlayParams: [String: Any]?
    private let completion: (Result<[String: Any], Error>) -> Void
    private var finished = false
    private var isMulti: Bool { mode == "multi" || mode == "final" }

    private var captureView: RoomCaptureView!
    private var sharedSession: ARSession?
    private var latestRoom: CapturedRoom?
    private var capturedRooms: [CapturedRoom] = []
    private var frames: [UUID: [WallFrame]] = [:]   // лучшие кадры по стенам
    private var pollTimer: Timer?
    private var lastTransform: simd_float4x4?
    private let ciContext = CIContext()
    private let statusLabel = UILabel()
    private var nextButton: UIButton!
    private var doneButton: UIButton!
    private var pendingAction: String = "done"      // "next" — после обработки комнаты продолжаем

    // финальный скан
    private var keyFrames: [KeyFrame] = []
    private var lastKeyPos: simd_float3?
    private var lastKeyFwd: simd_float3?
    private var meshAnchors: [ARMeshAnchor] = []

    // AR-призрак
    private var ghostView: UIImageView?
    private var ghostQuad: [CGPoint] = []            // TL, TR, BR, BL в пикселях картинки
    private var ghostWallW: Float = 0, ghostWallH: Float = 0
    private var ghostSlider: UISlider?

    struct WallFrame {
        let score: Float
        let full: Bool
        let camPos: simd_float3
        let jpeg: Data
        let corners: [[Float]]   // 4 × [u, v] в портретном кадре: TL, TR, BR, BL для зрителя
        let w: Float
        let h: Float
    }

    init(mode: String, maxDim: Int, wantFrames: Bool, overlay: [String: Any]?,
         completion: @escaping (Result<[String: Any], Error>) -> Void) {
        self.mode = mode
        self.maxDim = maxDim
        self.wantFrames = wantFrames
        self.overlayParams = overlay
        self.completion = completion
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    // MARK: UI

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        captureView = RoomCaptureView(frame: view.bounds)
        captureView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        captureView.delegate = self
        captureView.captureSession.delegate = self
        view.addSubview(captureView)
        sharedSession = captureView.captureSession.arSession

        let bar = UIStackView()
        bar.axis = .horizontal
        bar.distribution = .fillEqually
        bar.spacing = 10
        bar.translatesAutoresizingMaskIntoConstraints = false
        let cancel = makeButton("Отмена", color: UIColor(white: 0.2, alpha: 0.85))
        cancel.addTarget(self, action: #selector(cancelTapped), for: .touchUpInside)
        bar.addArrangedSubview(cancel)
        if isMulti {
            nextButton = makeButton("Следующая", color: UIColor(white: 0.25, alpha: 0.9))
            nextButton.addTarget(self, action: #selector(nextTapped), for: .touchUpInside)
            bar.addArrangedSubview(nextButton)
        }
        doneButton = makeButton(isMulti ? "Завершить" : "Готово", color: UIColor(red: 0.91, green: 0.44, blue: 0.18, alpha: 1))
        doneButton.addTarget(self, action: #selector(doneTapped), for: .touchUpInside)
        bar.addArrangedSubview(doneButton)
        view.addSubview(bar)

        statusLabel.textColor = .white
        statusLabel.font = .systemFont(ofSize: 13, weight: .semibold)
        statusLabel.textAlignment = .center
        statusLabel.numberOfLines = 3
        statusLabel.backgroundColor = UIColor(white: 0, alpha: 0.45)
        statusLabel.layer.cornerRadius = 10
        statusLabel.clipsToBounds = true
        statusLabel.translatesAutoresizingMaskIntoConstraints = false
        statusLabel.text = initialHint()
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

        if mode == "ghost" { setupGhost(bar: bar) }
    }

    private func initialHint() -> String {
        switch mode {
        case "walk": return "Обход этапа: медленно ведите телефон вдоль стен — кадры снимутся сами"
        case "multi": return wantFrames
            ? "Обход квартиры: пройдите комнату вдоль стен, затем «Следующая» и переходите в другую"
            : "Обмер квартиры: обойдите комнату, нажмите «Следующая», перейдите в другую. В конце — «Завершить»"
        case "final": return "Финальный скан: медленно обойдите каждую комнату, поворачивая телефон ко всем поверхностям"
        case "ghost": return "Наведите телефон на стену — старое фото совместится само"
        default: return "Обмер: обойдите комнату вдоль стен, заглядывая в углы"
        }
    }

    private func makeButton(_ title: String, color: UIColor) -> UIButton {
        let b = UIButton(type: .system)
        b.setTitle(title, for: .normal)
        b.setTitleColor(.white, for: .normal)
        b.titleLabel?.font = .systemFont(ofSize: 16, weight: .semibold)
        b.backgroundColor = color
        b.layer.cornerRadius = 14
        return b
    }

    private func setupGhost(bar: UIStackView) {
        guard let p = overlayParams, let b64 = p["jpeg"] as? String,
              let data = Data(base64Encoded: b64), let img = UIImage(data: data) else { return }
        let iv = UIImageView(image: img)
        iv.isUserInteractionEnabled = false
        iv.alpha = 0.5
        iv.isHidden = true
        iv.layer.anchorPoint = CGPoint(x: 0, y: 0)
        iv.frame = CGRect(origin: .zero, size: img.size)
        view.insertSubview(iv, aboveSubview: captureView)
        ghostView = iv
        let quad = (p["quad"] as? [[Any]]) ?? []
        let sz = img.size
        ghostQuad = quad.compactMap { q -> CGPoint? in
            guard q.count >= 2, let u = q[0] as? NSNumber, let v = q[1] as? NSNumber else { return nil }
            return CGPoint(x: CGFloat(u.doubleValue) * sz.width, y: CGFloat(v.doubleValue) * sz.height)
        }
        if ghostQuad.count != 4 {
            ghostQuad = [CGPoint(x: 0, y: 0), CGPoint(x: sz.width, y: 0), CGPoint(x: sz.width, y: sz.height), CGPoint(x: 0, y: sz.height)]
        }
        ghostWallW = Float((p["w"] as? NSNumber)?.doubleValue ?? 0)
        ghostWallH = Float((p["h"] as? NSNumber)?.doubleValue ?? 0)
        let slider = UISlider()
        slider.minimumValue = 0.05; slider.maximumValue = 0.95; slider.value = 0.5
        slider.translatesAutoresizingMaskIntoConstraints = false
        slider.addTarget(self, action: #selector(ghostAlphaChanged(_:)), for: .valueChanged)
        view.addSubview(slider)
        NSLayoutConstraint.activate([
            slider.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 24),
            slider.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -24),
            slider.bottomAnchor.constraint(equalTo: bar.topAnchor, constant: -12),
        ])
        ghostSlider = slider
    }

    @objc private func ghostAlphaChanged(_ s: UISlider) { ghostView?.alpha = CGFloat(s.value) }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        runCapture()
    }

    private func runCapture() {
        var config = RoomCaptureSession.Configuration()
        config.isCoachingEnabled = mode != "ghost"
        captureView.captureSession.run(configuration: config)
        if pollTimer == nil {
            pollTimer = Timer.scheduledTimer(withTimeInterval: 0.4, repeats: true) { [weak self] _ in self?.poll() }
        }
    }

    override var prefersStatusBarHidden: Bool { true }
    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { .portrait }

    // MARK: кнопки

    @objc private func cancelTapped() {
        guard !finished else { return }
        finished = true
        pollTimer?.invalidate()
        captureView.captureSession.stop(pauseARSession: true)
        dismiss(animated: true) { self.completion(.failure(ScanError.cancelled)) }
    }

    @objc private func nextTapped() {
        pendingAction = "next"
        nextButton.isEnabled = false; doneButton.isEnabled = false
        statusLabel.text = "Обрабатываю комнату…"
        captureView.captureSession.stop(pauseARSession: false)   // AR-сессия живёт дальше — общие координаты
    }

    @objc private func doneTapped() {
        pendingAction = "done"
        pollTimer?.invalidate(); pollTimer = nil
        if mode == "ghost" {
            finished = true
            captureView.captureSession.stop(pauseARSession: true)
            dismiss(animated: true) { self.completion(.success(["mode": "ghost"])) }
            return
        }
        // mesh-якоря берём до остановки сессии
        if let anchors = sharedSession?.currentFrame?.anchors {
            meshAnchors = anchors.compactMap { $0 as? ARMeshAnchor }
        }
        doneButton.isEnabled = false; nextButton?.isEnabled = false
        statusLabel.text = "Обрабатываю скан…"
        captureView.captureSession.stop(pauseARSession: false)
    }

    // MARK: RoomCaptureViewDelegate

    func captureView(shouldPresent roomDataForProcessing: CapturedRoomData, error: Error?) -> Bool {
        return true
    }

    func captureView(didPresent processedResult: CapturedRoom, error: Error?) {
        guard !finished else { return }
        if let error = error {
            finished = true
            dismiss(animated: true) { self.completion(.failure(ScanError.failed(error.localizedDescription))) }
            return
        }
        capturedRooms.append(processedResult)
        if pendingAction == "next" {
            startNextRoom()
            return
        }
        finished = true
        pollTimer?.invalidate()
        if isMulti { finishStructure() } else { finishSingle(processedResult) }
    }

    private func startNextRoom() {
        guard let session = sharedSession else { return }
        captureView.removeFromSuperview()
        let cv = RoomCaptureView(frame: view.bounds, arSession: session)
        cv.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        cv.delegate = self
        cv.captureSession.delegate = self
        view.insertSubview(cv, at: 0)
        captureView = cv
        latestRoom = nil
        nextButton.isEnabled = true; doneButton.isEnabled = true
        statusLabel.text = "Комнат отсканировано: \(capturedRooms.count). Перейдите в следующую и продолжайте"
        runCapture()
    }

    private func finishSingle(_ room: CapturedRoom) {
        let mirrors = detectMirrors(rooms: [room])
        var dict = buildResult(rooms: [room])
        dict["mirrors"] = mirrors
        sharedSession?.pause()
        dismiss(animated: true) { self.completion(.success(dict)) }
    }

    private func finishStructure() {
        let rooms = capturedRooms
        let anchors = meshAnchors
        let keys = keyFrames
        let wantMesh = mode == "final"
        statusLabel.text = wantMesh ? "Собираю квартиру и 3D-модель…" : "Собираю план квартиры…"
        Task { @MainActor in
            var finalRooms = rooms
            if rooms.count > 1 {
                do {
                    let builder = StructureBuilder(options: [.beautifyObjects])
                    let structure = try await builder.capturedStructure(from: rooms)
                    if !structure.rooms.isEmpty { finalRooms = structure.rooms }
                } catch { /* оставляем сырые комнаты — они уже в общих координатах */ }
            }
            var dict = self.buildResult(rooms: finalRooms)
            dict["mirrors"] = self.detectMirrors(rooms: finalRooms)
            if wantMesh {
                let mesh = await Task.detached(priority: .userInitiated) { () -> [String: Any] in
                    return Self.buildMesh(anchors: anchors, keyFrames: keys)
                }.value
                for (k, v) in mesh { dict[k] = v }
            }
            self.sharedSession?.pause()
            self.dismiss(animated: true) { self.completion(.success(dict)) }
        }
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

    // MARK: геометрия → словари для JS

    private func xyz(_ c: simd_float4) -> simd_float3 { simd_float3(c.x, c.y, c.z) }

    private func surfaceDict(_ s: CapturedRoom.Surface) -> [String: Any] {
        let t = s.transform
        let c = xyz(t.columns.3)
        let ax = simd_normalize(xyz(t.columns.0))
        let ay = simd_normalize(xyz(t.columns.1))
        let az = simd_normalize(xyz(t.columns.2))
        let w: Float = s.dimensions.x
        let h: Float = s.dimensions.y
        let half: simd_float3 = ax * (w / 2)
        let p0: simd_float3 = c - half
        let p1: simd_float3 = c + half
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

    private func roomDict(_ room: CapturedRoom) -> [String: Any] {
        var out: [String: Any] = [:]
        out["walls"] = room.walls.map(surfaceDict)
        out["doors"] = room.doors.map(surfaceDict)
        out["windows"] = room.windows.map(surfaceDict)
        out["openings"] = room.openings.map(surfaceDict)
        let floorY = room.walls.map { xyz($0.transform.columns.3).y - $0.dimensions.y / 2 }.min() ?? 0
        out["floorY"] = floorY
        return out
    }

    private func buildResult(rooms: [CapturedRoom]) -> [String: Any] {
        var out: [String: Any] = ["mode": mode]
        if let first = rooms.first, rooms.count == 1 {
            for (k, v) in roomDict(first) { out[k] = v }
        }
        out["rooms"] = rooms.map(roomDict)
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

    // MARK: опрос кадра

    private func poll() {
        guard let frame = sharedSession?.currentFrame else { return }
        if mode == "ghost" { pollGhost(frame: frame); return }
        if mode == "final" { pollKeyFrame(frame: frame) }
        if wantFrames { pollWallFrame(frame: frame) }
    }

    /// Лучшая стена в кадре: (стена, score) — камера смотрит на неё не вскользь, точка взгляда внутри стены.
    private func bestWall(in room: CapturedRoom, camera cam: ARCamera) -> (CapturedRoom.Surface, Float)? {
        let T = cam.transform
        let camPos = xyz(T.columns.3)
        let fwd = simd_normalize(-xyz(T.columns.2))
        var best: (CapturedRoom.Surface, Float)? = nil
        for wall in room.walls {
            let t = wall.transform
            let c = xyz(t.columns.3)
            let ax = simd_normalize(xyz(t.columns.0))
            let ay = simd_normalize(xyz(t.columns.1))
            let n = simd_normalize(xyz(t.columns.2))
            let denom: Float = simd_dot(fwd, n)
            if abs(denom) < 0.35 { continue }
            let toWall: simd_float3 = c - camPos
            let dist: Float = simd_dot(toWall, n) / denom
            if dist < 0.6 || dist > 7 { continue }
            let hit: simd_float3 = camPos + fwd * dist
            let rel: simd_float3 = hit - c
            let lx: Float = simd_dot(rel, ax)
            let ly: Float = simd_dot(rel, ay)
            if abs(lx) > wall.dimensions.x / 2 || abs(ly) > wall.dimensions.y / 2 { continue }
            let frontal: Float = abs(denom)
            let centered: Float = 1 - min(1, abs(lx) / max(0.1, wall.dimensions.x / 2))
            let score: Float = frontal * 0.7 + centered * 0.3
            if best == nil || score > best!.1 { best = (wall, score) }
        }
        return best
    }

    /// Углы стены (TL, TR, BR, BL для зрителя изнутри) в мировых координатах.
    private func wallCorners(_ wall: CapturedRoom.Surface, viewer camPos: simd_float3) -> [simd_float3] {
        let t = wall.transform
        let c = xyz(t.columns.3)
        var ax = simd_normalize(xyz(t.columns.0))
        let ay = simd_normalize(xyz(t.columns.1))
        let n = simd_normalize(xyz(t.columns.2))
        // ось X стены должна идти слева направо для зрителя: right = forward × up, forward = от зрителя к стене
        let toWall: simd_float3 = c - camPos
        let facing: simd_float3 = simd_dot(toWall, n) > 0 ? n : -n
        let right: simd_float3 = simd_normalize(simd_cross(facing, simd_float3(0, 1, 0)))
        if simd_dot(ax, right) < 0 { ax = -ax }
        let w: Float = wall.dimensions.x
        let h: Float = wall.dimensions.y
        let hx: simd_float3 = ax * (w / 2)
        let hy: simd_float3 = ay * (h / 2)
        let tl: simd_float3 = c - hx + hy
        let tr: simd_float3 = c + hx + hy
        let br: simd_float3 = c + hx - hy
        let bl: simd_float3 = c - hx - hy
        return [tl, tr, br, bl]
    }

    private func pollWallFrame(frame: ARFrame) {
        guard let room = latestRoom, !room.walls.isEmpty else { return }
        let cam = frame.camera
        guard cam.trackingState == .normal else { return }
        let T = cam.transform
        if let last = lastTransform {
            let dp = simd_length(xyz(T.columns.3) - xyz(last.columns.3))
            let f1 = -xyz(T.columns.2), f0 = -xyz(last.columns.2)
            let dang = acos(max(-1, min(1, simd_dot(f1, f0))))
            lastTransform = T
            if dp > 0.05 || dang > 0.05 { return }
        } else { lastTransform = T; return }

        guard let (wall, score0) = bestWall(in: room, camera: cam) else { return }
        let camPos = xyz(T.columns.3)
        let corners3 = wallCorners(wall, viewer: camPos)
        let viewM = T.inverse
        let K = cam.intrinsics
        let res = cam.imageResolution
        var pts: [[Float]] = []
        var allInside = true
        for p in corners3 {
            let pc4 = viewM * simd_float4(p.x, p.y, p.z, 1)
            let z: Float = -pc4.z
            if z <= 0.05 { return }
            let px: Float = K.columns.0.x * (pc4.x / z) + K.columns.2.x
            let py: Float = K.columns.2.y - K.columns.1.y * (pc4.y / z)
            let u: Float = px / Float(res.width)
            let v: Float = py / Float(res.height)
            if u < -0.15 || u > 1.15 || v < -0.15 || v > 1.15 { allInside = false }
            pts.append([1 - v, u])   // портрет: поворот на 90° по часовой
        }
        let full = allInside
        let score: Float = score0 + (full ? 0.3 : 0)
        let existing = frames[wall.identifier] ?? []
        if existing.contains(where: { simd_length($0.camPos - camPos) < 0.7 && $0.score >= score }) { return }
        guard let jpeg = jpegData(from: frame.capturedImage) else { return }
        var list = existing.filter { simd_length($0.camPos - camPos) >= 0.7 || $0.score > score }
        list.append(WallFrame(score: score, full: full, camPos: camPos, jpeg: jpeg, corners: pts, w: wall.dimensions.x, h: wall.dimensions.y))
        list.sort { $0.score > $1.score }
        if list.count > 2 { list = Array(list.prefix(2)) }
        frames[wall.identifier] = list
        let n = frames.values.reduce(0) { $0 + $1.count }
        statusLabel.text = "Снято кадров: \(n) · стен с фото: \(frames.count)" + (isMulti ? " · комнат: \(capturedRooms.count + 1)" : "")
    }

    // MARK: AR-призрак

    private func pollGhost(frame: ARFrame) {
        guard let gv = ghostView else { return }
        guard let room = latestRoom, !room.walls.isEmpty, frame.camera.trackingState == .normal else { gv.isHidden = true; return }
        let cam = frame.camera
        // предпочитаем стену тех же размеров, что у фото (±15 %)
        var candidates = room.walls
        if ghostWallW > 0 {
            let sized = room.walls.filter { abs($0.dimensions.x - ghostWallW) < ghostWallW * 0.15 }
            if !sized.isEmpty { candidates = sized }
        }
        let sub = CapturedRoom.Surface.self
        _ = sub
        var bestWallOpt: CapturedRoom.Surface? = nil
        var bestScore: Float = -1
        let T = cam.transform
        let camPos = xyz(T.columns.3)
        let fwd = simd_normalize(-xyz(T.columns.2))
        for wall in candidates {
            let t = wall.transform
            let c = xyz(t.columns.3)
            let n = simd_normalize(xyz(t.columns.2))
            let denom: Float = simd_dot(fwd, n)
            if abs(denom) < 0.25 { continue }
            let dist: Float = simd_dot(c - camPos, n) / denom
            if dist < 0.3 || dist > 8 { continue }
            let score: Float = abs(denom) - dist * 0.02
            if score > bestScore { bestScore = score; bestWallOpt = wall }
        }
        guard let wall = bestWallOpt else { gv.isHidden = true; return }
        let corners3 = wallCorners(wall, viewer: camPos)
        let size = view.bounds.size
        var screen: [CGPoint] = []
        for p in corners3 {
            let pc4 = T.inverse * simd_float4(p.x, p.y, p.z, 1)
            if -pc4.z <= 0.05 { gv.isHidden = true; return }
            screen.append(cam.projectPoint(p, orientation: .portrait, viewportSize: size))
        }
        guard let h = solveHomography(src: ghostQuad, dst: screen) else { gv.isHidden = true; return }
        gv.layer.transform = transform3D(fromHomography: h)
        gv.isHidden = false
        statusLabel.text = "Совмещено со стеной \(String(format: "%.1f", wall.dimensions.x)) × \(String(format: "%.1f", wall.dimensions.y)) м. Ползунок — прозрачность"
    }

    // MARK: зеркала: точки сетки «за» плоскостью стены

    private func detectMirrors(rooms: [CapturedRoom]) -> [[String: Any]] {
        var out: [[String: Any]] = []
        guard !meshAnchors.isEmpty else { return out }
        // вершины всех mesh-якорей в мировых координатах (прореживаем до ~150k)
        var verts: [simd_float3] = []
        for a in meshAnchors {
            let g = a.geometry
            let v = g.vertices
            let base = v.buffer.contents().advanced(by: v.offset)
            let step = max(1, v.count / 30000)
            var i = 0
            while i < v.count {
                let p = base.advanced(by: i * v.stride).assumingMemoryBound(to: simd_float3.self).pointee
                let w4 = a.transform * simd_float4(p.x, p.y, p.z, 1)
                verts.append(simd_float3(w4.x, w4.y, w4.z))
                i += step
            }
        }
        if verts.isEmpty { return out }
        for room in rooms {
            let centers = room.walls.map { xyz($0.transform.columns.3) }
            guard !centers.isEmpty else { continue }
            var rc = simd_float3(0, 0, 0)
            for c in centers { rc += c }
            rc /= Float(centers.count)
            let floorY = room.walls.map { xyz($0.transform.columns.3).y - $0.dimensions.y / 2 }.min() ?? 0
            for wall in room.walls {
                let t = wall.transform
                let c = xyz(t.columns.3)
                let ax = simd_normalize(xyz(t.columns.0))
                let ay = simd_normalize(xyz(t.columns.1))
                var n = simd_normalize(xyz(t.columns.2))
                if simd_dot(rc - c, n) < 0 { n = -n }            // n — внутрь комнаты
                let w: Float = wall.dimensions.x
                let h: Float = wall.dimensions.y
                if w < 0.5 || h < 0.5 { continue }
                let cell: Float = 0.1
                let nx = Int(w / cell) + 1, ny = Int(h / cell) + 1
                var grid = [Int](repeating: 0, count: nx * ny)
                var hits = 0
                for p in verts {
                    let rel: simd_float3 = p - c
                    let depth: Float = simd_dot(rel, n)
                    if depth > -0.3 || depth < -4 { continue }      // только «за» стеной, не дальше 4 м
                    let lx: Float = simd_dot(rel, ax)
                    let ly: Float = simd_dot(rel, ay)
                    if abs(lx) > w / 2 || abs(ly) > h / 2 { continue }
                    let gx = Int((lx + w / 2) / cell), gy = Int((ly + h / 2) / cell)
                    if gx < 0 || gy < 0 || gx >= nx || gy >= ny { continue }
                    grid[gy * nx + gx] += 1
                    hits += 1
                }
                if hits < 20 { continue }
                // связные области ячеек с ≥3 попаданиями
                var seen = [Bool](repeating: false, count: nx * ny)
                for start in 0..<(nx * ny) {
                    if seen[start] || grid[start] < 3 { continue }
                    var stack = [start]
                    var minX = nx, maxX = -1, minY = ny, maxY = -1, count = 0
                    while let i = stack.popLast() {
                        if seen[i] || grid[i] < 3 { continue }
                        seen[i] = true; count += 1
                        let gx = i % nx, gy = i / nx
                        minX = min(minX, gx); maxX = max(maxX, gx); minY = min(minY, gy); maxY = max(maxY, gy)
                        if gx > 0 { stack.append(i - 1) }
                        if gx + 1 < nx { stack.append(i + 1) }
                        if gy > 0 { stack.append(i - nx) }
                        if gy + 1 < ny { stack.append(i + nx) }
                    }
                    let mw = Float(maxX - minX + 1) * cell, mh = Float(maxY - minY + 1) * cell
                    if mw < 0.25 || mh < 0.25 || mw * mh < 0.15 { continue }
                    let fill = Float(count) / Float((maxX - minX + 1) * (maxY - minY + 1))
                    if fill < 0.45 { continue }                     // рыхлое облако — не зеркало
                    // центр в мировых координатах
                    let lcx: Float = (Float(minX) + Float(maxX + 1)) / 2 * cell - w / 2
                    let lcy: Float = (Float(minY) + Float(maxY + 1)) / 2 * cell - h / 2
                    let center: simd_float3 = c + ax * lcx + ay * lcy
                    out.append([
                        "parent": wall.identifier.uuidString,
                        "w": mw, "h": mh,
                        "cx": center.x, "cy": center.y, "cz": center.z,
                        "fromFloor": center.y - mh / 2 - floorY,
                        "confidence": fill > 0.7 ? "high" : "medium",
                    ])
                }
            }
        }
        return out
    }

    // MARK: финальный скан — ключевые кадры и окраска сетки

    private func pollKeyFrame(frame: ARFrame) {
        let cam = frame.camera
        guard cam.trackingState == .normal, keyFrames.count < 70 else { return }
        let T = cam.transform
        let pos = xyz(T.columns.3)
        let fwd = simd_normalize(-xyz(T.columns.2))
        if let lp = lastKeyPos, let lf = lastKeyFwd {
            let moved = simd_length(pos - lp)
            let turned = acos(max(-1, min(1, simd_dot(fwd, lf))))
            if moved < 0.35 && turned < 0.35 { return }
        }
        let res = cam.imageResolution
        let targetW = 320
        let targetH = Int(Double(targetW) * Double(res.height) / Double(res.width))
        let ci = CIImage(cvPixelBuffer: frame.capturedImage)
        guard let cg = ciContext.createCGImage(ci, from: ci.extent),
              let rgba = rgbaBytes(of: cg, width: targetW, height: targetH) else { return }
        let k = Float(targetW) / Float(res.width)
        let K = cam.intrinsics
        keyFrames.append(KeyFrame(transformInv: T.inverse,
                                  fx: K.columns.0.x * k, fy: K.columns.1.y * k, cx: K.columns.2.x * k, cy: K.columns.2.y * k,
                                  w: targetW, h: targetH, rgba: rgba, pos: pos, fwd: fwd))
        lastKeyPos = pos; lastKeyFwd = fwd
        statusLabel.text = "Ключевых кадров: \(keyFrames.count) · комнат: \(capturedRooms.count + 1)"
    }

    /// Сетка всех mesh-якорей с цветом вершин по ближайшему подходящему ключевому кадру → PLY (base64).
    private static func buildMesh(anchors: [ARMeshAnchor], keyFrames: [KeyFrame]) -> [String: Any] {
        var positions: [simd_float3] = []
        var normals: [simd_float3] = []
        var faces: [UInt32] = []
        for a in anchors {
            let g = a.geometry
            let v = g.vertices, nrm = g.normals, f = g.faces
            let vbase = v.buffer.contents().advanced(by: v.offset)
            let nbase = nrm.buffer.contents().advanced(by: nrm.offset)
            let offset = UInt32(positions.count)
            let rot = simd_float3x3(simd_float3(a.transform.columns.0.x, a.transform.columns.0.y, a.transform.columns.0.z),
                                    simd_float3(a.transform.columns.1.x, a.transform.columns.1.y, a.transform.columns.1.z),
                                    simd_float3(a.transform.columns.2.x, a.transform.columns.2.y, a.transform.columns.2.z))
            for i in 0..<v.count {
                let p = vbase.advanced(by: i * v.stride).assumingMemoryBound(to: simd_float3.self).pointee
                let w4 = a.transform * simd_float4(p.x, p.y, p.z, 1)
                positions.append(simd_float3(w4.x, w4.y, w4.z))
                let n = nbase.advanced(by: i * nrm.stride).assumingMemoryBound(to: simd_float3.self).pointee
                normals.append(simd_normalize(rot * n))
            }
            let fbase = f.buffer.contents()
            let per = f.indexCountPerPrimitive
            for i in 0..<f.count {
                for j in 0..<per {
                    let idx: UInt32
                    if f.bytesPerIndex == 2 {
                        idx = UInt32(fbase.advanced(by: (i * per + j) * 2).assumingMemoryBound(to: UInt16.self).pointee)
                    } else {
                        idx = fbase.advanced(by: (i * per + j) * 4).assumingMemoryBound(to: UInt32.self).pointee
                    }
                    faces.append(idx + offset)
                }
            }
        }
        var colors = [SIMD3<UInt8>](repeating: SIMD3<UInt8>(170, 165, 158), count: positions.count)
        if !keyFrames.isEmpty {
            for i in 0..<positions.count {
                let p = positions[i]
                let n = normals[i]
                var bestScore: Float = -1
                var bestColor: SIMD3<UInt8>? = nil
                for kf in keyFrames {
                    let d: simd_float3 = p - kf.pos
                    let dist: Float = simd_length(d)
                    if dist < 0.3 || dist > 5 { continue }
                    let dir: simd_float3 = d / dist
                    if simd_dot(dir, kf.fwd) < 0.5 { continue }          // вне поля зрения
                    let facing: Float = -simd_dot(dir, n)                   // нормаль смотрит на камеру
                    if facing < 0.15 { continue }
                    let pc4 = kf.transformInv * simd_float4(p.x, p.y, p.z, 1)
                    let z: Float = -pc4.z
                    if z <= 0.05 { continue }
                    let px = Int(kf.fx * (pc4.x / z) + kf.cx)
                    let py = Int(kf.cy - kf.fy * (pc4.y / z))
                    if px < 0 || py < 0 || px >= kf.w || py >= kf.h { continue }
                    let score: Float = facing * 2 - dist * 0.25
                    if score > bestScore {
                        let o = (py * kf.w + px) * 4
                        bestScore = score
                        bestColor = SIMD3<UInt8>(kf.rgba[o], kf.rgba[o + 1], kf.rgba[o + 2])
                    }
                }
                if let c = bestColor { colors[i] = c }
            }
        }
        let ply = plyData(positions: positions, colors: colors, faces: faces)
        return ["mesh": ply.base64EncodedString(), "meshVertices": positions.count, "meshFaces": faces.count / 3, "keyFrames": keyFrames.count]
    }

    private func jpegData(from pixelBuffer: CVPixelBuffer) -> Data? {
        var img = CIImage(cvPixelBuffer: pixelBuffer).oriented(.right)
        let longest = max(img.extent.width, img.extent.height)
        let k = CGFloat(maxDim) / longest
        if k < 1 { img = img.transformed(by: CGAffineTransform(scaleX: k, y: k)) }
        let cs = CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB()
        return ciContext.jpegRepresentation(of: img, colorSpace: cs, options: [kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: 0.85])
    }
}
