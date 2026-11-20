import { randomUUID, timingSafeEqual } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const API = 'https://api.notion.com/v1';
const VERSION = '2025-09-03';
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;
const TITLES = { questions: 'QB問題マスター', attempts: 'QB解答ログ' };
const MAX_BYTES = 1_048_576;
const CODE = /^NOTION_[A-Z_]+$/u;

export class NotionSetupError extends Error {
  constructor(code, { ambiguous = false } = {}) {
    super(code);
    this.name = 'NotionSetupError';
    this.code = code;
    this.ambiguous = ambiguous;
  }
}
function fail(code) { throw new NotionSetupError(code); }
function uuid(value) {
  if (typeof value !== 'string' || !UUID.test(value)) fail('NOTION_SETUP_ID_INVALID');
  return value.toLowerCase();
}
function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function rt(value) { return [{ type: 'text', text: { content: value } }]; }
function text(items) { return Array.isArray(items) ? items.map(x => x?.plain_text ?? x?.text?.content ?? '').join('') : ''; }

/** Accept a page UUID or an HTTPS Notion page URL; never fetch user-provided URLs. */
export function parseParentPage(value) {
  if (typeof value !== 'string' || value.length > 2_048) fail('NOTION_SETUP_PARENT_INVALID');
  let raw = value.trim();
  if (/^[0-9a-f]{32}$/iu.test(raw)) raw = raw.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/u, '$1-$2-$3-$4-$5');
  if (UUID.test(raw)) return uuid(raw);
  let url;
  try { url = new URL(raw); } catch { fail('NOTION_SETUP_PARENT_INVALID'); }
  if (url.protocol !== 'https:' || url.username || url.password
    || !['notion.so', 'www.notion.so', 'notion.com', 'www.notion.com', 'app.notion.com', 'notion.site', 'www.notion.site'].includes(url.hostname)
      && !url.hostname.endsWith('.notion.site')) fail('NOTION_SETUP_PARENT_INVALID');
  const last = url.pathname.replace(/\/$/u, '').split('/').at(-1) ?? '';
  const match = last.match(/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|[0-9a-f]{32})$/iu);
  if (!match) fail('NOTION_SETUP_PARENT_INVALID');
  return parseParentPage(match[1]);
}

export function questionProperties() {
  return { '問題番号': { title: {} }, '問題キー': { rich_text: {} }, '復習停止': { checkbox: {} },
    '次回復習日': { date: {} }, '科目': { rich_text: {} }, '分野': { rich_text: {} } };
}
export function attemptProperties(questionsDataSourceId) {
  const select = names => ({ select: { options: names.map(name => ({ name })) } });
  return {
    '記録名': { title: {} }, 'イベントID': { rich_text: {} }, '問題キー': { rich_text: {} },
    '問題番号': { rich_text: {} }, '自分の解答': { rich_text: {} },
    '判定': select(['正解', '不正解', '未判定']), '解答日時': { date: {} }, '学習日': { date: {} },
    '取得日時': { date: {} },
    '問題': { relation: { data_source_id: uuid(questionsDataSourceId), single_property: {} } },
    '記録元': select(['Chrome拡張', 'Safari拡張']), 'スキーマバージョン': { rich_text: {} },
    '学習種別': select(['通常学習', '復習', '未分類']), '記録データV1': { rich_text: {} },
    '学習目的データV1': { rich_text: {} }, '拡張バージョン': { rich_text: {} }, '集計除外': { checkbox: {} },
  };
}

function privateFile(path, maximum = MAX_BYTES) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum
    || process.platform !== 'win32' && ((stat.mode & 0o077) !== 0
      || process.getuid && stat.uid !== process.getuid())) fail('NOTION_SETUP_FILE_UNSAFE');
  return readFileSync(path, 'utf8');
}
function syncDirectory(base) {
  // Windows durability/ACL is provided by the installer; opening a directory is not portable.
  if (process.platform === 'win32') return;
  const fd = openSync(base, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function writeNew(path, content) {
  const fd = openSync(path, 'wx', 0o600);
  try { writeFileSync(fd, content, 'utf8'); fsyncSync(fd); } finally { closeSync(fd); }
}
function writeState(base, state) {
  const path = join(base, 'notion-setup-state.json');
  if (existsSync(path)) privateFile(path);
  const temporary = join(base, `.notion-setup-${randomUUID()}.tmp`);
  try {
    writeNew(temporary, JSON.stringify(state, null, 2) + '\n');
    renameSync(temporary, path);
    syncDirectory(base);
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}
function readState(path) {
  let s;
  try { s = JSON.parse(privateFile(path)); } catch (e) {
    if (e instanceof NotionSetupError) throw e;
    fail('NOTION_SETUP_STATE_INVALID');
  }
  const allowed = ['schema_version', 'setup_id', 'parent_page_id', 'publisher_host', 'max_questions', 'questions', 'attempts', 'complete'];
  if (!record(s) || Object.keys(s).some(k => !allowed.includes(k)) || s.schema_version !== '1'
    || !UUID.test(s.setup_id ?? '') || !UUID.test(s.parent_page_id ?? '')
    || typeof s.publisher_host !== 'string' || !Number.isSafeInteger(s.max_questions)
    || s.max_questions < 1 || s.max_questions > 100 || typeof s.complete !== 'boolean') fail('NOTION_SETUP_STATE_INVALID');
  for (const kind of ['questions', 'attempts']) {
    const step = s[kind];
    if (step === undefined) continue;
    if (!record(step) || Object.keys(step).some(k => !['status', 'database_id', 'data_source_id'].includes(k))
      || !['intent', 'rejected', 'created'].includes(step.status)
      || step.database_id !== undefined && !UUID.test(step.database_id)
      || step.data_source_id !== undefined && !UUID.test(step.data_source_id)
      || step.status === 'created' && (!step.database_id || !step.data_source_id)) fail('NOTION_SETUP_STATE_INVALID');
  }
  return s;
}
function tokenEqual(a, b) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
function sameJson(a, b) {
  return record(a) && record(b) && Object.keys(a).length === Object.keys(b).length
    && Object.keys(b).every(key => a[key] === b[key]);
}
function saveConfigOnce(path, expected) {
  if (existsSync(path)) {
    let actual;
    try { actual = JSON.parse(privateFile(path, 8_192)); } catch (e) {
      if (e instanceof NotionSetupError) throw e;
      fail('NOTION_SETUP_EXISTING_CONFIG_CONFLICT');
    }
    if (!sameJson(actual, expected)) fail('NOTION_SETUP_EXISTING_CONFIG_CONFLICT');
  } else writeNew(path, JSON.stringify(expected, null, 2) + '\n');
}
function acquireLock(base) {
  const path = join(base, 'notion-setup.lock');
  const lockId = randomUUID();
  const contents = JSON.stringify({ pid: process.pid, host: hostname(), lock_id: lockId });
  try { writeNew(path, contents); }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    // Serialize stale-lock recovery too: two resumed callers must not remove each other's lock.
    const recovery = join(base, 'notion-setup-recovery.lock');
    try { writeNew(recovery, contents); }
    catch { fail('NOTION_SETUP_BUSY'); }
    try {
      let previous;
      try { previous = JSON.parse(privateFile(path, 1_024)); } catch { fail('NOTION_SETUP_BUSY'); }
      if (previous.host !== hostname() || !Number.isSafeInteger(previous.pid) || previous.pid < 1) fail('NOTION_SETUP_BUSY');
      try { process.kill(previous.pid, 0); fail('NOTION_SETUP_BUSY'); }
      catch (error) { if (error.code !== 'ESRCH') fail('NOTION_SETUP_BUSY'); }
      unlinkSync(path);
      try { writeNew(path, contents); } catch { fail('NOTION_SETUP_BUSY'); }
    } finally { unlinkSync(recovery); }
  }
  return () => {
    if (existsSync(path) && JSON.parse(privateFile(path, 1_024)).lock_id === lockId) unlinkSync(path);
  };
}

function apiClient(token, fetchImpl) {
  let last = 0;
  return async (method, path, body) => {
    const wait = Math.max(0, last + 350 - Date.now());
    if (wait) await delay(wait);
    last = Date.now();
    const write = method === 'POST';
    try {
      const response = await fetchImpl(API + path, { method, redirect: 'error', signal: AbortSignal.timeout(20_000),
        headers: { Authorization: `Bearer ${token}`, 'Notion-Version': VERSION, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (response.redirected || response.status >= 300 && response.status < 400) {
        throw new NotionSetupError('NOTION_REQUEST_REJECTED', { ambiguous: write });
      }
      if (!response.ok) {
        try { await response.body?.cancel(); } catch { /* Retain only the HTTP status. */ }
        const rejected = [400, 401, 403, 404, 422, 429].includes(response.status);
        const code = response.status === 401 ? 'NOTION_UNAUTHORIZED' : response.status === 403 ? 'NOTION_FORBIDDEN'
          : response.status === 404 ? 'NOTION_NOT_FOUND' : response.status === 429 ? 'NOTION_RATE_LIMITED'
            : 'NOTION_REQUEST_REJECTED';
        throw new NotionSetupError(code, { ambiguous: write && !rejected });
      }
      const reader = response.body?.getReader();
      if (!reader) throw new NotionSetupError('NOTION_RESPONSE_INVALID', { ambiguous: write });
      const chunks = []; let size = 0;
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > MAX_BYTES) { await reader.cancel(); throw new NotionSetupError('NOTION_RESPONSE_TOO_LARGE', { ambiguous: write }); }
        chunks.push(Buffer.from(part.value));
      }
      try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw new NotionSetupError('NOTION_RESPONSE_INVALID', { ambiguous: write }); }
    } catch (error) {
      if (error instanceof NotionSetupError) throw error;
      throw new NotionSetupError('NOTION_NETWORK_ERROR', { ambiguous: write });
    }
  };
}

async function children(request, pageId) {
  const rows = [], cursors = new Set(); let cursor;
  for (let page = 0; page < 100; page++) {
    const value = await request('GET', `/blocks/${pageId}/children?page_size=100${cursor ? '&start_cursor=' + encodeURIComponent(cursor) : ''}`);
    if (!record(value) || !Array.isArray(value.results) || typeof value.has_more !== 'boolean') fail('NOTION_RESPONSE_INVALID');
    rows.push(...value.results);
    if (!value.has_more) return rows;
    if (typeof value.next_cursor !== 'string' || !value.next_cursor || cursors.has(value.next_cursor)) fail('NOTION_RESPONSE_INVALID');
    cursor = value.next_cursor; cursors.add(cursor);
  }
  fail('NOTION_SETUP_PARENT_TOO_LARGE');
}
function marker(state, kind) { return `QBStudyFriend setup ${state.setup_id} ${kind}`; }
function checkDatabase(value, state, kind) {
  if (!record(value) || value.object !== 'database' || !UUID.test(value.id ?? '')
    || value.parent?.type !== 'page_id' || value.parent.page_id?.toLowerCase() !== state.parent_page_id
    || value.archived === true || value.in_trash === true || text(value.title) !== TITLES[kind]
    || text(value.description) !== marker(state, kind)
    || !Array.isArray(value.data_sources) || value.data_sources.length !== 1
    || !UUID.test(value.data_sources[0]?.id ?? '')) fail('NOTION_SETUP_DATABASE_MISMATCH');
  return { database_id: uuid(value.id), data_source_id: uuid(value.data_sources[0].id) };
}
async function ensureDatabase({ base, state, kind, properties, request }) {
  let step = state[kind];
  if (step?.database_id) {
    const verified = checkDatabase(await request('GET', `/databases/${step.database_id}`), state, kind);
    if (step.data_source_id && step.data_source_id !== verified.data_source_id) fail('NOTION_SETUP_DATABASE_MISMATCH');
    state[kind] = { status: 'created', ...verified }; writeState(base, state); return verified;
  }
  if (step?.status === 'intent') {
    // A previous POST might have committed. Reconcile only this setup's marked database.
    const found = [];
    for (const block of await children(request, state.parent_page_id)) {
      if (block?.type !== 'child_database' || block.child_database?.title !== TITLES[kind] || !UUID.test(block.id ?? '')) continue;
      const candidate = await request('GET', `/databases/${uuid(block.id)}`);
      if (text(candidate?.description) === marker(state, kind)) found.push(checkDatabase(candidate, state, kind));
    }
    if (found.length !== 1) fail('NOTION_SETUP_OUTCOME_UNKNOWN');
    state[kind] = { status: 'created', ...found[0] }; writeState(base, state); return found[0];
  }
  state[kind] = { status: 'intent' }; writeState(base, state);
  let created;
  try {
    created = await request('POST', '/databases', { parent: { type: 'page_id', page_id: state.parent_page_id },
      title: rt(TITLES[kind]), description: rt(marker(state, kind)), is_inline: true,
      initial_data_source: { properties } });
  } catch (error) {
    if (error instanceof NotionSetupError && !error.ambiguous) {
      state[kind] = { status: 'rejected' }; writeState(base, state);
    }
    throw error;
  }
  // Save a returned ID before additional reads, so an interrupted validation is resumable.
  if (record(created) && UUID.test(created.id ?? '')) {
    state[kind] = { status: 'intent', database_id: uuid(created.id) }; writeState(base, state);
  }
  const verified = checkDatabase(created, state, kind);
  state[kind] = { status: 'created', ...verified }; writeState(base, state);
  return verified;
}

/**
 * Called only by the local, same-origin/CSRF-protected setup route. The Windows installer
 * must restrict the root ACL to the owner, SYSTEM and Administrators before this call.
 * No credential, API body, raw exception, or existing study record is returned/logged.
 */
export async function configureNotion({ base, parentPage, token, maxQuestions, fetchImpl = fetch }) {
  let unlock, result, failure;
  try {
    if (typeof base !== 'string' || !isAbsolute(base) || base.includes('\0') || base.length > 4_096) fail('NOTION_SETUP_BASE_INVALID');
    const parentId = parseParentPage(parentPage);
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{20,512}$/u.test(token)) fail('NOTION_TOKEN_INVALID');
    if (maxQuestions !== undefined && (!Number.isSafeInteger(maxQuestions) || maxQuestions < 1 || maxQuestions > 100)) fail('NOTION_SETUP_OPTIONS_INVALID');
    if (typeof fetchImpl !== 'function') fail('NOTION_SETUP_OPTIONS_INVALID');
    mkdirSync(base, { recursive: true, mode: 0o700 });
    const dir = lstatSync(base);
    if (!dir.isDirectory() || dir.isSymbolicLink() || process.platform !== 'win32' && (dir.mode & 0o077) !== 0) fail('NOTION_SETUP_FILE_UNSAFE');
    unlock = acquireLock(base);
    const stateFile = join(base, 'notion-setup-state.json');
    const tokenFile = join(base, 'notion-token');
    const configFile = join(base, 'notion-sync.json');
    const reviewFile = join(base, 'review-config.json');
    let state = existsSync(stateFile) ? readState(stateFile) : undefined;
    // An existing setup owns its saved limit. A release update never rewrites it.
    maxQuestions = maxQuestions ?? state?.max_questions ?? 100;
    if (!state && [tokenFile, configFile, reviewFile].some(existsSync)) fail('NOTION_SETUP_EXISTS');
    if (state && (state.parent_page_id !== parentId || state.publisher_host !== hostname() || state.max_questions !== maxQuestions)) fail('NOTION_SETUP_OPTIONS_CONFLICT');
    if (existsSync(tokenFile) && !tokenEqual(privateFile(tokenFile, 4_096).trim(), token)) fail('NOTION_SETUP_EXISTING_TOKEN_CONFLICT');
    const alreadyConfigured = state?.complete === true;
    // Import before creating remote resources: a missing/incompatible core must fail safely.
    const { NotionClient } = await import('./core.mjs');
    if (typeof NotionClient !== 'function') fail('NOTION_SETUP_CORE_UNAVAILABLE');
    const request = apiClient(token, fetchImpl);
    const parent = await request('GET', `/pages/${parentId}`);
    if (!record(parent) || parent.object !== 'page' || parent.id?.toLowerCase() !== parentId
      || parent.archived !== false || parent.in_trash !== false) fail('NOTION_SETUP_PARENT_INVALID');
    if (!state) {
      if ((await children(request, parentId)).length !== 0) fail('NOTION_SETUP_PARENT_NOT_EMPTY');
      state = { schema_version: '1', setup_id: randomUUID(), parent_page_id: parentId,
        publisher_host: hostname(), max_questions: maxQuestions, complete: false };
      writeState(base, state);
    }
    const questions = await ensureDatabase({ base, state, kind: 'questions', properties: questionProperties(), request });
    const attempts = await ensureDatabase({ base, state, kind: 'attempts', properties: attemptProperties(questions.data_source_id), request });
    const client = new NotionClient({ token, questionsDataSourceId: questions.data_source_id,
      attemptsDataSourceId: attempts.data_source_id, fetch: fetchImpl });
    await client.validateSchema();
    // Existing collector validation permits optional context; setup explicitly requires it.
    const schema = await request('GET', `/data_sources/${attempts.data_source_id}`);
    const props = schema?.properties;
    if (schema?.object !== 'data_source' || schema.id?.toLowerCase() !== attempts.data_source_id
      || props?.['学習目的データV1']?.type !== 'rich_text'
      || !['通常学習', '復習', '未分類'].every(name => props?.['学習種別']?.select?.options?.some(option => option.name === name))) fail('NOTION_STUDY_CONTEXT_SCHEMA_REQUIRED');
    // Existing data sources are inspected only; never replace their select options here.
    if (!['Chrome拡張', 'Safari拡張'].every(name => props?.['記録元']?.select?.options?.some(option => option.name === name))) fail('NOTION_SAFARI_SCHEMA_REQUIRED');
    const sync = { schema_version: '1', enabled: true, attempts_data_source_id: attempts.data_source_id,
      questions_data_source_id: questions.data_source_id, token_file: tokenFile };
    const review = { schema_version: '1', publisher_host: hostname(), notion_parent_page_id: parentId,
      max_questions: maxQuestions, request_retention: 0.9, per_question_daily_cap: 2, settings_version: 'daily-review-settings-v1' };
    // Complete the configuration last. Partial local writes are checked on the next attempt.
    if (!existsSync(tokenFile)) writeNew(tokenFile, token);
    saveConfigOnce(reviewFile, review);
    saveConfigOnce(configFile, sync);
    syncDirectory(base);
    state.complete = true; writeState(base, state);
    result = { status: alreadyConfigured ? 'already_configured' : 'configured', parentPageId: parentId,
      questionsDatabaseId: questions.database_id, questionsDataSourceId: questions.data_source_id,
      attemptsDatabaseId: attempts.database_id, attemptsDataSourceId: attempts.data_source_id,
      maxQuestions, notionUrl: `https://www.notion.so/${parentId.replaceAll('-', '')}` };
  } catch (error) {
    failure = error instanceof NotionSetupError ? error
      : new NotionSetupError(typeof error?.code === 'string' && CODE.test(error.code) ? error.code : 'NOTION_SETUP_FAILED');
  }
  if (unlock) {
    try { unlock(); } catch {
      // Keep the original failure if setup itself failed; cleanup must not hide it.
      failure ??= new NotionSetupError('NOTION_SETUP_LOCK_FAILED');
    }
  }
  if (failure) throw failure;
  return result;
}
