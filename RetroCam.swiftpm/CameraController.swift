import AVFoundation
import CoreImage
import Metal
import QuartzCore
import UIKit

/// Kamera + Mikrofon, VHS-Effekt in Echtzeit, Vorschau und Aufnahme in eine .mov-Datei.
/// Alles Bild-/Tonverarbeitende läuft auf `queue`.
final class CameraController: NSObject,
                              AVCaptureVideoDataOutputSampleBufferDelegate,
                              AVCaptureAudioDataOutputSampleBufferDelegate,
                              @unchecked Sendable {
    static let shared = CameraController()

    private let session = AVCaptureSession()
    private let queue = DispatchQueue(label: "retrocam.capture", qos: .userInitiated)
    private let videoOutput = AVCaptureVideoDataOutput()
    private let audioOutput = AVCaptureAudioDataOutput()
    private let effect = VHSEffect()
    private let ciContext: CIContext
    private let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!
    private var pool: CVPixelBufferPool?
    private var configured = false
    private var showDateStamp = true

    private let layerLock = NSLock()
    private weak var displayLayer: AVSampleBufferDisplayLayer?

    // Aufnahme-Zustand (nur auf `queue` benutzen)
    private var writer: AVAssetWriter?
    private var videoInput: AVAssetWriterInput?
    private var audioInput: AVAssetWriterInput?
    private var adaptor: AVAssetWriterInputPixelBufferAdaptor?
    private var sessionStarted = false
    private var firstPTS = CMTime.zero
    private var glitchStart: CFTimeInterval = 0

    override init() {
        if let device = MTLCreateSystemDefaultDevice() {
            ciContext = CIContext(mtlDevice: device)
        } else {
            ciContext = CIContext()
        }
        super.init()
    }

    // MARK: - Steuerung

    func attach(_ layer: AVSampleBufferDisplayLayer) {
        layerLock.lock()
        displayLayer = layer
        layerLock.unlock()
    }

    func setShowDateStamp(_ value: Bool) {
        queue.async { self.showDateStamp = value }
    }

    func start() {
        queue.async { [self] in
            if !configured { configure() }
            if !session.isRunning { session.startRunning() }
        }
    }

    func stop() {
        queue.async { [self] in
            if session.isRunning { session.stopRunning() }
        }
    }

    func startRecording(to url: URL) {
        queue.async { [self] in
            guard writer == nil else { return }
            try? FileManager.default.removeItem(at: url)
            guard let w = try? AVAssetWriter(outputURL: url, fileType: .mov) else { return }

            let videoSettings: [String: Any] = [
                AVVideoCodecKey: AVVideoCodecType.h264,
                AVVideoWidthKey: Int(VHSEffect.size.width),
                AVVideoHeightKey: Int(VHSEffect.size.height),
                AVVideoCompressionPropertiesKey: [
                    AVVideoAverageBitRateKey: 3_000_000,
                    AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel
                ]
            ]
            let vi = AVAssetWriterInput(mediaType: .video, outputSettings: videoSettings)
            vi.expectsMediaDataInRealTime = true
            guard w.canAdd(vi) else { return }
            w.add(vi)
            let ad = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: vi, sourcePixelBufferAttributes: nil)

            var ai: AVAssetWriterInput?
            if let settings = audioOutput.recommendedAudioSettingsForAssetWriter(writingTo: .mov) as? [String: Any] {
                let input = AVAssetWriterInput(mediaType: .audio, outputSettings: settings)
                input.expectsMediaDataInRealTime = true
                if w.canAdd(input) {
                    w.add(input)
                    ai = input
                }
            }

            writer = w
            videoInput = vi
            audioInput = ai
            adaptor = ad
            sessionStarted = false
            glitchStart = CACurrentMediaTime()
        }
    }

    /// Beendet die Aufnahme. `completion` kommt auf dem Main-Thread mit der Datei (oder nil).
    func stopRecording(completion: @escaping (URL?) -> Void) {
        queue.async { [self] in
            guard let w = writer else {
                DispatchQueue.main.async { completion(nil) }
                return
            }
            let started = sessionStarted
            writer = nil
            videoInput = nil
            audioInput = nil
            adaptor = nil
            sessionStarted = false

            guard started, w.status == .writing else {
                if w.status == .writing { w.cancelWriting() }
                DispatchQueue.main.async { completion(nil) }
                return
            }
            w.inputs.forEach { $0.markAsFinished() }
            w.finishWriting {
                let url: URL? = w.status == .completed ? w.outputURL : nil
                DispatchQueue.main.async { completion(url) }
            }
        }
    }

    // MARK: - Einrichtung

    private func configure() {
        configured = true

        let audioSession = AVAudioSession.sharedInstance()
        try? audioSession.setCategory(.playAndRecord, mode: .videoRecording, options: [.defaultToSpeaker, .allowBluetoothA2DP])
        try? audioSession.setActive(true)

        session.beginConfiguration()
        session.automaticallyConfiguresApplicationAudioSession = false
        if session.canSetSessionPreset(.vga640x480) {
            session.sessionPreset = .vga640x480
        } else {
            session.sessionPreset = .high
        }

        if let camera = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back),
           let input = try? AVCaptureDeviceInput(device: camera),
           session.canAddInput(input) {
            session.addInput(input)
        }
        if let mic = AVCaptureDevice.default(for: .audio),
           let input = try? AVCaptureDeviceInput(device: mic),
           session.canAddInput(input) {
            session.addInput(input)
        }

        videoOutput.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
        videoOutput.alwaysDiscardsLateVideoFrames = true
        videoOutput.setSampleBufferDelegate(self, queue: queue)
        if session.canAddOutput(videoOutput) { session.addOutput(videoOutput) }

        audioOutput.setSampleBufferDelegate(self, queue: queue)
        if session.canAddOutput(audioOutput) { session.addOutput(audioOutput) }

        if let connection = videoOutput.connection(with: .video),
           connection.isVideoRotationAngleSupported(0) {
            connection.videoRotationAngle = 0 // Querformat, Kamera links oben
        }
        session.commitConfiguration()

        let attributes: [String: Any] = [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
            kCVPixelBufferWidthKey as String: Int(VHSEffect.size.width),
            kCVPixelBufferHeightKey as String: Int(VHSEffect.size.height),
            kCVPixelBufferIOSurfacePropertiesKey as String: [String: Any](),
            kCVPixelBufferMetalCompatibilityKey as String: true
        ]
        CVPixelBufferPoolCreate(kCFAllocatorDefault, nil, attributes as CFDictionary, &pool)
    }

    // MARK: - Delegate

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        if output === videoOutput {
            handleVideo(sampleBuffer)
        } else {
            handleAudio(sampleBuffer)
        }
    }

    private func handleVideo(_ sampleBuffer: CMSampleBuffer) {
        guard let source = CMSampleBufferGetImageBuffer(sampleBuffer), let pool else { return }
        let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)

        let elapsed = CACurrentMediaTime() - glitchStart
        let glitch = CGFloat(max(0, 1 - elapsed / 0.6))
        let image = effect.apply(CIImage(cvPixelBuffer: source), date: Date(), showStamp: showDateStamp, glitch: glitch)

        var out: CVPixelBuffer?
        CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, pool, &out)
        guard let pixelBuffer = out else { return }
        ciContext.render(image, to: pixelBuffer, bounds: CGRect(origin: .zero, size: VHSEffect.size), colorSpace: colorSpace)

        if let writer {
            if !sessionStarted, writer.status == .unknown {
                if writer.startWriting() {
                    writer.startSession(atSourceTime: pts)
                    firstPTS = pts
                    sessionStarted = true
                }
            }
            if sessionStarted, writer.status == .writing, let videoInput, videoInput.isReadyForMoreMediaData {
                adaptor?.append(pixelBuffer, withPresentationTime: pts)
            }
        }

        display(pixelBuffer, pts: pts)
    }

    private func handleAudio(_ sampleBuffer: CMSampleBuffer) {
        guard sessionStarted, let writer, writer.status == .writing,
              let audioInput, audioInput.isReadyForMoreMediaData,
              CMSampleBufferGetPresentationTimeStamp(sampleBuffer) >= firstPTS else { return }
        audioInput.append(sampleBuffer)
    }

    private func display(_ pixelBuffer: CVPixelBuffer, pts: CMTime) {
        layerLock.lock()
        let layer = displayLayer
        layerLock.unlock()
        guard let layer else { return }

        var format: CMVideoFormatDescription?
        CMVideoFormatDescriptionCreateForImageBuffer(allocator: kCFAllocatorDefault, imageBuffer: pixelBuffer, formatDescriptionOut: &format)
        guard let format else { return }
        var timing = CMSampleTimingInfo(duration: .invalid, presentationTimeStamp: pts, decodeTimeStamp: .invalid)
        var sampleOut: CMSampleBuffer?
        CMSampleBufferCreateReadyWithImageBuffer(allocator: kCFAllocatorDefault, imageBuffer: pixelBuffer,
                                                 formatDescription: format, sampleTiming: &timing,
                                                 sampleBufferOut: &sampleOut)
        guard let sample = sampleOut else { return }
        if let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: true),
           CFArrayGetCount(attachments) > 0 {
            let dict = unsafeBitCast(CFArrayGetValueAtIndex(attachments, 0), to: CFMutableDictionary.self)
            CFDictionarySetValue(dict,
                                 Unmanaged.passUnretained(kCMSampleAttachmentKey_DisplayImmediately).toOpaque(),
                                 Unmanaged.passUnretained(kCFBooleanTrue).toOpaque())
        }
        let renderer = layer.sampleBufferRenderer
        if renderer.status == .failed { renderer.flush() }
        renderer.enqueue(sample)
    }
}
