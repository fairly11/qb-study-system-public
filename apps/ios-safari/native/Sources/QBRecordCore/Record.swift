import CoreFoundation
import Foundation

/// Errors are deliberately safe codes only. Never retain an upstream body, URL or token.
public struct RecordError: Error, Equatable, Sendable, CustomStringConvertible {
  public let code: String
  public init(_ code: String) {
    self.code = matches(code, "^[A-Z][A-Z0-9_]{0,63}$") ? code : "RECORD_UNAVAILABLE"
  }
  public var description: String { code }
}
func matches(_ value: String, _ pattern: String) -> Bool {
  guard let found = value.range(of: pattern, options: .regularExpression) else { return false }
  return found == value.startIndex..<value.endIndex
}
func jsonBoolean(_ value: Any?) -> Bool? {
  guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else {
    return nil
  }
  return number.boolValue
}
func normalizedID(_ value: String) throws -> String {
  guard matches(value, "^[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$"),
    UUID(uuidString: value) != nil
  else { throw RecordError("INVALID_ID") }
  return value.lowercased()
}
func object(_ data: Data, maximum: Int = 65536) throws -> [String: Any] {
  guard data.count <= maximum,
    let result = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
  else { throw RecordError("INVALID_FORMAT") }
  return result
}
func canonical(_ value: Any) throws -> Data {
  try JSONSerialization.data(
    withJSONObject: value, options: [.sortedKeys, .withoutEscapingSlashes])
}
func exactKeys(_ value: [String: Any], required: Set<String>, optional: Set<String> = []) throws {
  guard required.isSubset(of: Set(value.keys)),
    Set(value.keys).isSubset(of: required.union(optional))
  else { throw RecordError("INVALID_FORMAT") }
}
func timestamp(_ value: Any?) throws -> String {
  guard let text = value as? String,
    matches(
      text,
      "^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]{1,3})?(?:Z|[+-](?:(?:0[0-9]|1[0-3]):[0-5][0-9]|14:00))$"
    )
  else { throw RecordError("INVALID_TIMESTAMP") }
  let parts = text.prefix(10).split(separator: "-").compactMap { Int($0) }
  var calendar = Calendar(identifier: .gregorian)
  calendar.timeZone = TimeZone(secondsFromGMT: 0)!
  guard parts.count == 3,
    let day = calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2])),
    calendar.component(.day, from: day) == parts[2]
  else { throw RecordError("INVALID_TIMESTAMP") }
  let formatter = ISO8601DateFormatter()
  formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  let padded =
    text.contains(".") ? text : String(text.prefix(19)) + ".000" + String(text.dropFirst(19))
  guard let date = formatter.date(from: padded) else { throw RecordError("INVALID_TIMESTAMP") }
  let result = formatter.string(from: date)
  guard matches(result, "^[0-9]{4}-[0-9]{2}-[0-9]{2}T.*Z$") else {
    throw RecordError("INVALID_TIMESTAMP")
  }
  return result
}
func safeIdentifier(_ value: Any?, max: Int) throws -> String {
  guard let value = value as? String, value.count <= max,
    matches(value, "^[A-Za-z0-9][A-Za-z0-9@._:/+%#=~-]*$")
  else { throw RecordError("INVALID_IDENTIFIER") }
  return value
}

public struct StoredAttempt: Sendable {
  public let eventID: String
  public let questionKey: String
  public let eventJSON: Data
  public let routeJSON: Data
  public let deviceID: String
  var event: [String: Any] { (try? object(eventJSON)) ?? [:] }
  var route: [String: Any] { (try? object(routeJSON)) ?? [:] }
}
func validateAttempt(_ input: Data) throws -> (String, String, Data) {
  var value = try object(input)
  try exactKeys(
    value,
    required: [
      "schema_version", "record_type", "provenance", "quality", "event_id", "question_key",
      "answered_at", "result", "selected_option_indices",
    ], optional: ["question_group_id"])
  guard value["schema_version"] as? String == "1",
    value["record_type"] as? String == "attempt_event", let id = value["event_id"] as? String,
    let question = value["question_key"] as? String,
    matches(question, "^[0-9]{3}[A-Z][1-9][0-9]{0,2}$"), let result = value["result"] as? String,
    ["correct", "incorrect", "unknown"].contains(result),
    var provenance = value["provenance"] as? [String: Any],
    let quality = value["quality"] as? [String: Any],
    let selected = value["selected_option_indices"] as? [NSNumber], !selected.isEmpty
  else { throw RecordError("INVALID_ATTEMPT") }
  _ = try normalizedID(id)
  try exactKeys(
    provenance, required: ["producer", "producer_version", "source_system", "recorded_at"],
    optional: ["source_record_id"])
  for key in ["producer", "producer_version", "source_system"] {
    _ = try safeIdentifier(provenance[key], max: 100)
  }
  for key in ["source_record_id"] where provenance[key] != nil {
    _ = try safeIdentifier(provenance[key], max: 255)
  }
  if value["question_group_id"] != nil {
    _ = try safeIdentifier(value["question_group_id"], max: 255)
  }
  try exactKeys(quality, required: ["acquisition_method", "temporal_precision", "state_precision"])
  guard quality["acquisition_method"] as? String == "direct_capture",
    quality["temporal_precision"] as? String == "exact",
    quality["state_precision"] as? String == "exact"
  else { throw RecordError("INVALID_ATTEMPT") }
  for index in selected {
    guard CFGetTypeID(index) != CFBooleanGetTypeID(),
      index.doubleValue.rounded() == index.doubleValue, index.doubleValue >= 1,
      index.doubleValue <= 9_007_199_254_740_991
    else { throw RecordError("INVALID_ATTEMPT") }
  }
  let numbers = selected.map { $0.int64Value }
  guard Set(numbers).count == numbers.count else { throw RecordError("INVALID_ATTEMPT") }
  value["selected_option_indices"] = numbers.sorted()
  value["answered_at"] = try timestamp(value["answered_at"])
  provenance["recorded_at"] = try timestamp(provenance["recorded_at"])
  value["provenance"] = provenance
  return (id, question, try canonical(value))
}
func validateRoute(_ input: Data) throws -> Data {
  let route = try object(input, maximum: 2048)
  try exactKeys(route, required: ["quiz_id", "entry_source"], optional: ["set_id", "classification_policy", "manual_study_mode"])
  guard let quiz = route["quiz_id"] as? String, matches(quiz, "^[A-Za-z0-9_-]{1,100}$"),
    let source = route["entry_source"] as? String,
    ["observed_navigation", "unresolved"].contains(source)
  else { throw RecordError("INVALID_ROUTE") }
  if let policy = route["classification_policy"] {
    guard policy as? String == "normal_default_v1" else { throw RecordError("INVALID_ROUTE") }
  }
  if let mode = route["manual_study_mode"] {
    guard let mode = mode as? String, ["normal", "review"].contains(mode)
    else { throw RecordError("INVALID_ROUTE") }
  }
  if let set = route["set_id"] {
    guard source == "observed_navigation", let set = set as? String,
      matches(set, "^[A-Za-z0-9_-]{1,100}$")
    else { throw RecordError("INVALID_ROUTE") }
  }
  return try canonical(route)
}
func contextData(eventID: String, resolution: ReviewResolution) throws -> Data {
  guard ["normal", "review", "unclassified"].contains(resolution.studyMode),
    resolution.reviewPlanID == nil || resolution.studyMode == "review"
  else { throw RecordError("STUDY_CONTEXT_CONFLICT") }
  var context: [String: Any] = [
    "schema_version": "1", "record_type": "study_context", "event_id": eventID,
    "study_mode": resolution.studyMode,
  ]
  if let plan = resolution.reviewPlanID { context["review_plan_id"] = try normalizedID(plan) }
  return try canonical(context)
}
public struct AppendReceipt: Codable, Sendable {
  public let eventID: String
  public let status: String
}
public struct RecordStatus: Codable, Sendable {
  public let saved: Int
  public let pending: Int
  public let confirmed: Int
  public let blocked: Int
}
public struct SyncReport: Codable, Sendable {
  public let checked: Int
  public let confirmed: Int
  public let pending: Int
  public let blocked: Int
  public let code: String?
}
