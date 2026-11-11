import UIKit
import MetalKit
import AVFoundation

struct Destination {
    let name: String
    let file: String          // tên file .jpg trong gói app
    let lonDeg: Float         // kinh độ của địa danh trong ảnh 360° (0 là giữa ảnh)
}

final class CameraViewController: UIViewController {
    private let appVersion = "ios-3"
    private let destinations = [
        Destination(name: "La Mã", file: "colosseum", lonDeg: 132),
        Destination(name: "Paris", file: "eiffel", lonDeg: -96),
        Destination(name: "Vạn Lý Trường Thành", file: "great-wall", lonDeg: 42),
        Destination(name: "Venice", file: "venice", lonDeg: 15),
        Destination(name: "Vatican (đêm)", file: "vatican", lonDeg: -75),
        Destination(name: "London", file: "london", lonDeg: 70),
        Destination(name: "Louvre", file: "louvre", lonDeg: 85),
        Destination(name: "Nhà thờ Đức Bà", file: "notre-dame", lonDeg: -15),
        Destination(name: "Athens", file: "acropolis", lonDeg: 140),
        Destination(name: "Santorini", file: "santorini", lonDeg: -70),
        Destination(name: "Vienna", file: "schonbrunn", lonDeg: -3),
        Destination(name: "Thượng Hải (đêm)", file: "shanghai", lonDeg: 45),
        Destination(name: "Thác Niagara", file: "niagara", lonDeg: -20),
        Destination(name: "Grand Canyon", file: "grand-canyon", lonDeg: 60),
        Destination(name: "Núi Bàn", file: "table-mountain", lonDeg: 70),
    ]
    private var destinationIndex = 0

    private let capture = Capture()
    private let segmenter = Segmenter()
    private let motion = Motion()
    private let snap = SnapDetector()
    private let recorder = Recorder(width: 1080, height: 1920)
    private var renderer: Renderer?
    private var metalView: MTKView?

    private let hud = UILabel()
    private let toast = UILabel()
    private let snapButton = UIButton(type: .system)
    private let recordButton = UIButton(type: .custom)
    private let centerButton = UIButton(type: .system)
    private let destinationButton = UIButton(type: .system)
    private let qualityButton = UIButton(type: .system)
    private let maskButton = UIButton(type: .system)
    private let flipButton = UIButton(type: .system)

    private var segmentMs: Double = 0
    private var pinchStartZoom: Float = 1
    private var cameraSize = CGSize.zero

    override var prefersStatusBarHidden: Bool { true }
    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { .portrait }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black

        guard let device = MTLCreateSystemDefaultDevice(), let renderer = Renderer(device: device, motion: motion) else {
            showToast("Máy này không chạy được Metal", seconds: 60)
            return
        }
        renderer.recorder = recorder
        self.renderer = renderer

        let mv = MTKView(frame: .zero, device: device)
        mv.colorPixelFormat = .bgra8Unorm
        mv.framebufferOnly = true
        mv.preferredFramesPerSecond = 60
        mv.delegate = renderer
        mv.transform = CGAffineTransform(scaleX: -1, y: 1)       // xem trước kiểu soi gương; video ghi ra không lật
        view.addSubview(mv)
        metalView = mv

        setupControls()
        view.addGestureRecognizer(UIPinchGestureRecognizer(target: self, action: #selector(handlePinch(_:))))

        snap.onSnap = { [weak self] in self?.snapHeard() }
        capture.onVideo = { [weak self] buffer in self?.handleVideo(buffer) }
        capture.onAudio = { [weak self] buffer in
            self?.snap.process(buffer)
            self?.recorder.appendAudio(buffer)
        }

        motion.start()
        loadDestination(0)
        requestAccessAndStart()

        Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.updateHud() }
    }

    // MARK: Camera

    private func requestAccessAndStart() {
        AVCaptureDevice.requestAccess(for: .video) { [weak self] videoOK in
            AVCaptureDevice.requestAccess(for: .audio) { _ in
                DispatchQueue.main.async {
                    guard let self = self else { return }
                    guard videoOK else { self.showToast("Chưa được phép dùng camera. Mở Cài đặt để cấp quyền.", seconds: 60); return }
                    do {
                        try self.capture.configure()
                        self.capture.start()
                    } catch {
                        self.showToast("Không mở được camera: \(error.localizedDescription)", seconds: 60)
                    }
                }
            }
        }
    }

    /// Chạy trên luồng camera: tách người rồi giao khung hình cho bộ vẽ.
    private func handleVideo(_ sampleBuffer: CMSampleBuffer) {
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        let t0 = CACurrentMediaTime()
        let mask = segmenter.mask(for: pixelBuffer)
        let ms = (CACurrentMediaTime() - t0) * 1000
        segmentMs = segmentMs * 0.9 + ms * 0.1
        cameraSize = CGSize(width: CVPixelBufferGetWidth(pixelBuffer), height: CVPixelBufferGetHeight(pixelBuffer))
        renderer?.update(pixelBuffer: pixelBuffer, mask: mask, time: CMSampleBufferGetPresentationTimeStamp(sampleBuffer))
    }

    // MARK: Điều khiển

    private func setupControls() {
        hud.numberOfLines = 0
        hud.font = UIFont.monospacedSystemFont(ofSize: 11, weight: .regular)
        hud.textColor = .white
        hud.backgroundColor = UIColor.black.withAlphaComponent(0.45)
        hud.text = " đang mở camera… "
        view.addSubview(hud)

        toast.numberOfLines = 0
        toast.textAlignment = .center
        toast.font = UIFont.systemFont(ofSize: 15, weight: .medium)
        toast.textColor = .white
        toast.backgroundColor = UIColor.black.withAlphaComponent(0.7)
        toast.layer.cornerRadius = 10
        toast.layer.masksToBounds = true
        toast.isHidden = true
        view.addSubview(toast)

        style(snapButton, title: "Búng 🫰", action: #selector(tapSnap))
        style(centerButton, title: "Canh giữa", action: #selector(tapCenter))
        style(destinationButton, title: destinations[0].name, action: #selector(tapDestination))
        // Nhiều điểm đến: bấm nút thì mở danh sách để chọn thay vì phải bấm lần lượt.
        destinationButton.menu = UIMenu(title: "Điểm đến", children: destinations.enumerated().map { index, d in
            UIAction(title: d.name) { [weak self] _ in self?.loadDestination(index) }
        })
        destinationButton.showsMenuAsPrimaryAction = true
        destinationButton.titleLabel?.adjustsFontSizeToFitWidth = true
        style(qualityButton, title: "Tách: \(segmenter.quality.title)", action: #selector(tapQuality))
        style(maskButton, title: "Mặt nạ", action: #selector(tapMask))
        style(flipButton, title: "Đảo xoay", action: #selector(tapFlip))

        recordButton.backgroundColor = UIColor(red: 1, green: 0.3, blue: 0.3, alpha: 1)
        recordButton.layer.cornerRadius = 36
        recordButton.layer.borderWidth = 4
        recordButton.layer.borderColor = UIColor.white.cgColor
        recordButton.addTarget(self, action: #selector(tapRecord), for: .touchUpInside)
        recordButton.addTarget(self, action: #selector(touchedDown), for: .touchDown)
        view.addSubview(recordButton)
    }

    private func style(_ button: UIButton, title: String, action: Selector) {
        button.setTitle(title, for: .normal)
        button.setTitleColor(.white, for: .normal)
        button.titleLabel?.font = UIFont.systemFont(ofSize: 14, weight: .medium)
        button.backgroundColor = UIColor.black.withAlphaComponent(0.5)
        button.layer.cornerRadius = 18
        button.layer.borderWidth = 1
        button.layer.borderColor = UIColor.white.withAlphaComponent(0.35).cgColor
        button.addTarget(self, action: action, for: .touchUpInside)
        button.addTarget(self, action: #selector(touchedDown), for: .touchDown)
        view.addSubview(button)
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let b = view.bounds, safe = view.safeAreaInsets
        // Khung hình 9:16 nằm gọn trong màn hình, đúng là khung sẽ được ghi.
        let w = min(b.width, b.height * 9 / 16), h = w * 16 / 9
        if let mv = metalView {
            mv.bounds = CGRect(x: 0, y: 0, width: w, height: h)
            mv.center = CGPoint(x: b.midX, y: b.midY)
        }
        hud.frame = CGRect(x: 10, y: safe.top + 6, width: min(250, b.width - 150), height: 94)
        let rightX = b.width - 138
        var y = safe.top + 6
        for button in [destinationButton, qualityButton, maskButton, flipButton] {
            button.frame = CGRect(x: rightX, y: y, width: 128, height: 36)
            y += 42
        }
        let bottom = b.height - safe.bottom - 20
        recordButton.frame = CGRect(x: b.midX - 36, y: bottom - 72, width: 72, height: 72)
        snapButton.frame = CGRect(x: b.midX - 36 - 16 - 104, y: bottom - 54, width: 104, height: 36)
        centerButton.frame = CGRect(x: b.midX + 36 + 16, y: bottom - 54, width: 104, height: 36)
        toast.frame = CGRect(x: 30, y: b.midY - 40, width: b.width - 60, height: 80)
    }

    @objc private func tapSnap() { toggleScene() }

    // Ngón tay chạm màn hình tạo ra tiếng "tách" ngay sát micro: báo cho bộ nghe để nó bỏ qua.
    @objc private func touchedDown() { snap.noteTouch() }

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
        snap.noteTouch()
        super.touchesBegan(touches, with: event)
    }

    /// Tiếng búng tay chỉ đưa tới điểm đến. Quay về nhà phải bấm nút "Búng",
    /// để một tiếng động lạ không kéo cảnh về giữa chừng.
    private func snapHeard() {
        guard let r = renderer, r.revealTarget < 0.5 else { return }
        toggleScene()
    }

    @objc private func tapCenter() { renderer?.centerHeading() }

    @objc private func tapDestination() { loadDestination((destinationIndex + 1) % destinations.count) }

    @objc private func tapQuality() {
        segmenter.setQuality(segmenter.quality.next)
        qualityButton.setTitle("Tách: \(segmenter.quality.title)", for: .normal)
    }

    @objc private func tapMask() {
        guard let r = renderer else { return }
        r.debugMask.toggle()
        maskButton.setTitle(r.debugMask ? "Mặt nạ: bật" : "Mặt nạ", for: .normal)
    }

    @objc private func tapFlip() {
        guard let r = renderer else { return }
        r.flipMatrix.toggle()
        r.centerHeading()
        flipButton.setTitle(r.flipMatrix ? "Đảo xoay: bật" : "Đảo xoay", for: .normal)
    }

    @objc private func tapRecord() {
        if recorder.isRecording {
            recordButton.layer.cornerRadius = 36
            recordButton.transform = .identity
            recorder.stop { [weak self] message in self?.showToast(message, seconds: 3) }
        } else {
            do {
                try recorder.start()
                recordButton.layer.cornerRadius = 10
                recordButton.transform = CGAffineTransform(scaleX: 0.6, y: 0.6)
            } catch {
                showToast("Không bắt đầu ghi được: \(error.localizedDescription)", seconds: 4)
            }
        }
    }

    @objc private func handlePinch(_ gesture: UIPinchGestureRecognizer) {
        guard let r = renderer else { return }
        if gesture.state == .began { pinchStartZoom = r.zoom }
        r.zoom = max(1, min(3, pinchStartZoom * Float(gesture.scale)))
    }

    /// Búng tay: chuyển giữa "ở nhà" và "ở điểm đến". Khi tới nơi, địa danh hiện ngay sau lưng.
    private func toggleScene() {
        guard let r = renderer else { return }
        if r.revealTarget > 0.5 {
            r.revealTarget = 0
        } else {
            r.centerHeading()
            r.revealTarget = 1
        }
    }

    private func loadDestination(_ index: Int) {
        destinationIndex = index
        let d = destinations[index]
        destinationButton.setTitle(d.name, for: .normal)
        guard let url = Bundle.main.url(forResource: d.file, withExtension: "jpg") else {
            showToast("Thiếu ảnh \(d.file).jpg trong app", seconds: 4)
            return
        }
        renderer?.loadPano(url: url, lonDeg: d.lonDeg) { [weak self] ok in
            if !ok { self?.showToast("Không nạp được ảnh \(d.name)", seconds: 4) }
        }
    }

    // MARK: Thông tin trên màn hình

    private func updateHud() {
        guard let r = renderer else { return }
        let fps = r.takeFrameCount()
        let size = cameraSize
        hud.text = " \(appVersion)  \(fps) fps  cam \(Int(size.width))x\(Int(size.height))\n" +
            " tách người: \(segmenter.quality.title) \(String(format: "%.1f", segmentMs)) ms\n" +
            " xoay: \(motion.isAvailable ? "cảm biến" : "không có")  zoom \(String(format: "%.1f", r.zoom))x" +
            "\n búng: \(snap.fired) (loại \(snap.rejected)\(snap.lastReject.isEmpty ? "" : ": " + snap.lastReject))" +
            (recorder.isRecording ? "\n ● đang quay" : "")
    }

    private func showToast(_ text: String, seconds: Double) {
        toast.text = text
        toast.isHidden = false
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { [weak self] in
            if self?.toast.text == text { self?.toast.isHidden = true }
        }
    }
}
