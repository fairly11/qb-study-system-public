import Foundation

public protocol NotionTransport: Sendable {
  func request(method: String, path: String, body: Data?) async throws -> Data
}
public struct NotionFailure: Error, Sendable {
  public let code: String
  public let retryable: Bool
  public let ambiguous: Bool
  public let retryAfter: TimeInterval
  public init(
    code: String, retryable: Bool = false, ambiguous: Bool = false, retryAfter: TimeInterval = 0
  ) {
    self.code = RecordError(code).code
    self.retryable = retryable
    self.ambiguous = ambiguous
    self.retryAfter = retryAfter
  }
}
private final class NoRedirect: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
  func urlSession(
    _ session: URLSession, task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
    completionHandler: @escaping (URLRequest?) -> Void
  ) { completionHandler(nil) }
}
/// Tokens remain inside native memory and Keychain; URLSession never follows credential redirects.
public final class URLSessionNotionTransport: NotionTransport, @unchecked Sendable {
  private let token: String
  private let session: URLSession
  private let redirect = NoRedirect()
  private let throttle = RequestThrottle()
  public init(token: String) throws {
    guard matches(token, "^[A-Za-z0-9_-]{20,512}$") else {
      throw RecordError("NOTION_TOKEN_INVALID")
    }
    self.token = token
    let config = URLSessionConfiguration.ephemeral
    config.timeoutIntervalForRequest = 8
    config.timeoutIntervalForResource = 10
    config.httpCookieStorage = nil
    config.urlCache = nil
    config.httpShouldSetCookies = false
    session = URLSession(configuration: config, delegate: redirect, delegateQueue: nil)
  }
  deinit { session.invalidateAndCancel() }
  public func request(method: String, path: String, body: Data?) async throws -> Data {
    guard ["GET", "POST"].contains(method), path.hasPrefix("/"), !path.contains(".."),
      !path.contains("#"), !path.contains("\\"),
      let url = URL(string: "https://api.notion.com/v1" + path), url.scheme == "https",
      url.host == "api.notion.com", url.user == nil, url.password == nil
    else { throw RecordError("NOTION_PATH_INVALID") }
    try await throttle.wait()
    let write = method == "POST" && path == "/pages"
    var request = URLRequest(url: url)
    request.httpMethod = method
    request.httpBody = body
    request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
    request.setValue("2025-09-03", forHTTPHeaderField: "Notion-Version")
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    do {
      let (bytes, response) = try await session.bytes(for: request)
      guard let response = response as? HTTPURLResponse else {
        throw NotionFailure(code: "NOTION_RESPONSE_INVALID", ambiguous: write)
      }
      guard response.url?.host == "api.notion.com", response.url?.scheme == "https" else {
        throw NotionFailure(code: "NOTION_REDIRECT_REJECTED", ambiguous: write)
      }
      let retry = Self.retryAfter(response.value(forHTTPHeaderField: "Retry-After"))
      guard (200..<300).contains(response.statusCode) else {
        if response.statusCode == 429 || response.statusCode == 529 {
          throw NotionFailure(code: "NOTION_RATE_LIMITED", retryable: true, retryAfter: retry)
        }
        if response.statusCode >= 500 || response.statusCode == 408 {
          throw NotionFailure(
            code: "NOTION_SERVICE_UNAVAILABLE", retryable: true, ambiguous: write, retryAfter: retry
          )
        }
        throw NotionFailure(
          code: response.statusCode == 401
            ? "NOTION_UNAUTHORIZED"
            : response.statusCode == 403
              ? "NOTION_FORBIDDEN"
              : response.statusCode == 404 ? "NOTION_NOT_FOUND" : "NOTION_REQUEST_REJECTED",
          ambiguous: (300..<400).contains(response.statusCode) && write)
      }
      guard response.expectedContentLength <= 2 * 1024 * 1024 else {
        throw NotionFailure(code: "NOTION_RESPONSE_TOO_LARGE", ambiguous: write)
      }
      var data = Data()
      for try await byte in bytes {
        data.append(byte)
        guard data.count <= 2 * 1024 * 1024 else {
          throw NotionFailure(code: "NOTION_RESPONSE_TOO_LARGE", ambiguous: write)
        }
      }
      guard (try? object(data, maximum: 2 * 1024 * 1024)) != nil else {
        throw NotionFailure(code: "NOTION_RESPONSE_INVALID", ambiguous: write)
      }
      return data
    } catch let failure as NotionFailure { throw failure } catch {
      throw NotionFailure(code: "NOTION_NETWORK_ERROR", retryable: true, ambiguous: write)
    }
  }
  static func retryAfter(_ raw: String?) -> TimeInterval {
    guard let raw else { return 0 }
    if let seconds = Double(raw), seconds.isFinite, seconds >= 0 {
      return min(seconds, 86400 * 365)
    }
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.timeZone = TimeZone(secondsFromGMT: 0)
    formatter.dateFormat = "EEE',' dd MMM yyyy HH':'mm':'ss z"
    return formatter.date(from: raw).map { max(0, $0.timeIntervalSinceNow) } ?? 0
  }
}
public struct NotionConfiguration: Sendable {
  public let attemptsDataSourceID: String
  public let questionsDataSourceID: String
  public let reviewParentPageID: String?
  public var target: String { "notion-v1:\(attemptsDataSourceID):\(questionsDataSourceID)" }
  public init(
    attemptsDataSourceID: String, questionsDataSourceID: String, reviewParentPageID: String? = nil
  ) throws {
    self.attemptsDataSourceID = try normalizedID(attemptsDataSourceID)
    self.questionsDataSourceID = try normalizedID(questionsDataSourceID)
    self.reviewParentPageID = try reviewParentPageID.map(normalizedID)
    guard self.attemptsDataSourceID != self.questionsDataSourceID else {
      throw RecordError("NOTION_CONFIG_INVALID")
    }
  }
}
struct NotionPage {
  let id: String
  let properties: [String: Any]
}
public final class NotionClient: @unchecked Sendable {
  let configuration: NotionConfiguration
  let transport: any NotionTransport
  public init(configuration: NotionConfiguration, transport: any NotionTransport) {
    self.configuration = configuration
    self.transport = transport
  }
  func request(_ method: String, _ path: String, _ body: [String: Any]? = nil) async throws
    -> [String: Any]
  {
    try object(
      await transport.request(method: method, path: path, body: body.map(canonical)),
      maximum: 2 * 1024 * 1024)
  }
  public func validateSchema() async throws {
    let attempt = try await schema(configuration.attemptsDataSourceID)
    let question = try await schema(configuration.questionsDataSourceID)
    let required = [
      "記録名": "title", "イベントID": "rich_text", "問題キー": "rich_text", "問題番号": "rich_text",
      "自分の解答": "rich_text", "判定": "select", "解答日時": "date", "学習日": "date", "取得日時": "date",
      "問題": "relation", "記録元": "select", "スキーマバージョン": "rich_text", "学習種別": "select",
      "記録データV1": "rich_text", "学習目的データV1": "rich_text",
    ]
    for (name, type) in required {
      guard let property = attempt[name] as? [String: Any], property["type"] as? String == type,
        property[type] is [String: Any]
      else { throw RecordError("NOTION_SCHEMA_MISMATCH") }
    }
    for (name, type) in ["問題番号": "title", "問題キー": "rich_text"] {
      guard let property = question[name] as? [String: Any], property["type"] as? String == type
      else { throw RecordError("NOTION_SCHEMA_MISMATCH") }
    }
    for (name, options) in [
      "判定": ["正解", "不正解", "未判定"], "記録元": ["Safari拡張"], "学習種別": ["通常学習", "復習", "未分類"],
    ] {
      guard let property = attempt[name] as? [String: Any],
        let select = property["select"] as? [String: Any],
        let values = select["options"] as? [[String: Any]],
        Set(options).isSubset(of: Set(values.compactMap { $0["name"] as? String }))
      else { throw RecordError("NOTION_SCHEMA_MISMATCH") }
    }
    guard let relationProperty = attempt["問題"] as? [String: Any],
      let relation = relationProperty["relation"] as? [String: Any],
      let id = relation["data_source_id"] as? String,
      try normalizedID(id) == configuration.questionsDataSourceID
    else { throw RecordError("NOTION_SCHEMA_MISMATCH") }
  }
  private func schema(_ id: String) async throws -> [String: Any] {
    let value = try await request("GET", "/data_sources/\(id)")
    guard value["object"] as? String == "data_source", let actual = value["id"] as? String,
      try normalizedID(actual) == id, value["archived"] as? Bool != true,
      value["in_trash"] as? Bool != true, let props = value["properties"] as? [String: Any]
    else { throw RecordError("NOTION_SCHEMA_MISMATCH") }
    return props
  }
  private func page(_ value: [String: Any], source: String) throws -> NotionPage {
    guard value["object"] as? String == "page", let id = value["id"] as? String,
      let parent = value["parent"] as? [String: Any], parent["type"] as? String == "data_source_id",
      let parentID = parent["data_source_id"] as? String, try normalizedID(parentID) == source,
      jsonBoolean(value["archived"]) == false, jsonBoolean(value["in_trash"]) == false,
      let properties = value["properties"] as? [String: Any]
    else { throw RecordError("NOTION_PAGE_MISMATCH") }
    return NotionPage(id: try normalizedID(id), properties: properties)
  }
  func get(_ id: String, source: String) async throws -> NotionPage {
    let wanted = try normalizedID(id)
    let found = try page(await request("GET", "/pages/\(wanted)"), source: source)
    guard found.id == wanted else { throw RecordError("NOTION_PAGE_MISMATCH") }
    return found
  }
  func find(source: String, property: String, key: String) async throws -> [NotionPage] {
    var result: [NotionPage] = []
    var cursor: String?
    var seen = Set<String>()
    for _ in 0..<10 {
      var body: [String: Any] = [
        "filter": ["property": property, "rich_text": ["equals": key]], "page_size": 100,
      ]
      if let cursor { body["start_cursor"] = cursor }
      let response = try await request("POST", "/data_sources/\(source)/query", body)
      guard response["object"] as? String == "list",
        let values = response["results"] as? [[String: Any]], values.count <= 100,
        let more = jsonBoolean(response["has_more"])
      else { throw RecordError("NOTION_RESPONSE_INVALID") }
      let batch = try values.map { try page($0, source: source) }
      guard batch.allSatisfy({ readText($0, property) == key }) else {
        throw RecordError("NOTION_PAGE_MISMATCH")
      }
      result += batch
      if !more {
        guard response["next_cursor"] is NSNull else {
          throw RecordError("NOTION_RESPONSE_INVALID")
        }
        return result
      }
      guard let next = response["next_cursor"] as? String, !next.isEmpty, next.utf8.count <= 1024,
        !next.unicodeScalars.contains(where: { $0.value < 32 }), seen.insert(next).inserted
      else { throw RecordError("NOTION_RESPONSE_INVALID") }
      cursor = next
    }
    throw RecordError("NOTION_QUERY_LIMIT")
  }
  func create(source: String, properties: [String: Any]) async throws -> NotionPage {
    // Any invalid create response is ambiguous: the server may have committed it.
    do {
      return try page(
        await request(
          "POST", "/pages",
          [
            "parent": ["type": "data_source_id", "data_source_id": source],
            "properties": properties,
          ]), source: source)
    } catch let failure as NotionFailure { throw failure } catch {
      throw NotionFailure(code: "NOTION_RESPONSE_INVALID", ambiguous: true)
    }
  }
}
func textItems(_ value: String) -> [[String: Any]] {
  var chunks: [[String: Any]] = []
  var start = value.startIndex
  while start < value.endIndex {
    let end = value.index(start, offsetBy: 1800, limitedBy: value.endIndex) ?? value.endIndex
    chunks.append(["type": "text", "text": ["content": String(value[start..<end])]])
    start = end
  }
  return chunks
}
func rich(_ text: String) -> [String: Any] { ["rich_text": textItems(text)] }
func readText(_ page: NotionPage, _ name: String, type: String = "rich_text") -> String? {
  guard let property = page.properties[name] as? [String: Any], property["type"] as? String == type,
    let items = property[type] as? [[String: Any]], items.count <= 100
  else { return nil }
  var text = ""
  for item in items {
    guard item["type"] as? String == "text", let value = item["text"] as? [String: Any],
      let content = value["content"] as? String, content.utf16.count <= 2000,
      item["plain_text"] == nil || item["plain_text"] as? String == content
    else { return nil }
    text += content
  }
  return text
}
func sourceLabel(_ event: [String: Any]) throws -> String {
  guard let provenance = event["provenance"] as? [String: Any],
    provenance["producer"] as? String == "browser-extension",
    provenance["source_system"] as? String == "qb-web-dom",
    let version = provenance["producer_version"] as? String,
    matches(version, "^ios-[0-9]+\\.[0-9]+\\.[0-9]+(?:[+-][A-Za-z0-9.-]+)?$"),
    let selected = event["selected_option_indices"] as? [Int],
    selected.allSatisfy({ (1...5).contains($0) })
  else { throw RecordError("NOTION_EVENT_UNSUPPORTED") }
  return "Safari拡張"
}
func minute(_ value: Any?) throws -> String { String(try timestamp(value).prefix(16)) + ":00.000Z" }
func tokyoDay(_ value: Any?) throws -> String {
  let normalized = try timestamp(value)
  let input = ISO8601DateFormatter()
  input.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  guard let date = input.date(from: normalized) else { throw RecordError("INVALID_TIMESTAMP") }
  let format = DateFormatter()
  format.calendar = Calendar(identifier: .gregorian)
  format.locale = Locale(identifier: "en_US_POSIX")
  format.timeZone = TimeZone(identifier: "Asia/Tokyo")
  format.dateFormat = "yyyy-MM-dd"
  return format.string(from: date)
}
func attemptProperties(_ record: StoredAttempt, questionID: String, context: Data) throws
  -> [String: Any]
{
  let event = record.event
  let provenance = event["provenance"] as! [String: Any]
  let selected = event["selected_option_indices"] as! [Int]
  let source = try sourceLabel(event)
  let mode = try object(context)["study_mode"] as? String ?? "unclassified"
  return [
    "記録名": ["title": textItems(record.questionKey + " " + (event["answered_at"] as! String))],
    "イベントID": rich(record.eventID), "問題キー": rich(record.questionKey),
    "問題番号": rich(record.questionKey),
    "自分の解答": rich(selected.map { String(UnicodeScalar(96 + $0)!) }.joined(separator: ",")),
    "判定": [
      "select": [
        "name": ["correct": "正解", "incorrect": "不正解", "unknown": "未判定"][event["result"] as! String]!
      ]
    ], "解答日時": ["date": ["start": try minute(event["answered_at"])]],
    "学習日": ["date": ["start": try tokyoDay(event["answered_at"])]],
    "取得日時": ["date": ["start": try minute(provenance["recorded_at"])]],
    "問題": ["relation": [["id": questionID]]], "記録元": ["select": ["name": source]],
    "スキーマバージョン": rich("1"),
    "学習種別": ["select": ["name": ["normal": "通常学習", "review": "復習", "unclassified": "未分類"][mode]!]],
    "記録データV1": rich(String(data: record.eventJSON, encoding: .utf8)!),
    "学習目的データV1": rich(String(data: context, encoding: .utf8)!),
  ]
}
func matchesQuestion(_ page: NotionPage, key: String) -> Bool {
  readText(page, "問題キー") == key && readText(page, "問題番号", type: "title") == key
}
func matchesAttempt(_ page: NotionPage, record: StoredAttempt, questionID: String, context: Data)
  -> Bool
{
  do {
    guard let stored = readText(page, "記録データV1"),
      try validateAttempt(Data(stored.utf8)).2 == record.eventJSON,
      let storedContext = readText(page, "学習目的データV1"),
      try canonical(object(Data(storedContext.utf8))) == context
    else { return false }
    let expected = try attemptProperties(record, questionID: questionID, context: context)
    for (name, raw) in expected {
      let desired = raw as! [String: Any]
      guard let actual = page.properties[name] as? [String: Any] else { return false }
      if let items = desired["rich_text"] as? [[String: Any]] {
        let text = items.compactMap { ($0["text"] as? [String: Any])?["content"] as? String }
          .joined()
        guard readText(page, name) == text else { return false }
      } else if let title = desired["title"] as? [[String: Any]] {
        let text = title.compactMap { ($0["text"] as? [String: Any])?["content"] as? String }
          .joined()
        guard readText(page, name, type: "title") == text else { return false }
      } else if let selected = desired["select"] as? [String: String] {
        guard actual["type"] as? String == "select",
          let select = actual["select"] as? [String: Any],
          select["name"] as? String == selected["name"]
        else { return false }
      } else if let date = desired["date"] as? [String: String] {
        guard actual["type"] as? String == "date", let saved = actual["date"] as? [String: Any],
          saved["end"] is NSNull, saved["time_zone"] is NSNull,
          let start = saved["start"] as? String
        else { return false }
        if name == "学習日" {
          guard start == date["start"] else { return false }
        } else {
          guard try timestamp(start) == date["start"] else { return false }
        }
      } else if desired["relation"] != nil {
        guard actual["type"] as? String == "relation", jsonBoolean(actual["has_more"]) == false,
          let relation = actual["relation"] as? [[String: Any]], relation.count == 1,
          let id = relation[0]["id"] as? String, try normalizedID(id) == questionID
        else { return false }
      }
    }
    return true
  } catch { return false }
}

private actor RequestThrottle {
  private var next = Date.distantPast
  func wait() async throws {
    let now = Date()
    let reserved = max(now, next)
    next = reserved.addingTimeInterval(0.5)
    let delay = reserved.timeIntervalSince(now)
    if delay > 0 { try await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000)) }
  }
}
