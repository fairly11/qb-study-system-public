import Foundation
import SafariServices
import os

final class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
  func beginRequest(with context: NSExtensionContext) {
    let reply = ExtensionReply(context)
    guard let item = context.inputItems.first as? NSExtensionItem,
      let message = item.userInfo?[SFExtensionMessageKey],
      JSONSerialization.isValidJSONObject(message),
      let messageData = try? JSONSerialization.data(withJSONObject: message)
    else {
      reply.complete(["protocol_version": 1, "ok": false, "code": "MESSAGE_INVALID"])
      return
    }
    // Only an immutable JSON snapshot and the synchronized reply cross into the task.
    Task {
      let response: [String: Any]
      do {
        let message = try JSONSerialization.jsonObject(with: messageData)
        response = await NativeDispatcher(environment: try AppEnvironment()).handle(message)
      } catch {
        response = ["protocol_version": 1, "ok": false, "code": AppEnvironment.safeCode(error)]
      }
      reply.complete(response)
    }
  }
}

private struct ExtensionReply: Sendable {
  // After the input snapshot, all application access to this context is under the lock.
  // Clearing it inside the critical section makes completion single-use.
  private let context: OSAllocatedUnfairLock<NSExtensionContext?>

  init(_ context: NSExtensionContext) {
    self.context = OSAllocatedUnfairLock(uncheckedState: context)
  }

  func complete(_ response: [String: Any]) {
    // This closure runs synchronously; the response dictionary never escapes it.
    context.withLockUnchecked { pending in
      guard let context = pending else { return }
      pending = nil
      let item = NSExtensionItem()
      item.userInfo = [SFExtensionMessageKey: response]
      context.completeRequest(returningItems: [item], completionHandler: nil)
    }
  }
}
