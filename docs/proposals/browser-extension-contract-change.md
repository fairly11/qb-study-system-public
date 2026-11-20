# Browser extension V1 compatibility decision and collector boundary

- Status: Resolved — no V1 contract change required
- Date: 2026-08-26
- Scope: Browser extension capture and collector HTTP boundary

## Conclusion

The reviewed QB DOM contract can produce the existing `AttemptEventV1` without
changing `packages/contracts`, its V1 public TypeScript type, or its generated
JSON Schema. The browser extension must omit facts that V1 does not model and
must emit nothing when required V1 evidence is absent. No contract-change
proposal is being advanced by this document.

`AttemptEventV1` requires a non-empty, unique array of explicit one-based
`selected_option_indices`. The user authorized reading those indices when they
are unambiguous on screen. That authorization satisfies the existing V1
requirement; it does not add a field or change its meaning.

The task also identifies possible values that have no corresponding V1 field:

- QB question ID
- session ID
- source device
- Again, Hard, Good, or Easy self-rating

`AttemptEventV1` rejects additional properties. Existing fields such as
`question_group_id` and `provenance.source_record_id` must not be repurposed to
carry values with different meanings. The V1 browser payload omits all four
values.

## Consent and evidence boundary

The production content script is statically limited to the reviewed QB quiz
target, but its capture path remains inactive until the user explicitly starts
recording for the current document. Consent is document-scoped and ephemeral.
Closing the popup is no action. Declining suppresses automatic prompting for
that document but does not prevent a later manual start. Same-document `/quiz`
updates retain that decision and capture state; a verified new document requires
a new decision.

`chrome.action.openPopup()` is used only to present the choice and requires
Chrome 127 or later for a generally installed extension. If that API is absent
or its call rejects, a tab-specific badge and title request manual attention;
failure never implies consent. A stale or unreachable document instead has its
ephemeral session removed and capture remains off.

The service worker reconciles both `loading` and `complete` tab updates against
the exact stored document rather than treating an update notification as proof
of replacement. An active new `/quiz` document receives one automatic popup;
same-document updates retain the already-attempted popup state.

After consent, the extension may create `AttemptEventV1` only when all of the
following are observed through the reviewed production adapter:

1. the exact runtime origin is `https://qb.medilink-study.com` and pathname is
   `/quiz` in the top frame;
2. one unambiguous normalized question key is present;
3. exactly four or five options, matching the reviewed live structures,
   establish an unambiguous DOM-order to one-based-index mapping;
4. at least one explicit, unique selected-option index is present;
5. result and marker structure are supported; and
6. the same question transitions from pending to resolved while capture is
   active.

After a terminal result, a different supported question key starts the next
pending-to-resolved cycle in the same document. This continuation has no fixed
question-count limit.

An initially rendered result is accepted only as the capture baseline and
produces no event. An unknown selector layout, ambiguous option mapping, stale
or unconsented sender, or missing required value is rejected without an event.
A resolved state with no selected option is represented only inside the adapter
as `resolved_without_selection`; it is not converted to
`correct`, `incorrect`, or `unknown` and is not persisted as history.

The adapter derives correct-option indices transiently to compare the correct
set with the selected set. Correct-option indices are not part of
`AttemptEventV1`; they must not leave the local adapter computation or appear in
messages, payloads, outbox state, diagnostics, or logs. Content-free synthetic
fixtures may reproduce marker placement for adapter tests, but they do not store
real-site answers or a serialized correct-index field.

## Provisional collector HTTP profile

The history-collector package does not publish an accepted authenticated
external HTTP contract. The extension and the first-party local collector use
this local profile without changing V1:

- `POST` one strict `AttemptEventV1` JSON object to a configured loopback
  endpoint;
- default endpoint: `http://127.0.0.1:8765/v1/attempt-events`;
- the loopback port is configurable, but the path is fixed to
  `/v1/attempt-events`;
- no credentials, cookies, authorization headers, redirects, query, or URL
  fragment;
- acknowledge deletion from the outbox only for a 2xx JSON response whose
  exact shape is `{ "event_id": "<same UUID>", "status": "inserted" }` or
  `{ "event_id": "<same UUID>", "status": "duplicate" }`;
- retry network failures, HTTP 429, and 5xx responses; and
- retain but block automatic retry for other responses or malformed
  acknowledgements.

This collector profile is extension-local and does not change V1. It has no
collector authentication: a different local process that owns the configured
port could receive an event and forge an acknowledgement. Authentication and
endpoint ownership require a separate accepted integration decision before
external production distribution.

ADR-0013 accepts a local-only server implementation of this profile. It does
not promote the profile to a public or externally distributed contract.

## Conditions for future V2 work

If product requirements later require the QB question ID, session, source
device, self-rating, or correct-option indices outside the adapter, define their
semantics, privacy classification, idempotency impact, and validation constraints
in a new contract version. Do not modify the published V1 schema in place and do
not use this resolved document as authorization for those fields.
