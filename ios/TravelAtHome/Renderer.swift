import MetalKit
import AVFoundation
import simd

/// Phải khớp từng byte với struct Uniforms trong Shaders.metal.
struct Uniforms {
    var rot = matrix_identity_float4x4
    var p0 = SIMD4<Float>(0, 0, 0, 1)
    var p1 = SIMD4<Float>(1, 0.1, 0.9, 0)
    var tint = SIMD4<Float>(1, 1, 1, 0)
}

/// Vẽ từng khung hình: người (ảnh camera + mặt nạ) trên nền ảnh 360° xoay theo hướng máy.
/// Vẽ ra màn hình ở mỗi lần làm tươi, và vẽ thêm vào file video mỗi khi có khung camera mới lúc đang quay.
final class Renderer: NSObject, MTKViewDelegate {
    let device: MTLDevice
    private let commandQueue: MTLCommandQueue
    private let pipeline: MTLRenderPipelineState
    private var textureCache: CVMetalTextureCache?
    private let lock = NSLock()
    private let motion: Motion

    // Khung camera mới nhất
    private var camTexture: MTLTexture?
    private var camHold: (CVPixelBuffer, CVMetalTexture)?
    private var maskTextures: [MTLTexture?] = [nil, nil]
    private var maskIndex = 0
    private var frameTime = CMTime.invalid
    private var frameHostTime: CFTimeInterval = 0
    private var frameIsNew = false

    private var panoTexture: MTLTexture?
    private let emptyMask: MTLTexture
    private let emptyPano: MTLTexture

    // Thông số điều khiển từ giao diện (chỉ đổi trên luồng chính)
    var zoom: Float = 1
    var fovVerticalDeg: Float = 70
    var revealTarget: Float = 0
    private(set) var reveal: Float = 0
    var panoLon: Float = 0                 // kinh độ của địa danh trong ảnh 360° (radian)
    var debugMask = false
    var flipMatrix = false                 // công tắc thử: đảo chiều ma trận xoay nếu nền xoay ngược
    var motionDelay: CFTimeInterval = 0.05
    var recorder: Recorder?
    private var heading0: Float = 0
    private var lastDraw: CFTimeInterval = 0
    private(set) var framesThisSecond = 0

    init?(device: MTLDevice, motion: Motion) {
        guard let queue = device.makeCommandQueue(),
              let library = device.makeDefaultLibrary(),
              let vfn = library.makeFunction(name: "vmain"),
              let ffn = library.makeFunction(name: "fmain") else { return nil }
        let desc = MTLRenderPipelineDescriptor()
        desc.vertexFunction = vfn
        desc.fragmentFunction = ffn
        desc.colorAttachments[0].pixelFormat = .bgra8Unorm
        guard let state = try? device.makeRenderPipelineState(descriptor: desc),
              let m = Renderer.solidTexture(device: device, format: .r8Unorm, bytes: [0]),
              let p = Renderer.solidTexture(device: device, format: .bgra8Unorm, bytes: [40, 40, 40, 255]) else { return nil }
        self.device = device
        self.commandQueue = queue
        self.pipeline = state
        self.motion = motion
        self.emptyMask = m
        self.emptyPano = p
        super.init()
        CVMetalTextureCacheCreate(kCFAllocatorDefault, nil, device, nil, &textureCache)
    }

    private static func solidTexture(device: MTLDevice, format: MTLPixelFormat, bytes: [UInt8]) -> MTLTexture? {
        let d = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: format, width: 1, height: 1, mipmapped: false)
        d.usage = .shaderRead
        guard let t = device.makeTexture(descriptor: d) else { return nil }
        bytes.withUnsafeBytes { raw in
            if let base = raw.baseAddress {
                t.replace(region: MTLRegionMake2D(0, 0, 1, 1), mipmapLevel: 0, withBytes: base, bytesPerRow: bytes.count)
            }
        }
        return t
    }

    // MARK: Dữ liệu vào

    /// Gọi từ luồng camera với khung hình mới và mặt nạ của nó.
    func update(pixelBuffer: CVPixelBuffer, mask: CVPixelBuffer?, time: CMTime) {
        guard let cache = textureCache else { return }
        let w = CVPixelBufferGetWidth(pixelBuffer), h = CVPixelBufferGetHeight(pixelBuffer)
        var cvTexture: CVMetalTexture?
        CVMetalTextureCacheCreateTextureFromImage(kCFAllocatorDefault, cache, pixelBuffer, nil, .bgra8Unorm, w, h, 0, &cvTexture)
        guard let cvTex = cvTexture, let texture = CVMetalTextureGetTexture(cvTex) else { return }

        lock.lock()
        let target = 1 - maskIndex
        var maskTexture = maskTextures[target]
        lock.unlock()

        var maskUpdated = false
        if let mask = mask {
            let mw = CVPixelBufferGetWidth(mask), mh = CVPixelBufferGetHeight(mask)
            if maskTexture == nil || maskTexture?.width != mw || maskTexture?.height != mh {
                let d = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .r8Unorm, width: mw, height: mh, mipmapped: false)
                d.usage = .shaderRead
                maskTexture = device.makeTexture(descriptor: d)
            }
            CVPixelBufferLockBaseAddress(mask, .readOnly)
            if let base = CVPixelBufferGetBaseAddress(mask), let mt = maskTexture {
                mt.replace(region: MTLRegionMake2D(0, 0, mw, mh), mipmapLevel: 0, withBytes: base,
                           bytesPerRow: CVPixelBufferGetBytesPerRow(mask))
                maskUpdated = true
            }
            CVPixelBufferUnlockBaseAddress(mask, .readOnly)
        }

        lock.lock()
        camTexture = texture
        camHold = (pixelBuffer, cvTex)
        if maskUpdated { maskTextures[target] = maskTexture; maskIndex = target }
        frameTime = time
        frameHostTime = CACurrentMediaTime()
        frameIsNew = true
        framesThisSecond += 1
        lock.unlock()
    }

    func takeFrameCount() -> Int {
        lock.lock(); defer { lock.unlock() }
        let n = framesThisSecond
        framesThisSecond = 0
        return n
    }

    func loadPano(url: URL, lonDeg: Float, completion: @escaping (Bool) -> Void) {
        DispatchQueue.global(qos: .userInitiated).async {
            let loader = MTKTextureLoader(device: self.device)
            let options: [MTKTextureLoader.Option: Any] = [
                .SRGB: false,
                .generateMipmaps: false,
                .origin: MTKTextureLoader.Origin.topLeft,
            ]
            let texture = try? loader.newTexture(URL: url, options: options)
            DispatchQueue.main.async {
                if let texture = texture {
                    self.panoTexture = texture
                    self.panoLon = lonDeg * .pi / 180
                }
                completion(texture != nil)
            }
        }
    }

    // MARK: Hướng máy

    /// Ma trận đổi từ hệ của máy sang hệ mặt đất (Z hướng lên).
    private func deviceToWorld(at t: CFTimeInterval) -> simd_float3x3 {
        let refToDevice = motion.referenceToDevice(at: t)
        return flipMatrix ? refToDevice : refToDevice.transpose
    }

    /// Lấy hướng camera đang chĩa làm hướng của địa danh.
    func centerHeading() {
        let w = deviceToWorld(at: CACurrentMediaTime())
        let f = w * SIMD3<Float>(0, 0, 1)             // camera trước nhìn theo trục +Z của máy
        heading0 = atan2(f.x, f.y)
    }

    private func makeUniforms(aspect: Float, hostTime: CFTimeInterval) -> Uniforms {
        let w = deviceToWorld(at: hostTime - motionDelay)
        let a = heading0 - panoLon
        let c = cos(a), s = sin(a)
        let rz = simd_float3x3(columns: (SIMD3<Float>(c, s, 0), SIMD3<Float>(-s, c, 0), SIMD3<Float>(0, 0, 1)))
        let r = rz * w
        var u = Uniforms()
        u.rot = simd_float4x4(columns: (SIMD4<Float>(r.columns.0, 0), SIMD4<Float>(r.columns.1, 0),
                                        SIMD4<Float>(r.columns.2, 0), SIMD4<Float>(0, 0, 0, 1)))
        let tv = tan(fovVerticalDeg * .pi / 180 / 2) / zoom
        u.p0 = SIMD4<Float>(tv * aspect, tv, reveal, aspect)
        u.p1 = SIMD4<Float>(zoom, 0.08, 0.92, 0)
        u.tint = SIMD4<Float>(1, 1, 1, debugMask ? 1 : 0)
        return u
    }

    // MARK: Vẽ

    func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) {}

    func draw(in view: MTKView) {
        let now = CACurrentMediaTime()
        let dt = Float(min(0.1, now - lastDraw))
        lastDraw = now
        let diff = revealTarget - reveal
        if diff != 0 { reveal += (diff > 0 ? 1 : -1) * min(abs(diff), dt / 0.6) }   // chuyển cảnh trong khoảng 0,6 giây

        lock.lock()
        let cam = camTexture
        let hold = camHold
        let mask = maskTextures[maskIndex] ?? emptyMask
        let isNew = frameIsNew
        frameIsNew = false
        let time = frameTime
        let hostTime = frameHostTime
        lock.unlock()

        guard let camTex = cam, let commandBuffer = commandQueue.makeCommandBuffer() else { return }
        let pano = panoTexture ?? emptyPano

        // Ghi vào video: đúng một lần cho mỗi khung camera.
        if isNew, let rec = recorder, rec.isRecording, let cache = textureCache, let pb = rec.makePixelBuffer(at: time) {
            var cvTarget: CVMetalTexture?
            CVMetalTextureCacheCreateTextureFromImage(kCFAllocatorDefault, cache, pb, nil, .bgra8Unorm, rec.width, rec.height, 0, &cvTarget)
            if let cvTarget = cvTarget, let target = CVMetalTextureGetTexture(cvTarget) {
                let pass = MTLRenderPassDescriptor()
                pass.colorAttachments[0].texture = target
                pass.colorAttachments[0].loadAction = .dontCare
                pass.colorAttachments[0].storeAction = .store
                var u = makeUniforms(aspect: Float(rec.width) / Float(rec.height), hostTime: hostTime)
                encode(commandBuffer, pass: pass, uniforms: &u, cam: camTex, mask: mask, pano: pano)
                commandBuffer.addCompletedHandler { _ in
                    rec.appendVideo(pb, at: time)
                    _ = cvTarget
                }
            }
        }

        if let pass = view.currentRenderPassDescriptor, let drawable = view.currentDrawable {
            let size = view.drawableSize
            var u = makeUniforms(aspect: Float(size.width / max(1, size.height)), hostTime: hostTime)
            encode(commandBuffer, pass: pass, uniforms: &u, cam: camTex, mask: mask, pano: pano)
            commandBuffer.present(drawable)
        }
        commandBuffer.addCompletedHandler { _ in _ = hold }      // giữ khung camera sống tới khi GPU vẽ xong
        commandBuffer.commit()
    }

    private func encode(_ commandBuffer: MTLCommandBuffer, pass: MTLRenderPassDescriptor, uniforms: inout Uniforms,
                        cam: MTLTexture, mask: MTLTexture, pano: MTLTexture) {
        guard let encoder = commandBuffer.makeRenderCommandEncoder(descriptor: pass) else { return }
        encoder.setRenderPipelineState(pipeline)
        encoder.setFragmentBytes(&uniforms, length: MemoryLayout<Uniforms>.stride, index: 0)
        encoder.setFragmentTexture(cam, index: 0)
        encoder.setFragmentTexture(mask, index: 1)
        encoder.setFragmentTexture(pano, index: 2)
        encoder.drawPrimitives(type: .triangleStrip, vertexStart: 0, vertexCount: 4)
        encoder.endEncoding()
    }
}
