import { createServer } from 'node:http';
import { timingSafeEqual, randomBytes } from 'node:crypto';
import { readFileSync, existsSync, writeFileSync, unlinkSync, readdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { ReviewJournal, latestReviewDay, createSetManifest, verifySetMembership, readNotionSyncConfig, readEffectiveReviewPlan, readReviewRevision, qbVerificationKey } from './core.mjs';
import { configureNotion } from './notion-setup.mjs';

export const safeCode = error => /^[A-Z][A-Z_]{2,100}$/.test(error?.code ?? error?.message ?? '')
  ? (error.code ?? error.message) : 'QB_OPERATION_FAILED';
const fail = code => { throw new Error(code); };
const dayOK = day => typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day);
const uuidOK = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(value);

/** Only the three public destination IDs and the saved limit may leave this function. */
export function connectionInfo(base) {
  const notion = readNotionSyncConfig(join(base, 'notion-sync.json'));
  if (!notion) return undefined;
  const path = join(base, 'review-config.json');
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192
    || process.platform !== 'win32' && ((stat.mode & 0o077) !== 0
      || process.getuid && stat.uid !== process.getuid())) fail('REVIEW_CONFIG_PERMISSIONS');
  let review;
  try { review = JSON.parse(readFileSync(path, 'utf8')); } catch { fail('REVIEW_CONFIG_INVALID'); }
  if (review?.schema_version !== '1' || review.publisher_host !== hostname()
    || !uuidOK(review.notion_parent_page_id) || !Number.isSafeInteger(review.max_questions)
    || review.max_questions < 1 || review.max_questions > 100) fail('REVIEW_CONFIG_INVALID');
  return { attemptsDataSourceId: notion.attemptsDataSourceId, questionsDataSourceId: notion.questionsDataSourceId,
    reviewParentPageId: review.notion_parent_page_id.toLowerCase(), maxQuestions: review.max_questions };
}


export function validateRegistration(manifest, body) {
  if (body.confirmed !== true || typeof body.ids !== 'string' || body.ids.length > 3000
    || typeof body.url !== 'string' || body.url.length > 500) fail('REVIEW_CONFIRM_REQUIRED');
  const ids = body.ids.trim().toUpperCase().split(/[\s,、]+/u).filter(Boolean);
  const result = verifySetMembership(manifest, ids);
  if (!result.verified) fail('REVIEW_QB_MEMBERSHIP_MISMATCH');
  let url;
  try { url = new URL(body.url.trim()); } catch { fail('REVIEW_QB_URL_INVALID'); }
  if (url.origin !== 'https://qb.medilink-study.com' || url.pathname !== '/search'
    || url.username || url.password || url.hash || url.searchParams.getAll('questionSetId').length !== 1
    || !/^[A-Za-z0-9_-]{1,100}$/.test(url.searchParams.get('questionSetId') ?? '')
    || [...url.searchParams.keys()].some(k => !['questionSetId', 'operation'].includes(k))) fail('REVIEW_QB_URL_INVALID');
  return { ids, url: 'https://qb.medilink-study.com/search?questionSetId=' + url.searchParams.get('questionSetId') + '&operation=OR' };
}

export function assertSetNotReused(base, day, url) {
  const directory = join(base, 'daily-review');
  const journal = new ReviewJournal(directory);
  const setId = new URL(url).searchParams.get('questionSetId');
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!dayOK(entry.name) || entry.name === day) continue;
    if (!entry.isDirectory() || entry.isSymbolicLink()) fail('REVIEW_JOURNAL_CORRUPT');
    const saved = journal.read(entry.name, 'qb-created');
    if (saved && saved.set_id === setId) fail('REVIEW_SET_ALREADY_USED');
  }
}

export function localStatus(base) {
  const file = join(base, 'qb-study.sqlite');
  const output = { total: 0, confirmed: 0, pending: 0, blocked: 0, localOnly: 0, recent: [] };
  if (!existsSync(file)) return output;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout=2000');
    output.total = db.prepare('SELECT COUNT(*) AS n FROM attempts').get().n;
    let target;
    try { target = readNotionSyncConfig(join(base, 'notion-sync.json'))?.target; } catch { /* Config state reported separately. */ }
    const sync = target ? db.prepare(`SELECT resource_key, status, page_id, code FROM notion_sync_journal j
      WHERE target=? AND resource_kind='attempt' AND sequence=(SELECT MAX(sequence) FROM notion_sync_journal x
      WHERE x.target=j.target AND x.resource_kind=j.resource_kind AND x.resource_key=j.resource_key)`).all(target) : [];
    const byId = new Map(sync.map(r => [r.resource_key, r]));
    output.confirmed = sync.filter(r => r.status === 'confirmed' && r.page_id).length;
    output.blocked = sync.filter(r => r.status === 'blocked').length;
    const cutoff = target ? db.prepare('SELECT after_attempt_rowid FROM notion_sync_targets WHERE target=?').get(target)?.after_attempt_rowid : undefined;
    output.localOnly = cutoff === undefined ? output.total : db.prepare('SELECT COUNT(*) AS n FROM attempts WHERE rowid<=?').get(cutoff).n;
    output.pending = Math.max(0, output.total - output.localOnly - output.confirmed - output.blocked);
    output.recent = db.prepare(`SELECT a.rowid AS sequence,a.event_id,a.question_key,a.answered_at,a.result,c.study_mode
      FROM attempts a LEFT JOIN attempt_study_context c USING(event_id) ORDER BY a.rowid DESC LIMIT 20`).all().map(row => {
      const delivery = byId.get(row.event_id);
      return { question: row.question_key, answeredAt: row.answered_at, result: row.result, mode: row.study_mode ?? 'unclassified',
        selected: db.prepare('SELECT option_index FROM attempt_selected_options WHERE event_id=? ORDER BY option_index').all(row.event_id).map(x => x.option_index),
        sync: delivery?.status ?? (cutoff === undefined || row.sequence <= cutoff ? 'local_only' : 'pending'),
        ...(delivery?.status === 'confirmed' && delivery.page_id ? { notionUrl: 'https://www.notion.so/' + delivery.page_id.replaceAll('-', '') } : {}) };
    });
    return output;
  } finally { db.close(); }
}

export function reviewState(base, day = latestReviewDay(new Date().toISOString())) {
  if (!dayOK(day)) fail('REVIEW_DAY_INVALID');
  const journal = new ReviewJournal(join(base, 'daily-review'));
  const plan = readEffectiveReviewPlan(day, journal);
  if (!plan) return { day, prepared: false };
  const notion = journal.read(day, 'notion-verified');
  const revision = readReviewRevision(day, journal);
  return { day, prepared: true, revision: revision?.revision ?? 0, manifest: createSetManifest(plan), items: plan.items,
    started: !!journal.read(day, 'qb-intent'), set: journal.read(day, 'qb-created'),
    verified: !!journal.read(day, qbVerificationKey(plan, journal)),
    linked: !!journal.read(day, 'notion-set-link-verified') && (!revision || !!journal.read(day, 'notion-revision-1-verified')),
    notionUrl: notion ? 'https://www.notion.so/' + notion.id.replaceAll('-', '') : undefined };
}

async function jsonBody(req) {
  if (req.headers['content-type'] !== 'application/json') fail('QB_JSON_REQUIRED');
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > 16_384) fail('QB_REQUEST_TOO_LARGE'); chunks.push(chunk); }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail('QB_JSON_INVALID'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('QB_JSON_INVALID');
  return value;
}

export function createDashboard({ base, appDir, key, port, runReview, restartCollector, collectorStatus,
  shutdown, setup = configureNotion, status = localStatus }) {
  const origin = `http://127.0.0.1:${port}`;
  const secret = Buffer.from(key, 'hex');
  if (secret.length !== 32) fail('QB_SESSION_INVALID');
  let busy = false, closing = false;
  const assets = new Map([['/', ['index.html', 'text/html; charset=utf-8']], ['/client.js', ['client.js', 'text/javascript; charset=utf-8']],
    ['/style.css', ['style.css', 'text/css; charset=utf-8']]]);
  const server = createServer(async (req, res) => {
    const send = (code, value) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    if (req.headers.host !== `127.0.0.1:${port}` || req.socket.remoteAddress !== '127.0.0.1'
      || req.headers.origin && req.headers.origin !== origin || req.headers['sec-fetch-site'] === 'cross-site') return send(403, { code: 'QB_LOCAL_ONLY' });
    const asset = assets.get(req.url);
    if (req.method === 'GET' && asset) {
      res.writeHead(200, { 'Content-Type': asset[1] }); res.end(readFileSync(join(appDir, asset[0]))); return;
    }
    const presented = req.headers['x-qb-local-key'];
    if (typeof presented !== 'string' || !/^[a-f0-9]{64}$/.test(presented)
      || !timingSafeEqual(Buffer.from(presented, 'hex'), secret)) return send(403, { code: 'QB_SESSION_REQUIRED' });
    if (req.method === 'GET' && req.url === '/api/ping') return send(200, { product: 'QBStudyFriend', version: '1.1.0-preview', busy });
    if (req.method === 'GET' && req.url === '/api/status') {
      try {
        let configured = false, configError, connection;
        try {
          configured = !!readNotionSyncConfig(join(base, 'notion-sync.json'));
          if (configured) connection = connectionInfo(base);
        } catch (error) { configError = safeCode(error); }
        send(200, { configured, configError, connection, collector: collectorStatus(), records: status(base), review: reviewState(base), busy });
      } catch (error) { send(500, { code: safeCode(error) }); }
      return;
    }
    if (req.method !== 'POST' || req.headers.origin !== origin) return send(403, { code: 'QB_ORIGIN_REQUIRED' });
    if (!['/api/setup', '/api/prepare', '/api/begin', '/api/register', '/api/shutdown'].includes(req.url)) return send(404, { code: 'QB_ROUTE_UNKNOWN' });
    if (closing) return send(409, { code: 'QB_STOPPING' });
    if (busy) return send(409, { code: 'QB_BUSY' });
    busy = true;
    try {
      const body = await jsonBody(req);
      if (req.url === '/api/shutdown') {
        closing = true;
        send(200, { stopped: true }); setImmediate(() => { void shutdown(); }); return;
      }
      if (req.url === '/api/setup') {
        const result = await setup({ base, parentPage: body.parentPage, token: body.token });
        await restartCollector();
        send(200, result); return;
      }
      if (!readNotionSyncConfig(join(base, 'notion-sync.json'))) fail('REVIEW_NOTION_REQUIRED');
      if (req.url === '/api/prepare') {
        const day = latestReviewDay(new Date().toISOString());
        if (body.day !== undefined && (!dayOK(body.day) || body.day !== day)) fail('REVIEW_DAY_CHANGED');
        // The CLI verifies this same day again immediately before creating a plan.
        send(200, await runReview(['prepare', '-', day])); return;
      }
      if (!dayOK(body.day) || body.day !== latestReviewDay(new Date().toISOString())) fail('REVIEW_DAY_CHANGED');
      const current = reviewState(base, body.day);
      if (!current.prepared || !current.manifest.question_ids.length) fail('REVIEW_PLAN_EMPTY');
      if (req.url === '/api/begin') { send(200, await runReview(['begin-set', '-', body.day])); return; }
      const observed = validateRegistration(current.manifest, body);
      if (!current.started) fail('REVIEW_QB_INTENT_REQUIRED');
      assertSetNotReused(base, body.day, observed.url);
      const temp = join(base, 'observed-' + randomBytes(16).toString('hex') + '.json');
      writeFileSync(temp, JSON.stringify(observed.ids), { flag: 'wx', mode: 0o600 });
      try {
        await runReview(['record-set', observed.url, body.day]);
        await runReview(['verify-set', temp, body.day]);
        const result = await runReview(['link-set', '-', body.day]);
        send(200, result);
      } finally { unlinkSync(temp); }
    } catch (error) { send(400, { code: safeCode(error) }); }
    finally { busy = false; }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.beginShutdown = () => { closing = true; };
  return server;
}
