# QB study browser extension

This Manifest V3 extension automatically captures supported QB answer-result
transitions on `/quiz`, under the user's site-wide recording instruction.
It persists each actual answer to an outbox and sends it to the same Mac's
loopback collector. It never answers questions or changes QB state.

## Automatic recording and study classification

The URL-only bootstrap is registered on `https://qb.medilink-study.com:443/*`.
Navigation API events, browser history events, and a bounded URL check detect
SPA transitions from the set/search screens into `/quiz` without a reload.
Only the exact HTTPS origin, top frame, and `/quiz` path enable the reviewed
answer DOM adapter. Other pages are used only to observe navigation context.

The background verifies each document and route using a document-scoped probe.
No `tabs`, `webNavigation`, cookies, or QB network-interception permission is added.
A route probe compares the browser-provided sender URL with the content script's
current URL; URLs are not persisted in the route store. The session-only store keeps
a bounded set ID, document ID, route kind, and previous question ID. These identify
a same-question reload without retaining a stale review purpose on a new visit.

Recording starts before the review-set lookup finishes so that a quick first
answer can be captured. Candidate acceptance waits for the session's study
context to settle. Each stored attempt retains its original context through
retries and worker restarts.

- Opening a supported problem screen starts recording automatically.
- A `/search?questionSetId=...` route carries its exact set ID into the following
  quiz. The local collector checks verified daily-publication records or the
  shared Notion candidate pages. Only a verified system set is `review`.
- Other confirmed sets, ordinary quiz entry, and valid quiz entries whose set origin was lost are `normal`. Question membership,
  set-name prefixes, and sort order are never evidence of a review session.
- An invalid set identifier or unavailable set lookup remains `unclassified`;
  recording continues and the popup displays `判定未確認`.
- The popup offers `通常学習` and `復習課題` buttons for the current exercise.
  Manual selection applies only to future answers, supersedes pending automatic
  classification, and does not change stored attempts or invent a review-plan ID.
  Pause/resume keeps the chosen mode for that exercise. A new exercise starts
  automatically. Paused results are not backfilled on resume.
- Closing/replacing a tab drops session context; persisted outbox entries remain.
- Already-visible results are deliberately ignored. Only observed answer
  transitions produce attempts, as before.

Daily sets retain the publisher's verified `追加日が古い順` order. The extension
never changes the site's sort preference or set membership.

See [ADR-0017](../../docs/ADR/0017-automatic-qb-capture.md) for the authorization,
classification evidence, and migration policy.

## Reviewed DOM contract

The production adapter implements only the reviewed, observed `/quiz` DOM
contract. Selectors and class tokens are centralized in the QB quiz adapter.
It requires exactly one supported question key and question card, plus exactly
two nested ancestors matching the reviewed quiz-root selector. The closer
ancestor is the functional root and the other is the observed outer layout
wrapper. The card must contain exactly four or five option buttons, the two
counts observed on supported QB pages. No result marker in
the functional root means pending; once a result marker appears, selected-option
markers must be internally consistent. With a non-empty selection,
every `bg-qb-sky` element must partition into either an exact correct badge or
one exact reviewed progress fill per option; correct-option badges must also
match the reviewed direct-first-child structure. Main/key/card
ambiguity, a missing or unexpected root-ancestor count, an option count other
than four or five, inconsistent selected markers, or changed required structure is
Unsupported and emits no event.

QB displays examinations below 100 with a compact two-digit prefix, such as
`80A1`, while the V1 contract requires a three-digit canonical prefix. The
adapter accepts only that exact compact two-digit display form and passes its
zero-padded equivalent, such as `080A1`, through the shared normalizer. It does
not infer a missing section, question number, separator, or any other invalid
identifier form.

Capture begins from an observed pending state. Only a transition from pending to
a supported resolved state for the same question may create an event. An already
resolved page at capture start is not historical evidence of a new answer and is
not emitted. A resolved state with no selected option is treated as
`resolved_without_selection`; it is terminal for that question but is not
converted to `incorrect`, `unknown`, or an `AttemptEventV1`.
Once the adapter has confirmed a visible result, zero selected options, and at
least one exact correct badge, it returns this state before deriving or
validating a correct-option index set. The sky-marker partition and all five
progress paths are still validated first, so a progress fill alone cannot be
mistaken for evidence of a correct answer.

When a different supported question key appears in the same document, capture
continues with a new pending-to-resolved cycle. The extension has no
configured question-count limit; the same consented document may continue
recording for as many supported question transitions as the user performs.

The adapter temporarily derives correct-option indices only to compare their set
with the selected-option set. Correct-option indices are not returned by the
adapter, included in a message or payload, stored in the outbox, or logged.

Older QB result pages may expose one reviewed four-cell summary table instead
of the explanation-title marker. For that exact structure, the adapter reads
only the single status cell whose direct text is exactly `正解` or `不正解` and
maps it to the allowed result enum. It still requires a consistent non-empty
selected-option marker before creating an attempt; an unselected result remains
`resolved_without_selection`. The table's other cells are never read or stored.
The table may mount before its status text during normal rendering; until an
exact allowed status appears, the adapter remains pending and cannot emit an
event. A mounting reviewed table also keeps precedence over any early
explanation-title marker so progressive rendering cannot break the required
pending-to-resolved sequence.
When the reviewed status table and explanation-title markers coexist, the exact
status cell is the preferred result evidence. If that legacy structure is not
resolved, the existing explanation-marker path remains the fallback.

## Popup diagnostics and recent records

The popup reads status only through the extension-page-only background message
route; it does not read `chrome.storage` directly. `Last code` reports the most
recent extension diagnostic. `Capture issue` retains the most recent DOM or
candidate failure as a finite allowlisted code such as
`capture_unsupported_dom:quiz_root_count_invalid`, even after capture later
returns to observing. Neither field includes DOM text, HTML, a URL, or a
free-form error message.

Invalid question-key structure is classified without exposing its source text.
The finite codes distinguish invalid direct text, a valid key split across
presentational descendants, one bounded descendant candidate, no candidate,
and ambiguous candidates. These classifications are diagnostic only: every
case remains Unsupported and cannot generate an attempt event.

Correct-marker diagnostics validate every marker before reporting a complete
mapping to reviewed options. A marker that is itself an option or has no or
multiple option ancestors is rejected separately. When repeated markers map to
the same option, diagnostics continue scanning every marker and deduplicate by
the option element. A finite diagnostic reports only whether that option set
equals, strictly contains, is strictly contained by, is disjoint from, or
partially overlaps the selected-option set; partial overlap is also separated by
equal or different cardinality. Every relation remains Unsupported until the
repeated-marker contract is explicitly reviewed. The older generic differs code
remains readable for stored-state compatibility but is no longer emitted. No
diagnostic exposes a correct option index, count, or page content.

The correct badge is not identified by `bg-qb-sky` alone. It must be a `DIV`
with the exact reviewed class-token set and, for a selected answer, the direct
first element child of its option. The other observed `bg-qb-sky` elements are
accepted only as exact progress fills on the exact reviewed three-element path,
one per option. Missing, duplicate, drifted, extra-class, wrong-tag, or
unclassified sky elements are Unsupported.

`直近の記録` combines the existing outbox and delivered-event cache and shows
only question key, answered-at timestamp, result, selected one-based indices,
and delivery state. The list is newest-first and bounded to 99 display rows;
this is not a capture, outbox, or per-document question limit. Event IDs,
provenance, correct-option indices, URLs, and QB content are not exposed. A
storage read failure is shown as unreadable state rather than as proof that the
history is empty.

Stored version-0.1.0 diagnostic codes from the earlier popup-triggered capture
flow remain readable so an upgrade cannot invalidate or strand an existing
outbox. The current runtime does not emit those legacy codes.

## Safety boundary

- The extension only reads answer DOM and observes mutations in an authorized `/quiz` session. It
  never clicks, submits, dispatches page events, navigates, changes ratings,
  edits notes or bookmarks, or modifies a problem set.
- It never collects or stores question text, option text, explanation text,
  images, page HTML, cookies, tokens, credentials, or private API data.
  Navigation URLs are parsed transiently; full URLs are never persisted or sent to the collector.
- It stores only a normalized question key, explicit one-based selected-option
  indices, result, detection time, and the fixed V1 provenance and quality
  fields required by `AttemptEventV1`. The separate study context records the
  automatically determined purpose and, for verified review sessions, its plan ID.
- Messages from content scripts are treated as untrusted. The worker validates
  the exact sender tab, window, top frame, document identity, origin, pathname,
  consent state, and message shape before accepting capture data.
- The manifest does not request `tabs`, `webNavigation`, `activeTab`, or
  `scripting`. QB is not listed in `host_permissions`; static content-script
  matching is the only page access grant. Persistent permissions are limited to
  `storage`, `alarms`, and loopback collector access.

The synthetic fixture adapter remains dependency-injected by tests only and is
not reachable from the distributed entrypoint.

## Collector profile

The default endpoint is:

```text
http://127.0.0.1:8765/v1/attempt-events
```

Only loopback HTTP endpoints with a configurable port and the exact path
`/v1/attempt-events` are accepted; credentials, query strings, fragments,
redirects, cookies, and authorization headers are rejected. The extension never
accesses Google Sheets. It deletes an event from the outbox only after a 2xx JSON
acknowledgement with the same `event_id` and a status of `inserted` or
`duplicate`. Network failures, HTTP 429, and 5xx responses retain the event for
retry.

`services/history-collector` now implements this profile as a first-party local
server backed by the append-only SQLite storage boundary. The profile remains
local-only and unauthenticated rather than an accepted external HTTP API.
Another local process that owns the configured port could still receive a
payload and forge an acknowledgement. `storage.local` also has a finite quota;
indefinite offline capture cannot be guaranteed after the quota is exhausted.

## Build and verify

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm verify:browser-extension
```

The loadable unpacked extension is written to `apps/browser-extension/dist`.
Automated tests use content-free synthetic HTML and mock Chrome/HTTP boundaries;
they do not connect to the live QB site.

## Trusted-user macOS package

After committing and verifying a clean worktree, create the private beta package
from the repository root:

```sh
pnpm release:trusted
```

The command force-rebuilds all TypeScript project outputs, then writes an
ignored ZIP and its external SHA-256 file under `artifacts/`. The ZIP contains
only the six allowlisted unpacked-extension files, a standalone Node.js
collector bundle, forward-only SQL migrations, runtime dependency license
texts, checksums, and Japanese install/update/remove instructions. It does not
contain a database, outbox, credentials, source maps, repository metadata, or
`node_modules`.

Packaging normally refuses a dirty worktree so `RELEASE.json` can identify one
exact source commit. `--allow-dirty` exists only for pre-commit packaging tests;
do not distribute an artifact produced with that option. This is an unpacked,
trusted-user package and is not a Chrome Web Store release.

## Known limitations

- An already-open QB tab needs one reload after updating the unpacked extension.
  Subsequent set-to-quiz SPA transitions do not require a reload.
- A direct quiz link opened without its originating set, or after browser-session
  context was lost, cannot prove which set it came from. Use the set link to
  preserve review attribution.
- A first remote Notion registry read that exceeds the local endpoint timeout
  leaves that exercise unclassified. The completed background read can identify
  the set on a later exercise; existing attempt evidence is never rewritten.
- Results visible before automatic recording starts or after pausing are ignored.
  A candidate not yet acknowledged by background storage can still be lost if
  its document/route closes during a failed transfer. Persisted outbox entries
  remain durable and are retried.
- Compatibility is limited to the reviewed DOM contract. A changed QB structure
  stops candidate creation with an allowlisted diagnostic, rather than guessing.
