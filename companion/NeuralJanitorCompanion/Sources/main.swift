/**
 * Neural-Janitor Companion - Native Messaging Host
 * Kernel codename: The Chronos Engine
 *
 * Bridges the Chrome/Edge extension to Apple's local ML stack. The extension
 * sends browser activity timestamps; this process trains a Create ML logistic
 * regression classifier and loads it through Core ML for idle-window inference.
 */

import Foundation
import CoreML
import CreateML
import Metal
import NaturalLanguage

let appName = "Neural-Janitor"
let engineCodename = "The Chronos Engine"
let ipcProtocolVersion = 2

// MARK: - Paths

let appSupportDir: URL = {
    let dir: URL
    let environment = ProcessInfo.processInfo.environment
    if let override = environment["NEURAL_JANITOR_APP_SUPPORT_DIR"] ?? environment["SMART_TAB_HYGIENE_APP_SUPPORT_DIR"] ?? environment["MIMO_APP_SUPPORT_DIR"], !override.isEmpty {
        dir = URL(fileURLWithPath: override, isDirectory: true)
    } else {
        let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        dir = appSupport.appendingPathComponent("Neural-Janitor", isDirectory: true)
        let legacyDirs = [
            appSupport.appendingPathComponent("Smart Tab Hygiene", isDirectory: true),
            appSupport.appendingPathComponent("Mimo", isDirectory: true),
        ]
        if !FileManager.default.fileExists(atPath: dir.path) {
            for legacyDir in legacyDirs where FileManager.default.fileExists(atPath: legacyDir.path) {
                try? FileManager.default.copyItem(at: legacyDir, to: dir)
                break
            }
        }
    }
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
}()

let resetRequestURL = appSupportDir.appendingPathComponent("reset_learning_request.json")

// MARK: - Native Messaging Protocol

func readMessage() -> [String: Any]? {
    let stdin = FileHandle.standardInput
    let lengthBytes = stdin.readData(ofLength: 4)
    guard lengthBytes.count == 4 else { return nil }

    var rawLength: UInt32 = 0
    _ = withUnsafeMutableBytes(of: &rawLength) { lengthBytes.copyBytes(to: $0) }
    let length = UInt32(littleEndian: rawLength)
    guard length > 0, length < 1024 * 1024 else { return nil }

    let data = stdin.readData(ofLength: Int(length))
    guard data.count == Int(length) else { return nil }

    return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
}

func writeMessage(_ dict: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: dict) else { return }
    var length = UInt32(data.count).littleEndian
    let lengthData = Data(bytes: &length, count: 4)

    let stdout = FileHandle.standardOutput
    stdout.write(lengthData)
    stdout.write(data)
}

// MARK: - Logging

func writeLog(_ message: String) {
    let logURL = appSupportDir.appendingPathComponent("companion.log")
    let formatter = DateFormatter()
    formatter.dateFormat = "yyyy-MM-dd HH:mm:ss"
    let line = "[\(formatter.string(from: Date()))] \(message)\n"

    if let handle = try? FileHandle(forWritingTo: logURL) {
        handle.seekToEndOfFile()
        handle.write(line.data(using: .utf8)!)
        handle.closeFile()
    } else {
        try? line.data(using: .utf8)?.write(to: logURL, options: .atomic)
    }
}

// MARK: - Activity Data Store

struct ActivityEvent: Codable {
    let timestamp: Double
    let state: String
    let dwellMs: Double
    let interactions: Int
    let tabCount: Int
    let category: String

    var isIdleState: Bool { state == "idle" || state == "locked" }
    var isActiveState: Bool { state == "active" }
}

final class ActivityStore {
    private let fileURL: URL
    private let lock = NSLock()
    private var events: [ActivityEvent] = []

    init() {
        fileURL = appSupportDir.appendingPathComponent("activity_events.json")
        load()
    }

    func add(_ event: ActivityEvent) {
        guard event.timestamp > 0 else { return }
        lock.lock()
        events.append(event)
        if events.count > 200_000 {
            events = Array(events.suffix(150_000))
        }
        let snapshot = events
        lock.unlock()
        save(snapshot)
    }

    func add(timestamp: Double) {
        guard timestamp > 0 else { return }
        add(ActivityEvent(timestamp: timestamp, state: "active", dwellMs: 0, interactions: 0, tabCount: 0, category: "other"))
    }

    func all() -> [ActivityEvent] {
        lock.lock()
        let snapshot = events
        lock.unlock()
        return snapshot
    }

    var count: Int {
        lock.lock()
        let value = events.count
        lock.unlock()
        return value
    }

    private func load() {
        if let data = try? Data(contentsOf: fileURL),
           let arr = try? JSONDecoder().decode([ActivityEvent].self, from: data) {
            lock.lock()
            events = arr
            lock.unlock()
            return
        }

        let legacyURL = appSupportDir.appendingPathComponent("activity_log.json")
        guard let data = try? Data(contentsOf: legacyURL),
              let timestamps = try? JSONDecoder().decode([Double].self, from: data) else { return }

        let migrated = timestamps.map {
            ActivityEvent(timestamp: $0, state: "active", dwellMs: 0, interactions: 0, tabCount: 0, category: "other")
        }
        lock.lock()
        events = migrated
        lock.unlock()
        save(migrated)
    }

    private func save(_ snapshot: [ActivityEvent]) {
        guard let data = try? JSONEncoder().encode(snapshot) else { return }
        try? data.write(to: fileURL, options: .atomic)
    }

    func reset() {
        lock.lock()
        events = []
        lock.unlock()
        try? FileManager.default.removeItem(at: fileURL)
        let legacyURL = appSupportDir.appendingPathComponent("activity_log.json")
        try? FileManager.default.removeItem(at: legacyURL)
    }
}

// MARK: - Closure Learning Store

private let closureMultiPartSuffixes: Set<String> = [
    "ac.jp", "co.jp", "ed.jp", "go.jp", "gr.jp", "lg.jp", "ne.jp", "or.jp",
    "com.cn", "edu.cn", "gov.cn", "net.cn", "org.cn",
    "com.hk", "edu.hk", "gov.hk", "net.hk", "org.hk",
    "co.uk", "ac.uk", "gov.uk", "org.uk",
    "com.au", "edu.au", "gov.au", "net.au", "org.au",
    "co.kr", "or.kr", "go.kr",
    "co.nz", "com.sg", "com.tw",
]

private let closureBroadServiceRoots: Set<String> = [
    "google.com",
    "bing.com",
    "microsoft.com",
    "yahoo.com",
    "yahoo.co.jp",
    "amazon.com",
    "apple.com",
    "baidu.com",
    "tencent.com",
    "alibaba.com",
    "rakuten.co.jp",
    "dmm.com",
    "github.io",
    "cloudfront.net",
]

private let closureManualTypes: Set<String> = [
    "manual_browser_close",
    "manual_popup_close",
]

private let closureValidTypes: Set<String> = [
    "manual_browser_close",
    "manual_popup_close",
    "auto_cleanup",
]

private let closureMaxSamples = 2000

private func normalizeClosureType(_ raw: String?) -> String {
    guard let raw, closureValidTypes.contains(raw) else { return "manual_browser_close" }
    return raw
}

private func normalizeBrowserType(_ raw: String?) -> String {
    let value = (raw ?? "").lowercased()
    if value == "edge" || value == "chrome" || value == "safari" { return value }
    return "unknown"
}

private func isManualClosureType(_ raw: String) -> Bool {
    closureManualTypes.contains(raw)
}

private func normalizeClosureHostname(_ input: String) -> String {
    guard !input.isEmpty else { return "" }
    if let url = URL(string: input), let host = url.host {
        return host.lowercased().replacingOccurrences(of: "^www\\.", with: "", options: .regularExpression)
    }
    let stripped = input.lowercased()
        .replacingOccurrences(of: "^https?://", with: "", options: .regularExpression)
    let host = stripped.split(separator: "/").first.map(String.init) ?? stripped
    return host.replacingOccurrences(of: "^www\\.", with: "", options: .regularExpression)
}

private func closureRootDomain(for input: String) -> String {
    let hostname = normalizeClosureHostname(input)
    guard !hostname.isEmpty, hostname != "localhost" else { return hostname }
    if hostname.range(of: #"^\d{1,3}(\.\d{1,3}){3}$"#, options: .regularExpression) != nil {
        return hostname
    }

    let parts = hostname.split(separator: ".").map(String.init).filter { !$0.isEmpty }
    guard parts.count > 2 else { return hostname }

    let lastTwo = parts.suffix(2).joined(separator: ".")
    if closureMultiPartSuffixes.contains(lastTwo), parts.count >= 3 {
        return parts.suffix(3).joined(separator: ".")
    }

    return lastTwo
}

private func allowsClosureRootDomainLearning(_ input: String) -> Bool {
    let rootDomain = closureRootDomain(for: input)
    return !rootDomain.isEmpty && !closureBroadServiceRoots.contains(rootDomain)
}

private func closureDouble(_ value: Any?) -> Double? {
    if let doubleValue = value as? Double { return doubleValue }
    if let numberValue = value as? NSNumber { return numberValue.doubleValue }
    if let stringValue = value as? String { return Double(stringValue) }
    return nil
}

private func closureString(_ value: Any?) -> String? {
    if let stringValue = value as? String { return stringValue }
    if let numberValue = value as? NSNumber { return numberValue.stringValue }
    return nil
}

private struct ClosureSample: Codable {
    let sampleId: String
    let type: String
    let category: String
    let rootDomain: String
    let browserType: String
    let url: String
    let closedRecordId: String?
    let dwellMs: Double
    let ageMs: Double
    let backgroundAgeMs: Double?
    let interactions: Int
    let openedAt: Double
    let lastVisited: Double
    let lastBackgroundedAt: Double?
    let closedAt: Double
    let hourOfDay: Int
    let weight: Double

    init(
        sampleId: String,
        type: String,
        category: String,
        rootDomain: String,
        browserType: String,
        url: String,
        closedRecordId: String?,
        dwellMs: Double,
        ageMs: Double,
        backgroundAgeMs: Double?,
        interactions: Int,
        openedAt: Double,
        lastVisited: Double,
        lastBackgroundedAt: Double?,
        closedAt: Double,
        hourOfDay: Int,
        weight: Double
    ) {
        self.sampleId = sampleId
        self.type = type
        self.category = category
        self.rootDomain = rootDomain
        self.browserType = browserType
        self.url = url
        self.closedRecordId = closedRecordId
        self.dwellMs = dwellMs
        self.ageMs = ageMs
        self.backgroundAgeMs = backgroundAgeMs
        self.interactions = interactions
        self.openedAt = openedAt
        self.lastVisited = lastVisited
        self.lastBackgroundedAt = lastBackgroundedAt
        self.closedAt = closedAt
        self.hourOfDay = hourOfDay
        self.weight = weight
    }

    private static func makeSampleID(
        type: String,
        category: String,
        rootDomain: String,
        browserType: String,
        url: String,
        closedRecordId: String?,
        closedAt: Double,
        openedAt: Double,
        lastVisited: Double,
        lastBackgroundedAt: Double?,
        dwellMs: Double,
        ageMs: Double,
        interactions: Int
    ) -> String {
        let bg = lastBackgroundedAt ?? 0
        return [
            type,
            category,
            rootDomain,
            browserType,
            closedRecordId ?? "",
            String(format: "%.0f", closedAt),
            String(format: "%.0f", openedAt),
            String(format: "%.0f", lastVisited),
            String(format: "%.0f", bg),
            String(format: "%.0f", dwellMs),
            String(format: "%.0f", ageMs),
            String(interactions),
            url,
        ].joined(separator: "|")
    }

    init(dictionary: [String: Any], browserTypeDefault: String = "unknown") {
        let type = normalizeClosureType(closureString(dictionary["type"]))
        let url = closureString(dictionary["url"]) ?? ""
        let rootDomain = closureString(dictionary["rootDomain"]) ?? closureRootDomain(for: url)
        let browserType = normalizeBrowserType(closureString(dictionary["browserType"]) ?? browserTypeDefault)
        let closedAt = closureDouble(dictionary["closedAt"]) ?? Date().timeIntervalSince1970 * 1000.0
        let openedAt = closureDouble(dictionary["openedAt"]) ?? closedAt
        let lastVisited = closureDouble(dictionary["lastVisited"]) ?? closedAt
        let lastBackgroundedAt = closureDouble(dictionary["lastBackgroundedAt"])
        let closedRecordId = closureString(dictionary["closedRecordId"])
        let dwellMs = closureDouble(dictionary["dwellMs"]) ?? 0
        let ageMs = closureDouble(dictionary["ageMs"]) ?? 0
        let backgroundAgeMs = closureDouble(dictionary["backgroundAgeMs"])
        let interactions = intFromJSON(dictionary["interactions"]) ?? 0
        let sampleId = closureString(dictionary["sampleId"]) ?? ClosureSample.makeSampleID(
            type: type,
            category: closureString(dictionary["category"]) ?? "other",
            rootDomain: rootDomain,
            browserType: browserType,
            url: url,
            closedRecordId: closedRecordId,
            closedAt: closedAt,
            openedAt: openedAt,
            lastVisited: lastVisited,
            lastBackgroundedAt: lastBackgroundedAt,
            dwellMs: dwellMs,
            ageMs: ageMs,
            interactions: interactions
        )
        let hourOfDay = intFromJSON(dictionary["hourOfDay"]) ?? Calendar.current.component(.hour, from: Date(timeIntervalSince1970: closedAt / 1000.0))
        let weight = closureDouble(dictionary["weight"]) ?? (isManualClosureType(type) ? 1.0 : 0.2)

        self.init(
            sampleId: sampleId,
            type: type,
            category: closureString(dictionary["category"]) ?? "other",
            rootDomain: rootDomain,
            browserType: browserType,
            url: url,
            closedRecordId: closedRecordId,
            dwellMs: dwellMs,
            ageMs: ageMs,
            backgroundAgeMs: backgroundAgeMs,
            interactions: interactions,
            openedAt: openedAt,
            lastVisited: lastVisited,
            lastBackgroundedAt: lastBackgroundedAt,
            closedAt: closedAt,
            hourOfDay: hourOfDay,
            weight: weight
        )
    }
}

private final class ClosureLearningStore {
    private let fileURL: URL
    private let lock = NSLock()
    private var samples: [ClosureSample] = []
    private var sampleIDs: Set<String> = []

    init() {
        fileURL = appSupportDir.appendingPathComponent("closure_samples.json")
        load()
    }

    func add(_ incoming: [ClosureSample]) -> Int {
        guard !incoming.isEmpty else { return 0 }
        var imported = 0
        lock.lock()
        for sample in incoming {
            guard !sampleIDs.contains(sample.sampleId) else { continue }
            samples.append(sample)
            sampleIDs.insert(sample.sampleId)
            imported += 1
        }
        trimIfNeededLocked()
        let snapshot = samples
        lock.unlock()
        if imported > 0 { save(snapshot) }
        return imported
    }

    func all() -> [ClosureSample] {
        lock.lock()
        let snapshot = samples
        lock.unlock()
        return snapshot
    }

    func remove(closedRecordId: String? = nil, url: String? = nil, closedAt: Double? = nil, type: String = "auto_cleanup") -> Int {
        let normalizedType = normalizeClosureType(type)
        let targetRoot = closureRootDomain(for: url ?? "")
        let targetClosedAt = closedAt ?? 0
        var removedCount = 0
        var fallbackRemoved = false

        lock.lock()
        samples = samples.filter { sample in
            guard sample.type == normalizedType else { return true }

            if let closedRecordId, sample.closedRecordId == closedRecordId {
                removedCount += 1
                sampleIDs.remove(sample.sampleId)
                return false
            }

            let legacyTimeMatch = targetClosedAt > 0
                && abs(sample.closedAt - targetClosedAt) <= 2 * 60 * 1000
            let legacyUrlMatch = (url?.isEmpty == false) && sample.url == url
            let legacyRootMatch = !targetRoot.isEmpty && sample.rootDomain == targetRoot
            if !fallbackRemoved && removedCount == 0 && legacyTimeMatch && (legacyUrlMatch || legacyRootMatch) {
                fallbackRemoved = true
                removedCount += 1
                sampleIDs.remove(sample.sampleId)
                return false
            }

            return true
        }
        let snapshot = samples
        lock.unlock()
        if removedCount > 0 { save(snapshot) }
        return removedCount
    }

    func reset() {
        lock.lock()
        samples = []
        sampleIDs = []
        lock.unlock()
        try? FileManager.default.removeItem(at: fileURL)
    }

    private func load() {
        guard let data = try? Data(contentsOf: fileURL),
              let loaded = try? JSONDecoder().decode([ClosureSample].self, from: data) else { return }
        lock.lock()
        samples = loaded
        sampleIDs = Set(loaded.map(\.sampleId))
        trimIfNeededLocked()
        let snapshot = samples
        lock.unlock()
        save(snapshot)
    }

    private func trimIfNeededLocked() {
        guard samples.count > closureMaxSamples else { return }
        let overflow = samples.count - closureMaxSamples
        let removed = samples.prefix(overflow)
        for sample in removed {
            sampleIDs.remove(sample.sampleId)
        }
        samples = Array(samples.suffix(closureMaxSamples))
    }

    private func save(_ snapshot: [ClosureSample]) {
        guard let data = try? JSONEncoder().encode(snapshot) else { return }
        try? data.write(to: fileURL, options: .atomic)
    }
}

private func closureBrowserCounts(from samples: [ClosureSample]) -> [String: Int] {
    var counts: [String: Int] = [:]
    for sample in samples {
        let key = sample.browserType.isEmpty ? "unknown" : sample.browserType
        counts[key, default: 0] += 1
    }
    return counts
}

private func closureSamplesPayload(from samples: [ClosureSample]) -> [[String: Any]] {
    guard let data = try? JSONEncoder().encode(samples),
          let payload = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else {
        return []
    }
    return payload
}

// MARK: - Idle Prediction Engine

struct IdlePrediction {
    let day: Int
    let startHour: Double
    let endHour: Double
    let confidence: Double
}

struct IdleScheduleWindow {
    let sleepHour: Double
    let wakeHour: Double

    func contains(hourValue: Double) -> Bool {
        let h = hourValue.truncatingRemainder(dividingBy: 24.0)
        let normalized = h < 0 ? h + 24.0 : h
        if sleepHour == wakeHour { return false }
        if sleepHour > wakeHour {
            return normalized >= sleepHour || normalized < wakeHour
        }
        return normalized >= sleepHour && normalized < wakeHour
    }
}

struct IdleReferenceSchedule {
    let weekday: IdleScheduleWindow
    let rest: IdleScheduleWindow

    static let defaultValue = IdleReferenceSchedule(
        weekday: IdleScheduleWindow(sleepHour: 1.0, wakeHour: 7.0),
        rest: IdleScheduleWindow(sleepHour: 0.0, wakeHour: 8.5)
    )

    func window(day: Int, holidayLevel: Int) -> IdleScheduleWindow {
        if holidayLevel > 0 || day == 0 || day == 6 { return rest }
        return weekday
    }
}

struct ModelMetrics: Codable {
    var trainingSamples: Int = 0
    var modelAccuracy: Double?
    var lastRetrainedAt: Double?
    var lastRetrainRuntime: String = "not-trained"
}

final class IdlePredictor {
    private let store: ActivityStore
    private let modelURL = appSupportDir.appendingPathComponent("TabIdlePredictor.mlmodel")
    private let lookupURL = appSupportDir.appendingPathComponent("idle_lookup.json")
    private let metricsURL = appSupportDir.appendingPathComponent("model_metrics.json")
    private let minimumActivityEvents = 100
    private let minimumTrainingSamples = 100
    private let retrainInterval: TimeInterval = 6 * 60 * 60
    private let activeOverrideHorizon: TimeInterval = 2 * 60 * 60
    private let maximumIdleWindowHours = 10.0
    private let featureColumns = [
        "dayOfWeek",
        "hour",
        "minute",
        "isWeekend",
        "minutesSinceLastActive",
        "activeEventsLast24h",
        "activeDaysLast7",
        "tabCount",
        "avgDwellMinutes",
    ]

    private var model: MLModel?
    private var lookup: [String: Double] = [:]
    private var lastTrainingAttempt: Date?
    private var lastTrainingCompletedAt: Date?
    private var lastInferenceAt: Date?
    private var lastMetricsRefresh: Date?
    private var inferenceCount: Int = 0
    private var metrics = ModelMetrics()

    init(store: ActivityStore) {
        self.store = store
        loadArtifacts()
    }

    var mode: String {
        if model != nil { return "coreml" }
        if !lookup.isEmpty { return "lookup" }
        return "fallback"
    }

    func predict(
        holidayLevel: Int = 0,
        holidayLevels: [Int: Int] = [:],
        idleSchedule: IdleReferenceSchedule = .defaultValue
    ) -> ([IdlePrediction], Bool) {
        let resetApplied = applyPendingResetIfNeeded()
        maybeTrainIfNeeded()
        lastInferenceAt = Date()
        inferenceCount += 1

        var predictions: [IdlePrediction] = []
        let eventsForPrediction = store.all()
        for day in 0..<7 {
            let dayHolidayLevel = holidayLevels[day] ?? holidayLevel
            let referenceWindow = idleSchedule.window(day: day, holidayLevel: dayHolidayLevel)
            if model == nil && lookup.isEmpty {
                predictions.append(IdlePrediction(
                    day: day,
                    startHour: referenceWindow.sleepHour,
                    endHour: referenceWindow.wakeHour,
                    confidence: dayHolidayLevel >= 2 ? 0.55 : (dayHolidayLevel >= 1 ? 0.40 : 0.30)
                ))
                continue
            }

            var samples: [(hour: Double, prob: Double)] = []
            for hour in 0..<24 {
                for minute in stride(from: 0, to: 60, by: 15) {
                    let prob = probability(
                        day: day,
                        hour: hour,
                        minute: minute,
                        events: eventsForPrediction,
                        holidayLevel: dayHolidayLevel,
                        idleSchedule: idleSchedule
                    )
                    samples.append((Double(hour) + Double(minute) / 60.0, prob))
                }
            }

            let blocks = findContiguousBlocks(samples, threshold: 0.55)
            if let best = blocks.max(by: { $0.duration < $1.duration }),
               best.duration <= maximumIdleWindowHours {
                predictions.append(IdlePrediction(
                    day: day,
                    startHour: best.start,
                    endHour: best.end,
                    confidence: best.avgConfidence
                ))
            } else {
                predictions.append(IdlePrediction(
                    day: day,
                    startHour: referenceWindow.sleepHour,
                    endHour: referenceWindow.wakeHour,
                    confidence: 0.25
                ))
            }
        }
        return (predictions, resetApplied)
    }

    func retrain() throws {
        _ = applyPendingResetIfNeeded()
        lastTrainingAttempt = Date()
        let events = store.all().sorted { $0.timestamp < $1.timestamp }
        guard events.count >= minimumActivityEvents else {
            writeLog("Not enough activity events to train (\(events.count)/\(minimumActivityEvents))")
            return
        }

        writeLog("Training Create ML idle predictor from \(events.count) browser activity samples")
        let samples = buildTrainingSamples(from: events)
        guard samples.count >= minimumTrainingSamples else {
            writeLog("Training skipped because labeled idle samples are too sparse (\(samples.count)/\(minimumTrainingSamples))")
            return
        }
        guard Set(samples.map(\.label)).count >= 2 else {
            writeLog("Training skipped because samples contain only one class")
            return
        }

        try saveLookup(from: samples)
        try trainCoreMLModel(from: samples)
        loadArtifacts()
        lastTrainingCompletedAt = Date()
        metrics = ModelMetrics(
            trainingSamples: samples.count,
            modelAccuracy: evaluateAccuracy(on: samples),
            lastRetrainedAt: lastTrainingCompletedAt?.timeIntervalSince1970,
            lastRetrainRuntime: model != nil ? "Model" : "Learning"
        )
        saveMetrics()
        writeLog("Idle predictor trained via Create ML and loaded through Core ML")
    }

    func healthPayload(
        activityCount: Int,
        holidayLevel: Int = 0,
        idleSchedule: IdleReferenceSchedule = .defaultValue,
        resetRequested: Bool = false
    ) -> [String: Any] {
        let resetApplied = applyPendingResetIfNeeded()
        let effectiveActivityCount = (resetRequested || resetApplied) ? store.count : activityCount
        maybeTrainIfNeeded()
        let shouldRefreshMetrics = lastMetricsRefresh
            .map { Date().timeIntervalSince($0) > 15 * 60 } ?? true
        if shouldRefreshMetrics {
            refreshMetricsIfNeeded(activityCount: effectiveActivityCount)
        }

        let usingCoreML = model != nil
        let decision = decisionSnapshot(holidayLevel: holidayLevel, idleSchedule: idleSchedule)
        let trainingSamples = metrics.trainingSamples
        let maturity = min(1.0, Double(trainingSamples) / 1_000.0)
        let devices = localDeviceStatus(usingCoreML: usingCoreML)
        let markerStates = hardwareMarkerStates(from: devices)
        let modelAccuracyValue: Any
        if model != nil || !lookup.isEmpty, let modelAccuracy = metrics.modelAccuracy {
            modelAccuracyValue = modelAccuracy
        } else {
            modelAccuracyValue = NSNull()
        }
        let runtimeNote = usingCoreML
            ? "Core ML selects the exact ANE/GPU/CPU target internally; public APIs expose availability and requested compute units, not the per-inference processor."
            : "Core ML model is not loaded yet, so predictions use a local fallback while more browser activity is collected and retraining continues."
        let runtimeLabel = usingCoreML ? "Model" : (!lookup.isEmpty ? "Learning" : "Fallback")
        let resetFlag = resetRequested || resetApplied
        var payload: [String: Any] = [
            "type": "health",
            "protocolVersion": ipcProtocolVersion,
            "appName": appName,
            "engineCodename": engineCodename,
            "ok": true,
            "modelMode": mode,
            "modelLoaded": usingCoreML,
            "runtime": (model != nil ? "coreml" : (!lookup.isEmpty ? "lookup" : "heuristic")),
            "runtimeLabel": runtimeLabel,
            "computeUnits": usingCoreML ? "all" : "cpu",
            "activityCount": activityCount,
            "trainingSamples": trainingSamples,
            "targetTrainingSamples": 1_000,
            "minimumTrainingSamples": minimumTrainingSamples,
            "modelMaturity": maturity,
            "modelAccuracy": modelAccuracyValue,
            "readinessReason": readinessReason(activityCount: effectiveActivityCount),
            "currentIdleConfidence": decision["currentIdleConfidence"] ?? 0.0,
            "rawIdlePrior": decision["rawIdlePrior"] ?? decision["currentIdleConfidence"] ?? 0.0,
            "activityOverrideActive": decision["activityOverrideActive"] ?? false,
            "confidenceCurve": decision["confidenceCurve"] ?? [],
            "decisionThreshold": 0.55,
            "powerMode": "low",
            "powerSignal": recentInferenceActivity(),
            "inferenceCount": inferenceCount,
            "devices": devices,
            "telemetryStatus": "online",
            "hardwareTelemetry": [
                "source": "companion",
                "status": "online",
                "computeUnits": usingCoreML ? "all" : "cpu",
                "markerStates": markerStates,
                "devices": devices,
            ],
            "sampledAt": Date().timeIntervalSince1970 * 1000,
            "note": runtimeNote,
            "currentActivityState": currentActivityState(),
            "resetRequested": resetFlag,
        ]

        if let stateAt = currentActivityStateAtMs() {
            payload["currentActivityStateAt"] = stateAt
        }

        if let lastInferenceAt {
            payload["lastInferenceAt"] = lastInferenceAt.timeIntervalSince1970 * 1000
        }
        if let lastTrainingAttempt {
            payload["lastTrainingAttemptAt"] = lastTrainingAttempt.timeIntervalSince1970 * 1000
        }
        if let lastTrainingCompletedAt {
            payload["lastTrainingCompletedAt"] = lastTrainingCompletedAt.timeIntervalSince1970 * 1000
        } else if let metricRetrainedAt = metrics.lastRetrainedAt {
            payload["lastTrainingCompletedAt"] = metricRetrainedAt * 1000
        }
        payload["lastRetrainRuntime"] = metrics.lastRetrainRuntime

        return payload
    }

    private func loadArtifacts() {
        loadLookup()
        loadMetrics()
        if hasUndertrainedArtifacts {
            writeLog("Ignoring undertrained idle artifacts (\(metrics.trainingSamples)/\(minimumTrainingSamples) labeled samples)")
            lookup = [:]
            model = nil
        }
        loadModel()
    }

    private func loadModel() {
        guard !hasUndertrainedArtifacts else {
            model = nil
            return
        }
        guard FileManager.default.fileExists(atPath: modelURL.path) else {
            model = nil
            return
        }

        do {
            let compiledURL = try MLModel.compileModel(at: modelURL)
            let config = MLModelConfiguration()
            config.computeUnits = .all
            model = try MLModel(contentsOf: compiledURL, configuration: config)
            writeLog("Loaded Core ML model with computeUnits=.all")
        } catch {
            model = nil
            writeLog("Failed to load Core ML model: \(error)")
        }
    }

    private func loadLookup() {
        guard let data = try? Data(contentsOf: lookupURL),
              let raw = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            lookup = [:]
            return
        }

        var parsed: [String: Double] = [:]
        for (key, value) in raw {
            if let doubleValue = value as? Double {
                parsed[key] = doubleValue
            } else if let numberValue = value as? NSNumber {
                parsed[key] = numberValue.doubleValue
            }
        }
        lookup = parsed
    }

    private func loadMetrics() {
        guard let data = try? Data(contentsOf: metricsURL),
              let loaded = try? JSONDecoder().decode(ModelMetrics.self, from: data) else {
            metrics = ModelMetrics()
            if let artifactDate = latestArtifactModifiedAt() {
                lastTrainingCompletedAt = artifactDate
                metrics.lastRetrainedAt = artifactDate.timeIntervalSince1970
                metrics.lastRetrainRuntime = model != nil ? "Model" : (!lookup.isEmpty ? "Learning" : "Fallback")
            }
            return
        }
        metrics = loaded
        if let retrainedAt = loaded.lastRetrainedAt {
            lastTrainingCompletedAt = Date(timeIntervalSince1970: retrainedAt)
        }
    }

    private var hasUndertrainedArtifacts: Bool {
        metrics.trainingSamples > 0 && metrics.trainingSamples < minimumTrainingSamples
    }

    private func saveMetrics() {
        guard let data = try? JSONEncoder().encode(metrics) else { return }
        try? data.write(to: metricsURL, options: .atomic)
    }

    private func writeResetRequest() {
        let payload: [String: Any] = [
            "requestedAt": Date().timeIntervalSince1970 * 1000,
            "reason": "manual_reset",
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys]) else { return }
        try? data.write(to: resetRequestURL, options: .atomic)
    }

    private func consumeResetRequest() -> Bool {
        guard FileManager.default.fileExists(atPath: resetRequestURL.path) else { return false }
        try? FileManager.default.removeItem(at: resetRequestURL)
        return true
    }

    func resetLearningArtifacts(writeSentinel: Bool = false) {
        store.reset()
        model = nil
        lookup = [:]
        metrics = ModelMetrics()
        lastTrainingAttempt = nil
        lastTrainingCompletedAt = nil
        lastInferenceAt = nil
        lastMetricsRefresh = nil
        inferenceCount = 0
        let urls = [modelURL, lookupURL, metricsURL]
        for url in urls {
            try? FileManager.default.removeItem(at: url)
        }
        if writeSentinel {
            writeResetRequest()
        }
        writeLog("Reset local learning artifacts")
    }

    @discardableResult
    private func applyPendingResetIfNeeded() -> Bool {
        guard consumeResetRequest() else { return false }
        resetLearningArtifacts(writeSentinel: false)
        return true
    }

    private func latestArtifactModifiedAt() -> Date? {
        let urls = [modelURL, lookupURL]
        let dates = urls.compactMap { url -> Date? in
            guard FileManager.default.fileExists(atPath: url.path),
                  let attrs = try? FileManager.default.attributesOfItem(atPath: url.path) else { return nil }
            return attrs[.modificationDate] as? Date
        }
        return dates.max()
    }

    private func latestActivityEvent() -> ActivityEvent? {
        store.all().last
    }

    private func latestActiveEvent() -> ActivityEvent? {
        store.all().last(where: { $0.isActiveState })
    }

    private func currentActivityState() -> String {
        guard let latest = latestActivityEvent() else { return "unknown" }
        return latest.state
    }

    private func currentActivityStateAtMs() -> Double? {
        guard let latest = latestActivityEvent() else { return nil }
        return latest.timestamp * 1000
    }

    private func maybeTrainIfNeeded() {
        guard store.count >= minimumActivityEvents else { return }
        if let last = lastTrainingAttempt, Date().timeIntervalSince(last) < 60 * 60 { return }
        let hasPredictor = model != nil || !lookup.isEmpty
        let staleModel = lastTrainingCompletedAt
            .map { Date().timeIntervalSince($0) > retrainInterval } ?? true
        let shouldRetrain = !hasPredictor || hasUndertrainedArtifacts || staleModel
        guard shouldRetrain else { return }
        lastTrainingAttempt = Date()
        do {
            try retrain()
        } catch {
            writeLog("Training attempt failed: \(error)")
        }
    }

    private func probability(
        day: Int,
        hour: Int,
        minute: Int,
        events: [ActivityEvent],
        holidayLevel: Int = 0,
        idleSchedule: IdleReferenceSchedule = .defaultValue
    ) -> Double {
        let base: Double
        if let model = model {
            base = runInference(model: model, features: predictionFeatures(day: day, hour: hour, minute: minute, events: events))
            return restAdjustedProbability(
                base,
                day: day,
                hour: hour,
                minute: minute,
                holidayLevel: holidayLevel,
                idleSchedule: idleSchedule
            )
        }
        
        if let prob = lookup["\(day)_\(hour)"] {
            base = prob
            return restAdjustedProbability(
                base,
                day: day,
                hour: hour,
                minute: minute,
                holidayLevel: holidayLevel,
                idleSchedule: idleSchedule
            )
        }
        
        return heuristicProbability(day: day, hour: hour, minute: minute, holidayLevel: holidayLevel, idleSchedule: idleSchedule)
    }

    private func heuristicProbability(
        day: Int = 1,
        hour: Int,
        minute: Int,
        holidayLevel: Int = 0,
        idleSchedule: IdleReferenceSchedule = .defaultValue
    ) -> Double {
        let h = Double(hour) + Double(minute) / 60.0
        let insideReferenceWindow = idleSchedule.window(day: day, holidayLevel: holidayLevel).contains(hourValue: h)
        if holidayLevel >= 2 {
            // Holidays widen the early-morning idle window, but do not add a
            // blanket daytime confidence bump just because a calendar is enabled.
            return insideReferenceWindow ? 0.60 : 0.18
        } else if holidayLevel >= 1 {
            return insideReferenceWindow ? 0.57 : 0.18
        } else {
            return insideReferenceWindow ? 0.56 : 0.18
        }
    }

    private func restAdjustedProbability(
        _ base: Double,
        day: Int,
        hour: Int,
        minute: Int,
        holidayLevel: Int = 0,
        idleSchedule: IdleReferenceSchedule = .defaultValue
    ) -> Double {
        let h = Double(hour) + Double(minute) / 60.0
        let insideReferenceWindow = idleSchedule.window(day: day, holidayLevel: holidayLevel).contains(hourValue: h)
        if holidayLevel >= 2 {
            return clamp(base + (insideReferenceWindow ? 0.08 : -0.02))
        }
        if holidayLevel >= 1 {
            return clamp(base + (insideReferenceWindow ? 0.04 : -0.01))
        }
        return clamp(base + (insideReferenceWindow ? 0.02 : 0.0))
    }

    private func decisionSnapshot(
        holidayLevel: Int = 0,
        idleSchedule: IdleReferenceSchedule = .defaultValue
    ) -> [String: Any] {
        let events = store.all()
        let calendar = Calendar.current
        let now = Date()
        let comps = calendar.dateComponents([.weekday, .hour, .minute], from: now)
        let day = (comps.weekday ?? 1) - 1
        let hour = comps.hour ?? 0
        let minute = comps.minute ?? 0
        let rawCurrent = probability(
            day: day,
            hour: hour,
            minute: minute,
            events: events,
            holidayLevel: holidayLevel,
            idleSchedule: idleSchedule
        )
        let current = applyRecentActivityOverride(rawCurrent, targetDate: now)

        var curve: [[String: Any]] = []
        for offset in stride(from: 0, through: 180, by: 30) {
            let date = now.addingTimeInterval(TimeInterval(offset * 60))
            let c = calendar.dateComponents([.weekday, .hour, .minute], from: date)
            let d = (c.weekday ?? 1) - 1
            let h = c.hour ?? 0
            let m = c.minute ?? 0
            let raw = probability(
                day: d,
                hour: h,
                minute: m,
                events: events,
                holidayLevel: holidayLevel,
                idleSchedule: idleSchedule
            )
            curve.append([
                "offsetMinutes": offset,
                "hour": h,
                "minute": m,
                "confidence": applyRecentActivityOverride(raw, targetDate: date),
                "rawPrior": raw,
            ])
        }

        return [
            "currentIdleConfidence": current,
            "rawIdlePrior": rawCurrent,
            "activityOverrideActive": current < rawCurrent,
            "confidenceCurve": curve,
        ]
    }

    private func applyRecentActivityOverride(_ probability: Double, targetDate: Date) -> Double {
        guard let lastActive = latestActiveEvent()?.timestamp else { return probability }
        let elapsed = targetDate.timeIntervalSince1970 - lastActive
        guard elapsed >= 0, elapsed <= activeOverrideHorizon else { return probability }

        let cap: Double
        if elapsed <= 15 * 60 {
            cap = 0.05
        } else if elapsed <= 60 * 60 {
            cap = 0.25
        } else {
            cap = 0.45
        }
        return min(probability, cap)
    }

    private func recentInferenceActivity() -> String {
        guard let lastInferenceAt else { return "standby" }
        return Date().timeIntervalSince(lastInferenceAt) < 30 ? "breathing" : "standby"
    }

    private func readinessReason(activityCount: Int) -> String {
        if model != nil {
            return "Core ML model loaded"
        }
        if activityCount < minimumActivityEvents {
            return "Collecting \(activityCount)/\(minimumActivityEvents) activity events before first local training run"
        }
        if metrics.trainingSamples > 0 && metrics.trainingSamples < minimumTrainingSamples {
            return "Collecting stronger idle labels (\(metrics.trainingSamples)/\(minimumTrainingSamples)) before trusting Model mode"
        }
        if !lookup.isEmpty {
            return "CPU lookup active; Core ML model artifact is not loaded yet"
        }
        return "Awaiting variety"
    }

    private func refreshMetricsIfNeeded(activityCount: Int) {
        guard activityCount >= 100 else { return }
        if let lastMetricsRefresh, Date().timeIntervalSince(lastMetricsRefresh) < 10 * 60 { return }
        if metrics.trainingSamples > 0, metrics.modelAccuracy != nil { return }

        lastMetricsRefresh = Date()
        let events = store.all().sorted { $0.timestamp < $1.timestamp }
        let samples = buildTrainingSamples(from: events)
        guard !samples.isEmpty else { return }

        metrics.trainingSamples = samples.count
        metrics.modelAccuracy = evaluateAccuracy(on: samples)
        metrics.lastRetrainRuntime = model != nil ? "Model" : (!lookup.isEmpty ? "Learning" : "Fallback")
        if metrics.lastRetrainedAt == nil {
            metrics.lastRetrainedAt = latestArtifactModifiedAt()?.timeIntervalSince1970
            if let retrainedAt = metrics.lastRetrainedAt {
                lastTrainingCompletedAt = Date(timeIntervalSince1970: retrainedAt)
            }
        }
        saveMetrics()
    }

    private func evaluateAccuracy(on samples: [TrainingSample]) -> Double? {
        guard !samples.isEmpty else { return nil }
        let evaluationSamples = Array(samples.suffix(min(samples.count, 2_000)))
        var correct = 0

        for sample in evaluationSamples {
            let confidence: Double
            if let model = model {
                confidence = runInference(model: model, features: sample)
            } else if let prob = lookup["\(sample.dayOfWeek)_\(sample.hour)"] {
                confidence = prob
            } else {
                confidence = heuristicProbability(hour: sample.hour, minute: sample.minute)
            }
            let predicted = confidence >= 0.55 ? "idle" : "active"
            if predicted == sample.label { correct += 1 }
        }

        return Double(correct) / Double(evaluationSamples.count)
    }

    private func runInference(model: MLModel, features: TrainingSample) -> Double {
        do {
            let input = try MLDictionaryFeatureProvider(dictionary: [
                "dayOfWeek": MLFeatureValue(int64: Int64(features.dayOfWeek)),
                "hour": MLFeatureValue(int64: Int64(features.hour)),
                "minute": MLFeatureValue(int64: Int64(features.minute)),
                "isWeekend": MLFeatureValue(int64: Int64(features.isWeekend)),
                "minutesSinceLastActive": MLFeatureValue(double: features.minutesSinceLastActive),
                "activeEventsLast24h": MLFeatureValue(int64: Int64(features.activeEventsLast24h)),
                "activeDaysLast7": MLFeatureValue(int64: Int64(features.activeDaysLast7)),
                "tabCount": MLFeatureValue(int64: Int64(features.tabCount)),
                "avgDwellMinutes": MLFeatureValue(double: features.avgDwellMinutes),
            ])
            let output = try model.prediction(from: input)

            for name in output.featureNames {
                guard let value = output.featureValue(for: name) else { continue }
                if value.type == .dictionary {
                    let dict = value.dictionaryValue
                    for (key, number) in dict where String(describing: key).lowercased() == "idle" {
                        return number.doubleValue
                    }
                }
            }

            if let prob = output.featureValue(for: "idle_probability")?.doubleValue {
                return clamp(prob)
            }
            if let label = output.featureValue(for: "label")?.stringValue {
                return label.lowercased() == "idle" ? 0.80 : 0.20
            }
        } catch {
            writeLog("Core ML inference failed: \(error)")
        }
        return 0.50
    }

    private struct IdleBlock {
        let start: Double
        let end: Double
        let avgConfidence: Double
        var duration: Double { max(0, end - start) }
    }

    private func findContiguousBlocks(_ hours: [(hour: Double, prob: Double)], threshold: Double) -> [IdleBlock] {
        var blocks: [IdleBlock] = []
        var blockStart: Double?
        var blockProbs: [Double] = []

        for entry in hours {
            if entry.prob >= threshold {
                if blockStart == nil { blockStart = entry.hour }
                blockProbs.append(entry.prob)
            } else if let start = blockStart {
                blocks.append(IdleBlock(
                    start: start,
                    end: entry.hour,
                    avgConfidence: blockProbs.reduce(0, +) / Double(blockProbs.count)
                ))
                blockStart = nil
                blockProbs = []
            }
        }

        if let start = blockStart, !blockProbs.isEmpty {
            blocks.append(IdleBlock(
                start: start,
                end: 24.0,
                avgConfidence: blockProbs.reduce(0, +) / Double(blockProbs.count)
            ))
        }

        return blocks
    }

    private struct TrainingSample {
        let dayOfWeek: Int
        let hour: Int
        let minute: Int
        let isWeekend: Int
        let minutesSinceLastActive: Double
        let activeEventsLast24h: Int
        let activeDaysLast7: Int
        let tabCount: Int
        let avgDwellMinutes: Double
        let label: String
    }

    private func buildTrainingSamples(from events: [ActivityEvent]) -> [TrainingSample] {
        guard let first = events.first?.timestamp, let last = events.last?.timestamp else { return [] }

        let calendar = Calendar.current
        var current = Date(timeIntervalSince1970: first)
        let end = Date(timeIntervalSince1970: last)
        var samples: [TrainingSample] = []
        let activeEvents = events.filter(\.isActiveState)

        while current <= end {
            let ts = current.timeIntervalSince1970
            let components = calendar.dateComponents([.weekday, .hour, .minute], from: current)
            let day = (components.weekday ?? 1) - 1
            let hour = components.hour ?? 0
            let minute = components.minute ?? 0
            let lastEvent = eventBefore(ts, in: events)
            let lastActive = eventBefore(ts, in: activeEvents)?.timestamp
            let label: String
            if lastEvent?.isIdleState == true {
                label = "idle"
            } else if let lastActive, ts - lastActive <= activeOverrideHorizon {
                label = "active"
            } else {
                current = current.addingTimeInterval(15 * 60)
                continue
            }
            let recentActiveEvents = activeEvents.filter { $0.timestamp >= ts - 24 * 60 * 60 && $0.timestamp <= ts }
            let activeDays = Set(activeEvents
                .filter { $0.timestamp >= ts - 7 * 24 * 60 * 60 && $0.timestamp <= ts }
                .map { calendar.ordinality(of: .day, in: .era, for: Date(timeIntervalSince1970: $0.timestamp)) ?? 0 })
            let dwellValues = recentActiveEvents.map { $0.dwellMs / 60_000.0 }.filter { $0 > 0 }
            let avgDwell = dwellValues.isEmpty ? 0 : dwellValues.reduce(0, +) / Double(dwellValues.count)
            samples.append(TrainingSample(
                dayOfWeek: day,
                hour: hour,
                minute: minute,
                isWeekend: day == 0 || day == 6 ? 1 : 0,
                minutesSinceLastActive: lastActive.map { min(24 * 60, max(0, (ts - $0) / 60.0)) } ?? 24 * 60,
                activeEventsLast24h: recentActiveEvents.count,
                activeDaysLast7: activeDays.count,
                tabCount: max(0, lastEvent?.tabCount ?? 0),
                avgDwellMinutes: avgDwell,
                label: label
            ))
            current = current.addingTimeInterval(15 * 60)
        }

        return samples
    }

    private func predictionFeatures(day: Int, hour: Int, minute: Int, events: [ActivityEvent]) -> TrainingSample {
        let slotEvents = events.filter { event in
            let comps = Calendar.current.dateComponents([.weekday, .hour], from: Date(timeIntervalSince1970: event.timestamp))
            return ((comps.weekday ?? 1) - 1) == day && (comps.hour ?? 0) == hour
        }
        let activeSlotEvents = slotEvents.filter(\.isActiveState)
        let avgTabCount = slotEvents.isEmpty ? 0 : Int(round(Double(slotEvents.map(\.tabCount).reduce(0, +)) / Double(slotEvents.count)))
        let dwellValues = activeSlotEvents.map { $0.dwellMs / 60_000.0 }.filter { $0 > 0 }
        let avgDwell = dwellValues.isEmpty ? 0 : dwellValues.reduce(0, +) / Double(dwellValues.count)
        let globalActiveDays = Set(events
            .filter(\.isActiveState)
            .suffix(1000)
            .map { Calendar.current.ordinality(of: .day, in: .era, for: Date(timeIntervalSince1970: $0.timestamp)) ?? 0 })

        return TrainingSample(
            dayOfWeek: day,
            hour: hour,
            minute: minute,
            isWeekend: day == 0 || day == 6 ? 1 : 0,
            minutesSinceLastActive: activeSlotEvents.isEmpty ? 6 * 60 : 20,
            activeEventsLast24h: activeSlotEvents.count,
            activeDaysLast7: min(7, globalActiveDays.count),
            tabCount: avgTabCount,
            avgDwellMinutes: avgDwell,
            label: "idle"
        )
    }

    private func eventBefore(_ target: Double, in events: [ActivityEvent]) -> ActivityEvent? {
        guard !events.isEmpty else { return nil }
        var low = 0
        var high = events.count
        while low < high {
            let mid = (low + high) / 2
            if events[mid].timestamp <= target {
                low = mid + 1
            } else {
                high = mid
            }
        }
        return low > 0 ? events[low - 1] : nil
    }

    private func nearestGap(to target: Double, in sorted: [Double]) -> Double {
        var low = 0
        var high = sorted.count
        while low < high {
            let mid = (low + high) / 2
            if sorted[mid] < target {
                low = mid + 1
            } else {
                high = mid
            }
        }

        var best = Double.infinity
        if low < sorted.count {
            best = min(best, abs(sorted[low] - target))
        }
        if low > 0 {
            best = min(best, abs(sorted[low - 1] - target))
        }
        return best
    }

    private func saveLookup(from samples: [TrainingSample]) throws {
        var bins: [String: (idle: Int, total: Int)] = [:]
        for sample in samples {
            let key = "\(sample.dayOfWeek)_\(sample.hour)"
            var stat = bins[key] ?? (idle: 0, total: 0)
            stat.total += 1
            if sample.label == "idle" { stat.idle += 1 }
            bins[key] = stat
        }

        var table: [String: Double] = [:]
        for (key, stat) in bins {
            table[key] = stat.total > 0 ? Double(stat.idle) / Double(stat.total) : 0.5
        }

        let data = try JSONSerialization.data(withJSONObject: table, options: [.prettyPrinted, .sortedKeys])
        try data.write(to: lookupURL, options: .atomic)
    }

    private func trainCoreMLModel(from samples: [TrainingSample]) throws {
        let data = try MLDataTable(namedColumns: [
            "dayOfWeek": MLUntypedColumn(samples.map { $0.dayOfWeek }),
            "hour": MLUntypedColumn(samples.map { $0.hour }),
            "minute": MLUntypedColumn(samples.map { $0.minute }),
            "isWeekend": MLUntypedColumn(samples.map { $0.isWeekend }),
            "minutesSinceLastActive": MLUntypedColumn(samples.map { $0.minutesSinceLastActive }),
            "activeEventsLast24h": MLUntypedColumn(samples.map { $0.activeEventsLast24h }),
            "activeDaysLast7": MLUntypedColumn(samples.map { $0.activeDaysLast7 }),
            "tabCount": MLUntypedColumn(samples.map { $0.tabCount }),
            "avgDwellMinutes": MLUntypedColumn(samples.map { $0.avgDwellMinutes }),
            "label": MLUntypedColumn(samples.map { $0.label }),
        ])
        let params = MLBoostedTreeClassifier.ModelParameters(
            validation: .none,
            maxDepth: 5,
            maxIterations: 60,
            minLossReduction: 0,
            minChildWeight: 0.1,
            randomSeed: 42,
            stepSize: 0.2,
            earlyStoppingRounds: nil,
            rowSubsample: 0.9,
            columnSubsample: 0.9
        )
        let classifier = try MLBoostedTreeClassifier(
            trainingData: data,
            targetColumn: "label",
            featureColumns: featureColumns,
            parameters: params
        )

        let metadata = MLModelMetadata(
            author: NSFullUserName(),
            shortDescription: "The Chronos Engine predicts whether the Mac user is away using browser idle events and tab activity context.",
            license: "Local model, user-owned data",
            version: "1.0"
        )
        try classifier.write(to: modelURL, metadata: metadata)
    }

    private func clamp(_ value: Double) -> Double {
        min(1.0, max(0.0, value))
    }
}

func isAppleSiliconMac() -> Bool {
    #if arch(arm64)
    return true
    #else
    return false
    #endif
}

func hasMetalGPU() -> Bool {
    isAppleSiliconMac() || MTLCreateSystemDefaultDevice() != nil
}

func hardwareMarkerStates(from devices: [[String: Any]]) -> [String: String] {
    var states: [String: String] = [:]
    for device in devices {
        guard let key = device["key"] as? String else { continue }
        states[key] = (device["state"] as? String) ?? "standby"
    }
    return states
}

func localDeviceStatus(usingCoreML: Bool) -> [[String: Any]] {
    let npuAvailable = isAppleSiliconMac()
    let gpuAvailable = hasMetalGPU()

    func state(available: Bool, cpuFallback: Bool = false) -> String {
        guard available else { return "unavailable" }
        if usingCoreML { return "auto" }
        return cpuFallback ? "active" : "standby"
    }

    return [
        [
            "key": "npu",
            "label": "NPU",
            "detail": "Apple Neural Engine",
            "available": npuAvailable,
            "state": state(available: npuAvailable),
        ],
        [
            "key": "gpu",
            "label": "GPU",
            "detail": "Metal GPU",
            "available": gpuAvailable,
            "state": state(available: gpuAvailable),
        ],
        [
            "key": "cpu",
            "label": "CPU",
            "detail": "\(ProcessInfo.processInfo.processorCount) cores",
            "available": true,
            "state": state(available: true, cpuFallback: true),
        ],
    ]
}

// MARK: - On-Device Page Classification

final class LocalPageClassifier {
    private let keywords: [String: [String]] = [
        "nsfw": ["adult", "explicit", "nsfw", "xxx", "erotic", "cam", "fetish", "porn", "hentai"],
        "finance": [
            "bank", "banking", "brokerage", "portfolio", "credit", "mortgage", "invoice", "payment", "transaction", "crypto", "investment", "trading",
            "mufg", "smbc", "mizuhobank", "rakuten-sec", "sbisec", "monex", "jpx", "alipay", "tenpay", "eastmoney", "xueqiu", "futunn", "tigerbrokers", "rakuten-card", "interactivebrokers", "ibkr",
            "金融危機", "円安", "円高", "日銀", "為替", "金利", "インフレ", "景気後退",
            "銀行", "証券", "投資", "株価", "資産", "口座", "決済", "银行", "证券", "投资", "股票", "基金", "理财", "支付", "账单", "财富", "金融危机", "日元贬值", "日元升值", "汇率", "通胀", "央行", "加息", "降息", "债券",
            "invest", "stock", "investor", "dividend", "equity", "portfolio", "financial crisis", "recession", "inflation", "exchange rate", "bond yield",
        ],
        "ai": [
            "chatgpt", "openai", "claude", "anthropic", "gemini", "deepseek", "hugging face", "huggingface", "perplexity", "copilot", "mistral", "qwen", "kimi", "doubao", "chatglm", "grok", "phind", "openrouter", "lmarena", "replicate", "cursor", "windsurf", "prompt", "assistant", "llm", "large language model", "model card", "transformers", "inference", "ai studio", "model playground", "openai.com", "claude.ai", "perplexity.ai",
            "yiyan", "wenxin", "tongyi", "yuanbao", "zhipuai", "bigmodel", "baichuan-ai", "minimax", "coze", "dify",
            "生成ai", "人工知能", "チャット", "プロンプト", "大規模言語モデル", "生成式ai", "人工智能", "提示词", "大语言模型", "智能体",
        ],
        "email": [
            "inbox", "email", "message", "chat", "workspace", "meeting", "conversation", "slack", "gmail", "outlook",
            "mail.qq", "mail.163", "mail.126", "mail.sina", "mail.aliyun", "mail.yahoo.co.jp", "chatwork", "line.me", "worksmobile",
            "受信トレイ", "メール", "メッセージ", "会議", "通知", "收件箱", "邮箱", "邮件", "消息", "会议",
        ],
        "work": [
            "pull request", "issue tracker", "sprint", "project", "workspace", "document", "spreadsheet", "dashboard", "deployment", "repository", "jira", "notion",
            "qiita", "zenn", "cybozu", "backlog", "esa.io", "kintone", "yuque", "teambition", "feishu", "larksuite", "coding.net", "gitee", "tapd", "shimo",
            "プロジェクト", "タスク", "議事録", "資料", "ドキュメント", "開発", "项目", "任务", "文档", "表格", "看板", "部署", "代码仓库",
        ],
        "social": [
            "profile", "followers", "following", "feed", "timeline", "post", "comments", "community", "likes",
            "weibo", "xiaohongshu", "douban", "tieba", "5ch", "2ch", "mixi",
            "フォロー", "プロフィール", "投稿", "コメント", "コミュニティ", "关注", "粉丝", "主页", "帖子", "评论", "社区", "动态",
        ],
        "news": [
            "breaking news", "latest news", "analysis", "opinion", "reporting", "world news", "market news", "reuters", "apnews",
            "nhk", "asahi", "yomiuri", "mainichi", "sankei", "nikkei", "news.yahoo.co.jp", "itmedia", "gigazine", "toyokeizai", "diamond.jp", "news.livedoor", "36kr", "thepaper", "caixin", "jiemian", "toutiao", "ifeng", "ithome", "guancha", "people.com.cn", "xinhuanet",
            "ニュース", "速報", "報道", "記事", "社会", "政治", "経済", "新闻", "快讯", "报道", "时政", "财经", "热点", "专栏",
        ],
        "shopping": [
            "cart", "checkout", "order", "shipping", "product", "sale", "coupon", "wishlist", "price", "microsoft rewards", "bing rewards", "reward points",
            "taobao", "tmall", "jd.com", "pinduoduo", "rakuten.co.jp", "mercari", "yodobashi", "zozo", "kakaku",
            "カート", "購入", "注文", "配送", "商品", "セール", "価格", "ポイント", "购物车", "购买", "订单", "优惠券", "价格", "积分",
        ],
        "entertainment": [
            "watch", "stream", "episode", "movie", "music", "playlist", "gameplay", "trailer", "video", "anime", "manga",
            "bilibili", "nicovideo", "niconico", "abema", "tver", "pixiv", "douyin", "kuaishou", "youku", "iqiyi", "acfun", "music.163", "anilist", "myanimelist", "bangumi", "mikanani", "dmhy", "agefans",
            "動画", "映画", "音楽", "配信", "アニメ", "漫画", "ゲーム", "视频", "电影", "音乐", "直播", "动漫", "游戏", "播放", "番剧",
        ],
        "reference": [
            "documentation", "tutorial", "reference", "manual", "guide", "course", "lesson", "api", "wiki", "stackoverflow",
            "baike", "wikipedia", "csdn", "cnblogs", "juejin", "segmentfault", "oschina", "teratail", "note.com", "hatena", "kotobank", "weblio", "developer.aliyun", "cloud.tencent", "infoq.cn", "sspai", "zhihu", "weread", "duolingo", "duolingguo", "cambridge dictionary", "godic", "eudic", "nowcoder",
            "百科", "辞書", "解説", "使い方", "講座", "学習", "単語", "翻訳", "词条", "教程", "指南", "文档", "学习", "课程", "知识库", "知乎", "微信读书", "德语助手", "词典", "编程题", "面试题", "接口文档",
        ],
    ]

    func classify(url: String, title: String, description: String, text: String) -> [String: Any] {
        let joined = "\(url) \(title) \(description) \(text)"
        let normalized = joined.lowercased()
        let tokens = tokenize(normalized)
        var scores: [String: Double] = [:]

        for (category, words) in keywords {
            var score = 0.0
            for word in words {
                if word.contains(" ") {
                    if normalized.contains(word) { score += 2.0 }
                } else if tokens.contains(word) || normalized.contains(word) {
                    score += url.lowercased().contains(word) ? 1.8 : 1.0
                }
            }
            scores[category] = score
        }

        guard let best = scores.max(by: { $0.value < $1.value }), best.value >= 1.0 else {
            return ["type": "classification", "category": "other", "confidence": 0.0, "source": "companion-nlp"]
        }

        let sortedScores = scores.values.sorted(by: >)
        let second = sortedScores.dropFirst().first ?? 0
        let margin = max(0, best.value - second)
        let confidence = min(0.95, 0.35 + best.value * 0.08 + margin * 0.05)

        return [
            "type": "classification",
            "category": best.key,
            "confidence": confidence,
            "source": "companion-nlp",
        ]
    }

    private func tokenize(_ text: String) -> Set<String> {
        let tokenizer = NLTokenizer(unit: .word)
        tokenizer.string = text
        var result = Set<String>()
        tokenizer.enumerateTokens(in: text.startIndex..<text.endIndex) { range, _ in
            let token = String(text[range]).trimmingCharacters(in: .punctuationCharacters)
            if token.count > 2 { result.insert(token) }
            return true
        }
        return result
    }
}

// MARK: - Main Loop

func normalizeTimestamp(_ raw: Double) -> Double {
    raw > 10_000_000_000 ? raw / 1000.0 : raw
}

func intFromJSON(_ value: Any?) -> Int? {
    if let intValue = value as? Int { return intValue }
    if let numberValue = value as? NSNumber { return numberValue.intValue }
    if let stringValue = value as? String { return Int(stringValue) }
    return nil
}

func hourFromJSONTime(_ value: Any?, fallback: Double) -> Double {
    if let numberValue = value as? NSNumber {
        return max(0.0, min(23.99, numberValue.doubleValue))
    }
    guard let text = value as? String else { return fallback }
    let parts = text.split(separator: ":")
    guard parts.count == 2,
          let hour = Int(parts[0]),
          let minute = Int(parts[1]),
          hour >= 0, hour <= 23,
          minute >= 0, minute <= 59 else { return fallback }
    return Double(hour) + Double(minute) / 60.0
}

func scheduleWindowFromJSON(_ value: Any?, fallback: IdleScheduleWindow) -> IdleScheduleWindow {
    guard let dict = value as? [String: Any] else { return fallback }
    return IdleScheduleWindow(
        sleepHour: hourFromJSONTime(dict["sleep"], fallback: fallback.sleepHour),
        wakeHour: hourFromJSONTime(dict["wake"], fallback: fallback.wakeHour)
    )
}

func idleScheduleFromJSON(_ value: Any?) -> IdleReferenceSchedule {
    guard let dict = value as? [String: Any] else { return .defaultValue }
    return IdleReferenceSchedule(
        weekday: scheduleWindowFromJSON(dict["weekday"], fallback: IdleReferenceSchedule.defaultValue.weekday),
        rest: scheduleWindowFromJSON(dict["rest"], fallback: IdleReferenceSchedule.defaultValue.rest)
    )
}

func holidayLevelMap(from value: Any?) -> [Int: Int] {
    if let dict = value as? [String: Any] {
        var parsed: [Int: Int] = [:]
        for (key, rawValue) in dict {
            guard let day = Int(key), day >= 0, day <= 6, let level = intFromJSON(rawValue) else { continue }
            parsed[day] = max(0, min(2, level))
        }
        return parsed
    }

    if let array = value as? [Any] {
        var parsed: [Int: Int] = [:]
        for (day, rawValue) in array.enumerated() where day < 7 {
            guard let level = intFromJSON(rawValue) else { continue }
            parsed[day] = max(0, min(2, level))
        }
        return parsed
    }

    return [:]
}

let store = ActivityStore()
private let closureStore = ClosureLearningStore()
let predictor = IdlePredictor(store: store)
let pageClassifier = LocalPageClassifier()

if CommandLine.arguments.contains("--reset-learning") {
    predictor.resetLearningArtifacts(writeSentinel: true)
    closureStore.reset()
    print("[Neural-Janitor] Reset local learning artifacts, closure learning, and queued browser-state reset")
    exit(EXIT_SUCCESS)
}

writeLog("\(appName) Companion started; \(engineCodename) online (pid: \(ProcessInfo.processInfo.processIdentifier))")

DispatchQueue.global(qos: .utility).async {
    while true {
        Thread.sleep(forTimeInterval: 24 * 60 * 60)
        do {
            try predictor.retrain()
        } catch {
            writeLog("Scheduled retraining failed: \(error)")
        }
    }
}

while true {
    guard let message = readMessage() else {
        writeLog("stdin closed or invalid message; exiting")
        break
    }

    let type = message["type"] as? String ?? ""
    switch type {
    case "recordClosureSample":
        if let sampleDict = message["sample"] as? [String: Any] {
            let imported = closureStore.add([ClosureSample(dictionary: sampleDict)])
            let samples = closureStore.all()
            writeMessage([
                "type": "recordClosureSampleResult",
                "protocolVersion": ipcProtocolVersion,
                "appName": appName,
                "engineCodename": engineCodename,
                "ok": true,
                "importedCount": imported,
                "totalSamples": samples.count,
                "browserCounts": closureBrowserCounts(from: samples),
            ])
        } else {
            writeMessage([
                "type": "recordClosureSampleResult",
                "protocolVersion": ipcProtocolVersion,
                "appName": appName,
                "engineCodename": engineCodename,
                "ok": false,
                "error": "Missing sample payload",
            ])
        }

    case "recordClosureSamples":
        let rawSamples = message["samples"] as? [[String: Any]] ?? []
        let imported = closureStore.add(rawSamples.map { ClosureSample(dictionary: $0) })
        let samples = closureStore.all()
        writeMessage([
            "type": "recordClosureSamplesResult",
            "protocolVersion": ipcProtocolVersion,
            "appName": appName,
            "engineCodename": engineCodename,
            "ok": true,
            "importedCount": imported,
            "totalSamples": samples.count,
            "browserCounts": closureBrowserCounts(from: samples),
        ])

    case "getClosureLearning", "getClosureSamples", "getGlobalStats":
        let samples = closureStore.all()
        writeMessage([
            "type": "closureLearning",
            "protocolVersion": ipcProtocolVersion,
            "appName": appName,
            "engineCodename": engineCodename,
            "ok": true,
            "samples": closureSamplesPayload(from: samples),
            "totalSamples": samples.count,
            "browserCounts": closureBrowserCounts(from: samples),
        ])

    case "removeClosureSamplesForClosedRecord":
        let closedRecordId = message["closedRecordId"] as? String
        let url = message["url"] as? String
        let closedAt = closureDouble(message["closedAt"])
        let type = (message["recordType"] as? String) ?? "auto_cleanup"
        let removedCount = closureStore.remove(
            closedRecordId: closedRecordId,
            url: url,
            closedAt: closedAt,
            type: type
        )
        let samples = closureStore.all()
        writeMessage([
            "type": "removeClosureSamplesForClosedRecordResult",
            "protocolVersion": ipcProtocolVersion,
            "appName": appName,
            "engineCodename": engineCodename,
            "ok": true,
            "removedCount": removedCount,
            "totalSamples": samples.count,
            "browserCounts": closureBrowserCounts(from: samples),
        ])

    case "resetClosureLearning":
        closureStore.reset()
        writeMessage([
            "type": "resetClosureLearningResult",
            "protocolVersion": ipcProtocolVersion,
            "appName": appName,
            "engineCodename": engineCodename,
            "ok": true,
            "resetApplied": true,
        ])

    case "activity":
        if let timestamp = message["timestamp"] as? Double {
            store.add(ActivityEvent(
                timestamp: normalizeTimestamp(timestamp),
                state: (message["state"] as? String) ?? "active",
                dwellMs: (message["dwellMs"] as? Double) ?? 0,
                interactions: (message["interactions"] as? Int) ?? 0,
                tabCount: (message["tabCount"] as? Int) ?? 0,
                category: (message["category"] as? String) ?? "other"
            ))
        }
        writeMessage([
            "type": "activityAck",
            "protocolVersion": ipcProtocolVersion,
            "appName": appName,
            "engineCodename": engineCodename,
            "ok": true,
        ])

    case "predict":
        let holidayLevel = intFromJSON(message["holidayLevel"]) ?? 0
        let holidayLevels = holidayLevelMap(from: message["holidayLevels"])
        let idleSchedule = idleScheduleFromJSON(message["idleSchedule"])
        let (predictions, resetApplied) = predictor.predict(
            holidayLevel: holidayLevel,
            holidayLevels: holidayLevels,
            idleSchedule: idleSchedule
        )
        var predDict: [String: Any] = [:]
        for pred in predictions {
            predDict["\(pred.day)"] = [
                "startHour": pred.startHour,
                "endHour": pred.endHour,
                "confidence": pred.confidence,
            ]
        }
        writeMessage([
            "type": "idlePredictions",
            "protocolVersion": ipcProtocolVersion,
            "appName": appName,
            "engineCodename": engineCodename,
            "predictions": predDict,
            "modelMode": predictor.mode,
            "activityCount": store.count,
            "health": predictor.healthPayload(
                activityCount: store.count,
                holidayLevel: holidayLevel,
                idleSchedule: idleSchedule,
                resetRequested: resetApplied
            ),
        ])

    case "retrain":
        do {
            try predictor.retrain()
            writeMessage([
                "type": "retrainResult",
                "protocolVersion": ipcProtocolVersion,
                "appName": appName,
                "engineCodename": engineCodename,
                "ok": true,
                "modelMode": predictor.mode,
            ])
        } catch {
            writeMessage([
                "type": "retrainResult",
                "protocolVersion": ipcProtocolVersion,
                "appName": appName,
                "engineCodename": engineCodename,
                "ok": false,
                "error": "\(error)",
            ])
        }

    case "health":
        let holidayLevel = intFromJSON(message["holidayLevel"]) ?? 0
        let idleSchedule = idleScheduleFromJSON(message["idleSchedule"])
        var payload = predictor.healthPayload(
            activityCount: store.count,
            holidayLevel: holidayLevel,
            idleSchedule: idleSchedule
        )
        payload["version"] = "1.0.0"
        writeMessage(payload)

    case "resetLearningState":
        predictor.resetLearningArtifacts(writeSentinel: false)
        closureStore.reset()
        writeMessage([
            "type": "resetLearningStateResult",
            "protocolVersion": ipcProtocolVersion,
            "appName": appName,
            "engineCodename": engineCodename,
            "ok": true,
            "resetRequested": true,
            "modelMode": predictor.mode,
        ])

    case "classifyURL":
        var result = pageClassifier.classify(
            url: (message["url"] as? String) ?? "",
            title: (message["title"] as? String) ?? "",
            description: (message["description"] as? String) ?? "",
            text: (message["text"] as? String) ?? ""
        )
        result["protocolVersion"] = ipcProtocolVersion
        result["appName"] = appName
        result["engineCodename"] = engineCodename
        writeMessage(result)

    default:
        writeMessage([
            "type": "error",
            "protocolVersion": ipcProtocolVersion,
            "appName": appName,
            "engineCodename": engineCodename,
            "message": "Unknown message type: \(type)",
        ])
    }
}
