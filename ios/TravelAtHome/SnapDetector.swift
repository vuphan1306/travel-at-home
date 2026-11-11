import AVFoundation
import QuartzCore

/// Nhận ra tiếng búng tay. Cùng cách làm với snap.js của bản web (đã thử bằng tools/test_snap.mjs).
///
/// Một tiếng búng tay được công nhận khi đủ cả các điều kiện sau:
///   1. to hẳn lên so với 150 ms trước đó (không phải đang giữa một câu nói hay tiếng ồn kéo dài)
///   2. sáng: phần lớn năng lượng nằm ở dải cao (tiếng nói, tiếng gõ trầm thì không)
///   3. tắt rất nhanh: sau 40 ms không còn gì đáng kể, và giữ lặng tới 150 ms
///   4. không trùng lúc ngón tay vừa chạm màn hình (chạm máy cũng tạo ra tiếng "tách")
final class SnapDetector {
    var onSnap: (() -> Void)?
    var isEnabled = true
    var sensitivity: Float = 5            // 1 (khó kích) .. 10 (dễ kích)
    /// Tỉ lệ dải cao / toàn dải tối thiểu. Bộ lọc ở đây là hiệu hai mẫu liên tiếp nên tỉ lệ thấp hơn bản web.
    var minBright: Float = 0.25
    private(set) var fired = 0
    private(set) var rejected = 0
    private(set) var lastReject = ""

    private var background: Float = 0.01
    private var history: [(t: Double, hp: Float)] = []
    private var candidate: (t: Double, peak: Float)?
    private var lastFire: Double = -1e9
    private var lastTouch: Double = -1e9
    private var previous: Float = 0

    /// Gọi khi ngón tay chạm màn hình. Dùng cùng đồng hồ với mốc thời gian của âm thanh (giây kể từ lúc máy bật).
    func noteTouch() { lastTouch = CACurrentMediaTime() }

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
            // Mỗi đoạn khoảng 10 ms: đỉnh của tín hiệu gốc và đỉnh sau khi lọc thông cao thô (hiệu hai mẫu liên tiếp).
            let chunk = max(1, Int(asbd.mSampleRate * 0.01))
            var i = 0
            while i < frames {
                let end = min(frames, i + chunk)
                var hp: Float = 0
                var raw: Float = 0
                var j = i
                while j < end {
                    let v = Float(samples[j * channels]) / 32768.0
                    let d = abs(v - previous)
                    previous = v
                    if d > hp { hp = d }
                    if abs(v) > raw { raw = abs(v) }
                    j += 1
                }
                step(hp: hp, raw: raw, time: time + duration * Double(i) / Double(max(1, frames)))
                i = end
            }
        }
    }

    private func step(hp: Float, raw: Float, time: Double) {
        if let c = candidate {
            let age = time - c.t
            if age <= 0.04 {
                if hp > c.peak { candidate = (c.t, hp) }
            } else if age <= 0.15 {
                if hp > c.peak * 0.3 { candidate = nil; rejected += 1; lastReject = "âm kéo dài" }
            } else {
                candidate = nil
                lastFire = time
                fired += 1
                if isEnabled { DispatchQueue.main.async { [weak self] in self?.onSnap?() } }
            }
        } else {
            var recent: Float = 0
            for h in history where h.hp > recent { recent = h.hp }
            let floorLevel = 0.75 / (sensitivity * sensitivity)
            if hp > floorLevel, hp > background * 6, hp > recent * 4, time - lastFire > 1.5 {
                if time - lastTouch < 0.4 { rejected += 1; lastReject = "vừa chạm màn hình" }
                else if raw <= 0 || hp / raw < minBright { rejected += 1; lastReject = "âm trầm" }
                else { candidate = (time, hp) }
            }
        }
        history.append((time, hp))
        while let first = history.first, time - first.t > 0.15 { history.removeFirst() }
        background = background * 0.97 + min(hp, 0.2) * 0.03
    }
}
