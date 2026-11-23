import AVFoundation
import SwiftUI

/// Das "Laufwerk": verwaltet Bandposition, Aufnahme und Wiedergabe einer Kassette.
@MainActor
final class CamcorderModel: ObservableObject {
    enum Mode: Equatable {
        case standby, recording, playing, paused, rewinding, forwarding
    }

    @Published private(set) var mode: Mode = .standby
    @Published private(set) var head: Double
    @Published private(set) var tape: Tape
    @Published private(set) var busy = false
    @Published private(set) var showSnow = false
    @Published private(set) var recordStartHead = 0.0
    @Published var errorMessage: String?

    let player = AVPlayer()

    private let store: TapeStore
    private let camera = CameraController.shared
    private let shuttleSpeed = 6.0
    private var dirty = true
    private var prepareTask: Task<Void, Never>?
    private var endObserver: NSObjectProtocol?
    private var timeObserver: Any?
    private var ticker: Timer?
    private var tick: (() -> Void)?
    private var recordStartTime = Date()
    private var pendingFileName: String?
    private var snowTask: Task<Void, Never>?
    private var hasLeft = false

    init(tape: Tape, store: TapeStore) {
        self.tape = tape
        self.store = store
        self.head = min(max(0, tape.head), tape.length)
        player.actionAtItemEnd = .pause
        timeObserver = player.addPeriodicTimeObserver(forInterval: CMTime(value: 1, timescale: 15), queue: .main) { [weak self] time in
            MainActor.assumeIsolated {
                guard let self, self.mode == .playing else { return }
                self.head = min(max(0, time.seconds), self.tape.length)
            }
        }
    }

    // MARK: - Abgeleitete Zustände für die Oberfläche

    var showsCamera: Bool { mode == .standby || mode == .recording }
    var isShuttling: Bool { mode == .rewinding || mode == .forwarding }
    var isOverwriting: Bool { mode == .recording && head < tape.length - 0.05 }

    // MARK: - Lebenszyklus

    func appear(showDate: Bool) {
        hasLeft = false
        camera.setShowDateStamp(showDate)
        Task {
            let video = await AVCaptureDevice.requestAccess(for: .video)
            _ = await AVCaptureDevice.requestAccess(for: .audio)
            if video {
                camera.start()
            } else {
                errorMessage = "Kein Kamerazugriff. Bitte in den Einstellungen → RetroCam erlauben."
            }
        }
    }

    func leave() {
        guard !hasLeft else { return }
        hasLeft = true
        if mode == .recording {
            stopRecording() // speichert selbst, wenn die Datei fertig ist
        } else {
            haltTransport()
            if !busy { store.updateHead(head, for: tape.id) }
        }
        player.pause()
        camera.stop()
    }

    func enteredBackground() {
        if mode == .recording { stopRecording() }
        haltTransport()
        if mode != .standby { mode = .paused }
    }

    // MARK: - Tasten

    func recordButton() {
        guard !busy else { return }
        if mode == .recording {
            stopRecording()
        } else {
            startRecording()
        }
    }

    func playButton() {
        guard !busy else { return }
        switch mode {
        case .recording:
            return
        case .playing:
            player.pause()
            mode = .paused
        case .paused, .rewinding, .forwarding:
            stopTicker()
            Task {
                await seek(to: head, precise: true)
                guard mode == .paused || isShuttling else { return }
                startPlayback()
            }
        case .standby:
            Task { await beginPlayback() }
        }
    }

    func stopButton() {
        guard !busy else { return }
        if mode == .recording {
            stopRecording()
            return
        }
        haltTransport()
        mode = .standby
        store.updateHead(head, for: tape.id)
    }

    func rewindButton() { shuttle(direction: -1) }
    func forwardButton() { shuttle(direction: 1) }

    /// Springt direkt an eine Bandstelle (Antippen/Ziehen am Bandzählwerk).
    func scrub(to time: Double) {
        guard !busy, mode != .recording, tape.length > 0.1 else { return }
        stopTicker()
        player.pause()
        head = min(max(0, time), tape.length)
        mode = .paused
        Task {
            await prepareIfNeeded()
            quickSeek(to: head)
        }
    }

    func scrubEnded() {
        guard mode == .paused else { return }
        Task { await seek(to: head, precise: true) }
    }

    // MARK: - Aufnahme

    private func startRecording() {
        haltTransport()
        let fileName = store.newSegmentFileName(for: tape)
        pendingFileName = fileName
        camera.startRecording(to: TapePaths.url(forFile: fileName))
        recordStartHead = head
        recordStartTime = Date()
        mode = .recording
        startTicker { [weak self] in
            guard let self else { return }
            self.head = self.recordStartHead + Date().timeIntervalSince(self.recordStartTime)
        }
    }

    private func stopRecording() {
        guard mode == .recording, let fileName = pendingFileName else { return }
        pendingFileName = nil
        busy = true
        stopTicker()
        mode = .standby
        let start = recordStartHead
        // Bewusst starke Referenz: die Aufnahme muss gespeichert werden, auch wenn die Ansicht schon zu ist.
        camera.stopRecording { url in
            Task { @MainActor in
                await self.finishRecording(fileName: fileName, start: start, url: url)
            }
        }
    }

    private func finishRecording(fileName: String, start: Double, url: URL?) async {
        defer { busy = false }
        guard let url else {
            head = start
            return
        }
        do {
            let asset = AVURLAsset(url: url)
            guard let track = try await asset.loadTracks(withMediaType: .video).first else {
                head = start
                return
            }
            let range = try await track.load(.timeRange)
            let segment = Segment(fileName: fileName,
                                  tapeStart: start,
                                  clipOffset: range.start.seconds,
                                  duration: range.duration.seconds)
            guard segment.duration > 0.1 else {
                try? FileManager.default.removeItem(at: url)
                head = start
                return
            }
            tape.record(segment)
            head = tape.head
            store.update(tape)
            dirty = true
        } catch {
            head = start
            errorMessage = "Die Aufnahme konnte nicht gespeichert werden."
        }
    }

    // MARK: - Wiedergabe

    private func beginPlayback() async {
        guard tape.length > 0.1, head < tape.length - 0.1 else {
            flashSnow() // Leeres Band: nur Schnee
            return
        }
        await prepareIfNeeded()
        await seek(to: head, precise: true)
        guard mode == .standby else { return }
        startPlayback()
    }

    private func startPlayback() {
        mode = .playing
        player.play()
    }

    private func shuttle(direction: Double) {
        guard !busy, mode != .recording else { return }
        let target: Mode = direction < 0 ? .rewinding : .forwarding
        if mode == target {
            stopTicker()
            mode = .paused
            Task { await seek(to: head, precise: true) }
            return
        }
        guard tape.length > 0.1 else {
            flashSnow()
            return
        }
        player.pause()
        stopTicker()
        mode = target
        Task {
            await prepareIfNeeded()
            guard mode == target else { return }
            startTicker { [weak self] in self?.shuttleStep(direction) }
        }
    }

    private func shuttleStep(_ direction: Double) {
        let next = head + direction * shuttleSpeed / 30
        if next <= 0 {
            head = 0
            stopTicker()
            mode = .paused
            Task { await seek(to: 0, precise: true) }
            return
        }
        if next >= tape.length {
            // Bandende erreicht: zurück zur Kamera, nächste Aufnahme hängt hinten an
            head = tape.length
            stopTicker()
            player.pause()
            mode = .standby
            flashSnow()
            store.updateHead(head, for: tape.id)
            return
        }
        head = next
        quickSeek(to: next)
    }

    private func reachedEnd() {
        guard mode == .playing else { return }
        head = tape.length
        mode = .standby
        flashSnow()
        store.updateHead(head, for: tape.id)
    }

    private func prepareIfNeeded() async {
        if !dirty, player.currentItem != nil { return }
        if let prepareTask {
            await prepareTask.value
            return
        }
        let task = Task { await buildItem() }
        prepareTask = task
        await task.value
        prepareTask = nil
    }

    private func buildItem() async {
        do {
            let composition = try await TapeComposer.composition(for: tape)
            let item = AVPlayerItem(asset: composition)
            player.replaceCurrentItem(with: item)
            if let endObserver { NotificationCenter.default.removeObserver(endObserver) }
            endObserver = NotificationCenter.default.addObserver(forName: AVPlayerItem.didPlayToEndTimeNotification,
                                                                 object: item, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.reachedEnd() }
            }
            dirty = false
        } catch {
            errorMessage = "Die Kassette konnte nicht geladen werden."
        }
    }

    private func seek(to time: Double, precise: Bool) async {
        await prepareIfNeeded()
        let t = CMTime(seconds: time, preferredTimescale: 600)
        let tolerance = precise ? CMTime.zero : CMTime(seconds: 0.2, preferredTimescale: 600)
        _ = await player.seek(to: t, toleranceBefore: tolerance, toleranceAfter: tolerance)
    }

    private func quickSeek(to time: Double) {
        player.currentItem?.cancelPendingSeeks()
        let tolerance = CMTime(seconds: 0.15, preferredTimescale: 600)
        player.seek(to: CMTime(seconds: time, preferredTimescale: 600),
                    toleranceBefore: tolerance, toleranceAfter: tolerance,
                    completionHandler: { _ in })
    }

    private func haltTransport() {
        stopTicker()
        player.pause()
    }

    private func flashSnow() {
        snowTask?.cancel()
        showSnow = true
        snowTask = Task {
            try? await Task.sleep(for: .seconds(1.2))
            guard !Task.isCancelled else { return }
            showSnow = false
        }
    }

    // MARK: - Takt (30 Hz) für Zählwerk und Spulen

    private func startTicker(_ block: @escaping () -> Void) {
        stopTicker()
        tick = block
        ticker = Timer.scheduledTimer(withTimeInterval: 1.0 / 30.0, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.tick?() }
        }
    }

    private func stopTicker() {
        ticker?.invalidate()
        ticker = nil
        tick = nil
    }
}
