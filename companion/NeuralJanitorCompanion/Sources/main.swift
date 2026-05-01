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
}

// MARK: - Idle Prediction Engine

struct IdlePrediction {
    let day: Int
    let startHour: Double
    let endHour: Double
    let confidence: Double
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

    func predict() -> [IdlePrediction] {
        maybeTrainIfNeeded()
        lastInferenceAt = Date()
        inferenceCount += 1

        var predictions: [IdlePrediction] = []
        let eventsForPrediction = store.all()
        for day in 0..<7 {
            var samples: [(hour: Double, prob: Double)] = []
            for hour in 0..<24 {
                for minute in stride(from: 0, to: 60, by: 15) {
                    let prob = probability(day: day, hour: hour, minute: minute, events: eventsForPrediction)
                    samples.append((Double(hour) + Double(minute) / 60.0, prob))
                }
            }

            let blocks = findContiguousBlocks(samples, threshold: 0.55)
            if let best = blocks.max(by: { $0.duration < $1.duration }) {
                predictions.append(IdlePrediction(
                    day: day,
                    startHour: best.start,
                    endHour: best.end,
                    confidence: best.avgConfidence
                ))
            } else {
                predictions.append(IdlePrediction(day: day, startHour: 1.0, endHour: 7.0, confidence: 0.25))
            }
        }
        return predictions
    }

    func retrain() throws {
        lastTrainingAttempt = Date()
        let events = store.all().sorted { $0.timestamp < $1.timestamp }
        guard events.count >= 100 else {
            writeLog("Not enough activity samples to train (\(events.count)/100)")
            return
        }

        writeLog("Training Create ML idle predictor from \(events.count) browser activity samples")
        let samples = buildTrainingSamples(from: events)
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
            lastRetrainRuntime: model != nil ? "Core ML Auto" : "CPU Lookup"
        )
        saveMetrics()
        writeLog("Idle predictor trained via Create ML and loaded through Core ML")
    }

    func healthPayload(activityCount: Int) -> [String: Any] {
        refreshMetricsIfNeeded(activityCount: activityCount)

        let runtime: String
        let runtimeLabel: String
        if model != nil {
            runtime = "coreml"
            runtimeLabel = "Core ML Auto"
        } else if !lookup.isEmpty {
            runtime = "lookup"
            runtimeLabel = "CPU Lookup"
        } else {
            runtime = "heuristic"
            runtimeLabel = "CPU Heuristic"
        }

        let usingCoreML = model != nil
        let decision = decisionSnapshot()
        let matureSamples = max(metrics.trainingSamples, activityCount)
        let maturity = min(1.0, Double(matureSamples) / 1_000.0)
        let devices = localDeviceStatus(usingCoreML: usingCoreML)
        let markerStates = hardwareMarkerStates(from: devices)
        let runtimeNote = usingCoreML
            ? "Core ML selects the exact ANE/GPU/CPU target internally; public APIs expose availability and requested compute units, not the per-inference processor."
            : "Core ML model is not loaded yet, so predictions use a local CPU fallback while more browser activity is collected and retraining continues."
        var payload: [String: Any] = [
            "type": "health",
            "protocolVersion": ipcProtocolVersion,
            "appName": appName,
            "engineCodename": engineCodename,
            "ok": true,
            "modelMode": mode,
            "modelLoaded": usingCoreML,
            "runtime": runtime,
            "runtimeLabel": runtimeLabel,
            "computeUnits": usingCoreML ? "all" : "cpu",
            "activityCount": activityCount,
            "trainingSamples": matureSamples,
            "targetTrainingSamples": 1_000,
            "minimumTrainingSamples": 100,
            "modelMaturity": maturity,
            "modelAccuracy": metrics.modelAccuracy ?? NSNull(),
            "readinessReason": readinessReason(activityCount: activityCount),
            "currentIdleConfidence": decision["currentIdleConfidence"] ?? 0.0,
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
        ]

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
        loadModel()
    }

    private func loadModel() {
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
                metrics.lastRetrainRuntime = model != nil ? "Core ML Auto" : (!lookup.isEmpty ? "CPU Lookup" : "not-trained")
            }
            return
        }
        metrics = loaded
        if let retrainedAt = loaded.lastRetrainedAt {
            lastTrainingCompletedAt = Date(timeIntervalSince1970: retrainedAt)
        }
    }

    private func saveMetrics() {
        guard let data = try? JSONEncoder().encode(metrics) else { return }
        try? data.write(to: metricsURL, options: .atomic)
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

    private func maybeTrainIfNeeded() {
        guard model == nil, store.count >= 100 else { return }
        if let last = lastTrainingAttempt, Date().timeIntervalSince(last) < 60 * 60 { return }
        lastTrainingAttempt = Date()
        do {
            try retrain()
        } catch {
            writeLog("Training attempt failed: \(error)")
        }
    }

    private func probability(day: Int, hour: Int, minute: Int, events: [ActivityEvent]) -> Double {
        if let model = model {
            return runInference(model: model, features: predictionFeatures(day: day, hour: hour, minute: minute, events: events))
        }

        if let prob = lookup["\(day)_\(hour)"] {
            return prob
        }

        return (hour >= 1 && hour < 7) ? 0.75 : 0.20
    }

    private func decisionSnapshot() -> [String: Any] {
        let events = store.all()
        let calendar = Calendar.current
        let now = Date()
        let comps = calendar.dateComponents([.weekday, .hour, .minute], from: now)
        let day = (comps.weekday ?? 1) - 1
        let hour = comps.hour ?? 0
        let minute = comps.minute ?? 0
        let current = probability(day: day, hour: hour, minute: minute, events: events)

        var curve: [[String: Any]] = []
        for offset in stride(from: 0, through: 180, by: 30) {
            let date = now.addingTimeInterval(TimeInterval(offset * 60))
            let c = calendar.dateComponents([.weekday, .hour, .minute], from: date)
            let d = (c.weekday ?? 1) - 1
            let h = c.hour ?? 0
            let m = c.minute ?? 0
            curve.append([
                "offsetMinutes": offset,
                "hour": h,
                "minute": m,
                "confidence": probability(day: d, hour: h, minute: m, events: events),
            ])
        }

        return [
            "currentIdleConfidence": current,
            "confidenceCurve": curve,
        ]
    }

    private func recentInferenceActivity() -> String {
        guard let lastInferenceAt else { return "standby" }
        return Date().timeIntervalSince(lastInferenceAt) < 30 ? "breathing" : "standby"
    }

    private func readinessReason(activityCount: Int) -> String {
        if model != nil {
            return "Core ML model loaded"
        }
        if activityCount < 100 {
            return "Collecting \(activityCount)/100 samples before first Core ML training run"
        }
        if !lookup.isEmpty {
            return "CPU lookup active; Core ML model artifact is not loaded yet"
        }
        return "CPU heuristic; awaiting idle/active variety for Core ML"
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
        metrics.lastRetrainRuntime = model != nil ? "Core ML Auto" : (!lookup.isEmpty ? "CPU Lookup" : "CPU Heuristic")
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
                confidence = (sample.hour >= 1 && sample.hour < 7) ? 0.75 : 0.20
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
        let gapThreshold: TimeInterval = 30 * 60
        var current = Date(timeIntervalSince1970: first)
        let end = Date(timeIntervalSince1970: last)
        var samples: [TrainingSample] = []
        let activeEvents = events.filter(\.isActiveState)
        let activeTimestamps = activeEvents.map(\.timestamp)

        while current <= end {
            let ts = current.timeIntervalSince1970
            let components = calendar.dateComponents([.weekday, .hour, .minute], from: current)
            let day = (components.weekday ?? 1) - 1
            let hour = components.hour ?? 0
            let minute = components.minute ?? 0
            let nearestActiveGap = nearestGap(to: ts, in: activeTimestamps)
            let lastEvent = eventBefore(ts, in: events)
            let label: String
            if lastEvent?.isIdleState == true {
                label = "idle"
            } else {
                label = nearestActiveGap > gapThreshold ? "idle" : "active"
            }
            let recentActiveEvents = activeEvents.filter { $0.timestamp >= ts - 24 * 60 * 60 && $0.timestamp <= ts }
            let activeDays = Set(activeEvents
                .filter { $0.timestamp >= ts - 7 * 24 * 60 * 60 && $0.timestamp <= ts }
                .map { calendar.ordinality(of: .day, in: .era, for: Date(timeIntervalSince1970: $0.timestamp)) ?? 0 })
            let lastActive = eventBefore(ts, in: activeEvents)?.timestamp
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
            "mufg", "smbc", "mizuhobank", "rakuten-sec", "sbisec", "monex", "jpx", "alipay", "tenpay", "eastmoney", "xueqiu", "futunn", "tigerbrokers",
            "銀行", "証券", "投資", "株価", "資産", "口座", "決済", "银行", "证券", "投资", "股票", "基金", "理财", "支付", "账单",
        ],
        "ai": [
            "chatgpt", "openai", "claude", "anthropic", "gemini", "deepseek", "hugging face", "huggingface", "perplexity", "copilot", "mistral", "qwen", "kimi", "doubao", "chatglm", "grok", "phind", "openrouter", "lmarena", "replicate", "cursor", "windsurf", "prompt", "assistant", "llm", "large language model", "model card", "transformers", "inference", "ai studio", "model playground",
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
            "weibo", "xiaohongshu", "zhihu", "douban", "tieba", "5ch", "2ch", "mixi",
            "フォロー", "プロフィール", "投稿", "コメント", "コミュニティ", "关注", "粉丝", "主页", "帖子", "评论", "社区", "动态",
        ],
        "news": [
            "breaking news", "latest news", "analysis", "opinion", "reporting", "world news", "market news", "reuters", "apnews",
            "nhk", "asahi", "yomiuri", "mainichi", "sankei", "nikkei", "news.yahoo.co.jp", "itmedia", "gigazine", "toyokeizai", "diamond.jp", "news.livedoor", "36kr", "thepaper", "caixin", "jiemian", "toutiao", "ifeng", "ithome", "guancha", "people.com.cn", "xinhuanet",
            "ニュース", "速報", "報道", "記事", "社会", "政治", "経済", "新闻", "快讯", "报道", "时政", "财经", "热点", "专栏",
        ],
        "shopping": [
            "cart", "checkout", "order", "shipping", "product", "sale", "coupon", "wishlist", "price",
            "taobao", "tmall", "jd.com", "pinduoduo", "rakuten.co.jp", "mercari", "yodobashi", "zozo", "kakaku",
            "カート", "購入", "注文", "配送", "商品", "セール", "価格", "购物车", "购买", "订单", "优惠券", "价格",
        ],
        "entertainment": [
            "watch", "stream", "episode", "movie", "music", "playlist", "gameplay", "trailer", "video",
            "bilibili", "nicovideo", "niconico", "abema", "tver", "pixiv", "douyin", "kuaishou", "youku", "iqiyi", "acfun", "music.163",
            "動画", "映画", "音楽", "配信", "アニメ", "漫画", "ゲーム", "视频", "电影", "音乐", "直播", "动漫", "游戏", "播放",
        ],
        "reference": [
            "documentation", "tutorial", "reference", "manual", "guide", "course", "lesson", "api", "wiki", "stackoverflow",
            "baike", "wikipedia", "csdn", "cnblogs", "juejin", "segmentfault", "oschina", "teratail", "note.com", "hatena", "kotobank", "weblio", "developer.aliyun", "cloud.tencent", "infoq.cn", "sspai",
            "百科", "辞書", "解説", "使い方", "講座", "学習", "词条", "教程", "指南", "文档", "学习", "课程", "知识库",
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

let store = ActivityStore()
let predictor = IdlePredictor(store: store)
let pageClassifier = LocalPageClassifier()

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
        let predictions = predictor.predict()
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
            "health": predictor.healthPayload(activityCount: store.count),
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
        var payload = predictor.healthPayload(activityCount: store.count)
        payload["version"] = "1.0.0"
        writeMessage(payload)

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
