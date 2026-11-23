import Foundation

/// Ein Stück Aufnahme auf dem Band. Verweist auf (einen Ausschnitt) einer Videodatei.
struct Segment: Codable, Identifiable, Hashable {
    var id = UUID()
    /// Pfad relativ zu `TapePaths.root`, z. B. "<tapeID>/<clipID>.mov"
    var fileName: String
    /// Position auf dem Band (Sekunden), an der dieses Stück beginnt.
    var tapeStart: Double
    /// Startzeit innerhalb der Videodatei (Sekunden).
    var clipOffset: Double
    /// Länge (Sekunden).
    var duration: Double

    var tapeEnd: Double { tapeStart + duration }
}

/// Eine Kassette = ein Projekt. Wie ein echtes Band: es gibt eine Kopfposition,
/// und eine neue Aufnahme überschreibt alles ab dieser Position für die Dauer der Aufnahme.
struct Tape: Codable, Identifiable, Hashable {
    var id = UUID()
    var name: String
    var createdAt = Date()
    var updatedAt = Date()
    var segments: [Segment] = []
    /// Aktuelle Bandposition (Sekunden). Hier geht die nächste Aufnahme los.
    var head: Double = 0

    /// Bespielte Länge des Bandes.
    var length: Double { segments.map(\.tapeEnd).max() ?? 0 }

    /// Fügt eine neue Aufnahme ein und überschreibt dabei, was im Bereich
    /// [tapeStart, tapeEnd) der neuen Aufnahme lag. Alles danach bleibt erhalten.
    mutating func record(_ new: Segment) {
        let start = new.tapeStart
        let end = new.tapeEnd
        let minPiece = 1.0 / 60.0
        var result: [Segment] = []

        for s in segments {
            // Komplett außerhalb -> bleibt unverändert
            if s.tapeEnd <= start || s.tapeStart >= end {
                result.append(s)
                continue
            }
            // Linker Rest (vor der neuen Aufnahme)
            if s.tapeStart < start {
                var left = s
                left.id = UUID()
                left.duration = start - s.tapeStart
                if left.duration >= minPiece { result.append(left) }
            }
            // Rechter Rest (nach der neuen Aufnahme)
            if s.tapeEnd > end {
                var right = s
                right.id = UUID()
                let cut = end - s.tapeStart
                right.tapeStart = end
                right.clipOffset = s.clipOffset + cut
                right.duration = s.tapeEnd - end
                if right.duration >= minPiece { result.append(right) }
            }
        }

        result.append(new)
        segments = result.sorted { $0.tapeStart < $1.tapeStart }
        head = end
    }
}

/// Dateipfade (bewusst außerhalb des MainActors, damit Export/Komposition sie nutzen können).
enum TapePaths {
    static let root: URL = {
        let url = URL.documentsDirectory.appendingPathComponent("Tapes", isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }()

    static func url(forFile name: String) -> URL {
        root.appendingPathComponent(name)
    }

    static func url(for segment: Segment) -> URL {
        url(forFile: segment.fileName)
    }

    static func directory(for tapeID: UUID) -> URL {
        root.appendingPathComponent(tapeID.uuidString, isDirectory: true)
    }
}

func timecode(_ seconds: Double) -> String {
    let t = max(0, Int(seconds.rounded(.down)))
    return String(format: "%d:%02d:%02d", t / 3600, (t / 60) % 60, t % 60)
}
