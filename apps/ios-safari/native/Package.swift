// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "QBRecordCore", platforms: [.iOS(.v16), .macOS(.v14)],
  products: [.library(name: "QBRecordCore", targets: ["QBRecordCore"])],
  targets: [
    .systemLibrary(name: "CSQLite"), .target(name: "QBRecordCore", dependencies: ["CSQLite"]),
    .testTarget(name: "QBRecordCoreTests", dependencies: ["QBRecordCore"]),
  ], swiftLanguageModes: [.v5])
