import SwiftUI

/// Startbildschirm: alle Kassetten (Projekte).
struct TapeListView: View {
    @EnvironmentObject private var store: TapeStore
    @State private var activeTape: Tape?
    @State private var showNew = false
    @State private var newName = ""
    @State private var renaming: Tape?
    @State private var renameText = ""
    @State private var deleting: Tape?
    @State private var exportingID: UUID?
    @State private var message: String?

    var body: some View {
        NavigationStack {
            Group {
                if store.tapes.isEmpty {
                    ContentUnavailableView("Keine Kassetten",
                                           systemImage: "recordingtape",
                                           description: Text("Lege mit + eine neue Kassette an und fang an zu filmen."))
                } else {
                    List {
                        ForEach(store.tapes) { tape in
                            Button {
                                activeTape = tape
                            } label: {
                                TapeRow(tape: tape, exporting: exportingID == tape.id)
                            }
                            .swipeActions(edge: .trailing) {
                                Button(role: .destructive) { deleting = tape } label: { Label("Löschen", systemImage: "trash") }
                                Button { startRename(tape) } label: { Label("Umbenennen", systemImage: "pencil") }
                                    .tint(.orange)
                            }
                            .contextMenu {
                                Button { export(tape) } label: { Label("In Fotos speichern", systemImage: "square.and.arrow.down") }
                                Button { startRename(tape) } label: { Label("Umbenennen", systemImage: "pencil") }
                                Button(role: .destructive) { deleting = tape } label: { Label("Löschen", systemImage: "trash") }
                            }
                        }
                    }
                }
            }
            .navigationTitle("Kassetten")
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        newName = "Kassette \(store.tapes.count + 1)"
                        showNew = true
                    } label: {
                        Image(systemName: "plus")
                    }
                }
            }
            .alert("Neue Kassette", isPresented: $showNew) {
                TextField("Name", text: $newName)
                Button("Abbrechen", role: .cancel) {}
                Button("Einlegen") {
                    let tape = store.createTape(named: newName)
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { activeTape = tape }
                }
            }
            .alert("Umbenennen", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
                TextField("Name", text: $renameText)
                Button("Abbrechen", role: .cancel) {}
                Button("Sichern") {
                    if let tape = renaming { store.rename(tape, to: renameText) }
                }
            }
            .confirmationDialog("Kassette löschen?",
                                isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }),
                                titleVisibility: .visible) {
                Button("Löschen", role: .destructive) {
                    if let tape = deleting { store.delete(tape) }
                }
            } message: {
                Text("Alle Aufnahmen auf „\(deleting?.name ?? "")“ gehen verloren.")
            }
            .alert(message ?? "", isPresented: Binding(get: { message != nil }, set: { if !$0 { message = nil } })) {
                Button("OK", role: .cancel) {}
            }
        }
        .fullScreenCover(item: $activeTape) { tape in
            CamcorderView(tape: store.tape(withID: tape.id) ?? tape, store: store)
        }
    }

    private func startRename(_ tape: Tape) {
        renameText = tape.name
        renaming = tape
    }

    private func export(_ tape: Tape) {
        guard exportingID == nil else { return }
        exportingID = tape.id
        let current = store.tape(withID: tape.id) ?? tape
        Task {
            do {
                try await TapeComposer.exportToPhotos(current)
                message = "„\(current.name)“ wurde in Fotos gespeichert."
            } catch {
                message = "Export fehlgeschlagen: \(error.localizedDescription)"
            }
            exportingID = nil
        }
    }
}

struct TapeRow: View {
    let tape: Tape
    let exporting: Bool

    var body: some View {
        HStack(spacing: 14) {
            CassetteIcon()
                .frame(width: 64, height: 40)
            VStack(alignment: .leading, spacing: 3) {
                Text(tape.name)
                    .font(.system(.headline, design: .monospaced))
                    .foregroundStyle(.primary)
                Text("\(timecode(tape.length)) · \(tape.segments.count) \(tape.segments.count == 1 ? "Stück" : "Stücke")")
                    .font(.system(.subheadline, design: .monospaced))
                    .foregroundStyle(.secondary)
                Text(tape.updatedAt.formatted(date: .abbreviated, time: .shortened))
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
            Spacer()
            if exporting {
                ProgressView()
            } else {
                Image(systemName: "chevron.right").foregroundStyle(.tertiary)
            }
        }
        .padding(.vertical, 4)
    }
}

/// Kleine gezeichnete VHS-Kassette.
struct CassetteIcon: View {
    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 4).fill(Color(white: 0.12))
            RoundedRectangle(cornerRadius: 2)
                .fill(Color(red: 0.95, green: 0.6, blue: 0.25))
                .padding(.horizontal, 6)
                .padding(.top, 4)
                .padding(.bottom, 22)
            HStack(spacing: 14) {
                Circle().stroke(Color(white: 0.7), lineWidth: 2).frame(width: 12, height: 12)
                Circle().stroke(Color(white: 0.7), lineWidth: 2).frame(width: 12, height: 12)
            }
            .offset(y: 8)
        }
    }
}
