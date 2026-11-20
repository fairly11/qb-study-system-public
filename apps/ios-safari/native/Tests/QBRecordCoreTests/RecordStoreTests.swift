import Foundation
import Testing

@testable import QBRecordCore

func fixtureEvent(
  id: String = "11111111-1111-4111-8111-111111111111",
  answered: String = "2026-10-24T12:34:56.123+09:00"
) -> [String: Any] {
  [
    "schema_version": "1", "record_type": "attempt_event", "event_id": id, "question_key": "120A1",
    "answered_at": answered, "result": "correct", "selected_option_indices": [1],
    "provenance": [
      "producer": "browser-extension", "producer_version": "ios-0.1.0",
      "source_system": "qb-web-dom", "source_record_id": "synthetic-session",
      "recorded_at": answered,
    ],
    "quality": [
      "acquisition_method": "direct_capture", "temporal_precision": "exact",
      "state_precision": "exact",
    ],
  ]
}
func fixtureRoute(_ source: String = "observed_navigation", set: String? = nil) throws -> Data {
  var value: [String: Any] = [
    "quiz_id": "22222222-2222-4222-8222-222222222222", "entry_source": source,
  ]
  if let set { value["set_id"] = set }
  return try canonical(value)
}
func temporaryStore() throws -> IOSRecordStore {
  try IOSRecordStore(
    directory: FileManager.default.temporaryDirectory.appendingPathComponent(
      "qb-core-test-" + UUID().uuidString))
}

struct RecordStoreTests {
  @Test func testDurabilityDeviceIdentityIdempotenceAndGenuineRepeat() throws {
    let store = try temporaryStore()
    let event = try canonical(fixtureEvent())
    expectEqual(try store.append(eventJSON: event, routeJSON: fixtureRoute()).status, "local_saved")
    let reopened = try IOSRecordStore(directory: store.directory)
    expectEqual(try store.deviceID(), try reopened.deviceID())
    _ = try reopened.append(eventJSON: event, routeJSON: fixtureRoute())
    expectEqual(try reopened.status().saved, 1)
    _ = try reopened.append(
      eventJSON: canonical(fixtureEvent(id: "33333333-3333-4333-8333-333333333333")),
      routeJSON: fixtureRoute())
    expectEqual(try store.status().saved, 2)
    expectEqual(try store.status().confirmed, 0)
    let provenance = try store.attempts()[0].event["provenance"] as! [String: Any]
    expectEqual(
      provenance["source_record_id"] as? String,
      "ios:" + (try store.deviceID()) + ":22222222-2222-4222-8222-222222222222")
    expectEqual(try store.attempts()[0].event["answered_at"] as? String, "2026-10-24T03:34:56.123Z")
  }
  @Test func testSameIDChangedPayloadOrRouteCannotOverwriteEvidence() throws {
    let store = try temporaryStore()
    _ = try store.append(eventJSON: canonical(fixtureEvent()), routeJSON: fixtureRoute())
    var changed = fixtureEvent()
    changed["result"] = "incorrect"
    expectThrows(try store.append(eventJSON: canonical(changed), routeJSON: fixtureRoute()))
    expectThrows(
      try store.append(eventJSON: canonical(fixtureEvent()), routeJSON: fixtureRoute("unresolved")))
    expectEqual(try store.status().saved, 1)
    expectEqual(try store.attempts()[0].event["result"] as? String, "correct")
  }
  @Test func testRejectsUnexpectedContentSnapshotBooleanIndicesAndBadDates() throws {
    let store = try temporaryStore()
    var content = fixtureEvent()
    content["question_text"] = "forbidden synthetic property"
    var snapshot = fixtureEvent()
    snapshot["record_type"] = "history_snapshot"
    var boolean = fixtureEvent()
    boolean["selected_option_indices"] = [true]
    var duplicate = fixtureEvent()
    duplicate["selected_option_indices"] = [1, 1]
    for invalid in [
      content, snapshot, boolean, duplicate, fixtureEvent(answered: "2026-02-30T12:34:56Z"),
      fixtureEvent(answered: "2026-10-24"),
    ] {
      expectThrows(try store.append(eventJSON: canonical(invalid), routeJSON: fixtureRoute()))
    }
    expectEqual(try store.status().saved, 0)
  }
  @Test func testRejectedRouteDoesNotPartiallySaveAttempt() throws {
    let store = try temporaryStore()
    expectThrows(
      try store.append(
        eventJSON: canonical(fixtureEvent()),
        routeJSON: canonical([
          "quiz_id": "safe", "entry_source": "normal", "url": "https://example.invalid",
        ])))
    expectEqual(try store.status().saved, 0)
  }
  @Test func testManualRouteMetadataIsBoundedAndImmutable() throws {
    let store = try temporaryStore()
    var route = try object(fixtureRoute())
    route["classification_policy"] = "normal_default_v1"
    route["manual_study_mode"] = "review"
    _ = try store.append(eventJSON: canonical(fixtureEvent()), routeJSON: canonical(route))
    route["manual_study_mode"] = "normal"
    expectThrows(try store.append(eventJSON: canonical(fixtureEvent()), routeJSON: canonical(route)))
    #expect(try store.attempts()[0].route["manual_study_mode"] as? String == "review")
    for invalid: Any in ["unclassified", 1, true] {
      route["manual_study_mode"] = invalid
      expectThrows(try validateRoute(canonical(route)))
    }
    route["manual_study_mode"] = "normal"
    route["classification_policy"] = "invented"
    expectThrows(try validateRoute(canonical(route)))
  }
  @Test func testCrossInstanceLockAndReleaseAndTargetPin() throws {
    let store = try temporaryStore()
    let second = try IOSRecordStore(directory: store.directory)
    var held = try store.acquireSyncLock()
    expectNotNil(held)
    expectNil(try second.acquireSyncLock())
    held = nil
    expectNotNil(try second.acquireSyncLock())
    try store.pinTarget("first")
    expectThrows(try second.pinTarget("second"))
  }
  @Test func testImmutableContextAndSafeErrors() throws {
    let store = try temporaryStore()
    let id = fixtureEvent()["event_id"] as! String
    _ = try store.append(eventJSON: canonical(fixtureEvent()), routeJSON: fixtureRoute())
    let normal = try contextData(
      eventID: id, resolution: ReviewResolution(studyMode: "normal", reviewPlanID: nil))
    try store.appendContext(eventID: id, data: normal)
    expectThrows(
      try store.appendContext(
        eventID: id,
        data: contextData(
          eventID: id, resolution: ReviewResolution(studyMode: "unclassified", reviewPlanID: nil))))
    expectEqual(RecordError("unsafe secret payload").description, "RECORD_UNAVAILABLE")
  }
  @Test func testSharedTypeScriptV1ContractFixtures() throws {
    var root = URL(fileURLWithPath: #filePath)
    for _ in 0..<6 { root.deleteLastPathComponent() }
    let valid = try Data(
      contentsOf: root.appendingPathComponent(
        "tests/fixtures/contracts/valid-attempt-event-v1.json"))
    let invalid = try Data(
      contentsOf: root.appendingPathComponent(
        "tests/fixtures/contracts/invalid-attempt-event-v1.json"))
    let value = try validateAttempt(valid)
    #expect(value.0 == "00000000-0000-4000-8000-000000000001")
    #expect(value.1 == "119A12")
    expectThrows(try validateAttempt(invalid))
  }

}
