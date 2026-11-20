import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFileSync, existsSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readNotionSyncConfig } from './core.mjs';
import { configureNotion } from './notion-setup.mjs';

const CODES = new Set(['QB_OPERATION_FAILED', 'QB_SESSION_INVALID', 'QB_SESSION_REQUIRED', 'QB_LOCAL_ONLY',
  'QB_ORIGIN_REQUIRED', 'QB_ROUTE_UNKNOWN', 'QB_BUSY', 'QB_STOPPING', 'QB_JSON_REQUIRED', 'QB_JSON_INVALID',
  'QB_REQUEST_TOO_LARGE', 'QB_REQUEST_FIELDS_INVALID', 'QB_COLLECTOR_START_FAILED', 'QB_COLLECTOR_START_TIMEOUT',
  'QB_COMMAND_FAILED', 'QB_CHROME_NOT_FOUND', 'QB_CHROME_OPEN_FAILED', 'QB_TEST_ISOLATION_REQUIRED',
  'QB_WINDOWS_INSTALL_REQUIRED', 'QB_SETUP_REQUIRED', 'QB_NOT_RUNNING',
  'QB_PRIVACY_BLOCKED', 'QB_RECORDS_UNAVAILABLE', 'NOTION_SETUP_EXISTS', 'NOTION_SETUP_ID_INVALID',
  'NOTION_SETUP_TOKEN_INVALID', 'NOTION_SETUP_FILE_UNSAFE', 'NOTION_SETUP_READ_ONLY', 'NOTION_SETUP_PARENT_INVALID',
  'NOTION_SETUP_FAILED', 'NOTION_UNAUTHORIZED', 'NOTION_FORBIDDEN', 'NOTION_NOT_FOUND', 'NOTION_RATE_LIMITED',
  'NOTION_REQUEST_REJECTED', 'NOTION_RESPONSE_INVALID', 'NOTION_RESPONSE_TOO_LARGE', 'NOTION_NETWORK_ERROR',
  'NOTION_SCHEMA_MISMATCH', 'NOTION_STUDY_CONTEXT_SCHEMA_REQUIRED', 'NOTION_SERVICE_UNAVAILABLE',
  'NOTION_CONFIG_INVALID', 'NOTION_CONFIG_MISSING', 'NOTION_CONFIG_PERMISSIONS', 'NOTION_TOKEN_INVALID',
  'REVIEW_CONFIG_INVALID', 'REVIEW_CONFIG_PERMISSIONS', 'COLLECTOR_START_BLOCKED', 'COLLECTOR_PORT_UNAVAILABLE',
  'COLLECTOR_CONFIGURATION_BLOCKED', 'NOTION_CONFIGURATION_BLOCKED', 'NOTION_SYNC_UNAVAILABLE']);
export const safeCode = error => CODES.has(error?.code ?? error?.message) ? (error.code ?? error.message) : 'QB_OPERATION_FAILED';
const fail = code => { throw new Error(code); };
const uuidOK = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(value);

/** Deliberately returns only destination identifiers, never a token or its file path. */
export function connectionInfo(base) {
  const notion = readNotionSyncConfig(join(base, 'notion-sync.json'));
  if (!notion) {
    if (['notion-token', 'review-config.json'].some(name => existsSync(join(base, name)))) fail('NOTION_SETUP_EXISTS');
    return undefined;
  }
  const path = join(base, 'review-config.json');
  let review;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192 || process.platform !== 'win32'
      && ((stat.mode & 0o077) !== 0 || process.getuid && stat.uid !== process.getuid())) fail('REVIEW_CONFIG_PERMISSIONS');
    review = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) { if (error.message === 'REVIEW_CONFIG_PERMISSIONS') throw error; fail('REVIEW_CONFIG_INVALID'); }
  if (!review || typeof review !== 'object' || Array.isArray(review)
    || Object.keys(review).sort().join(',') !== 'notion_parent_page_id,schema_version'
    || review.schema_version !== '1' || !uuidOK(review.notion_parent_page_id)) fail('REVIEW_CONFIG_INVALID');
  return { attemptsDataSourceId: notion.attemptsDataSourceId, questionsDataSourceId: notion.questionsDataSourceId,
    reviewParentPageId: review.notion_parent_page_id.toLowerCase() };
}

export function localStatus(base) {
  const file = join(base, 'qb-study.sqlite');
  const output = { total: 0, confirmed: 0, pending: 0, blocked: 0, localOnly: 0, recent: [] };
  if (!existsSync(file)) return output;
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) fail('QB_RECORDS_UNAVAILABLE');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout=2000');
    let target;
    try { target = readNotionSyncConfig(join(base, 'notion-sync.json'))?.target; } catch { /* Separately reported by the connection check. */ }
    const cutoff = target ? db.prepare('SELECT after_attempt_rowid FROM notion_sync_targets WHERE target=?').get(target)?.after_attempt_rowid : undefined;
    const rows = db.prepare(`SELECT a.rowid AS sequence,a.event_id,j.status,j.page_id
      FROM attempts a LEFT JOIN notion_sync_journal j ON j.target=? AND j.resource_kind='attempt'
        AND j.resource_key=a.event_id AND j.sequence=(SELECT MAX(sequence) FROM notion_sync_journal x
          WHERE x.target=j.target AND x.resource_kind=j.resource_kind AND x.resource_key=j.resource_key)`).all(target ?? '');
    const byId = new Map();
    for (const row of rows) {
      const sync = cutoff === undefined || row.sequence <= cutoff ? 'local_only'
        : row.status === 'confirmed' && row.page_id ? 'confirmed' : row.status ?? 'pending';
      byId.set(row.event_id, { sync, pageId: row.page_id });
      output.total++;
      if (sync === 'local_only') output.localOnly++;
      else if (sync === 'confirmed') output.confirmed++;
      else if (sync === 'blocked' || sync === 'creating') output.blocked++;
      else output.pending++;
    }
    const selections = db.prepare('SELECT option_index FROM attempt_selected_options WHERE event_id=? ORDER BY option_index');
    output.recent = db.prepare(`SELECT a.event_id,a.question_key,a.answered_at,a.result,c.study_mode
      FROM attempts a LEFT JOIN attempt_study_context c USING(event_id) ORDER BY a.rowid DESC LIMIT 20`).all().map(row => {
      const delivery = byId.get(row.event_id);
      return { question: row.question_key, answeredAt: row.answered_at, result: row.result, mode: row.study_mode ?? 'unclassified',
        selected: selections.all(row.event_id).map(value => value.option_index), sync: delivery?.sync ?? 'pending',
        ...(delivery?.sync === 'confirmed' && uuidOK(delivery.pageId)
          ? { notionUrl: 'https://www.notion.so/' + delivery.pageId.replaceAll('-', '') } : {}) };
    });
    return output;
  } finally { db.close(); }
}

async function jsonBody(req) {
  if (req.headers['content-type'] !== 'application/json' || req.headers['content-encoding']) fail('QB_JSON_REQUIRED');
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 16_384) fail('QB_REQUEST_TOO_LARGE'); chunks.push(chunk); }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail('QB_JSON_INVALID'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('QB_JSON_INVALID');
  return value;
}

export function createDashboard({ base, appDir, key, port, restartCollector, collectorStatus, shutdown,
  setup = configureNotion, status = localStatus }) {
  if (typeof key !== 'string' || !/^[a-f0-9]{64}$/u.test(key)
    || !Number.isSafeInteger(port) || port < 1 || port > 65535) fail('QB_SESSION_INVALID');
  const origin = `http://127.0.0.1:${port}`, secret = Buffer.from(key, 'hex');
  let busy = false, closing = false;
  const assets = new Map([['/', ['index.html', 'text/html; charset=utf-8']],
    ['/client.js', ['client.js', 'text/javascript; charset=utf-8']], ['/style.css', ['style.css', 'text/css; charset=utf-8']]]);
  const server = createServer(async (req, res) => {
    const send = (code, value) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    if (req.headers.host !== `127.0.0.1:${port}` || req.socket.remoteAddress !== '127.0.0.1'
      || req.headers.origin && req.headers.origin !== origin || req.headers['sec-fetch-site'] === 'cross-site') {
      req.resume(); return send(403, { code: 'QB_LOCAL_ONLY' });
    }
    const asset = assets.get(req.url);
    if (req.method === 'GET' && asset) {
      try { const content = readFileSync(join(appDir, asset[0])); res.writeHead(200, { 'Content-Type': asset[1] }); res.end(content); }
      catch { send(500, { code: 'QB_OPERATION_FAILED' }); }
      return;
    }
    const presented = req.headers['x-qb-local-key'];
    if (typeof presented !== 'string' || !/^[a-f0-9]{64}$/u.test(presented)
      || !timingSafeEqual(Buffer.from(presented, 'hex'), secret)) { req.resume(); return send(403, { code: 'QB_SESSION_REQUIRED' }); }
    if (req.method === 'GET' && req.url === '/api/ping') return send(200, { product: 'QBRecordWindows', version: '0.1.1-preview', busy });
    if (req.method === 'GET' && req.url === '/api/status') {
      try {
        let connection, configError;
        try { connection = connectionInfo(base); } catch (error) { configError = safeCode(error); }
        const current = collectorStatus();
        const collector = { state: ['running', 'starting', 'stopped', 'failed', 'unconfigured', 'needs_setup'].includes(current?.state) ? current.state : 'stopped',
          ...(current?.code ? { code: safeCode({ code: current.code }) } : {}) };
        send(200, { configured: !!connection, configError, connection, collector, records: status(base), busy });
      } catch { send(500, { code: 'QB_RECORDS_UNAVAILABLE' }); }
      return;
    }
    if (req.method !== 'POST' || !['/api/setup', '/api/shutdown'].includes(req.url)) {
      req.resume(); return send(404, { code: 'QB_ROUTE_UNKNOWN' });
    }
    if (req.headers.origin !== origin) { req.resume(); return send(403, { code: 'QB_ORIGIN_REQUIRED' }); }
    if (closing || busy) { req.resume(); return send(409, { code: closing ? 'QB_STOPPING' : 'QB_BUSY' }); }
    busy = true;
    try {
      const body = await jsonBody(req);
      if (req.url === '/api/shutdown') {
        if (Object.keys(body).length) fail('QB_REQUEST_FIELDS_INVALID');
        closing = true;
        send(200, { stopped: true }); setImmediate(() => { void Promise.resolve().then(shutdown).catch(() => undefined); }); return;
      }
      if (Object.keys(body).sort().join(',') !== 'attemptsDataSourceId,questionsDataSourceId,reviewParentPageId,token') fail('QB_REQUEST_FIELDS_INVALID');
      const result = await setup({ base, token: body.token, attemptsDataSourceId: body.attemptsDataSourceId,
        questionsDataSourceId: body.questionsDataSourceId, reviewParentPageId: body.reviewParentPageId });
      await restartCollector();
      send(200, { status: 'configured', attemptsDataSourceId: result.attemptsDataSourceId,
        questionsDataSourceId: result.questionsDataSourceId, reviewParentPageId: result.reviewParentPageId });
    } catch (error) { send(400, { code: safeCode(error) }); }
    finally { busy = false; }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.maxHeadersCount = 32;
  server.maxConnections = 16;
  server.beginShutdown = () => { closing = true; };
  return server;
}
