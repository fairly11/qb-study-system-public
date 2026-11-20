import assert from 'node:assert/strict';
import { after, afterEach, before, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  NotionClient, attemptProperties, questionProperties, matchesAttempt, readCanonicalAttempt,
  readStudyContext, canonicalAttempt, generateDailyReviewPlan, reviewProgress,
  ReviewJournal, latestReviewDay, prepareReview,
} from '../dist/QBStudyFriend-Windows11-1.1.0-preview/app/core.mjs';

// Exercise the distributed bundle, not a separate source copy. All evidence is synthetic.
// These tests do not establish Windows device, live QB, or live Notion readiness.
const AS_OF = '2026-10-16T04:00:00+09:00';
const PLAN_ID = '90000000-0000-4000-8000-000000000001';
const ATTEMPTS_ID = '00000000-0000-4000-8000-000000000010';
const QUESTIONS_ID = '00000000-0000-4000-8000-000000000020';
const temporaryDirectories = [];
let originalFetch;
before(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('TEST_EXTERNAL_NETWORK_FORBIDDEN'); };
});
after(() => { globalThis.fetch = originalFetch; });
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function identifier(value, prefix = '10000000') {
  return `${prefix}-0000-4000-8000-${String(value).padStart(12, '0')}`;
}
function event(id = 1, { question = `119A${id}`, version = 'ios-0.1.0',
  answeredAt = '2026-10-01T09:00:00+09:00', result = 'incorrect' } = {}) {
  return {
    schema_version: '1', record_type: 'attempt_event', event_id: identifier(id),
    question_key: question, answered_at: answeredAt, result, selected_option_indices: [1],
    provenance: { producer: 'browser-extension', producer_version: version, source_system: 'qb-web-dom', recorded_at: answeredAt },
    quality: { acquisition_method: 'direct_capture', temporal_precision: 'exact', state_precision: 'exact' },
  };
}
function context(attempt, mode = 'unclassified', planId) {
  return { schema_version: '1', record_type: 'study_context', event_id: attempt.event_id, study_mode: mode,
    ...(planId === undefined ? {} : { review_plan_id: planId }) };
}
function apiProperties(properties) {
  return Object.fromEntries(Object.entries(properties).map(([name, raw]) => {
    const type = Object.keys(raw)[0];
    return [name, { ...raw, id: name, type,
      ...(type === 'date' ? { date: { end: null, time_zone: null, ...raw.date } } : {}),
      ...(type === 'relation' ? { has_more: false } : {}) }];
  }));
}
function page(properties, source = ATTEMPTS_ID, id = identifier(1, '20000000')) {
  return { object: 'page', id, parent: { type: 'data_source_id', data_source_id: source },
    archived: false, in_trash: false, properties: apiProperties(properties) };
}
function attemptPage(attempt, mode = 'unclassified', planId) {
  return page(attemptProperties(attempt, identifier(1, '30000000'),
    { studyContext: context(attempt, mode, planId), includeExtensionVersion: true }), ATTEMPTS_ID,
  identifier(Number(attempt.event_id.slice(-12)), '20000000'));
}
function questionPage(attempt) {
  return page(questionProperties(attempt), QUESTIONS_ID,
    identifier(Number(attempt.event_id.slice(-12)), '30000000'));
}
function schema(source) {
  const properties = source === QUESTIONS_ID ? questionProperties(event())
    : attemptProperties(event(), identifier(1, '30000000'), { studyContext: context(event()) });
  const options = { 判定: ['正解', '不正解', '未判定'], 記録元: ['Chrome拡張', 'Safari拡張'],
    学習種別: ['通常学習', '復習', '未分類'] };
  return { object: 'data_source', id: source, in_trash: false, archived: false,
    properties: Object.fromEntries(Object.entries(properties).map(([name, raw]) => {
      const type = Object.keys(raw)[0];
      const value = type === 'select' ? { options: options[name].map(label => ({ name: label })) }
        : type === 'relation' ? { data_source_id: QUESTIONS_ID, type: 'single_property', single_property: {} } : {};
      return [name, { id: name, name, type, [type]: value }];
    })) };
}
function response(value) {
  return new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
}
function list(results, cursor = null) {
  return { object: 'list', results, has_more: cursor !== null, next_cursor: cursor };
}
function snapshotFixture(attempts = [event(1), event(2), event(3)]) {
  return { attempts, contexts: [], questions: [], unknownAttemptRows: 0, duplicateAttemptRows: 0,
    excludedFutureEvents: 0, excludedFromAggregationRows: 0, unknownQuestionRows: 0,
    readStartedAt: '2026-10-15T19:00:00.000Z', readCompletedAt: '2026-10-15T19:00:01.000Z' };
}
function fixedModel(dueByQuestion) {
  return { model_id: 'synthetic-test', model_version: '1', grade_policy_version: 'synthetic-v1',
    predict: ({ attempts }) => ({
      next_review_at: new Date(dueByQuestion[attempts[0].question_key]).toISOString(),
      retrievability: 0.5, stability_days: 1, difficulty: 5, derived_grades: [],
    }) };
}

test('packaged Notion boundary accepts Safari and Chrome evidence, rejects a mislabeled source', () => {
  for (const [version, expected] of [['ios-0.1.0', 'Safari拡張'], ['ios-0.1.0+3', 'Safari拡張'], ['0.1.2', 'Chrome拡張']]) {
    const attempt = event(1, { version });
    const saved = attemptPage(attempt, 'review', PLAN_ID);
    assert.equal(saved.properties.記録元.select.name, expected);
    assert.equal(matchesAttempt(saved, attempt, identifier(1, '30000000')), true);
    assert.deepEqual(readCanonicalAttempt(saved), JSON.parse(canonicalAttempt(attempt)));
    assert.deepEqual(readStudyContext(saved), context(attempt, 'review', PLAN_ID));
    const changed = structuredClone(saved);
    changed.properties.記録元.select.name = expected === 'Safari拡張' ? 'Chrome拡張' : 'Safari拡張';
    assert.equal(matchesAttempt(changed, attempt, identifier(1, '30000000')), false);
  }
});

test('packaged snapshot paginates and calculates all three study modes across both devices', async () => {
  const attempts = [event(1, { version: '0.1.2' }), event(2), event(3)];
  const rows = [attemptPage(attempts[0], 'normal'), attemptPage(attempts[1], 'review', PLAN_ID), attemptPage(attempts[2])];
  const replies = [schema(QUESTIONS_ID), schema(ATTEMPTS_ID), list([rows[0], rows[1]], 'synthetic-page-2'),
    list([rows[1], rows[2]]), list(attempts.map(questionPage))];
  const calls = [];
  const client = new NotionClient({ token: 'synthetic-not-a-secret', attemptsDataSourceId: ATTEMPTS_ID,
    questionsDataSourceId: QUESTIONS_ID, sleep: async () => {}, fetch: async (url, init) => {
      const address = new URL(url);
      assert.equal(address.origin, 'https://api.notion.com');
      assert.ok(init.method === 'GET' && /^\/v1\/data_sources\/[a-f0-9-]+$/.test(address.pathname)
        || init.method === 'POST' && /^\/v1\/data_sources\/[a-f0-9-]+\/query$/.test(address.pathname));
      calls.push({ method: init.method, path: address.pathname, body: init.body && JSON.parse(init.body) });
      assert.ok(replies.length > 0, 'unexpected mock request');
      return response(replies.shift());
    } });
  const snapshot = await client.readReviewSnapshot({ asOf: AS_OF });
  assert.equal(replies.length, 0);
  assert.equal(snapshot.attempts.length, 3);
  assert.equal(snapshot.duplicateAttemptRows, 1);
  assert.equal(snapshot.unknownAttemptRows, 0);
  assert.equal(calls[3].body.start_cursor, 'synthetic-page-2');
  const plan = generateDailyReviewPlan({ as_of: AS_OF, attempts: snapshot.attempts,
    contexts: snapshot.contexts, questions: snapshot.questions });
  assert.equal(plan.all_time_counts.total.attempts, 3);
  for (const mode of ['normal', 'review', 'unclassified']) assert.equal(plan.all_time_counts[mode].attempts, 1);
  assert.equal(plan.states.length, 3);
  assert.ok(plan.states.every(state => state.prediction.derived_grades.length === 1));
});

test('retransmission is counted once but conflicting evidence is rejected', () => {
  const first = event(1);
  const second = event(2, { question: first.question_key, version: '0.1.2' });
  const plan = generateDailyReviewPlan({ as_of: AS_OF, attempts: [first, first, second] });
  assert.equal(plan.all_time_counts.total.attempts, 2);
  assert.equal(plan.all_time_counts.total.unique_questions, 1);
  assert.throws(() => generateDailyReviewPlan({ as_of: AS_OF, attempts: [first, { ...first, result: 'correct' }] }),
    /REVIEW_EVENT_CONFLICT/);
});

test('review horizon includes afternoon and 03:59:59.999, excludes the next 04:00', () => {
  const due = { '119A1': '2026-10-16T15:00:00+09:00', '119A2': '2026-10-17T03:59:59.999+09:00',
    '119A3': '2026-10-17T04:00:00+09:00' };
  for (const asOf of [AS_OF, '2026-10-17T01:00:00+09:00']) {
    const plan = generateDailyReviewPlan({ as_of: asOf, attempts: [event(1), event(2), event(3)], model: fixedModel(due) });
    assert.deepEqual(plan.items.map(item => item.question_key), ['119A1', '119A2']);
    assert.equal(plan.due_before, '2026-10-16T19:00:00.000Z');
    assert.equal(plan.target_date, '2026-10-16');
  }
  assert.equal(latestReviewDay('2027-01-01T03:59:59.999+09:00'), '2026-12-31');
  assert.equal(latestReviewDay('2027-01-01T04:00:00+09:00'), '2027-01-01');
});

test('current default chooses at most 100 questions and never fills a short candidate list', () => {
  const attempts = Array.from({ length: 105 }, (_, index) => event(index + 1));
  const model = fixedModel(Object.fromEntries(attempts.map(attempt => [attempt.question_key, '2026-10-16T12:00:00+09:00'])));
  const full = generateDailyReviewPlan({ as_of: AS_OF, attempts, model });
  const short = generateDailyReviewPlan({ as_of: AS_OF, attempts: attempts.slice(0, 3), model });
  assert.equal(full.settings.max_questions, 100);
  assert.equal(full.items.length, 100);
  assert.equal(new Set(full.items.map(item => item.question_key)).size, 100);
  assert.equal(short.items.length, 3);
});

test('late-arriving answers do not rewrite a saved same-day plan and are read the next day', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'qb-friend-test-fixed-plan-'));
  temporaryDirectories.push(directory);
  const journal = new ReviewJournal(directory);
  let reads = 0;
  const initial = await prepareReview({ asOf: AS_OF, journal, readSnapshot: async () => {
    reads++; return snapshotFixture([event(1)]);
  } });
  const repeated = await prepareReview({ asOf: '2026-10-16T12:00:00+09:00', journal,
    readSnapshot: async () => { reads++; throw new Error('SAME_DAY_MUST_NOT_REFETCH'); } });
  assert.deepEqual(repeated, initial);
  assert.equal(reads, 1);
  const next = await prepareReview({ asOf: '2026-10-17T04:00:00+09:00', journal,
    readSnapshot: async () => { reads++; return snapshotFixture([event(1), event(2)]); } });
  assert.equal(reads, 2);
  assert.equal(next.all_time_counts.total.attempts, 2);
  assert.deepEqual(journal.read(initial.target_date, 'plan'), initial);
});

test('review completion excludes normal, unclassified, other-plan and out-of-window answers', () => {
  const plan = { ...generateDailyReviewPlan({ as_of: AS_OF, attempts: [event(1), event(2), event(3)] }), plan_id: PLAN_ID };
  const normal = event(10, { question: '119A1', answeredAt: '2026-10-16T05:00:00+09:00' });
  const unknown = event(11, { question: '119A2', answeredAt: '2026-10-16T05:00:00+09:00' });
  const reviewed = event(12, { question: '119A3', answeredAt: '2026-10-16T05:00:00+09:00' });
  const other = event(13, { question: '119A1', answeredAt: '2026-10-16T05:00:00+09:00' });
  const nextDay = event(14, { question: '119A1', answeredAt: '2026-10-17T04:00:00+09:00' });
  const progress = reviewProgress(plan, [normal, unknown, reviewed, reviewed, other, nextDay],
    [context(normal, 'normal'), context(unknown), context(reviewed, 'review', PLAN_ID),
      context(other, 'review', identifier(2, '90000000')), context(nextDay, 'review', PLAN_ID)], '2026-10-18T04:00:00+09:00');
  assert.equal(progress.review_attempts, 1);
  assert.equal(progress.attempted_questions, 1);
  assert.deepEqual(progress.attempted_positions, [plan.items.find(item => item.question_key === '119A3').position]);
  assert.deepEqual(new Set(progress.remaining_question_ids), new Set(['119A1', '119A2']));
});

test('normal and unclassified correct answers update the same memory calculation as review answers', () => {
  const attempt = event(1, { answeredAt: '2026-10-13T21:00:00+09:00', result: 'correct' });
  const plans = ['normal', 'review', 'unclassified'].map(mode => generateDailyReviewPlan({ as_of: AS_OF,
    attempts: [attempt], contexts: [context(attempt, mode)] }));
  for (const plan of plans) {
    assert.equal(plan.states[0].prediction.derived_grades[0].observed_result, 'correct');
    assert.equal(plan.states[0].prediction.derived_grades[0].derived_grade, 'Good');
    assert.equal(plan.items[0].question_key, '119A1');
  }
  assert.deepEqual(plans[0].states[0].prediction, plans[1].states[0].prediction);
  assert.deepEqual(plans[0].states[0].prediction, plans[2].states[0].prediction);
});

test('future answers and future-recorded evidence cannot affect this calculation', () => {
  const current = event(1);
  const future = event(2, { question: '119A1', answeredAt: '2026-10-16T04:00:00.001+09:00', result: 'correct' });
  const notYetRecorded = { ...event(3), provenance: { ...event(3).provenance, recorded_at: future.answered_at } };
  const plan = generateDailyReviewPlan({ as_of: AS_OF, attempts: [current, future, notYetRecorded] });
  assert.equal(plan.all_time_counts.total.attempts, 1);
  assert.equal(plan.excluded_future_attempts, 2);
  assert.equal(plan.states[0].prediction.derived_grades[0].event_id, current.event_id);
});
