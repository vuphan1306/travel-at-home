import AVFoundation

/// Nhận ra tiếng búng tay: một xung âm thanh ngắn, mạnh ở dải cao, tắt gần như ngay.
/// Tiếng nói cũng có dải cao nhưng kéo dài, nên sau khi thấy xung ta chờ 90 ms rồi kiểm tra đã lặng lại chưa.
final class SnapDetector {
    var onSnap: (() -> Void)?
    var isEnabled = true
    var sensitivity: Float = 5            // 1 (khó kích) .. 10 (dễ kích)
    private(set) var level: Float = 0     // mức hiện tại, để vẽ thanh đo

    private var background: Float = 0.01
    private var candidatePeak: Float = 0
    private var candidateTime: Double = -1
    private var lastSnap: Double = -10
    private var previous: Float = 0

    func process(_ sampleBuffer: CMSampleBuffer) {
        guard let format = CMSampleBufferGetFormatDescription(sampleBuffer),
              let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(format)?.pointee,
              asbd.mFormatID == kAudioFormatLinearPCM,
              asbd.mBitsPerChannel == 16,
              (asbd.mFormatFlags & kAudioFormatFlagIsFloat) == 0,
              let block = CMSampleBufferGetDataBuffer(sampleBuffer) else { return }

        var length = 0
        var pointer: UnsafeMutablePointer<Int8>?
        guard CMBlockBufferGetDataPointer(block, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: &length, dataPointerOut: &pointer) == kCMBlockBufferNoErr,
              let base = pointer, length >= 2 else { return }

        let channels = max(1, Int(asbd.mChannelsPerFrame))
        let frames = length / (2 * channels)
        let time = CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sampleBuffer))
        let duration = Double(frames) / max(1, asbd.mSampleRate)

        base.withMemoryRebound(to: Int16.self, capacity: frames * channels) { samples in
            // Lọc thông cao thô bằng hiệu của hai mẫu liên tiếp, rồi lấy đỉnh theo từng đoạn khoảng 10 ms.
            let chunk = max(1, Int(asbd.mSampleRate * 0.01))
            var i = 0
            while i < frames {
                let end = min(frames, i + chunk)
                var peak: Float = 0
                var j = i
                while j < end {
                    let v = Float(samples[j * channels]) / 32768.0
                    let hp = abs(v - previous)
                    previous = v
                    if hp > peak { peak = hp }
                    j += 1
                }
                step(peak: peak, time: time + duration * Double(i) / Double(max(1, frames)))
                i = end
            }
        }
    }

    private func step(peak: Float, time: Double) {
        level = peak
        let threshold = max(0.5 / (sensitivity * sensitivity), background * 6)
        if candidateTime >= 0 {
            if time - candidateTime > 0.09 {
                if peak < candidatePeak * 0.35, isEnabled, time - lastSnap > 1.2 {
                    lastSnap = time
                    DispatchQueue.main.async { [weak self] in self?.onSnap?() }
                }
                candidateTime = -1
            } else if peak > candidatePeak {
                candidatePeak = peak
            }
        } else if peak > threshold, time - lastSnap > 1.2 {
            candidateTime = time
            candidatePeak = peak
        }
        background = background * 0.97 + min(peak, 0.2) * 0.03
    }
}
