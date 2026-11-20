import Foundation
import QBRecordCore
import Security

/// Shared by the containing app and Safari's native extension. Never returns the token to JavaScript.
final class AppEnvironment: @unchecked Sendable {
  struct Settings: Codable, Equatable {
    let attemptsDataSourceID: String
    let questionsDataSourceID: String
    let reviewParentPageID: String?

    init(attempts: String, questions: String, reviewParent: String) throws {
      func identifier(_ value: String) throws -> String {
        guard let uuid = UUID(uuidString: value.trimmingCharacters(in: .whitespacesAndNewlines))
        else {
          throw RecordError("SETTINGS_ID_INVALID")
        }
        return uuid.uuidString.lowercased()
      }
      attemptsDataSourceID = try identifier(attempts)
      questionsDataSourceID = try identifier(questions)
      let parent = reviewParent.trimmingCharacters(in: .whitespacesAndNewlines)
      reviewParentPageID = parent.isEmpty ? nil : try identifier(parent)
      guard attemptsDataSourceID != questionsDataSourceID else {
        throw RecordError("SETTINGS_ID_INVALID")
      }
    }

    var native: NotionConfiguration {
      get throws {
        try NotionConfiguration(
          attemptsDataSourceID: attemptsDataSourceID,
          questionsDataSourceID: questionsDataSourceID,
          reviewParentPageID: reviewParentPageID)
      }
    }
  }

  let store: IOSRecordStore
  private let directory: URL
  private let accessGroup: String
  private var settingsURL: URL { directory.appendingPathComponent("notion-settings.json") }

  init() throws {
    guard let group = Bundle.main.object(forInfoDictionaryKey: "QBAppGroupIdentifier") as? String,
      group.hasPrefix("group."), !group.contains("$("),
      let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group)
    else {
      throw RecordError("APP_GROUP_UNAVAILABLE")
    }
    accessGroup = group
    directory = container.appendingPathComponent("QBRecords", isDirectory: true)
    try FileManager.default.createDirectory(
      at: directory, withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700])
    #if os(iOS)
      try FileManager.default.setAttributes(
        [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
        ofItemAtPath: directory.path)
    #endif
    var excluded = directory
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try excluded.setResourceValues(values)
    store = try IOSRecordStore(directory: directory)
  }

  func settings() throws -> Settings? {
    guard FileManager.default.fileExists(atPath: settingsURL.path) else { return nil }
    do { return try JSONDecoder().decode(Settings.self, from: Data(contentsOf: settingsURL)) } catch
    { throw RecordError("SETTINGS_UNREADABLE") }
  }

  private var keychainQuery: [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: "qb-study-ios-notion",
      kSecAttrAccount as String: "notion-token-v1",
      kSecAttrAccessGroup as String: accessGroup,
      kSecAttrSynchronizable as String: false,
    ]
  }

  private func token() throws -> String {
    var query = keychainQuery
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
      let data = result as? Data, let value = String(data: data, encoding: .utf8)
    else {
      throw RecordError("KEYCHAIN_UNAVAILABLE")
    }
    return value
  }

  /// Validates only the schema, then saves locally. This call never creates a Notion row.
  func save(settings candidate: Settings, token newToken: String) async throws {
    if let existing = try settings(),
      existing.attemptsDataSourceID != candidate.attemptsDataSourceID
        || existing.questionsDataSourceID != candidate.questionsDataSourceID
    {
      throw RecordError("SETTINGS_TARGET_LOCKED")
    }
    let provided = newToken.trimmingCharacters(in: .whitespacesAndNewlines)
    let clean = provided.isEmpty ? try token() : provided
    guard clean.count >= 16, clean.count <= 1024, !clean.contains(where: { $0.isWhitespace }) else {
      throw RecordError("TOKEN_FORMAT_INVALID")
    }
    let transport = try URLSessionNotionTransport(token: clean)
    let client = NotionClient(configuration: try candidate.native, transport: transport)
    try await client.validateSchema()
    var attributes = [String: Any]()
    attributes[kSecValueData as String] = Data(clean.utf8)
    attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    let updated = SecItemUpdate(keychainQuery as CFDictionary, attributes as CFDictionary)
    if updated == errSecItemNotFound {
      let inserted = SecItemAdd(
        keychainQuery.merging(attributes) { _, new in new } as CFDictionary, nil)
      guard inserted == errSecSuccess else { throw RecordError("KEYCHAIN_WRITE_FAILED") }
    } else if updated != errSecSuccess {
      throw RecordError("KEYCHAIN_WRITE_FAILED")
    }
    do {
      try JSONEncoder().encode(candidate).write(to: settingsURL, options: .atomic)
      try FileManager.default.setAttributes(
        [.posixPermissions: 0o600], ofItemAtPath: settingsURL.path)
    } catch { throw RecordError("SETTINGS_WRITE_FAILED") }
  }

  func sync(foreground: Bool = false) async throws -> SyncReport {
    guard let configuration = try settings() else { throw RecordError("NOTION_NOT_CONFIGURED") }
    let transport = try URLSessionNotionTransport(token: token())
    let worker = try NotionSyncWorker(
      store: store, configuration: configuration.native, transport: transport,
      maximumEvents: foreground ? 20 : 5, timeBudget: foreground ? 300 : 12)
    // runOnce resolves unknown sets from verified evidence without preloading the whole catalog.
    try Task.checkCancellation()
    return await worker.runOnce()
  }

  func previewStudyMode(routeJSON: Data) async throws -> ReviewResolution {
    guard let configuration = try settings() else { throw RecordError("NOTION_NOT_CONFIGURED") }
    let transport = try URLSessionNotionTransport(token: token())
    let worker = try NotionSyncWorker(store: store, configuration: configuration.native, transport: transport)
    return try await worker.previewStudyMode(routeJSON: routeJSON)
  }

  /// Preloads only read-verified set identities; never creates a Notion row.
  func warmReviewCatalog() async throws -> ReviewCatalogReport {
    guard let configuration = try settings() else { throw RecordError("NOTION_NOT_CONFIGURED") }
    let transport = try URLSessionNotionTransport(token: token())
    let worker = try NotionSyncWorker(
      store: store, configuration: configuration.native, transport: transport,
      maximumEvents: 1, timeBudget: 300)
    return await worker.warmReviewCatalog()
  }

  static func safeCode(_ error: Error) -> String {
    (error as? RecordError)?.code ?? (error as? NotionFailure)?.code ?? "OPERATION_UNAVAILABLE"
  }
}
