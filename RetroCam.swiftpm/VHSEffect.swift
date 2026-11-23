import CoreImage
import CoreImage.CIFilterBuiltins
import UIKit

/// Macht aus einem Kamerabild ein VHS-Camcorder-Bild (640x480, 4:3).
/// Läuft komplett auf der GPU über Core Image.
final class VHSEffect {
    static let size = CGSize(width: 640, height: 480)
    private let rect = CGRect(origin: .zero, size: VHSEffect.size)

    private let scanlines: CIImage
    private let noiseSource: CIImage
    private var frame = 0
    private var stampCache: (key: String, image: CIImage)?

    private let timeFormatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "HH:mm:ss"
        return f
    }()

    private let dateFormatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "dd.MM.yyyy"
        return f
    }()

    init() {
        let stripes = CIFilter.stripesGenerator()
        stripes.color0 = CIColor(red: 0, green: 0, blue: 0, alpha: 0.16)
        stripes.color1 = CIColor(red: 0, green: 0, blue: 0, alpha: 0)
        stripes.width = 1
        stripes.sharpness = 1
        stripes.center = .zero
        let lines = stripes.outputImage ?? CIImage.empty()
        scanlines = lines
            .transformed(by: CGAffineTransform(rotationAngle: .pi / 2))
            .cropped(to: CGRect(origin: .zero, size: VHSEffect.size))
        noiseSource = CIFilter.randomGenerator().outputImage ?? CIImage.empty()
    }

    /// - Parameters:
    ///   - glitch: 0...1, starke Bildstörung (z. B. direkt beim Aufnahmestart, wie beim echten Camcorder).
    func apply(_ input: CIImage, date: Date, showStamp: Bool, glitch: CGFloat) -> CIImage {
        frame &+= 1
        var img = fit(input)

        // 1. Farben: kräftig, leicht warm, milchige Schwarzwerte
        let controls = CIFilter.colorControls()
        controls.inputImage = img
        controls.saturation = 1.3
        controls.contrast = 0.9
        controls.brightness = 0.01
        img = controls.outputImage ?? img

        let grade = CIFilter.colorMatrix()
        grade.inputImage = img
        grade.rVector = CIVector(x: 1.06, y: 0, z: 0, w: 0)
        grade.gVector = CIVector(x: 0, y: 1.0, z: 0, w: 0)
        grade.bVector = CIVector(x: 0, y: 0, z: 0.9, w: 0)
        grade.aVector = CIVector(x: 0, y: 0, z: 0, w: 1)
        grade.biasVector = CIVector(x: 0.04, y: 0.035, z: 0.055, w: 0)
        img = grade.outputImage ?? img

        // 2. Datum/Uhrzeit wird "ins Signal" gestempelt, bekommt also auch die Bandfehler ab
        if showStamp {
            img = stamp(for: date).composited(over: img)
        }

        // 3. Horizontale Unschärfe: Helligkeit leicht, Farbe stark verschmiert (Chroma-Bleeding)
        let clamped = img.clampedToExtent()
        let luma = motionBlur(clamped, radius: 1.6)
        let chroma = motionBlur(clamped, radius: 8)
        let blend = CIFilter.luminosityBlendMode()
        blend.inputImage = luma
        blend.backgroundImage = chroma
        img = (blend.outputImage ?? luma).cropped(to: rect)

        // VHS-typische Überschärfung (helle Kanten-Säume)
        let sharpen = CIFilter.unsharpMask()
        sharpen.inputImage = img.clampedToExtent()
        sharpen.radius = 2.5
        sharpen.intensity = 0.55
        img = (sharpen.outputImage ?? img).cropped(to: rect)

        // 4. Farbversatz (Rot nach rechts, Blau nach links)
        img = chromaticShift(img.clampedToExtent(), red: 2.5, blue: -1.5).cropped(to: rect)

        // 5. Bildzittern + Störung beim Aufnahmestart
        let jitterX = CGFloat.random(in: -0.6...0.6) + glitch * CGFloat.random(in: -14...14)
        let jitterY = glitch * glitch * CGFloat.random(in: -30...30)
        img = img.clampedToExtent()
            .transformed(by: CGAffineTransform(translationX: jitterX.rounded(), y: jitterY.rounded()))
            .cropped(to: rect)

        // 6. Langsam durchlaufendes Tracking-Band
        let t = Double(frame) / 30
        let bandHeight = 16 + glitch * 70
        let bandY = CGFloat((t * 21).truncatingRemainder(dividingBy: Double(rect.height + 240))) - 120
        let bandRect = CGRect(x: 0, y: bandY, width: rect.width, height: bandHeight).intersection(rect)
        if !bandRect.isNull && !bandRect.isEmpty {
            let shift = (2 + glitch * 28).rounded()
            let band = img.clampedToExtent()
                .transformed(by: CGAffineTransform(translationX: shift, y: 0))
                .cropped(to: bandRect)
            img = band.composited(over: img)
            img = noise(alpha: 0.12 + glitch * 0.4, in: bandRect).composited(over: img)
        }

        // 7. Kopfumschalt-Störung am unteren Bildrand
        let bottom = CGRect(x: 0, y: 0, width: rect.width, height: 7)
        let headSwitch = img.clampedToExtent()
            .transformed(by: CGAffineTransform(translationX: CGFloat.random(in: 8...22).rounded(), y: 0))
            .cropped(to: bottom)
        img = headSwitch.composited(over: img)
        img = noise(alpha: 0.4, in: bottom).composited(over: img)

        // 8. Rauschen über das ganze Bild
        img = noise(alpha: 0.07 + glitch * 0.35, in: rect).composited(over: img)

        // 9. Gelegentliche Dropouts (weiße Striche)
        if Int.random(in: 0..<30) == 0 || glitch > 0.3 {
            for _ in 0..<Int.random(in: 1...3) {
                let w = CGFloat.random(in: 15...140)
                let r = CGRect(x: CGFloat.random(in: 0...(rect.width - w)).rounded(),
                               y: CGFloat.random(in: 8...rect.height).rounded(),
                               width: w, height: 1)
                img = CIImage(color: CIColor(red: 1, green: 1, blue: 1, alpha: 0.65)).cropped(to: r).composited(over: img)
            }
        }

        // 10. Zeilenstruktur + Vignette
        img = scanlines.composited(over: img)
        let vignette = CIFilter.vignette()
        vignette.inputImage = img
        vignette.intensity = 0.7
        vignette.radius = 1.6
        img = vignette.outputImage ?? img

        return img.cropped(to: rect)
    }

    // MARK: - Helfer

    /// Skaliert auf 640x480 (füllend, mittig beschnitten).
    private func fit(_ image: CIImage) -> CIImage {
        let e = image.extent
        guard e.width > 0, e.height > 0 else { return image }
        let s = max(rect.width / e.width, rect.height / e.height)
        let w = e.width * s
        let h = e.height * s
        return image
            .transformed(by: CGAffineTransform(translationX: -e.minX, y: -e.minY))
            .transformed(by: CGAffineTransform(scaleX: s, y: s))
            .transformed(by: CGAffineTransform(translationX: -(w - rect.width) / 2, y: -(h - rect.height) / 2))
            .cropped(to: rect)
    }

    private func motionBlur(_ image: CIImage, radius: Float) -> CIImage {
        let f = CIFilter.motionBlur()
        f.inputImage = image
        f.radius = radius
        f.angle = 0
        return f.outputImage ?? image
    }

    private func channel(_ image: CIImage, r: CGFloat, g: CGFloat, b: CGFloat) -> CIImage {
        let m = CIFilter.colorMatrix()
        m.inputImage = image
        m.rVector = CIVector(x: r, y: 0, z: 0, w: 0)
        m.gVector = CIVector(x: 0, y: g, z: 0, w: 0)
        m.bVector = CIVector(x: 0, y: 0, z: b, w: 0)
        m.aVector = CIVector(x: 0, y: 0, z: 0, w: 1)
        m.biasVector = CIVector(x: 0, y: 0, z: 0, w: 0)
        return m.outputImage ?? image
    }

    private func add(_ a: CIImage, _ b: CIImage) -> CIImage {
        let f = CIFilter.additionCompositing()
        f.inputImage = a
        f.backgroundImage = b
        return f.outputImage ?? a
    }

    private func chromaticShift(_ image: CIImage, red: CGFloat, blue: CGFloat) -> CIImage {
        let r = channel(image, r: 1, g: 0, b: 0).transformed(by: CGAffineTransform(translationX: red, y: 0))
        let g = channel(image, r: 0, g: 1, b: 0)
        let b = channel(image, r: 0, g: 0, b: 1).transformed(by: CGAffineTransform(translationX: blue, y: 0))
        return add(add(r, g), b)
    }

    /// Graues, horizontal gestrecktes Rauschen mit gegebener Deckkraft.
    private func noise(alpha: CGFloat, in r: CGRect) -> CIImage {
        let ox = CGFloat.random(in: 0...4000).rounded()
        let oy = CGFloat.random(in: 0...4000).rounded()
        let n = noiseSource
            .transformed(by: CGAffineTransform(translationX: ox, y: oy))
            .transformed(by: CGAffineTransform(scaleX: 2, y: 1))
        let m = CIFilter.colorMatrix()
        m.inputImage = n
        m.rVector = CIVector(x: 1, y: 0, z: 0, w: 0)
        m.gVector = CIVector(x: 1, y: 0, z: 0, w: 0)
        m.bVector = CIVector(x: 1, y: 0, z: 0, w: 0)
        m.aVector = CIVector(x: 0, y: 0, z: 0, w: 0)
        m.biasVector = CIVector(x: 0, y: 0, z: 0, w: min(1, alpha))
        return (m.outputImage ?? n).cropped(to: r)
    }

    /// Camcorder-Datumsstempel unten rechts (wird pro Sekunde einmal neu gezeichnet).
    private func stamp(for date: Date) -> CIImage {
        let time = timeFormatter.string(from: date)
        let day = dateFormatter.string(from: date)
        let key = time + day
        if let cache = stampCache, cache.key == key { return cache.image }

        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = false
        let size = VHSEffect.size
        let renderer = UIGraphicsImageRenderer(size: size, format: format)
        let uiImage = renderer.image { _ in
            let font = UIFont(name: "Menlo-Bold", size: 27) ?? UIFont.monospacedSystemFont(ofSize: 27, weight: .bold)
            let paragraph = NSMutableParagraphStyle()
            paragraph.alignment = .right
            let shadow = NSShadow()
            shadow.shadowColor = UIColor.black.withAlphaComponent(0.85)
            shadow.shadowOffset = CGSize(width: 2, height: 2)
            shadow.shadowBlurRadius = 0
            let attributes: [NSAttributedString.Key: Any] = [
                .font: font,
                .foregroundColor: UIColor(red: 1.0, green: 0.97, blue: 0.88, alpha: 1),
                .paragraphStyle: paragraph,
                .shadow: shadow,
                .kern: 1.5
            ]
            let text = "\(time)\n\(day)" as NSString
            text.draw(in: CGRect(x: 0, y: size.height - 104, width: size.width - 36, height: 84), withAttributes: attributes)
        }
        let image = uiImage.cgImage.map { CIImage(cgImage: $0) } ?? CIImage.empty()
        stampCache = (key, image)
        return image
    }
}
