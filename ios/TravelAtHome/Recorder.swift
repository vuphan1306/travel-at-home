import AVFoundation
import Photos

/// Ghi hình đã ghép (từng khung do Renderer vẽ vào pixel buffer) cùng âm thanh từ micro ra file mp4.
final class Recorder {
    private let queue = DispatchQueue(label: "tah.recorder")
    private var writer: AVAssetWriter?
    private var videoInput: AVAssetWriterInput?
    private var audioInput: AVAssetWriterInput?
    private var adaptor: AVAssetWriterInputPixelBufferAdaptor?
    private var started = false
    private(set) var isRecording = false
    private(set) var url: URL?

    let width: Int
    let height: Int

    init(width: Int, height: Int) {
        self.width = width
        self.height = height
    }

    func start() throws {
        let fileURL = FileManager.default.temporaryDirectory.appendingPathComponent("travel-at-home-\(Int(Date().timeIntervalSince1970)).mp4")
        let w = try AVAssetWriter(outputURL: fileURL, fileType: .mp4)

        let v = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: width,
            AVVideoHeightKey: height,
            AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: 12_000_000, AVVideoExpectedSourceFrameRateKey: 30],
        ])
        v.expectsMediaDataInRealTime = true
        let ad = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: v, sourcePixelBufferAttributes: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
            kCVPixelBufferWidthKey as String: width,
            kCVPixelBufferHeightKey as String: height,
            kCVPixelBufferMetalCompatibilityKey as String: true,
        ])
        let a = AVAssetWriterInput(mediaType: .audio, outputSettings: [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVNumberOfChannelsKey: 1,
            AVSampleRateKey: 44_100,
            AVEncoderBitRateKey: 96_000,
        ])
        a.expectsMediaDataInRealTime = true

        if w.canAdd(v) { w.add(v) }
        if w.canAdd(a) { w.add(a) }
        guard w.startWriting() else { throw w.error ?? NSError(domain: "tah.recorder", code: 1) }

        queue.sync {
            writer = w; videoInput = v; audioInput = a; adaptor = ad
            url = fileURL; started = false; isRecording = true
        }
    }

    /// Pixel buffer trống để Renderer vẽ khung hình vào. Khung đầu tiên cũng là mốc bắt đầu của video
    /// (kho pixel buffer của bộ ghi chỉ có sau khi phiên ghi đã mở).
    func makePixelBuffer(at time: CMTime) -> CVPixelBuffer? {
        var result: CVPixelBuffer?
        queue.sync {
            guard isRecording, let writer = writer else { return }
            if !started {
                writer.startSession(atSourceTime: time)
                started = true
            }
            guard let pool = adaptor?.pixelBufferPool else { return }
            CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, pool, &result)
        }
        return result
    }

    func appendVideo(_ pixelBuffer: CVPixelBuffer, at time: CMTime) {
        queue.async {
            guard self.isRecording, self.started, let input = self.videoInput, let adaptor = self.adaptor else { return }
            if input.isReadyForMoreMediaData { adaptor.append(pixelBuffer, withPresentationTime: time) }
        }
    }

    func appendAudio(_ sampleBuffer: CMSampleBuffer) {
        queue.async {
            guard self.isRecording, self.started, let input = self.audioInput, input.isReadyForMoreMediaData else { return }
            input.append(sampleBuffer)
        }
    }

    /// Dừng ghi và lưu vào thư viện ảnh. Gọi lại trên luồng chính với thông báo kết quả.
    func stop(completion: @escaping (String) -> Void) {
        queue.async {
            guard self.isRecording, let writer = self.writer else { return }
            self.isRecording = false
            self.videoInput?.markAsFinished()
            self.audioInput?.markAsFinished()
            let fileURL = self.url
            writer.finishWriting {
                guard writer.status == .completed, let fileURL = fileURL else {
                    DispatchQueue.main.async { completion("Ghi hình lỗi: \(writer.error?.localizedDescription ?? "không rõ")") }
                    return
                }
                PHPhotoLibrary.requestAuthorization(for: .addOnly) { status in
                    guard status == .authorized || status == .limited else {
                        DispatchQueue.main.async { completion("Chưa được phép lưu vào thư viện ảnh") }
                        return
                    }
                    PHPhotoLibrary.shared().performChanges({
                        PHAssetChangeRequest.creationRequestForAssetFromVideo(atFileURL: fileURL)
                    }, completionHandler: { ok, error in
                        DispatchQueue.main.async {
                            completion(ok ? "Đã lưu video vào thư viện ảnh" : "Không lưu được: \(error?.localizedDescription ?? "không rõ")")
                        }
                    })
                }
            }
        }
    }
}
