import Foundation
import UIKit
import Capacitor
import RoomPlan

/// Мост Стенограф ↔ Apple RoomPlan.
/// JS: const RP = Capacitor.registerPlugin('RoomPlan');
///   await RP.isSupported()
///   await RP.scan({ mode: 'measure' | 'walk' | 'multi' | 'final' | 'ghost', frames?: bool, overlay?: {...} })
@objc(RoomPlanPlugin)
public class RoomPlanPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "RoomPlanPlugin"
    public let jsName = "RoomPlan"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isSupported", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "scan", returnType: CAPPluginReturnPromise),
    ]

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
        guard #available(iOS 17.0, *), RoomCaptureSession.isSupported else {
            call.reject("Лидар не поддерживается на этом устройстве")
            return
        }
        let mode = call.getString("mode") ?? "measure"
        let maxDim = call.getInt("maxDim") ?? 1600
        let wantFrames = call.getBool("frames") ?? (mode == "walk")
        let overlay = call.getObject("overlay")
        DispatchQueue.main.async {
            let vc = RoomScanViewController(mode: mode, maxDim: maxDim, wantFrames: wantFrames, overlay: overlay) { result in
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
