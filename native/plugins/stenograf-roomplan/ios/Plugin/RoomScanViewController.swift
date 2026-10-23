import UIKit
import RoomPlan
import ARKit
import CoreImage
import simd
import CoreLocation

/// Экран сканирования: RoomCaptureView + наша панель кнопок.
/// mode: "measure" — геометрия одной комнаты; "walk" — плюс автоснимки стен;
///       "multi"   — несколько комнат подряд в одной AR-сессии (StructureBuilder), кадры по флагу;
///       "final"   — как multi, плюс окрашенная 3D-сетка (финальный скан);
///       "ghost"   — AR-призрак: старое фото стены приклеивается к ней в живой картинке.
@available(iOS 17.0, *)
final class RoomScanViewController: UIViewController, RoomCaptureViewDelegate, RoomCaptureSessionDelegate {

    enum ScanError: LocalizedError {
        case cancelled, paused, failed(String)
        var errorDescription: String? {
            switch self {
            case .cancelled: return "cancelled"
            case .paused: return "paused"
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
    // всё, что нельзя потерять при выгрузке приложения, по ходу пишется в журнал на диске (ScanJournal, 2026-10-23)
    private var latestRoom: CapturedRoom? { didSet { journal?.saveCurrent(latestRoom) } }
    private var capturedRooms: [CapturedRoom] = [] { didSet { journal?.saveRooms(capturedRooms); journal?.clearCurrent() } }
    private var frames: [UUID: [WallFrame]] = [:] { didSet { journal?.saveFrames(frames, rewrite: frameRewrite) } }   // лучшие кадры по стенам
    private var frameRewrite: UUID?          // кадр, JPEG которого заменил снимок 12 Мп, — переписать в журнале
    private var journal: ScanJournal?
    var journalContext: [String: Any]?       // контекст JS (что за скан и куда сохранять) — задаёт плагин до показа
    private var pollTimer: Timer?
    private var lastTransform: simd_float4x4?
    private let ciContext = CIContext()
    private let statusLabel = UILabel()
    private var nextButton: UIButton!
    private var doneButton: UIButton!
    private var pendingAction: String = "done"      // "next" — после обработки комнаты продолжаем
    // сканы по комнатам: после каждой комнаты — проверка результата («Принять» / «Переснять»), прогресс остальных комнат не теряется
    private var buttonBar: UIStackView?
    private var reviewRoom: CapturedRoom?            // комната, которую сейчас показываем на проверку
    private var reviewPanel: UIView?
    private var discardCurrent = false               // остановить текущую комнату без обработки и начать её заново

    // финальный скан
    private var keyFrames: [KeyFrame] = []
    private var lastKeyPos: simd_float3?
    private var lastKeyFwd: simd_float3?
    private var meshAnchors: [ARMeshAnchor] = []
    // стороны света: компас + направление камеры в мире сессии → азимут севера в осях скана (усреднение по кругу)
    private let locMgr = CLLocationManager()
    private var northSin = 0.0, northCos = 0.0, northN = 0
    private var northTrue = true
    // пол и потолок обхода: кадры со всех сторон (уменьшенные, с позой камеры) → ортофото в конце
    private var surfFrames: [KeyFrame] = []
    private var lastSurfPos: simd_float3?
    private var lastSurfFwd: simd_float3?
    private var prevSurfT: simd_float4x4?
    // пол/потолок из кадров: обход этапа и отдельный скан одной поверхности (mode "surface", overlay.surface = "f" | "c")
    private var wantSurfaces: Bool { (wantFrames && (mode == "walk" || mode == "multi")) || mode == "surface" }
    private let hd: Bool                              // HD-скан: полные кадры + позы для обучения на компьютере
    private var hdCapture: HDCapture?

    // покрытие финального скана: подсветка в камере, мини-карта, проверка перед завершением
    private var coverage: CoverageModel?
    private var coverageOverlay: CoverageOverlayView?
    private var coverageMap: CoverageMapView?
    // облако точек лидара поверх камеры (кнопка слева вверху, просьба пользователя 2026-10-20 — видеть, что «видит» лидар)
    private var cloudView: PointCloudView?
    private var cloudButton: UIButton?
    private var cloudLink: CADisplayLink?
    private let cloudQueue = DispatchQueue(label: "fixpoint.cloud", qos: .userInitiated)
    private var cloudBusy = false   // сетка считается в фоне — новый расчёт не начинать
    private var cloudSuspended = false   // скан комнаты закончен (модель едет в центр, проверка) — сетку лидара не показываем
    // подсказка «чего не хватает для кадра стены» над кнопками и перекрестие в центре (кадр стены берётся по стене под центром экрана)
    private let aimLabel = UILabel()
    private let crosshair = UILabel()
    private var lastAimOK = Date.distantPast
    private var hiResCount = 0
    private var hiResBusy = false   // снимок 12 Мп в работе — следующий не запрашивать (ARKit делает их по одному)
    // кольцо вокруг перекрестия: заполняется, пока телефон неподвижен; кадр снят — вспышка (просьба пользователя 2026-10-22,
    // вместо текста «Замрите на секунду»)
    private let stillRing = StillRingView(frame: CGRect(x: 0, y: 0, width: 64, height: 64))
    private var ringLink: CADisplayLink?
    private var ringPrev: (T: simd_float4x4, t: CFTimeInterval)?
    private var coverageLink: CADisplayLink?
    private var currentSurfaces: [CovSurface] = []
    private var doneSurfaces: [CovSurface] = []      // комнаты, уже завершённые кнопкой «Следующая комната»
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
        var jpeg: Data
        let corners: [[Float]]   // 4 × [u, v] в портретном кадре: TL, TR, BR, BL для зрителя
        let w: Float
        let h: Float
        var id = UUID()          // имя файла кадра в журнале скана
    }

    private let resume: Bool                 // продолжение скана с паузы (журнал + карта места ARKit)
    private var waitingReloc = false          // ждём, пока ARKit узнает помещение по карте места
    private var pausedRooms: [CapturedRoom] = []   // комнаты, недоснятые на момент пауз, — для переноса их кадров стен

    init(mode: String, maxDim: Int, wantFrames: Bool, overlay: [String: Any]?, hd: Bool = false, resume: Bool = false,
         completion: @escaping (Result<[String: Any], Error>) -> Void) {
        self.resume = resume
        self.mode = mode
        self.hd = hd && (mode == "final" || mode == "walk" || mode == "multi")   // HD-пакет — и в обходе этапа
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
        // Своя AR-сессия с сеткой лидара и глубиной кадра, отданная RoomPlan (официальный путь с iOS 17, WWDC23 «RoomPlan»:
        // «любая своя ARSession с ARWorldTrackingConfiguration будет учтена внутри RoomCaptureSession»). Без этого RoomPlan
        // запускал свою конфигурацию без сетки — облака точек и сетки «Финала» не было (проверка на устройстве 2026-10-21).
        // boostSession() остаётся запасным вариантом, если RoomPlan всё же уберёт сетку из конфигурации.
        if mode != "ghost" {
            let s = ARSession()
            let cfg = ARWorldTrackingConfiguration()
            if ARWorldTrackingConfiguration.supportsSceneReconstruction(.mesh) { cfg.sceneReconstruction = .mesh }
            if ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth) { cfg.frameSemantics.insert(.sceneDepth) }
            // HD: формат видео, с которым ARKit умеет делать полноразмерные снимки (12 Мп) — captureHighResolutionFrame
            if hd, let f = ARWorldTrackingConfiguration.recommendedVideoFormatForHighResolutionFrameCapturing { cfg.videoFormat = f }
            // продолжение с паузы: карта места — ARKit узнаёт помещение и возвращает прежние координаты
            if resume, let map = ScanJournal.worldMap() { cfg.initialWorldMap = map; waitingReloc = true }
            s.run(cfg)
            ownSession = true
            captureView = RoomCaptureView(frame: view.bounds, arSession: s)
        } else {
            captureView = RoomCaptureView(frame: view.bounds)
        }
        captureView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        captureView.delegate = self
        captureView.captureSession.delegate = self
        view.addSubview(captureView)
        sharedSession = captureView.captureSession.arSession

        let bar = UIStackView()
        // круглые стеклянные кнопки по углам (просьба пользователя 2026-10-13, по образцу сканера с прозрачными кнопками):
        // слева крестик — отмена, справа галочка — готово/сохранить; середина свободна для мини-модели RoomPlan
        bar.axis = .horizontal
        bar.distribution = .equalSpacing
        bar.alignment = .center
        bar.translatesAutoresizingMaskIntoConstraints = false
        let cancel = GlassButton(symbol: "xmark", label: "Отмена")
        cancel.addTarget(self, action: #selector(cancelTapped), for: .touchUpInside)
        bar.addArrangedSubview(cancel)
        if isMulti {
            nextButton = GlassButton(title: "Следующая комната")
            nextButton.addTarget(self, action: #selector(nextTapped), for: .touchUpInside)
            bar.addArrangedSubview(nextButton)
        }
        // сканы по комнатам: клетчатый флаг «закончить всё» (галочка путалась с «комната готова»); одиночные — галочка
        doneButton = GlassButton(symbol: isMulti ? "flag.checkered" : "checkmark", label: isMulti ? "Закончить и сохранить квартиру" : "Готово", tint: UIColor(red: 0.91, green: 0.44, blue: 0.18, alpha: 1))
        doneButton.addTarget(self, action: #selector(doneTapped), for: .touchUpInside)
        bar.addArrangedSubview(doneButton)
        view.addSubview(bar)
        buttonBar = bar

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
            bar.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 28),
            bar.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -28),
            bar.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -14),
            bar.heightAnchor.constraint(equalToConstant: GlassButton.side),
            statusLabel.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 16),
            statusLabel.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -16),
            statusLabel.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 8),
            statusLabel.heightAnchor.constraint(greaterThanOrEqualToConstant: 40),
        ])

        if mode == "ghost" { setupGhost(bar: bar) }
        if mode != "ghost" { setupCompass(); setupCloudToggle() }
        if wantFrames { setupAimHint(above: bar) }
        if resume {
            // продолжение с паузы: принятые комнаты, кадры стен и HD-кадры — из журнала, дальше пишем в тот же журнал
            if hd { hdCapture = ScanJournal.hdDir.flatMap { HDCapture(restoring: $0) } ?? HDCapture() }
            pausedRooms = ScanJournal.pausedRooms()
            frames = ScanJournal.frames()
            capturedRooms = ScanJournal.rooms()
            journal = ScanJournal(resuming: frames)
        } else {
            if hd { hdCapture = HDCapture() }
            // журнал — для обходов и сканов по комнатам (долгие); короткие обмер комнаты, пол/потолок и призрак — без него
            if mode == "walk" || isMulti {
                journal = ScanJournal(mode: mode, hd: hd, wantFrames: wantFrames, maxDim: maxDim, hdDir: hdCapture?.dir, context: journalContext)
            }
        }
        if mode == "final" || wantSurfaces { setupCoverage() }
    }

    // MARK: подсказка съёмки стен (2026-10-21: пользователь 20 с пытался снять кусок стены — не зеленел, и непонятно почему)

    private func setupAimHint(above bar: UIView) {
        aimLabel.textColor = .white
        aimLabel.font = .systemFont(ofSize: 13, weight: .semibold)
        aimLabel.textAlignment = .center
        aimLabel.numberOfLines = 2
        aimLabel.backgroundColor = UIColor(red: 0.85, green: 0.37, blue: 0.09, alpha: 0.88)
        aimLabel.layer.cornerRadius = 10
        aimLabel.clipsToBounds = true
        aimLabel.isHidden = true
        aimLabel.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(aimLabel)
        crosshair.text = "+"
        crosshair.textColor = UIColor(white: 1, alpha: 0.85)
        crosshair.font = .systemFont(ofSize: 34, weight: .light)
        crosshair.layer.shadowColor = UIColor.black.cgColor
        crosshair.layer.shadowOpacity = 0.6
        crosshair.layer.shadowRadius = 2
        crosshair.layer.shadowOffset = .zero
        crosshair.translatesAutoresizingMaskIntoConstraints = false
        crosshair.isUserInteractionEnabled = false
        view.addSubview(crosshair)
        stillRing.translatesAutoresizingMaskIntoConstraints = false
        view.insertSubview(stillRing, belowSubview: crosshair)
        let rl = CADisplayLink(target: self, selector: #selector(ringTick))
        rl.preferredFramesPerSecond = 30
        rl.add(to: .main, forMode: .common)
        ringLink = rl
        NSLayoutConstraint.activate([
            stillRing.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            stillRing.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            stillRing.widthAnchor.constraint(equalToConstant: 64), stillRing.heightAnchor.constraint(equalToConstant: 64),
            aimLabel.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            aimLabel.widthAnchor.constraint(lessThanOrEqualTo: view.widthAnchor, constant: -40),
            // сверху, под строкой статуса и мини-картой (128 + отступы): внизу подсказка закрывала мини-модель RoomPlan (замечание пользователя 2026-10-22)
            aimLabel.topAnchor.constraint(equalTo: statusLabel.bottomAnchor, constant: 8 + 128 + 10),
            aimLabel.heightAnchor.constraint(greaterThanOrEqualToConstant: 34),
            crosshair.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            crosshair.centerYAnchor.constraint(equalTo: view.centerYAnchor),
        ])
    }

    /// Скорость телефона по кадру ARKit: медленнее порогов съёмки (≈ 12 см/с и 0,12 рад/с — как «≤ 5 см / 0,05 рад за 0,4 с»)
    /// — кольцо заполняется за 0,8 с, иначе быстро опустошается.
    @objc private func ringTick(_ link: CADisplayLink) {
        guard let frame = sharedSession?.currentFrame, reviewRoom == nil, !finished else { stillRing.setProgress(0); return }
        let T = frame.camera.transform, now = link.timestamp
        defer { ringPrev = (T, now) }
        guard let prev = ringPrev, now > prev.t, frame.camera.trackingState == .normal else { stillRing.setProgress(0); return }
        let dt = Float(now - prev.t)
        let v = simd_length(xyz(T.columns.3) - xyz(prev.T.columns.3)) / dt
        let w = acos(max(-1, min(1, simd_dot(simd_normalize(-xyz(T.columns.2)), simd_normalize(-xyz(prev.T.columns.2)))))) / dt
        let still = v < 0.12 && w < 0.12
        stillRing.setProgress(still ? min(1, stillRing.progress + CGFloat(dt / 0.8)) : max(0, stillRing.progress - CGFloat(dt * 4)))
    }

    /// nil — всё в порядке (кадр снят или снимать нечего); иначе — что мешает. Показ с задержкой 1,2 с, чтобы не мигало на ходу.
    private func setAim(_ text: String?) {
        guard wantFrames else { return }
        if text == nil { lastAimOK = Date(); aimLabel.isHidden = true; return }
        if Date().timeIntervalSince(lastAimOK) < 1.2 { return }
        aimLabel.text = "  " + text! + "  "
        aimLabel.isHidden = reviewRoom != nil || finished
    }

    /// Почему центр экрана не попадает ни в одну стену (для подсказки).
    private func aimProblem(in room: CapturedRoom, camera cam: ARCamera) -> String {
        let T = cam.transform
        let camPos = xyz(T.columns.3)
        let fwd = simd_normalize(-xyz(T.columns.2))
        var oblique = false, tooClose = false, tooFar = false
        for wall in room.walls {
            let t = wall.transform
            let c = xyz(t.columns.3)
            let n = simd_normalize(xyz(t.columns.2))
            let denom: Float = simd_dot(fwd, n)
            if abs(denom) < 0.05 { continue }
            let dist: Float = simd_dot(c - camPos, n) / denom
            if dist <= 0 { continue }
            let rel: simd_float3 = camPos + fwd * dist - c
            let lx = simd_dot(rel, simd_normalize(xyz(t.columns.0))), ly = simd_dot(rel, simd_normalize(xyz(t.columns.1)))
            guard abs(lx) <= wall.dimensions.x / 2, abs(ly) <= wall.dimensions.y / 2 else { continue }
            if abs(denom) < 0.35 { oblique = true } else if dist < 0.6 { tooClose = true } else if dist > 7 { tooFar = true }
        }
        if tooClose { return "Слишком близко — отойдите от стены (нужно от 0,6 м)" }
        if oblique { return "Слишком сбоку — встаньте к стене прямее" }
        if tooFar { return "Слишком далеко — подойдите ближе (до 7 м)" }
        return "Наведите центр экрана (+) на неснятый кусок стены"
    }

    /// HD: что с клеткой стены под перекрестием — «подойдите ближе» (нет кадра с 1,5 м), «ещё с другой точки» (кадров < 2).
    private func hdAim(frame: ARFrame) {
        guard let room = latestRoom, let model = coverage, frame.camera.trackingState == .normal else { return }
        // телефон в движении — подсказку «Замрите» уже поставил pollWallFrame
        if let last = lastTransform, simd_length(xyz(frame.camera.transform.columns.3) - xyz(last.columns.3)) > 0.05 { return }
        guard let (wall, _) = bestWall(in: room, camera: frame.camera) else { return }
        let T = frame.camera.transform
        let camPos = xyz(T.columns.3), fwd = simd_normalize(-xyz(T.columns.2))
        let n = simd_normalize(xyz(wall.transform.columns.2)), c0 = xyz(wall.transform.columns.3)
        let denom = simd_dot(fwd, n)
        guard abs(denom) > 0.05 else { return }
        let dist = simd_dot(c0 - camPos, n) / denom
        let hit = camPos + fwd * dist
        guard let surf = currentSurfaces.first(where: { $0.isWall && $0.key.contains(wall.identifier.uuidString) }), !surf.cells.isEmpty else { return }
        var bi = 0; var bd = Float.greatestFiniteMagnitude
        for (i, cell) in surf.cells.enumerated() { let d = simd_length(cell.center - hit); if d < bd { bd = d; bi = i } }
        let (cnt, close) = model.raw(surf)
        guard bi < cnt.count else { return }
        if close[bi] > 0 && cnt[bi] >= model.need { setAim(nil); return }
        if close[bi] == 0 && dist > 1.5 { setAim("Подойдите ближе — для деталей нужен кадр с 1,5 м и ближе"); return }
        if close[bi] == 0 { setAim("Замрите на секунду — снимается кадр вблизи"); return }
        setAim("Снимите это место ещё с другой точки — шаг в сторону")
    }

    // MARK: облако точек лидара

    private var boosted = false
    private var ownSession = false   // сессия создана нами (с сеткой и глубиной) и отдана RoomPlan
    /// Добавить к конфигурации RoomPlan сетку лидара и карту глубины кадра (если устройство умеет), не сбрасывая сессию.
    private func boostSession() {
        guard !finished, let s = sharedSession, let cfg = s.configuration as? ARWorldTrackingConfiguration else { return }
        var changed = false
        if ARWorldTrackingConfiguration.supportsSceneReconstruction(.mesh) && cfg.sceneReconstruction != .mesh {
            cfg.sceneReconstruction = .mesh; changed = true
        }
        if ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth) && !cfg.frameSemantics.contains(.sceneDepth) {
            cfg.frameSemantics.insert(.sceneDepth); changed = true
        }
        boosted = true
        if changed { s.run(cfg, options: []) }
    }

    /// Что из лидара сейчас доступно — для надписи на облаке точек.
    private func lidarDiag(_ frame: ARFrame, anchors: Int) -> String {
        let cfg = sharedSession?.configuration as? ARWorldTrackingConfiguration
        let rec = cfg.map { $0.sceneReconstruction == .mesh ? "вкл" : "выкл" } ?? "?"
        let dep = (frame.sceneDepth ?? frame.smoothedSceneDepth) != nil ? "есть" : "нет"
        return "сетка: \(anchors) · реконструкция: \(rec) · глубина кадра: \(dep) · сессия: \(ownSession ? "своя" : "RoomPlan")\(boosted ? " · дожимали" : "")"
    }

    private func setupCloudToggle() {
        let b = UIButton(type: .system)
        b.translatesAutoresizingMaskIntoConstraints = false
        b.setImage(UIImage(systemName: "circle.dotted", withConfiguration: UIImage.SymbolConfiguration(pointSize: 20, weight: .semibold)), for: .normal)
        b.tintColor = .white
        b.layer.cornerRadius = 22
        b.layer.cornerCurve = .continuous
        b.layer.borderWidth = 1
        b.layer.borderColor = UIColor(white: 1, alpha: 0.38).cgColor
        b.accessibilityLabel = "Облако точек лидара"
        b.addTarget(self, action: #selector(cloudTapped), for: .touchUpInside)
        view.addSubview(b)
        NSLayoutConstraint.activate([
            b.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 16),
            b.topAnchor.constraint(equalTo: statusLabel.bottomAnchor, constant: 8),
            b.widthAnchor.constraint(equalToConstant: 44), b.heightAnchor.constraint(equalToConstant: 44),
        ])
        cloudButton = b
        setCloud(UserDefaults.standard.bool(forKey: "fixpoint.showCloud"))
    }

    @objc private func cloudTapped() {
        let on = cloudView == nil
        UserDefaults.standard.set(on, forKey: "fixpoint.showCloud")
        setCloud(on)
    }

    private func setCloud(_ on: Bool) {
        cloudButton?.backgroundColor = on ? UIColor(red: 0.85, green: 0.37, blue: 0.09, alpha: 0.85) : UIColor(white: 0, alpha: 0.35)
        if on, cloudView == nil {
            if !boosted { DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in self?.boostSession() } }
            let cv = PointCloudView(frame: view.bounds)
            cv.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            view.insertSubview(cv, aboveSubview: captureView)
            cloudView = cv
            let link = CADisplayLink(target: self, selector: #selector(cloudTick))
            link.preferredFramesPerSecond = 6
            link.add(to: .main, forMode: .common)
            cloudLink = link
            suspendCloud(cloudSuspended)
        } else if !on {
            cloudLink?.invalidate(); cloudLink = nil
            cloudView?.removeFromSuperview(); cloudView = nil
        }
    }

    /// 2026-10-22, просьба пользователя: после окончания скана комнаты (готовая модель едет в центр экрана) сетку лидара выключать;
    /// при следующей комнате — снова как была. Кнопка облака остаётся как есть.
    private func suspendCloud(_ s: Bool) {
        cloudSuspended = s
        cloudView?.isHidden = s
        cloudLink?.isPaused = s
    }

    @objc private func cloudTick() {
        guard let cv = cloudView, !cloudBusy, let frame = sharedSession?.currentFrame else { return }
        let anchors = frame.anchors.compactMap { $0 as? ARMeshAnchor }
        if anchors.isEmpty { cv.update(frame: frame, anchors: anchors, diag: lidarDiag(frame, anchors: 0)); return }
        // 2026-10-22: фризы по 0,3–0,5 с каждую секунду (запись пользователя) — рёбра сетки считались на главном потоке
        // через projectPoint на каждую вершину всей комнаты. Теперь: матрицы берём здесь, проекция — в фоне, по одному расчёту за раз
        let size = cv.bounds.size
        let cam = frame.camera
        let vp = cam.projectionMatrix(for: .portrait, viewportSize: size, zNear: 0.1, zFar: 20) * cam.viewMatrix(for: .portrait)
        let camPos = simd_float3(cam.transform.columns.3.x, cam.transform.columns.3.y, cam.transform.columns.3.z)
        cloudBusy = true
        cloudQueue.async { [weak self, weak cv] in
            let path = meshWirePath(anchors: anchors, viewProj: vp, camPos: camPos, size: size)
            DispatchQueue.main.async {
                self?.cloudBusy = false
                cv?.setWire(path)
            }
        }
    }

    // MARK: покрытие

    private func setupCoverage() {
        // HD (2026-10-21, «максимально подробная съёмка»): клетки 20 см, на клетку 2 кадра, из них хотя бы один с 1,5 м и ближе;
        // считаются и HD-кадры. Обычный обход — клетки 40 см, 1 кадр.
        coverageCellSize = hd ? 0.2 : 0.4
        let model = hd ? CoverageModel(need: 2, closeDist: 1.5) : CoverageModel(need: 1)
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
                                   message: "Не сняты (не зелёные на мини-карте и в камере):\n\n\(shown)",
                                   preferredStyle: .alert)
        ac.addAction(UIAlertAction(title: "Доснять", style: .cancel))
        ac.addAction(UIAlertAction(title: currentOnly ? "Дальше всё равно" : "Сохранить всё равно", style: .default) { [weak self] _ in
            self?.coverageChecked = true
            proceed()
            self?.coverageChecked = false
        })
        present(ac, animated: true)
        return false
    }

    private func initialHint() -> String {
        switch mode {
        case "surface":
            let what = (overlayParams?["surface"] as? String) == "f" ? "пол" : "потолок"
            return "Скан: \(what). Сначала обведите камерой стены комнаты, потом медленно ведите телефоном по поверхности — снятое подсвечивается зелёным. В конце «Готово»"
        case "walk": return hd
            ? "HD-обход: идите медленно двумя кругами — телефон на уровне груди, потом над головой; захватывайте пол и потолок. HD-кадр снимается, когда телефон неподвижен и картинка резкая. Снятое подсвечивается зелёным"
            : "Обход этапа: медленно ведите телефон вдоль стен и наклоняйте к полу и потолку — кадры снимутся сами. Снятое подсвечивается зелёным"
        case "multi": return hd
            ? "HD-обход квартиры: в каждой комнате медленно два круга — на уровне груди и над головой, с полом и потолком; HD-кадр снимается, когда телефон неподвижен. Всё зелёное — «Следующая комната»"
            : wantFrames
            ? "Обход квартиры: пройдите вдоль стен, наклоняя телефон к полу и потолку. Всё зелёное — «Следующая комната»"
            : "Обмер квартиры: обойдите комнату, нажмите «Следующая комната», перейдите в другую. В конце — флаг 🏁"
        case "final": return hd
            ? "HD-скан: идите медленно и замирайте — кадр снимается, когда телефон неподвижен. Снятое подсвечивается зелёным"
            : "Финальный скан: наводите телефон на всё, что ещё не зелёное. Тап по карте — спрятать подсветку"
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
        // во время скана экран не гаснет и телефон не блокируется (обмер квартиры идёт долго, экрана не касаются)
        UIApplication.shared.isIdleTimerDisabled = true
        if waitingReloc { waitForRelocalization() } else { runCapture() }
    }

    /// Продолжение с паузы: RoomPlan запускаем только после того, как ARKit узнал помещение по карте места
    /// (до этого координаты другие — кадры и комнаты не совпали бы с уже снятыми).
    private var relocTimer: Timer?
    private var relocStart = Date()
    private func waitForRelocalization() {
        relocStart = Date()
        statusLabel.text = "Продолжаем скан. Наведите камеру на уже снятое место и медленно поводите — телефон ищет, где вы"
        relocTimer?.invalidate()
        relocTimer = Timer.scheduledTimer(withTimeInterval: 0.3, repeats: true) { [weak self] _ in
            guard let self = self, !self.finished, let f = self.sharedSession?.currentFrame else { return }
            if case .normal = f.camera.trackingState {
                self.relocTimer?.invalidate(); self.relocTimer = nil
                self.waitingReloc = false
                self.statusLabel.text = "Место найдено — продолжаем. Принято комнат: \(self.capturedRooms.count)"
                self.runCapture()
            } else if Date().timeIntervalSince(self.relocStart) > 40 {
                self.relocTimer?.invalidate(); self.relocTimer = nil
                self.relocFailed()
            }
        }
    }

    private func relocFailed() {
        let ac = UIAlertController(title: "Не узнаю помещение",
                                   message: "Телефон не нашёл уже снятое место. Подойдите туда, где остановились, и попробуйте ещё — или сохраните снятое до паузы и доснимите остальное новым обходом.",
                                   preferredStyle: .alert)
        ac.addAction(UIAlertAction(title: "Ещё попробовать", style: .default) { [weak self] _ in self?.waitForRelocalization() })
        ac.addAction(UIAlertAction(title: "Сохранить снятое", style: .default) { [weak self] _ in self?.saveAndFinish() })
        present(ac, animated: true)
    }

    /// Пауза: журнал уже на диске; добавляем карту места ARKit и недоснятую комнату, закрываем сканер.
    /// Продолжение — новый вызов scan с resume (JS спрашивает «Продолжить скан на паузе?»).
    private func pauseScan() {
        guard !finished else { return }
        pollTimer?.invalidate(); pollTimer = nil
        relocTimer?.invalidate(); relocTimer = nil
        nextButton?.isEnabled = false; doneButton?.isEnabled = false
        statusLabel.text = "Сохраняю скан для продолжения…"
        if !waitingReloc { journal?.savePausedRoom(latestRoom) }
        let finishPause: (ARWorldMap?) -> Void = { [weak self] map in
            guard let self = self, !self.finished else { return }
            if let m = map { self.journal?.saveWorldMap(m) }
            self.hdCapture?.flushJournal()
            self.journal?.markPaused(hasMap: map != nil || ScanJournal.worldMap() != nil)
            self.finished = true
            self.stopCoverage()
            self.captureView.captureSession.stop(pauseARSession: true)
            self.dismiss(animated: true) { self.completion(.failure(ScanError.paused)) }
        }
        // пока помещение не узнано, карта места — прежняя (новую не снимаем: она была бы в чужих координатах)
        guard !waitingReloc, let sess = sharedSession else { finishPause(nil); return }
        sess.getCurrentWorldMap { map, _ in DispatchQueue.main.async { finishPause(map) } }
    }

    private func runCapture() {
        var config = RoomCaptureSession.Configuration()
        config.isCoachingEnabled = mode != "ghost"
        captureView.captureSession.run(configuration: config)
        // RoomPlan запускает свою конфигурацию без сетки (ARMeshAnchor) и, возможно, без sceneDepth — на устройстве
        // кнопка облака показала «сетки нет» (2026-10-21). Через секунду после старта добавляем их к его же конфигурации
        // (без сброса сессии). Нужно для HD-пакета (облако точек, глубина) и кнопки облака; обычный обмер не трогаем.
        if hd || mode == "final" || cloudView != nil {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in self?.boostSession() }
        }
        if hd {
            // экспозиция и баланс белого: дать автомату 2 с подстроиться под комнату и зафиксировать до конца комнаты
            HDCapture.setCameraLocked(false)
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in if self?.finished == false { HDCapture.setCameraLocked(true) } }
        }
        if pollTimer == nil {
            pollTimer = Timer.scheduledTimer(withTimeInterval: 0.4, repeats: true) { [weak self] _ in self?.poll() }
        }
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        UIApplication.shared.isIdleTimerDisabled = false   // вернуть обычное автогашение экрана
        if hd { HDCapture.setCameraLocked(false) }
        locMgr.stopUpdatingHeading(); locMgr.stopUpdatingLocation()
        stopCoverage()   // CADisplayLink держит контроллер — отпускаем при любом закрытии экрана
        cloudLink?.invalidate(); cloudLink = nil
        ringLink?.invalidate(); ringLink = nil
    }

    override var prefersStatusBarHidden: Bool { true }
    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { .portrait }

    // MARK: кнопки

    @objc private func cancelTapped() {
        guard !finished else { return }
        // скан по комнатам: «Отмена» не сбрасывает всё сразу — можно переснять только текущую комнату,
        // а отмена всего обмера — отдельным пунктом с подтверждением
        if isMulti {
            let n = capturedRooms.count
            let ac = UIAlertController(title: "Что отменить?",
                                       message: n > 0 ? "Уже принято комнат: \(n). Они сохранятся, если переснять только текущую." : nil,
                                       preferredStyle: .actionSheet)
            ac.addAction(UIAlertAction(title: "Переснять эту комнату", style: .default) { [weak self] _ in self?.restartCurrentRoom() })
            if journal != nil {
                ac.addAction(UIAlertAction(title: "Пауза — продолжить позже", style: .default) { [weak self] _ in self?.pauseScan() })
            }
            // сохранить готовое сейчас, остальные комнаты — потом новым обходом (добавятся к той же схеме)
            if !savableRooms().isEmpty {
                ac.addAction(UIAlertAction(title: "Сохранить готовое и закончить", style: .default) { [weak self] _ in self?.saveAndFinish() })
            }
            ac.addAction(UIAlertAction(title: "Отменить весь обмер", style: .destructive) { [weak self] _ in self?.confirmCancelAll() })
            ac.addAction(UIAlertAction(title: "Продолжить скан", style: .cancel))
            present(ac, animated: true)
            return
        }
        if journal != nil {   // обход комнаты: тоже можно поставить на паузу
            let ac = UIAlertController(title: "Остановить обход?", message: nil, preferredStyle: .actionSheet)
            ac.addAction(UIAlertAction(title: "Пауза — продолжить позже", style: .default) { [weak self] _ in self?.pauseScan() })
            ac.addAction(UIAlertAction(title: "Отменить обход", style: .destructive) { [weak self] _ in self?.cancelAll() })
            ac.addAction(UIAlertAction(title: "Продолжить скан", style: .cancel))
            present(ac, animated: true)
            return
        }
        cancelAll()
    }

    private func confirmCancelAll() {
        let n = capturedRooms.count + (reviewRoom != nil ? 1 : 0)
        // второй вопрос — только когда есть что терять (уже отсканированные комнаты); иначе закрываем сразу
        if n == 0 { cancelAll(); return }
        let ac = UIAlertController(title: "Отменить весь обмер?",
                                   message: n > 0 ? "Будут потеряны все отсканированные комнаты (\(n)) и текущая." : "Скан будет закрыт без сохранения.",
                                   preferredStyle: .alert)
        ac.addAction(UIAlertAction(title: "Нет, вернуться", style: .cancel))
        ac.addAction(UIAlertAction(title: "Отменить всё", style: .destructive) { [weak self] _ in self?.cancelAll() })
        present(ac, animated: true)
    }

    /// Текущая комната — заново: её скан останавливается без обработки, принятые комнаты остаются.
    private func restartCurrentRoom() {
        guard !finished else { return }
        if reviewRoom != nil { rejectReview(); return }
        currentSurfaces = []
        discardCurrent = true
        nextButton?.isEnabled = false; doneButton.isEnabled = false
        statusLabel.text = "Начинаю комнату заново…"
        suspendCloud(true)
        captureView.captureSession.stop(pauseARSession: false)
    }

    private func cancelAll() {
        guard !finished else { return }
        finished = true
        pollTimer?.invalidate()
        stopCoverage()
        captureView.captureSession.stop(pauseARSession: true)
        hdCapture?.discard()
        dismiss(animated: true) { self.completion(.failure(ScanError.cancelled)) }
    }

    /// Стен меньше трёх — комнату из такого скана не собрать. Говорим сразу, в сканере, пока можно доснять
    /// (раньше об этом узнавали только после закрытия сканера и ввода названия). true — можно продолжать.
    private var skipWallCheck = false
    private func confirmWalls(proceed: @escaping () -> Void) -> Bool {
        if skipWallCheck { return true }   // «Всё равно завершить» — до следующей комнаты больше не спрашиваем
        guard mode != "ghost" else { return true }
        let n = latestRoom?.walls.filter { $0.dimensions.x > 0.15 }.count ?? 0
        if n >= 3 { return true }
        let ac = UIAlertController(title: "Мало стен",
                                   message: "Найдено стен: \(n). Чтобы построить комнату, нужно минимум три — обойдите комнату вдоль стен, заглядывая в углы.",
                                   preferredStyle: .alert)
        ac.addAction(UIAlertAction(title: "Продолжить скан", style: .cancel))
        ac.addAction(UIAlertAction(title: "Всё равно завершить", style: .destructive) { [weak self] _ in
            self?.skipWallCheck = true
            proceed()
        })
        present(ac, animated: true)
        return false
    }

    @objc private func nextTapped() {
        guard confirmWalls(proceed: { [weak self] in self?.nextTapped() }) else { return }
        guard confirmCoverage(currentOnly: true, proceed: { [weak self] in self?.nextTapped() }) else { return }
        pendingAction = "next"
        nextButton.isEnabled = false; doneButton.isEnabled = false
        statusLabel.text = "Обрабатываю комнату…"
        suspendCloud(true)
        captureView.captureSession.stop(pauseARSession: false)   // AR-сессия живёт дальше — общие координаты
    }

    /// сканы по комнатам: кнопка-флаг завершает всю квартиру — сначала спрашиваем (2026-10-19, просьба пользователя)
    private var finishConfirmed = false
    @objc private func doneTapped() {
        if isMulti && !finishConfirmed {
            let n = capturedRooms.count
            let ac = UIAlertController(title: "Закончить и сохранить квартиру?",
                                       message: n > 0 ? "Принято комнат: \(n). Текущую комнату покажем на проверку, затем всё сохранится." : "Текущую комнату покажем на проверку, затем всё сохранится.",
                                       preferredStyle: .alert)
            ac.addAction(UIAlertAction(title: "Продолжить скан", style: .cancel))
            ac.addAction(UIAlertAction(title: "Закончить", style: .default) { [weak self] _ in
                self?.finishConfirmed = true
                self?.doneTapped()
            })
            present(ac, animated: true)
            return
        }
        guard confirmWalls(proceed: { [weak self] in self?.doneTapped() }) else { finishConfirmed = false; return }
        guard confirmCoverage(currentOnly: false, proceed: { [weak self] in self?.doneTapped() }) else { finishConfirmed = false; return }
        finishConfirmed = false
        pendingAction = "done"
        if !isMulti { pollTimer?.invalidate(); pollTimer = nil; stopCoverage() }
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
        suspendCloud(true)
        captureView.captureSession.stop(pauseARSession: false)
    }

    // MARK: RoomCaptureViewDelegate

    func captureView(shouldPresent roomDataForProcessing: CapturedRoomData, error: Error?) -> Bool {
        if finished { return false }            // пауза или отмена — обработка комнаты не нужна
        if discardCurrent {                     // «Переснять эту комнату» во время скана: результат не нужен
            discardCurrent = false
            DispatchQueue.main.async { [weak self] in self?.startNextRoom() }
            return false
        }
        return true
    }

    func captureView(didPresent processedResult: CapturedRoom, error: Error?) {
        guard !finished else { return }
        if let error = error { scanInterrupted(error); return }
        if isMulti {                             // по комнатам: сначала показать результат на проверку
            showReview(processedResult)
            return
        }
        capturedRooms.append(processedResult)
        finished = true
        pollTimer?.invalidate()
        finishSingle(processedResult)
    }

    // MARK: проверка комнаты после скана

    /// Сводка по комнате: площадь, габариты, сколько стен/проёмов/предметов.
    /// Площадь пола («11.7 м²», nil — пол не распознан) и габариты комнаты («4.6 × 3.0 × 3.0 м», nil — нет стен).
    private func roomSummary(_ room: CapturedRoom) -> (area: String?, dims: String?) {
        var minX = Float.greatestFiniteMagnitude, maxX = -Float.greatestFiniteMagnitude
        var minZ = Float.greatestFiniteMagnitude, maxZ = -Float.greatestFiniteMagnitude
        var height: Float = 0
        for w in room.walls {
            let c = xyz(w.transform.columns.3)
            let ax = simd_normalize(xyz(w.transform.columns.0))
            let half: Float = w.dimensions.x / 2
            for p in [c - ax * half, c + ax * half] {
                minX = min(minX, p.x); maxX = max(maxX, p.x)
                minZ = min(minZ, p.z); maxZ = max(maxZ, p.z)
            }
            height = max(height, w.dimensions.y)
        }
        guard !room.walls.isEmpty else { return (nil, nil) }
        let a: Float = maxX - minX, b: Float = maxZ - minZ
        var area: Float = 0
        for f in room.floors { area += f.dimensions.x * f.dimensions.y }
        return (area > 0.5 ? String(format: "%.1f м²", area) : nil,
                String(format: "%.1f × %.1f × %.1f м", max(a, b), min(a, b), height))
    }

    private func showReview(_ room: CapturedRoom) {
        reviewRoom = room
        buttonBar?.isHidden = true
        coverageOverlay?.isHidden = true
        let n = capturedRooms.count + 1
        statusLabel.text = "Комната \(n): проверьте результат — модель можно покрутить пальцем"

        // прозрачное (стеклянное) окно со сводкой: название, площадь и габариты, значки «стены · двери · окна» с числом;
        // под ним — круглые стеклянные кнопки, как при скане: слева «повтор» (переснять), справа галочка (принять)
        let glass = UIVisualEffectView(effect: UIBlurEffect(style: .systemUltraThinMaterialDark))
        glass.layer.cornerRadius = 22
        glass.layer.cornerCurve = .continuous
        glass.layer.masksToBounds = true
        glass.layer.borderWidth = 1
        glass.layer.borderColor = UIColor(white: 1, alpha: 0.3).cgColor
        glass.contentView.backgroundColor = UIColor(white: 0, alpha: 0.22)   // фон проверки светлый — без затемнения белый текст не читается
        if applyLiquidGlass(glass, tint: nil) { glass.layer.borderWidth = 0 }

        let title = UILabel()
        title.text = "Комната \(n)"
        title.textColor = .white
        title.font = .systemFont(ofSize: 17, weight: .semibold)

        // площадь пола и габариты — значок + значение (вместо слов «Пол ≈» и «габариты»)
        func measure(_ symbol: String, _ text: String, _ name: String) -> UIView {
            let iv = UIImageView(image: UIImage(systemName: symbol, withConfiguration: UIImage.SymbolConfiguration(pointSize: 15, weight: .medium)))
            iv.tintColor = UIColor(white: 1, alpha: 0.85)
            iv.contentMode = .scaleAspectFit
            iv.setContentHuggingPriority(.required, for: .horizontal)
            let l = UILabel()
            l.text = text
            l.textColor = UIColor(white: 1, alpha: 0.9)
            l.font = .monospacedDigitSystemFont(ofSize: 15, weight: .regular)
            let st = UIStackView(arrangedSubviews: [iv, l])
            st.axis = .horizontal
            st.spacing = 6
            st.alignment = .center
            st.isAccessibilityElement = true
            st.accessibilityLabel = "\(name): \(text)"
            return st
        }
        let sum = roomSummary(room)
        let info = UIStackView()
        info.axis = .horizontal
        info.distribution = .equalSpacing
        if let area = sum.area { info.addArrangedSubview(measure("square.fill", area, "Площадь пола")) }
        if let dims = sum.dims { info.addArrangedSubview(measure("ruler", dims, "Габариты")) }
        if info.arrangedSubviews.count == 1 { info.addArrangedSubview(UIView()) }   // одно значение — прижато влево
        info.isHidden = info.arrangedSubviews.isEmpty

        func stat(_ symbol: String, _ count: Int, _ name: String) -> UIView {
            let iv = UIImageView(image: UIImage(systemName: symbol, withConfiguration: UIImage.SymbolConfiguration(pointSize: 20, weight: .medium)))
            iv.tintColor = .white
            iv.contentMode = .scaleAspectFit
            let l = UILabel()
            l.text = "\(count)"
            l.textColor = .white
            l.font = .monospacedDigitSystemFont(ofSize: 20, weight: .semibold)
            let row = UIStackView(arrangedSubviews: [iv, l])
            row.axis = .horizontal
            row.spacing = 8
            row.alignment = .center
            let cap = UILabel()   // подпись под значком: «Стены», «Двери», «Окна»
            cap.text = name
            cap.textColor = UIColor(white: 1, alpha: 0.7)
            cap.font = .systemFont(ofSize: 12)
            let st = UIStackView(arrangedSubviews: [row, cap])
            st.axis = .vertical
            st.spacing = 3
            st.alignment = .center
            st.isAccessibilityElement = true
            st.accessibilityLabel = "\(name): \(count)"
            return st
        }
        let stats = UIStackView(arrangedSubviews: [
            stat("rectangle.split.3x1", room.walls.count, "Стены"),
            stat("door.left.hand.open", room.doors.count, "Двери"),
            stat("window.vertical.closed", room.windows.count, "Окна"),
        ])
        stats.axis = .horizontal
        stats.distribution = .equalSpacing

        let stack = UIStackView(arrangedSubviews: [title, info, stats])
        // из комнаты, где стен меньше трёх, схему не собрать — говорим об этом здесь же, а не молча пропускаем потом
        if room.walls.filter({ $0.dimensions.x > 0.15 }).count < 3 {
            let warn = UILabel()
            warn.text = "Стен меньше трёх — такая комната на схему не попадёт. Лучше переснять."
            warn.textColor = UIColor(red: 1, green: 0.78, blue: 0.45, alpha: 1)
            warn.font = .systemFont(ofSize: 14, weight: .semibold)
            warn.numberOfLines = 0
            stack.addArrangedSubview(warn)
        }
        stack.axis = .vertical
        stack.spacing = 10
        stack.setCustomSpacing(14, after: info)
        stack.translatesAutoresizingMaskIntoConstraints = false
        glass.contentView.addSubview(stack)

        let redo = GlassButton(symbol: "arrow.clockwise", label: "Переснять")
        redo.addTarget(self, action: #selector(rejectReviewTapped), for: .touchUpInside)
        let ok = GlassButton(symbol: "checkmark", label: pendingAction == "next" ? "Принять" : "Принять и сохранить",
                             tint: UIColor(red: 0.91, green: 0.44, blue: 0.18, alpha: 1))
        ok.addTarget(self, action: #selector(acceptReviewTapped), for: .touchUpInside)
        let buttons = UIStackView(arrangedSubviews: [redo, ok])
        buttons.axis = .horizontal
        buttons.distribution = .equalSpacing
        buttons.alignment = .center

        let panel = UIStackView(arrangedSubviews: [glass, buttons])
        panel.axis = .vertical
        panel.spacing = 16
        panel.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(panel)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: glass.contentView.leadingAnchor, constant: 18),
            stack.trailingAnchor.constraint(equalTo: glass.contentView.trailingAnchor, constant: -18),
            stack.topAnchor.constraint(equalTo: glass.contentView.topAnchor, constant: 14),
            stack.bottomAnchor.constraint(equalTo: glass.contentView.bottomAnchor, constant: -16),
            panel.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 28),
            panel.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -28),
            panel.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -14),
        ])
        reviewPanel = panel
    }

    private func hideReview() {
        reviewPanel?.removeFromSuperview(); reviewPanel = nil
        reviewRoom = nil
        buttonBar?.isHidden = false
        coverageOverlay?.isHidden = false
    }

    @objc private func acceptReviewTapped() {
        guard let room = reviewRoom, !finished else { return }
        hideReview()
        capturedRooms.append(room)
        doneSurfaces += currentSurfaces
        currentSurfaces = []
        if pendingAction == "next" {
            startNextRoom()
            return
        }
        // последняя комната принята — собираем квартиру
        finished = true
        pollTimer?.invalidate(); pollTimer = nil
        stopCoverage()
        if let anchors = sharedSession?.currentFrame?.anchors {
            meshAnchors = anchors.compactMap { $0 as? ARMeshAnchor }
        }
        buttonBar?.isHidden = true
        finishStructure()
    }

    @objc private func rejectReviewTapped() { rejectReview() }

    /// Комната не понравилась — снимаем её заново; принятые раньше комнаты остаются.
    private func rejectReview() {
        guard reviewRoom != nil, !finished else { return }
        hideReview()
        currentSurfaces = []
        startNextRoom()
        statusLabel.text = "Комната \(capturedRooms.count + 1): сканируйте заново. Принятых комнат: \(capturedRooms.count)"
    }

    private func startNextRoom() {
        guard let session = sharedSession else { return }
        skipWallCheck = false
        captureView.removeFromSuperview()
        let cv = RoomCaptureView(frame: view.bounds, arSession: session)
        cv.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        cv.delegate = self
        cv.captureSession.delegate = self
        view.insertSubview(cv, at: 0)
        captureView = cv
        latestRoom = nil
        suspendCloud(false)
        nextButton?.isEnabled = true; doneButton?.isEnabled = true
        statusLabel.text = capturedRooms.isEmpty ? initialHint() : "Комнат принято: \(capturedRooms.count). Перейдите в следующую и продолжайте"
        runCapture()
    }

    private func finishSingle(_ room: CapturedRoom) {
        sharedSession?.pause()
        Task { @MainActor in
            let out = await self.singleResult(room)
            self.dismiss(animated: true) { self.completion(.success(out)) }
        }
    }

    /// Результат одиночного скана (обход комнаты и т.п.) — и при обычном завершении, и при восстановлении из журнала.
    private func singleResult(_ room: CapturedRoom) async -> [String: Any] {
        let mirrors = detectMirrors(rooms: [room])
        var dict = buildResult(rooms: [room])
        dict["mirrors"] = mirrors
        if let usdz = exportUSDZ({ try room.export(to: $0) }) { dict["usdz"] = usdz }
        let base = dict
        let hdc = hdCapture
        let anchors = meshAnchors
        let keys = keyFrames
        do {
            var out = base
            await self.addSurfaces(to: &out, rooms: [room])
            if let hc = hdc {
                // как в финальном скане: окрашенная сетка лидара (смотреть в 3D) и она же — облако точек для старта обучения
                self.statusLabel.text = "Собираю 3D-сетку лидара…"
                let meshInput = MeshInput(anchors: anchors, keyFrames: keys)
                let mesh = await Task.detached(priority: .userInitiated) { () -> [String: Any] in buildColoredMesh(meshInput) }.value
                for (k, v) in mesh { out[k] = v }
                let ply = (out["mesh"] as? String).flatMap { Data(base64Encoded: $0) }
                await self.packHD(hc, into: &out, pointsPLY: (out["meshVertices"] as? Int ?? 0) > 0 ? ply : nil)
            }
            return out
        }
    }

    private func finishStructure() {
        Task { @MainActor in
            let dict = await self.structureResult()
            self.sharedSession?.pause()
            self.dismiss(animated: true) { self.completion(.success(dict)) }
        }
    }

    /// Результат скана по комнатам (StructureBuilder) — и при обычном завершении, и при восстановлении из журнала.
    private func structureResult() async -> [String: Any] {
        let rooms = capturedRooms
        let anchors = meshAnchors
        let keys = keyFrames
        let hdc = hdCapture
        let wantMesh = mode == "final" || hdc != nil   // HD-обход квартиры — тоже с сеткой и облаком точек
        statusLabel.text = wantMesh ? "Собираю квартиру и 3D-модель…" : "Собираю план квартиры…"
        do {
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
                let ply = (dict["mesh"] as? String).flatMap { Data(base64Encoded: $0) }
                await self.packHD(hc, into: &dict, pointsPLY: (dict["meshVertices"] as? Int ?? 0) > 0 ? ply : nil)
            }
            return dict
        }
    }

    // MARK: восстановление скана из журнала (приложение выгрузили во время скана)

    /// Собрать результат из журнала без AR-сессии: принятые комнаты + текущая по последнему виду, кадры стен, HD-кадры.
    /// Сетки лидара, снимков пола/потолка и покрытия нет — они жили только в сессии.
    func recoverFromJournal() async -> [String: Any]? {
        var rooms = ScanJournal.rooms()
        if let cur = ScanJournal.current(), cur.walls.count >= 3 { rooms.append(cur) }
        frames = ScanJournal.frames()
        if let dir = ScanJournal.hdDir { hdCapture = HDCapture(restoring: dir) }
        if rooms.isEmpty {
            // комнат нет, но есть HD-кадры — сохраняем хотя бы HD-пакет (модель на компьютере строится и без схемы)
            guard let hc = hdCapture, hc.count > 0 else { return nil }
            var out = buildResult(rooms: [])
            await packHD(hc, into: &out, pointsPLY: nil)
            out["recovered"] = true
            return out
        }
        capturedRooms = rooms
        var out: [String: Any]
        if isMulti { out = await structureResult() } else { out = await singleResult(rooms[rooms.count - 1]) }
        out["recovered"] = true
        return out
    }

    /// HD-пакет (кадры + позы + облако точек лидара points.ply) → ZIP в Documents; в результат — путь, число кадров и размер.
    private func packHD(_ hc: HDCapture, into dict: inout [String: Any], pointsPLY: Data?) async {
        guard hc.count > 0 else { hc.discard(); return }
        statusLabel.text = "Упаковываю HD-кадры для компьютера…"
        let res = await Task.detached(priority: .userInitiated) { () -> (String?, String?) in
            do { return (try hc.finish(pointsPLY: pointsPLY).path, nil) } catch { return (nil, error.localizedDescription) }
        }.value
        if let path = res.0 {
            dict["hdZip"] = path
            dict["hdFrames"] = hc.count
            dict["hdBytes"] = ((try? FileManager.default.attributesOfItem(atPath: path)[.size]) as? NSNumber)?.intValue ?? 0
        } else if let err = res.1 { dict["hdError"] = err }
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
        if let error = error, !finished { DispatchQueue.main.async { [weak self] in self?.scanInterrupted(error) } }
    }

    // MARK: прерывание скана (звонок, потеря положения) — прогресс не теряем

    /// 2026-10-23: во время скана позвонили, после разговора «телефон теряет положение», RoomPlan закончил скан с ошибкой —
    /// и сканер закрывался, выбрасывая принятые комнаты и HD-кадры. Теперь — окно: продолжить / сохранить готовое / отменить.
    private var interruptShown = false
    private func scanInterrupted(_ error: Error) {
        guard !finished, !interruptShown else { return }
        if mode == "ghost" {
            finished = true
            dismiss(animated: true) { self.completion(.failure(ScanError.failed(error.localizedDescription))) }
            return
        }
        interruptShown = true
        if reviewRoom != nil { hideReview() }
        nextButton?.isEnabled = false; doneButton?.isEnabled = false
        suspendCloud(true)
        let canSave = savableRooms().count > 0
        var lines: [String] = []
        if !capturedRooms.isEmpty { lines.append("Принято комнат: \(capturedRooms.count)") }
        if let r = latestRoom, r.walls.count >= 3 { lines.append("текущая комната — по последнему виду (стен: \(r.walls.count))") }
        if let hc = hdCapture, hc.count > 0 { lines.append("HD-кадров: \(hc.count)") }
        let ac = UIAlertController(title: "Скан прервался",
                                   message: (lines.isEmpty ? "" : lines.joined(separator: ", ") + " — сохранены.\n")
                                       + "«Продолжить» — снова наведите камеру на уже снятое место, телефон найдёт своё положение.",
                                   preferredStyle: .alert)
        ac.addAction(UIAlertAction(title: "Продолжить", style: .default) { [weak self] _ in self?.resumeAfterInterrupt() })
        if canSave { ac.addAction(UIAlertAction(title: "Сохранить и закончить", style: .default) { [weak self] _ in self?.saveAndFinish() }) }
        if journal != nil { ac.addAction(UIAlertAction(title: "Пауза — продолжить позже", style: .default) { [weak self] _ in self?.interruptShown = false; self?.pauseScan() }) }
        ac.addAction(UIAlertAction(title: "Отменить", style: .destructive) { [weak self] _ in
            // отдельное подтверждение; «Нет» — снова это окно (кнопки скана сейчас выключены)
            let c = UIAlertController(title: "Отменить весь скан?", message: "Всё снятое в этом скане будет потеряно.", preferredStyle: .alert)
            c.addAction(UIAlertAction(title: "Нет, вернуться", style: .cancel) { _ in self?.interruptShown = false; self?.scanInterrupted(error) })
            c.addAction(UIAlertAction(title: "Отменить всё", style: .destructive) { _ in self?.interruptShown = false; self?.cancelAll() })
            self?.present(c, animated: true)
        })
        statusLabel.text = "Скан прервался — прогресс сохранён"
        if presentedViewController != nil { dismiss(animated: false) { [weak self] in self?.present(ac, animated: true) } }
        else { present(ac, animated: true) }
    }

    /// Комнаты, которые можно сохранить сейчас: принятые + текущая по последнему виду RoomPlan (если в ней ≥ 3 стен).
    private func savableRooms() -> [CapturedRoom] {
        var rooms = capturedRooms
        if let r = latestRoom, r.walls.count >= 3 { rooms.append(r) }
        return rooms
    }

    /// Текущая комната — заново в той же AR-сессии (ARKit сам находит прежнее положение по уже снятому); принятое остаётся.
    private func resumeAfterInterrupt() {
        interruptShown = false
        guard !finished else { return }
        currentSurfaces = []
        startNextRoom()
        statusLabel.text = "Продолжаем. Наведите камеру на уже снятое место, затем сканируйте дальше"
    }

    /// «Сохранить и закончить»: принятые комнаты + текущая по последнему виду, HD-пакет — как при обычном завершении.
    /// Оставшиеся комнаты снимаются потом новым обходом — они добавятся к той же схеме.
    private func saveAndFinish() {
        interruptShown = false
        guard !finished else { return }
        let rooms = savableRooms()
        guard !rooms.isEmpty else { confirmCancelAll(); return }
        finished = true
        pollTimer?.invalidate(); pollTimer = nil
        stopCoverage()
        if let anchors = sharedSession?.currentFrame?.anchors { meshAnchors = anchors.compactMap { $0 as? ARMeshAnchor } }
        buttonBar?.isHidden = true
        if reviewRoom != nil { hideReview() }
        captureView.captureSession.stop(pauseARSession: false)
        if isMulti { capturedRooms = rooms; finishStructure() }
        else { capturedRooms = rooms; finishSingle(rooms[rooms.count - 1]) }
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

    /// Компас: истинный север (если разрешена геопозиция), иначе магнитный.
    private func setupCompass() {
        guard CLLocationManager.headingAvailable() else { return }
        locMgr.headingOrientation = .portrait
        locMgr.desiredAccuracy = kCLLocationAccuracyKilometer
        if locMgr.authorizationStatus == .notDetermined { locMgr.requestWhenInUseAuthorization() }
        locMgr.startUpdatingLocation()   // нужна для trueHeading; без разрешения просто не сработает
        locMgr.startUpdatingHeading()
    }

    /// Камера смотрит в мире сессии под углом a_cam = atan2(z, x) (по часовой при взгляде сверху),
    /// компас говорит, что это направление h° от севера по часовой → север в мире: a_cam − h.
    private func sampleNorth(frame: ARFrame) {
        guard let h = locMgr.heading, h.headingAccuracy >= 0, h.headingAccuracy <= 30,
              frame.camera.trackingState == .normal else { return }
        let T = frame.camera.transform
        let fx = Double(-T.columns.2.x), fz = Double(-T.columns.2.z)
        guard (fx * fx + fz * fz).squareRoot() > 0.5 else { return }   // телефон смотрит в пол/потолок — пропуск
        let useTrue = h.trueHeading >= 0
        let deg = useTrue ? h.trueHeading : h.magneticHeading
        let a = atan2(fz, fx) - deg * Double.pi / 180
        northSin += sin(a); northCos += cos(a); northN += 1
        if !useTrue { northTrue = false }
    }

    private func buildResult(rooms: [CapturedRoom]) -> [String: Any] {
        var out: [String: Any] = ["mode": mode]
        if northN >= 5 {
            out["north"] = atan2(northSin, northCos)
            out["northTrue"] = northTrue
            out["northSamples"] = northN
        }
        if let first = rooms.first, rooms.count == 1 {
            for (k, v) in roomDict(first) { out[k] = v }
        }
        out["rooms"] = rooms.map(roomDict)
        var fr: [[String: Any]] = []
        for (wallId, list) in remapPausedFrames(to: rooms) {
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

    /// Кадры стен комнаты, недоснятой на момент паузы, ссылаются на её стены; после продолжения RoomPlan снимает комнату
    /// заново с новыми id — переносим кадры на ближайшую новую стену (координаты те же после узнавания места).
    private func remapPausedFrames(to rooms: [CapturedRoom]) -> [UUID: [WallFrame]] {
        guard !pausedRooms.isEmpty else { return frames }
        let walls = rooms.flatMap { $0.walls }
        let known = Set(walls.map { $0.identifier })
        let old = Dictionary(pausedRooms.flatMap { $0.walls }.map { ($0.identifier, $0) }, uniquingKeysWith: { a, _ in a })
        var out: [UUID: [WallFrame]] = [:]
        for (wid, list) in frames {
            if known.contains(wid) { out[wid, default: []] += list; continue }
            guard let ow = old[wid] else { continue }
            let oc = xyz(ow.transform.columns.3), on = simd_normalize(xyz(ow.transform.columns.2))
            var best: (UUID, Float)? = nil
            for w in walls {
                let c = xyz(w.transform.columns.3), n = simd_normalize(xyz(w.transform.columns.2))
                guard abs(simd_dot(n, on)) > 0.9 else { continue }
                let d: Float = simd_length(c - oc) + abs(simd_dot(c - oc, n)) * 2   // в стороне по плоскости — терпимо, поперёк — нет
                if d < 1.0 && d < (best?.1 ?? Float.infinity) { best = (w.identifier, d) }
            }
            if let b = best { out[b.0, default: []] += list }
        }
        return out
    }

    // MARK: опрос кадра

    private func poll() {
        guard let frame = sharedSession?.currentFrame else { return }
        if reviewRoom != nil { return }           // идёт проверка комнаты — ничего не снимаем
        if mode == "ghost" { pollGhost(frame: frame); return }
        sampleNorth(frame: frame)
        // ключевые кадры для окрашенной сетки лидара: финальный скан и HD-обход этапа (HD заменил финальный скан 2026-10-12,
        // но сетка и облако точек при этом потерялись — вернули 2026-10-20: «функционал не надо было менять»)
        if mode == "final" || hd { pollKeyFrame(frame: frame) }
        if let hc = hdCapture, hc.consider(frame: frame, ciContext: ciContext) {
            stillRing.flash()
            // 2026-10-22: HD-кадр — полноразмерный снимок 12 Мп вместо видеокадра 1920×1440 (резче текстура модели)
            if !hiResBusy, let sess = sharedSession {
                hiResBusy = true
                let idx = hc.count - 1, ctx = ciContext
                sess.captureHighResolutionFrame { [weak self, weak hc] hf, _ in
                    DispatchQueue.main.async {
                        self?.hiResBusy = false
                        if let hf = hf { hc?.attachHiRes(index: idx, frame: hf, ciContext: ctx) }
                    }
                }
            }
            // в обходе этапа счётчик HD — в строке «Снято кадров»; HD-кадры идут и в подсветку (подробность съёмки)
            if mode == "final" { statusLabel.text = "HD-кадров: \(hc.count) · комнат: \(capturedRooms.count + 1)" }
            if let e = hc.last {
                let p = simd_float3(e.c2w.columns.3.x, e.c2w.columns.3.y, e.c2w.columns.3.z)
                coverage?.add(CovView(inv: e.c2w.inverse, fx: e.fx, fy: e.fy, cx: e.cx, cy: e.cy, w: Float(e.w), h: Float(e.h), pos: p))
            }
        }
        if coverage != nil { refreshCoverageMap() }
        if wantSurfaces { pollSurfaceFrame(frame: frame) }
        if wantFrames { pollWallFrame(frame: frame) }
        if hd && wantFrames { hdAim(frame: frame) }
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
        guard let room = latestRoom, !room.walls.isEmpty else { setAim("Стены ещё не распознаны — медленно обведите комнату камерой"); return }
        let cam = frame.camera
        guard cam.trackingState == .normal else {
            setAim("Телефон теряет положение — больше света или деталей в кадре, двигайтесь медленнее"); return
        }
        let T = cam.transform
        if let last = lastTransform {
            let dp = simd_length(xyz(T.columns.3) - xyz(last.columns.3))
            let f1 = -xyz(T.columns.2), f0 = -xyz(last.columns.2)
            let dang = acos(max(-1, min(1, simd_dot(f1, f0))))
            lastTransform = T
            if dp > 0.05 || dang > 0.05 { setAim("Замрите на секунду — кадр снимается, когда телефон неподвижен"); return }
        } else { lastTransform = T; return }

        guard let (wall, score0) = bestWall(in: room, camera: cam) else { setAim(aimProblem(in: room, camera: cam)); return }
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
        let K0 = cam.intrinsics
        let covView = CovView(inv: viewM, fx: K0.columns.0.x, fy: K0.columns.1.y, cx: K0.columns.2.x, cy: K0.columns.2.y,
                              w: Float(res.width), h: Float(res.height), pos: camPos, target: .wall(wall.identifier.uuidString))
        // сколько ещё не снятых клеток этой стены попадёт в кадр: такой кадр берём всегда — раньше его отбрасывали,
        // если с этого же места (< 0,7 м) уже был кадр «прямее», и недоснятый кусок не зеленел, сколько ни целься
        let fresh = hd ? 0 : (coverage.map { $0.freshCells(covView, surfaces: currentSurfaces) } ?? 0)
        if fresh == 0 && existing.contains(where: { simd_length($0.camPos - camPos) < 0.7 && $0.score >= score }) {
            if !hd { setAim(nil) }; return   // это место стены уже снято
        }
        guard let jpeg = jpegData(from: frame.capturedImage) else { return }
        let camDir: simd_float3 = -xyz(T.columns.2)
        let new = WallFrame(score: score, full: full, camPos: camPos, camDir: camDir, jpeg: jpeg, corners: pts, w: wall.dimensions.x, h: wall.dimensions.y)
        var list: [WallFrame]
        if fresh > 0 {
            // добирающий кадр: оставляем все прежние (они покрывают свои куски). Предела нет: такой кадр берётся,
            // только если снимает ещё не снятое, и когда стена вся зелёная, кадры перестают добавляться сами
            // (предел с отбором по ракурсу мог выбросить единственный кадр какого-то куска — зелёный, а фото нет)
            list = existing + [new]
            list.sort { $0.score > $1.score }
        } else {
            list = existing.filter { simd_length($0.camPos - camPos) >= 0.7 || $0.score > score }
            list.append(new)
            list.sort { $0.score > $1.score }
            if list.count > 2 { list = Array(list.prefix(2)) }
        }
        frames[wall.identifier] = list
        if !hd { setAim(nil) }
        coverage?.add(covView)
        stillRing.flash()
        // HD: пробуем полноразмерный снимок 12 Мп (ARKit 6) вместо кадра видео 1920×1440 — получится ли внутри сессии RoomPlan,
        // проверяется на устройстве: счётчик «12 Мп» в строке статуса
        if hd, !hiResBusy, let sess = sharedSession {
            let wid = wall.identifier, pos = camPos
            hiResBusy = true
            sess.captureHighResolutionFrame { [weak self] hf, _ in
                DispatchQueue.main.async { self?.hiResBusy = false }
                guard let self = self, let hf = hf, let j = self.jpegData(from: hf.capturedImage) else { return }
                DispatchQueue.main.async {
                    guard var l = self.frames[wid], let i = l.firstIndex(where: { simd_length($0.camPos - pos) < 0.001 }) else { return }
                    l[i].jpeg = j
                    self.frameRewrite = l[i].id
                    self.frames[wid] = l
                    self.frameRewrite = nil
                    self.hiResCount += 1
                }
            }
        }
        let n = frames.values.reduce(0) { $0 + $1.count }
        statusLabel.text = "Снято кадров: \(n) · стен с фото: \(frames.count)" + (hdCapture.map { " · HD: \($0.count)" + ($0.hiRes > 0 ? " (12 Мп: \($0.hiRes))" : "") } ?? "") + (hiResCount > 0 ? " · 12 Мп: \(hiResCount)" : "") + (isMulti ? " · комнат: \(capturedRooms.count + 1)" : "")
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

    private static let maxKeyFrames = 1000

    private func pollKeyFrame(frame: ARFrame) {
        let cam = frame.camera
        // потолок числа кадров: 70 хватало на одну комнату — на квартире кадры кончались, и пол/стены дальше
        // не снимались и не подсвечивались. 1000 кадров 320 px ≈ 300 МБ памяти (по просьбе пользователя; кадр берётся раз в 35 см / 20°, до предела доходит редко).
        guard cam.trackingState == .normal else { return }
        guard keyFrames.count < Self.maxKeyFrames else {
            statusLabel.text = "Кадров: \(keyFrames.count) — предел, новые не снимаются. Нажмите флаг 🏁"
            return
        }
        let T = cam.transform
        let pos = xyz(T.columns.3)
        let fwd = simd_normalize(-xyz(T.columns.2))
        let res = cam.imageResolution
        let targetW = 320
        let targetH = Int(Double(targetW) * Double(res.height) / Double(res.width))
        let k = Float(targetW) / Float(res.width)
        let K = cam.intrinsics
        let view = CovView(inv: T.inverse, fx: K.columns.0.x * k, fy: K.columns.1.y * k, cx: K.columns.2.x * k, cy: K.columns.2.y * k,
                           w: Float(targetW), h: Float(targetH), pos: pos)
        var moved: Float = .infinity, turned: Float = .infinity
        if let lp = lastKeyPos, let lf = lastKeyFwd {
            moved = simd_length(pos - lp)
            turned = acos(max(-1, min(1, simd_dot(fwd, lf))))
        }
        if let model = coverage, !currentSurfaces.isEmpty {
            // Приложение знает, что уже снято (зелёная подсветка): кадр берём, только если он снимает ещё не снятое —
            // не меньше 3 новых клеток 40×40 см. Одно и то же место много раз не фотографируем
            // (раньше кадр шёл просто по движению — на одну прихожую уходило 70 кадров).
            if moved < 0.1 && turned < 0.1 { return }               // телефон почти не сдвинулся — нечего проверять
            let fresh = model.freshCells(view, surfaces: currentSurfaces)
            // одна-две оставшиеся клетки (угол, край) тоже доснимаем — но только с нового ракурса, не каждые 0,4 с
            if fresh < 3 && !(fresh >= 1 && (moved >= 0.5 || turned >= 0.5)) { return }
        } else {
            // комната ещё не распознана (нет поверхностей для подсветки) — по движению: полметра или ~29°
            if moved < 0.5 && turned < 0.5 { return }
        }
        let ci = CIImage(cvPixelBuffer: frame.capturedImage)
        guard let cg = ciContext.createCGImage(ci, from: ci.extent),
              let rgba = rgbaBytes(of: cg, width: targetW, height: targetH) else { return }
        if mode == "final" { coverage?.add(view) }
        keyFrames.append(KeyFrame(transformInv: T.inverse,
                                  fx: K.columns.0.x * k, fy: K.columns.1.y * k, cx: K.columns.2.x * k, cy: K.columns.2.y * k,
                                  w: targetW, h: targetH, rgba: rgba, pos: pos, fwd: fwd))
        lastKeyPos = pos; lastKeyFwd = fwd
        if mode == "final" { statusLabel.text = "Кадров: \(keyFrames.count) из \(Self.maxKeyFrames) · комнат: \(capturedRooms.count + 1)" }
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

/// «Жидкое стекло» iOS 26+ (UIGlassEffect) вместо обычного размытия. true — применено.
/// Собирается только новым Xcode (SDK iOS 26+, Swift 6.2+); на старом Xcode и на iOS < 26 остаётся размытие.
/// Тёмный вариант стекла — у нас поверх него белые значки и текст.
@MainActor func applyLiquidGlass(_ view: UIVisualEffectView, tint: UIColor?) -> Bool {
    #if compiler(>=6.2)
    if #available(iOS 26.0, *) {
        let effect = UIGlassEffect()
        effect.tintColor = tint
        view.overrideUserInterfaceStyle = .dark
        view.effect = effect
        return true
    }
    #endif
    return false
}

/// Стеклянная кнопка поверх камеры: размытие фона (системный материал), светлый ободок, белый значок.
/// Круглая со значком SF Symbols или капсула с текстом; `tint` — цветное стекло для главного действия.
/// Нажатие — пружинное сжатие; выключенная — полупрозрачная.
/// Кольцо прогресса вокруг перекрестия: белая дорожка, оранжевая дуга заполняется по часовой с 12 часов; flash() — кадр снят.
final class StillRingView: UIView {
    private let track = CAShapeLayer(), arc = CAShapeLayer()
    private(set) var progress: CGFloat = 0
    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        backgroundColor = .clear
        for (l, c, w) in [(track, UIColor(white: 1, alpha: 0.35), CGFloat(4)), (arc, UIColor(red: 0.85, green: 0.37, blue: 0.09, alpha: 1), CGFloat(4))] {
            l.fillColor = UIColor.clear.cgColor; l.strokeColor = c.cgColor; l.lineWidth = w; l.lineCap = .round
            layer.addSublayer(l)
        }
        arc.strokeEnd = 0
        layer.shadowColor = UIColor.black.cgColor; layer.shadowOpacity = 0.35; layer.shadowRadius = 2; layer.shadowOffset = .zero
    }
    required init?(coder: NSCoder) { fatalError() }
    override func layoutSubviews() {
        super.layoutSubviews()
        let r = min(bounds.width, bounds.height) / 2 - 3
        let path = UIBezierPath(arcCenter: CGPoint(x: bounds.midX, y: bounds.midY), radius: r, startAngle: -.pi / 2, endAngle: 1.5 * .pi, clockwise: true).cgPath
        track.path = path; arc.path = path
    }
    func setProgress(_ p: CGFloat) {
        progress = p
        CATransaction.begin(); CATransaction.setDisableActions(true); arc.strokeEnd = p; CATransaction.commit()
    }
    /// Кадр снят: кольцо зеленеет, коротко «вздувается» и сбрасывается.
    func flash() {
        arc.strokeColor = UIColor(red: 0.2, green: 0.8, blue: 0.4, alpha: 1).cgColor
        setProgress(1)
        transform = .identity
        UIView.animate(withDuration: 0.12, animations: { self.transform = CGAffineTransform(scaleX: 1.25, y: 1.25) }) { _ in
            UIView.animate(withDuration: 0.18, animations: { self.transform = .identity }) { _ in
                self.arc.strokeColor = UIColor(red: 0.85, green: 0.37, blue: 0.09, alpha: 1).cgColor
                self.setProgress(0)
            }
        }
    }
}

/// Точки мира из карты глубины кадра (лидар): каждый step-й пиксель, только средняя и высокая уверенность.
/// Карта глубины в той же ориентации, что кадр камеры (датчик, альбомная), интринсики — от полного кадра.
func depthWorldPoints(_ frame: ARFrame, step: Int) -> [simd_float3] {
    guard let sd = frame.sceneDepth ?? frame.smoothedSceneDepth else { return [] }
    let dm = sd.depthMap
    CVPixelBufferLockBaseAddress(dm, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(dm, .readOnly) }
    guard let db = CVPixelBufferGetBaseAddress(dm) else { return [] }
    let w = CVPixelBufferGetWidth(dm), h = CVPixelBufferGetHeight(dm), bpr = CVPixelBufferGetBytesPerRow(dm)
    var conf: UnsafeMutablePointer<UInt8>? = nil; var cbpr = 0
    if let cm = sd.confidenceMap { CVPixelBufferLockBaseAddress(cm, .readOnly); conf = CVPixelBufferGetBaseAddress(cm)?.assumingMemoryBound(to: UInt8.self); cbpr = CVPixelBufferGetBytesPerRow(cm) }
    defer { if let cm = sd.confidenceMap { CVPixelBufferUnlockBaseAddress(cm, .readOnly) } }
    let K = frame.camera.intrinsics, res = frame.camera.imageResolution
    let sx = Float(res.width) / Float(w), sy = Float(res.height) / Float(h)
    let T = frame.camera.transform
    var out: [simd_float3] = []
    out.reserveCapacity((w / step) * (h / step))
    var y = 0
    while y < h {
        let row = (db + y * bpr).assumingMemoryBound(to: Float32.self)
        var x = 0
        while x < w {
            let d = row[x]
            if d.isFinite && d > 0.1 && d < 8, conf.map({ $0[y * cbpr + x] >= UInt8(ARConfidenceLevel.medium.rawValue) }) ?? true {
                let u = (Float(x) + 0.5) * sx, v = (Float(y) + 0.5) * sy
                // камера ARKit: x вправо, y вверх, смотрит вдоль −z; у картинки y вниз
                let pc = simd_float4((u - K.columns.2.x) / K.columns.0.x * d, -(v - K.columns.2.y) / K.columns.1.y * d, -d, 1)
                let pw = T * pc
                out.append(simd_float3(pw.x, pw.y, pw.z))
            }
            x += step
        }
        y += step
    }
    return out
}

/// Рёбра треугольников сетки лидара на экране (портрет): одна матрица на якорь, без projectPoint — считается в фоне.
/// Якоря ближе 7 м, вершины 0,15–6 м от камеры, не больше ~20 тыс. треугольников.
func meshWirePath(anchors: [ARMeshAnchor], viewProj: simd_float4x4, camPos: simd_float3, size: CGSize) -> CGPath {
    let near = anchors.filter { simd_length(simd_float3($0.transform.columns.3.x, $0.transform.columns.3.y, $0.transform.columns.3.z) - camPos) < 7 }
    let totalFaces = near.reduce(0) { $0 + $1.geometry.faces.count }
    let fstep = max(1, totalFaces / 20000)
    let path = CGMutablePath()
    let W = Float(size.width), H = Float(size.height), pad: Float = 40
    for a in near {
        let g = a.geometry, vs = g.vertices
        let M = viewProj * a.transform
        let vbase = vs.buffer.contents().advanced(by: vs.offset)
        var scr = [SIMD2<Float>](repeating: SIMD2<Float>(.nan, .nan), count: vs.count)
        for i in 0..<vs.count {
            let v = vbase.advanced(by: i * vs.stride).assumingMemoryBound(to: (Float, Float, Float).self).pointee
            let c = M * simd_float4(v.0, v.1, v.2, 1)
            guard c.w > 0.15 && c.w < 6 else { continue }          // w клипа = расстояние до камеры по оси взгляда
            let x = (c.x / c.w + 1) * 0.5 * W, y = (1 - c.y / c.w) * 0.5 * H
            if x > -pad && y > -pad && x < W + pad && y < H + pad { scr[i] = SIMD2(x, y) }
        }
        let fs = g.faces
        guard fs.indexCountPerPrimitive == 3 else { continue }
        let fbase = fs.buffer.contents()
        var f = 0
        while f < fs.count {
            let o = f * 3 * fs.bytesPerIndex
            let i0: Int, i1: Int, i2: Int
            if fs.bytesPerIndex == 4 {
                let ip = fbase.advanced(by: o).assumingMemoryBound(to: UInt32.self); i0 = Int(ip[0]); i1 = Int(ip[1]); i2 = Int(ip[2])
            } else {
                let ip = fbase.advanced(by: o).assumingMemoryBound(to: UInt16.self); i0 = Int(ip[0]); i1 = Int(ip[1]); i2 = Int(ip[2])
            }
            f += fstep
            guard i0 < scr.count, i1 < scr.count, i2 < scr.count else { continue }
            let p0 = scr[i0], p1 = scr[i1], p2 = scr[i2]
            if p0.x.isNaN || p1.x.isNaN || p2.x.isNaN { continue }
            path.move(to: CGPoint(x: CGFloat(p0.x), y: CGFloat(p0.y)))
            path.addLine(to: CGPoint(x: CGFloat(p1.x), y: CGFloat(p1.y)))
            path.addLine(to: CGPoint(x: CGFloat(p2.x), y: CGFloat(p2.y)))
            path.closeSubpath()
        }
    }
    return path
}

/// Сетка лидара (рёбра треугольников ARMeshAnchor) поверх камеры, а без сетки — точки глубины кадра; цвет — по расстоянию (близко — голубой, далеко — фиолетовый).
/// Не больше ~6000 точек за кадр; если сетки нет — надпись: значит, и облака точек в HD-пакете не будет.
final class PointCloudView: UIView {
    private var pts: [CGPoint] = []
    private var dist: [Float] = []
    private let note = UILabel()
    private let wireLayer = CAShapeLayer()   // рёбра рисует сервер отрисовки, не главный поток

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        backgroundColor = .clear
        isOpaque = false
        wireLayer.strokeColor = UIColor(white: 1, alpha: 0.42).cgColor
        wireLayer.fillColor = nil
        wireLayer.lineWidth = 0.6
        layer.addSublayer(wireLayer)
        note.textColor = .white
        note.font = .systemFont(ofSize: 13, weight: .semibold)
        note.backgroundColor = UIColor(white: 0, alpha: 0.5)
        note.layer.cornerRadius = 8
        note.clipsToBounds = true
        note.textAlignment = .center
        note.isHidden = true
        addSubview(note)
    }
    required init?(coder: NSCoder) { fatalError() }

    func update(frame: ARFrame, anchors: [ARMeshAnchor], diag: String) {
        let size = bounds.size
        let total = anchors.reduce(0) { $0 + $1.geometry.vertices.count }
        if total == 0 {
            // сетки нет — точки из карты глубины этого кадра (то, что лидар видит прямо сейчас)
            var p: [CGPoint] = []; var d: [Float] = []
            for w in depthWorldPoints(frame, step: 4) {
                let c = frame.camera.transform.inverse * simd_float4(w, 1)
                let z = -c.z
                guard z > 0.15 && z < 8 else { continue }
                let s = frame.camera.projectPoint(w, orientation: .portrait, viewportSize: size)
                if s.x >= 0 && s.y >= 0 && s.x <= size.width && s.y <= size.height { p.append(s); d.append(z) }
            }
            pts = p; dist = d; wireLayer.path = nil
            note.text = "  " + (p.isEmpty ? "Лидар не отдаёт ни сетку, ни глубину" : "Точки из глубины кадра") + " · " + diag + "  "
            note.isHidden = false
            note.numberOfLines = 2
            note.font = .systemFont(ofSize: 11, weight: .semibold)
            let fit = note.sizeThatFits(CGSize(width: size.width - 24, height: 60))
            note.frame = CGRect(x: (size.width - min(fit.width, size.width - 24)) / 2, y: size.height * 0.45, width: min(fit.width, size.width - 24), height: fit.height + 8)
            setNeedsDisplay()
            return
        }
        // сетка есть — её рёбра считает meshWirePath в фоне (cloudTick → setWire)
    }

    /// Готовые рёбра сетки (посчитаны в фоне, meshWirePath).
    func setWire(_ path: CGPath) {
        CATransaction.begin(); CATransaction.setDisableActions(true)
        wireLayer.frame = bounds; wireLayer.path = path
        CATransaction.commit()
        if !pts.isEmpty { pts = []; dist = []; setNeedsDisplay() }
        note.isHidden = true
    }

    override func draw(_ rect: CGRect) {
        guard let ctx = UIGraphicsGetCurrentContext() else { return }
        for (i, q) in pts.enumerated() {
            let t = CGFloat(min(1, max(0, (dist[i] - 0.5) / 4.5)))   // 0,5 м → 0, 5 м → 1
            ctx.setFillColor(UIColor(red: 0.2 + 0.5 * t, green: 0.9 - 0.7 * t, blue: 1.0, alpha: 0.9).cgColor)
            ctx.fill(CGRect(x: q.x - 1.5, y: q.y - 1.5, width: 3, height: 3))
        }
    }
}

final class GlassButton: UIButton {
    static let side: CGFloat = 62
    private let glass = UIVisualEffectView(effect: UIBlurEffect(style: .systemUltraThinMaterialDark))
    private let tintLayer = UIView()

    init(symbol: String? = nil, title: String? = nil, label: String? = nil, tint: UIColor? = nil) {
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        for v in [glass, tintLayer] as [UIView] {
            v.isUserInteractionEnabled = false
            v.translatesAutoresizingMaskIntoConstraints = false
            insertSubview(v, at: 0)
            NSLayoutConstraint.activate([
                v.leadingAnchor.constraint(equalTo: leadingAnchor), v.trailingAnchor.constraint(equalTo: trailingAnchor),
                v.topAnchor.constraint(equalTo: topAnchor), v.bottomAnchor.constraint(equalTo: bottomAnchor),
            ])
        }
        sendSubviewToBack(glass)
        tintLayer.backgroundColor = tint?.withAlphaComponent(0.78) ?? UIColor(white: 0, alpha: 0.18)   // лёгкое затемнение: белый значок читается и на светлом фоне
        // iOS 26+: настоящее «жидкое стекло» (цвет главного действия — оттенком стекла), наш слой затемнения и ободок не нужны
        if applyLiquidGlass(glass, tint: tint?.withAlphaComponent(0.85)) {
            tintLayer.isHidden = true
            layer.borderWidth = 0
        }
        layer.cornerRadius = Self.side / 2
        layer.cornerCurve = .continuous
        layer.masksToBounds = true
        layer.borderWidth = 1
        layer.borderColor = UIColor(white: 1, alpha: 0.38).cgColor
        tintColor = .white
        if let symbol = symbol {
            let cfg = UIImage.SymbolConfiguration(pointSize: 24, weight: .semibold)
            setImage(UIImage(systemName: symbol, withConfiguration: cfg), for: .normal)
            widthAnchor.constraint(equalToConstant: Self.side).isActive = true
        }
        if let title = title {
            setTitle(title, for: .normal)
            setTitleColor(.white, for: .normal)
            titleLabel?.font = .systemFont(ofSize: 16, weight: .semibold)
            widthAnchor.constraint(greaterThanOrEqualToConstant: 140).isActive = true
            contentEdgeInsets = UIEdgeInsets(top: 0, left: 18, bottom: 0, right: 18)   // «Следующая комната» — с полями по бокам
        }
        heightAnchor.constraint(equalToConstant: Self.side).isActive = true
        accessibilityLabel = label ?? title
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override func layoutSubviews() {
        super.layoutSubviews()
        if let iv = imageView { bringSubviewToFront(iv) }
        if let tl = titleLabel { bringSubviewToFront(tl) }
    }

    override var isHighlighted: Bool {
        didSet {
            guard oldValue != isHighlighted else { return }
            UIView.animate(withDuration: 0.35, delay: 0, usingSpringWithDamping: 0.55, initialSpringVelocity: 0.6,
                           options: [.allowUserInteraction, .beginFromCurrentState]) {
                self.transform = self.isHighlighted ? CGAffineTransform(scaleX: 0.88, y: 0.88) : .identity
            }
        }
    }
    override var isEnabled: Bool { didSet { alpha = isEnabled ? 1 : 0.45 } }
}
