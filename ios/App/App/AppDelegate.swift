import UIKit
import Capacitor
import CoreMotion
import CoreLocation

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
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(TripSensors())
    }
}

@objc(TripSensors)
class TripSensors: CAPPlugin, CAPBridgedPlugin, CLLocationManagerDelegate {
    let identifier = "TripSensors"
    let jsName = "TripSensors"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startGps", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "exportTrip", returnType: CAPPluginReturnPromise)
    ]

    private let motion = CMMotionManager()
    private var location: CLLocationManager?
    private var gpsEnabled = false
    private var idleTimerWasDisabled: Bool?
    private var observer: NSObjectProtocol?

    override func load() {
        observer = NotificationCenter.default.addObserver(
            forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main
        ) { [weak self] _ in self?.deactivate() }
    }

    deinit {
        if let observer = observer { NotificationCenter.default.removeObserver(observer) }
    }

    @objc func start(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.deactivate()
            guard self.motion.isDeviceMotionAvailable else {
                call.reject("Датчики движения недоступны")
                return
            }
            self.gpsEnabled = call.getBool("gps") ?? false
            self.idleTimerWasDisabled = UIApplication.shared.isIdleTimerDisabled
            UIApplication.shared.isIdleTimerDisabled = true
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
            guard self.gpsEnabled else {
                call.reject("GPS выключен")
                return
            }
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
            notifyListeners("gps", data: data)
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.deactivate()
            call.resolve()
        }
    }

    private func deactivate() {
        motion.stopDeviceMotionUpdates()
        location?.stopUpdatingLocation()
        gpsEnabled = false
        if let previous = idleTimerWasDisabled { UIApplication.shared.isIdleTimerDisabled = previous }
        idleTimerWasDisabled = nil
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
