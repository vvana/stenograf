import UIKit
import ARKit
import SceneKit
import simd

/// «LiDAR Mode» (2026-10-26, просьба пользователя — как LiDAR Mode у Polycam): скан без RoomPlan.
/// На экране только камера; неснятое — полупрозрачная синяя заливка по сетке лидара (снятое — чистая картинка камеры).
/// Кадры — на ходу из видео 4K (HDCapture.onTheMove, фильтр резкости), без звука. По ✓ — HD-пакет для компьютера и
/// модель с текстурой на телефоне (TextureBuilder). Схему и фото стен не трогает; модель не привязана к схеме.
@available(iOS 17.0, *)
final class LidarScanViewController: UIViewController, ARSCNViewDelegate {
    private let completion: (Result<[String: Any], Error>) -> Void
    private var sceneView: ARSCNView!
    private var hd: HDCapture?
    private var timer: Timer?
    private let ciContext = CIContext()
    private let statusLabel = UILabel()
    private var finished = false
    // снятое: воксели 8 см точек глубины из принятых кадров (до 3 м — дальше деталей нет)
    private var covered = Set<SIMD3<Int32>>()
    private let coverLock = NSLock()
    private var coverVersion = 0
    private var nodeVersion: [UUID: Int] = [:]
    private let voxel: Float = 0.08
    private var lastRecolor: TimeInterval = 0

    init(completion: @escaping (Result<[String: Any], Error>) -> Void) {
        self.completion = completion
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError() }

    override var prefersStatusBarHidden: Bool { true }
    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { .portrait }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        sceneView = ARSCNView(frame: view.bounds)
        sceneView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        sceneView.delegate = self
        sceneView.automaticallyUpdatesLighting = false
        sceneView.rendersCameraGrain = false
        view.addSubview(sceneView)

        statusLabel.translatesAutoresizingMaskIntoConstraints = false
        statusLabel.textColor = .white
        statusLabel.font = .systemFont(ofSize: 14, weight: .semibold)
        statusLabel.numberOfLines = 2
        statusLabel.textAlignment = .center
        statusLabel.backgroundColor = UIColor(white: 0, alpha: 0.45)
        statusLabel.layer.cornerRadius = 12
        statusLabel.clipsToBounds = true
        statusLabel.text = "  Медленно водите телефоном — синее исчезает там, где снято  "
        view.addSubview(statusLabel)

        let cancel = GlassButton(symbol: "xmark", label: "Отменить")
        cancel.addTarget(self, action: #selector(cancelTapped), for: .touchUpInside)
        let done = GlassButton(symbol: "checkmark", label: "Готово", tint: UIColor(red: 0.91, green: 0.44, blue: 0.18, alpha: 1))
        done.addTarget(self, action: #selector(doneTapped), for: .touchUpInside)
        view.addSubview(cancel); view.addSubview(done)
        let g = view.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            statusLabel.topAnchor.constraint(equalTo: g.topAnchor, constant: 10),
            statusLabel.leadingAnchor.constraint(equalTo: g.leadingAnchor, constant: 16),
            statusLabel.trailingAnchor.constraint(equalTo: g.trailingAnchor, constant: -16),
            statusLabel.heightAnchor.constraint(greaterThanOrEqualToConstant: 40),
            cancel.leadingAnchor.constraint(equalTo: g.leadingAnchor, constant: 24),
            cancel.bottomAnchor.constraint(equalTo: g.bottomAnchor, constant: -20),
            done.trailingAnchor.constraint(equalTo: g.trailingAnchor, constant: -24),
            done.bottomAnchor.constraint(equalTo: g.bottomAnchor, constant: -20),
        ])

        hd = HDCapture()
        hd?.onTheMove = true
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        UIApplication.shared.isIdleTimerDisabled = true
        let cfg = ARWorldTrackingConfiguration()
        if ARWorldTrackingConfiguration.supportsSceneReconstruction(.mesh) { cfg.sceneReconstruction = .mesh }
        if ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth) { cfg.frameSemantics.insert(.sceneDepth) }
        if let f = ARWorldTrackingConfiguration.recommendedVideoFormatFor4KResolution { cfg.videoFormat = f }
        sceneView.session.run(cfg)
        HDCapture.setCameraLocked(false)
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in if self?.finished == false { HDCapture.setCameraLocked(true) } }
        timer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in self?.poll() }
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        UIApplication.shared.isIdleTimerDisabled = false
        HDCapture.setCameraLocked(false)
        timer?.invalidate(); timer = nil
    }

    // MARK: съёмка

    private func poll() {
        guard !finished, let hd = hd, let frame = sceneView.session.currentFrame else { return }
        if case .normal = frame.camera.trackingState {} else {
            statusLabel.text = "  Телефон теряет положение — больше света, медленнее  "; return
        }
        if hd.consider(frame: frame, ciContext: ciContext) {
            markCoverage(frame)
            statusLabel.text = "  Кадров: \(hd.count)\(hd.blurRejected > 0 ? " · смазано: \(hd.blurRejected)" : "")  "
        }
    }

    /// Точки глубины принятого кадра (до 3 м, средняя и высокая уверенность) → воксели «снято»
    private func markCoverage(_ frame: ARFrame) {
        let pts = depthWorldPoints(frame, step: 2)
        let camPos = simd_float3(frame.camera.transform.columns.3.x, frame.camera.transform.columns.3.y, frame.camera.transform.columns.3.z)
        coverLock.lock()
        for p in pts where simd_length(p - camPos) < 3 {
            covered.insert(SIMD3(Int32((p.x / voxel).rounded(.down)), Int32((p.y / voxel).rounded(.down)), Int32((p.z / voxel).rounded(.down))))
        }
        coverVersion += 1
        coverLock.unlock()
    }

    private func isCovered(_ p: simd_float3) -> Bool {
        let k = SIMD3(Int32((p.x / voxel).rounded(.down)), Int32((p.y / voxel).rounded(.down)), Int32((p.z / voxel).rounded(.down)))
        return covered.contains(k)
    }

    // MARK: синяя заливка неснятого по сетке лидара

    func renderer(_ renderer: SCNSceneRenderer, nodeFor anchor: ARAnchor) -> SCNNode? {
        guard let a = anchor as? ARMeshAnchor else { return nil }
        let n = SCNNode()
        n.geometry = uncoveredGeometry(a)
        return n
    }

    func renderer(_ renderer: SCNSceneRenderer, didUpdate node: SCNNode, for anchor: ARAnchor) {
        guard let a = anchor as? ARMeshAnchor else { return }
        node.geometry = uncoveredGeometry(a)
        nodeVersion[a.identifier] = coverVersion
    }

    /// раз в полсекунды перекрашиваем якоря, у которых покрытие устарело (новые кадры)
    func renderer(_ renderer: SCNSceneRenderer, updateAtTime time: TimeInterval) {
        guard time - lastRecolor > 0.5, let frame = sceneView.session.currentFrame else { return }
        lastRecolor = time
        let v = coverVersion
        let cam = frame.camera.transform.columns.3
        // кадры добавляют покрытие только вблизи камеры — дальние якоря не пересчитываем
        for a in frame.anchors.compactMap({ $0 as? ARMeshAnchor }) where (nodeVersion[a.identifier] ?? -1) != v {
            let c = a.transform.columns.3
            if simd_length(simd_float3(c.x - cam.x, c.y - cam.y, c.z - cam.z)) > 5 { continue }
            guard let node = sceneView.node(for: a) else { continue }
            node.geometry = uncoveredGeometry(a)
            nodeVersion[a.identifier] = v
        }
    }

    /// Только треугольники, у которых есть неснятая вершина, — полупрозрачным синим
    private func uncoveredGeometry(_ a: ARMeshAnchor) -> SCNGeometry? {
        let g = a.geometry, vs = g.vertices, fs = g.faces
        guard fs.indexCountPerPrimitive == 3, vs.count > 0 else { return nil }
        let vb = vs.buffer.contents().advanced(by: vs.offset)
        var local = [SCNVector3](); local.reserveCapacity(vs.count)
        var cov = [Bool](repeating: false, count: vs.count)
        coverLock.lock()
        for i in 0..<vs.count {
            let v = vb.advanced(by: i * vs.stride).assumingMemoryBound(to: (Float, Float, Float).self).pointee
            local.append(SCNVector3(v.0, v.1, v.2))
            let w = a.transform * simd_float4(v.0, v.1, v.2, 1)
            cov[i] = isCovered(simd_float3(w.x, w.y, w.z))
        }
        coverLock.unlock()
        var idx = [UInt32](); idx.reserveCapacity(fs.count * 3)
        let fb = fs.buffer.contents()
        for f in 0..<fs.count {
            let o = f * 3 * fs.bytesPerIndex
            var t = [Int](repeating: 0, count: 3)
            if fs.bytesPerIndex == 4 { let p = fb.advanced(by: o).assumingMemoryBound(to: UInt32.self); t = [Int(p[0]), Int(p[1]), Int(p[2])] }
            else { let p = fb.advanced(by: o).assumingMemoryBound(to: UInt16.self); t = [Int(p[0]), Int(p[1]), Int(p[2])] }
            if !(cov[t[0]] && cov[t[1]] && cov[t[2]]) { idx += [UInt32(t[0]), UInt32(t[1]), UInt32(t[2])] }
        }
        guard !idx.isEmpty else { return nil }
        let src = SCNGeometrySource(vertices: local)
        let el = SCNGeometryElement(indices: idx, primitiveType: .triangles)
        let geo = SCNGeometry(sources: [src], elements: [el])
        let m = SCNMaterial()
        m.lightingModel = .constant
        m.diffuse.contents = UIColor(red: 0.20, green: 0.45, blue: 1.0, alpha: 1)
        m.transparency = 0.42
        m.isDoubleSided = true
        m.writesToDepthBuffer = false
        geo.materials = [m]
        return geo
    }

    // MARK: кнопки

    @objc private func cancelTapped() {
        guard !finished else { return }
        let ac = UIAlertController(title: "Отменить скан?", message: "Снятое будет удалено.", preferredStyle: .alert)
        ac.addAction(UIAlertAction(title: "Продолжить скан", style: .cancel))
        ac.addAction(UIAlertAction(title: "Отменить", style: .destructive) { [weak self] _ in
            guard let self = self else { return }
            self.finished = true
            self.timer?.invalidate()
            self.sceneView.session.pause()
            self.hd?.discard()
            self.dismiss(animated: true) { self.completion(.failure(RoomScanViewController.ScanError.cancelled)) }
        })
        present(ac, animated: true)
    }

    @objc private func doneTapped() {
        guard !finished, let hd = hd else { return }
        guard hd.count >= 5 else {
            let ac = UIAlertController(title: "Мало кадров", message: "Снято кадров: \(hd.count). Поводите телефоном по комнате, пока синее не исчезнет.", preferredStyle: .alert)
            ac.addAction(UIAlertAction(title: "OK", style: .default)); present(ac, animated: true); return
        }
        finished = true
        timer?.invalidate()
        let anchors = sceneView.session.currentFrame?.anchors.compactMap { $0 as? ARMeshAnchor } ?? []
        sceneView.session.pause()
        statusLabel.text = "  Упаковываю HD-кадры…  "
        let label = statusLabel
        Task { @MainActor in
            var out: [String: Any] = ["mode": "lidar"]
            hd.flushJournal()
            // points.ply для старта обучения на компьютере — та же сетка лидара (цвет не нужен)
            let meshInput = MeshInput(anchors: anchors, keyFrames: [])
            let packed = await Task.detached(priority: .userInitiated) { () -> (String?, String?) in
                let mesh = meshInput.anchors.isEmpty ? [:] : buildColoredMesh(meshInput)
                let ply = (mesh["meshVertices"] as? Int ?? 0) > 0 ? (mesh["mesh"] as? String).flatMap { Data(base64Encoded: $0) } : nil
                do { return (try hd.finish(pointsPLY: ply, keepFiles: true).path, nil) } catch { return (nil, error.localizedDescription) }
            }.value
            if let path = packed.0 {
                out["hdZip"] = path; out["hdFrames"] = hd.count
                out["hdBytes"] = ((try? FileManager.default.attributesOfItem(atPath: path)[.size]) as? NSNumber)?.intValue ?? 0
            } else if let e = packed.1 { out["hdError"] = e }
            if !anchors.isEmpty {
                label.text = "  Собираю 3D-модель…  "
                let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("scan-models", isDirectory: true)
                try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
                let url = dir.appendingPathComponent("Fixpoint-LiDAR-\(Int(Date().timeIntervalSince1970)).glb")
                let input = TexInput(anchors: anchors, frames: hd.texFrames)
                let t0 = Date()
                let res = await Task.detached(priority: .userInitiated) { () -> (faces: Int, seen: Int)? in
                    TextureBuilder.build(anchors: input.anchors, frames: input.frames, to: url) { p in
                        DispatchQueue.main.async { label.text = "  Собираю 3D-модель… \(Int(p * 100))%  " }
                    }
                }.value
                if let r = res, FileManager.default.fileExists(atPath: url.path) {
                    out["texModel"] = url.path; out["texFaces"] = r.faces; out["texSeen"] = r.seen
                    out["texSeconds"] = Int(Date().timeIntervalSince(t0))
                }
            }
            try? FileManager.default.removeItem(at: hd.dir)
            self.dismiss(animated: true) { self.completion(.success(out)) }
        }
    }
}
