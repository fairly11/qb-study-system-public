import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const executable = fileURLToPath(new URL('../dist/QBStudyFriend-Windows11-1.1.0-preview/collector/dist/collector.mjs', import.meta.url));

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

test('packaged collector commits evidence, shuts down through Windows IPC and preserves it across replay', { timeout: 25_000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'qb-friend-test-lifecycle-'));
  const runs = [];
  t.after(async () => {
    for (const run of runs) {
      if (run.child.exitCode === null && run.child.signalCode === null) run.child.kill();
      await run.exited;
    }
    rmSync(directory, { recursive: true, force: true });
  });
  const envelope = {
    attempt: { schema_version: '1', record_type: 'attempt_event',
      event_id: '10000000-0000-4000-8000-000000000001', question_key: '119A1',
      answered_at: '2026-10-01T00:00:00.000Z', result: 'incorrect', selected_option_indices: [2, 1],
      provenance: { producer: 'browser-extension', producer_version: '0.1.2', source_system: 'qb-web-dom',
        recorded_at: '2026-10-01T00:00:00.000Z' },
      quality: { acquisition_method: 'direct_capture', temporal_precision: 'exact', state_precision: 'exact' } },
    context: { schema_version: '1', record_type: 'study_context',
      event_id: '10000000-0000-4000-8000-000000000001', study_mode: 'review',
      review_plan_id: '90000000-0000-4000-8000-000000000001' },
  };
  const first = await startCollector(directory, await unusedPort());
  runs.push(first);
  const inserted = await submit(first.port, envelope);
  assert.equal(inserted.code, 200);
  assert.deepEqual(inserted.body, { event_id: envelope.attempt.event_id, status: 'inserted' });
  const whileRunning = storedEvidence(directory);
  assert.equal(whileRunning.attempts.length, 1);
  assert.equal(whileRunning.choices.length, 2);
  assert.equal(whileRunning.contexts[0].study_mode, 'review');
  await stopCollector(first);
  assert.deepEqual(storedEvidence(directory), whileRunning);

  const second = await startCollector(directory, await unusedPort());
  runs.push(second);
  assert.deepEqual(await submit(second.port, envelope), { code: 200,
    body: { event_id: envelope.attempt.event_id, status: 'duplicate' } });
  assert.equal((await submit(second.port, { ...envelope, context: { ...envelope.context, study_mode: 'normal', review_plan_id: undefined } })).code, 409);
  await stopCollector(second);
  assert.deepEqual(storedEvidence(directory), whileRunning);
});
