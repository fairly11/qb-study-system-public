import { Buffer } from "node:buffer";
import {
  createServer,
  type IncomingMessage,
  type RequestListener,
  type Server,
  type ServerResponse,
} from "node:http";
import { TextDecoder } from "node:util";

import {
  validateAttemptEventV1,
  validateStudyAttemptEnvelopeV1,
  type AttemptEventV1,
} from "@qb-study/contracts";
import {
  IdempotencyConflictError,
  StorageValidationError,
  openSqliteHistoryCollectorStorage,
  type HistoryCollectorStorage,
} from "@qb-study/storage/history-collector";

import {
  DEFAULT_HISTORY_COLLECTOR_PORT,
  HISTORY_COLLECTOR_HOST,
} from "./config.js";
import type { ReviewSetResolution } from "./review-set-resolver.js";

export const ATTEMPT_EVENTS_PATH = "/v1/attempt-events";
export const STUDY_ATTEMPT_EVENTS_PATH = "/v2/attempt-events";
export const REVIEW_SETS_PATH = "/v1/review-sets/";
export const REVIEW_SET_CLIENT_HEADER = "x-qb-study-client";
export const MAX_REQUEST_BODY_BYTES = 64 * 1_024;

const MAX_HEADER_BYTES = 8_192;
const MAX_HEADERS_COUNT = 32;
const MAX_CONNECTIONS = 16;
const MAX_REQUESTS_PER_SOCKET = 100;
const REQUEST_TIMEOUT_MS = 15_000;
const HEADERS_TIMEOUT_MS = 10_000;
const KEEP_ALIVE_TIMEOUT_MS = 5_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;

type CollectorErrorCode =
  | "COLLECTOR_INTERNAL_ERROR"
  | "CONTENT_ENCODING_UNSUPPORTED"
  | "CONTENT_TYPE_UNSUPPORTED"
  | "HOST_HEADER_UNSUPPORTED"
  | "IDEMPOTENCY_CONFLICT"
  | "INVALID_ATTEMPT_EVENT"
  | "INVALID_JSON"
  | "METHOD_NOT_ALLOWED"
  | "REQUEST_BODY_READ_FAILED"
  | "REQUEST_BODY_TOO_LARGE"
  | "REQUEST_HEADERS_UNSUPPORTED"
  | "REVIEW_SET_RESOLUTION_UNAVAILABLE"
  | "ROUTE_NOT_FOUND";

interface ErrorEnvelope {
  readonly error_code: CollectorErrorCode;
}

interface AttemptDeliveryAck {
  readonly event_id: string;
  readonly status: "inserted" | "duplicate";
}

type RequestBodyResult =
  | { readonly ok: true; readonly text: string }
  | {
      readonly ok: false;
      readonly code: "REQUEST_BODY_READ_FAILED" | "REQUEST_BODY_TOO_LARGE";
    };

export interface AttemptCollectorHandlerOptions {
  readonly storage: HistoryCollectorStorage;
  readonly maxRequestBodyBytes?: number;
  readonly resolveReviewSet?: (questionSetId: string) => Promise<ReviewSetResolution>;
}

export interface StartHistoryCollectorOptions {
  readonly port?: number;
  readonly databasePath?: string;
  readonly storage?: HistoryCollectorStorage;
  readonly maxRequestBodyBytes?: number;
  readonly resolveReviewSet?: (questionSetId: string) => Promise<ReviewSetResolution>;
}

export interface RunningHistoryCollector {
  readonly host: typeof HISTORY_COLLECTOR_HOST;
  readonly port: number;
  readonly server: Server;
  close(): Promise<void>;
}

function writeJson(
  response: ServerResponse,
  statusCode: number,
  body: AttemptDeliveryAck | ErrorEnvelope | ReviewSetResolution,
  extraHeaders: Readonly<Record<string, string>> = {},
): void {
  const payload = JSON.stringify(body);
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload, "utf8"),
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
    ...extraHeaders,
  });
  response.end(payload);
}

function writeError(
  response: ServerResponse,
  statusCode: number,
  errorCode: CollectorErrorCode,
  extraHeaders?: Readonly<Record<string, string>>,
): void {
  writeJson(response, statusCode, { error_code: errorCode }, extraHeaders);
}

function isJsonContentType(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }
  const normalized = value.toLowerCase().replaceAll(" ", "");
  return normalized === "application/json"
    || normalized === "application/json;charset=utf-8";
}

function isSafeHostHeader(request: IncomingMessage): boolean {
  const localPort = request.socket.localPort;
  return localPort !== undefined
    && request.headers.host === `${HISTORY_COLLECTOR_HOST}:${localPort}`;
}

function hasUnsupportedHeaders(request: IncomingMessage): boolean {
  return request.headers.authorization !== undefined
    || request.headers.cookie !== undefined
    || request.headers["proxy-authorization"] !== undefined;
}

function hasUnsupportedContentEncoding(request: IncomingMessage): boolean {
  const encoding = request.headers["content-encoding"];
  return encoding !== undefined && encoding.toLowerCase() !== "identity";
}

function readRequestBody(
  request: IncomingMessage,
  maximumBytes: number,
): Promise<RequestBodyResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let byteLength = 0;
    let tooLarge = false;
    let settled = false;

    const finish = (result: RequestBodyResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
    };

    request.on("data", (chunk: Buffer | string) => {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      byteLength += buffer.byteLength;
      if (byteLength > maximumBytes) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      if (!tooLarge) {
        chunks.push(buffer);
      }
    });
    request.on("end", () => {
      if (tooLarge) {
        finish({ ok: false, code: "REQUEST_BODY_TOO_LARGE" });
        return;
      }
      try {
        const decoder = new TextDecoder("utf-8", { fatal: true });
        finish({ ok: true, text: decoder.decode(Buffer.concat(chunks)) });
      } catch {
        finish({ ok: false, code: "REQUEST_BODY_READ_FAILED" });
      }
    });
    request.on("aborted", () => {
      finish({ ok: false, code: "REQUEST_BODY_READ_FAILED" });
    });
    request.on("error", () => {
      finish({ ok: false, code: "REQUEST_BODY_READ_FAILED" });
    });
  });
}

function parseJson(input: string):
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false } {
  try {
    return { ok: true, value: JSON.parse(input) as unknown };
  } catch {
    return { ok: false };
  }
}

function isAttemptEvent(value: unknown): value is AttemptEventV1 {
  return validateAttemptEventV1(value);
}

export function createAttemptCollectorRequestHandler(
  options: AttemptCollectorHandlerOptions,
): RequestListener {
  const maximumBytes = options.maxRequestBodyBytes ?? MAX_REQUEST_BODY_BYTES;
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new RangeError("INVALID_MAX_REQUEST_BODY_BYTES");
  }

  return (request, response) => {
    void (async () => {
      const reviewSetId = /^\/v1\/review-sets\/([A-Za-z0-9_-]{1,100})$/u.exec(request.url ?? "")?.[1];
      if (reviewSetId !== undefined) {
        if (request.method !== "GET") {
          writeError(response, 405, "METHOD_NOT_ALLOWED", { allow: "GET" }); request.resume(); return;
        }
        if (!isSafeHostHeader(request)) {
          writeError(response, 400, "HOST_HEADER_UNSUPPORTED"); request.resume(); return;
        }
        if (hasUnsupportedHeaders(request) || request.headers[REVIEW_SET_CLIENT_HEADER] !== "browser-extension"
          || request.headers["transfer-encoding"] !== undefined
          || (request.headers["content-length"] !== undefined && request.headers["content-length"] !== "0")) {
          writeError(response, 400, "REQUEST_HEADERS_UNSUPPORTED"); request.resume(); return;
        }
        if (hasUnsupportedContentEncoding(request)) {
          writeError(response, 415, "CONTENT_ENCODING_UNSUPPORTED"); request.resume(); return;
        }
        request.resume();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          if (options.resolveReviewSet === undefined) throw new Error("REVIEW_SET_RESOLUTION_UNAVAILABLE");
          const result = await Promise.race([options.resolveReviewSet(reviewSetId), new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("REVIEW_SET_RESOLUTION_UNAVAILABLE")), 10_000);
            timer.unref();
          })]);
          if (result.schema_version !== "1" || result.question_set_id !== reviewSetId
            || (result.study_mode !== "normal" && result.study_mode !== "review")
            || (result.study_mode === "review" && !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(result.review_plan_id))) {
            throw new Error("REVIEW_SET_RESOLUTION_UNAVAILABLE");
          }
          writeJson(response, 200, result.study_mode === "review"
            ? { schema_version: "1", question_set_id: reviewSetId, study_mode: "review", review_plan_id: result.review_plan_id }
            : { schema_version: "1", question_set_id: reviewSetId, study_mode: "normal" });
        } catch {
          writeError(response, 503, "REVIEW_SET_RESOLUTION_UNAVAILABLE");
        } finally { if (timer !== undefined) clearTimeout(timer); }
        return;
      }
      if (request.url !== ATTEMPT_EVENTS_PATH && request.url !== STUDY_ATTEMPT_EVENTS_PATH) {
        writeError(response, 404, "ROUTE_NOT_FOUND");
        request.resume();
        return;
      }
      if (request.method !== "POST") {
        writeError(response, 405, "METHOD_NOT_ALLOWED", { allow: "POST" });
        request.resume();
        return;
      }
      if (!isSafeHostHeader(request)) {
        writeError(response, 400, "HOST_HEADER_UNSUPPORTED");
        request.resume();
        return;
      }
      if (hasUnsupportedHeaders(request)) {
        writeError(response, 400, "REQUEST_HEADERS_UNSUPPORTED");
        request.resume();
        return;
      }
      if (hasUnsupportedContentEncoding(request)) {
        writeError(response, 415, "CONTENT_ENCODING_UNSUPPORTED");
        request.resume();
        return;
      }
      if (!isJsonContentType(request.headers["content-type"])) {
        writeError(response, 415, "CONTENT_TYPE_UNSUPPORTED");
        request.resume();
        return;
      }

      const body = await readRequestBody(request, maximumBytes);
      if (!body.ok) {
        writeError(
          response,
          body.code === "REQUEST_BODY_TOO_LARGE" ? 413 : 400,
          body.code,
        );
        return;
      }

      const parsed = parseJson(body.text);
      if (!parsed.ok) {
        writeError(response, 400, "INVALID_JSON");
        return;
      }
      const isStudyEnvelope = request.url === STUDY_ATTEMPT_EVENTS_PATH;
      if (isStudyEnvelope ? !validateStudyAttemptEnvelopeV1(parsed.value) : !isAttemptEvent(parsed.value)) {
        writeError(response, 400, "INVALID_ATTEMPT_EVENT");
        return;
      }

      try {
        const result = isStudyEnvelope && validateStudyAttemptEnvelopeV1(parsed.value)
          ? options.storage.appendStudyAttempt(parsed.value)
          : options.storage.appendAttempt(parsed.value as AttemptEventV1);
        writeJson(response, 200, {
          event_id: result.record_id,
          status: result.status,
        });
      } catch (error) {
        if (error instanceof IdempotencyConflictError) {
          writeError(response, 409, "IDEMPOTENCY_CONFLICT");
          return;
        }
        if (error instanceof StorageValidationError) {
          writeError(response, 400, "INVALID_ATTEMPT_EVENT");
          return;
        }
        writeError(response, 500, "COLLECTOR_INTERNAL_ERROR");
      }
    })().catch(() => {
      if (!response.headersSent) {
        writeError(response, 500, "COLLECTOR_INTERNAL_ERROR");
      } else if (!response.writableEnded) {
        response.end();
      }
    });
  };
}

export function createAttemptCollectorServer(
  options: AttemptCollectorHandlerOptions,
): Server {
  const server = createServer(
    {
      insecureHTTPParser: false,
      maxHeaderSize: MAX_HEADER_BYTES,
    },
    createAttemptCollectorRequestHandler(options),
  );
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
  server.maxHeadersCount = MAX_HEADERS_COUNT;
  server.maxConnections = MAX_CONNECTIONS;
  server.maxRequestsPerSocket = MAX_REQUESTS_PER_SOCKET;
  return server;
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(port, HISTORY_COLLECTOR_HOST, () => {
      server.off("error", onError);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const forceClose = setTimeout(() => {
      server.closeAllConnections();
    }, SHUTDOWN_TIMEOUT_MS);
    forceClose.unref();
    server.close((error) => {
      clearTimeout(forceClose);
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
}

export async function startHistoryCollector(
  options: StartHistoryCollectorOptions = {},
): Promise<RunningHistoryCollector> {
  const requestedPort = options.port ?? DEFAULT_HISTORY_COLLECTOR_PORT;
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65_535) {
    throw new RangeError("INVALID_COLLECTOR_PORT");
  }
  if (
    options.maxRequestBodyBytes !== undefined
    && (
      !Number.isSafeInteger(options.maxRequestBodyBytes)
      || options.maxRequestBodyBytes < 1
    )
  ) {
    throw new RangeError("INVALID_MAX_REQUEST_BODY_BYTES");
  }

  const ownsStorage = options.storage === undefined;
  const storage = options.storage ?? openSqliteHistoryCollectorStorage({
    ...(options.databasePath === undefined
      ? {}
      : { databasePath: options.databasePath }),
  });
  let server: Server;
  try {
    server = createAttemptCollectorServer({
      storage,
      ...(options.resolveReviewSet === undefined ? {} : { resolveReviewSet: options.resolveReviewSet }),
      ...(options.maxRequestBodyBytes === undefined
        ? {}
        : { maxRequestBodyBytes: options.maxRequestBodyBytes }),
    });
    await listen(server, requestedPort);
  } catch (error) {
    if (ownsStorage) {
      storage.close();
    }
    throw error;
  }

  const address = server.address();
  if (address === null || typeof address === "string") {
    await closeServer(server);
    if (ownsStorage) {
      storage.close();
    }
    throw new Error("COLLECTOR_ADDRESS_UNAVAILABLE");
  }
  if (address.address !== HISTORY_COLLECTOR_HOST || address.family !== "IPv4") {
    await closeServer(server);
    if (ownsStorage) {
      storage.close();
    }
    throw new Error("COLLECTOR_BINDING_UNSAFE");
  }

  let closed = false;
  return Object.freeze({
    host: HISTORY_COLLECTOR_HOST,
    port: address.port,
    server,
    async close(): Promise<void> {
      if (closed) {
        return;
      }
      closed = true;
      try {
        await closeServer(server);
      } finally {
        if (ownsStorage) {
          storage.close();
        }
      }
    },
  });
}
