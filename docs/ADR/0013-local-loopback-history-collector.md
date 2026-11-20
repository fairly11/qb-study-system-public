# ADR-0013: Local loopback history collector

- Status: Accepted
- Date: 2026-08-27
- Supersedes: none
- Related: ADR-0002, ADR-0005, ADR-0008, ADR-0012

## Context

ADR-0012 defined a provisional extension-local HTTP profile so the browser
outbox could be tested without changing `AttemptEventV1`. The extension already
fixes the loopback host, request path, payload, retry categories, and exact
success acknowledgement. The repository's storage package already validates
and appends attempts transactionally, but `services/history-collector` had no
network entrypoint.

The local user now needs a first-party collector process that can receive the
existing outbox and persist it into the SQLite source of truth. This decision
does not promote the unauthenticated profile to an external or public API.

## Decision

Implement `services/history-collector` as a Node.js 24 HTTP server with these
constraints:

- bind only IPv4 `127.0.0.1`; never bind `localhost`, `::`, `0.0.0.0`, or a
  configurable host;
- default to port `8765`, with only an explicit integer port from 1 through
  65535 configurable for the CLI;
- accept only `POST /v1/attempt-events` with no query or fragment;
- accept one uncompressed `application/json` body, bounded to 64 KiB;
- reject authorization, proxy authorization, cookies, non-loopback Host
  headers, other methods, other paths, and unsupported content types or
  encodings;
- emit no CORS permission;
- validate the decoded value with `validateAttemptEventV1`, then pass the same
  event to `HistoryCollectorStorage.appendAttempt` for independent storage
  validation and transactional persistence; and
- return HTTP 200 with exactly `{event_id, status}` only after `appendAttempt`
  returns `inserted` or `duplicate`.

The acknowledgement always uses the incoming event ID. It never returns the
storage layer's `existing_record_id`. An `IdempotencyConflictError` returns 409,
invalid input returns a bounded 4xx response, and unexpected storage failures
return 500. Response bodies contain only an allowlisted error code or the exact
success acknowledgement; they do not echo the request.

The CLI reads only `QB_STUDY_COLLECTOR_PORT` and `QB_STUDY_DB_PATH`. The host and
path are not configurable. The database path must be absolute; otherwise the
collector stops before listening. The existing storage default remains
`~/Library/Application Support/qb-study-system/qb-study.sqlite`.

No V1 contract, generated JSON Schema, or SQLite migration changes are made.
The server uses the existing append transaction, checksum-based replay
handling, append-only triggers, directory permissions, and database file
permissions.

## Consequences

- A success ACK means the attempt transaction has logically committed to
  SQLite. If the response is lost, a replay returns `duplicate` and can safely
  clear the outbox.
- Invalid or conflicting data is never acknowledged as delivered. Internal
  failures remain retryable through a 5xx response.
- The synchronous SQLite adapter can block the collector event loop during its
  configured busy timeout. The initial single-user loopback profile accepts
  that tradeoff.
- The transport has no authentication. A different process on the same machine
  can occupy the configured port, receive events, or forge acknowledgements.
  Authentication and endpoint ownership require a new Accepted ADR before this
  integration can be treated as an external production contract.
- WAL/SHM permissions, backup, existing parent-directory permissions, and disk
  encryption remain operational concerns from ADR-0002 and the security guide.
