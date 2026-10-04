import Foundation
import UIKit
import Capacitor
import RoomPlan
import ARKit
import AVFoundation
import QuickLook

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
        CAPPluginMethod(name: "deviceInfo", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "quickLook", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "shareFile", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "fileInfo", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "deleteFile", returnType: CAPPluginReturnPromise),
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
        DispatchQueue.main.async {
            let vc = RoomScanViewController(mode: mode, maxDim: maxDim, wantFrames: wantFrames, overlay: overlay, hd: hd) { result in
                switch result {
                case .success(let dict): call.resolve(dict)
                case .failure(let err): call.reject(err.localizedDescription)
                }
            }
            vc.modalPresentationStyle = .fullScreen
            guard let host = self.bridge?.viewController else {
                call.reject("Нет окна для сканирования")
                return
            }
            host.present(vc, animated: true)
        }
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
