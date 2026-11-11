import CoreMotion
import QuartzCore
import simd

/// Hướng của máy theo thời gian. Giữ một đoạn lịch sử ngắn để lấy lại hướng tại thời điểm khung hình được chụp
/// (hình camera luôn trễ hơn cảm biến vài chục mili giây).
final class Motion {
    private let manager = CMMotionManager()
    private let queue = OperationQueue()
    private let lock = NSLock()
    private var samples: [(t: CFTimeInterval, m: simd_float3x3)] = []

    var isAvailable: Bool { manager.isDeviceMotionAvailable }

    func start() {
        guard manager.isDeviceMotionAvailable else { return }
        manager.deviceMotionUpdateInterval = 1.0 / 100.0
        // Trục Z của hệ quy chiếu hướng lên trời; trục X tuỳ ý (không cần la bàn).
        manager.startDeviceMotionUpdates(using: .xArbitraryZVertical, to: queue) { [weak self] motion, _ in
            guard let self = self, let r = motion?.attitude.rotationMatrix else { return }
            // CMRotationMatrix đổi toạ độ từ hệ quy chiếu sang hệ của máy. Lưu theo hàng.
            let m = simd_float3x3(rows: [
                SIMD3<Float>(Float(r.m11), Float(r.m12), Float(r.m13)),
                SIMD3<Float>(Float(r.m21), Float(r.m22), Float(r.m23)),
                SIMD3<Float>(Float(r.m31), Float(r.m32), Float(r.m33)),
            ])
            self.lock.lock()
            self.samples.append((CACurrentMediaTime(), m))
            if self.samples.count > 200 { self.samples.removeFirst(self.samples.count - 200) }
            self.lock.unlock()
        }
    }

    /// Ma trận "hệ quy chiếu -> máy" tại thời điểm t (mẫu gần nhất không muộn hơn t).
    func referenceToDevice(at t: CFTimeInterval) -> simd_float3x3 {
        lock.lock(); defer { lock.unlock() }
        guard let last = samples.last else { return matrix_identity_float3x3 }
        for s in samples.reversed() where s.t <= t { return s.m }
        return samples.first?.m ?? last.m
    }
}
