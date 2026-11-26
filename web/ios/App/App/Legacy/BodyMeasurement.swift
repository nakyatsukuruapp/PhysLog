// 旧版（SwiftUI 版 PhysLog）の記録の形。旧版の記録を引き継ぐためだけに置く（main の PhysLog/Models/BodyMeasurement.swift と同じ内容）。
// 中身を変えると、旧版の記録を開けなくなるので、変えないこと。
import Foundation
import SwiftData

@Model
final class BodyMeasurement {
    var date: Date = Date()
    var weight: Double?             // kg
    var bodyFatPercentage: Double?  // %
    var muscleMass: Double?         // kg
    var memo: String = ""
    /// ヘルスケアから取り込んだサンプルのUUID。重複取り込みの判定に使う。
    /// 手入力の記録では nil のまま。
    var externalID: String?

    init(
        date: Date = Date(),
        weight: Double? = nil,
        bodyFatPercentage: Double? = nil,
        muscleMass: Double? = nil,
        memo: String = "",
        externalID: String? = nil
    ) {
        self.date = date
        self.weight = weight
        self.bodyFatPercentage = bodyFatPercentage
        self.muscleMass = muscleMass
        self.memo = memo
        self.externalID = externalID
    }

    /// ヘルスケア由来かどうか
    var isFromHealthKit: Bool { externalID != nil }

    /// 除脂肪体重（LBM）。体重と体脂肪率が揃っている場合のみ算出。
    var leanBodyMass: Double? {
        guard let w = weight, let f = bodyFatPercentage else { return nil }
        return w * (1 - f / 100)
    }
}
