import CoreFoundation
import Foundation
import QBRecordCore

struct NativeDispatcher {
  let environment: AppEnvironment

  func handle(_ request: Any) async -> [String: Any] {
    do {
      guard let message = request as? [String: Any],
        let version = message["protocol_version"] as? NSNumber,
        CFGetTypeID(version) != CFBooleanGetTypeID(), version == 1,
        let command = message["command"] as? String
      else { throw RecordError("MESSAGE_INVALID") }
      switch command {
      case "ingest":
        guard Set(message.keys) == Set(["protocol_version", "command", "event", "route"]),
          let event = message["event"] as? [String: Any],
          let route = message["route"] as? [String: Any]
        else { throw RecordError("MESSAGE_INVALID") }
        let receipt = try environment.store.append(
          eventJSON: JSONSerialization.data(withJSONObject: event),
          routeJSON: JSONSerialization.data(withJSONObject: route))
        var response = try status()
        response["event_id"] = receipt.eventID
        response["status"] = receipt.status
        return response
      case "status":
        guard Set(message.keys).isSubset(of: ["protocol_version", "command", "event_id"]) else {
          throw RecordError("MESSAGE_INVALID")
        }
        var response = try status()
        if message["event_id"] != nil {
          guard let eventID = message["event_id"] as? String, UUID(uuidString: eventID) != nil
          else { throw RecordError("MESSAGE_INVALID") }
          response["event_id"] = eventID
          response["status"] = try environment.store.eventStatus(eventID: eventID)
        }
        return response
      case "study_mode":
        guard Set(message.keys) == Set(["protocol_version", "command", "route"]),
          let route = message["route"] as? [String: Any]
        else { throw RecordError("MESSAGE_INVALID") }
        let resolution = try await environment.previewStudyMode(routeJSON: JSONSerialization.data(withJSONObject: route))
        return ["protocol_version": 1, "ok": true, "study_mode": resolution.studyMode]
      case "sync":
        guard Set(message.keys) == Set(["protocol_version", "command"]) else {
          throw RecordError("MESSAGE_INVALID")
        }
        let report = try await environment.sync()
        var response = try status()
        if let code = report.code { response["code"] = code }
        return response
      default: throw RecordError("MESSAGE_INVALID")
      }
    } catch {
      return ["protocol_version": 1, "ok": false, "code": AppEnvironment.safeCode(error)]
    }
  }

  private func status() throws -> [String: Any] {
    let value = try environment.store.status()
    return [
      "protocol_version": 1, "ok": true, "saved": value.saved, "pending": value.pending,
      "confirmed": value.confirmed, "blocked": value.blocked,
    ]
  }
}
