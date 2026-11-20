import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createServer } from 'node:net';

const packageRoot = process.env.QB_WINDOWS_PACKAGE ?? fileURLToPath(new URL('../dist/QBStudyFriend-Windows11-1.1.0-preview/', import.meta.url));
assert.ok(isAbsolute(packageRoot), 'QB_WINDOWS_PACKAGE must be an absolute generated package path');
const moduleURL = name => pathToFileURL(join(packageRoot, 'app', name)).href;
const { configureNotion, parseParentPage, questionProperties, attemptProperties } = await import(moduleURL('notion-setup.mjs'));
const { connectionInfo, createDashboard, validateRegistration, reviewState } = await import(moduleURL('server.mjs'));
const { NotionClient, ReviewJournal, createSetManifest, latestReviewDay } = await import(moduleURL('core.mjs'));
const ids = {
  parent: '10000000-0000-4000-8000-000000000001', questionsDB: '10000000-0000-4000-8000-000000000002',
  attemptsDB: '10000000-0000-4000-8000-000000000003', questions: '10000000-0000-4000-8000-000000000004',
  attempts: '10000000-0000-4000-8000-000000000005', plan: '10000000-0000-4000-8000-000000000006',
};
const syntheticToken = 'synthetic_not_a_real_credential_12345';
function directory(t) {
  const base = mkdtempSync(join(tmpdir(), 'qb-friend-test-dashboard-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return base;
}
function privateJSON(path, value) { writeFileSync(path, JSON.stringify(value), { mode: 0o600 }); }
function typedProperties(properties) {
  return Object.fromEntries(Object.entries(properties).map(([name, value]) => {
    const type = Object.keys(value)[0];
    return [name, { type, ...value,
      ...(type === 'date' && typeof value.date?.start === 'string' ? { date: { end: null, time_zone: null, ...value.date } } : {}),
      ...(type === 'relation' && Array.isArray(value.relation) ? { has_more: false } : {}),
    }];
  }));
}
function mockNotion() {
  const databases = new Map(), sources = new Map(), pages = new Map(), calls = [];
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    assert.equal(parsed.origin, 'https://api.notion.com');
    const path = parsed.pathname.replace(/^\/v1/u, '');
    const method = options.method ?? 'GET';
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ method, path, body });
    let value;
    if (method === 'GET' && path === `/pages/${ids.parent}`) {
      value = { object: 'page', id: ids.parent, archived: false, in_trash: false };
    } else if (method === 'GET' && path === `/blocks/${ids.parent}/children`) {
      value = { object: 'list', results: [], has_more: false, next_cursor: null };
    } else if (method === 'POST' && path === '/databases') {
      const question = !databases.has(ids.questionsDB);
      const databaseID = question ? ids.questionsDB : ids.attemptsDB;
      const sourceID = question ? ids.questions : ids.attempts;
      value = { object: 'database', id: databaseID, parent: body.parent, title: body.title,
        description: body.description, archived: false, in_trash: false, data_sources: [{ id: sourceID }] };
      databases.set(databaseID, value);
      sources.set(sourceID, { object: 'data_source', id: sourceID, properties: typedProperties(body.initial_data_source.properties) });
    } else if (method === 'GET' && path.startsWith('/databases/')) {
      value = databases.get(path.split('/').at(-1));
    } else if (method === 'GET' && path.startsWith('/data_sources/')) {
      value = sources.get(path.split('/').at(-1));
    } else if (method === 'POST' && path === '/pages') {
      const id = `20000000-0000-4000-8000-${String(pages.size + 1).padStart(12, '0')}`;
      value = { object: 'page', id, parent: body.parent, archived: false, in_trash: false, properties: typedProperties(body.properties) };
      pages.set(id, value);
    } else if (method === 'POST' && /^\/data_sources\/[^/]+\/query$/u.test(path)) {
      const source = path.split('/')[2];
      value = { object: 'list', results: [...pages.values()].filter(page => page.parent.data_source_id === source), has_more: false, next_cursor: null };
    }
    assert.ok(value, `Unexpected synthetic request: ${method} ${path}`);
    return new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return { fetchImpl, databases, sources, pages, calls };
}
function seedConfiguration(base, maxQuestions = 100) {
  const tokenPath = join(base, 'notion-token');
  writeFileSync(tokenPath, syntheticToken, { mode: 0o600 });
  privateJSON(join(base, 'notion-sync.json'), { schema_version: '1', enabled: true,
    questions_data_source_id: ids.questions, attempts_data_source_id: ids.attempts, token_file: tokenPath });
  privateJSON(join(base, 'review-config.json'), { schema_version: '1', publisher_host: hostname(),
    notion_parent_page_id: ids.parent, max_questions: maxQuestions, request_retention: 0.9, per_question_daily_cap: 2,
    settings_version: 'daily-review-settings-v1' });
}
async function dashboard(t, base, overrides = {}) {
  const reserve = createServer();
  await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
  const port = reserve.address().port;
  await new Promise(resolve => reserve.close(resolve));
  const key = '1'.repeat(64), origin = `http://127.0.0.1:${port}`;
  const server = createDashboard({ base, appDir: join(packageRoot, 'app'), key, port,
    runReview: async () => { throw new Error('UNEXPECTED_REVIEW'); }, restartCollector: async () => {},
    collectorStatus: () => ({ state: 'running' }), shutdown: async () => {}, ...overrides });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const request = (path, body, overrides = {}) => fetch(origin + path, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'X-QB-Local-Key': key, Origin: origin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...overrides },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { request, origin };
}

test('Notion page links accept the official app host but reject credentialed and lookalike hosts', () => {
  assert.equal(parseParentPage(`https://app.notion.com/Friend-${ids.parent.replaceAll('-', '')}?v=ignored`), ids.parent);
  assert.equal(parseParentPage(ids.parent), ids.parent);
  for (const host of ['notion.com', 'www.notion.com']) assert.equal(parseParentPage(`https://${host}/${ids.parent.replaceAll('-', '')}`), ids.parent);
  assert.equal(parseParentPage(`https://www.notion.so/Friend-${ids.parent.replaceAll('-', '')}`), ids.parent);
  assert.equal(parseParentPage(`https://friend.notion.site/Friend-${ids.parent.replaceAll('-', '')}`), ids.parent);
  for (const value of [`https://app.notion.com.evil.example/${ids.parent}`, `https://user:password@app.notion.com/${ids.parent}`,
    `http://app.notion.com/${ids.parent}`, `https://example.org/${ids.parent}`]) assert.throws(() => parseParentPage(value));
});

test('fresh setup creates both source options and three modes, with a 100-question default', async t => {
  const base = directory(t), notion = mockNotion();
  const result = await configureNotion({ base, parentPage: ids.parent, token: syntheticToken, fetchImpl: notion.fetchImpl });
  assert.equal(result.maxQuestions, 100);
  const properties = notion.sources.get(ids.attempts).properties;
  assert.deepEqual(properties['記録元'].select.options.map(x => x.name), ['Chrome拡張', 'Safari拡張']);
  assert.deepEqual(properties['学習種別'].select.options.map(x => x.name), ['通常学習', '復習', '未分類']);
  assert.equal(JSON.parse(readFileSync(join(base, 'review-config.json'))).max_questions, 100);
  assert.equal(notion.calls.filter(call => call.method === 'POST' && call.path === '/databases').length, 2);
  assert.ok(!JSON.stringify(result).includes(syntheticToken));
});

test('a resumed completed setup retains its existing 30-question setting and creates no extra database', async t => {
  const base = directory(t), notion = mockNotion();
  await configureNotion({ base, parentPage: ids.parent, token: syntheticToken, maxQuestions: 30, fetchImpl: notion.fetchImpl });
  const configBefore = readFileSync(join(base, 'review-config.json'), 'utf8');
  const resumed = await configureNotion({ base, parentPage: ids.parent, token: syntheticToken, fetchImpl: notion.fetchImpl });
  assert.equal(resumed.status, 'already_configured');
  assert.equal(resumed.maxQuestions, 30);
  assert.equal(readFileSync(join(base, 'review-config.json'), 'utf8'), configBefore);
  assert.equal(notion.calls.filter(call => call.method === 'POST' && call.path === '/databases').length, 2);
  await assert.rejects(configureNotion({ base, parentPage: ids.parent, token: syntheticToken, maxQuestions: 100, fetchImpl: notion.fetchImpl }), /NOTION_SETUP_OPTIONS_CONFLICT/u);
  assert.equal(readFileSync(join(base, 'review-config.json'), 'utf8'), configBefore);
});

test('a legacy Notion source missing Safari is rejected without rewriting options or saved configuration', async t => {
  const base = directory(t), notion = mockNotion();
  await configureNotion({ base, parentPage: ids.parent, token: syntheticToken, fetchImpl: notion.fetchImpl });
  const props = notion.sources.get(ids.attempts).properties;
  props['記録元'].select.options = [{ name: 'Chrome拡張' }, { name: '友人の独自項目' }];
  const schemaBefore = JSON.stringify(props), configBefore = readFileSync(join(base, 'review-config.json'), 'utf8');
  await assert.rejects(configureNotion({ base, parentPage: ids.parent, token: syntheticToken, fetchImpl: notion.fetchImpl }), /NOTION_SAFARI_SCHEMA_REQUIRED/u);
  assert.equal(JSON.stringify(props), schemaBefore);
  assert.equal(readFileSync(join(base, 'review-config.json'), 'utf8'), configBefore);
  assert.equal(notion.calls.filter(call => call.method === 'PATCH').length, 0);
});

test('iPhone connection details expose only validated public IDs and the saved limit', t => {
  const base = directory(t); seedConfiguration(base, 30);
  const actual = connectionInfo(base);
  assert.deepEqual(actual, { attemptsDataSourceId: ids.attempts, questionsDataSourceId: ids.questions,
    reviewParentPageId: ids.parent, maxQuestions: 30 });
  assert.ok(!JSON.stringify(actual).includes(syntheticToken));
  assert.ok(!JSON.stringify(actual).includes(base));
  assert.deepEqual(connectionInfo(directory(t)), undefined);
});

test('iPhone connection details reject a symlinked review configuration', t => {
  const base = directory(t); seedConfiguration(base);
  const saved = readFileSync(join(base, 'review-config.json'));
  rmSync(join(base, 'review-config.json'));
  writeFileSync(join(base, 'other.json'), saved, { mode: 0o600 });
  symlinkSync(join(base, 'other.json'), join(base, 'review-config.json'));
  assert.throws(() => connectionInfo(base), /REVIEW_CONFIG_PERMISSIONS/u);
});

test('dashboard setup delegates limit selection to setup so existing settings are retained', async t => {
  const base = directory(t), received = [];
  const env = await dashboard(t, base, { setup: async value => { received.push(value); return { status: 'configured' }; } });
  const response = await env.request('/api/setup', { parentPage: ids.parent, token: syntheticToken });
  assert.equal(response.status, 200);
  assert.equal(received.length, 1);
  assert.equal(received[0].maxQuestions, undefined);
  assert.ok(!JSON.stringify(await response.json()).includes(syntheticToken));
});

test('dashboard status returns iPhone IDs while retaining local-only counter semantics and omitting credentials', async t => {
  const base = directory(t); seedConfiguration(base);
  const env = await dashboard(t, base);
  const response = await env.request('/api/status');
  const status = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(status.connection, { attemptsDataSourceId: ids.attempts, questionsDataSourceId: ids.questions,
    reviewParentPageId: ids.parent, maxQuestions: 100 });
  assert.deepEqual(status.records, { total: 0, confirmed: 0, pending: 0, blocked: 0, localOnly: 0, recent: [] });
  assert.ok(!JSON.stringify(status).includes(syntheticToken));
  assert.ok(!JSON.stringify(status).includes('token_file'));
  assert.ok(!JSON.stringify(status).includes(base));
});

test('dashboard setup refuses cross-origin or unauthenticated writes', async t => {
  let invoked = 0;
  const env = await dashboard(t, directory(t), { setup: async () => { invoked++; return { status: 'configured' }; } });
  assert.equal((await env.request('/api/setup', {}, { Origin: 'https://example.org' })).status, 403);
  assert.equal((await env.request('/api/setup', {}, { 'X-QB-Local-Key': '2'.repeat(64) })).status, 403);
  assert.equal(invoked, 0);
});

test('100-question registration requires every observed ID in the intended order', () => {
  const questionIDs = Array.from({ length: 100 }, (_, i) => `123A${i + 1}`);
  const manifest = createSetManifest({ plan_id: ids.plan, target_date: '2026-10-29',
    items: questionIDs.map((question_key, index) => ({ question_key, position: index + 1 })) });
  const body = { confirmed: true, ids: questionIDs.join('\n'), url: 'https://qb.medilink-study.com/search?questionSetId=synthetic-set&operation=OR' };
  assert.deepEqual(validateRegistration(manifest, body).ids, questionIDs);
  for (const idsValue of [questionIDs.slice(1), [...questionIDs].reverse(), [...questionIDs.slice(0, 99), questionIDs[0]]])
    assert.throws(() => validateRegistration(manifest, { ...body, ids: idsValue.join('\n') }), /REVIEW_QB_MEMBERSHIP_MISMATCH/u);
});

test('dashboard reads the saved plan unchanged and does not ignore an invalid revision', t => {
  const base = directory(t), day = '2026-10-29';
  const journal = new ReviewJournal(join(base, 'daily-review'));
  const plan = { plan_id: ids.plan, target_date: day, items: [{ question_key: '123A1', position: 1 }] };
  journal.writeOnce(day, 'plan', plan);
  const before = readFileSync(join(base, 'daily-review', day, 'plan.json'), 'utf8');
  assert.deepEqual(reviewState(base, day).manifest.question_ids, ['123A1']);
  assert.equal(reviewState(base, day).revision, 0);
  assert.equal(readFileSync(join(base, 'daily-review', day, 'plan.json'), 'utf8'), before);
  journal.writeOnce(day, 'revision-1', { revision: 1, reason: 'include_due_within_day' });
  assert.throws(() => reviewState(base, day), /REVIEW_JOURNAL_CORRUPT/u);
});

test('current packaged reader accepts Safari and Chrome records with distinct normal, review and unclassified contexts', async () => {
  const notion = mockNotion();
  notion.sources.set(ids.questions, { object: 'data_source', id: ids.questions, properties: typedProperties(questionProperties()) });
  notion.sources.set(ids.attempts, { object: 'data_source', id: ids.attempts, properties: typedProperties(attemptProperties(ids.questions)) });
  const client = new NotionClient({ token: syntheticToken, questionsDataSourceId: ids.questions,
    attemptsDataSourceId: ids.attempts, fetch: notion.fetchImpl, sleep: async () => {} });
  const events = ['normal', 'review', 'unclassified'].map((mode, index) => ({
    schema_version: '1', record_type: 'attempt_event', event_id: `30000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    question_key: '123A1', answered_at: `2026-10-28T0${index}:00:00.000Z`, result: index === 0 ? 'incorrect' : 'correct', selected_option_indices: [1],
    provenance: { producer: 'browser-extension', producer_version: index === 0 ? '0.1.2' : 'ios-0.1.0', source_system: 'qb-web-dom', recorded_at: `2026-10-28T0${index}:00:00.000Z` },
    quality: { acquisition_method: 'direct_capture', temporal_precision: 'exact', state_precision: 'exact' },
  }));
  const question = await client.createQuestion(events[0]);
  for (const [index, study_mode] of ['normal', 'review', 'unclassified'].entries()) {
    await client.createAttempt(events[index], question.id, { schema_version: '1', record_type: 'study_context',
      event_id: events[index].event_id, study_mode, ...(study_mode === 'review' ? { review_plan_id: ids.plan } : {}) });
  }
  const snapshot = await client.readReviewSnapshot({ asOf: '2026-10-29T00:00:00.000Z' });
  assert.equal(snapshot.attempts.length, 3);
  assert.deepEqual(snapshot.contexts.map(x => x.study_mode), ['normal', 'review', 'unclassified']);
  const attemptPages = [...notion.pages.values()].filter(page => page.parent.data_source_id === ids.attempts);
  assert.deepEqual(attemptPages.map(page => page.properties['記録元'].select.name), ['Chrome拡張', 'Safari拡張', 'Safari拡張']);
  attemptPages[1].properties['記録元'].select.name = 'Chrome拡張';
  await assert.rejects(client.readReviewSnapshot({ asOf: '2026-10-29T00:00:00.000Z' }), /NOTION_EVENT_CONFLICT/u);
});


test('dashboard prepare pins the requested current day and rejects a stale day before invoking the CLI', async t => {
  const base = directory(t); seedConfiguration(base);
  const calls = [];
  const env = await dashboard(t, base, { runReview: async args => { calls.push(args); return { event_code: 'REVIEW_PLAN_READY' }; } });
  const day = latestReviewDay(new Date().toISOString());
  assert.equal((await env.request('/api/prepare', { day })).status, 200);
  assert.deepEqual(calls[0], ['prepare', '-', day]);
  assert.equal((await env.request('/api/prepare', {})).status, 200);
  assert.deepEqual(calls[1], ['prepare', '-', day]);
  for (const invalid of ['2000-01-01', null, 'today', '2026-99-99']) {
    const response = await env.request('/api/prepare', { day: invalid });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'REVIEW_DAY_CHANGED');
  }
  assert.equal(calls.length, 2);
});

test('setup cleanup failure keeps the original validation error and writes no connection credential', async t => {
  const base = directory(t);
  const fetchImpl = async () => {
    writeFileSync(join(base, 'notion-setup.lock'), '{synthetic damaged lock', { mode: 0o600 });
    return new Response(JSON.stringify({ object: 'page', id: ids.parent, archived: true, in_trash: false }),
      { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  await assert.rejects(configureNotion({ base, parentPage: ids.parent, token: syntheticToken, fetchImpl }),
    /NOTION_SETUP_PARENT_INVALID/u);
  assert.throws(() => readFileSync(join(base, 'notion-token')), { code: 'ENOENT' });
});
