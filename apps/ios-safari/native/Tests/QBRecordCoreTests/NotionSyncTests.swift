import Foundation
import Testing

@testable import QBRecordCore

let attemptsID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
let questionsID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
let questionPageID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
let attemptPageID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
let reviewParentID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
func testConfiguration() throws -> NotionConfiguration {
  try NotionConfiguration(attemptsDataSourceID: attemptsID, questionsDataSourceID: questionsID)
}
func responseProperties(_ value: [String: Any]) -> [String: Any] {
  var result: [String: Any] = [:]
  for (name, raw) in value {
    var property = raw as! [String: Any]
    let type = property.keys.first!
    property["type"] = type
    if type == "date" {
      var date = property["date"] as! [String: Any]
      date["end"] = NSNull()
      date["time_zone"] = NSNull()
      property["date"] = date
    }
    if type == "relation" { property["has_more"] = false }
    result[name] = property
  }
  return result
}
func pageResponse(id: String, source: String, properties: [String: Any]) -> [String: Any] {
  [
    "object": "page", "id": id, "parent": ["type": "data_source_id", "data_source_id": source],
    "archived": false, "in_trash": false, "properties": responseProperties(properties),
  ]
}
actor MockNotion: NotionTransport {
  enum Mode {
    case normal, committedResponseLost, uncommittedResponseLost, rateLimited, tamperedReadback
  }
  var mode: Mode
  var creates = 0
  var attempts: [[String: Any]] = []
  var questionExists = true
  var questionCreates = 0
  var reviewRequests = 0
  func reviewRequestCount() -> Int { reviewRequests }
  var reviewAvailable = false
  var reviewFailure: NotionFailure?
  init(_ mode: Mode = .normal) { self.mode = mode }
  func setMode(_ next: Mode) { mode = next }
  func setReviewAvailable(_ available: Bool) { reviewAvailable = available }
  func setReviewFailure(_ failure: NotionFailure?) { reviewFailure = failure }
  func setQuestionExists(_ exists: Bool) { questionExists = exists }
  func createCount() -> Int { creates }
  func questionCreateCount() -> Int { questionCreates }
  func request(method: String, path: String, body: Data?) async throws -> Data {
    if method == "GET", path.contains(reviewParentID) {
      reviewRequests += 1
      if let reviewFailure { throw reviewFailure }
      guard reviewAvailable else {
        throw NotionFailure(code: "NOTION_NETWORK_ERROR", retryable: true)
      }
      if path.contains("/children") {
        return try canonical([
          "object": "list", "results": [], "has_more": false, "next_cursor": NSNull(),
        ])
      }
      return try canonical([
        "object": "page", "id": reviewParentID, "archived": false, "in_trash": false,
      ])
    }
    if method == "GET", path.hasPrefix("/data_sources/") {
      let isAttempt = path.contains(attemptsID)
      let types =
        isAttempt
        ? [
          "記録名": "title", "イベントID": "rich_text", "問題キー": "rich_text", "問題番号": "rich_text",
          "自分の解答": "rich_text", "判定": "select", "解答日時": "date", "学習日": "date", "取得日時": "date",
          "問題": "relation", "記録元": "select", "スキーマバージョン": "rich_text", "学習種別": "select",
          "記録データV1": "rich_text", "学習目的データV1": "rich_text",
        ] : ["問題番号": "title", "問題キー": "rich_text"]
      var props: [String: Any] = [:]
      for (name, type) in types {
        var inner: [String: Any] = [:]
        if type == "select" {
          inner["options"] = ["正解", "不正解", "未判定", "Safari拡張", "通常学習", "復習", "未分類"].map {
            ["name": $0]
          }
        }
        if type == "relation" { inner["data_source_id"] = questionsID }
        props[name] = ["type": type, type: inner]
      }
      return try canonical([
        "object": "data_source", "id": isAttempt ? attemptsID : questionsID, "properties": props,
      ])
    }
    let question = pageResponse(
      id: questionPageID, source: questionsID,
      properties: ["問題番号": ["title": textItems("120A1")], "問題キー": rich("120A1")])
    if method == "POST", path.hasSuffix("/query") {
      return try canonical([
        "object": "list",
        "results": path.contains(questionsID) ? (questionExists ? [question] : []) : attempts,
        "has_more": false, "next_cursor": NSNull(),
      ])
    }
    if method == "POST", path == "/pages" {
      let data = try object(body!)
      let source = (data["parent"] as! [String: Any])["data_source_id"] as! String
      if source == questionsID {
        questionCreates += 1
        if mode == .uncommittedResponseLost {
          throw NotionFailure(code: "NOTION_NETWORK_ERROR", retryable: true, ambiguous: true)
        }
        questionExists = true
        return try canonical(question)
      }
      creates += 1
      if mode == .rateLimited {
        throw NotionFailure(code: "NOTION_RATE_LIMITED", retryable: true, retryAfter: 120)
      }
      if mode == .uncommittedResponseLost {
        throw NotionFailure(code: "NOTION_NETWORK_ERROR", retryable: true, ambiguous: true)
      }
      var saved = pageResponse(
        id: attemptPageID, source: attemptsID, properties: data["properties"] as! [String: Any])
      if mode == .tamperedReadback {
        var props = saved["properties"] as! [String: Any]
        props["自分の解答"] = ["type": "rich_text", "rich_text": textItems("b")]
        saved["properties"] = props
      }
      attempts = [saved]
      if mode == .committedResponseLost {
        throw NotionFailure(code: "NOTION_NETWORK_ERROR", retryable: true, ambiguous: true)
      }
      return try canonical(saved)
    }
    if method == "GET", path == "/pages/\(questionPageID)" { return try canonical(question) }
    if method == "GET", path == "/pages/\(attemptPageID)", let saved = attempts.first {
      return try canonical(saved)
    }
    throw NotionFailure(code: "NOTION_NOT_FOUND")
  }
}
struct NotionSyncTests {
  func prepared() throws -> IOSRecordStore {
    let store = try temporaryStore()
    _ = try store.append(eventJSON: canonical(fixtureEvent()), routeJSON: fixtureRoute())
    return store
  }
  func worker(_ store: IOSRecordStore, _ transport: MockNotion, time: Double = 1000) throws
    -> NotionSyncWorker
  {
    NotionSyncWorker(
      store: store, configuration: try testConfiguration(), transport: transport,
      now: { Date(timeIntervalSince1970: time) })
  }
  func reviewWorker(_ store: IOSRecordStore, _ transport: MockNotion, time: Double = 1000) throws
    -> NotionSyncWorker
  {
    NotionSyncWorker(
      store: store,
      configuration: try NotionConfiguration(
        attemptsDataSourceID: attemptsID, questionsDataSourceID: questionsID,
        reviewParentPageID: reviewParentID),
      transport: transport, now: { Date(timeIntervalSince1970: time) })
  }
  @Test func testSuccessRequiresReadbackAndPersistsConfirmation() async throws {
    let store = try prepared()
    let mock = MockNotion()
    let report = await (try worker(store, mock)).runOnce()
    expectEqual(report.confirmed, 1)
    expectNil(report.code)
    expectEqual(try IOSRecordStore(directory: store.directory).status().confirmed, 1)
    expectEqual(
      try store.eventStatus(eventID: fixtureEvent()["event_id"] as! String), "notion_confirmed")
    _ = await (try worker(store, mock)).runOnce()
    let count = await mock.createCount()
    expectEqual(count, 1)
  }
  @Test func testCommittedLostResponseReconcilesWithoutSecondCreate() async throws {
    let store = try prepared()
    let mock = MockNotion(.committedResponseLost)
    let failed = await (try worker(store, mock)).runOnce()
    expectEqual(failed.pending, 1)
    expectEqual(failed.blocked, 1)
    let reopened = try IOSRecordStore(directory: store.directory)
    let recovered = await (try worker(reopened, mock, time: 1020)).runOnce()
    expectEqual(recovered.confirmed, 1)
    let count = await mock.createCount()
    expectEqual(count, 1)
  }
  @Test func testNegativeReadAfterUnknownCreateNeverBlindlyRetries() async throws {
    let store = try prepared()
    let mock = MockNotion(.uncommittedResponseLost)
    _ = await (try worker(store, mock)).runOnce()
    await mock.setMode(.normal)
    for time in [1020.0, 2000.0] {
      let report = await (try worker(IOSRecordStore(directory: store.directory), mock, time: time))
        .runOnce()
      expectEqual(report.confirmed, 0)
      expectEqual(report.blocked, 1)
    }
    let count = await mock.createCount()
    expectEqual(count, 1)
  }
  @Test func testQuestionUnknownCreateAlsoNeverRetries() async throws {
    let store = try prepared()
    let mock = MockNotion(.uncommittedResponseLost)
    await mock.setQuestionExists(false)
    _ = await (try worker(store, mock)).runOnce()
    await mock.setMode(.normal)
    _ = await (try worker(store, mock, time: 2000)).runOnce()
    let questionCount = await mock.questionCreateCount()
    let count = await mock.createCount()
    expectEqual(questionCount, 1)
    expectEqual(count, 0)
  }
  @Test func testRetryAfterPersistsAcrossRestartAndSafeRejectionCanRetry() async throws {
    let store = try prepared()
    let mock = MockNotion(.rateLimited)
    _ = await (try worker(store, mock)).runOnce()
    await mock.setMode(.normal)
    let held = await (try worker(IOSRecordStore(directory: store.directory), mock, time: 1050))
      .runOnce()
    expectEqual(held.code, "NOTION_BACKOFF")
    let resumed = await (try worker(store, mock, time: 1121)).runOnce()
    expectEqual(resumed.confirmed, 1)
    let count = await mock.createCount()
    expectEqual(count, 2)
  }
  @Test func testPayloadMismatchFailsClosedAndRetainsLocalEvidence() async throws {
    let store = try prepared()
    let mock = MockNotion(.tamperedReadback)
    let report = await (try worker(store, mock)).runOnce()
    expectEqual(report.confirmed, 0)
    expectEqual(report.blocked, 1)
    expectEqual(try store.status().saved, 1)
    expectEqual(try store.attempts()[0].event["result"] as? String, "correct")
  }
  @Test func testUnresolvedRouteStaysUnclassified() async throws {
    let store = try temporaryStore()
    let event = fixtureEvent()
    _ = try store.append(eventJSON: canonical(event), routeJSON: fixtureRoute("unresolved"))
    _ = await (try worker(store, MockNotion())).runOnce()
    let context = try store.context(eventID: event["event_id"] as! String)!
    expectEqual(try object(context)["study_mode"] as? String, "unclassified")
  }
  @Test func testNewUnresolvedRouteDefaultsToNormalWithoutChangingLegacyEvidence() async throws {
    let store = try temporaryStore()
    let event = fixtureEvent()
    var route = try object(fixtureRoute("unresolved"))
    route["classification_policy"] = "normal_default_v1"
    _ = try store.append(eventJSON: canonical(event), routeJSON: canonical(route))
    _ = await (try worker(store, MockNotion())).runOnce()
    let context = try #require(try store.context(eventID: event["event_id"] as! String))
    #expect(try object(context)["study_mode"] as? String == "normal")
    #expect(try object(context)["review_plan_id"] == nil)
  }
  @Test func testManualSelectionSurvivesNativeSyncAndDoesNotRequireSetLookup() async throws {
    for mode in ["normal", "review"] {
      let store = try temporaryStore()
      let event = fixtureEvent()
      var route = try object(fixtureRoute(set: "known-review-set"))
      route["classification_policy"] = "normal_default_v1"
      route["manual_study_mode"] = mode
      _ = try store.append(eventJSON: canonical(event), routeJSON: canonical(route))
      let mock = MockNotion()
      await mock.setReviewFailure(NotionFailure(code: "NOTION_FORBIDDEN"))
      let report = await (try reviewWorker(store, mock)).runOnce()
      #expect(report.confirmed == 1)
      let context = try #require(try store.context(eventID: event["event_id"] as! String))
      #expect(try object(context)["study_mode"] as? String == mode)
      #expect(try object(context)["review_plan_id"] == nil)
      _ = await (try reviewWorker(IOSRecordStore(directory: store.directory), mock)).runOnce()
      #expect(try store.context(eventID: event["event_id"] as! String) == context)
    }
  }
  @Test func testPreviewDoesNotCreateAttemptsAndRespectsManualSelection() async throws {
    let store = try temporaryStore()
    let mock = MockNotion()
    let preview = try reviewWorker(store, mock)
    var route = try object(fixtureRoute("unresolved"))
    route["classification_policy"] = "normal_default_v1"
    #expect(try await preview.previewStudyMode(routeJSON: canonical(route)).studyMode == "normal")
    route["manual_study_mode"] = "review"
    let manual = try await preview.previewStudyMode(routeJSON: canonical(route))
    #expect(manual.studyMode == "review")
    #expect(manual.reviewPlanID == nil)
    #expect(try store.status().saved == 0)
    #expect(await mock.createCount() == 0)
  }
  @Test func testPreviewSharesRetryAfterWithSyncAndDoesNotBypassCooldown() async throws {
    let store = try temporaryStore()
    let mock = MockNotion()
    await mock.setReviewFailure(NotionFailure(code: "NOTION_RATE_LIMITED", retryable: true, retryAfter: 120))
    let route = try fixtureRoute(set: "synthetic-review")
    let first = try await reviewWorker(store, mock).previewStudyMode(routeJSON: route)
    #expect(first.studyMode == "unclassified")
    #expect(await mock.reviewRequestCount() == 1)
    #expect(try store.state(target: testConfiguration().target, kind: "worker", key: "cooldown")?.retryAt == 1120)
    await mock.setReviewFailure(nil)
    await mock.setReviewAvailable(true)
    let reopened = try IOSRecordStore(directory: store.directory)
    let held = try await reviewWorker(reopened, mock, time: 1100).previewStudyMode(routeJSON: route)
    #expect(held.studyMode == "unclassified")
    #expect(await mock.reviewRequestCount() == 1)
    let resumed = try await reviewWorker(reopened, mock, time: 1121).previewStudyMode(routeJSON: route)
    #expect(resumed.studyMode == "normal")
    #expect(await mock.reviewRequestCount() > 1)
    #expect(try store.status().saved == 0)
  }
  @Test func testConfiguredReviewLookupFailureStaysPendingThenResumesClassification() async throws {
    let store = try temporaryStore()
    let event = fixtureEvent()
    _ = try store.append(eventJSON: canonical(event), routeJSON: fixtureRoute(set: "new-set"))
    let mock = MockNotion()
    let config = try NotionConfiguration(
      attemptsDataSourceID: attemptsID, questionsDataSourceID: questionsID,
      reviewParentPageID: reviewParentID)
    let failed = await NotionSyncWorker(
      store: store, configuration: config, transport: mock,
      now: { Date(timeIntervalSince1970: 1000) }
    ).runOnce()
    #expect(failed.pending == 1)
    #expect(try store.context(eventID: event["event_id"] as! String) == nil)
    #expect(await mock.createCount() == 0)
    await mock.setReviewAvailable(true)
    let reopened = try IOSRecordStore(directory: store.directory)
    let resumed = await NotionSyncWorker(
      store: reopened, configuration: config, transport: mock,
      now: { Date(timeIntervalSince1970: 2000) }
    ).runOnce()
    #expect(resumed.confirmed == 1)
    let context = try #require(try reopened.context(eventID: event["event_id"] as! String))
    #expect(try object(context)["study_mode"] as? String == "normal")
  }
  @Test func testParentAccessFailureDoesNotPauseNormalOrPreviouslyClassifiedAnswers() async throws {
    for code in ["NOTION_FORBIDDEN", "NOTION_NOT_FOUND"] {
      for previouslyClassified in [false, true] {
        let store = try temporaryStore()
        let event = fixtureEvent()
        let eventID = event["event_id"] as! String
        _ = try store.append(
          eventJSON: canonical(event),
          routeJSON: fixtureRoute(set: previouslyClassified ? "known-review-set" : nil))
        if previouslyClassified {
          try store.appendContext(
            eventID: eventID,
            data: contextData(
              eventID: eventID,
              resolution: ReviewResolution(
                studyMode: "review", reviewPlanID: "33333333-3333-4333-8333-333333333333")))
        }
        let originalContext = try store.context(eventID: eventID)
        let mock = MockNotion()
        await mock.setReviewFailure(NotionFailure(code: code))
        let warmed = await (try reviewWorker(store, mock)).warmReviewCatalog()
        #expect(warmed.code == code)
        #expect(
          try store.state(
            target: testConfiguration().target, kind: "worker", key: "cooldown") == nil)
        let reopened = try IOSRecordStore(directory: store.directory)
        let report = await (try reviewWorker(reopened, mock)).runOnce()
        #expect(report.code == nil)
        #expect(report.confirmed == 1)
        #expect(try reopened.status().saved == 1)
        #expect(await mock.createCount() == 1)
        let context = try #require(try reopened.context(eventID: eventID))
        #expect(
          try object(context)["study_mode"] as? String
            == (previouslyClassified ? "review" : "normal"))
        if previouslyClassified { #expect(context == originalContext) }
      }
    }
  }
  @Test func testParentAccessFailureKeepsUnknownReviewClassificationPending() async throws {
    for code in ["NOTION_FORBIDDEN", "NOTION_NOT_FOUND"] {
      let store = try temporaryStore()
      let event = fixtureEvent()
      _ = try store.append(eventJSON: canonical(event), routeJSON: fixtureRoute(set: "unknown-set"))
      let mock = MockNotion()
      await mock.setReviewFailure(NotionFailure(code: code))
      _ = await (try reviewWorker(store, mock)).warmReviewCatalog()
      let report = await (try reviewWorker(store, mock)).runOnce()
      #expect(report.code == code)
      #expect(report.confirmed == 0)
      #expect(report.pending == 1)
      #expect(try store.context(eventID: event["event_id"] as! String) == nil)
      #expect(await mock.createCount() == 0)
    }
  }
  @Test func testReviewAccessFailureDoesNotBlockNormalAnswerInSameBatch() async throws {
    for code in ["NOTION_FORBIDDEN", "NOTION_NOT_FOUND"] {
      let store = try temporaryStore()
      let reviewEvent = fixtureEvent()
      let normalEvent = fixtureEvent(id: "44444444-4444-4444-8444-444444444444")
      _ = try store.append(
        eventJSON: canonical(reviewEvent), routeJSON: fixtureRoute(set: "unverified-review-set"))
      _ = try store.append(eventJSON: canonical(normalEvent), routeJSON: fixtureRoute())
      let mock = MockNotion()
      await mock.setReviewFailure(NotionFailure(code: code))

      let report = await (try reviewWorker(store, mock)).runOnce()

      #expect(report.code == code)
      #expect(report.checked == 2)
      #expect(report.confirmed == 1)
      #expect(report.pending == 1)
      #expect(await mock.createCount() == 1)
      #expect(try store.context(eventID: reviewEvent["event_id"] as! String) == nil)
      #expect(
        try store.eventStatus(eventID: normalEvent["event_id"] as! String) == "notion_confirmed")
      let reopened = try IOSRecordStore(directory: store.directory)
      #expect(try reopened.status().saved == 2)
      #expect(try reopened.status().confirmed == 1)
      #expect(
        try reopened.state(
          target: testConfiguration().target, kind: "worker", key: "cooldown") == nil)
    }
  }
  @Test func testReviewRateLimitStillStopsMixedBatchAndPersistsCooldown() async throws {
    let store = try temporaryStore()
    _ = try store.append(
      eventJSON: canonical(fixtureEvent()), routeJSON: fixtureRoute(set: "unverified-review-set"))
    _ = try store.append(
      eventJSON: canonical(fixtureEvent(id: "44444444-4444-4444-8444-444444444444")),
      routeJSON: fixtureRoute())
    let mock = MockNotion()
    await mock.setReviewFailure(
      NotionFailure(code: "NOTION_RATE_LIMITED", retryable: true, retryAfter: 120))

    let report = await (try reviewWorker(store, mock)).runOnce()

    #expect(report.code == "NOTION_RATE_LIMITED")
    #expect(report.checked == 1)
    #expect(report.confirmed == 0)
    #expect(report.pending == 2)
    #expect(await mock.createCount() == 0)
    let reopened = try IOSRecordStore(directory: store.directory)
    let cooldown = try #require(
      try reopened.state(
        target: testConfiguration().target, kind: "worker", key: "cooldown"))
    #expect(cooldown.retryAt == 1120)
    let held = await (try reviewWorker(reopened, mock, time: 1119)).runOnce()
    #expect(held.code == "NOTION_BACKOFF")
    #expect(held.checked == 0)
  }
  @Test func testRetryableCatalogFailuresStillPauseDeliveryAcrossRestart() async throws {
    let failures = [
      NotionFailure(code: "NOTION_RATE_LIMITED", retryable: true, retryAfter: 120),
      NotionFailure(code: "NOTION_NETWORK_ERROR", retryable: true),
      NotionFailure(code: "NOTION_SERVICE_UNAVAILABLE", retryable: true),
    ]
    for failure in failures {
      let store = try prepared()
      let mock = MockNotion()
      await mock.setReviewFailure(failure)
      let warmed = await (try reviewWorker(store, mock)).warmReviewCatalog()
      #expect(warmed.code == failure.code)
      let resumeAt = 1000 + max(10, failure.retryAfter)
      let reopened = try IOSRecordStore(directory: store.directory)
      let cooldown = try #require(
        try reopened.state(
          target: testConfiguration().target, kind: "worker", key: "cooldown"))
      #expect(cooldown.retryAt == resumeAt)
      #expect(cooldown.code == failure.code)
      let held = await (try reviewWorker(reopened, mock, time: resumeAt - 1)).runOnce()
      #expect(held.code == "NOTION_BACKOFF")
      #expect(held.checked == 0)
      #expect(await mock.createCount() == 0)
      await mock.setReviewFailure(nil)
      await mock.setReviewAvailable(true)
      let resumedWorker = try reviewWorker(reopened, mock, time: resumeAt + 1)
      let rewarmed = await resumedWorker.warmReviewCatalog()
      #expect(rewarmed.code == nil)
      let resumed = await resumedWorker.runOnce()
      #expect(resumed.code == nil)
      #expect(resumed.confirmed == 1)
      #expect(await mock.createCount() == 1)
    }
  }
  @Test func testUnconfiguredReviewParentDeliversUnclassifiedWithoutDroppingAnswer() async throws {
    let store = try temporaryStore()
    let event = fixtureEvent()
    _ = try store.append(eventJSON: canonical(event), routeJSON: fixtureRoute(set: "unknown-set"))
    let report = await (try worker(store, MockNotion())).runOnce()
    #expect(report.confirmed == 1)
    let context = try #require(try store.context(eventID: event["event_id"] as! String))
    #expect(try object(context)["study_mode"] as? String == "unclassified")
  }

}
