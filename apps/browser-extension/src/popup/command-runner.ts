import type {
  CommandResponseV1,
  PopupRequestMessageV1,
} from "../shared/protocol.js";

export interface PopupCommandPorts {
  readonly setBusy: (busy: boolean) => void;
  readonly renderCode: (code: string) => void;
  readonly sendMessage: (message: PopupRequestMessageV1) => Promise<unknown>;
  readonly refreshAllStatus: () => Promise<boolean>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): boolean {
  const actualKeys = Object.keys(value).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();
  return actualKeys.length === sortedExpectedKeys.length
    && actualKeys.every((key, index) => key === sortedExpectedKeys[index]);
}

function isCommandResponse(value: unknown): value is CommandResponseV1 {
  return isRecord(value)
    && hasExactKeys(value, ["ok", "code"])
    && typeof value.ok === "boolean"
    && typeof value.code === "string";
}

export async function runPopupCommand(
  message: PopupRequestMessageV1,
  ports: PopupCommandPorts,
): Promise<void> {
  ports.setBusy(true);
  ports.renderCode("popup_command_pending");
  try {
    const response = await ports.sendMessage(message);
    if (!isCommandResponse(response)) {
      ports.renderCode("popup_command_response_invalid");
      return;
    }

    if (await ports.refreshAllStatus()) {
      ports.renderCode(response.code);
    }
  } catch {
    ports.renderCode("popup_runtime_unavailable");
  } finally {
    ports.setBusy(false);
  }
}
