import Foundation

/// Speichert alle Kassetten (Projekte) als JSON + Videodateien im Dokumente-Ordner.
@MainActor
final class TapeStore: ObservableObject {
    @Published private(set) var tapes: [Tape] = []

    private var indexURL: URL { TapePaths.root.appendingPathComponent("tapes.json") }

    init() {
        load()
    }

    func tape(withID id: UUID) -> Tape? {
        tapes.first { $0.id == id }
    }

    func createTape(named name: String) -> Tape {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let tape = Tape(name: trimmed.isEmpty ? "Kassette \(tapes.count + 1)" : trimmed)
        try? FileManager.default.createDirectory(at: TapePaths.directory(for: tape.id), withIntermediateDirectories: true)
        tapes.insert(tape, at: 0)
        save()
        return tape
    }

    func rename(_ tape: Tape, to name: String) {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let i = tapes.firstIndex(where: { $0.id == tape.id }) else { return }
        tapes[i].name = trimmed
        save()
    }

    func delete(_ tape: Tape) {
        tapes.removeAll { $0.id == tape.id }
        try? FileManager.default.removeItem(at: TapePaths.directory(for: tape.id))
        save()
    }

    /// Übernimmt den Stand einer Kassette (z. B. nach einer Aufnahme) und räumt
    /// Videodateien weg, die komplett überschrieben wurden.
    func update(_ tape: Tape) {
        var t = tape
        t.updatedAt = Date()
        if let i = tapes.firstIndex(where: { $0.id == tape.id }) {
            t.name = tapes[i].name // Name kann in der Liste geändert worden sein
            tapes[i] = t
        } else {
            tapes.insert(t, at: 0)
        }
        save()
        cleanupFiles(for: t)
    }

    /// Nur die Bandposition sichern (ohne Dateien aufzuräumen).
    func updateHead(_ head: Double, for tapeID: UUID) {
        guard let i = tapes.firstIndex(where: { $0.id == tapeID }) else { return }
        tapes[i].head = head
        save()
    }

    func newSegmentFileName(for tape: Tape) -> String {
        try? FileManager.default.createDirectory(at: TapePaths.directory(for: tape.id), withIntermediateDirectories: true)
        return "\(tape.id.uuidString)/\(UUID().uuidString).mov"
    }

    // MARK: - Persistenz

    private func load() {
        guard let data = try? Data(contentsOf: indexURL),
              let decoded = try? JSONDecoder().decode([Tape].self, from: data) else { return }
        tapes = decoded
    }

    private func save() {
        guard let data = try? JSONEncoder().encode(tapes) else { return }
        try? data.write(to: indexURL, options: .atomic)
    }

    private func cleanupFiles(for tape: Tape) {
        let dir = TapePaths.directory(for: tape.id)
        let used = Set(tape.segments.map { ($0.fileName as NSString).lastPathComponent })
        guard let files = try? FileManager.default.contentsOfDirectory(atPath: dir.path) else { return }
        for file in files where !used.contains(file) {
            try? FileManager.default.removeItem(at: dir.appendingPathComponent(file))
        }
    }
}
