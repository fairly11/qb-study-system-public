import type { AttemptEventV1, StudyContextV1 } from "@qb-study/contracts";

import {
  BACKGROUND_STORAGE_KEY,
  COLLECTOR_REQUEST_TIMEOUT_MS,
  RETRY_ALARM_NAME,
  type BackgroundStateV1,
  type BackgroundStoragePort,
  type ClockPort,
  type CollectorTransportPort,
  type RetrySchedulerPort,
  type TransportResponse,
} from "./types.js";

function chromeOperationError(): Error {
  return new Error("CHROME_OPERATION_BLOCKED");
}

export function createChromeStoragePort(
  storageArea: chrome.storage.StorageArea = chrome.storage.local,
): BackgroundStoragePort {
  return {
    read(): Promise<unknown> {
      return new Promise((resolve, reject) => {
        storageArea.get(BACKGROUND_STORAGE_KEY, (items) => {
          if (chrome.runtime.lastError !== undefined) {
            reject(chromeOperationError());
            return;
          }
          resolve(items[BACKGROUND_STORAGE_KEY]);
        });
      });
    },
    write(state: BackgroundStateV1): Promise<void> {
      return new Promise((resolve, reject) => {
        storageArea.set({ [BACKGROUND_STORAGE_KEY]: state }, () => {
          if (chrome.runtime.lastError !== undefined) {
            reject(chromeOperationError());
            return;
          }
          resolve();
        });
      });
    },
  };
}

export function createChromeRetrySchedulerPort(): RetrySchedulerPort {
  return {
    async schedule(atEpochMilliseconds: number): Promise<void> {
      await chrome.alarms.create(RETRY_ALARM_NAME, { when: atEpochMilliseconds });
    },
    clear(): Promise<void> {
      return new Promise((resolve, reject) => {
        chrome.alarms.clear(RETRY_ALARM_NAME, () => {
          if (chrome.runtime.lastError !== undefined) {
            reject(chromeOperationError());
            return;
          }
          resolve();
        });
      });
    },
  };
}

export async function restrictChromeStorageToTrustedContexts(): Promise<void> {
  await chrome.storage.local.setAccessLevel({
    accessLevel: "TRUSTED_CONTEXTS",
  });
}

export function createSystemClockPort(): ClockPort {
  return { now: () => Date.now() };
}

async function parseAcknowledgment(response: Response): Promise<unknown> {
  if (response.status < 200 || response.status > 299) {
    return null;
  }
  try {
    return await response.json() as unknown;
  } catch {
    return null;
  }
}

export function createFetchCollectorTransportPort(): CollectorTransportPort {
  return {
    async postAttempt(
      endpoint: string,
      event: AttemptEventV1,
      context?: StudyContextV1,
    ): Promise<TransportResponse> {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify(context === undefined ? event : { attempt: event, context }),
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        signal: AbortSignal.timeout(COLLECTOR_REQUEST_TIMEOUT_MS),
      });
      return {
        status: response.status,
        body: await parseAcknowledgment(response),
      };
    },
  };
}
