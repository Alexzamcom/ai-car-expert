import UIKit
import Capacitor
import CoreMotion
import CoreLocation
import CryptoKit
import AVFoundation

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Override point for customization after application launch.
        return true
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later.
        // If your application supports background execution, this method is called instead of applicationWillTerminate: when the user quits.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Restart any tasks that were paused (or not yet started) while the application was inactive. If the application was previously in the background, optionally refresh the user interface.
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        // Called when the app was launched with a url. Feel free to add additional processing here,
        // but if you want the App API to support tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        // Called when the app was launched with an activity, including Universal Links.
        // Feel free to add additional processing here, but if you want the App API to support
        // tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }

}

class TripBridgeViewController: CAPBridgeViewController {
    override var prefersStatusBarHidden: Bool { true }
    override var prefersHomeIndicatorAutoHidden: Bool { true }
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(TripSensors())
        bridge?.registerPluginInstance(NativePosition())
        bridge?.registerPluginInstance(OfflineFiles())
        bridge?.registerPluginInstance(NativeSpeech())
        webView?.scrollView.contentInsetAdjustmentBehavior = .never
#if DEBUG && targetEnvironment(simulator)
        if let stage = ProcessInfo.processInfo.environment["ACE_IOS_SMOKE"] {
            probeSmoke(stage: stage, remaining: 300)
        }
#endif
    }
#if DEBUG && targetEnvironment(simulator)
    private func probeSmoke(stage: String, remaining: Int) {
        guard remaining > 0 else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in
            guard let self = self else { return }
            self.webView?.evaluateJavaScript(
                "window.__aceIOSRun && window.__aceIOSRun('\(stage == "install" ? "install" : "restore")'); window.__aceIOSResult || ''"
            ) { value, _ in
                if let json = value as? String, !json.isEmpty {
                    if let directory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first {
                        try? json.write(to: directory.appendingPathComponent("ace-ios-smoke.json"), atomically: true, encoding: .utf8)
                    }
                } else { self.probeSmoke(stage: stage, remaining: remaining - 1) }
            }
        }
    }
#endif
}

@objc(TripSensors)
class TripSensors: CAPPlugin, CAPBridgedPlugin, CLLocationManagerDelegate {
    let identifier = "TripSensors"
    let jsName = "TripSensors"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startGps", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopGps", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setHudAwake", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "exportTrip", returnType: CAPPluginReturnPromise)
    ]

    private let motion = CMMotionManager()
    private var location: CLLocationManager?
    private var gpsEnabled = false
    private var idleTimerWasDisabled: Bool?
    private var active = false
    private var hudAwake = false
    private var observer: NSObjectProtocol?

    override func load() {
        observer = NotificationCenter.default.addObserver(
            forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main
        ) { [weak self] _ in
            self?.hudAwake = false
            self?.deactivate()
        }
    }

    deinit {
        if let observer = observer { NotificationCenter.default.removeObserver(observer) }
    }

    @objc func start(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.deactivate()
            guard self.motion.isDeviceMotionAvailable || call.getBool("allowGpsOnly") == true else {
                call.reject("Датчики движения недоступны")
                return
            }
            self.gpsEnabled = call.getBool("gps") ?? false
            self.active = true
            self.updateIdleTimer()
            guard self.motion.isDeviceMotionAvailable else { call.resolve(); return }
            self.motion.deviceMotionUpdateInterval = 0.05
            self.motion.startDeviceMotionUpdates(using: .xArbitraryZVertical, to: .main) { [weak self] sample, error in
                guard let self = self else { return }
                if let error = error {
                    self.notifyListeners("failure", data: ["message": error.localizedDescription])
                }
                guard let sample = sample else { return }
                let r = sample.attitude.rotationMatrix
                let a = sample.userAcceleration
                let gyro = sample.rotationRate
                self.notifyListeners("motion", data: [
                    "at": Date().timeIntervalSince1970 * 1000,
                    "x": 9.80665 * (r.m11 * a.x + r.m21 * a.y + r.m31 * a.z),
                    "y": 9.80665 * (r.m12 * a.x + r.m22 * a.y + r.m32 * a.z),
                    "yawRate": -(r.m13 * gyro.x + r.m23 * gyro.y + r.m33 * gyro.z) * 180 / Double.pi,
                    "orientation": [r.m11, r.m21, r.m31, r.m12, r.m22, r.m32, r.m13, r.m23, r.m33]
                ])
            }
            call.resolve()
        }
    }

    @objc func startGps(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard self.active else {
                call.reject("GPS выключен")
                return
            }
            self.gpsEnabled = true
            let location = self.location ?? CLLocationManager()
            self.location = location
            location.delegate = self
            location.desiredAccuracy = kCLLocationAccuracyBest
            location.activityType = .automotiveNavigation
            if location.authorizationStatus == .notDetermined { location.requestWhenInUseAuthorization() }
            self.locationManagerDidChangeAuthorization(location)
            call.resolve()
        }
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        if gpsEnabled && (manager.authorizationStatus == .authorizedWhenInUse || manager.authorizationStatus == .authorizedAlways) {
            manager.startUpdatingLocation()
        }
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard gpsEnabled else { return }
        for fix in locations {
            var data: [String: Any] = [
                "at": fix.timestamp.timeIntervalSince1970 * 1000, "lat": fix.coordinate.latitude,
                "lon": fix.coordinate.longitude, "accuracy": fix.horizontalAccuracy
            ]
            if fix.speed >= 0 { data["speed"] = fix.speed }
            if fix.speedAccuracy >= 0 { data["speedAccuracy"] = fix.speedAccuracy }
            if fix.verticalAccuracy >= 0 { data["verticalAccuracy"] = fix.verticalAccuracy }
            if fix.course >= 0 { data["course"] = fix.course }
            if fix.courseAccuracy >= 0 { data["courseAccuracy"] = fix.courseAccuracy }
            notifyListeners("gps", data: data)
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.deactivate()
            call.resolve()
        }
    }

    @objc func stopGps(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.gpsEnabled = false
            self.location?.stopUpdatingLocation()
            call.resolve()
        }
    }

    @objc func setHudAwake(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.hudAwake = call.getBool("enabled") ?? false
            self.updateIdleTimer()
            call.resolve()
        }
    }

    private func updateIdleTimer() {
        if active || hudAwake {
            if idleTimerWasDisabled == nil { idleTimerWasDisabled = UIApplication.shared.isIdleTimerDisabled }
            UIApplication.shared.isIdleTimerDisabled = true
        } else if let previous = idleTimerWasDisabled {
            UIApplication.shared.isIdleTimerDisabled = previous
            idleTimerWasDisabled = nil
        }
    }

    private func deactivate() {
        motion.stopDeviceMotionUpdates()
        location?.stopUpdatingLocation()
        gpsEnabled = false
        active = false
        updateIdleTimer()
    }

    @objc func exportTrip(_ call: CAPPluginCall) {
        guard let data = call.getString("data") else {
            call.reject("Нет записи для экспорта")
            return
        }
        DispatchQueue.main.async {
            let file = FileManager.default.temporaryDirectory.appendingPathComponent("ai-car-trip-\(UUID().uuidString).json")
            do {
                try data.write(to: file, atomically: true, encoding: .utf8)
                guard let controller = self.bridge?.viewController else {
                    try? FileManager.default.removeItem(at: file)
                    call.reject("Нет окна для экспорта")
                    return
                }
                let share = UIActivityViewController(activityItems: [file], applicationActivities: nil)
                share.popoverPresentationController?.sourceView = controller.view
                share.popoverPresentationController?.sourceRect = CGRect(x: controller.view.bounds.midX, y: controller.view.bounds.midY, width: 1, height: 1)
                share.completionWithItemsHandler = { _, _, _, _ in try? FileManager.default.removeItem(at: file) }
                controller.present(share, animated: true)
                call.resolve()
            } catch {
                call.reject("Не удалось подготовить экспорт", nil, error)
            }
        }
    }
}

@objc(NativePosition)
final class NativePosition: CAPPlugin, CAPBridgedPlugin, CLLocationManagerDelegate {
    let identifier = "NativePosition"
    let jsName = "NativePosition"
    let pluginMethods = ["start", "stop", "refresh", "diagnostics", "acknowledge", "copyDiagnostics"].map {
        CAPPluginMethod(name: $0, returnType: CAPPluginReturnPromise)
    }
    private lazy var location: CLLocationManager = {
        let manager = CLLocationManager()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyBest
        manager.activityType = .automotiveNavigation
        return manager
    }()
    private let motion = CMMotionManager()
    private var running = false
    private var awaitingPermission: CAPPluginCall?
    private var sequence = 0

    private var status: [String: Any] {
        let allowed = [.authorizedAlways, .authorizedWhenInUse].contains(location.authorizationStatus)
        let precise = allowed && location.accuracyAuthorization == .fullAccuracy
        return ["fine": precise, "coarse": allowed, "gpsEnabled": precise, "networkEnabled": allowed,
                "fusedStatus": allowed ? "core-location" : "permission", "playServices": -1, "sent": sequence]
    }

    @objc func start(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.running = true
            if self.location.authorizationStatus == .notDetermined && call.getBool("ask") == true {
                self.awaitingPermission = call
                self.location.requestWhenInUseAuthorization()
            } else { self.begin(call) }
        }
    }

    private func begin(_ call: CAPPluginCall?) {
        guard running else { call?.reject("Запрос остановлен"); return }
        switch location.authorizationStatus {
        case .restricted, .denied:
            call?.reject("Разрешите геолокацию в настройках iOS", "DENIED")
        case .authorizedAlways, .authorizedWhenInUse:
            location.startUpdatingLocation()
            if motion.isDeviceMotionAvailable && !motion.isDeviceMotionActive {
                motion.deviceMotionUpdateInterval = 0.1
                motion.startDeviceMotionUpdates(using: .xArbitraryZVertical, to: .main) { [weak self] sample, _ in
                    guard let self = self, self.running, let sample = sample else { return }
                    let r = sample.attitude.rotationMatrix, gyro = sample.rotationRate, a = sample.userAcceleration
                    self.notifyListeners("motion", data: ["at": Date().timeIntervalSince1970 * 1000,
                        "yawRate": -(r.m13 * gyro.x + r.m23 * gyro.y + r.m33 * gyro.z) * 180 / Double.pi,
                        "east": 9.80665 * (r.m11 * a.x + r.m21 * a.y + r.m31 * a.z),
                        "north": 9.80665 * (r.m12 * a.x + r.m22 * a.y + r.m32 * a.z)])
                }
            }
            call?.resolve(status)
        default: call?.resolve(status)
        }
        notifyListeners("locationStatus", data: status)
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        guard manager.authorizationStatus != .notDetermined, running else { return }
        let call = awaitingPermission
        awaitingPermission = nil
        begin(call)
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard running else { return }
        for fix in locations where fix.horizontalAccuracy >= 0 {
            sequence += 1
            let reduced = manager.accuracyAuthorization == .reducedAccuracy
            var result: [String: Any] = [
                "at": fix.timestamp.timeIntervalSince1970 * 1000, "lat": fix.coordinate.latitude,
                "lon": fix.coordinate.longitude, "accuracy": fix.horizontalAccuracy,
                "source": reduced ? "network" : "fused", "provisional": reduced, "sequence": sequence
            ]
            if fix.speed >= 0 { result["speed"] = fix.speed }
            if fix.speedAccuracy >= 0 { result["speedAccuracy"] = fix.speedAccuracy }
            if fix.course >= 0 { result["heading"] = fix.course }
            notifyListeners("position", data: result)
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.running = false
            self.awaitingPermission?.reject("Запрос остановлен")
            self.awaitingPermission = nil
            self.location.stopUpdatingLocation()
            self.motion.stopDeviceMotionUpdates()
            call.resolve()
        }
    }

    @objc func refresh(_ call: CAPPluginCall) { DispatchQueue.main.async { self.begin(call) } }
    @objc func diagnostics(_ call: CAPPluginCall) { DispatchQueue.main.async { call.resolve(self.status) } }
    @objc func acknowledge(_ call: CAPPluginCall) { call.resolve() }
    @objc func copyDiagnostics(_ call: CAPPluginCall) {
        guard let json = call.getString("json") else { call.reject("Нет отчёта"); return }
        DispatchQueue.main.async { UIPasteboard.general.string = json; call.resolve() }
    }
}

@objc(OfflineFiles)
final class OfflineFiles: CAPPlugin, CAPBridgedPlugin {
    let identifier = "OfflineFiles"
    let jsName = "OfflineFiles"
    let pluginMethods = ["capacity", "regions", "publish", "remove", "erase", "writeBatch", "read", "digest", "checkpoint"].map {
        CAPPluginMethod(name: $0, returnType: CAPPluginReturnPromise)
    }
    private let queue = DispatchQueue(label: "com.aicarexpert.offline-files", qos: .utility)
    private let manager = FileManager.default
    private var dataRoot: URL?

    private func root() throws -> URL {
        if let root = dataRoot { return root }
        let base = try manager.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        var root = base.appendingPathComponent("OfflineMaps", isDirectory: true)
        try manager.createDirectory(at: root, withIntermediateDirectories: true)
        var attributes = URLResourceValues()
        attributes.isExcludedFromBackup = true
        try root.setResourceValues(attributes)
        dataRoot = root
        return root
    }

    private func directory(_ id: String, root: URL) throws -> URL {
        guard id.range(of: "^[pr][a-z0-9]{1,64}$", options: .regularExpression) != nil else { throw CocoaError(.fileReadInvalidFileName) }
        return root.appendingPathComponent(id, isDirectory: true)
    }

    private func resource(_ id: String, _ path: String, root: URL) throws -> URL {
        guard path.utf8.count <= 256 else { throw CocoaError(.fileReadInvalidFileName) }
        let parts = path.components(separatedBy: "/")
        guard parts.allSatisfy({ $0 != "." && $0 != ".." && $0.range(of: "^[A-Za-z0-9_.-]+$", options: .regularExpression) != nil })
        else { throw CocoaError(.fileReadInvalidFileName) }
        return try parts.reduce(directory(id, root: root)) { $0.appendingPathComponent($1) }
    }

    private func catalogue(_ root: URL) throws -> [[String: Any]] {
        let path = root.appendingPathComponent("regions.json")
        guard manager.fileExists(atPath: path.path) else { return [] }
        guard let result = try JSONSerialization.jsonObject(with: Data(contentsOf: path)) as? [[String: Any]]
        else { throw CocoaError(.fileReadCorruptFile) }
        return result
    }

    private func work(_ call: CAPPluginCall, _ action: @escaping (URL) throws -> [String: Any]) {
        queue.async {
            do { call.resolve(try action(self.root())) }
            catch { call.reject("Локальное хранилище карт недоступно", nil, error) }
        }
    }

    @objc func capacity(_ call: CAPPluginCall) {
        work(call) { root in
            let bytes = try root.resourceValues(forKeys: [.volumeAvailableCapacityKey]).volumeAvailableCapacity ?? 0
            return ["availableBytes": bytes]
        }
    }

    @objc func regions(_ call: CAPPluginCall) { work(call) { root in ["entries": try self.catalogue(root)] } }

    @objc func publish(_ call: CAPPluginCall) {
        work(call) { root in
            guard let region = call.getObject("region"), let id = region["id"] as? String,
                  let name = region["name"] as? String,
                  self.manager.fileExists(atPath: try self.directory(id, root: root).path)
            else { throw CocoaError(.fileReadCorruptFile) }
            let previous = call.getString("previous")
            let updated = try self.catalogue(root).filter { ($0["id"] as? String) != previous && ($0["name"] as? String) != name } + [region]
            try JSONSerialization.data(withJSONObject: updated).write(to: root.appendingPathComponent("regions.json"), options: .atomic)
            return [:]
        }
    }

    @objc func remove(_ call: CAPPluginCall) {
        work(call) { root in
            guard let id = call.getString("id") else { throw CocoaError(.fileReadInvalidFileName) }
            let updated = try self.catalogue(root).filter { ($0["id"] as? String) != id }
            try JSONSerialization.data(withJSONObject: updated).write(to: root.appendingPathComponent("regions.json"), options: .atomic)
            return [:]
        }
    }

    @objc func erase(_ call: CAPPluginCall) {
        work(call) { root in
            guard let id = call.getString("id"), try !self.catalogue(root).contains(where: { ($0["id"] as? String) == id })
            else { throw CocoaError(.fileWriteNoPermission) }
            let path = try self.directory(id, root: root)
            if self.manager.fileExists(atPath: path.path) { try self.manager.removeItem(at: path) }
            return [:]
        }
    }

    @objc func writeBatch(_ call: CAPPluginCall) {
        work(call) { root in
            guard let id = call.getString("id"), let entries = call.getArray("entries", JSObject.self),
                  entries.count <= 16 else { throw CocoaError(.fileReadCorruptFile) }
            for entry in entries {
                guard let relative = entry["path"] as? String, let encoded = entry["data"] as? String,
                      let data = Data(base64Encoded: encoded) else { throw CocoaError(.fileReadCorruptFile) }
                let path = try self.resource(id, relative, root: root)
                try self.manager.createDirectory(at: path.deletingLastPathComponent(), withIntermediateDirectories: true)
                try data.write(to: path, options: .atomic)
            }
            return [:]
        }
    }

    @objc func read(_ call: CAPPluginCall) {
        work(call) { root in
            guard let id = call.getString("id"), let relative = call.getString("path") else { throw CocoaError(.fileReadInvalidFileName) }
            let path = try self.resource(id, relative, root: root)
            guard self.manager.fileExists(atPath: path.path) else { return [:] }
            return ["data": try Data(contentsOf: path).base64EncodedString()]
        }
    }

    @objc func checkpoint(_ call: CAPPluginCall) {
        work(call) { root in
            guard let key = call.getString("key") else { throw CocoaError(.fileReadInvalidFileName) }
            let name = SHA256.hash(data: Data(key.utf8)).map { String(format: "%02x", $0) }.joined()
            let file = root.appendingPathComponent("checkpoint-" + name + ".json")
            if call.getBool("remove") == true {
                if self.manager.fileExists(atPath: file.path) { try self.manager.removeItem(at: file) }
                return [:]
            }
            if let entry = call.getObject("entry") {
                try JSONSerialization.data(withJSONObject: entry).write(to: file, options: .atomic)
                return [:]
            }
            guard self.manager.fileExists(atPath: file.path) else { return [:] }
            return ["entry": try JSONSerialization.jsonObject(with: Data(contentsOf: file))]
        }
    }

    @objc func digest(_ call: CAPPluginCall) {
        work(call) { _ in
            guard let encoded = call.getString("data"), let data = Data(base64Encoded: encoded) else { throw CocoaError(.fileReadCorruptFile) }
            return ["hash": SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()]
        }
    }
}

@objc(NativeSpeech)
final class NativeSpeech: CAPPlugin, CAPBridgedPlugin, AVSpeechSynthesizerDelegate {
    let identifier = "NativeSpeech"
    let jsName = "NativeSpeech"
    let pluginMethods = [CAPPluginMethod(name: "say", returnType: CAPPluginReturnPromise)]
    private let synth = AVSpeechSynthesizer()
    private var pending: [ObjectIdentifier: CAPPluginCall] = [:]

    @objc func say(_ call: CAPPluginCall) {
        guard let text = call.getString("text"), let lang = call.getString("lang") else { call.reject("Нет текста"); return }
        DispatchQueue.main.async {
            self.synth.delegate = self
            self.synth.stopSpeaking(at: .immediate)
            let utterance = AVSpeechUtterance(string: text)
            utterance.voice = AVSpeechSynthesisVoice(language: lang)
            self.pending[ObjectIdentifier(utterance)] = call
            self.synth.speak(utterance)
        }
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        pending.removeValue(forKey: ObjectIdentifier(utterance))?.resolve()
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        pending.removeValue(forKey: ObjectIdentifier(utterance))?.resolve()
    }
}
