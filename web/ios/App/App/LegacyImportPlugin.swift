import Foundation
import Capacitor
import SwiftData
import Vision
import UIKit

/// 旧版（SwiftUI 版 PhysLog）の記録を読み出して、アプリ（Web 側）に渡す。
/// 旧版は記録を端末の中（SwiftData の default.store）に持っている。同じアプリIDで更新すると、そのファイルは端末に残るので、
/// 旧版と同じ形（Legacy/ のモデル）で開いて読む。書き込みはしない（旧版のファイルは、そのまま残す）。
/// 変換（新しい記録の形へ）は Web 側（src/lib/legacy.ts）で行う。
@objc(LegacyImportPlugin)
public class LegacyImportPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "LegacyImportPlugin"
    public let jsName = "LegacyImport"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "read", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "recognizeText", returnType: CAPPluginReturnPromise),
    ]

    @objc func read(_ call: CAPPluginCall) {
        let fm = FileManager.default
        guard let support = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else {
            call.resolve(["found": false])
            return
        }
        let url = support.appendingPathComponent("default.store")
        // ファイルがないのに開くと、空の保存先が新しく作られてしまうので、先に確かめる
        guard fm.fileExists(atPath: url.path) else {
            call.resolve(["found": false])
            return
        }
        DispatchQueue.main.async {
            do {
                let schema = Schema([
                    BodyMeasurement.self, PhysicalAbility.self, TrainingSession.self,
                    TrainingSet.self, SetEntry.self, ConditionRecord.self, Gym.self,
                ])
                let config = ModelConfiguration(schema: schema, url: url, allowsSave: false)
                let container = try ModelContainer(for: schema, configurations: [config])
                let ctx = ModelContext(container)
                let ms = { (d: Date) -> Double in (d.timeIntervalSince1970 * 1000).rounded() }

                let bodies = try ctx.fetch(FetchDescriptor<BodyMeasurement>()).map { b -> [String: Any] in
                    var o: [String: Any] = ["date": ms(b.date), "memo": b.memo, "fromHealth": b.externalID != nil]
                    if let v = b.weight { o["weight"] = v }
                    if let v = b.bodyFatPercentage { o["bodyFat"] = v }
                    if let v = b.muscleMass { o["muscle"] = v }
                    return o
                }
                let conditions = try ctx.fetch(FetchDescriptor<ConditionRecord>()).map { c -> [String: Any] in
                    var o: [String: Any] = ["date": ms(c.date), "memo": c.memo, "fromHealth": c.externalID != nil]
                    if let v = c.sleepHours { o["sleep"] = v }
                    if let v = c.fatigue { o["fatigue"] = v }
                    if let v = c.condition { o["condition"] = v }
                    return o
                }
                let abilities = try ctx.fetch(FetchDescriptor<PhysicalAbility>()).map { a -> [String: Any] in
                    ["date": ms(a.date), "type": a.type, "value": a.value, "unit": a.unit, "memo": a.memo]
                }
                let sessions = try ctx.fetch(FetchDescriptor<TrainingSession>()).map { s -> [String: Any] in
                    let exercises = (s.exercises ?? []).map { e -> [String: Any] in
                        var o: [String: Any] = ["name": e.exercise, "order": e.order]
                        if let v = e.weight { o["weight"] = v }
                        if let v = e.reps { o["reps"] = v }
                        if let v = e.sets { o["sets"] = v }
                        o["entries"] = (e.entries ?? []).map { x -> [String: Any] in
                            var p: [String: Any] = ["order": x.order]
                            if let v = x.weight { p["weight"] = v }
                            if let v = x.reps { p["reps"] = v }
                            return p
                        }
                        return o
                    }
                    return ["date": ms(s.date), "sport": s.sport, "memo": s.memo, "gym": s.gymName, "exercises": exercises]
                }
                let gyms = try ctx.fetch(FetchDescriptor<Gym>()).map { g -> [String: Any] in
                    var o: [String: Any] = [
                        "name": g.name, "memo": g.memo, "isDefault": g.isDefault,
                        "barWeights": g.barWeights, "plateWeights": g.plateWeights,
                        "dumbbellMin": g.dumbbellMin, "dumbbellMax": g.dumbbellMax, "dumbbellStep": g.dumbbellStep,
                        "machineUnit": g.machineUnitRaw,
                    ]
                    if let v = g.machineStepWeight { o["machineStepWeight"] = v }
                    return o
                }
                let defaults = UserDefaults.standard
                call.resolve([
                    "found": true,
                    "profile": ["name": defaults.string(forKey: "userName") ?? "", "sport": defaults.string(forKey: "userSport") ?? ""],
                    "bodies": bodies,
                    "conditions": conditions,
                    "abilities": abilities,
                    "sessions": sessions,
                    "gyms": gyms,
                ])
            } catch {
                call.reject("旧版の記録を開けませんでした: \(error.localizedDescription)")
            }
        }
    }
}

extension LegacyImportPlugin {
    /// 写真（結果用紙・画面のスクリーンショット）の文字を読み取る。端末の中だけで行い、画像も文字も外へ送らない（旧版の OCRImporter と同じ設定）。
    /// 受け取り：image（base64。data: で始まる形も可）。返す：lines（読み取った行）
    @objc func recognizeText(_ call: CAPPluginCall) {
        guard var b64 = call.getString("image") else { call.reject("画像がありません"); return }
        if let comma = b64.firstIndex(of: ","), b64.hasPrefix("data:") { b64 = String(b64[b64.index(after: comma)...]) }
        guard let data = Data(base64Encoded: b64, options: .ignoreUnknownCharacters),
              let image = UIImage(data: data), let cg = image.cgImage else {
            call.reject("画像を読み込めませんでした")
            return
        }
        let request = VNRecognizeTextRequest { request, error in
            if let error = error { call.reject("文字を読み取れませんでした: \(error.localizedDescription)"); return }
            let lines = (request.results as? [VNRecognizedTextObservation] ?? []).compactMap { $0.topCandidates(1).first?.string }
            call.resolve(["lines": lines])
        }
        request.recognitionLevel = .accurate
        request.recognitionLanguages = ["ja-JP", "en-US"]
        request.usesLanguageCorrection = false // 数値が補正で崩れるのを防ぐ
        let orientation = CGImagePropertyOrientation(image.imageOrientation)
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                try VNImageRequestHandler(cgImage: cg, orientation: orientation, options: [:]).perform([request])
            } catch {
                call.reject("文字を読み取れませんでした: \(error.localizedDescription)")
            }
        }
    }
}

private extension CGImagePropertyOrientation {
    init(_ o: UIImage.Orientation) {
        switch o {
        case .up: self = .up
        case .down: self = .down
        case .left: self = .left
        case .right: self = .right
        case .upMirrored: self = .upMirrored
        case .downMirrored: self = .downMirrored
        case .leftMirrored: self = .leftMirrored
        case .rightMirrored: self = .rightMirrored
        @unknown default: self = .up
        }
    }
}

/// 自前のプラグイン（LegacyImportPlugin）を登録するための画面。SceneDelegate から使う
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(LegacyImportPlugin())
    }
}
