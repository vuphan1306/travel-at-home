import Vision
import CoreVideo

/// Tách người bằng bộ của Apple (Vision), chạy trên chip của máy.
final class Segmenter {
    enum Quality: Int { case fast = 0, balanced, accurate
        var title: String { ["nhanh", "cân bằng", "cao"][rawValue] }
        var next: Quality { Quality(rawValue: (rawValue + 1) % 3) ?? .balanced }
    }

    private let request = VNGeneratePersonSegmentationRequest()
    private let handler = VNSequenceRequestHandler()      // giữ trạng thái giữa các khung để mặt nạ ổn định hơn
    private(set) var quality: Quality = .accurate

    init() {
        request.outputPixelFormat = kCVPixelFormatType_OneComponent8
        setQuality(.accurate)
    }

    func setQuality(_ q: Quality) {
        quality = q
        switch q {
        case .fast: request.qualityLevel = .fast
        case .balanced: request.qualityLevel = .balanced
        case .accurate: request.qualityLevel = .accurate
        }
    }

    /// Mặt nạ một kênh 8 bit: 255 là người, 0 là nền.
    func mask(for pixelBuffer: CVPixelBuffer) -> CVPixelBuffer? {
        do {
            try handler.perform([request], on: pixelBuffer, orientation: .up)
        } catch {
            return nil
        }
        return request.results?.first?.pixelBuffer
    }
}
