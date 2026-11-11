import UIKit

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?

    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        let w = UIWindow(frame: UIScreen.main.bounds)
        w.rootViewController = CameraViewController()
        w.makeKeyAndVisible()
        window = w
        application.isIdleTimerDisabled = true      // không tắt màn hình khi đang quay
        return true
    }
}
