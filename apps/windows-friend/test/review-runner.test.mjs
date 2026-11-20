import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const packageRoot = process.env.QB_WINDOWS_PACKAGE
  ?? fileURLToPath(new URL('../dist/QBStudyFriend-Windows11-1.1.0-preview/', import.meta.url));
assert.ok(isAbsolute(packageRoot));
const runnerPath = join(packageRoot, 'app', 'review-runner.mjs');
const { runReviewAction } = await import(pathToFileURL(runnerPath).href);
const day = '2026-10-29';
const sessionKey = 'a'.repeat(64);
const notionToken = 'synthetic_not_a_real_notion_key_12345';
const manifest = { plan_id: '10000000-0000-4000-8000-000000000001', target_date: day,
  name: `QB復習_${day}_synthetic`, question_ids: ['123A1', '123A2', '123A3'], order: 'added_oldest_first' };
const current = () => ({ configured: true, review: { day, prepared: true, manifest },
  records: { total: 0, confirmed: 0, pending: 0, blocked: 0, localOnly: 0, recent: [] } });
function temporary(t, session = true) {
  const root = mkdtempSync(join(tmpdir(), 'qb-friend-test-runner-'));
  mkdirSync(join(root, 'data'), { mode: 0o700 });
  if (session) writeSession(root);
  writeFileSync(join(root, 'data', 'notion-token'), notionToken, { mode: 0o600 });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function writeSession(root, overrides = {}) {
  writeFileSync(join(root, 'data', 'session.json'), JSON.stringify({ product: 'QBStudyFriend', port: 8766, pid: 1234, key: sessionKey, ...overrides }), { mode: 0o600 });
}
function input(root, value, filename = 'observed.json') {
  const path = join(root, filename);
  writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
  return path;
}
function mocked(overrides = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url);
    assert.equal(parsed.origin, 'http://127.0.0.1:8766');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Origin, parsed.origin);
    assert.equal(options.headers['X-QB-Local-Key'], sessionKey);
    const body = options.body === undefined ? undefined : JSON.parse(options.body);
    calls.push({ path: parsed.pathname, method: options.method, body });
    let value, ok = true;
    if (parsed.pathname === '/api/ping') value = { product: 'QBStudyFriend', version: '1.1.0-preview' };
    else if (parsed.pathname === '/api/status') value = current();
    else if (parsed.pathname === '/api/prepare') value = { event_code: 'REVIEW_PLAN_READY', target_date: body.day };
    else if (parsed.pathname === '/api/begin') value = { event_code: 'REVIEW_SET_BEGIN', may_create: true };
    else if (parsed.pathname === '/api/register') value = { event_code: 'REVIEW_SET_LINK_READY', url: body.url };
    else assert.fail(`Unexpected mock path: ${parsed.pathname}`);
    if (overrides[parsed.pathname]) ({ value, ok = true } = overrides[parsed.pathname](body));
    return { ok, text: async () => JSON.stringify(value) };
  };
  return { fetchImpl, calls };
}
function noSecrets(value) {
  const text = JSON.stringify(value);
  assert.ok(!text.includes(sessionKey));
  assert.ok(!text.includes(notionToken));
  assert.ok(!text.includes('notion-token'));
}

test('status uses only the authenticated local dashboard and returns no credential or session URL', async t => {
  const root = temporary(t), remote = mocked();
  const output = await runReviewAction({ root, action: 'status', fetchImpl: remote.fetchImpl });
  assert.deepEqual(output, current());
  assert.deepEqual(remote.calls.map(call => [call.method, call.path]), [['GET', '/api/ping'], ['GET', '/api/status']]);
  assert.ok(remote.calls.every(call => call.body === undefined));
  noSecrets(output);
  assert.ok(!JSON.stringify(output).includes(root));
});

test('action allowlist rejects setup, arbitrary commands and unknown actions without contacting a service', async t => {
  const root = temporary(t), remote = mocked();
  for (const action of ['setup', 'delete', 'configure-schema', 'amend-day', 'shutdown', '', undefined])
    await assert.rejects(runReviewAction({ root, action, fetchImpl: remote.fetchImpl }), /REVIEW_ACTION_INVALID/u);
  assert.equal(remote.calls.length, 0);
});

test('missing and malformed session files are rejected before any request', async t => {
  const root = temporary(t, false), remote = mocked();
  await assert.rejects(runReviewAction({ root, action: 'status', fetchImpl: remote.fetchImpl }));
  const path = join(root, 'data', 'session.json');
  writeFileSync(path, '{invalid json', { mode: 0o600 });
  await assert.rejects(runReviewAction({ root, action: 'status', fetchImpl: remote.fetchImpl }));
  for (const override of [{ product: 'different' }, { port: 9000 }, { pid: -1 }, { pid: '1234' }, { key: 'short' }]) {
    writeSession(root, override);
    await assert.rejects(runReviewAction({ root, action: 'status', fetchImpl: remote.fetchImpl }), /QB_SESSION_INVALID/u);
  }
  assert.equal(remote.calls.length, 0);
});

test('session symlinks and oversized JSON are not followed', async t => {
  const root = temporary(t), remote = mocked(), path = join(root, 'data', 'session.json');
  const original = readFileSync(path);
  rmSync(path);
  writeFileSync(join(root, 'session-copy.json'), original, { mode: 0o600 });
  symlinkSync(join(root, 'session-copy.json'), path);
  await assert.rejects(runReviewAction({ root, action: 'status', fetchImpl: remote.fetchImpl }), /REVIEW_INPUT_INVALID/u);
  rmSync(path);
  writeFileSync(path, ' '.repeat(1025));
  await assert.rejects(runReviewAction({ root, action: 'status', fetchImpl: remote.fetchImpl }), /REVIEW_INPUT_INVALID/u);
  assert.equal(remote.calls.length, 0);
});

test('prepare pins one explicit current day and stops on missing, stale or rollover dates', async t => {
  const root = temporary(t), remote = mocked();
  const output = await runReviewAction({ root, action: 'prepare', day, fetchImpl: remote.fetchImpl });
  assert.deepEqual(remote.calls.at(-1), { path: '/api/prepare', method: 'POST', body: { day } });
  assert.equal(output.target_date, day); noSecrets(output);
  for (const invalid of [undefined, 'today', '2026-10-28']) {
    const fresh = mocked();
    await assert.rejects(runReviewAction({ root, action: 'prepare', day: invalid, fetchImpl: fresh.fetchImpl }), /REVIEW_DAY_REQUIRED|REVIEW_DAY_CHANGED/u);
    assert.equal(fresh.calls.filter(call => call.method === 'POST').length, 0);
  }
  const rollover = mocked({ '/api/prepare': () => ({ ok: false, value: { code: 'REVIEW_DAY_CHANGED' } }) });
  await assert.rejects(runReviewAction({ root, action: 'prepare', day, fetchImpl: rollover.fetchImpl }), /REVIEW_DAY_CHANGED/u);
  assert.equal(rollover.calls.filter(call => call.method === 'POST').length, 1);
});

test('begin sends only the explicit day and refuses a missing day', async t => {
  const root = temporary(t), remote = mocked();
  const output = await runReviewAction({ root, action: 'begin', day, fetchImpl: remote.fetchImpl });
  assert.equal(output.may_create, true); noSecrets(output);
  assert.deepEqual(remote.calls.at(-1), { path: '/api/begin', method: 'POST', body: { day } });
  const missing = mocked();
  await assert.rejects(runReviewAction({ root, action: 'begin', fetchImpl: missing.fetchImpl }), /REVIEW_DAY_REQUIRED/u);
  assert.equal(missing.calls.filter(call => call.method === 'POST').length, 0);
});

test('remaining permits only an observed prefix, preserving the input and never writing to the dashboard', async t => {
  const root = temporary(t), remote = mocked();
  const path = input(root, { day, ids: ['123A1'] });
  const before = readFileSync(path, 'utf8');
  const output = await runReviewAction({ root, action: 'remaining', inputFile: path, fetchImpl: remote.fetchImpl });
  assert.deepEqual(output, { day, remaining: ['123A2', '123A3'] }); noSecrets(output);
  assert.equal(readFileSync(path, 'utf8'), before);
  for (const ids of [['123A2'], ['123A1', '123A1'], ['123A1', '123A3'], ['123A1', '123A2', '123A3', '123A4']]) {
    input(root, { day, ids });
    await assert.rejects(runReviewAction({ root, action: 'remaining', inputFile: path, fetchImpl: remote.fetchImpl }), /REVIEW_SET_RESUME_MISMATCH/u);
  }
  input(root, { day: '2026-10-28', ids: [] });
  await assert.rejects(runReviewAction({ root, action: 'remaining', inputFile: path, fetchImpl: remote.fetchImpl }), /REVIEW_DAY_CHANGED/u);
  assert.equal(remote.calls.filter(call => call.method === 'POST').length, 0);
});

test('registration requires explicit observed confirmation and rejects unknown fields, relative inputs and malformed content', async t => {
  const root = temporary(t), remote = mocked();
  const observed = { day, url: 'https://qb.medilink-study.com/search?questionSetId=synthetic&operation=OR', ids: '123A1\n123A2\n123A3', confirmed: true };
  const path = input(root, observed);
  const output = await runReviewAction({ root, action: 'register', inputFile: path, fetchImpl: remote.fetchImpl });
  assert.deepEqual(remote.calls.at(-1), { path: '/api/register', method: 'POST', body: observed });
  noSecrets(output);
  for (const invalid of [{ ...observed, confirmed: false }, { ...observed, confirmed: 'true' },
    { ...observed, extra: 'unexpected' }, { ...observed, ids: ['123A1'] }, { ...observed, day: undefined }]) {
    const fresh = mocked(); input(root, invalid);
    await assert.rejects(runReviewAction({ root, action: 'register', inputFile: path, fetchImpl: fresh.fetchImpl }), /REVIEW_INPUT_INVALID/u);
    assert.equal(fresh.calls.filter(call => call.method === 'POST').length, 0);
  }
  for (const inputFile of [undefined, 'relative.json']) await assert.rejects(
    runReviewAction({ root, action: 'register', inputFile, fetchImpl: remote.fetchImpl }), /REVIEW_INPUT_REQUIRED/u);
});

test('version mismatch and service errors stop before publication and do not forward free-form errors', async t => {
  const root = temporary(t);
  const old = mocked({ '/api/ping': () => ({ value: { product: 'QBStudyFriend', version: '1.0.0-preview' } }) });
  await assert.rejects(runReviewAction({ root, action: 'prepare', day, fetchImpl: old.fetchImpl }), /QB_VERSION_MISMATCH/u);
  assert.equal(old.calls.length, 1);
  const unsafe = mocked({ '/api/ping': () => ({ ok: false, value: { code: `credential: ${notionToken}` } }) });
  await assert.rejects(runReviewAction({ root, action: 'status', fetchImpl: unsafe.fetchImpl }), error => {
    assert.equal(error.message, 'REVIEW_REQUEST_FAILED'); noSecrets({ error: error.message }); return true;
  });
});

test('the command entry rejects an uninstalled invocation with bounded JSON and no secrets on stdout or stderr', t => {
  const root = temporary(t);
  const env = { ...process.env, LOCALAPPDATA: join(root, 'not-installed'), QB_UNUSED_TEST_TOKEN: notionToken };
  delete env.NODE_OPTIONS;
  const result = spawnSync(process.execPath, [runnerPath, 'status'], { env, encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.deepEqual(JSON.parse(result.stderr.trim()), { event_code: 'QB_WINDOWS_INSTALL_REQUIRED' });
  noSecrets({ stdout: result.stdout, stderr: result.stderr });
  assert.ok(!result.stderr.includes(root));
});
