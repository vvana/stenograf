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
    // пол и потолок обхода: кадры со всех сторон (уменьшенные, с позой камеры) → ортофото в конце
    private var surfFrames: [KeyFrame] = []
    private var lastSurfPos: simd_float3?
    private var lastSurfFwd: simd_float3?
    private var prevSurfT: simd_float4x4?
    private var wantSurfaces: Bool { wantFrames && (mode == "walk" || mode == "multi") }
    private let hd: Bool                              // HD-скан: полные кадры + позы для обучения на компьютере
    private var hdCapture: HDCapture?

    // покрытие финального скана: подсветка в камере, мини-карта, проверка перед завершением
    private var coverage: CoverageModel?
    private var coverageOverlay: CoverageOverlayView?
    private var coverageMap: CoverageMapView?
    private var coverageLink: CADisplayLink?
    private var currentSurfaces: [CovSurface] = []
    private var doneSurfaces: [CovSurface] = []      // комнаты, уже завершённые кнопкой «Следующая»
    private var coverageChecked = false

    // AR-призрак
    private var ghostView: UIImageView?
    private var ghostQuad: [CGPoint] = []            // TL, TR, BR, BL в пикселях картинки
    private var ghostWallW: Float = 0, ghostWallH: Float = 0
    private var ghostSlider: UISlider?

    struct WallFrame {
        let score: Float
        let full: Bool
        let camPos: simd_float3
        let camDir: simd_float3  // направление взгляда камеры (мир)
        let jpeg: Data
        let corners: [[Float]]   // 4 × [u, v] в портретном кадре: TL, TR, BR, BL для зрителя
        let w: Float
        let h: Float
    }

    init(mode: String, maxDim: Int, wantFrames: Bool, overlay: [String: Any]?, hd: Bool = false,
         completion: @escaping (Result<[String: Any], Error>) -> Void) {
        self.mode = mode
        self.hd = hd && mode == "final"
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
        if hd { hdCapture = HDCapture() }
        if mode == "final" || wantSurfaces { setupCoverage() }
    }

    // MARK: покрытие

    private func setupCoverage() {
        let model = CoverageModel(need: hd ? 2 : 1)   // обход этапа: 1 кадр на клетку
        coverage = model
        let ov = CoverageOverlayView(frame: view.bounds)
        ov.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.insertSubview(ov, aboveSubview: captureView)
        coverageOverlay = ov
        let map = CoverageMapView(frame: .zero)
        map.model = model
        map.translatesAutoresizingMaskIntoConstraints = false
        map.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(toggleOverlay)))
        view.addSubview(map)
        NSLayoutConstraint.activate([
            map.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -16),
            map.topAnchor.constraint(equalTo: statusLabel.bottomAnchor, constant: 8),
            map.widthAnchor.constraint(equalToConstant: 128),
            map.heightAnchor.constraint(equalToConstant: 128),
        ])
        coverageMap = map
        let link = CADisplayLink(target: self, selector: #selector(coverageTick))
        link.preferredFramesPerSecond = 10
        link.add(to: .main, forMode: .common)
        coverageLink = link
    }

    /// Тап по мини-карте — спрятать/показать подсветку в камере.
    @objc private func toggleOverlay() {
        guard let ov = coverageOverlay else { return }
        ov.isHidden.toggle()
    }

    @objc private func coverageTick() {
        guard let model = coverage, let ov = coverageOverlay, !ov.isHidden,
              let frame = sharedSession?.currentFrame, frame.camera.trackingState == .normal else { return }
        ov.update(camera: frame.camera, surfaces: currentSurfaces, model: model)
    }

    private func refreshCoverageMap() {
        guard let map = coverageMap else { return }
        map.surfaces = doneSurfaces + currentSurfaces
        if let T = sharedSession?.currentFrame?.camera.transform {
            map.camPos = simd_float3(T.columns.3.x, T.columns.3.y, T.columns.3.z)
            map.camFwd = -simd_float3(T.columns.2.x, T.columns.2.y, T.columns.2.z)
        }
        map.setNeedsDisplay()
    }

    private func stopCoverage() {
        coverageLink?.invalidate(); coverageLink = nil
        coverageOverlay?.clear()
    }

    /// Плохо снятые поверхности (меньше половины клеток): из всех комнат или только текущей.
    private func weakSurfaces(currentOnly: Bool) -> [String] {
        guard let model = coverage else { return [] }
        let list = currentOnly ? currentSurfaces : doneSurfaces + currentSurfaces
        return list.compactMap { (s: CovSurface) -> String? in
            if s.cells.count < 3 { return nil }          // узкие простенки и короба — не придираемся
            let f = model.fraction(s)
            return f < 0.5 ? "\(s.name) — \(Int(f * 100))%" : nil
        }
    }

    /// Предупредить о пропусках; true — можно продолжать действие.
    private func confirmCoverage(currentOnly: Bool, proceed: @escaping () -> Void) -> Bool {
        guard coverage != nil, !coverageChecked else { return true }
        let weak = weakSurfaces(currentOnly: currentOnly)
        guard !weak.isEmpty else { return true }
        let shown = weak.prefix(8).joined(separator: "\n") + (weak.count > 8 ? "\n… и ещё \(weak.count - 8)" : "")
        let ac = UIAlertController(title: "Снято не всё",
                                   message: "Мало кадров на поверхностях (красные на мини-карте и в камере):\n\n\(shown)",
                                   preferredStyle: .alert)
        ac.addAction(UIAlertAction(title: "Доснять", style: .cancel))
        ac.addAction(UIAlertAction(title: currentOnly ? "Дальше всё равно" : "Завершить всё равно", style: .default) { [weak self] _ in
            self?.coverageChecked = true
            proceed()
            self?.coverageChecked = false
        })
        present(ac, animated: true)
        return false
    }

    private func initialHint() -> String {
        switch mode {
        case "walk": return "Обход этапа: медленно ведите телефон вдоль стен и наклоняйте к полу и потолку — кадры снимутся сами. Красное — ещё не снято, зелёное — готово"
        case "multi": return wantFrames
            ? "Обход квартиры: пройдите комнату вдоль стен, наклоняя телефон к полу и потолку, пока всё не станет зелёным, затем «Следующая» — и в другую комнату"
            : "Обмер квартиры: обойдите комнату, нажмите «Следующая», перейдите в другую. В конце — «Завершить»"
        case "final": return hd
            ? "HD-скан: идите медленно и замирайте — кадр снимается, когда телефон неподвижен. Красное — ещё не снято, жёлтое — мало кадров, зелёное — готово"
            : "Финальный скан: наводите телефон на всё красное, пока не станет зелёным. Тап по карте — спрятать подсветку"
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

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        stopCoverage()   // CADisplayLink держит контроллер — отпускаем при любом закрытии экрана
    }

    override var prefersStatusBarHidden: Bool { true }
    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { .portrait }

    // MARK: кнопки

    @objc private func cancelTapped() {
        guard !finished else { return }
        finished = true
        pollTimer?.invalidate()
        stopCoverage()
        captureView.captureSession.stop(pauseARSession: true)
        hdCapture?.discard()
        dismiss(animated: true) { self.completion(.failure(ScanError.cancelled)) }
    }

    @objc private func nextTapped() {
        guard confirmCoverage(currentOnly: true, proceed: { [weak self] in self?.nextTapped() }) else { return }
        doneSurfaces += currentSurfaces
        currentSurfaces = []
        pendingAction = "next"
        nextButton.isEnabled = false; doneButton.isEnabled = false
        statusLabel.text = "Обрабатываю комнату…"
        captureView.captureSession.stop(pauseARSession: false)   // AR-сессия живёт дальше — общие координаты
    }

    @objc private func doneTapped() {
        guard confirmCoverage(currentOnly: false, proceed: { [weak self] in self?.doneTapped() }) else { return }
        pendingAction = "done"
        pollTimer?.invalidate(); pollTimer = nil
        stopCoverage()
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
        if let usdz = exportUSDZ({ try room.export(to: $0) }) { dict["usdz"] = usdz }
        sharedSession?.pause()
        let base = dict
        Task { @MainActor in
            var out = base
            await self.addSurfaces(to: &out, rooms: [room])
            self.dismiss(animated: true) { self.completion(.success(out)) }
        }
    }

    private func finishStructure() {
        let rooms = capturedRooms
        let anchors = meshAnchors
        let keys = keyFrames
        let wantMesh = mode == "final"
        let hdc = hdCapture
        statusLabel.text = wantMesh ? "Собираю квартиру и 3D-модель…" : "Собираю план квартиры…"
        Task { @MainActor in
            var finalRooms = rooms
            var usdz: String? = nil
            if rooms.count > 1 {
                do {
                    let builder = StructureBuilder(options: [.beautifyObjects])
                    let structure = try await builder.capturedStructure(from: rooms)
                    if !structure.rooms.isEmpty { finalRooms = structure.rooms }
                    usdz = self.exportUSDZ({ try structure.export(to: $0) })
                } catch { /* оставляем сырые комнаты — они уже в общих координатах */ }
            } else if let only = rooms.first {
                usdz = self.exportUSDZ({ try only.export(to: $0) })
            }
            var dict = self.buildResult(rooms: finalRooms)
            if let usdz = usdz { dict["usdz"] = usdz }
            dict["mirrors"] = self.detectMirrors(rooms: finalRooms)
            await self.addSurfaces(to: &dict, rooms: finalRooms)
            if wantMesh {
                let meshInput = MeshInput(anchors: anchors, keyFrames: keys)
                let mesh = await Task.detached(priority: .userInitiated) { () -> [String: Any] in
                    return buildColoredMesh(meshInput)
                }.value
                for (k, v) in mesh { dict[k] = v }
            }
            if let hc = hdc {
                self.statusLabel.text = "Упаковываю HD-кадры для компьютера…"
                let ply = (dict["mesh"] as? String).flatMap { Data(base64Encoded: $0) }
                let res = await Task.detached(priority: .userInitiated) { () -> (String?, String?) in
                    do { return (try hc.finish(pointsPLY: ply).path, nil) } catch { return (nil, error.localizedDescription) }
                }.value
                if let path = res.0 {
                    dict["hdZip"] = path
                    dict["hdFrames"] = hc.count
                    dict["hdBytes"] = ((try? FileManager.default.attributesOfItem(atPath: path)[.size]) as? NSNumber)?.intValue ?? 0
                } else if let err = res.1 { dict["hdError"] = err }
            }
            self.sharedSession?.pause()
            self.dismiss(animated: true) { self.completion(.success(dict)) }
        }
    }

    /// Оригинальная модель RoomPlan (USDZ, как в предпросмотре) → base64; при ошибке nil.
    private func exportUSDZ(_ write: (URL) throws -> Void) -> String? {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("roomplan-\(UUID().uuidString).usdz")
        defer { try? FileManager.default.removeItem(at: url) }
        do {
            try write(url)
            return try Data(contentsOf: url).base64EncodedString()
        } catch {
            return nil
        }
    }

    /// Верхний край стены по polygonCorners (скосы, ступеньки): [[x вдоль стены от центра, высота над низом стены]].
    /// nil — стена прямоугольная.
    private func topProfile(_ s: CapturedRoom.Surface) -> [[Float]]? {
        let corners = s.polygonCorners
        guard corners.count >= 3 else { return nil }
        let w = s.dimensions.x, h = s.dimensions.y
        // углы могут прийти в локальных координатах стены или в мировых — приводим к локальным
        let looksLocal = corners.allSatisfy { abs($0.z) < 0.15 && abs($0.x) <= w / 2 + 0.3 && abs($0.y) <= h / 2 + 0.3 }
        let inv = s.transform.inverse
        let local: [simd_float3] = looksLocal ? corners : corners.map { p in
            let q = inv * simd_float4(p.x, p.y, p.z, 1)
            return simd_float3(q.x, q.y, q.z)
        }
        let minY = local.map { $0.y }.min() ?? 0
        let isBottom: (simd_float3) -> Bool = { $0.y < minY + 0.03 }
        let n = local.count
        guard let startIdx = (0..<n).first(where: { isBottom(local[$0]) && !isBottom(local[($0 + 1) % n]) }) else { return nil }
        var run: [simd_float3] = []
        var k = (startIdx + 1) % n
        while !isBottom(local[k]) && run.count < n {
            run.append(local[k])
            k = (k + 1) % n
        }
        guard run.count >= 2 else { return nil }
        if run.first!.x > run.last!.x { run.reverse() }
        let hs = run.map { $0.y - minY }
        if (hs.max()! - hs.min()!) < 0.02 { return nil }
        return run.map { [$0.x, $0.y - minY] }
    }

    // MARK: RoomCaptureSessionDelegate

    func captureSession(_ session: RoomCaptureSession, didUpdate room: CapturedRoom) {
        latestRoom = room
        if coverage != nil {
            DispatchQueue.main.async { [weak self] in
                guard let self = self else { return }
                self.currentSurfaces = coverageSurfaces(room: room, index: self.capturedRooms.count + 1)
            }
        }
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
        if let curve = s.curve {
            d["curve"] = [
                "radius": curve.radius,
                "start": curve.startAngle.converted(to: .radians).value,
                "end": curve.endAngle.converted(to: .radians).value,
            ]
        }
        if case .wall = s.category, let top = topProfile(s) { d["top"] = top }
        return d
    }

    /// Мебель и оборудование, распознанные RoomPlan: габариты, центр и направление оси X.
    private func objectDict(_ o: CapturedRoom.Object) -> [String: Any] {
        let t = o.transform
        let c = xyz(t.columns.3)
        let ax = simd_normalize(xyz(t.columns.0))
        return [
            "id": o.identifier.uuidString,
            "cat": String(describing: o.category),
            "attrs": o.attributes.map { String(describing: $0) },
            "w": o.dimensions.x, "h": o.dimensions.y, "d": o.dimensions.z,
            "cx": c.x, "cy": c.y, "cz": c.z,
            "ax": ax.x, "az": ax.z,
            "confidence": confidenceName(o.confidence),
        ]
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
        out["objects"] = room.objects.map(objectDict)
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
                    "cam": [f.camPos.x, f.camPos.y, f.camPos.z],
                    "dir": [f.camDir.x, f.camDir.y, f.camDir.z],
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
        if let hc = hdCapture, hc.consider(frame: frame, ciContext: ciContext) {
            statusLabel.text = "HD-кадров: \(hc.count) · комнат: \(capturedRooms.count + 1)"
            if let e = hc.last {
                let p = simd_float3(e.c2w.columns.3.x, e.c2w.columns.3.y, e.c2w.columns.3.z)
                coverage?.add(CovView(inv: e.c2w.inverse, fx: e.fx, fy: e.fy, cx: e.cx, cy: e.cy, w: Float(e.w), h: Float(e.h), pos: p))
            }
        }
        if coverage != nil { refreshCoverageMap() }
        if wantSurfaces { pollSurfaceFrame(frame: frame) }
        if wantFrames { pollWallFrame(frame: frame) }
    }

    /// Кадр для пола/потолка: телефон неподвижен (не смазано) и смотрит в новую сторону (≥ 14°) или сдвинулся (≥ 0,5 м).
    /// Берём только кадры, где камера наклонена к полу или к потолку больше чем на 20°.
    private func pollSurfaceFrame(frame: ARFrame) {
        let cam = frame.camera
        guard cam.trackingState == .normal, surfFrames.count < 120 else { return }
        let T = cam.transform
        let pos = xyz(T.columns.3)
        let fwd = simd_normalize(-xyz(T.columns.2))
        defer { prevSurfT = T }
        guard abs(fwd.y) > 0.34, let prev = prevSurfT else { return }
        let jitter = simd_length(pos - xyz(prev.columns.3))
        let spin = acos(max(-1, min(1, simd_dot(fwd, simd_normalize(-xyz(prev.columns.2))))))
        if jitter > 0.05 || spin > 0.06 { return }
        if let lp = lastSurfPos, let lf = lastSurfFwd {
            let moved = simd_length(pos - lp)
            let turned = acos(max(-1, min(1, simd_dot(fwd, lf))))
            if moved < 0.5 && turned < 0.25 { return }
        }
        for kf in surfFrames where simd_length(kf.pos - pos) < 0.5 && simd_dot(kf.fwd, fwd) > 0.97 { return }
        let res = cam.imageResolution
        let targetW = 480
        let targetH = Int(Double(targetW) * Double(res.height) / Double(res.width))
        let ci = CIImage(cvPixelBuffer: frame.capturedImage)
        guard let cg = ciContext.createCGImage(ci, from: ci.extent),
              let rgba = rgbaBytes(of: cg, width: targetW, height: targetH) else { return }
        let k = Float(targetW) / Float(res.width)
        let K = cam.intrinsics
        coverage?.add(CovView(inv: T.inverse, fx: K.columns.0.x * k, fy: K.columns.1.y * k, cx: K.columns.2.x * k, cy: K.columns.2.y * k,
                              w: Float(targetW), h: Float(targetH), pos: pos, target: .planes))
        surfFrames.append(KeyFrame(transformInv: T.inverse,
                                   fx: K.columns.0.x * k, fy: K.columns.1.y * k, cx: K.columns.2.x * k, cy: K.columns.2.y * k,
                                   w: targetW, h: targetH, rgba: rgba, pos: pos, fwd: fwd))
        lastSurfPos = pos; lastSurfFwd = fwd
    }

    /// Пол и потолок по комнатам в фоне (около секунды на комнату).
    private func addSurfaces(to dict: inout [String: Any], rooms: [CapturedRoom]) async {
        guard wantSurfaces, !surfFrames.isEmpty else { return }
        statusLabel.text = "Собираю пол и потолок…"
        let input = OrthoInput(rooms: orthoRooms(rooms), frames: surfFrames)
        let planes = await Task.detached(priority: .userInitiated) { () -> [[String: Any]] in
            return buildOrthos(input)
        }.value
        if !planes.isEmpty { dict["planes"] = planes }
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
        let camDir: simd_float3 = -xyz(T.columns.2)
        list.append(WallFrame(score: score, full: full, camPos: camPos, camDir: camDir, jpeg: jpeg, corners: pts, w: wall.dimensions.x, h: wall.dimensions.y))
        list.sort { $0.score > $1.score }
        if list.count > 2 { list = Array(list.prefix(2)) }
        frames[wall.identifier] = list
        let K0 = cam.intrinsics
        coverage?.add(CovView(inv: viewM, fx: K0.columns.0.x, fy: K0.columns.1.y, cx: K0.columns.2.x, cy: K0.columns.2.y,
                              w: Float(res.width), h: Float(res.height), pos: camPos, target: .wall(wall.identifier.uuidString)))
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
        coverage?.add(CovView(inv: T.inverse, fx: K.columns.0.x * k, fy: K.columns.1.y * k, cx: K.columns.2.x * k, cy: K.columns.2.y * k,
                              w: Float(targetW), h: Float(targetH), pos: pos))
        keyFrames.append(KeyFrame(transformInv: T.inverse,
                                  fx: K.columns.0.x * k, fy: K.columns.1.y * k, cx: K.columns.2.x * k, cy: K.columns.2.y * k,
                                  w: targetW, h: targetH, rgba: rgba, pos: pos, fwd: fwd))
        lastKeyPos = pos; lastKeyFwd = fwd
        statusLabel.text = "Ключевых кадров: \(keyFrames.count) · комнат: \(capturedRooms.count + 1)"
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

/// Вход для построения сетки — копируется в фоновую задачу (Sendable, без ссылок на контроллер).
struct MeshInput: @unchecked Sendable {
    let anchors: [ARMeshAnchor]
    let keyFrames: [KeyFrame]
}

/// Сетка всех mesh-якорей с цветом вершин по ближайшему подходящему ключевому кадру → PLY (base64).
func buildColoredMesh(_ input: MeshInput) -> [String: Any] {
let anchors = input.anchors
let keyFrames = input.keyFrames
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
