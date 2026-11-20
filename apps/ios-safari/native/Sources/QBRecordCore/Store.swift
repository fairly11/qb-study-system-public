import CSQLite
import Darwin
import Foundation

private let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
struct SyncState {
  let status: String
  let pageID: String?
  let retryAt: Double
  let code: String?
}
/// Owns one connection. A recursive lock serializes callers; SQLite handles app/extension processes.
public final class IOSRecordStore: ReviewCatalogCheckpointStore, @unchecked Sendable {
  private var db: OpaquePointer?
  private let mutex = NSRecursiveLock()
  public let directory: URL
  public init(directory: URL) throws {
    guard directory.isFileURL else { throw RecordError("STORE_PATH_INVALID") }
    self.directory = directory
    try FileManager.default.createDirectory(
      at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    #if os(iOS)
      try FileManager.default.setAttributes(
        [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
        ofItemAtPath: directory.path)
    #endif
    var excluded = directory
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try excluded.setResourceValues(values)
    let path = directory.appendingPathComponent("records.sqlite").path
    guard
      sqlite3_open_v2(
        path, &db, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, nil)
        == SQLITE_OK
    else { throw RecordError("STORE_OPEN_FAILED") }
    sqlite3_busy_timeout(db, 3000)
    do {
      try sql("PRAGMA journal_mode=WAL")
      try sql("PRAGMA synchronous=FULL")
      try sql("PRAGMA foreign_keys=ON")
      try sql("CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL)")
      try sql(
        "CREATE TABLE IF NOT EXISTS attempts(event_id TEXT PRIMARY KEY,question_key TEXT NOT NULL,event_json TEXT NOT NULL,route_json TEXT NOT NULL,device_id TEXT NOT NULL,created_at REAL NOT NULL)"
      )
      try sql(
        "CREATE TABLE IF NOT EXISTS contexts(event_id TEXT PRIMARY KEY REFERENCES attempts(event_id),context_json TEXT NOT NULL)"
      )
      try sql(
        "CREATE TABLE IF NOT EXISTS journal(sequence INTEGER PRIMARY KEY AUTOINCREMENT,target TEXT NOT NULL,kind TEXT NOT NULL,record_key TEXT NOT NULL,status TEXT NOT NULL,page_id TEXT,retry_at REAL NOT NULL DEFAULT 0,code TEXT)"
      )
      try sql(
        "CREATE TABLE IF NOT EXISTS review_checkpoints(sequence INTEGER PRIMARY KEY AUTOINCREMENT,parent_page_id TEXT NOT NULL,data TEXT NOT NULL)"
      )
      try sql(
        "CREATE INDEX IF NOT EXISTS review_checkpoint_lookup ON review_checkpoints(parent_page_id,sequence DESC)"
      )
      try sql(
        "CREATE INDEX IF NOT EXISTS journal_lookup ON journal(target,kind,record_key,sequence DESC)"
      )
      for table in ["attempts", "contexts", "journal", "metadata", "review_checkpoints"] {
        try sql(
          "CREATE TRIGGER IF NOT EXISTS immutable_\(table)_update BEFORE UPDATE ON \(table) BEGIN SELECT RAISE(ABORT,'IMMUTABLE'); END"
        )
        try sql(
          "CREATE TRIGGER IF NOT EXISTS immutable_\(table)_delete BEFORE DELETE ON \(table) BEGIN SELECT RAISE(ABORT,'IMMUTABLE'); END"
        )
      }
      try transaction {
        if try metadata("device_id") == nil {
          try sql("INSERT INTO metadata VALUES('device_id',?)", [UUID().uuidString.lowercased()])
        }
      }
      try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path)
    } catch {
      sqlite3_close(db)
      db = nil
      throw RecordError("STORE_SETUP_FAILED")
    }
  }
  deinit { if let db { sqlite3_close(db) } }
  private func sql(_ query: String, _ values: [String?] = []) throws {
    var statement: OpaquePointer?
    guard sqlite3_prepare_v2(db, query, -1, &statement, nil) == SQLITE_OK else {
      throw RecordError("STORE_WRITE_FAILED")
    }
    defer { sqlite3_finalize(statement) }
    try bind(statement, values)
    let code = sqlite3_step(statement)
    guard code == SQLITE_DONE || code == SQLITE_ROW else { throw RecordError("STORE_WRITE_FAILED") }
  }
  private func bind(_ statement: OpaquePointer?, _ values: [String?]) throws {
    for (index, value) in values.enumerated() {
      let code =
        value.map { sqlite3_bind_text(statement, Int32(index + 1), $0, -1, transient) }
        ?? sqlite3_bind_null(statement, Int32(index + 1))
      guard code == SQLITE_OK else { throw RecordError("STORE_WRITE_FAILED") }
    }
  }
  private func rows(_ query: String, _ values: [String?] = []) throws -> [[String?]] {
    var statement: OpaquePointer?
    guard sqlite3_prepare_v2(db, query, -1, &statement, nil) == SQLITE_OK else {
      throw RecordError("STORE_READ_FAILED")
    }
    defer { sqlite3_finalize(statement) }
    try bind(statement, values)
    var results: [[String?]] = []
    while true {
      let code = sqlite3_step(statement)
      if code == SQLITE_DONE { break }
      guard code == SQLITE_ROW else { throw RecordError("STORE_READ_FAILED") }
      results.append(
        (0..<sqlite3_column_count(statement)).map {
          sqlite3_column_text(statement, $0).map { String(cString: $0) }
        })
    }
    return results
  }
  private func transaction<T>(_ action: () throws -> T) throws -> T {
    mutex.lock()
    defer { mutex.unlock() }
    try sql("BEGIN IMMEDIATE")
    do {
      let result = try action()
      try sql("COMMIT")
      return result
    } catch {
      try? sql("ROLLBACK")
      throw error
    }
  }
  private func metadata(_ key: String) throws -> String? {
    try rows("SELECT value FROM metadata WHERE key=?", [key]).first?.first ?? nil
  }
  public func deviceID() throws -> String {
    mutex.lock()
    defer { mutex.unlock() }
    guard let id = try metadata("device_id") else { throw RecordError("STORE_READ_FAILED") }
    return id
  }
  @discardableResult public func append(eventJSON: Data, routeJSON: Data) throws -> AppendReceipt {
    let (_, _, validated) = try validateAttempt(eventJSON)
    let route = try validateRoute(routeJSON)
    var enriched = try object(validated)
    var provenance = enriched["provenance"] as! [String: Any]
    provenance["source_record_id"] =
      "ios:" + (try deviceID()) + ":" + (try object(route)["quiz_id"] as! String)
    enriched["provenance"] = provenance
    let (id, question, event) = try validateAttempt(canonical(enriched))
    return try transaction {
      if let prior = try rows("SELECT event_json,route_json FROM attempts WHERE event_id=?", [id])
        .first
      {
        guard prior[0] == String(data: event, encoding: .utf8),
          prior[1] == String(data: route, encoding: .utf8)
        else { throw RecordError("EVENT_ID_CONFLICT") }
      } else {
        try sql(
          "INSERT INTO attempts VALUES(?,?,?,?,?,?)",
          [
            id, question, String(data: event, encoding: .utf8),
            String(data: route, encoding: .utf8), try deviceID(),
            String(Date().timeIntervalSince1970),
          ])
      }
      return AppendReceipt(eventID: id, status: try eventStatus(eventID: id))
    }
  }
  public func status(target: String? = nil) throws -> RecordStatus {
    mutex.lock()
    defer { mutex.unlock() }
    let all = try attempts()
    let target = try target ?? metadata("target")
    var confirmed = 0
    var blocked = 0
    if let target {
      for item in all {
        let event = try state(target: target, kind: "attempt", key: item.eventID)
        let question = try state(target: target, kind: "question", key: item.questionKey)
        if event?.status == "confirmed" && question?.status == "confirmed" { confirmed += 1 }
        let eventBlocked = event?.status == "creating" || event?.status == "blocked"
        let questionBlocked = question?.status == "creating" || question?.status == "blocked"
        if eventBlocked || questionBlocked { blocked += 1 }
      }
    }
    return RecordStatus(
      saved: all.count, pending: all.count - confirmed, confirmed: confirmed, blocked: blocked)
  }
  public func eventStatus(eventID: String, target: String? = nil) throws -> String {
    mutex.lock()
    defer { mutex.unlock() }
    guard let row = try rows("SELECT question_key FROM attempts WHERE event_id=?", [eventID]).first,
      let question = row[0]
    else { return "unknown" }
    if let target = try target ?? metadata("target"),
      try state(target: target, kind: "attempt", key: eventID)?.status == "confirmed",
      try state(target: target, kind: "question", key: question)?.status == "confirmed"
    {
      return "notion_confirmed"
    }
    return "local_saved"
  }
  func attempts() throws -> [StoredAttempt] {
    mutex.lock()
    defer { mutex.unlock() }
    return try rows(
      "SELECT event_id,question_key,event_json,route_json,device_id FROM attempts ORDER BY rowid"
    ).map { row in
      guard row.count == 5, row.allSatisfy({ $0 != nil }) else {
        throw RecordError("STORE_READ_FAILED")
      }
      let payload = Data(row[2]!.utf8)
      let (eventID, question, validated) = try validateAttempt(payload)
      let route = try validateRoute(Data(row[3]!.utf8))
      guard eventID == row[0], question == row[1], validated == payload else {
        throw RecordError("STORE_RECORD_INVALID")
      }
      _ = try normalizedID(row[4]!)
      return StoredAttempt(
        eventID: eventID, questionKey: question, eventJSON: payload, routeJSON: route,
        deviceID: row[4]!)
    }
  }
  func pinTarget(_ target: String) throws {
    try transaction {
      if let existing = try metadata("target") {
        guard existing == target else { throw RecordError("NOTION_TARGET_CHANGED") }
      } else {
        try sql("INSERT INTO metadata VALUES('target',?)", [target])
      }
    }
  }
  func context(eventID: String) throws -> Data? {
    mutex.lock()
    defer { mutex.unlock() }
    return try rows("SELECT context_json FROM contexts WHERE event_id=?", [eventID]).first?.first
      .flatMap { $0 }.map { Data($0.utf8) }
  }
  func appendContext(eventID: String, data: Data) throws {
    try transaction {
      if let previous = try context(eventID: eventID) {
        guard previous == data else { throw RecordError("STUDY_CONTEXT_CONFLICT") }
      } else {
        try sql("INSERT INTO contexts VALUES(?,?)", [eventID, String(data: data, encoding: .utf8)])
      }
    }
  }
  func state(target: String, kind: String, key: String) throws -> SyncState? {
    mutex.lock()
    defer { mutex.unlock() }
    guard
      let row = try rows(
        "SELECT status,page_id,retry_at,code FROM journal WHERE target=? AND kind=? AND record_key=? ORDER BY sequence DESC LIMIT 1",
        [target, kind, key]
      ).first, let status = row[0], let retry = row[2].flatMap(Double.init)
    else { return nil }
    return SyncState(status: status, pageID: row[1], retryAt: retry, code: row[3])
  }
  func saveState(
    target: String, kind: String, key: String, status: String, pageID: String? = nil,
    retryAt: Double = 0, code: String? = nil
  ) throws {
    try transaction {
      try sql(
        "INSERT INTO journal(target,kind,record_key,status,page_id,retry_at,code) VALUES(?,?,?,?,?,?,?)",
        [target, kind, key, status, pageID, String(retryAt), code])
    }
  }
  public func loadReviewCatalog(parentPageID: String) throws -> Data? {
    mutex.lock()
    defer { mutex.unlock() }
    let parent = try normalizedID(parentPageID)
    return try rows(
      "SELECT data FROM review_checkpoints WHERE parent_page_id=? ORDER BY sequence DESC LIMIT 1",
      [parent]
    ).first?.first.flatMap { $0 }.map { Data($0.utf8) }
  }
  public func saveReviewCatalog(parentPageID: String, data: Data) throws {
    let parent = try normalizedID(parentPageID)
    guard data.count <= 1_048_576, let text = String(data: data, encoding: .utf8) else {
      throw RecordError("REVIEW_CHECKPOINT_INVALID")
    }
    try transaction {
      if try loadReviewCatalog(parentPageID: parent) != data {
        try sql("INSERT INTO review_checkpoints(parent_page_id,data) VALUES(?,?)", [parent, text])
      }
    }
  }
  /// An OS lock has no wall-clock expiry and is released by process death. A suspended owner cannot race a second writer.
  func acquireSyncLock() throws -> SyncFileLock? {
    try SyncFileLock(url: directory.appendingPathComponent("sync.lock"))
  }
}
final class SyncFileLock {
  private var fd: Int32
  init?(url: URL) throws {
    fd = Darwin.open(url.path, O_CREAT | O_RDWR | O_NOFOLLOW, 0o600)
    guard fd >= 0 else { throw RecordError("SYNC_LOCK_UNAVAILABLE") }
    guard flock(fd, LOCK_EX | LOCK_NB) == 0 else {
      let lockError = errno
      close(fd)
      fd = -1
      if lockError == EWOULDBLOCK { return nil }
      throw RecordError("SYNC_LOCK_UNAVAILABLE")
    }
  }
  deinit {
    if fd >= 0 {
      flock(fd, LOCK_UN)
      close(fd)
    }
  }
}
