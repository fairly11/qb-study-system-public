import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, dirname, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { createDashboard, safeCode, connectionInfo } from './server.mjs';

const appDir = dirname(fileURLToPath(import.meta.url));
const root = dirname(appDir);
const testing = process.argv.includes('--test');
const base = testing ? process.env.QB_RECORDER_TEST_DATA : join(root, 'data');
const port = testing ? Number(process.env.QB_RECORDER_TEST_WEB_PORT) : 8766;
const collectorPort = testing ? Number(process.env.QB_RECORDER_TEST_COLLECTOR_PORT) : 8765;
const sessionPath = base && join(base, 'session.json');
let child, server, stopping = false, state = 'needs_setup', lastCode;
function exec(file, args, options = {}) {
  return new Promise((resolve, reject) => execFile(file, args, { windowsHide: true, timeout: 180_000, maxBuffer: 2_097_152, ...options },
    (error, stdout) => error ? reject(new Error('QB_COMMAND_FAILED')) : resolve(stdout)));
}
function openChrome(url) {
  const paths = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean)
    .map(directory => join(directory, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  const chrome = paths.find(existsSync);
  if (!chrome) throw new Error('QB_CHROME_NOT_FOUND');
  const opened = spawn(chrome, [url], { detached: true, windowsHide: true, stdio: 'ignore' });
  opened.on('error', () => process.stdout.write('QB_CHROME_OPEN_FAILED\n'));
  opened.unref();
}
async function verifyPrivacy() {
  if (testing) {
    if (!base || !isAbsolute(base) || base === join(root, 'data') || !base.includes('qb-recorder-test-')
      || !Number.isInteger(port) || !Number.isInteger(collectorPort) || port === collectorPort
      || [port, collectorPort].some(n => n < 1024 || n > 65535 || n === 8765 || n === 8766)) throw new Error('QB_TEST_ISOLATION_REQUIRED');
    mkdirSync(base, { recursive: true, mode: 0o700 }); return;
  }
  if (process.platform !== 'win32' || !process.env.LOCALAPPDATA
    || resolve(root).toLowerCase() !== resolve(process.env.LOCALAPPDATA, 'QBRecordWindows').toLowerCase()) throw new Error('QB_WINDOWS_INSTALL_REQUIRED');
  const powershell = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = await exec(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'scripts', 'Check-Privacy.ps1'), '-Root', root]);
  if (result.trim() !== 'QB_PRIVACY_OK') throw new Error('QB_PRIVACY_BLOCKED');
}
function environment() {
  const env = { ...process.env, QB_STUDY_HOME: base, QB_STUDY_DB_PATH: join(base, 'qb-study.sqlite'), QB_STUDY_COLLECTOR_PORT: String(collectorPort) };
  delete env.QB_STUDY_NOTION_CONFIG;
  delete env.QB_REVIEW_PARENT_PAGE_ID;
  // The private runtime must not inherit a developer's loader or debugging flags.
  delete env.NODE_OPTIONS;
  return env;
}
function configured() {
  return connectionInfo(base) !== undefined;
}
async function startCollector() {
  // Do not receive answers before the initial sync target has been activated.
  if (!configured()) { state = 'needs_setup'; lastCode = undefined; return; }
  state = 'starting'; lastCode = undefined;
  const current = spawn(process.execPath, [join(root, 'collector', 'dist', 'collector.mjs')],
    { env: environment(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  child = current;
  try {
    await new Promise((resolve, reject) => {
      let started = false, buffer = '';
      const timer = setTimeout(() => reject(new Error('QB_COLLECTOR_START_TIMEOUT')), 15_000);
      const parse = line => {
        let event; try { event = JSON.parse(line); } catch { return; }
        if (/^[A-Z_]{3,100}$/.test(event.event_code ?? '')) {
          if (event.event_code === 'COLLECTOR_LISTENING') { started = true; state = 'running'; clearTimeout(timer); resolve(); }
          else if (event.event_code.includes('BLOCKED') || event.event_code.includes('UNAVAILABLE')) lastCode = event.event_code;
        }
      };
      current.stdout.on('data', chunk => { buffer += chunk.toString(); const lines = buffer.split('\n'); buffer = lines.pop().slice(-8192); lines.forEach(parse); });
      current.stderr.on('data', chunk => chunk.toString().split('\n').forEach(parse));
      current.on('error', () => { clearTimeout(timer); state = 'failed'; reject(new Error('QB_COLLECTOR_START_FAILED')); });
      current.on('exit', () => {
        clearTimeout(timer);
        if (child === current) { child = undefined; state = stopping ? 'stopped' : 'failed'; }
        if (!started) reject(new Error(lastCode ?? 'QB_COLLECTOR_START_FAILED'));
      });
    });
  } catch (error) {
    await stopCollector();
    state = 'failed'; lastCode = safeCode(error);
    throw error;
  }
}
async function stopCollector() {
  const current = child; if (!current || current.exitCode !== null || current.signalCode !== null) return;
  await new Promise(resolve => {
    const timer = setTimeout(() => { current.kill(); }, 20_000);
    current.once('exit', () => { clearTimeout(timer); resolve(); });
    if (current.connected) current.send({ type: 'qb-study-shutdown' }, error => { if (error) current.kill(); }); else current.kill();
  });
}
async function restartCollector() {
  await stopCollector();
  try { await startCollector(); }
  catch (error) { state = 'failed'; lastCode = safeCode(error); throw error; }
  if (state !== 'running') throw new Error('QB_SETUP_REQUIRED');
}
async function shutdown() {
  if (stopping) return; stopping = true;
  server?.beginShutdown();
  await stopCollector();
  if (server?.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  try { if (JSON.parse(readFileSync(sessionPath, 'utf8')).pid === process.pid) unlinkSync(sessionPath); } catch { /* No foreign session changes. */ }
}
async function existing(action) {
  let session;
  try { session = JSON.parse(readFileSync(sessionPath, 'utf8')); } catch { throw new Error('QB_NOT_RUNNING'); }
  if (session.product !== 'QBRecordWindows' || session.port !== port || !/^[a-f0-9]{64}$/.test(session.key ?? '')) throw new Error('QB_SESSION_INVALID');
  const origin = `http://127.0.0.1:${port}`;
  const headers = { 'X-QB-Local-Key': session.key, Origin: origin, 'Content-Type': 'application/json' };
  const ping = await fetch(origin + '/api/ping', { headers, signal: AbortSignal.timeout(3000) });
  if (!ping.ok || (await ping.json()).product !== 'QBRecordWindows') throw new Error('QB_NOT_RUNNING');
  if (action === 'stop') {
    const response = await fetch(origin + '/api/shutdown', { method: 'POST', headers, body: '{}', signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('QB_BUSY');
    process.stdout.write('QB_STOP_REQUESTED\n');
  } else if (!testing) openChrome(origin + '/#' + session.key);
}
async function main() {
  await verifyPrivacy();
  if (process.argv.includes('--stop')) { await existing('stop'); return; }
  if (process.argv.includes('--open')) { await existing('open'); return; }
  const key = randomBytes(32).toString('hex');
  server = createDashboard({ base, appDir, port, key,
    collectorStatus: () => ({ state, code: lastCode }), restartCollector, shutdown });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  try { await startCollector(); }
  catch (error) { state = 'failed'; lastCode = safeCode(error); }
  writeFileSync(sessionPath, JSON.stringify({ product: 'QBRecordWindows', pid: process.pid, port, key }), { mode: 0o600 });
  process.stdout.write('QB_RECORDER_READY\n');
  if (!testing && !process.argv.includes('--no-browser')) {
    try { openChrome(`http://127.0.0.1:${port}/#${key}`); }
    catch { process.stdout.write('QB_CHROME_NOT_FOUND\n'); }
  }
  process.once('SIGINT', () => { void shutdown(); });
  process.once('SIGTERM', () => { void shutdown(); });
}
main().catch(async error => { process.stderr.write(safeCode(error) + '\n'); await shutdown(); process.exitCode = 1; });
