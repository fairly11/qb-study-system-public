# History collector

Optional Notion synchronization is implemented behind the existing local capture
boundary. See [the setup and recovery guide](../../docs/NOTION_SYNC.md) and
[ADR-0014](../../docs/ADR/0014-notion-shared-original.md). The local ACK still means
durable local storage, not confirmed Notion delivery. Without configuration the
collector continues local-only operation.

`@qb-study/history-collector` is the local HTTP boundary between the browser
extension outbox and the append-only SQLite source of truth. It accepts one
strict `AttemptEventV1` at a time and acknowledges the event only after the
SQLite append transaction has committed or an identical replay has been
identified.

## Run

From the repository root:

```sh
pnpm --filter @qb-study/history-collector start
```

The default listener and database are:

```text
http://127.0.0.1:8765/v1/attempt-events
~/Library/Application Support/qb-study-system/qb-study.sqlite
```

The listener host and path are fixed. Only the port and absolute database path
can be changed:

```sh
QB_STUDY_COLLECTOR_PORT=9876 \
QB_STUDY_DB_PATH="/absolute/path/qb-study.sqlite" \
pnpm --filter @qb-study/history-collector start
```

Startup and shutdown output contains only a component name, an allowlisted
event code, and the numeric port. It does not print the database path, request
body, event fields, headers, stack, or free-form error messages. Send `SIGINT`
or `SIGTERM` for graceful shutdown.

## Local HTTP profile

The only accepted route is `POST /v1/attempt-events` with uncompressed
`application/json`. The request body is limited to 64 KiB and must validate as
exactly one `AttemptEventV1`. Authorization, proxy authorization, cookies,
query strings, other paths, and non-loopback Host headers are rejected. The
server does not emit CORS headers.

Successful responses use HTTP 200 and exactly one of these bodies:

```json
{"event_id":"10000000-0000-4000-8000-000000000001","status":"inserted"}
```

```json
{"event_id":"10000000-0000-4000-8000-000000000001","status":"duplicate"}
```

An idempotency conflict returns 409. Malformed or unsupported requests return a
bounded 4xx error envelope, and unexpected storage failures return 500 so the
extension retains the event for retry. Error responses never echo input.

This is a first-party, local-only implementation of the extension's loopback
profile. It is not an authenticated public collector contract. Another local
process can still occupy the port or impersonate the collector; do not expose
this profile as an external or network-reachable service.

## Verify

```sh
pnpm --filter @qb-study/history-collector verify
```

Tests use content-free synthetic events, temporary SQLite databases, and an
ephemeral IPv4 loopback port. They cover inserted and duplicate ACKs,
idempotency conflicts, input rejection, body limits, binding safety, graceful
shutdown, and the one-event outbox transition from one pending item to zero.
