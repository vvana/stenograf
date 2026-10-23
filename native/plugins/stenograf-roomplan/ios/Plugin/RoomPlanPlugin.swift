import Foundation
import UIKit
import Capacitor
import RoomPlan
import ARKit
import AVFoundation
import QuickLook
import Photos
import Contacts
import ContactsUI
import UniformTypeIdentifiers
import CoreLocation

/// Мост Fixpoint ↔ Apple RoomPlan.
/// JS: const RP = Capacitor.registerPlugin('RoomPlan');
///   await RP.isSupported()
///   await RP.scan({ mode: 'measure' | 'walk' | 'multi' | 'final' | 'ghost', frames?: bool, overlay?: {...}, hd?: bool })
///   await RP.shareFile({ path }) / RP.fileInfo({ path }) / RP.deleteFile({ path }) — файлы в Documents (HD-пакет)
@objc(RoomPlanPlugin)
public class RoomPlanPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "RoomPlanPlugin"
    public let jsName = "RoomPlan"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isSupported", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "scan", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pendingScan", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "recoverScan", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "discardScan", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "deviceInfo", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "quickLook", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "shareFile", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "fileInfo", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "deleteFile", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "htmlPdf", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "saveImage", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openSettings", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "saveFile", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "saveFileAs", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pickFile", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "takeIncoming", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getLocation", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pickContact", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "searchContacts", returnType: CAPPluginReturnPromise),
    ]
    private var qlSource: ModelPreviewSource?

    /// Показать оригинальную модель RoomPlan (USDZ) во встроенном просмотрщике iOS: 3D и AR.
    @objc func quickLook(_ call: CAPPluginCall) {
        guard let b64 = call.getString("usdz"), let data = Data(base64Encoded: b64) else {
            call.reject("Нет модели")
            return
        }
        let title = call.getString("title") ?? "Модель RoomPlan"
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("stenograf-model.usdz")
        do {
            try? FileManager.default.removeItem(at: url)
            try data.write(to: url)
        } catch {
            call.reject("Не удалось сохранить модель: \(error.localizedDescription)")
            return
        }
        DispatchQueue.main.async {
            guard let host = self.bridge?.viewController else {
                call.reject("Нет окна для просмотра")
                return
            }
            let src = ModelPreviewSource(url: url, title: title)
            self.qlSource = src
            let ql = QLPreviewController()
            ql.dataSource = src
            host.present(ql, animated: true)
            call.resolve()
        }
    }

    /// Файл из папки приложения (Documents) — только оттуда, чтобы JS не мог отдать чужой путь.
    private func docFile(_ call: CAPPluginCall) -> URL? {
        guard let path = call.getString("path") else { return nil }
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].standardizedFileURL.path
        let url = URL(fileURLWithPath: path).standardizedFileURL
        return url.path.hasPrefix(docs + "/") ? url : nil
    }

    /// Системное меню «Поделиться» для файла (HD-пакет большой — через мост его не гоняем).
    @objc func shareFile(_ call: CAPPluginCall) {
        guard let url = docFile(call), FileManager.default.fileExists(atPath: url.path) else {
            call.reject("Файл не найден")
            return
        }
        DispatchQueue.main.async {
            guard let host = self.bridge?.viewController else { call.reject("Нет окна"); return }
            let ac = UIActivityViewController(activityItems: [url], applicationActivities: nil)
            if let pop = ac.popoverPresentationController {   // iPad
                pop.sourceView = host.view
                pop.sourceRect = CGRect(x: host.view.bounds.midX, y: host.view.bounds.maxY - 40, width: 1, height: 1)
            }
            ac.completionWithItemsHandler = { _, completed, _, _ in call.resolve(["completed": completed]) }
            host.present(ac, animated: true)
        }
    }

    /// HTML → PDF (A4, поля 15 мм) средствами iOS и меню «Поделиться». window.print() во WKWebView не работает.
    @objc func htmlPdf(_ call: CAPPluginCall) {
        guard let html = call.getString("html") else { call.reject("Нет html"); return }
        let raw = call.getString("name") ?? "Fixpoint"
        let name = raw.replacingOccurrences(of: "[/\\:*?\"<>|]", with: "_", options: .regularExpression)
        DispatchQueue.main.async {
            guard let host = self.bridge?.viewController else { call.reject("Нет окна"); return }
            let fmt = UIMarkupTextPrintFormatter(markupText: html)
            let renderer = UIPrintPageRenderer()
            renderer.addPrintFormatter(fmt, startingAtPageAt: 0)
            let page = CGRect(x: 0, y: 0, width: 595.2, height: 841.8)          // A4 в пунктах
            let margin: CGFloat = 42.5                                            // 15 мм
            renderer.setValue(NSValue(cgRect: page), forKey: "paperRect")
            renderer.setValue(NSValue(cgRect: page.insetBy(dx: margin, dy: margin)), forKey: "printableRect")
            let data = NSMutableData()
            UIGraphicsBeginPDFContextToData(data, page, nil)
            renderer.prepare(forDrawingPages: NSRange(location: 0, length: renderer.numberOfPages))
            for i in 0..<renderer.numberOfPages {
                UIGraphicsBeginPDFPage()
                renderer.drawPage(at: i, in: UIGraphicsGetPDFContextBounds())
            }
            UIGraphicsEndPDFContext()
            let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("exports", isDirectory: true)
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            let url = dir.appendingPathComponent(name + ".pdf")
            do { try data.write(to: url, options: .atomic) } catch { call.reject("Не удалось сохранить PDF: \(error.localizedDescription)"); return }
            let ac = UIActivityViewController(activityItems: [url], applicationActivities: nil)
            if let pop = ac.popoverPresentationController {   // iPad
                pop.sourceView = host.view
                pop.sourceRect = CGRect(x: host.view.bounds.midX, y: host.view.bounds.maxY - 40, width: 1, height: 1)
            }
            ac.completionWithItemsHandler = { _, completed, _, _ in call.resolve(["path": url.path, "pages": renderer.numberOfPages, "completed": completed]) }
            host.present(ac, animated: true)
        }
    }

    /// Картинка (base64 JPEG/PNG) → приложение «Фото». Нужен только доступ «добавлять» (NSPhotoLibraryAddUsageDescription).
    @objc func saveImage(_ call: CAPPluginCall) {
        guard let b64 = call.getString("data"), let data = Data(base64Encoded: b64), let img = UIImage(data: data) else {
            call.reject("Нет картинки"); return
        }
        PHPhotoLibrary.requestAuthorization(for: .addOnly) { status in
            guard status == .authorized || status == .limited else {
                call.reject("Нет доступа к «Фото»", "denied"); return
            }
            PHPhotoLibrary.shared().performChanges({ PHAssetChangeRequest.creationRequestForAsset(from: img) }) { ok, err in
                if ok { call.resolve() } else { call.reject(err?.localizedDescription ?? "Не удалось сохранить") }
            }
        }
    }

    /// Страница приложения в «Настройках» (там пункт «Фото»). Прямо на сам пункт iOS открыть не даёт.
    @objc func openSettings(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let url = URL(string: UIApplication.openSettingsURLString) else { call.reject("Нет ссылки"); return }
            UIApplication.shared.open(url) { ok in call.resolve(["opened": ok]) }
        }
    }

    /// Файл (base64) → Documents/exports/<имя> — виден в «Файлы» → «На iPhone» → Fixpoint (UIFileSharingEnabled).
    @objc func saveFile(_ call: CAPPluginCall) {
        guard let b64 = call.getString("data"), let data = Data(base64Encoded: b64) else { call.reject("Нет данных"); return }
        let raw = call.getString("name") ?? "Fixpoint.bin"
        let name = raw.replacingOccurrences(of: "[/\\:*?\"<>|]", with: "_", options: .regularExpression)
        let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("exports", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appendingPathComponent(name)
        do { try data.write(to: url, options: .atomic); call.resolve(["path": url.path]) }
        catch { call.reject("Не удалось сохранить: \(error.localizedDescription)") }
    }

    /// Файл (base64) → системное окно «Сохранить в Файлы»: пользователь сам выбирает папку (iCloud Drive, «На iPhone», Google Drive…).
    /// Ответ {saved: true/false}; отмена — saved: false.
    private var exportDelegate: ExportPickerDelegate?
    @objc func saveFileAs(_ call: CAPPluginCall) {
        guard let b64 = call.getString("data"), let data = Data(base64Encoded: b64) else { call.reject("Нет данных"); return }
        let raw = call.getString("name") ?? "Fixpoint.bin"
        let name = raw.replacingOccurrences(of: "[/\\:*?\"<>|]", with: "_", options: .regularExpression)
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("export-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appendingPathComponent(name)
        do { try data.write(to: url, options: .atomic) } catch { call.reject("Не удалось подготовить файл: \(error.localizedDescription)"); return }
        DispatchQueue.main.async {
            guard let host = self.bridge?.viewController else { call.reject("Нет окна"); return }
            let picker = UIDocumentPickerViewController(forExporting: [url], asCopy: true)
            let d = ExportPickerDelegate { [weak self] saved in
                self?.exportDelegate = nil
                try? FileManager.default.removeItem(at: dir)
                call.resolve(["saved": saved])
            }
            self.exportDelegate = d
            picker.delegate = d
            host.present(picker, animated: true)
        }
    }

    /// Выбор файла системным окном «Файлы»: все места — «На iPhone», iCloud Drive, Google Диск (если стоит его приложение) и т. д.
    /// Тип не ограничиваем (.item): у .ply/.spz нет системного типа, и окно браузера (<input type=file>) делает их серыми.
    /// Файл (после скачивания, если он в облаке) копируется в Documents/import; ответ {picked, path, name, size}; JS читает его через convertFileSrc и удаляет (deleteFile).
    private var pickDelegate: PickFileDelegate?
    @objc func pickFile(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let host = self.bridge?.viewController else { call.reject("Нет окна"); return }
            // asCopy: false — окно закрывается сразу после тапа, а скачивание (Google Диск, iCloud) идёт уже у нас
            // через NSFileCoordinator с окном «Загружаю файл…». С asCopy: true окно молча ждало скачивания 150+ МБ,
            // и казалось, что файл не выбирается (запись экрана пользователя 2026-10-20).
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.item], asCopy: false)
            picker.allowsMultipleSelection = false
            let d = PickFileDelegate { [weak self] src in
                self?.pickDelegate = nil
                guard let src = src else { call.resolve(["picked": false]); return }
                let wait = UIAlertController(title: "Загружаю файл…", message: src.lastPathComponent, preferredStyle: .alert)
                host.present(wait, animated: true)
                DispatchQueue.global(qos: .userInitiated).async {
                    let scoped = src.startAccessingSecurityScopedResource()
                    defer { if scoped { src.stopAccessingSecurityScopedResource() } }
                    // в Documents — deleteFile удаляет только там; UUID в имени, чтобы не затереть одноимённый файл
                    let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("import", isDirectory: true)
                    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
                    let dst = dir.appendingPathComponent(UUID().uuidString + "-" + src.lastPathComponent)
                    var failure: String?
                    var coordErr: NSError?
                    NSFileCoordinator().coordinate(readingItemAt: src, options: [], error: &coordErr) { url in
                        do { try FileManager.default.copyItem(at: url, to: dst) } catch { failure = error.localizedDescription }
                    }
                    if let e = coordErr { failure = e.localizedDescription }
                    let size = ((try? FileManager.default.attributesOfItem(atPath: dst.path)[.size]) as? NSNumber)?.intValue ?? 0
                    let fail = failure
                    DispatchQueue.main.async {
                        wait.dismiss(animated: true) {
                            if let f = fail { call.reject("Не удалось взять файл: \(f)"); return }
                            call.resolve(["picked": true, "path": dst.path, "name": src.lastPathComponent, "size": size])
                        }
                    }
                }
            }
            self.pickDelegate = d
            picker.delegate = d
            picker.presentationController?.delegate = d
            host.present(picker, animated: true)
        }
    }

    /// Файл, присланный в приложение из другого: «Поделиться → Fixpoint» в Telegram, Google Диске, «Файлах», почте, AirDrop.
    /// Типы .ply/.spz/.splat/.ksplat объявлены в Info.plist (CI). iOS открывает приложение с URL файла → Capacitor шлёт
    /// уведомление capacitorOpenURL; при холодном старте оно могло прийти раньше загрузки плагина — тогда берём lastURL.
    /// Файл копируется в Documents/import, JS получает его через takeIncoming() (при старте и по событию окна fixpointIncoming).
    private var incoming: [String: Any]?
    private static let modelExts: Set<String> = ["ply", "spz", "splat", "ksplat"]
    override public func load() {
        NotificationCenter.default.addObserver(self, selector: #selector(onOpenURL(_:)), name: Notification.Name.capacitorOpenURL, object: nil)
        if let url = ApplicationDelegateProxy.shared.lastURL { receive(url) }
    }
    @objc private func onOpenURL(_ note: Notification) {
        guard let info = note.object as? [String: Any], let url = info["url"] as? URL else { return }
        receive(url)
    }
    private func receive(_ src: URL) {
        guard src.isFileURL, Self.modelExts.contains(src.pathExtension.lowercased()) else { return }
        DispatchQueue.global(qos: .userInitiated).async {
            let scoped = src.startAccessingSecurityScopedResource()
            defer { if scoped { src.stopAccessingSecurityScopedResource() } }
            let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            let dir = docs.appendingPathComponent("import", isDirectory: true)
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            let dst = dir.appendingPathComponent(UUID().uuidString + "-" + src.lastPathComponent)
            var ok = false
            var coordErr: NSError?
            NSFileCoordinator().coordinate(readingItemAt: src, options: [], error: &coordErr) { url in
                ok = (try? FileManager.default.copyItem(at: url, to: dst)) != nil
            }
            // копия, которую iOS положила в Documents/Inbox, больше не нужна
            if src.path.hasPrefix(docs.appendingPathComponent("Inbox").path) { try? FileManager.default.removeItem(at: src) }
            guard ok else { return }
            let size = ((try? FileManager.default.attributesOfItem(atPath: dst.path)[.size]) as? NSNumber)?.intValue ?? 0
            let item: [String: Any] = ["path": dst.path, "name": src.lastPathComponent, "size": size]
            DispatchQueue.main.async {
                self.incoming = item
                self.bridge?.triggerWindowJSEvent(eventName: "fixpointIncoming")
            }
        }
    }
    @objc func takeIncoming(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            let item = self.incoming
            self.incoming = nil
            call.resolve(item ?? [:])
        }
    }

    /// Геопозиция для печати фото — через CoreLocation, по системному разрешению приложения (то же, что у компаса в сканере).
    /// Раньше JS брал её через navigator.geolocation, и встроенный браузер спрашивал «localhost хочет использовать геопозицию»
    /// при каждом запуске (WKWebView не запоминает разрешение сайта). Ответ {lat, lon, acc} или {denied: true} / {} по таймауту.
    private var geoOnce: LocationOnce?
    @objc func getLocation(_ call: CAPPluginCall) {
        let timeout = call.getDouble("timeout") ?? 4
        DispatchQueue.main.async {
            if self.geoOnce != nil { call.resolve([:]); return }   // уже идёт запрос — без геометки, съёмку не держим
            let g = LocationOnce(timeout: timeout) { [weak self] loc, denied in
                self?.geoOnce = nil
                if denied { call.resolve(["denied": true]); return }
                guard let l = loc else { call.resolve([:]); return }
                call.resolve(["lat": l.coordinate.latitude, "lon": l.coordinate.longitude, "acc": l.horizontalAccuracy])
            }
            self.geoOnce = g
            g.start()
        }
    }

    /// Выбор контакта системным окном iOS (CNContactPickerViewController): окно работает вне приложения,
    /// поэтому разрешение на доступ ко всей книге контактов не нужно — приложение получает только выбранный контакт.
    /// Ответ {picked, name, phones: [String]}; отмена — picked: false.
    private var contactDelegate: ContactPickerDelegate?
    @objc func pickContact(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let host = self.bridge?.viewController else { call.reject("Нет окна"); return }
            let picker = CNContactPickerViewController()
            picker.displayedPropertyKeys = [CNContactPhoneNumbersKey]
            let d = ContactPickerDelegate { [weak self] contact in
                self?.contactDelegate = nil
                guard let c = contact else { call.resolve(["picked": false]); return }
                var name = [c.givenName, c.familyName].filter { !$0.isEmpty }.joined(separator: " ")
                if name.isEmpty { name = c.organizationName }
                let phones = c.phoneNumbers.map { $0.value.stringValue }
                call.resolve(["picked": true, "name": name, "phones": phones])
            }
            self.contactDelegate = d
            picker.delegate = d
            host.present(picker, animated: true)
        }
    }

    /// Подсказки при вводе имени/телефона исполнителя: поиск по контактам телефона (нужен доступ к контактам —
    /// при первом вызове iOS спрашивает; с iOS 18 можно дать доступ к части контактов). Ответ {access, items:[{name, phones}]};
    /// access: "ok" | "denied". Ищем по вхождению в имя (без регистра) или по цифрам номера (от 3 цифр), не больше 8 контактов.
    private let contactStore = CNContactStore()
    @objc func searchContacts(_ call: CAPPluginCall) {
        let q = (call.getString("q") ?? "").trimmingCharacters(in: .whitespaces)
        let run = {
            DispatchQueue.global(qos: .userInitiated).async {
                let needle = q.lowercased()
                let digits = q.filter { $0.isNumber }
                let byPhone = digits.count >= 3 && digits.count * 2 >= q.filter { !$0.isWhitespace }.count
                let keys = [CNContactGivenNameKey, CNContactFamilyNameKey, CNContactOrganizationNameKey, CNContactPhoneNumbersKey] as [CNKeyDescriptor]
                let req = CNContactFetchRequest(keysToFetch: keys)
                var items: [[String: Any]] = []
                if !needle.isEmpty {
                    try? self.contactStore.enumerateContacts(with: req) { c, stop in
                        var name = [c.givenName, c.familyName].filter { !$0.isEmpty }.joined(separator: " ")
                        if name.isEmpty { name = c.organizationName }
                        let phones = c.phoneNumbers.map { $0.value.stringValue }
                        if phones.isEmpty { return }
                        let hit: Bool
                        if byPhone {
                            hit = phones.contains { p in p.filter { $0.isNumber }.contains(digits) }
                        } else {
                            hit = name.lowercased().contains(needle)
                        }
                        if hit { items.append(["name": name, "phones": phones]) }
                        if items.count >= 8 { stop.pointee = true }
                    }
                }
                call.resolve(["access": "ok", "items": items])
            }
        }
        switch CNContactStore.authorizationStatus(for: .contacts) {
        case .notDetermined:
            contactStore.requestAccess(for: .contacts) { granted, _ in
                if granted { run() } else { call.resolve(["access": "denied", "items": []]) }
            }
        case .denied, .restricted:
            call.resolve(["access": "denied", "items": []])
        default:   // .authorized и (iOS 18+) .limited — ищем в том, что доступно
            run()
        }
    }

    @objc func fileInfo(_ call: CAPPluginCall) {
        guard let url = docFile(call) else { call.resolve(["exists": false]); return }
        let size = ((try? FileManager.default.attributesOfItem(atPath: url.path)[.size]) as? NSNumber)?.intValue
        call.resolve(["exists": size != nil, "size": size ?? 0])
    }

    @objc func deleteFile(_ call: CAPPluginCall) {
        if let url = docFile(call) { try? FileManager.default.removeItem(at: url) }
        call.resolve()
    }

    /// Подробно: что видит приложение — ARKit, сцена-реконструкция (лидар), RoomPlan, модель.
    @objc func deviceInfo(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            var info: [String: Any] = [
                "ios": UIDevice.current.systemVersion,
                "model": Self.modelIdentifier(),
                "arWorldTracking": ARWorldTrackingConfiguration.isSupported,
                "sceneDepth": ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth),
                "meshReconstruction": ARWorldTrackingConfiguration.supportsSceneReconstruction(.mesh),
                "camera": AVCaptureDevice.authorizationStatus(for: .video).rawValue,
            ]
            if #available(iOS 17.0, *) {
                info["roomPlan"] = RoomCaptureSession.isSupported
            } else {
                info["roomPlan"] = "iOS < 17"
            }
            call.resolve(info)
        }
    }

    static func modelIdentifier() -> String {
        var sys = utsname()
        uname(&sys)
        return withUnsafePointer(to: &sys.machine) {
            $0.withMemoryRebound(to: CChar.self, capacity: 1) { String(cString: $0) }
        }
    }

    @objc func isSupported(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            if #available(iOS 17.0, *) {
                call.resolve(["supported": RoomCaptureSession.isSupported, "ios": UIDevice.current.systemVersion])
            } else {
                call.resolve(["supported": false, "ios": UIDevice.current.systemVersion])
            }
        }
    }

    @objc func scan(_ call: CAPPluginCall) {
        let force = call.getBool("force") ?? false
        guard #available(iOS 17.0, *) else {
            call.reject("Нужна iOS 17 или новее")
            return
        }
        if !force && !RoomCaptureSession.isSupported {
            call.reject("Лидар не поддерживается на этом устройстве (RoomCaptureSession.isSupported = false)")
            return
        }
        let mode = call.getString("mode") ?? "measure"
        let maxDim = call.getInt("maxDim") ?? 1600
        let wantFrames = call.getBool("frames") ?? (mode == "walk")
        let overlay = call.getObject("overlay")
        let hd = call.getBool("hd") ?? false
        let recoverCtx = call.getObject("recover")   // контекст JS для восстановления скана из журнала (см. ScanJournal)
        let resume = call.getBool("resume") ?? false  // продолжить скан, поставленный на паузу
        if resume && ScanJournal.manifest() == nil { call.reject("Нет скана на паузе"); return }
        DispatchQueue.main.async {
            let vc = RoomScanViewController(mode: mode, maxDim: maxDim, wantFrames: wantFrames, overlay: overlay, hd: hd, resume: resume) { result in
                // скан завершён или отменён — журнал больше не нужен (HD-кадры уже упакованы или удалены); пауза — журнал остаётся
                if case .failure(let e) = result, e.localizedDescription == "paused" { } else { ScanJournal.discard(keepHD: true) }
                switch result {
                case .success(let dict): call.resolve(dict)
                case .failure(let err): call.reject(err.localizedDescription)
                }
            }
            vc.journalContext = recoverCtx
            vc.modalPresentationStyle = .fullScreen
            guard let host = self.bridge?.viewController else {
                call.reject("Нет окна для сканирования")
                return
            }
            host.present(vc, animated: true)
        }
    }
}

// MARK: незавершённый скан (приложение выгрузили во время скана) — журнал ScanJournal

extension RoomPlanPlugin {
    /// Есть ли что восстановить: {exists, created, mode, rooms, current, wallFrames, hdFrames, context}
    @objc func pendingScan(_ call: CAPPluginCall) {
        DispatchQueue.global(qos: .userInitiated).async {
            if let s = ScanJournal.summary() { var r = s; r["exists"] = true; call.resolve(r) }
            else { call.resolve(["exists": false]) }
        }
    }

    /// Собрать результат из журнала (как при обычном завершении скана) и удалить журнал.
    @objc func recoverScan(_ call: CAPPluginCall) {
        guard #available(iOS 17.0, *) else { call.reject("Нужна iOS 17 или новее"); return }
        guard let m = ScanJournal.manifest() else { call.reject("Нет незавершённого скана"); return }
        DispatchQueue.main.async {
            let vc = RoomScanViewController(mode: m["mode"] as? String ?? "walk", maxDim: (m["maxDim"] as? NSNumber)?.intValue ?? 1600,
                                            wantFrames: m["frames"] as? Bool ?? false, overlay: nil, hd: m["hd"] as? Bool ?? false) { _ in }
            Task { @MainActor in
                let out = await vc.recoverFromJournal()
                ScanJournal.discard(keepHD: true)
                if var o = out { if let c = m["context"] { o["context"] = c }; call.resolve(o) }
                else { call.reject("Восстанавливать нечего") }
            }
        }
    }

    /// Пользователь отказался восстанавливать — удалить журнал и недоупакованные HD-кадры.
    @objc func discardScan(_ call: CAPPluginCall) {
        ScanJournal.discard()
        call.resolve()
    }
}

final class ModelPreviewItem: NSObject, QLPreviewItem {
    let previewItemURL: URL?
    let previewItemTitle: String?
    init(url: URL, title: String) {
        previewItemURL = url
        previewItemTitle = title
    }
}

final class ModelPreviewSource: NSObject, QLPreviewControllerDataSource {
    let item: ModelPreviewItem
    init(url: URL, title: String) { item = ModelPreviewItem(url: url, title: title) }
    func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }
    func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem { item }
}

final class ExportPickerDelegate: NSObject, UIDocumentPickerDelegate {
    let done: (Bool) -> Void
    init(_ done: @escaping (Bool) -> Void) { self.done = done }
    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) { done(true) }
    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) { done(false) }
}

final class PickFileDelegate: NSObject, UIDocumentPickerDelegate, UIAdaptivePresentationControllerDelegate {
    private var done: ((URL?) -> Void)?
    init(_ done: @escaping (URL?) -> Void) { self.done = done }
    private func finish(_ url: URL?) { let d = done; done = nil; d?(url) }   // ответ ровно один раз
    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) { finish(urls.first) }
    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) { finish(nil) }
    // окно смахнули вниз — тоже отмена, иначе JS ждал бы ответа вечно
    func presentationControllerDidDismiss(_ presentationController: UIPresentationController) { finish(nil) }
}

/// Одна геоточка: при необходимости спрашивает системное разрешение «при использовании», затем requestLocation; таймаут — ответ без точки.
final class LocationOnce: NSObject, CLLocationManagerDelegate {
    private let mgr = CLLocationManager()
    private var done: ((CLLocation?, Bool) -> Void)?
    private let timeout: Double
    init(timeout: Double, _ done: @escaping (CLLocation?, Bool) -> Void) { self.timeout = timeout; self.done = done; super.init() }
    func start() {
        mgr.delegate = self
        mgr.desiredAccuracy = kCLLocationAccuracyHundredMeters
        DispatchQueue.main.asyncAfter(deadline: .now() + timeout) { [weak self] in self?.finish(nil, false) }
        switch mgr.authorizationStatus {
        case .notDetermined: mgr.requestWhenInUseAuthorization()   // ответ придёт в locationManagerDidChangeAuthorization
        case .denied, .restricted: finish(nil, true)
        default: mgr.requestLocation()
        }
    }
    private func finish(_ l: CLLocation?, _ denied: Bool) { let d = done; done = nil; mgr.delegate = nil; d?(l, denied) }
    func locationManagerDidChangeAuthorization(_ m: CLLocationManager) {
        switch m.authorizationStatus {
        case .notDetermined: break
        case .denied, .restricted: finish(nil, true)
        default: m.requestLocation()
        }
    }
    func locationManager(_ m: CLLocationManager, didUpdateLocations locs: [CLLocation]) { finish(locs.last, false) }
    func locationManager(_ m: CLLocationManager, didFailWithError error: Error) { finish(nil, false) }
}

final class ContactPickerDelegate: NSObject, CNContactPickerDelegate {
    let done: (CNContact?) -> Void
    init(_ done: @escaping (CNContact?) -> Void) { self.done = done }
    func contactPicker(_ picker: CNContactPickerViewController, didSelect contact: CNContact) { done(contact) }
    func contactPickerDidCancel(_ picker: CNContactPickerViewController) { done(nil) }
}
