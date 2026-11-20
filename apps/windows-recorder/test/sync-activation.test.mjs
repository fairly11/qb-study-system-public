import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const packageRoot = process.env.QB_WINDOWS_PACKAGE ?? fileURLToPath(new URL('../dist/QBRecord-Windows11-0.1.1-preview/', import.meta.url));
assert.ok(isAbsolute(packageRoot));
const executable = join(packageRoot, 'collector/dist/collector.mjs');
const attemptsId = '10000000-0000-4000-8000-000000000003';
const questionsId = '10000000-0000-4000-8000-000000000002';

async function unusedPort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  assert.ok(Number.isSafeInteger(port) && port > 1024 && port !== 8765 && port !== 8766);
  return port;
}

function prepareDatabase(directory) {
  const db = new DatabaseSync(join(directory, 'qb-study.sqlite'));
  try {
    db.exec(`PRAGMA foreign_keys=ON; CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY CHECK(version BETWEEN 1 AND 9007199254740991),
      name TEXT NOT NULL UNIQUE, checksum TEXT NOT NULL CHECK(length(checksum)=64), applied_at TEXT NOT NULL
    ) STRICT;`);
    const migrations = join(packageRoot, 'collector/migrations');
    for (const name of readdirSync(migrations).filter(name => /^\d{4}_[a-z0-9_]+\.sql$/u.test(name)).sort()) {
      const sql = readFileSync(join(migrations, name), 'utf8');
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations VALUES(?,?,?,?)').run(Number(name.slice(0, 4)), name.slice(5, -4),
        createHash('sha256').update(sql).digest('hex'), '2026-11-15T00:00:00Z');
    }
    // Fail only the activation INSERT; normal migrations and answer persistence still work.
    db.exec(`CREATE TRIGGER synthetic_activation_failure BEFORE INSERT ON notion_sync_targets
      BEGIN SELECT RAISE(ABORT, 'SYNTHETIC_ACTIVATION_FAILURE'); END;`);
  } finally { db.close(); }
}

function configure(directory) {
  const tokenFile = join(directory, 'notion-token');
  writeFileSync(tokenFile, 'synthetic_not_a_real_credential_12345', { mode: 0o600 });
  writeFileSync(join(directory, 'notion-sync.json'), JSON.stringify({ schema_version: '1', enabled: true,
    attempts_data_source_id: attemptsId, questions_data_source_id: questionsId, token_file: tokenFile }), { mode: 0o600 });
}

function launch(directory, port) {
  const environment = {
    QB_STUDY_HOME: directory, QB_STUDY_DB_PATH: join(directory, 'qb-study.sqlite'),
    QB_STUDY_COLLECTOR_PORT: String(port), TEMP: directory, TMP: directory, TMPDIR: directory,
    ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {}),
  };
  const denyFetch = 'data:text/javascript,' + encodeURIComponent(
    'globalThis.fetch = async () => { process.stdout.write(JSON.stringify({event_code:"TEST_FETCH_BLOCKED"})+"\\n"); throw new Error("TEST_EXTERNAL_NETWORK_FORBIDDEN"); };');
  const child = spawn(process.execPath, ['--import', denyFetch, executable], {
    env: environment, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true,
  });
  const events = [];
  for (const stream of [child.stdout, child.stderr]) {
    let partial = '';
    stream.on('data', chunk => {
      partial += chunk.toString();
      const lines = partial.split('\n'); partial = lines.pop();
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          if (/^[A-Z_]+$/u.test(event.event_code ?? '')) events.push(event.event_code);
        } catch { /* Never retain arbitrary native output. */ }
      }
    });
  }
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  return { child, events, exited, port };
}

async function within(promise, milliseconds) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('TEST_PROCESS_TIMEOUT')), milliseconds);
  })]).finally(() => clearTimeout(timer));
}

async function waitForListening(run) {
  if (run.events.includes('COLLECTOR_LISTENING')) return;
  await within(new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (run.events.includes('COLLECTOR_LISTENING')) { clearInterval(timer); resolve(); }
      else if (run.child.exitCode !== null || run.child.signalCode !== null) {
        clearInterval(timer); reject(new Error('TEST_COLLECTOR_EARLY_EXIT'));
      }
    }, 10);
    run.exited.finally(() => clearInterval(timer));
  }), 5000);
}

const record = {
  attempt: { schema_version: '1', record_type: 'attempt_event', event_id: '20000000-0000-4000-8000-000000000001',
    question_key: '115A1', answered_at: '2026-11-15T00:00:00.000Z', result: 'incorrect', selected_option_indices: [2],
    provenance: { producer: 'browser-extension', producer_version: '0.1.2', source_system: 'qb-web-dom',
      recorded_at: '2026-11-15T00:00:00.000Z' },
    quality: { acquisition_method: 'direct_capture', temporal_precision: 'exact', state_precision: 'exact' } },
  context: { schema_version: '1', record_type: 'study_context', event_id: '20000000-0000-4000-8000-000000000001', study_mode: 'normal' },
};
function submit(port) {
  assert.ok(port !== 8765 && port !== 8766);
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(record);
    const req = request({ host: '127.0.0.1', port, path: '/v2/attempt-events', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Connection: 'close' },
      timeout: 2000 }, res => {
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

function stored(directory) {
  const db = new DatabaseSync(join(directory, 'qb-study.sqlite'), { readOnly: true });
  try {
    return { attempts: db.prepare('SELECT rowid,event_id FROM attempts').all(),
      targets: db.prepare('SELECT after_attempt_rowid FROM notion_sync_targets').all() };
  } finally { db.close(); }
}

test('failed initial sync activation prevents receipt; recovery activates before offline answer capture', { timeout: 15_000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'qb-recorder-test-activation-'));
  const runs = [];
  t.after(async () => {
    for (const run of runs) {
      if (run.child.exitCode === null && run.child.signalCode === null) run.child.kill();
      await run.exited;
    }
    rmSync(directory, { recursive: true, force: true });
  });
  prepareDatabase(directory); configure(directory);
  const blocked = launch(directory, await unusedPort()); runs.push(blocked);
  assert.deepEqual(await within(blocked.exited, 5000), { code: 1, signal: null });
  assert.ok(blocked.events.includes('NOTION_CONFIGURATION_BLOCKED'));
  assert.equal(blocked.events.includes('COLLECTOR_LISTENING'), false);
  assert.equal(blocked.events.includes('TEST_FETCH_BLOCKED'), false);
  await assert.rejects(submit(blocked.port), error => error.code === 'ECONNREFUSED');
  assert.deepEqual(stored(directory), { attempts: [], targets: [] });

  const db = new DatabaseSync(join(directory, 'qb-study.sqlite'));
  try { db.exec('DROP TRIGGER synthetic_activation_failure'); } finally { db.close(); }
  const recovered = launch(directory, await unusedPort()); runs.push(recovered);
  await waitForListening(recovered);
  assert.deepEqual(await submit(recovered.port), { code: 200,
    body: { event_id: record.attempt.event_id, status: 'inserted' } });
  const evidence = stored(directory);
  assert.equal(evidence.attempts.length, 1); assert.equal(evidence.targets.length, 1);
  assert.equal(evidence.targets[0].after_attempt_rowid, 0);
  assert.ok(evidence.attempts[0].rowid > evidence.targets[0].after_attempt_rowid);
  assert.ok(recovered.events.includes('TEST_FETCH_BLOCKED'), 'the network failure is intercepted without preventing local capture');
  await new Promise((resolve, reject) => recovered.child.send({ type: 'qb-study-shutdown' }, error => error ? reject(error) : resolve()));
  assert.deepEqual(await within(recovered.exited, 5000), { code: 0, signal: null });
  assert.deepEqual(stored(directory), evidence);
});
