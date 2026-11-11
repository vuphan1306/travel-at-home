import AVFoundation

/// Camera trước + micro. Trả từng khung hình (BGRA, đã xoay dọc, không lật gương) và từng gói âm thanh.
final class Capture: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate, AVCaptureAudioDataOutputSampleBufferDelegate {
    let session = AVCaptureSession()
    var onVideo: ((CMSampleBuffer) -> Void)?
    var onAudio: ((CMSampleBuffer) -> Void)?

    private let videoQueue = DispatchQueue(label: "tah.capture.video")
    private let audioQueue = DispatchQueue(label: "tah.capture.audio")
    private let videoOutput = AVCaptureVideoDataOutput()
    private let audioOutput = AVCaptureAudioDataOutput()

    enum CaptureError: Error { case noCamera }

    func configure() throws {
        session.beginConfiguration()
        defer { session.commitConfiguration() }
        session.sessionPreset = .hd1920x1080

        guard let camera = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .front) else {
            throw CaptureError.noCamera
        }
        let videoInput = try AVCaptureDeviceInput(device: camera)
        if session.canAddInput(videoInput) { session.addInput(videoInput) }

        if let mic = AVCaptureDevice.default(for: .audio), let audioInput = try? AVCaptureDeviceInput(device: mic),
           session.canAddInput(audioInput) {
            session.addInput(audioInput)
        }

        videoOutput.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
        videoOutput.alwaysDiscardsLateVideoFrames = true      // model chậm thì bỏ khung, không dồn hàng
        videoOutput.setSampleBufferDelegate(self, queue: videoQueue)
        if session.canAddOutput(videoOutput) { session.addOutput(videoOutput) }

        audioOutput.setSampleBufferDelegate(self, queue: audioQueue)
        if session.canAddOutput(audioOutput) { session.addOutput(audioOutput) }

        if let conn = videoOutput.connection(with: .video) {
            if #available(iOS 17.0, *) {
                if conn.isVideoRotationAngleSupported(90) { conn.videoRotationAngle = 90 }
            } else if conn.isVideoOrientationSupported {
                conn.videoOrientation = .portrait
            }
            if conn.isVideoMirroringSupported {
                conn.automaticallyAdjustsVideoMirroring = false
                conn.isVideoMirrored = false                  // giữ ảnh thật; chỉ lật gương ở màn hình xem trước
            }
        }
    }

    func start() {
        videoQueue.async { [session] in
            if !session.isRunning { session.startRunning() }
        }
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        if output === videoOutput { onVideo?(sampleBuffer) } else { onAudio?(sampleBuffer) }
    }
}
