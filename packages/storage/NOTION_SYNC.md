# Notion synchronization storage

`@qb-study/storage/notion-sync` opens the same local database as the history
collector. It does not access Notion or change `AttemptEventV1`.

Call `activateTarget(target)` before synchronizing. The first call records the
current maximum attempt row ID, so existing history is excluded by default.
Passing `true` as the second argument includes existing history
only on the first activation. Subsequent calls never move that boundary.
Use a stable target identifier derived from both destination data source IDs.

`listAttemptsForTarget` returns eligible attempts in insertion order and verifies
their V1 shape and stored checksum. With no limit it returns every eligible
attempt, including confirmed entries that may need periodic reconciliation.
A caller using a limit must provide its own progression strategy; repeatedly
requesting the same prefix does not advance a cursor.

Before a remote create request, call `beginCreate`. Its conditional insert checks
the current lease owner and expiry together with the latest resource state in
one SQLite transaction. It returns true only when that state is absent or is a
retry whose waiting period has elapsed, and appends `creating` with the code
`NOTION_CREATE_UNCONFIRMED`. False means no request may be sent. After a crash,
that state means the remote outcome is uncertain and must be reconciled; it is
not permission to create again. Append `confirmed` only after verifying the
remote page and supplying its page ID. The storage records outcomes but does
not infer whether a remote operation succeeded. Ordinary `appendState`
allows further evidence, including a known page ID while still `creating`;
initial create intent must use `beginCreate`. `getState` returns the latest
journal entry for one resource.

Journal entries and activation boundaries are protected by update/delete
triggers. The lease table is deliberately mutable operational coordination,
separate from answer evidence. Acquiring a lease is an atomic SQLite operation;
the same owner renews it, and another owner can acquire it only after expiry.
The caller must renew and confirm ownership before remote effects, re-read the
latest resource state, and stop if it loses ownership. Expiring leases cannot
fence a request already sent to Notion or coordinate different Macs. Notion
reconciliation and conservative handling of ambiguous creates remain required.

Each sync connection uses `synchronous=FULL` before writing create intent. Local
collector connections also use `FULL` so an acknowledgement follows the stronger
SQLite WAL durability boundary. Hardware, filesystem, and backup behavior remain
outside this guarantee. Database files must stay outside cloud-synchronized
folders. No runtime credentials or remote payloads are stored in the journal.
