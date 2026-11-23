import AVFoundation
import Photos

/// Baut aus den Segmenten einer Kassette ein durchgehendes Video (zum Abspielen und Exportieren).
enum TapeComposer {
    enum ExportError: LocalizedError {
        case empty, failed, noPermission
        var errorDescription: String? {
            switch self {
            case .empty: return "Die Kassette ist noch leer."
            case .failed: return "Das Video konnte nicht erstellt werden."
            case .noPermission: return "Kein Zugriff auf die Fotomediathek."
            }
        }
    }

    static func composition(for tape: Tape) async throws -> AVMutableComposition {
        let comp = AVMutableComposition()
        guard let vTrack = comp.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid),
              let aTrack = comp.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid)
        else { return comp }

        let scale: CMTimeScale = 600
        var cursor = CMTime.zero

        for seg in tape.segments.sorted(by: { $0.tapeStart < $1.tapeStart }) {
            let asset = AVURLAsset(url: TapePaths.url(for: seg))
            var at = CMTime(seconds: seg.tapeStart, preferredTimescale: scale)
            var start = CMTime(seconds: seg.clipOffset, preferredTimescale: scale)
            var duration = CMTime(seconds: seg.duration, preferredTimescale: scale)

            // Rundungs-Überlappungen abschneiden
            if at < cursor {
                let skip = cursor - at
                start = start + skip
                duration = duration - skip
                at = cursor
            }
            guard duration > .zero else { continue }

            guard let srcVideo = try await asset.loadTracks(withMediaType: .video).first else { continue }
            let videoRange = try await srcVideo.load(.timeRange)
            let range = CMTimeRange(start: start, duration: duration).intersection(videoRange)
            guard range.duration > .zero else { continue }

            pad(vTrack, to: at)
            try vTrack.insertTimeRange(range, of: srcVideo, at: at)

            if let srcAudio = try await asset.loadTracks(withMediaType: .audio).first {
                let audioRange = try await srcAudio.load(.timeRange)
                let ar = range.intersection(audioRange)
                if ar.duration > .zero {
                    let audioAt = at + (ar.start - range.start)
                    pad(aTrack, to: audioAt)
                    try aTrack.insertTimeRange(ar, of: srcAudio, at: audioAt)
                }
            }
            cursor = at + range.duration
        }

        if aTrack.segments.isEmpty {
            comp.removeTrack(aTrack)
        }
        return comp
    }

    /// Füllt eine Spur bis `time` mit Leerlauf auf (falls dort eine Lücke ist).
    private static func pad(_ track: AVMutableCompositionTrack, to time: CMTime) {
        let end = track.segments.isEmpty ? CMTime.zero : track.timeRange.end
        if end < time {
            track.insertEmptyTimeRange(CMTimeRange(start: end, end: time))
        }
    }

    /// Exportiert die ganze Kassette als ein Video in die Fotomediathek.
    static func exportToPhotos(_ tape: Tape) async throws {
        guard tape.length > 0.1 else { throw ExportError.empty }
        let comp = try await composition(for: tape)
        guard let session = AVAssetExportSession(asset: comp, presetName: AVAssetExportPresetHighestQuality) else {
            throw ExportError.failed
        }
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("RetroCam-\(UUID().uuidString).mov")
        session.outputURL = url
        session.outputFileType = .mov
        await session.export()
        guard session.status == .completed else { throw session.error ?? ExportError.failed }
        defer { try? FileManager.default.removeItem(at: url) }

        let status = await PHPhotoLibrary.requestAuthorization(for: .addOnly)
        guard status == .authorized || status == .limited else { throw ExportError.noPermission }
        try await PHPhotoLibrary.shared().performChanges {
            _ = PHAssetChangeRequest.creationRequestForAssetFromVideo(atFileURL: url)
        }
    }
}
