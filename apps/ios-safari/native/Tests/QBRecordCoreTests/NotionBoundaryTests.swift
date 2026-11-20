import Foundation
import Testing

@testable import QBRecordCore

private struct FixedResponse: NotionTransport {
  let response: Data
  func request(method: String, path: String, body: Data?) async throws -> Data { response }
}
private actor CancelAwareTransport: NotionTransport {
  private(set) var calls = 0
  func request(method: String, path: String, body: Data?) async throws -> Data {
    calls += 1
    try await Task.sleep(nanoseconds: 10_000_000_000)
    return Data("{}".utf8)
  }
}
struct NotionBoundaryTests {
  @Test func testKnownPageGETMustReturnRequestedID() async throws {
    let response = pageResponse(
      id: attemptPageID, source: questionsID, properties: ["問題キー": rich("120A1")])
    let client = NotionClient(
      configuration: try testConfiguration(),
      transport: FixedResponse(response: try canonical(response)))
    do {
      _ = try await client.get(questionPageID, source: questionsID)
      Issue.record("Unexpected page accepted")
    } catch let error as RecordError { #expect(error.code == "NOTION_PAGE_MISMATCH") }
  }
  @Test func testQueryMustMatchFilterAndFinishPagination() async throws {
    let wrong = pageResponse(
      id: questionPageID, source: questionsID, properties: ["問題キー": rich("120A2")])
    for response: [String: Any] in [
      ["object": "list", "results": [wrong], "has_more": false, "next_cursor": NSNull()],
      ["object": "list", "results": [], "has_more": false],
      ["object": "list", "results": [], "has_more": 0, "next_cursor": NSNull()],
    ] {
      let client = NotionClient(
        configuration: try testConfiguration(),
        transport: FixedResponse(response: try canonical(response)))
      do {
        _ = try await client.find(source: questionsID, property: "問題キー", key: "120A1")
        Issue.record("Invalid query result accepted")
      } catch {}
    }
  }
  @Test func testInvalidArchiveBooleanIsNotTrusted() async throws {
    var response = pageResponse(
      id: questionPageID, source: questionsID, properties: ["問題キー": rich("120A1")])
    response["archived"] = 0
    let client = NotionClient(
      configuration: try testConfiguration(),
      transport: FixedResponse(response: try canonical(response)))
    do {
      _ = try await client.get(questionPageID, source: questionsID)
      Issue.record("Numeric archive flag accepted")
    } catch {}
  }
  @Test func testDeadlineBeforeSendDoesNotClaimAnAmbiguousWrite() async throws {
    let base = CancelAwareTransport()
    let limited = DeadlineTransport(base: base, deadline: Date.distantPast, now: { Date() })
    do {
      _ = try await limited.request(method: "POST", path: "/pages", body: nil)
      Issue.record("Expired request sent")
    } catch let error as NotionFailure { #expect(!error.ambiguous) }
    #expect(await base.calls == 0)
  }
  @Test func testDeadlineDuringCreateCancelsAndRemainsAmbiguous() async throws {
    let base = CancelAwareTransport()
    let limited = DeadlineTransport(
      base: base, deadline: Date().addingTimeInterval(0.03), now: { Date() })
    let started = Date()
    do {
      _ = try await limited.request(method: "POST", path: "/pages", body: nil)
      Issue.record("Slow create not cancelled")
    } catch let error as NotionFailure {
      #expect(error.ambiguous)
      #expect(error.code == "NOTION_TIME_BUDGET")
    }
    #expect(Date().timeIntervalSince(started) < 1)
  }
  @Test func testNewlineCannotBypassIdentifierOrTokenValidation() throws {
    #expect(!matches("synthetic-token\n", "^[A-Za-z0-9_-]+$"))
    expectThrows(try URLSessionNotionTransport(token: String(repeating: "x", count: 24) + "\n"))
    let store = try temporaryStore()
    var event = fixtureEvent()
    event["question_key"] = "120A1\n"
    expectThrows(try store.append(eventJSON: canonical(event), routeJSON: fixtureRoute()))
    expectThrows(
      try store.append(
        eventJSON: canonical(fixtureEvent()), routeJSON: fixtureRoute("unresolved", set: "set-1")))
  }
  @Test func testRetryAfterSecondsAndInvalidValues() {
    #expect(URLSessionNotionTransport.retryAfter("120") == 120)
    #expect(URLSessionNotionTransport.retryAfter("invalid") == 0)
    #expect(URLSessionNotionTransport.retryAfter("-1") == 0)
  }
}
