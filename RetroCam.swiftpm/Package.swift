// swift-tools-version: 5.9

// Diese Datei ist ein Xcode "App Playground".
// Öffnen: RetroCam.swiftpm doppelklicken (Xcode 15+ oder Swift Playgrounds auf Mac/iPad).

import PackageDescription
import AppleProductTypes

let package = Package(
    name: "RetroCam",
    platforms: [
        .iOS("17.0")
    ],
    products: [
        .iOSApplication(
            name: "RetroCam",
            targets: ["AppModule"],
            bundleIdentifier: "de.privat.retrocam",
            teamIdentifier: "",
            displayVersion: "1.0",
            bundleVersion: "1",
            appIcon: .placeholder(icon: .camera),
            accentColor: .presetColor(.orange),
            supportedDeviceFamilies: [
                .phone
            ],
            supportedInterfaceOrientations: [
                .landscapeRight
            ],
            capabilities: [
                .camera(purposeString: "RetroCam braucht die Kamera, um wie ein alter Camcorder zu filmen."),
                .microphone(purposeString: "RetroCam nimmt den Ton zu deinen Videos auf."),
                .photoLibraryAdd(purposeString: "RetroCam speichert fertige Kassetten als Video in deiner Fotomediathek.")
            ]
        )
    ],
    targets: [
        .executableTarget(
            name: "AppModule",
            path: "."
        )
    ]
)
