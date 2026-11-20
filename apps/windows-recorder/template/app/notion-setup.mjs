import { closeSync, fsyncSync, fstatSync, lstatSync, openSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { NotionClient } from './core.mjs';

const API = 'https://api.notion.com/v1';
const VERSION = '2025-09-03';
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;
const MAX_BYTES = 1_048_576;
const READ_ERRORS = new Set(['NOTION_UNAUTHORIZED', 'NOTION_FORBIDDEN', 'NOTION_NOT_FOUND',
  'NOTION_RATE_LIMITED', 'NOTION_REQUEST_REJECTED', 'NOTION_RESPONSE_INVALID',
  'NOTION_RESPONSE_TOO_LARGE', 'NOTION_NETWORK_ERROR', 'NOTION_SCHEMA_MISMATCH',
  'NOTION_SERVICE_UNAVAILABLE', 'NOTION_STUDY_CONTEXT_SCHEMA_REQUIRED']);

export class NotionSetupError extends Error {
  constructor(code) { super(code); this.name = 'NotionSetupError'; this.code = code; }
}
const fail = code => { throw new NotionSetupError(code); };
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function uuid(value) {
  if (typeof value !== 'string' || !UUID.test(value)) fail('NOTION_SETUP_ID_INVALID');
  return value.toLowerCase();
}
function exists(path) {
  try { lstatSync(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
function privateDirectory(base) {
  if (typeof base !== 'string' || !isAbsolute(base) || base.includes('\0')) fail('NOTION_SETUP_FILE_UNSAFE');
  const info = lstatSync(base);
  if (!info.isDirectory() || info.isSymbolicLink() || process.platform !== 'win32'
    && ((info.mode & 0o077) !== 0 || process.getuid && info.uid !== process.getuid())) fail('NOTION_SETUP_FILE_UNSAFE');
}
function writeNew(path, content, created) {
  const fd = openSync(path, 'wx', 0o600);
  try {
    const info = fstatSync(fd);
    created.push({ path, dev: info.dev, ino: info.ino });
    writeFileSync(fd, content, 'utf8');
    fsyncSync(fd);
  } finally { closeSync(fd); }
}
function rollbackCreated(created) {
  for (const entry of [...created].reverse()) {
    try {
      const info = lstatSync(entry.path);
      if (info.isFile() && !info.isSymbolicLink() && info.dev === entry.dev && info.ino === entry.ino) unlinkSync(entry.path);
    } catch { /* A partial configuration remains blocked; never remove another file. */ }
  }
}
async function readJSON(path, token, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(API + path, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(20_000),
      headers: { Authorization: `Bearer ${token}`, 'Notion-Version': VERSION } });
    if (response.redirected || response.status >= 300 && response.status < 400) fail('NOTION_REQUEST_REJECTED');
    if (!response.ok) {
      await response.body?.cancel();
      fail(({ 401: 'NOTION_UNAUTHORIZED', 403: 'NOTION_FORBIDDEN', 404: 'NOTION_NOT_FOUND',
        429: 'NOTION_RATE_LIMITED' })[response.status] ?? 'NOTION_REQUEST_REJECTED');
    }
    const reader = response.body?.getReader();
    if (!reader) fail('NOTION_RESPONSE_INVALID');
    const chunks = []; let size = 0;
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_BYTES) { await reader.cancel(); fail('NOTION_RESPONSE_TOO_LARGE'); }
      chunks.push(Buffer.from(part.value));
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { fail('NOTION_RESPONSE_INVALID'); }
  } catch (error) {
    if (error instanceof NotionSetupError) throw error;
    fail('NOTION_NETWORK_ERROR');
  }
}

/** Connects existing destinations only. The setup transport rejects every non-GET request. */
export async function configureNotion({ base, token, attemptsDataSourceId, questionsDataSourceId,
  reviewParentPageId, fetchImpl = fetch }) {
  const created = [];
  try {
    privateDirectory(base);
    const tokenFile = join(base, 'notion-token');
    const configFile = join(base, 'notion-sync.json');
    const reviewFile = join(base, 'review-config.json');
    if ([tokenFile, configFile, reviewFile].some(exists)) fail('NOTION_SETUP_EXISTS');
    const attempts = uuid(attemptsDataSourceId), questions = uuid(questionsDataSourceId), parent = uuid(reviewParentPageId);
    if (attempts === questions) fail('NOTION_SETUP_ID_INVALID');
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{20,512}$/u.test(token)) fail('NOTION_SETUP_TOKEN_INVALID');
    const readOnlyFetch = (url, options = {}) => {
      if ((options.method ?? 'GET') !== 'GET' || typeof url !== 'string'
        || !url.startsWith(API + '/') || options.body !== undefined) fail('NOTION_SETUP_READ_ONLY');
      return fetchImpl(url, options);
    };
    const client = new NotionClient({ token, attemptsDataSourceId: attempts,
      questionsDataSourceId: questions, fetch: readOnlyFetch });
    await client.validateSchema();
    const schema = await readJSON(`/data_sources/${attempts}`, token, readOnlyFetch);
    const props = schema?.properties;
    if (!record(schema) || schema.object !== 'data_source' || schema.id?.toLowerCase() !== attempts
      || props?.['学習目的データV1']?.type !== 'rich_text'
      || props?.['学習種別']?.type !== 'select'
      || !['通常学習', '復習', '未分類'].every(name => props['学習種別'].select?.options?.some(option => option.name === name))) {
      fail('NOTION_STUDY_CONTEXT_SCHEMA_REQUIRED');
    }
    const page = await readJSON(`/pages/${parent}`, token, readOnlyFetch);
    if (!record(page) || page.object !== 'page' || page.id?.toLowerCase() !== parent
      || page.archived !== false || page.in_trash !== false) fail('NOTION_SETUP_PARENT_INVALID');
    // Read access to the plan children is needed by the recording classifier; no publisher settings are installed.
    const children = await readJSON(`/blocks/${parent}/children?page_size=1`, token, readOnlyFetch);
    if (!record(children) || children.object !== 'list' || !Array.isArray(children.results)
      || typeof children.has_more !== 'boolean') fail('NOTION_RESPONSE_INVALID');
    // Recheck after remote validation, then publish the enabled configuration last.
    if ([tokenFile, configFile, reviewFile].some(exists)) fail('NOTION_SETUP_EXISTS');
    writeNew(tokenFile, token, created);
    writeNew(reviewFile, JSON.stringify({ schema_version: '1', notion_parent_page_id: parent }, null, 2) + '\n', created);
    writeNew(configFile, JSON.stringify({ schema_version: '1', enabled: true,
      attempts_data_source_id: attempts, questions_data_source_id: questions, token_file: tokenFile }, null, 2) + '\n', created);
    if (process.platform !== 'win32') {
      const fd = openSync(base, 'r');
      try { fsyncSync(fd); } finally { closeSync(fd); }
    }
    return { status: 'configured', attemptsDataSourceId: attempts, questionsDataSourceId: questions, reviewParentPageId: parent };
  } catch (error) {
    rollbackCreated(created);
    if (error instanceof NotionSetupError) throw error;
    const code = error?.code ?? error?.message;
    if (code === 'EEXIST') fail('NOTION_SETUP_EXISTS');
    fail(READ_ERRORS.has(code) ? code : 'NOTION_SETUP_FAILED');
  }
}
