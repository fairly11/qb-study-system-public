import CryptoKit
import Foundation
import Testing

@testable import QBRecordCore

private let reviewParent = "30000000-0000-4000-8000-000000000001"
private let reviewPage = "20000000-0000-4000-8000-000000000001"
private let reviewPlan = "10000000-0000-4000-8000-000000000001"
private let reviewToggle = "40000000-0000-4000-8000-000000000001"
private let reviewSet = "synthetic-QB-set"
private let reviewURL =
  "https://qb.medilink-study.com/search?questionSetId=synthetic-QB-set&operation=OR"

private actor ReviewTransportFixture: NotionTransport {
  let responses: [String: Data]
  var requests: [String] = []
  init(_ responses: [String: Data]) { self.responses = responses }
  func request(method: String, path: String, body: Data?) async throws -> Data {
    guard method == "GET", body == nil else { throw URLError(.unsupportedURL) }
    requests.append(path)
    guard let response = responses[path] else { throw URLError(.notConnectedToInternet) }
    return response
  }
}

private struct ReviewFixture {
  var plan: [String: Any] = [
    "schema_version": "review-plan-v2", "plan_id": reviewPlan,
    "target_date": "2026-10-25", "timezone": "Asia/Tokyo",
    "selection_at": "2026-10-24T19:00:00Z", "scheduled_at": "2026-10-25T04:00:00+09:00",
    "source_plan_sha256": String(repeating: "a", count: 64),
    "items": [
      ["position": 1, "question_key": "119A12"], ["position": 2, "question_key": "118B3"],
    ],
  ]
  var title = "QB復習候補 2026-10-25"
  var url = reviewURL
  var actualLink = reviewURL
  var pageParent = reviewParent
  var pageID = reviewPage
  var planMarkerID = reviewPlan
  var corruptHash = false
  var omitLink = false
  var omitMarker = false
  var duplicateLink = false
  var archivedPage = false
  var codeHasChildren = false
  var rawPlan: String?
  var blockParent: String?

  func responses() throws -> [String: Data] {
    let canonical =
      try rawPlan
      ?? String(
        decoding: JSONSerialization.data(withJSONObject: plan, options: [.sortedKeys]),
        as: UTF8.self)
    let hash =
      corruptHash
      ? String(repeating: "0", count: 64)
      : SHA256.hash(data: Data(canonical.utf8)).map { String(format: "%02x", $0) }.joined()
    var main: [[String: Any]] = []
    if !omitMarker {
      main.append(
        reviewFixtureBlock(
          "40000000-0000-4000-8000-000000000002", "paragraph",
          "QB_REVIEW_PLAN_V1:\(planMarkerID):\(hash)", parent: blockParent ?? reviewPage))
    }
    main.append(
      reviewFixtureBlock(reviewToggle, "toggle", "計画データ（照合用）", parent: reviewPage, children: true))
    let link = reviewFixtureBlock(
      "40000000-0000-4000-8000-000000000003", "paragraph", "QB問題セット: \(url)", parent: reviewPage,
      link: actualLink)
    if !omitLink { main.append(link) }
    if duplicateLink {
      main.append(
        reviewFixtureBlock(
          "40000000-0000-4000-8000-000000000004", "paragraph", "QB問題セット: \(url)",
          parent: reviewPage, link: actualLink))
    }
    return try [
      "/pages/\(reviewParent)": reviewFixtureJSON(reviewFixturePage(reviewParent)),
      reviewBlocksPath(reviewParent): reviewFixtureJSON(
        reviewFixtureList([
          reviewFixtureBlock(reviewPage, "child_page", title, parent: reviewParent, children: true)
        ])),
      "/pages/\(reviewPage)": reviewFixtureJSON(
        reviewFixturePage(pageID, parent: pageParent, title: title, archived: archivedPage)),
      reviewBlocksPath(reviewPage): reviewFixtureJSON(reviewFixtureList(main)),
      reviewBlocksPath(reviewToggle): reviewFixtureJSON(
        reviewFixtureList([
          reviewFixtureBlock(
            "40000000-0000-4000-8000-000000000005", "code", canonical, parent: reviewToggle,
            children: codeHasChildren)
        ])),
    ]
  }
}

private func reviewBlocksPath(_ id: String, cursor: String? = nil) -> String {
  "/blocks/\(id)/children?page_size=100" + (cursor.map { "&start_cursor=\($0)" } ?? "")
}
private func reviewFixtureJSON(_ object: Any) throws -> Data {
  try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
}
private func reviewRichParts(_ text: String, link: String? = nil) -> [[String: Any]] {
  [
    [
      "type": "text",
      "text": ["content": text, "link": link.map { ["url": $0] } as Any? ?? NSNull()],
    ]
  ]
}
private func reviewFixturePage(
  _ id: String, parent: String? = nil, title: String = "", archived: Bool = false
) -> [String: Any] {
  var result: [String: Any] = [
    "object": "page", "id": id, "archived": archived, "in_trash": false,
    "properties": ["title": ["type": "title", "title": reviewRichParts(title)]],
  ]
  if let parent { result["parent"] = ["type": "page_id", "page_id": parent] }
  return result
}
private func reviewFixtureBlock(
  _ id: String, _ type: String, _ text: String, parent: String, children: Bool = false,
  link: String? = nil
) -> [String: Any] {
  [
    "object": "block", "id": id, "type": type, "has_children": children, "archived": false,
    "in_trash": false,
    "parent": [
      "type": parent == reviewToggle ? "block_id" : "page_id",
      parent == reviewToggle ? "block_id" : "page_id": parent,
    ],
    type: type == "child_page" ? ["title": text] : ["rich_text": reviewRichParts(text, link: link)],
  ]
}
private func reviewFixtureList(_ results: [[String: Any]], cursor: String? = nil) -> [String: Any] {
  [
    "object": "list", "results": results, "has_more": cursor != nil,
    "next_cursor": cursor as Any? ?? NSNull(),
  ]
}

private actor BudgetReviewFixture: NotionTransport {
  let responses: [String: Data]
  let maximum: Int
  var requests: [String] = []
  init(_ responses: [String: Data], maximum: Int) {
    self.responses = responses
    self.maximum = maximum
  }
  func request(method: String, path: String, body: Data?) async throws -> Data {
    guard method == "GET", body == nil else { throw RecordError("UNEXPECTED_TEST_REQUEST") }
    guard requests.count < maximum else {
      throw NotionFailure(code: "NOTION_TIME_BUDGET", retryable: true)
    }
    requests.append(path)
    guard let value = responses[path] else {
      throw NotionFailure(code: "NOTION_NETWORK_ERROR", retryable: true)
    }
    return value
  }
}
private struct CombinedReviewFixture: NotionTransport {
  let review: [String: Data]
  let notion: MockNotion
  func request(method: String, path: String, body: Data?) async throws -> Data {
    if method == "GET", let response = review[path] { return response }
    return try await notion.request(method: method, path: path, body: body)
  }
}
private func multiReviewFixture(count: Int, conflictingLast: Bool = false) throws -> [String: Data]
{
  var responses = try ReviewFixture().responses()
  var children: [[String: Any]] = []
  for index in 0..<count {
    let suffix = String(format: "%012d", index + 1)
    let pageID = "20000000-0000-4000-8000-" + suffix
    let toggleID = "40000000-0000-4000-8000-" + String(format: "%012d", index * 100 + 1)
    let planID = "10000000-0000-4000-8000-" + suffix
    var fixture = ReviewFixture()
    fixture.plan["plan_id"] = planID
    fixture.planMarkerID = planID
    if index > 0 && !(conflictingLast && index == count - 1) {
      fixture.url =
        "https://qb.medilink-study.com/search?questionSetId=synthetic-set-\(index)&operation=OR"
      fixture.actualLink = fixture.url
    }
    for (key, data) in try fixture.responses() where !key.contains(reviewParent) {
      let newKey = key.replacingOccurrences(of: reviewPage, with: pageID).replacingOccurrences(
        of: reviewToggle, with: toggleID)
      let text = String(decoding: data, as: UTF8.self).replacingOccurrences(
        of: reviewPage, with: pageID
      ).replacingOccurrences(of: reviewToggle, with: toggleID)
      responses[newKey] = Data(text.utf8)
    }
    children.append(
      reviewFixtureBlock(pageID, "child_page", fixture.title, parent: reviewParent, children: true))
  }
  responses[reviewBlocksPath(reviewParent)] = try reviewFixtureJSON(reviewFixtureList(children))
  return responses
}

struct ReviewSetResolverTests {
  @Test func testExactPublishedProofConfirmsReviewAndReadOnlyRequests() async throws {
    let transport = ReviewTransportFixture(try ReviewFixture().responses())
    let result = await VerifiedReviewSetResolver(transport: transport, parentPageID: reviewParent)
      .resolve(questionSetID: reviewSet)
    #expect(result == ReviewResolution(studyMode: "review", reviewPlanID: reviewPlan))
    let calls = await transport.requests
    #expect(calls.count == 6)
    #expect(calls.contains(reviewBlocksPath(reviewToggle)))
  }

  @Test func testCompleteCatalogNonmatchIsNormal() async throws {
    let result = await resolve(ReviewFixture(), set: "ordinary-set")
    #expect(result == ReviewResolution(studyMode: "normal"))
  }

  @Test func testTitleAndQuestionMembershipWithoutPublishedLinkDoNotAuthorizeReview() async throws {
    var fixture = ReviewFixture()
    fixture.omitLink = true
    let result = await resolve(fixture)
    #expect(result == ReviewResolution(studyMode: "normal"))
  }

  @Test func testSpoofedDisplayedAndActualLinksRemainUnclassified() async throws {
    let badURLs = [
      "https://qb.medilink-study.com.evil.invalid/search?questionSetId=synthetic-QB-set&operation=OR",
      "https://qb.medilink-study.com/search?questionSetId=synthetic-QB-set&operation=OR#x",
      "https://qb.medilink-study.com/search?questionSetId=synthetic-QB-set&operation=OR&extra=x",
      "https://qb.medilink-study.com/search?operation=OR&questionSetId=synthetic-QB-set",
      "https://qb.medilink-study.com/search?questionSetId=synthetic-QB-set&questionSetId=other&operation=OR",
      "http://qb.medilink-study.com/search?questionSetId=synthetic-QB-set&operation=OR",
    ]
    for bad in badURLs {
      var fixture = ReviewFixture()
      fixture.url = bad
      fixture.actualLink = bad
      let result = await resolve(fixture)
      #expect(result.studyMode == "unclassified")
    }
    var hidden = ReviewFixture()
    hidden.actualLink = "https://evil.invalid/"
    let result = await resolve(hidden)
    #expect(result.studyMode == "unclassified")
  }

  @Test func testMisleadingTitleOrMarkerCannotProveOrigin() async throws {
    var title = ReviewFixture()
    title.title = "QB復習候補 2026-10-24"
    var marker = ReviewFixture()
    marker.omitMarker = true
    var otherID = ReviewFixture()
    otherID.planMarkerID = "10000000-0000-4000-8000-000000000002"
    var duplicate = ReviewFixture()
    duplicate.duplicateLink = true
    for fixture in [title, marker, otherID, duplicate] {
      let result = await resolve(fixture)
      #expect(result.studyMode == "unclassified")
    }
  }

  @Test func testMalformedOrChangedPlanNeverAuthorizesReviewOrNormal() async throws {
    var corrupt = ReviewFixture()
    corrupt.corruptHash = true
    var malformed = ReviewFixture()
    malformed.rawPlan = "{invalid"
    var invalidDay = ReviewFixture()
    invalidDay.plan["target_date"] = "2026-02-30"
    var missingOffset = ReviewFixture()
    missingOffset.plan["selection_at"] = "2026-10-24T19:00:00"
    var invalidHour = ReviewFixture()
    invalidHour.plan["selection_at"] = "2026-10-24T24:00:00Z"
    var invalidOffset = ReviewFixture()
    invalidOffset.plan["selection_at"] = "2026-10-24T19:00:00+14:01"
    var wrongZone = ReviewFixture()
    wrongZone.plan["timezone"] = "UTC"
    var missingSource = ReviewFixture()
    missingSource.plan["source_plan_sha256"] = nil
    var empty = ReviewFixture()
    empty.plan["items"] = []
    var duplicate = ReviewFixture()
    duplicate.plan["items"] = [
      ["position": 1, "question_key": "119A12"], ["position": 2, "question_key": "119A12"],
    ]
    var wrongPosition = ReviewFixture()
    wrongPosition.plan["items"] = [["position": 2, "question_key": "119A12"]]
    var booleanPosition = ReviewFixture()
    booleanPosition.plan["items"] = [["position": true, "question_key": "119A12"]]
    var nestedCode = ReviewFixture()
    nestedCode.codeHasChildren = true
    for fixture in [
      corrupt, malformed, invalidDay, missingOffset, invalidHour, invalidOffset, wrongZone,
      missingSource, empty, duplicate, wrongPosition, booleanPosition, nestedCode,
    ] {
      let result = await resolve(fixture)
      #expect(result.studyMode == "unclassified")
      let nonmatch = await resolve(fixture, set: "ordinary-set")
      #expect(nonmatch.studyMode == "unclassified")
    }
  }

  @Test func testMissingConfigOrInvalidSetMakesNoNetworkRequests() async throws {
    let transport = ReviewTransportFixture([:])
    for parent in [nil, "not-an-id"] as [String?] {
      let result = await VerifiedReviewSetResolver(transport: transport, parentPageID: parent)
        .resolve(questionSetID: reviewSet)
      #expect(result.studyMode == "unclassified")
    }
    let result = await VerifiedReviewSetResolver(transport: transport, parentPageID: reviewParent)
      .resolve(questionSetID: "bad?set")
    #expect(result.studyMode == "unclassified")
    let calls = await transport.requests
    #expect(calls.isEmpty)
  }

  @Test func testWrongParentWrongPageArchivedOrWrongBlockParentIsUnclassified() async throws {
    var moved = ReviewFixture()
    moved.pageParent = "30000000-0000-4000-8000-000000000002"
    var wrongID = ReviewFixture()
    wrongID.pageID = "20000000-0000-4000-8000-000000000002"
    var archived = ReviewFixture()
    archived.archivedPage = true
    var wrongBlock = ReviewFixture()
    wrongBlock.blockParent = reviewParent
    for fixture in [moved, wrongID, archived, wrongBlock] {
      let result = await resolve(fixture)
      #expect(result.studyMode == "unclassified")
    }
  }

  @Test func testReadsAllParentPaginationBeforeMakingNonmatchDecision() async throws {
    var responses = try ReviewFixture().responses()
    let children = responses[reviewBlocksPath(reviewParent)]!
    responses[reviewBlocksPath(reviewParent)] = try reviewFixtureJSON(
      reviewFixtureList([], cursor: "next-page"))
    responses[reviewBlocksPath(reviewParent, cursor: "next%2Dpage")] = children
    let transport = ReviewTransportFixture(responses)
    let result = await VerifiedReviewSetResolver(transport: transport, parentPageID: reviewParent)
      .resolve(questionSetID: reviewSet)
    #expect(result.studyMode == "review")
    let calls = await transport.requests
    #expect(calls.contains(reviewBlocksPath(reviewParent, cursor: "next%2Dpage")))
  }

  @Test func testPublishedPlanAcrossCodePaginationIsFullyReadAndHashed() async throws {
    let fixture = ReviewFixture()
    var responses = try fixture.responses()
    let canonical = String(
      decoding: try JSONSerialization.data(withJSONObject: fixture.plan, options: [.sortedKeys]),
      as: UTF8.self)
    let split = canonical.index(canonical.startIndex, offsetBy: canonical.count / 2)
    responses[reviewBlocksPath(reviewToggle)] = try reviewFixtureJSON(
      reviewFixtureList(
        [
          reviewFixtureBlock(
            "40000000-0000-4000-8000-000000000005", "code", String(canonical[..<split]),
            parent: reviewToggle)
        ], cursor: "code2"))
    responses[reviewBlocksPath(reviewToggle, cursor: "code2")] = try reviewFixtureJSON(
      reviewFixtureList([
        reviewFixtureBlock(
          "40000000-0000-4000-8000-000000000006", "code", String(canonical[split...]),
          parent: reviewToggle)
      ]))
    let result = await VerifiedReviewSetResolver(
      transport: ReviewTransportFixture(responses), parentPageID: reviewParent
    ).resolve(questionSetID: reviewSet)
    #expect(result == ReviewResolution(studyMode: "review", reviewPlanID: reviewPlan))
  }

  @Test func testNumericBooleanAndDuplicateBlockCannotProveCompleteCatalog() async throws {
    for duplicate in [true, false] {
      var responses = try ReviewFixture().responses()
      var malformed = reviewFixtureList([])
      if duplicate {
        let child = reviewFixtureBlock(
          reviewPage, "child_page", "QB復習候補 2026-10-25", parent: reviewParent, children: true)
        malformed["results"] = [child, child]
      } else {
        malformed["has_more"] = 0
      }
      responses[reviewBlocksPath(reviewParent)] = try reviewFixtureJSON(malformed)
      let result = await VerifiedReviewSetResolver(
        transport: ReviewTransportFixture(responses), parentPageID: reviewParent
      ).resolve(questionSetID: "ordinary-set")
      #expect(result.studyMode == "unclassified")
    }
  }

  @Test func testMissingFinalParentOrCodePageIsUnclassifiedIncludingKnownMatch() async throws {
    for missingID in [reviewParent, reviewToggle] {
      var responses = try ReviewFixture().responses()
      let data = try #require(responses[reviewBlocksPath(missingID)])
      var body = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
      body["has_more"] = true
      body["next_cursor"] = "missing"
      responses[reviewBlocksPath(missingID)] = try reviewFixtureJSON(body)
      let result = await VerifiedReviewSetResolver(
        transport: ReviewTransportFixture(responses), parentPageID: reviewParent
      ).resolve(questionSetID: reviewSet)
      #expect(result.studyMode == "unclassified")
    }
  }

  @Test func testCursorCycleAndMissingTerminalCursorFailClosed() async throws {
    for repeatCursor in [true, false] {
      var responses = try ReviewFixture().responses()
      if repeatCursor {
        responses[reviewBlocksPath(reviewParent)] = try reviewFixtureJSON(
          reviewFixtureList([], cursor: "cycle"))
        responses[reviewBlocksPath(reviewParent, cursor: "cycle")] = try reviewFixtureJSON(
          reviewFixtureList([], cursor: "cycle"))
      } else {
        var malformed = reviewFixtureList([])
        malformed["next_cursor"] = "stale"
        responses[reviewBlocksPath(reviewParent)] = try reviewFixtureJSON(malformed)
      }
      let result = await VerifiedReviewSetResolver(
        transport: ReviewTransportFixture(responses), parentPageID: reviewParent
      ).resolve(questionSetID: "ordinary-set")
      #expect(result.studyMode == "unclassified")
    }
  }

  @Test func testReadFailureAfterValidPageDoesNotPromotePartialCatalog() async throws {
    var responses = try ReviewFixture().responses()
    responses[reviewBlocksPath(reviewParent)] = try reviewFixtureJSON(
      reviewFixtureList([
        reviewFixtureBlock(
          reviewPage, "child_page", "QB復習候補 2026-10-25", parent: reviewParent, children: true),
        reviewFixtureBlock(
          "20000000-0000-4000-8000-000000000002", "child_page", "later-page", parent: reviewParent,
          children: true),
      ]))
    let result = await VerifiedReviewSetResolver(
      transport: ReviewTransportFixture(responses), parentPageID: reviewParent
    ).resolve(questionSetID: reviewSet)
    #expect(result.studyMode == "unclassified")
  }

  @Test func testDuplicateSetWithDifferentPlanIsUnclassified() async throws {
    var responses = try ReviewFixture().responses()
    let secondPage = "20000000-0000-4000-8000-000000000002"
    let secondToggle = "40000000-0000-4000-8000-000000000012"
    let secondPlan = "10000000-0000-4000-8000-000000000002"
    var second = ReviewFixture()
    second.plan["plan_id"] = secondPlan
    second.planMarkerID = secondPlan
    let secondResponses = try second.responses()
    for (key, value) in secondResponses where !key.contains(reviewParent) {
      let text = String(decoding: value, as: UTF8.self).replacingOccurrences(
        of: reviewPage, with: secondPage
      ).replacingOccurrences(of: reviewToggle, with: secondToggle)
      responses[
        key.replacingOccurrences(of: reviewPage, with: secondPage).replacingOccurrences(
          of: reviewToggle, with: secondToggle)] = Data(text.utf8)
    }
    responses[reviewBlocksPath(reviewParent)] = try reviewFixtureJSON(
      reviewFixtureList([
        reviewFixtureBlock(
          reviewPage, "child_page", "QB復習候補 2026-10-25", parent: reviewParent, children: true),
        reviewFixtureBlock(
          secondPage, "child_page", "QB復習候補 2026-10-25", parent: reviewParent, children: true),
      ]))
    let result = await VerifiedReviewSetResolver(
      transport: ReviewTransportFixture(responses), parentPageID: reviewParent
    ).resolve(questionSetID: reviewSet)
    #expect(result.studyMode == "unclassified")
  }

  @Test func testAppendedRevisionDoesNotReplaceBasePlanIdentity() async throws {
    var responses = try ReviewFixture().responses()
    let source = try #require(responses[reviewBlocksPath(reviewPage)])
    var body = try #require(JSONSerialization.jsonObject(with: source) as? [String: Any])
    var values = try #require(body["results"] as? [[String: Any]])
    values.append(
      reviewFixtureBlock(
        "40000000-0000-4000-8000-000000000006", "paragraph", "QB_REVIEW_REVISION_V1:synthetic",
        parent: reviewPage))
    body["results"] = values
    responses[reviewBlocksPath(reviewPage)] = try reviewFixtureJSON(body)
    let result = await VerifiedReviewSetResolver(
      transport: ReviewTransportFixture(responses), parentPageID: reviewParent
    ).resolve(questionSetID: reviewSet)
    #expect(result == ReviewResolution(studyMode: "review", reviewPlanID: reviewPlan))
  }

  @Test func testBudgetInterruptionResumesSanitizedProofAcrossStoreReopen() async throws {
    let store = try temporaryStore()
    let responses = try multiReviewFixture(count: 8)
    let first = BudgetReviewFixture(responses, maximum: 5)
    let interrupted = await VerifiedReviewSetResolver(
      transport: first, parentPageID: reviewParent, checkpointStore: store
    ).resolve(questionSetID: reviewSet)
    #expect(!interrupted.lookupComplete)
    let checkpointData = try #require(try store.loadReviewCatalog(parentPageID: reviewParent))
    let checkpointText = String(decoding: checkpointData, as: UTF8.self)
    #expect(!checkpointText.contains("119A12"))
    #expect(!checkpointText.contains("QB復習候補"))
    #expect(!checkpointText.contains("source_plan_sha256"))
    #expect(!checkpointText.contains("rich_text"))
    var final = interrupted
    var secondCalls: [String] = []
    for iteration in 0..<8 {
      let transport = BudgetReviewFixture(responses, maximum: 5)
      let reopened = try IOSRecordStore(directory: store.directory)
      final = await VerifiedReviewSetResolver(
        transport: transport, parentPageID: reviewParent, checkpointStore: reopened
      ).resolve(questionSetID: reviewSet)
      if iteration == 0 { secondCalls = await transport.requests }
      if final.lookupComplete { break }
    }
    #expect(!secondCalls.contains("/pages/\(reviewPage)"))
    #expect(final == ReviewResolution(studyMode: "review", reviewPlanID: reviewPlan))
  }

  @Test func testResumedLaterConflictNeverReleasesEarlierPositiveMapping() async throws {
    let store = try temporaryStore()
    let responses = try multiReviewFixture(count: 2, conflictingLast: true)
    let interrupted = await VerifiedReviewSetResolver(
      transport: BudgetReviewFixture(responses, maximum: 5), parentPageID: reviewParent,
      checkpointStore: store
    ).resolve(questionSetID: reviewSet)
    #expect(!interrupted.lookupComplete)
    let resumed = await VerifiedReviewSetResolver(
      transport: BudgetReviewFixture(responses, maximum: 20), parentPageID: reviewParent,
      checkpointStore: try IOSRecordStore(directory: store.directory)
    ).resolve(questionSetID: reviewSet)
    #expect(resumed.studyMode == "unclassified")
    #expect(!resumed.lookupComplete)
  }

  @Test func testNewParentChildDuringResumePreventsStaleNormalClassification() async throws {
    let store = try temporaryStore()
    let first = await VerifiedReviewSetResolver(
      transport: BudgetReviewFixture(try multiReviewFixture(count: 2), maximum: 5),
      parentPageID: reviewParent, checkpointStore: store
    ).resolve(questionSetID: "ordinary-set")
    #expect(!first.lookupComplete)
    let changed = await VerifiedReviewSetResolver(
      transport: BudgetReviewFixture(try multiReviewFixture(count: 3), maximum: 20),
      parentPageID: reviewParent, checkpointStore: store
    ).resolve(questionSetID: "ordinary-set")
    #expect(changed.studyMode == "unclassified")
    #expect(!changed.lookupComplete)
    let refreshed = await VerifiedReviewSetResolver(
      transport: BudgetReviewFixture(try multiReviewFixture(count: 3), maximum: 20),
      parentPageID: reviewParent, checkpointStore: store
    ).resolve(questionSetID: "ordinary-set")
    #expect(refreshed.studyMode == "normal")
    #expect(refreshed.lookupComplete)
  }

  @Test func testCompletedSnapshotCannotAnswerNewSetWithoutNetwork() async throws {
    let store = try temporaryStore()
    let first = await VerifiedReviewSetResolver(
      transport: ReviewTransportFixture(try ReviewFixture().responses()),
      parentPageID: reviewParent, checkpointStore: store
    ).resolve(questionSetID: reviewSet)
    #expect(first.studyMode == "review")
    let offline = await VerifiedReviewSetResolver(
      transport: ReviewTransportFixture([:]), parentPageID: reviewParent, checkpointStore: store
    ).resolve(questionSetID: "ordinary-set")
    #expect(offline.studyMode == "unclassified")
    #expect(!offline.lookupComplete)
  }

  @Test func testWarmCatalogPersistsPositiveProofForLaterNativeSync() async throws {
    let store = try temporaryStore()
    let config = try NotionConfiguration(
      attemptsDataSourceID: attemptsID, questionsDataSourceID: questionsID,
      reviewParentPageID: reviewParent)
    let mock = MockNotion()
    let combined = CombinedReviewFixture(review: try ReviewFixture().responses(), notion: mock)
    let warmed = await NotionSyncWorker(store: store, configuration: config, transport: combined)
      .warmReviewCatalog()
    #expect(warmed.code == nil)
    #expect(warmed.verifiedSets == 1)
    let event = fixtureEvent()
    try store.append(eventJSON: canonical(event), routeJSON: fixtureRoute(set: reviewSet))
    let reopened = try IOSRecordStore(directory: store.directory)
    // MockNotion has no review fixture; only the completed cached proof can classify this.
    let report = await NotionSyncWorker(store: reopened, configuration: config, transport: mock)
      .runOnce()
    #expect(report.confirmed == 1)
    let context = try #require(try reopened.context(eventID: event["event_id"] as! String))
    #expect(try object(context)["study_mode"] as? String == "review")
    #expect(try object(context)["review_plan_id"] as? String == reviewPlan)
  }

  private func resolve(_ fixture: ReviewFixture, set: String = reviewSet) async -> ReviewResolution
  {
    do {
      return await VerifiedReviewSetResolver(
        transport: ReviewTransportFixture(try fixture.responses()), parentPageID: reviewParent
      ).resolve(questionSetID: set)
    } catch {
      Issue.record("Fixture construction failed")
      return ReviewResolution(studyMode: "fixture_error")
    }
  }
}
