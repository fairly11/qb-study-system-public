import Foundation

/// A bounded foreground worker. Every create intent is committed before network I/O.
public final class NotionSyncWorker: @unchecked Sendable {
  private let store: IOSRecordStore
  private let configuration: NotionConfiguration
  private let transport: any NotionTransport
  private let now: @Sendable () -> Date
  private let maximumEvents: Int
  private let budget: TimeInterval
  public init(
    store: IOSRecordStore, configuration: NotionConfiguration, transport: any NotionTransport,
    maximumEvents: Int = 5, timeBudget: TimeInterval = 12,
    now: @escaping @Sendable () -> Date = { Date() }
  ) {
    self.store = store
    self.configuration = configuration
    self.transport = transport
    self.maximumEvents = min(20, max(1, maximumEvents))
    self.budget = min(300, max(1, timeBudget))
    self.now = now
  }
  public func runOnce() async -> SyncReport {
    var checked = 0
    var confirmed = 0
    var deferredReviewCode: String?
    do {
      guard let exclusion = try store.acquireSyncLock() else {
        return try report(checked: 0, confirmed: 0, code: "NOTION_WORKER_BUSY")
      }
      defer { withExtendedLifetime(exclusion) {} }
      try store.pinTarget(configuration.target)
      let start = now()
      if let cooldown = try store.state(
        target: configuration.target, kind: "worker", key: "cooldown"),
        cooldown.retryAt > start.timeIntervalSince1970
      {
        return try report(checked: 0, confirmed: 0, code: "NOTION_BACKOFF")
      }
      let bounded = DeadlineTransport(
        base: transport, deadline: start.addingTimeInterval(budget), now: now)
      let client = NotionClient(configuration: configuration, transport: bounded)
      var resolutions: [String: ReviewResolution] = [:]
      try await client.validateSchema()
      let attempts = try store.attempts()
      let pending = try attempts.filter {
        try store.eventStatus(eventID: $0.eventID, target: configuration.target)
          != "notion_confirmed"
      }
      // Cursor journal rotates even blocked records so an ambiguous event does not starve later answers.
      let offset = Int(
        try store.state(target: configuration.target, kind: "worker", key: "cursor")?.retryAt ?? 0)
      for index in 0..<min(maximumEvents, pending.count) {
        guard now().timeIntervalSince(start) < budget, !Task.isCancelled else { break }
        let record = pending[(offset + index) % pending.count]
        checked += 1
        try store.saveState(
          target: configuration.target, kind: "worker", key: "cursor", status: "cursor",
          retryAt: Double(offset + index + 1))
        let context: Data
        if let stored = try store.context(eventID: record.eventID) {
          context = stored
        } else {
          let resolution: ReviewResolution
          if let mode = record.route["manual_study_mode"] as? String {
            resolution = ReviewResolution(studyMode: mode)
          } else if record.route["entry_source"] as? String != "observed_navigation" {
            resolution = ReviewResolution(studyMode: record.route["classification_policy"] as? String == "normal_default_v1" ? "normal" : "unclassified")
          } else if let set = record.route["set_id"] as? String {
            do {
              if configuration.reviewParentPageID == nil {
                resolution = ReviewResolution(studyMode: "unclassified")
              } else if let cached = try cachedReview(set) {
                resolution = cached
              } else if let cached = resolutions[set] {
                resolution = cached
              } else {
                let mappings = try await VerifiedReviewSetResolver(
                  transport: bounded, parentPageID: configuration.reviewParentPageID,
                  checkpointStore: store
                ).loadVerifiedMappings()
                try cacheReviewMappings(mappings)
                resolution =
                  mappings[set].map { ReviewResolution(studyMode: "review", reviewPlanID: $0) }
                  ?? ReviewResolution(studyMode: "normal")
                resolutions[set] = resolution
              }
            } catch {
              // A set-specific access/proof failure leaves this context pending without
              // stopping unrelated answers. Rate limits and transport failures still
              // reach the worker-wide cooldown below.
              guard let code = deferredReviewFailureCode(error) else { throw error }
              deferredReviewCode = code
              continue
            }
          } else {
            resolution = ReviewResolution(studyMode: "normal", reviewPlanID: nil)
          }
          context = try contextData(eventID: record.eventID, resolution: resolution)
          try store.appendContext(eventID: record.eventID, data: context)
        }
        guard now().timeIntervalSince(start) < budget, !Task.isCancelled else { break }
        guard
          let question = try await ensure(
            kind: "question", key: record.questionKey, source: configuration.questionsDataSourceID,
            property: "問題キー", client: client,
            properties: [
              "問題番号": ["title": textItems(record.questionKey)], "問題キー": rich(record.questionKey),
            ], valid: { matchesQuestion($0, key: record.questionKey) })
        else { continue }
        guard now().timeIntervalSince(start) < budget, !Task.isCancelled else { break }
        let props = try attemptProperties(record, questionID: question.id, context: context)
        if try await ensure(
          kind: "attempt", key: record.eventID, source: configuration.attemptsDataSourceID,
          property: "イベントID", client: client, properties: props,
          valid: { matchesAttempt($0, record: record, questionID: question.id, context: context) })
          != nil
        {
          confirmed += 1
        }
      }
      try store.saveState(
        target: configuration.target, kind: "worker", key: "failures", status: "failures",
        retryAt: 0)
      return try report(checked: checked, confirmed: confirmed, code: deferredReviewCode)
    } catch {
      let code =
        (error as? RecordError)?.code ?? (error as? NotionFailure)?.code
        ?? "NOTION_SYNC_UNAVAILABLE"
      // Durable cooldown applies to app and extension and survives relaunch.
      if code == "NOTION_TIME_BUDGET" {
        return (try? report(checked: checked, confirmed: confirmed, code: code))
          ?? SyncReport(
            checked: checked, confirmed: confirmed, pending: 0, blocked: 0,
            code: "STORE_READ_FAILED")
      }
      let previousFailureCount = Int(
        (try? store.state(target: configuration.target, kind: "worker", key: "failures")?.retryAt)
          ?? 0)
      let failures = min(10, previousFailureCount + 1)
      try? store.saveState(
        target: configuration.target, kind: "worker", key: "failures", status: "failures",
        retryAt: Double(failures))
      let delay = min(300, 5 * pow(2, Double(failures)))
      let wait = max(delay, (error as? NotionFailure)?.retryAfter ?? 0)
      try? store.saveState(
        target: configuration.target, kind: "worker", key: "cooldown", status: "retry",
        retryAt: now().timeIntervalSince1970 + wait, code: code)
      return (try? report(checked: checked, confirmed: confirmed, code: code))
        ?? SyncReport(
          checked: checked, confirmed: confirmed, pending: 0, blocked: 0, code: "STORE_READ_FAILED")
    }
  }
  /// Preview only. Never writes an attempt or its immutable classification.
  public func previewStudyMode(routeJSON: Data) async throws -> ReviewResolution {
    let route = try object(validateRoute(routeJSON))
    if let mode = route["manual_study_mode"] as? String { return ReviewResolution(studyMode: mode) }
    guard let set = route["set_id"] as? String else {
      return ReviewResolution(studyMode: route["entry_source"] as? String == "observed_navigation"
        || route["classification_policy"] as? String == "normal_default_v1" ? "normal" : "unclassified")
    }
    guard let exclusion = try store.acquireSyncLock() else { return ReviewResolution(studyMode: "unclassified") }
    defer { withExtendedLifetime(exclusion) {} }
    if let cached = try cachedReview(set) { return cached }
    if let cooldown = try store.state(target: configuration.target, kind: "worker", key: "cooldown"),
      cooldown.retryAt > now().timeIntervalSince1970
    { return ReviewResolution(studyMode: "unclassified", lookupComplete: false) }
    let bounded = DeadlineTransport(base: transport, deadline: now().addingTimeInterval(budget), now: now)
    do {
      let mappings = try await VerifiedReviewSetResolver(
        transport: bounded, parentPageID: configuration.reviewParentPageID, checkpointStore: store
      ).loadVerifiedMappings()
      try cacheReviewMappings(mappings)
      return mappings[set].map { ReviewResolution(studyMode: "review", reviewPlanID: $0) }
        ?? ReviewResolution(studyMode: "normal")
    } catch {
      if let failure = error as? NotionFailure, failure.retryable,
        failure.code != "NOTION_TIME_BUDGET"
      {
        try? store.saveState(
          target: configuration.target, kind: "worker", key: "cooldown", status: "retry",
          retryAt: now().timeIntervalSince1970 + max(10, failure.retryAfter), code: failure.code)
      }
      return ReviewResolution(studyMode: "unclassified", lookupComplete: false)
    }
  }

  public func warmReviewCatalog() async -> ReviewCatalogReport {
    guard configuration.reviewParentPageID != nil else {
      return ReviewCatalogReport(verifiedSets: 0, code: "REVIEW_PARENT_UNCONFIGURED")
    }
    do {
      guard let exclusion = try store.acquireSyncLock() else {
        return ReviewCatalogReport(verifiedSets: 0, code: "NOTION_WORKER_BUSY")
      }
      defer { withExtendedLifetime(exclusion) {} }
      try store.pinTarget(configuration.target)
      if let cooldown = try store.state(
        target: configuration.target, kind: "worker", key: "cooldown"),
        cooldown.retryAt > now().timeIntervalSince1970
      {
        return ReviewCatalogReport(verifiedSets: 0, code: "NOTION_BACKOFF")
      }
      let bounded = DeadlineTransport(
        base: transport, deadline: now().addingTimeInterval(budget), now: now)
      let mappings = try await VerifiedReviewSetResolver(
        transport: bounded, parentPageID: configuration.reviewParentPageID, checkpointStore: store
      ).loadVerifiedMappings()
      try cacheReviewMappings(mappings)
      return ReviewCatalogReport(verifiedSets: mappings.count, code: nil)
    } catch {
      let code =
        (error as? RecordError)?.code ?? (error as? NotionFailure)?.code
        ?? "REVIEW_SET_LOOKUP_PENDING"
      // A missing or unshared optional parent must not pause unrelated answer delivery.
      // Retryable service failures still share their cooldown with the app and extension.
      if let failure = error as? NotionFailure, failure.retryable,
        failure.code != "NOTION_TIME_BUDGET"
      {
        try? store.saveState(
          target: configuration.target, kind: "worker", key: "cooldown", status: "retry",
          retryAt: now().timeIntervalSince1970 + max(10, failure.retryAfter), code: code)
      }
      return ReviewCatalogReport(verifiedSets: 0, code: code)
    }
  }
  private func deferredReviewFailureCode(_ error: Error) -> String? {
    if let failure = error as? NotionFailure, !failure.retryable,
      ["NOTION_FORBIDDEN", "NOTION_NOT_FOUND"].contains(failure.code)
    {
      return failure.code
    }
    if let failure = error as? RecordError,
      ["REVIEW_SET_LOOKUP_PENDING", "REVIEW_SET_CONFLICT", "REVIEW_PARENT_UNAVAILABLE"]
        .contains(failure.code)
    {
      return failure.code
    }
    return nil
  }
  private var reviewTarget: String {
    configuration.target + ":review:" + (configuration.reviewParentPageID ?? "unconfigured")
  }
  private func cachedReview(_ set: String) throws -> ReviewResolution? {
    guard let state = try store.state(target: reviewTarget, kind: "review_set", key: set) else {
      return nil
    }
    guard state.status == "confirmed", let plan = state.pageID else {
      throw RecordError("REVIEW_SET_CONFLICT")
    }
    return ReviewResolution(studyMode: "review", reviewPlanID: plan)
  }
  private func cacheReviewMappings(_ mappings: [String: String]) throws {
    for (set, plan) in mappings {
      if let state = try store.state(target: reviewTarget, kind: "review_set", key: set) {
        if state.status == "blocked" || state.pageID != plan {
          try store.saveState(
            target: reviewTarget, kind: "review_set", key: set, status: "blocked",
            code: "REVIEW_SET_CONFLICT")
          throw RecordError("REVIEW_SET_CONFLICT")
        }
        continue
      }
      try store.saveState(
        target: reviewTarget, kind: "review_set", key: set, status: "confirmed", pageID: plan)
    }
  }
  private func report(checked: Int, confirmed: Int, code: String?) throws -> SyncReport {
    let status = try store.status(target: configuration.target)
    return SyncReport(
      checked: checked, confirmed: confirmed, pending: status.pending, blocked: status.blocked,
      code: code)
  }
  private func save(
    _ kind: String, _ key: String, _ status: String, _ pageID: String? = nil, _ code: String? = nil,
    _ retry: Double = 0
  ) throws {
    try store.saveState(
      target: configuration.target, kind: kind, key: key, status: status, pageID: pageID,
      retryAt: retry, code: code)
  }
  private func ensure(
    kind: String, key: String, source: String, property: String, client: NotionClient,
    properties: [String: Any], valid: (NotionPage) -> Bool
  ) async throws -> NotionPage? {
    var pages = try await client.find(source: source, property: property, key: key)
    let previous = try store.state(target: configuration.target, kind: kind, key: key)
    if pages.isEmpty, let known = previous?.pageID {
      do { pages = [try await client.get(known, source: source)] } catch let failure
        as NotionFailure where failure.code == "NOTION_NOT_FOUND"
      {
        try save(kind, key, "blocked", known, "NOTION_REMOTE_MISSING")
        return nil
      }
    }
    if pages.isEmpty {
      if let previous {
        guard previous.status == "retry", previous.retryAt <= now().timeIntervalSince1970 else {
          return nil
        }
      }
      try save(kind, key, "creating", nil, "NOTION_CREATE_UNCONFIRMED")
      var createdID: String?
      do {
        let created = try await client.create(source: source, properties: properties)
        createdID = created.id
        try save(kind, key, "creating", created.id, "NOTION_CREATE_UNCONFIRMED")
        pages = [try await client.get(created.id, source: source)]
      } catch {
        // After successful POST, a failed GET must retain the creating state, including its page ID.
        if createdID == nil, let failure = error as? NotionFailure, !failure.ambiguous {
          try save(
            kind, key, failure.retryable ? "retry" : "blocked", nil, failure.code,
            now().timeIntervalSince1970 + max(10, failure.retryAfter))
        }
        throw error
      }
    }
    guard pages.count == 1, let page = pages.first, valid(page) else {
      try save(
        kind, key, "blocked", pages.first?.id,
        kind == "attempt" ? "NOTION_EVENT_CONFLICT" : "NOTION_QUESTION_CONFLICT")
      return nil
    }
    try save(kind, key, "confirmed", page.id)
    return page
  }
}

/// Cancels URLSession at the foreground budget. A timed-out create remains ambiguous and is reconciled later.
struct DeadlineTransport: NotionTransport {
  let base: any NotionTransport
  let deadline: Date
  let now: @Sendable () -> Date
  func request(method: String, path: String, body: Data?) async throws -> Data {
    let remaining = deadline.timeIntervalSince(now())
    guard remaining > 0, !Task.isCancelled else {
      throw NotionFailure(code: "NOTION_TIME_BUDGET", retryable: true)
    }
    return try await withThrowingTaskGroup(of: Data.self) { group in
      group.addTask { try await base.request(method: method, path: path, body: body) }
      group.addTask {
        try await Task.sleep(nanoseconds: UInt64(min(remaining, 300) * 1_000_000_000))
        throw NotionFailure(
          code: "NOTION_TIME_BUDGET", retryable: true,
          ambiguous: method == "POST" && path == "/pages")
      }
      defer { group.cancelAll() }
      guard let first = try await group.next() else {
        throw NotionFailure(code: "NOTION_TIME_BUDGET", retryable: true)
      }
      return first
    }
  }
}

public struct ReviewCatalogReport: Codable, Sendable {
  public let verifiedSets: Int
  public let code: String?
}
