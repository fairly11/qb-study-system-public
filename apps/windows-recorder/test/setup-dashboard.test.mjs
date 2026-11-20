import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { DatabaseSync } from 'node:sqlite';

const packageRoot = process.env.QB_WINDOWS_PACKAGE ?? fileURLToPath(new URL('../dist/QBRecord-Windows11-0.1.1-preview/', import.meta.url));
assert.ok(isAbsolute(packageRoot), 'QB_WINDOWS_PACKAGE must be an absolute generated package path');
const moduleURL = name => pathToFileURL(join(packageRoot, 'app', name)).href;
const { configureNotion } = await import(moduleURL('notion-setup.mjs'));
const { connectionInfo, createDashboard, localStatus, safeCode } = await import(moduleURL('server.mjs'));
const { readNotionSyncConfig } = await import(moduleURL('core.mjs'));
const browserSource = readFileSync(join(packageRoot, 'app', 'client.js'), 'utf8');
const { parseConnectionTargets } = await import('data:text/javascript;base64,' + Buffer.from(browserSource).toString('base64'));
const ids = { parent: '10000000-0000-4000-8000-000000000001', questions: '10000000-0000-4000-8000-000000000002',
  attempts: '10000000-0000-4000-8000-000000000003', page: '10000000-0000-4000-8000-000000000004' };
const syntheticToken = 'synthetic_not_a_real_credential_12345';
const targets = { attemptsDataSourceId: ids.attempts, questionsDataSourceId: ids.questions, reviewParentPageId: ids.parent };
const setupBody = () => ({ ...targets, token: syntheticToken });
function directory(t) {
  const base = mkdtempSync(join(tmpdir(), 'qb-recorder-test-dashboard-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return base;
}
function properties(types) {
  return Object.fromEntries(Object.entries(types).map(([name, type]) => [name, { type, [type]: {} }]));
}
function mockNotion() {
  const sources = new Map(), calls = [];
  sources.set(ids.questions, { object: 'data_source', id: ids.questions, properties: properties({ '問題番号': 'title', '問題キー': 'rich_text' }) });
  const props = properties({ '記録名': 'title', 'イベントID': 'rich_text', '問題キー': 'rich_text', '問題番号': 'rich_text',
    '自分の解答': 'rich_text', '判定': 'select', '解答日時': 'date', '学習日': 'date', '取得日時': 'date',
    '問題': 'relation', '記録元': 'select', 'スキーマバージョン': 'rich_text', '学習種別': 'select',
    '記録データV1': 'rich_text', '学習目的データV1': 'rich_text' });
  props['問題'].relation = { data_source_id: ids.questions };
  for (const [name, values] of Object.entries({ '判定': ['正解', '不正解', '未判定'], '記録元': ['Chrome拡張', 'Safari拡張'],
    '学習種別': ['通常学習', '復習', '未分類'] })) props[name].select = { options: values.map(name => ({ name })) };
  sources.set(ids.attempts, { object: 'data_source', id: ids.attempts, properties: props });
  const state = { parentArchived: false, denyChildren: false };
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url), method = options.method ?? 'GET';
    calls.push({ method, path: parsed.pathname, body: options.body });
    assert.equal(parsed.origin, 'https://api.notion.com');
    assert.equal(method, 'GET', 'setup must never write to Notion');
    assert.equal(options.body, undefined);
    let value;
    if (parsed.pathname.startsWith('/v1/data_sources/')) value = sources.get(parsed.pathname.split('/').at(-1));
    else if (parsed.pathname === `/v1/pages/${ids.parent}`) value = { object: 'page', id: ids.parent, archived: state.parentArchived, in_trash: state.parentArchived };
    else if (parsed.pathname === `/v1/blocks/${ids.parent}/children`) {
      if (state.denyChildren) return new Response('{}', { status: 403 });
      value = { object: 'list', results: [{ object: 'block', id: ids.page }], has_more: false, next_cursor: null };
    }
    assert.ok(value, `Unexpected mock request ${parsed.pathname}`);
    return new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
  };
  return { fetchImpl, sources, calls, state };
}
async function connect(base, notion = mockNotion()) { return configureNotion({ base, ...setupBody(), fetchImpl: notion.fetchImpl }); }
async function dashboard(t, base, overrides = {}) {
  const reserve = createServer();
  await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
  const port = reserve.address().port;
  await new Promise(resolve => reserve.close(resolve));
  const key = '1'.repeat(64), origin = `http://127.0.0.1:${port}`;
  const server = createDashboard({ base, appDir: join(packageRoot, 'app'), key, port,
    restartCollector: async () => {}, collectorStatus: () => ({ state: 'unconfigured' }), shutdown: async () => {}, ...overrides });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const request = (path, body, headers = {}) => {
    const requestHeaders = { 'X-QB-Local-Key': key, Origin: origin,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers };
    for (const name of Object.keys(requestHeaders)) if (requestHeaders[name] === null) delete requestHeaders[name];
    return new Promise((resolve, reject) => {
      const req = httpRequest(origin + path, { method: body === undefined ? 'GET' : 'POST', headers: requestHeaders }, res => {
        const chunks = []; res.on('data', chunk => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: res.headers })));
      });
      req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  };
  return { request, origin, server };
}

test('existing destinations are validated using GET only and no publisher configuration is saved', async t => {
  const base = directory(t), notion = mockNotion(), before = JSON.stringify([...notion.sources]);
  const result = await connect(base, notion);
  assert.deepEqual(result, { status: 'configured', ...targets });
  assert.equal(JSON.stringify([...notion.sources]), before);
  assert.ok(notion.calls.length >= 5);
  assert.ok(notion.calls.every(call => call.method === 'GET' && call.body === undefined));
  assert.deepEqual(readdirSync(base).sort(), ['notion-sync.json', 'notion-token', 'review-config.json']);
  assert.deepEqual(JSON.parse(readFileSync(join(base, 'review-config.json'))), { schema_version: '1', notion_parent_page_id: ids.parent });
  assert.deepEqual(connectionInfo(base), targets);
  assert.ok(!JSON.stringify(result).includes(syntheticToken));
  assert.ok(!JSON.stringify(connectionInfo(base)).includes(syntheticToken));
});

test('any saved or partial configuration blocks setup before network access without replacing files', async t => {
  for (const name of ['notion-token', 'notion-sync.json', 'review-config.json']) {
    const base = directory(t), notion = mockNotion();
    writeFileSync(join(base, name), 'existing-content', { mode: 0o600 });
    await assert.rejects(connect(base, notion), /NOTION_SETUP_EXISTS/u);
    assert.equal(readFileSync(join(base, name), 'utf8'), 'existing-content');
    assert.deepEqual(readdirSync(base), [name]);
    assert.equal(notion.calls.length, 0);
  }
});

test('concurrent setup has only one winner and never overwrites its credentials', async t => {
  const base = directory(t), a = mockNotion(), b = mockNotion();
  const results = await Promise.allSettled([connect(base, a), connect(base, b)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'NOTION_SETUP_EXISTS');
  assert.equal(readFileSync(join(base, 'notion-token'), 'utf8'), syntheticToken);
  assert.deepEqual(connectionInfo(base), targets);
});

test('missing study context, missing normal mode, or wrong relation are rejected without local settings', async t => {
  for (const mutate of [props => { delete props['学習目的データV1']; },
    props => { props['学習種別'].select.options = [{ name: '未分類' }]; },
    props => { props['問題'].relation.data_source_id = ids.parent; }]) {
    const base = directory(t), notion = mockNotion(); mutate(notion.sources.get(ids.attempts).properties);
    await assert.rejects(connect(base, notion), /NOTION_(?:STUDY_CONTEXT_SCHEMA_REQUIRED|SCHEMA_MISMATCH)/u);
    assert.deepEqual(readdirSync(base), []);
    assert.ok(notion.calls.every(call => call.method === 'GET'));
  }
});

test('archived or unreadable review parent is rejected without changing destinations', async t => {
  for (const mode of ['parentArchived', 'denyChildren']) {
    const base = directory(t), notion = mockNotion(); notion.state[mode] = true;
    await assert.rejects(connect(base, notion), /NOTION_(?:SETUP_PARENT_INVALID|FORBIDDEN)/u);
    assert.deepEqual(readdirSync(base), []);
  }
});

test('invalid IDs and tokens never reach the network', async t => {
  for (const change of [{ attemptsDataSourceId: ids.questions }, { reviewParentPageId: 'https://example.com' },
    { token: 'short' }, { token: syntheticToken + '\n' }]) {
    const base = directory(t), notion = mockNotion();
    await assert.rejects(configureNotion({ base, ...setupBody(), ...change, fetchImpl: notion.fetchImpl }));
    assert.equal(notion.calls.length, 0);
    assert.deepEqual(readdirSync(base), []);
  }
});

test('dangling credential symlink is treated as an existing file', { skip: process.platform === 'win32' }, async t => {
  const base = directory(t), notion = mockNotion();
  symlinkSync(join(base, 'not-created'), join(base, 'notion-token'));
  await assert.rejects(connect(base, notion), /NOTION_SETUP_EXISTS/u);
  assert.equal(notion.calls.length, 0);
});

test('unknown network exception details and arbitrary uppercase strings are never returned', async t => {
  const base = directory(t);
  await assert.rejects(configureNotion({ base, ...setupBody(), fetchImpl: async () => { throw new Error(syntheticToken); } }), error => {
    assert.ok(!JSON.stringify({ message: error.message, code: error.code }).includes(syntheticToken)); return true;
  });
  assert.equal(safeCode(new Error('PRIVATE_SECRET_VALUE')), 'QB_OPERATION_FAILED');
  assert.equal(safeCode(new Error(syntheticToken)), 'QB_OPERATION_FAILED');
});

test('destination file accepts exactly three UUID values and enforces the byte limit', () => {
  assert.deepEqual(parseConnectionTargets(JSON.stringify(targets)), targets);
  for (const value of [{ ...targets, token: syntheticToken }, { ...targets, reviewParentPageId: 'bad' },
    { attemptsDataSourceId: ids.attempts }, [], null]) assert.throws(() => parseConnectionTargets(JSON.stringify(value)), /QB_TARGET_FILE_INVALID/u);
  assert.throws(() => parseConnectionTargets(' '.repeat(4097)), /QB_TARGET_FILE_INVALID/u);
  assert.throws(() => parseConnectionTargets('あ'.repeat(1400)), /QB_TARGET_FILE_INVALID/u);
});

test('dashboard starts the collector only after successful read-only setup', async t => {
  const base = directory(t), notion = mockNotion(); let starts = 0;
  const app = await dashboard(t, base, { setup: options => configureNotion({ ...options, fetchImpl: notion.fetchImpl }),
    restartCollector: async () => { assert.deepEqual(connectionInfo(base), targets); starts++; } });
  let response = await app.request('/api/status');
  assert.equal((await response.json()).configured, false); assert.equal(starts, 0);
  response = await app.request('/api/setup', setupBody());
  assert.equal(response.status, 200); assert.equal(starts, 1);
  response = await app.request('/api/status');
  const body = await response.text();
  assert.ok(!body.includes(syntheticToken)); assert.ok(!body.includes('notion-token'));
  assert.equal(JSON.parse(body).configured, true);
  assert.deepEqual(JSON.parse(body).connection, targets);
  assert.equal(Object.hasOwn(JSON.parse(body), 'review'), false);
  response = await app.request('/api/setup', setupBody());
  assert.equal(response.status, 400); assert.equal(starts, 1);
});

test('setup failure never starts the collector and does not expose submitted credentials', async t => {
  const base = directory(t); let starts = 0;
  const app = await dashboard(t, base, { setup: async () => { throw new Error(syntheticToken); }, restartCollector: async () => { starts++; } });
  const response = await app.request('/api/setup', setupBody());
  assert.equal(response.status, 400); assert.equal(starts, 0);
  assert.deepEqual(await response.json(), { code: 'QB_OPERATION_FAILED' });
});

test('partial saved settings are reported instead of offering to replace them', async t => {
  const base = directory(t);
  writeFileSync(join(base, 'notion-token'), syntheticToken, { mode: 0o600 });
  const app = await dashboard(t, base, { collectorStatus: () => ({ state: 'needs_setup' }) });
  const response = await app.request('/api/status');
  const body = await response.json();
  assert.equal(body.configured, false);
  assert.equal(body.configError, 'NOTION_SETUP_EXISTS');
  assert.equal(body.collector.state, 'needs_setup');
  assert.ok(!JSON.stringify(body).includes(syntheticToken));
});

test('session, host, origin, content type and field checks protect setup', async t => {
  const base = directory(t); let calls = 0;
  const app = await dashboard(t, base, { setup: async () => { calls++; return targets; } });
  for (const headers of [{ 'X-QB-Local-Key': 'bad' }, { Origin: 'https://example.com' }, { Host: 'example.com' },
    { 'Sec-Fetch-Site': 'cross-site' }, { Origin: null }]) {
    assert.equal((await app.request('/api/setup', setupBody(), headers)).status, 403, Object.keys(headers)[0]);
  }
  assert.equal((await app.request('/api/setup', setupBody(), { 'Content-Type': 'text/plain' })).status, 400);
  assert.equal((await app.request('/api/setup', { ...setupBody(), publisher_host: 'unexpected' })).status, 400);
  assert.equal(calls, 0);
  const page = await app.request('/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/u);
  assert.equal(page.headers.get('cache-control'), 'no-store');
});

test('review calculation and publication endpoints are absent', async t => {
  const app = await dashboard(t, directory(t));
  assert.equal((await (await app.request('/api/ping')).json()).product, 'QBRecordWindows');
  for (const path of ['/api/prepare', '/api/begin', '/api/register', '/api/review', '/api/remaining']) {
    assert.equal((await app.request(path, {})).status, 404);
    assert.equal((await app.request(path)).status, 404);
  }
});

test('local status counts this database only, preserves ambiguity, and limits recent results to 20', async t => {
  const base = directory(t); await connect(base);
  const target = readNotionSyncConfig(join(base, 'notion-sync.json')).target;
  const db = new DatabaseSync(join(base, 'qb-study.sqlite'));
  db.exec(`CREATE TABLE attempts(event_id TEXT PRIMARY KEY,question_key TEXT,answered_at TEXT,result TEXT);
    CREATE TABLE attempt_study_context(event_id TEXT PRIMARY KEY,study_mode TEXT);
    CREATE TABLE attempt_selected_options(event_id TEXT,option_index INTEGER);
    CREATE TABLE notion_sync_targets(target TEXT PRIMARY KEY,after_attempt_rowid INTEGER);
    CREATE TABLE notion_sync_journal(sequence INTEGER PRIMARY KEY,target TEXT,resource_kind TEXT,resource_key TEXT,status TEXT,page_id TEXT);`);
  const insert = db.prepare('INSERT INTO attempts VALUES(?,?,?,?)');
  for (let i = 1; i <= 25; i++) {
    insert.run('event-' + i, '120A' + i, '2026-11-15T00:00:00Z', 'correct');
    db.prepare('INSERT INTO attempt_selected_options VALUES(?,?)').run('event-' + i, 1);
  }
  db.prepare('INSERT INTO attempt_study_context VALUES(?,?)').run('event-25', 'normal');
  db.prepare('INSERT INTO notion_sync_targets VALUES(?,?)').run(target, 1);
  const journal = db.prepare('INSERT INTO notion_sync_journal(target,resource_kind,resource_key,status,page_id) VALUES(?,?,?,?,?)');
  journal.run(target, 'attempt', 'event-24', 'retry', null);
  journal.run(target, 'attempt', 'event-24', 'confirmed', ids.page);
  journal.run(target, 'attempt', 'event-23', 'blocked', null);
  journal.run(target, 'attempt', 'event-22', 'creating', ids.page);
  journal.run('another-target', 'attempt', 'event-21', 'confirmed', ids.page);
  db.close();
  const output = localStatus(base);
  assert.deepEqual([output.total, output.confirmed, output.pending, output.blocked, output.localOnly], [25, 1, 21, 2, 1]);
  assert.equal(output.recent.length, 20);
  assert.equal(output.recent[0].question, '120A25'); assert.equal(output.recent[0].mode, 'normal');
  assert.equal(output.recent[1].notionUrl, 'https://www.notion.so/' + ids.page.replaceAll('-', ''));
  assert.equal(output.recent[3].sync, 'creating'); assert.equal(output.recent[3].notionUrl, undefined);
  assert.ok(!JSON.stringify(output).includes('event-'));
});
