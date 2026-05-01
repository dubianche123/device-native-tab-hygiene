// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "SmartTabHygieneCompanion",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "SmartTabHygieneCompanion",
            path: "Sources",
            linkerSettings: [
                .linkedFramework("CreateML"),
                .linkedFramework("CoreML"),
                .linkedFramework("Foundation"),
                .linkedFramework("NaturalLanguage"),
            ]
        ),
    ]
)
