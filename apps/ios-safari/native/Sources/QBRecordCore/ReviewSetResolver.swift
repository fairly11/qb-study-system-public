import CoreFoundation
import CryptoKit
import Foundation

public struct ReviewResolution: Equatable, Sendable {
  public let studyMode: String
  public let reviewPlanID: String?
  public let lookupComplete: Bool

  public init(studyMode: String, reviewPlanID: String? = nil, lookupComplete: Bool = true) {
    self.studyMode = studyMode
    self.reviewPlanID = reviewPlanID
    self.lookupComplete = lookupComplete
  }
}

/// Checkpoints contain only validated identifiers, title hashes and cursor metadata.
/// Implementations persist each version atomically; no Notion response/body is saved.
public protocol ReviewCatalogCheckpointStore: Sendable {
  func loadReviewCatalog(parentPageID: String) throws -> Data?
  func saveReviewCatalog(parentPageID: String, data: Data) throws
}

/// Reads the same published proof as the Mac collector, directly from Notion.
/// The caller supplies a set ID observed in a trusted QB navigation route, never
/// a name or a match against the questions. A failed/incomplete read is unknown.
/// No attempt is written or discarded by this reader.
public struct VerifiedReviewSetResolver: Sendable {
  private let transport: any NotionTransport
  private let parentPageID: String?
  private let checkpointStore: (any ReviewCatalogCheckpointStore)?

  public init(
    transport: any NotionTransport, parentPageID: String?,
    checkpointStore: (any ReviewCatalogCheckpointStore)? = nil
  ) {
    self.transport = transport
    self.parentPageID = parentPageID
    self.checkpointStore = checkpointStore
  }

  public func resolve(questionSetID: String) async -> ReviewResolution {
    guard reviewMatches(questionSetID, "^[A-Za-z0-9_-]{1,100}$"),
      reviewNormalizedID(parentPageID) != nil
    else {
      return ReviewResolution(studyMode: "unclassified")
    }
    do {
      let mappings = try await loadVerifiedMappings()
      if let planID = mappings[questionSetID] {
        return ReviewResolution(studyMode: "review", reviewPlanID: planID)
      }
      return ReviewResolution(studyMode: "normal")
    } catch {
      // Error payloads may contain credentials/upstream bodies. Expose none.
      return ReviewResolution(studyMode: "unclassified", lookupComplete: false)
    }
  }

  /// Returns mappings only after a complete traversal. A bounded foreground
  /// call can stop at any request; the next call resumes the saved proof index.
  /// A completed checkpoint is never reused as a negative result for a new set.
  public func loadVerifiedMappings() async throws -> [String: String] {
    guard let parent = reviewNormalizedID(parentPageID) else {
      throw RecordError("REVIEW_PARENT_UNAVAILABLE")
    }
    do {
      var reader = ReviewCatalogReader(transport: transport)
      return try await reader.load(parentID: parent, checkpointStore: checkpointStore)
    } catch is ReviewReadError {
      try? ReviewCheckpoint(version: 1, parentID: parent).save(store: checkpointStore)
      throw RecordError("REVIEW_SET_LOOKUP_PENDING")
    } catch is DecodingError {
      try? ReviewCheckpoint(version: 1, parentID: parent).save(store: checkpointStore)
      throw RecordError("REVIEW_SET_LOOKUP_PENDING")
    } catch let failure as NotionFailure { throw failure } catch let error as RecordError {
      throw error
    } catch { throw RecordError("REVIEW_SET_LOOKUP_PENDING") }
  }
}

private enum ReviewReadError: Error { case unavailable }
private struct ReviewBlock {
  let id: String
  let type: String
  let text: String
  let hasChildren: Bool
  let links: [String]
}

private struct ReviewPageReference: Codable, Equatable {
  let id: String
  let titleHash: String
}

/// No raw Notion text, question identifiers, credentials or page body is retained.
private struct ReviewCheckpoint: Codable {
  let version: Int
  let parentID: String
  var startedAt = Date().timeIntervalSince1970
  var pages: [ReviewPageReference] = []
  var blockIDs: [String] = []
  var cursor: String?
  var seenCursors: [String] = []
  var listingComplete = false
  var nextPage = 0
  var mappings: [String: String] = [:]
  var complete = false

  static func load(parentID: String, store: (any ReviewCatalogCheckpointStore)?) throws
    -> ReviewCheckpoint
  {
    guard let data = try store?.loadReviewCatalog(parentPageID: parentID) else {
      return ReviewCheckpoint(version: 1, parentID: parentID)
    }
    guard data.count <= 1_048_576 else { throw ReviewReadError.unavailable }
    let value = try JSONDecoder().decode(ReviewCheckpoint.self, from: data)
    try value.validate(parentID: parentID)
    return value.complete || Date().timeIntervalSince1970 - value.startedAt > 300
      ? ReviewCheckpoint(version: 1, parentID: parentID) : value
  }

  func save(store: (any ReviewCatalogCheckpointStore)?) throws {
    try validate(parentID: parentID)
    let data = try JSONEncoder().encode(self)
    guard data.count <= 1_048_576 else { throw ReviewReadError.unavailable }
    try store?.saveReviewCatalog(parentPageID: parentID, data: data)
  }

  private func validate(parentID expected: String) throws {
    guard version == 1, parentID == expected, reviewNormalizedID(parentID) == parentID,
      startedAt.isFinite, startedAt >= 0, startedAt <= Date().timeIntervalSince1970 + 60,
      pages.count <= 10_000, blockIDs.count <= 10_000, seenCursors.count <= 1_000,
      nextPage >= 0, nextPage <= pages.count, listingComplete || nextPage == 0,
      !complete || (listingComplete && nextPage == pages.count),
      !listingComplete || cursor == nil,
      Set(blockIDs).count == blockIDs.count, blockIDs.allSatisfy({ reviewNormalizedID($0) == $0 }),
      Set(pages.map(\.id)).count == pages.count,
      pages.allSatisfy({ blockIDs.contains($0.id) && reviewMatches($0.titleHash, "^[a-f0-9]{64}$") }
      ),
      Set(seenCursors).count == seenCursors.count, seenCursors.allSatisfy(validReviewCursor),
      cursor == nil || (validReviewCursor(cursor!) && seenCursors.contains(cursor!)),
      mappings.count <= pages.count,
      mappings.allSatisfy({
        reviewMatches($0.key, "^[A-Za-z0-9_-]{1,100}$") && reviewNormalizedID($0.value) == $0.value
      })
    else {
      throw ReviewReadError.unavailable
    }
  }
}

private func validReviewCursor(_ value: String) -> Bool {
  !value.isEmpty && value.utf8.count <= 2_000
    && !value.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 })
}
private func reviewHash(_ value: String) -> String {
  SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
}

private struct ReviewCatalogReader {
  let transport: any NotionTransport
  // Bounds make unsupported huge catalogs unknown, never a partial "normal".
  private var requestCount = 0
  private var byteCount = 0

  init(transport: any NotionTransport) { self.transport = transport }

  mutating func load(parentID: String, checkpointStore: (any ReviewCatalogCheckpointStore)?)
    async throws -> [String: String]
  {
    var checkpoint = try ReviewCheckpoint.load(parentID: parentID, store: checkpointStore)
    let parent = try await get("/pages/\(parentID)")
    try validatePage(parent, id: parentID)
    while !checkpoint.listingComplete {
      let batch = try await blockPage(parentID, cursor: checkpoint.cursor)
      for block in batch.blocks {
        guard !checkpoint.blockIDs.contains(block.id) else { throw ReviewReadError.unavailable }
        checkpoint.blockIDs.append(block.id)
        if block.type == "child_page" {
          checkpoint.pages.append(
            ReviewPageReference(id: block.id, titleHash: reviewHash(block.text)))
        }
      }
      if let next = batch.cursor {
        guard !checkpoint.seenCursors.contains(next) else { throw ReviewReadError.unavailable }
        checkpoint.seenCursors.append(next)
      }
      checkpoint.cursor = batch.cursor
      checkpoint.listingComplete = batch.cursor == nil
      try checkpoint.save(store: checkpointStore)
    }
    while checkpoint.nextPage < checkpoint.pages.count {
      if let mapping = try await proof(checkpoint.pages[checkpoint.nextPage], parentID: parentID) {
        if let prior = checkpoint.mappings[mapping.setID], prior != mapping.planID {
          throw ReviewReadError.unavailable
        }
        checkpoint.mappings[mapping.setID] = mapping.planID
      }
      checkpoint.nextPage += 1
      try checkpoint.save(store: checkpointStore)
    }
    // Re-list before allowing a nonmatch: a set may have been published
    // while earlier short activations were reading the saved page list.
    let current = try await blocks(parentID).filter { $0.type == "child_page" }
      .map { ReviewPageReference(id: $0.id, titleHash: reviewHash($0.text)) }
    guard current == checkpoint.pages, Date().timeIntervalSince1970 - checkpoint.startedAt <= 300
    else {
      try ReviewCheckpoint(version: 1, parentID: parentID).save(store: checkpointStore)
      throw ReviewReadError.unavailable
    }
    checkpoint.complete = true
    try checkpoint.save(store: checkpointStore)
    return checkpoint.mappings
  }

  private mutating func proof(_ reference: ReviewPageReference, parentID: String) async throws -> (
    setID: String, planID: String
  )? {
    let page = try await get("/pages/\(reference.id)")
    try validatePage(page, id: reference.id)
    guard let parentValue = page["parent"] as? [String: Any],
      parentValue["type"] as? String == "page_id",
      reviewNormalizedID(parentValue["page_id"] as? String) == parentID,
      let properties = page["properties"] as? [String: Any],
      let titleValue = properties["title"] as? [String: Any],
      titleValue["type"] as? String == "title"
    else {
      throw ReviewReadError.unavailable
    }
    let title = try richText(titleValue["title"]).text
    guard title.utf8.count <= 800, reviewHash(title) == reference.titleHash else {
      throw ReviewReadError.unavailable
    }
    let content = try await blocks(reference.id)
    guard let setID = try linkedSetID(content) else { return nil }
    let markers = content.filter { $0.text.hasPrefix("QB_REVIEW_PLAN_V1:") }
    let toggles = content.filter { $0.type == "toggle" && $0.text == "計画データ（照合用）" }
    guard markers.count == 1, markers[0].type == "paragraph", !markers[0].hasChildren,
      markers[0].links.isEmpty, toggles.count == 1, toggles[0].hasChildren,
      toggles[0].links.isEmpty
    else { throw ReviewReadError.unavailable }
    let parts = markers[0].text.split(separator: ":", omittingEmptySubsequences: false)
    guard parts.count == 3, let markerPlanID = reviewNormalizedID(String(parts[1])),
      reviewMatches(String(parts[1]), "^[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$"),
      reviewMatches(String(parts[2]), "^[a-fA-F0-9]{64}$")
    else { throw ReviewReadError.unavailable }
    let code = try await blocks(toggles[0].id)
    guard !code.isEmpty,
      code.allSatisfy({ $0.type == "code" && !$0.hasChildren && $0.links.isEmpty })
    else {
      throw ReviewReadError.unavailable
    }
    let canonical = code.map(\.text).joined()
    let data = Data(canonical.utf8)
    guard data.count <= 240_000,
      SHA256.hash(data: data).map({ String(format: "%02x", $0) }).joined()
        == String(parts[2]).lowercased(),
      let document = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else {
      throw ReviewReadError.unavailable
    }
    let identity = try planIdentity(document)
    guard identity.id == markerPlanID, title == "QB復習候補 \(identity.day)" else {
      throw ReviewReadError.unavailable
    }
    return (setID, identity.id)
  }

  private mutating func get(_ path: String) async throws -> [String: Any] {
    guard requestCount < 1_000 else { throw ReviewReadError.unavailable }
    requestCount += 1
    let data = try await transport.request(method: "GET", path: path, body: nil)
    byteCount += data.count
    guard data.count <= 2_000_000, byteCount <= 16_000_000,
      let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else {
      throw ReviewReadError.unavailable
    }
    return value
  }

  private mutating func blocks(_ id: String) async throws -> [ReviewBlock] {
    var result: [ReviewBlock] = []
    var ids = Set<String>()
    var cursors = Set<String>()
    var cursor: String?
    repeat {
      let batch = try await blockPage(id, cursor: cursor)
      for block in batch.blocks {
        guard ids.insert(block.id).inserted else { throw ReviewReadError.unavailable }
        result.append(block)
      }
      guard result.count <= 10_000 else { throw ReviewReadError.unavailable }
      if let next = batch.cursor, !cursors.insert(next).inserted {
        throw ReviewReadError.unavailable
      }
      cursor = batch.cursor
    } while cursor != nil
    return result
  }

  private mutating func blockPage(_ id: String, cursor: String?) async throws -> (
    blocks: [ReviewBlock], cursor: String?
  ) {
    var suffix = ""
    if let cursor {
      guard validReviewCursor(cursor),
        let encoded = cursor.addingPercentEncoding(withAllowedCharacters: .alphanumerics)
      else { throw ReviewReadError.unavailable }
      suffix = "&start_cursor=\(encoded)"
    }
    let list = try await get("/blocks/\(id)/children?page_size=100\(suffix)")
    guard list["object"] as? String == "list", let values = list["results"] as? [[String: Any]],
      values.count <= 100, let more = strictBool(list["has_more"])
    else { throw ReviewReadError.unavailable }
    var blocks: [ReviewBlock] = []
    var ids = Set<String>()
    for value in values {
      guard value["object"] as? String == "block",
        let blockID = reviewNormalizedID(value["id"] as? String),
        let type = value["type"] as? String, let children = strictBool(value["has_children"]),
        let archived = strictBool(value["archived"]), let trashed = strictBool(value["in_trash"]),
        let parent = value["parent"] as? [String: Any],
        let parentType = parent["type"] as? String, ["page_id", "block_id"].contains(parentType),
        reviewNormalizedID(parent[parentType] as? String) == id,
        ids.insert(blockID).inserted
      else { throw ReviewReadError.unavailable }
      if archived || trashed { continue }
      let body = value[type] as? [String: Any]
      var text = ""
      var links: [String] = []
      if type == "child_page" {
        guard let title = body?["title"] as? String, title.utf8.count <= 800 else {
          throw ReviewReadError.unavailable
        }
        text = title
      } else if ["paragraph", "toggle", "code"].contains(type) {
        let rich = try richText(body?["rich_text"])
        text = rich.text
        links = rich.links
      }
      blocks.append(
        ReviewBlock(id: blockID, type: type, text: text, hasChildren: children, links: links))
    }
    if more {
      guard let cursor = list["next_cursor"] as? String, validReviewCursor(cursor) else {
        throw ReviewReadError.unavailable
      }
      return (blocks, cursor)
    }
    guard list["next_cursor"] is NSNull else { throw ReviewReadError.unavailable }
    return (blocks, nil)
  }

}

private func validatePage(_ value: [String: Any], id: String) throws {
  guard value["object"] as? String == "page", reviewNormalizedID(value["id"] as? String) == id,
    strictBool(value["archived"]) == false, strictBool(value["in_trash"]) == false
  else {
    throw ReviewReadError.unavailable
  }
}

private func richText(_ value: Any?) throws -> (text: String, links: [String]) {
  guard let parts = value as? [[String: Any]] else { throw ReviewReadError.unavailable }
  var result = ""
  var links: [String] = []
  for part in parts {
    guard part["type"] as? String == "text", let text = part["text"] as? [String: Any],
      let content = text["content"] as? String
    else { throw ReviewReadError.unavailable }
    result += content
    if let linkValue = text["link"], !(linkValue is NSNull) {
      guard let link = linkValue as? [String: Any], let url = link["url"] as? String else {
        throw ReviewReadError.unavailable
      }
      links.append(url)
    }
    guard result.utf8.count <= 240_000 else { throw ReviewReadError.unavailable }
  }
  return (result, links)
}

private func linkedSetID(_ blocks: [ReviewBlock]) throws -> String? {
  let prefix = "QB問題セット: "
  let links = blocks.filter { $0.text.hasPrefix(prefix) }
  guard !links.isEmpty else { return nil }
  guard links.count == 1, links[0].type == "paragraph", !links[0].hasChildren else {
    throw ReviewReadError.unavailable
  }
  let url = String(links[0].text.dropFirst(prefix.count))
  let start = "https://qb.medilink-study.com/search?questionSetId="
  let end = "&operation=OR"
  guard links[0].links == [url], url.hasPrefix(start), url.hasSuffix(end) else {
    throw ReviewReadError.unavailable
  }
  let setID = String(url.dropFirst(start.count).dropLast(end.count))
  guard reviewMatches(setID, "^[A-Za-z0-9_-]{1,100}$") else { throw ReviewReadError.unavailable }
  return setID
}

private func planIdentity(_ value: [String: Any]) throws -> (id: String, day: String) {
  guard value["schema_version"] as? String == "review-plan-v2",
    let rawID = value["plan_id"] as? String,
    reviewMatches(rawID, "^[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$"),
    let id = reviewNormalizedID(rawID), let day = value["target_date"] as? String, validDay(day),
    value["timezone"] as? String == "Asia/Tokyo", validTimestamp(value["selection_at"]),
    validTimestamp(value["scheduled_at"]), let sourceHash = value["source_plan_sha256"] as? String,
    reviewMatches(sourceHash, "^[a-f0-9]{64}$"), let items = value["items"] as? [[String: Any]],
    !items.isEmpty, items.count <= 100
  else { throw ReviewReadError.unavailable }
  var seen = Set<String>()
  for (index, item) in items.enumerated() {
    guard let position = item["position"] as? NSNumber,
      CFGetTypeID(position) != CFBooleanGetTypeID(), position.doubleValue == Double(index + 1),
      let question = item["question_key"] as? String,
      reviewMatches(question, "^[0-9]{3}[A-Z][1-9][0-9]{0,2}$"),
      seen.insert(question).inserted
    else { throw ReviewReadError.unavailable }
  }
  return (id, day)
}

private func reviewNormalizedID(_ value: String?) -> String? {
  guard let value,
    reviewMatches(
      value, "^(?:[a-fA-F0-9]{32}|[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12})$")
  else { return nil }
  let raw = value.replacingOccurrences(of: "-", with: "").lowercased()
  guard reviewMatches(raw, "^[a-f0-9]{32}$"), value.count == 32 || value.count == 36,
    let id = UUID(
      uuidString: [
        String(raw.prefix(8)), String(raw.dropFirst(8).prefix(4)),
        String(raw.dropFirst(12).prefix(4)), String(raw.dropFirst(16).prefix(4)),
        String(raw.suffix(12)),
      ].joined(separator: "-"))
  else { return nil }
  return id.uuidString.lowercased()
}

private func reviewMatches(_ text: String, _ pattern: String) -> Bool {
  guard let range = text.range(of: pattern, options: .regularExpression) else { return false }
  return range == text.startIndex..<text.endIndex
}

private func strictBool(_ value: Any?) -> Bool? {
  guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else {
    return nil
  }
  return number.boolValue
}

private func validDay(_ text: String) -> Bool {
  guard reviewMatches(text, "^[0-9]{4}-[0-9]{2}-[0-9]{2}$") else { return false }
  let values = text.split(separator: "-").compactMap { Int($0) }
  guard values.count == 3, values[0] >= 1 else { return false }
  var calendar = Calendar(identifier: .gregorian)
  calendar.timeZone = TimeZone(secondsFromGMT: 0)!
  let components = DateComponents(year: values[0], month: values[1], day: values[2])
  guard let date = calendar.date(from: components) else { return false }
  let checked = calendar.dateComponents([.year, .month, .day], from: date)
  return checked.year == values[0] && checked.month == values[1] && checked.day == values[2]
}

private func validTimestamp(_ value: Any?) -> Bool {
  guard let text = value as? String,
    reviewMatches(
      text,
      "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]{1,3})?(?:Z|[+-][0-9]{2}:[0-9]{2})$"
    ),
    validDay(String(text.prefix(10)))
  else { return false }
  let timeFields = text.dropFirst(11).prefix(8).split(separator: ":").compactMap { Int($0) }
  guard timeFields.count == 3, timeFields[0] <= 23, timeFields[1] <= 59, timeFields[2] <= 59 else {
    return false
  }
  if !text.hasSuffix("Z") {
    let offset = text.suffix(5).split(separator: ":").compactMap { Int($0) }
    guard offset.count == 2, offset[0] <= 14, offset[1] <= 59,
      offset[0] != 14 || offset[1] == 0
    else { return false }
  }
  let formatter = ISO8601DateFormatter()
  formatter.formatOptions =
    text.contains(".") ? [.withInternetDateTime, .withFractionalSeconds] : [.withInternetDateTime]
  return formatter.date(from: text) != nil
}
