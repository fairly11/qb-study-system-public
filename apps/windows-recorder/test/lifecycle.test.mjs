import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const packageRoot = process.env.QB_WINDOWS_PACKAGE ?? fileURLToPath(new URL('../dist/QBRecord-Windows11-0.1.1-preview/', import.meta.url));
const executable = join(packageRoot, 'collector/dist/collector.mjs');

async function unusedPort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  assert.ok(Number.isInteger(port) && port > 1024 && port !== 8765 && port !== 8766);
  return port;
}
async function startCollector(directory, port) {
  // Allowlist instead of inheriting credentials, config overrides, loaders, proxies or NODE_OPTIONS.
  const environment = {
    QB_STUDY_HOME: directory, QB_STUDY_DB_PATH: join(directory, 'qb-study.sqlite'),
    QB_STUDY_COLLECTOR_PORT: String(port), TEMP: directory, TMP: directory, TMPDIR: directory,
    ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {}),
  };
  const denyExternalFetch = 'data:text/javascript,' + encodeURIComponent(
    'globalThis.fetch = async () => { throw new Error("TEST_EXTERNAL_NETWORK_FORBIDDEN"); };');
  const child = spawn(process.execPath, ['--import', denyExternalFetch, executable], {
    env: environment, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true,
  });
  const events = [];
  let partial = '';
  let readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const timer = setTimeout(() => readyReject(new Error('TEST_COLLECTOR_START_TIMEOUT')), 8_000);
  child.stdout.on('data', chunk => {
    partial += chunk.toString();
    const lines = partial.split('\n');
    partial = lines.pop();
    for (const line of lines) {
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      events.push(entry);
      if (entry.event_code === 'COLLECTOR_LISTENING') readyResolve(entry);
    }
  });
  // Only codes are retained, never arbitrary native stderr or data payloads.
  child.stderr.on('data', chunk => {
    for (const line of chunk.toString().split('\n')) {
      try {
        const entry = JSON.parse(line);
        if (/^[A-Z_]+$/.test(entry.event_code ?? '')) events.push({ event_code: entry.event_code });
      } catch { /* Ignore runtime notices and retain no free-form output. */ }
    }
  });
  const exited = new Promise((resolve, reject) => {
    child.once('error', error => { readyReject(error); reject(error); });
    child.once('exit', (code, signal) => {
      readyReject(new Error('TEST_COLLECTOR_EXITED_BEFORE_READY'));
      resolve({ code, signal });
    });
  });
  try {
    const observed = await ready;
    assert.equal(observed.port, port);
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
    throw error;
  } finally { clearTimeout(timer); }
  return { child, exited, events, port };
}
function submit(port, envelope) {
  assert.ok(port !== 8765 && port !== 8766);
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(envelope);
    const req = request({ host: '127.0.0.1', port, path: '/v2/attempt-events', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Connection: 'close' },
      timeout: 3_000 }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        try { resolve({ code: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }); }
        catch (error) { reject(error); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('TEST_LOCAL_REQUEST_TIMEOUT')));
    req.end(body);
  });
}
async function stopCollector(run) {
  await new Promise((resolve, reject) => run.child.send({ type: 'qb-study-shutdown' }, error => error ? reject(error) : resolve()));
  let timer;
  const result = await Promise.race([run.exited, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('TEST_IPC_SHUTDOWN_TIMEOUT')), 5_000);
  })]).finally(() => clearTimeout(timer));
  assert.deepEqual(result, { code: 0, signal: null });
  assert.equal(run.events.filter(entry => entry.event_code === 'COLLECTOR_STOPPED').length, 1);
  assert.equal(run.events.some(entry => entry.event_code.startsWith('NOTION_')), false);
}
function storedEvidence(directory) {
  const db = new DatabaseSync(join(directory, 'qb-study.sqlite'), { readOnly: true });
  try {
    assert.equal(Object.values(db.prepare('PRAGMA quick_check').get())[0], 'ok');
    return {
      attempts: db.prepare('SELECT * FROM attempts ORDER BY event_id').all(),
      choices: db.prepare('SELECT * FROM attempt_selected_options ORDER BY event_id,option_index').all(),
      contexts: db.prepare('SELECT * FROM attempt_study_context ORDER BY event_id').all(),
    };
  } finally { db.close(); }
}

function envelope(number, question, mode, planId) {
  const eventId = `10000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
  return {
    attempt: { schema_version: '1', record_type: 'attempt_event', event_id: eventId, question_key: question,
      answered_at: '2026-10-01T00:00:00.000Z', result: 'incorrect', selected_option_indices: [2, 1],
      provenance: { producer: 'browser-extension', producer_version: '0.1.2', source_system: 'qb-web-dom',
        recorded_at: '2026-10-01T00:00:00.000Z' },
      quality: { acquisition_method: 'direct_capture', temporal_precision: 'exact', state_precision: 'exact' } },
    context: { schema_version: '1', record_type: 'study_context', event_id: eventId, study_mode: mode,
      ...(planId === undefined ? {} : { review_plan_id: planId }) },
  };
}

test('packaged collector preserves normal, review and older-exam evidence across IPC shutdown and duplicate replay', { timeout: 25_000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'qb-recorder-test-lifecycle-'));
  const runs = [];
  t.after(async () => {
    for (const run of runs) {
      if (run.child.exitCode === null && run.child.signalCode === null) run.child.kill();
      await run.exited;
    }
    rmSync(directory, { recursive: true, force: true });
  });
  const records = [
    envelope(1, '119A1', 'normal'),
    envelope(2, '120B2', 'review', '90000000-0000-4000-8000-000000000001'),
    envelope(3, '116A1', 'normal'),
    envelope(4, '115A1', 'review'),
  ];
  const first = await startCollector(directory, await unusedPort());
  runs.push(first);
  for (const record of records) {
    assert.deepEqual(await submit(first.port, record), { code: 200,
      body: { event_id: record.attempt.event_id, status: 'inserted' } });
  }
  const whileRunning = storedEvidence(directory);
  assert.equal(whileRunning.attempts.length, 4);
  assert.equal(whileRunning.choices.length, 8);
  assert.deepEqual(whileRunning.attempts.map(record => record.question_key), ['119A1', '120B2', '116A1', '115A1']);
  assert.deepEqual(whileRunning.contexts.map(context => context.study_mode), ['normal', 'review', 'normal', 'review']);
  assert.equal(whileRunning.contexts[1].review_plan_id, '90000000-0000-4000-8000-000000000001');
  assert.equal(whileRunning.contexts[3].review_plan_id, null);
  await stopCollector(first);
  assert.deepEqual(storedEvidence(directory), whileRunning);

  const second = await startCollector(directory, await unusedPort());
  runs.push(second);
  for (const record of records) {
    assert.deepEqual(await submit(second.port, record), { code: 200,
      body: { event_id: record.attempt.event_id, status: 'duplicate' } });
  }
  const record = records[1];
  assert.equal((await submit(second.port, { ...record, context: { ...record.context, study_mode: 'normal', review_plan_id: undefined } })).code, 409);
  await stopCollector(second);
  assert.deepEqual(storedEvidence(directory), whileRunning);
});

function dashboardRequest(port, path, key, body) {
  assert.ok(port !== 8765 && port !== 8766);
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = request({ host: '127.0.0.1', port, path, method: payload === undefined ? 'GET' : 'POST',
      headers: { 'X-QB-Local-Key': key, Origin: `http://127.0.0.1:${port}`, Connection: 'close',
        ...(payload === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }) }, timeout: 3000 }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        try { resolve({ code: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }); }
        catch (error) { reject(error); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('TEST_LOCAL_REQUEST_TIMEOUT')));
    req.end(payload);
  });
}

test('unconfigured launcher exposes setup without accepting answers or creating a database', { timeout: 15_000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'qb-recorder-test-launcher-'));
  const webPort = await unusedPort();
  let collectorPort = await unusedPort();
  while (collectorPort === webPort) collectorPort = await unusedPort();
  const environment = {
    QB_RECORDER_TEST_DATA: directory, QB_RECORDER_TEST_WEB_PORT: String(webPort),
    QB_RECORDER_TEST_COLLECTOR_PORT: String(collectorPort), TEMP: directory, TMP: directory, TMPDIR: directory,
    ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {}),
  };
  const denyFetch = 'data:text/javascript,' + encodeURIComponent(
    'globalThis.fetch = async () => { throw new Error("TEST_EXTERNAL_NETWORK_FORBIDDEN"); };');
  const child = spawn(process.execPath, ['--import', denyFetch, join(packageRoot, 'app/launcher.mjs'), '--test'], {
    env: environment, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
    rmSync(directory, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('TEST_LAUNCHER_START_TIMEOUT')), 8000);
    let buffer = '';
    child.stdout.on('data', chunk => {
      buffer = (buffer + chunk.toString()).slice(-8192);
      if (buffer.includes('QB_RECORDER_READY\n')) { clearTimeout(timer); resolve(); }
    });
    child.stderr.on('data', () => { /* Never retain arbitrary subprocess output. */ });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('TEST_LAUNCHER_EXITED_BEFORE_READY')); });
  });
  const session = JSON.parse(readFileSync(join(directory, 'session.json'), 'utf8'));
  assert.equal(session.product, 'QBRecordWindows');
  const status = await dashboardRequest(webPort, '/api/status', session.key);
  assert.equal(status.code, 200);
  assert.equal(status.body.collector.state, 'needs_setup');
  assert.equal(status.body.configured, false);
  assert.equal(existsSync(join(directory, 'qb-study.sqlite')), false);
  await assert.rejects(submit(collectorPort, envelope(5, '115A2', 'normal')), error => error.code === 'ECONNREFUSED');
  const stopped = await dashboardRequest(webPort, '/api/shutdown', session.key, {});
  assert.equal(stopped.code, 200);
  let timer;
  const result = await Promise.race([exited, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('TEST_LAUNCHER_STOP_TIMEOUT')), 5000);
  })]).finally(() => clearTimeout(timer));
  assert.deepEqual(result, { code: 0, signal: null });
  assert.equal(existsSync(join(directory, 'session.json')), false);
  assert.equal(existsSync(join(directory, 'qb-study.sqlite')), false);
});
