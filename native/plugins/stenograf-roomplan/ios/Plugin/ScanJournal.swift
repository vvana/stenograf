import Foundation
import ARKit
import RoomPlan
import simd

/// Журнал скана на диске (2026-10-23, просьба пользователя): во время обхода/обмера по ходу съёмки пишется всё, из чего
/// потом можно собрать результат без AR-сессии, — принятые комнаты (CapturedRoom — Codable), текущая комната по последнему
/// виду RoomPlan, кадры стен (JPEG + углы стены в кадре), путь к папке HD-кадров (HDCapture сам пишет entries.json).
/// Если iOS выгрузит приложение (долгий звонок) или оно упадёт, при следующем запуске JS спросит «Восстановить скан?» —
/// метод плагина recoverScan соберёт результат так же, как при обычном завершении, и отдаст его тому же коду, что и скан.
/// Обычное завершение или отмена скана журнал удаляют. Не восстанавливается: сетка лидара (якоря живут в сессии),
/// ключевые кадры для её окраски, снимки пола/потолка, покрытие.
final class ScanJournal {
    static var root: URL {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("scan-journal", isDirectory: true)
    }
    private var dir: URL { Self.root }
    private var framesDir: URL { dir.appendingPathComponent("frames", isDirectory: true) }
    private var writtenFrames = Set<UUID>()
    private var lastCurrent = Date.distantPast
    private let io = DispatchQueue(label: "fixpoint.journal", qos: .utility)

    /// Новый журнал: прежний (если остался) удаляется вместе с его HD-кадрами — JS предлагает восстановить его до нового скана.
    init(mode: String, hd: Bool, wantFrames: Bool, maxDim: Int, hdDir: URL?, context: [String: Any]?) {
        Self.discard()
        try? FileManager.default.createDirectory(at: framesDir, withIntermediateDirectories: true)
        var m: [String: Any] = ["created": Date().timeIntervalSince1970 * 1000, "mode": mode, "hd": hd,
                                "frames": wantFrames, "maxDim": maxDim]
        if let h = hdDir { m["hdDir"] = h.lastPathComponent }
        if let c = context { m["context"] = c }
        Self.writeJSON(m, to: dir.appendingPathComponent("manifest.json"))
    }

    /// Продолжение скана с паузы: журнал не удаляется, уже записанные кадры стен не переписываются.
    init(resuming frames: [UUID: [RoomScanViewController.WallFrame]]) {
        for list in frames.values { for f in list { writtenFrames.insert(f.id) } }
        Self.updateManifest { $0["paused"] = false }
    }

    // MARK: пауза (2026-10-23): карта места ARKit + недоснятая комната — чтобы продолжить в тех же координатах

    func saveWorldMap(_ map: ARWorldMap) {
        guard let data = try? NSKeyedArchiver.archivedData(withRootObject: map, requiringSecureCoding: true) else { return }
        try? data.write(to: dir.appendingPathComponent("worldmap.bin"), options: .atomic)
    }

    /// Комната, недоснятая на момент паузы: её кадры стен потом переносятся на стены, снятые после продолжения (по геометрии).
    func savePausedRoom(_ room: CapturedRoom?) {
        guard let room = room else { return }
        var list = Self.pausedRooms(); list.append(room)
        if let data = try? JSONEncoder().encode(list) { try? data.write(to: dir.appendingPathComponent("paused-rooms.json"), options: .atomic) }
    }

    func markPaused(hasMap: Bool) {
        flush()
        Self.updateManifest { $0["paused"] = true; $0["pausedAt"] = Date().timeIntervalSince1970 * 1000; $0["worldMap"] = hasMap }
    }

    static func worldMap() -> ARWorldMap? {
        guard let d = try? Data(contentsOf: root.appendingPathComponent("worldmap.bin")) else { return nil }
        return try? NSKeyedUnarchiver.unarchivedObject(ofClass: ARWorldMap.self, from: d)
    }

    static func pausedRooms() -> [CapturedRoom] {
        guard let d = try? Data(contentsOf: root.appendingPathComponent("paused-rooms.json")) else { return [] }
        return (try? JSONDecoder().decode([CapturedRoom].self, from: d)) ?? []
    }

    private static func updateManifest(_ change: (inout [String: Any]) -> Void) {
        var m = manifest() ?? [:]
        change(&m)
        writeJSON(m, to: root.appendingPathComponent("manifest.json"))
    }

    func saveRooms(_ rooms: [CapturedRoom]) {
        guard let data = try? JSONEncoder().encode(rooms) else { return }
        let url = dir.appendingPathComponent("rooms.json")
        io.async { try? data.write(to: url, options: .atomic) }
    }

    /// Текущая комната по последнему виду RoomPlan — не чаще раза в 5 с.
    func saveCurrent(_ room: CapturedRoom?) {
        guard let room = room, Date().timeIntervalSince(lastCurrent) > 5 else { return }
        lastCurrent = Date()
        guard let data = try? JSONEncoder().encode(room) else { return }
        let url = dir.appendingPathComponent("current.json")
        io.async { try? data.write(to: url, options: .atomic) }
    }

    func clearCurrent() {
        let url = dir.appendingPathComponent("current.json")
        io.async { try? FileManager.default.removeItem(at: url) }
    }

    /// Кадры стен: JPEG каждого кадра пишется один раз (и заново, если его заменил снимок 12 Мп), индекс — целиком.
    func saveFrames(_ frames: [UUID: [RoomScanViewController.WallFrame]], rewrite: UUID? = nil) {
        var index: [[String: Any]] = []
        var toWrite: [(URL, Data)] = []
        for (wall, list) in frames {
            for f in list {
                index.append(["id": f.id.uuidString, "wall": wall.uuidString, "score": f.score, "full": f.full,
                              "cam": [f.camPos.x, f.camPos.y, f.camPos.z], "dir": [f.camDir.x, f.camDir.y, f.camDir.z],
                              "corners": f.corners, "w": f.w, "h": f.h])
                if !writtenFrames.contains(f.id) || f.id == rewrite {
                    writtenFrames.insert(f.id)
                    toWrite.append((framesDir.appendingPathComponent(f.id.uuidString + ".jpg"), f.jpeg))
                }
            }
        }
        let url = dir.appendingPathComponent("frames.json")
        io.async {
            for (u, d) in toWrite { try? d.write(to: u, options: .atomic) }
            Self.writeJSON(["frames": index], to: url)
        }
    }

    func flush() { io.sync {} }

    // MARK: чтение при восстановлении

    static func manifest() -> [String: Any]? {
        guard let d = try? Data(contentsOf: root.appendingPathComponent("manifest.json")),
              let m = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { return nil }
        return m
    }

    static func rooms() -> [CapturedRoom] {
        guard let d = try? Data(contentsOf: root.appendingPathComponent("rooms.json")) else { return [] }
        return (try? JSONDecoder().decode([CapturedRoom].self, from: d)) ?? []
    }

    static func current() -> CapturedRoom? {
        guard let d = try? Data(contentsOf: root.appendingPathComponent("current.json")) else { return nil }
        return try? JSONDecoder().decode(CapturedRoom.self, from: d)
    }

    static func frames() -> [UUID: [RoomScanViewController.WallFrame]] {
        guard let d = try? Data(contentsOf: root.appendingPathComponent("frames.json")),
              let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
              let list = j["frames"] as? [[String: Any]] else { return [:] }
        var out: [UUID: [RoomScanViewController.WallFrame]] = [:]
        for f in list {
            guard let ids = f["id"] as? String, let id = UUID(uuidString: ids),
                  let ws = f["wall"] as? String, let wall = UUID(uuidString: ws),
                  let jpeg = try? Data(contentsOf: root.appendingPathComponent("frames/\(ids).jpg")) else { continue }
            func v3(_ k: String) -> simd_float3 {
                let a = (f[k] as? [NSNumber])?.map { $0.floatValue } ?? [0, 0, 0]
                return a.count == 3 ? simd_float3(a[0], a[1], a[2]) : simd_float3(0, 0, 0)
            }
            let corners = (f["corners"] as? [[NSNumber]])?.map { $0.map { $0.floatValue } } ?? []
            let wf = RoomScanViewController.WallFrame(score: (f["score"] as? NSNumber)?.floatValue ?? 0, full: f["full"] as? Bool ?? false,
                                                      camPos: v3("cam"), camDir: v3("dir"), jpeg: jpeg, corners: corners,
                                                      w: (f["w"] as? NSNumber)?.floatValue ?? 0, h: (f["h"] as? NSNumber)?.floatValue ?? 0, id: id)
            out[wall, default: []].append(wf)
        }
        return out
    }

    static var hdDir: URL? {
        guard let name = manifest()?["hdDir"] as? String else { return nil }
        let u = root.deletingLastPathComponent().appendingPathComponent(name, isDirectory: true)
        return FileManager.default.fileExists(atPath: u.path) ? u : nil
    }

    /// Сводка для вопроса «Восстановить скан?»; nil — восстанавливать нечего.
    static func summary() -> [String: Any]? {
        guard let m = manifest() else { return nil }
        let rooms = Self.rooms().count
        let cur = Self.current().map { $0.walls.count >= 3 } ?? false
        let frames = Self.frames().values.reduce(0) { $0 + $1.count }
        let hd = hdDir.map { HDCapture.journalCount(dir: $0) } ?? 0
        if rooms == 0 && !cur && frames == 0 && hd == 0 { discard(); return nil }
        var out = m
        out["rooms"] = rooms; out["current"] = cur; out["wallFrames"] = frames; out["hdFrames"] = hd
        return out
    }

    /// Удалить журнал; с HD-кадрами (keepHD: false) — когда пользователь отказался восстанавливать.
    static func discard(keepHD: Bool = false) {
        if !keepHD, let h = hdDir { try? FileManager.default.removeItem(at: h) }
        try? FileManager.default.removeItem(at: root)
    }

    private static func writeJSON(_ obj: [String: Any], to url: URL) {
        if let d = try? JSONSerialization.data(withJSONObject: obj) { try? d.write(to: url, options: .atomic) }
    }
}
