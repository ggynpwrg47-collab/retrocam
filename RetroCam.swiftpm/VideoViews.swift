import AVFoundation
import SwiftUI
import UIKit

// MARK: - Live-Sucher (zeigt die bereits VHS-bearbeiteten Kamerabilder)

final class PreviewUIView: UIView {
    override class var layerClass: AnyClass { AVSampleBufferDisplayLayer.self }
    var displayLayer: AVSampleBufferDisplayLayer { layer as! AVSampleBufferDisplayLayer }
}

struct CameraPreview: UIViewRepresentable {
    func makeUIView(context: Context) -> PreviewUIView {
        let view = PreviewUIView()
        view.backgroundColor = .black
        view.displayLayer.videoGravity = .resizeAspect
        CameraController.shared.attach(view.displayLayer)
        return view
    }

    func updateUIView(_ uiView: PreviewUIView, context: Context) {}
}

// MARK: - Wiedergabe

final class PlayerUIView: UIView {
    override class var layerClass: AnyClass { AVPlayerLayer.self }
    var playerLayer: AVPlayerLayer { layer as! AVPlayerLayer }
}

struct PlayerLayerView: UIViewRepresentable {
    let player: AVPlayer

    func makeUIView(context: Context) -> PlayerUIView {
        let view = PlayerUIView()
        view.backgroundColor = .black
        view.playerLayer.player = player
        view.playerLayer.videoGravity = .resizeAspect
        return view
    }

    func updateUIView(_ uiView: PlayerUIView, context: Context) {}
}

// MARK: - Bildrauschen ("Schnee")

enum NoiseFactory {
    static let frames: [UIImage] = (0..<8).map { _ in make(width: 160, height: 120) }

    static func make(width: Int, height: Int) -> UIImage {
        var bytes = [UInt8](repeating: 0, count: width * height)
        for i in bytes.indices { bytes[i] = UInt8.random(in: 0...255) }
        guard let provider = CGDataProvider(data: Data(bytes) as CFData),
              let image = CGImage(width: width, height: height,
                                  bitsPerComponent: 8, bitsPerPixel: 8, bytesPerRow: width,
                                  space: CGColorSpaceCreateDeviceGray(),
                                  bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.none.rawValue),
                                  provider: provider, decode: nil, shouldInterpolate: false,
                                  intent: .defaultIntent)
        else { return UIImage() }
        return UIImage(cgImage: image)
    }
}

/// Vollbild-Schnee (leeres Band / Bandende).
struct SnowView: View {
    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 24.0)) { context in
            let i = Int(context.date.timeIntervalSinceReferenceDate * 24) % NoiseFactory.frames.count
            Image(uiImage: NoiseFactory.frames[i])
                .resizable()
                .interpolation(.none)
        }
        .allowsHitTesting(false)
    }
}

/// Durchlaufende Störbalken beim Vor- und Zurückspulen.
struct NoiseBars: View {
    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30.0)) { context in
            let t = context.date.timeIntervalSinceReferenceDate
            GeometryReader { geo in
                ZStack(alignment: .top) {
                    ForEach(0..<3, id: \.self) { k in
                        let speed = 0.45 + Double(k) * 0.21
                        let phase = (t * speed + Double(k) * 0.37).truncatingRemainder(dividingBy: 1)
                        let y = phase * Double(geo.size.height + 80) - 40
                        Image(uiImage: NoiseFactory.frames[(Int(t * 30) + k) % NoiseFactory.frames.count])
                            .resizable()
                            .interpolation(.none)
                            .frame(width: geo.size.width, height: 12 + CGFloat(k) * 9)
                            .opacity(0.85)
                            .offset(y: CGFloat(y))
                    }
                }
                .frame(width: geo.size.width, height: geo.size.height, alignment: .top)
            }
        }
        .allowsHitTesting(false)
    }
}
