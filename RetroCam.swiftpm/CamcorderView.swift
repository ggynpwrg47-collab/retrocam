import SwiftUI
import UIKit

/// Der Camcorder: links der Bildschirm mit Bandzählwerk, rechts die Laufwerkstasten.
struct CamcorderView: View {
    @StateObject private var model: CamcorderModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @AppStorage("showDateStamp") private var showDate = true

    init(tape: Tape, store: TapeStore) {
        _model = StateObject(wrappedValue: CamcorderModel(tape: tape, store: store))
    }

    var body: some View {
        HStack(spacing: 14) {
            VStack(spacing: 8) {
                ScreenView(model: model)
                    .aspectRatio(4.0 / 3.0, contentMode: .fit)
                TapeBar(segments: model.tape.segments,
                        length: model.tape.length,
                        head: model.head,
                        recordingFrom: model.mode == .recording ? model.recordStartHead : nil,
                        enabled: model.mode != .recording && !model.busy,
                        onScrub: { model.scrub(to: $0) },
                        onScrubEnded: { model.scrubEnded() })
                    .frame(height: 24)
            }
            .frame(maxWidth: .infinity)

            ControlPanel(model: model, showDate: $showDate) {
                model.leave()
                dismiss()
            }
            .frame(width: 150)
        }
        .padding(10)
        .background(
            LinearGradient(colors: [Color(white: 0.13), Color(white: 0.07)], startPoint: .top, endPoint: .bottom)
                .ignoresSafeArea()
        )
        .statusBarHidden()
        .persistentSystemOverlays(.hidden)
        .onAppear { model.appear(showDate: showDate) }
        .onDisappear { model.leave() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .background { model.enteredBackground() }
        }
        .onChange(of: showDate) { _, value in
            CameraController.shared.setShowDateStamp(value)
        }
        .alert("Hinweis", isPresented: Binding(get: { model.errorMessage != nil },
                                               set: { if !$0 { model.errorMessage = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(model.errorMessage ?? "")
        }
    }
}

// MARK: - Bildschirm mit Einblendungen

struct ScreenView: View {
    @ObservedObject var model: CamcorderModel

    var body: some View {
        ZStack {
            Color.black
            CameraPreview()
                .opacity(model.showsCamera ? 1 : 0)
            PlayerLayerView(player: model.player)
                .opacity(model.showsCamera ? 0 : 1)
            if model.isShuttling { NoiseBars() }
            if model.showSnow { SnowView() }
            OSDView(model: model)
            if model.busy {
                ProgressView().tint(.white).scaleEffect(1.4)
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color(white: 0.28), lineWidth: 2))
    }
}

/// Camcorder-Einblendungen im Sucher (werden NICHT mit aufgenommen – nur Datum/Uhrzeit wird eingebrannt).
struct OSDView: View {
    @ObservedObject var model: CamcorderModel

    var body: some View {
        TimelineView(.periodic(from: .now, by: 0.5)) { context in
            let blink = Int(context.date.timeIntervalSinceReferenceDate * 2) % 2 == 0
            VStack(alignment: .leading) {
                HStack(alignment: .top) {
                    modeLabel(blink: blink)
                    Spacer()
                    Text(timecode(model.head))
                }
                Spacer()
                HStack(alignment: .bottom) {
                    VStack(alignment: .leading, spacing: 2) {
                        if model.isOverwriting {
                            Text("ÜBERSPIELEN").foregroundStyle(.yellow)
                        } else if model.mode == .standby && model.head < model.tape.length - 0.05 {
                            Text("REC = ÜBERSPIELEN").foregroundStyle(.yellow.opacity(0.85))
                        }
                        Text(model.tape.name.uppercased()).lineLimit(1)
                    }
                    Spacer()
                }
            }
            .font(.system(size: 17, weight: .bold, design: .monospaced))
            .foregroundStyle(.white)
            .shadow(color: .black, radius: 0, x: 2, y: 2)
            .padding(12)
        }
        .allowsHitTesting(false)
    }

    @ViewBuilder
    private func modeLabel(blink: Bool) -> some View {
        switch model.mode {
        case .standby:
            Text("STBY")
        case .recording:
            HStack(spacing: 6) {
                Circle().fill(Color.red).frame(width: 14, height: 14).opacity(blink ? 1 : 0)
                Text("REC").foregroundStyle(.red)
            }
        case .playing:
            Text("▶ PLAY")
        case .paused:
            Text("❚❚ PAUSE")
        case .rewinding:
            Text("◀◀ REW")
        case .forwarding:
            Text("▶▶ FF")
        }
    }
}

// MARK: - Bandanzeige (antippen/ziehen = an diese Stelle spulen)

struct TapeBar: View {
    let segments: [Segment]
    let length: Double
    let head: Double
    let recordingFrom: Double?
    let enabled: Bool
    let onScrub: (Double) -> Void
    let onScrubEnded: () -> Void

    var body: some View {
        GeometryReader { geo in
            let total = max(length, head, 10) * 1.08
            let width = geo.size.width
            let sorted = segments.sorted { $0.tapeStart < $1.tapeStart }
            ZStack(alignment: .leading) {
                Rectangle().fill(Color(white: 0.17))
                ForEach(Array(sorted.enumerated()), id: \.element.id) { index, segment in
                    Rectangle()
                        .fill(index % 2 == 0 ? Color(red: 0.82, green: 0.45, blue: 0.18) : Color(red: 0.96, green: 0.63, blue: 0.27))
                        .frame(width: max(1, width * segment.duration / total))
                        .offset(x: width * segment.tapeStart / total)
                }
                if let from = recordingFrom {
                    Rectangle()
                        .fill(Color.red)
                        .frame(width: max(1, width * (head - from) / total))
                        .offset(x: width * from / total)
                }
                Rectangle()
                    .fill(Color.white)
                    .frame(width: 3)
                    .offset(x: min(width - 3, width * head / total))
            }
            .clipShape(Capsule())
            .overlay(Capsule().stroke(Color(white: 0.3), lineWidth: 1))
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { value in
                        guard enabled, width > 0 else { return }
                        let t = Double(value.location.x / width) * total
                        onScrub(min(length, max(0, t)))
                    }
                    .onEnded { _ in
                        if enabled { onScrubEnded() }
                    }
            )
        }
    }
}

// MARK: - Laufwerkstasten

struct ControlPanel: View {
    @ObservedObject var model: CamcorderModel
    @Binding var showDate: Bool
    let onEject: () -> Void

    var body: some View {
        VStack(spacing: 8) {
            Button {
                click()
                onEject()
            } label: {
                Label("EJECT", systemImage: "eject.fill")
            }
            .buttonStyle(DeckButtonStyle(height: 34))

            Button {
                click(.heavy)
                model.recordButton()
            } label: {
                VStack(spacing: 4) {
                    Circle()
                        .fill(Color.red)
                        .frame(width: 30, height: 30)
                        .overlay(Circle().stroke(Color.white.opacity(0.7), lineWidth: model.mode == .recording ? 3 : 0))
                    Text(model.mode == .recording ? "STOP" : "REC")
                }
            }
            .buttonStyle(DeckButtonStyle(height: 76, highlighted: model.mode == .recording, highlightColor: .red))

            HStack(spacing: 8) {
                Button {
                    click()
                    model.rewindButton()
                } label: {
                    Image(systemName: "backward.fill")
                }
                .buttonStyle(DeckButtonStyle(height: 48, highlighted: model.mode == .rewinding))

                Button {
                    click()
                    model.forwardButton()
                } label: {
                    Image(systemName: "forward.fill")
                }
                .buttonStyle(DeckButtonStyle(height: 48, highlighted: model.mode == .forwarding))
            }

            HStack(spacing: 8) {
                Button {
                    click()
                    model.playButton()
                } label: {
                    Image(systemName: model.mode == .playing ? "pause.fill" : "play.fill")
                }
                .buttonStyle(DeckButtonStyle(height: 48, highlighted: model.mode == .playing || model.mode == .paused))

                Button {
                    click()
                    model.stopButton()
                } label: {
                    Image(systemName: "stop.fill")
                }
                .buttonStyle(DeckButtonStyle(height: 48))
            }

            Button {
                click(.light)
                showDate.toggle()
            } label: {
                Label("DATUM", systemImage: showDate ? "calendar.badge.checkmark" : "calendar")
            }
            .buttonStyle(DeckButtonStyle(height: 34, highlighted: showDate))
        }
        .font(.system(size: 13, weight: .bold, design: .monospaced))
        .disabled(model.busy)
    }

    private func click(_ style: UIImpactFeedbackGenerator.FeedbackStyle = .medium) {
        UIImpactFeedbackGenerator(style: style).impactOccurred()
    }
}

struct DeckButtonStyle: ButtonStyle {
    var height: CGFloat
    var highlighted = false
    var highlightColor: Color = .orange

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(highlighted ? highlightColor : Color(white: 0.86))
            .frame(maxWidth: .infinity, minHeight: height, maxHeight: height)
            .background(
                RoundedRectangle(cornerRadius: 8)
                    .fill(LinearGradient(colors: configuration.isPressed
                                         ? [Color(white: 0.13), Color(white: 0.19)]
                                         : [Color(white: 0.31), Color(white: 0.18)],
                                         startPoint: .top, endPoint: .bottom))
            )
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.black.opacity(0.7), lineWidth: 1))
            .scaleEffect(configuration.isPressed ? 0.96 : 1)
    }
}
