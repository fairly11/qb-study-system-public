import type { AttemptEventV1, HistorySnapshotV1 } from "../src/index.js";

declare const attempt: AttemptEventV1;
declare const snapshot: HistorySnapshotV1;

const acceptAttempt = (value: AttemptEventV1): void => { void value; };
const acceptSnapshot = (value: HistorySnapshotV1): void => { void value; };

acceptAttempt(attempt);
acceptSnapshot(snapshot);

// @ts-expect-error A snapshot cannot be consumed as an exact attempt event.
acceptAttempt(snapshot);
// @ts-expect-error An attempt event cannot be consumed as an imported snapshot.
acceptSnapshot(attempt);
