import SwiftUI

@main
struct RetroCamApp: App {
    @StateObject private var store = TapeStore()

    var body: some Scene {
        WindowGroup {
            TapeListView()
                .environmentObject(store)
                .preferredColorScheme(.dark)
                .tint(.orange)
        }
    }
}
