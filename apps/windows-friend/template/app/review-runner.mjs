import { lstatSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { remainingSetItems } from './core.mjs';

const actions = new Set(['status', 'prepare', 'begin', 'remaining', 'register']);
const fail = code => { throw new Error(code); };
function jsonFile(file, maximum) {
  const info = lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maximum) fail('REVIEW_INPUT_INVALID');
  return JSON.parse(readFileSync(file, 'utf8'));
}
const dayOK = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const only = (value, keys) => plain(value) && Object.keys(value).every(key => keys.includes(key));

/** Uses only the running local dashboard; never reads or prints the Notion credential. */
export async function runReviewAction({ root, action, day, inputFile, fetchImpl = fetch }) {
  if (!actions.has(action)) fail('REVIEW_ACTION_INVALID');
  const session = jsonFile(join(root, 'data/session.json'), 1024);
  if (session.product !== 'QBStudyFriend' || session.port !== 8766
    || !Number.isSafeInteger(session.pid) || session.pid < 1 || !/^[a-f0-9]{64}$/.test(session.key ?? '')) fail('QB_SESSION_INVALID');
  const origin = 'http://127.0.0.1:8766';
  const request = async (path, body) => {
    const response = await fetchImpl(origin + path, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(185000),
      headers: { 'X-QB-Local-Key': session.key, Origin: origin,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    if (text.length > 2097152) fail('REVIEW_RESPONSE_INVALID');
    let value;
    try { value = JSON.parse(text); } catch { fail('REVIEW_RESPONSE_INVALID'); }
    if (!response.ok) fail(/^[A-Z_]{3,100}$/.test(value?.code ?? '') ? value.code : 'REVIEW_REQUEST_FAILED');
    return value;
  };
  const ping = await request('/api/ping');
  if (ping.product !== 'QBStudyFriend' || ping.version !== '1.1.0-preview') fail('QB_VERSION_MISMATCH');
  if (action === 'status') return request('/api/status');
  if (action === 'prepare') {
    if (!dayOK(day)) fail('REVIEW_DAY_REQUIRED');
    const current = await request('/api/status');
    if (current.review?.day !== day) fail('REVIEW_DAY_CHANGED');
    return request('/api/prepare', { day });
  }
  if (action === 'begin') {
    if (!dayOK(day)) fail('REVIEW_DAY_REQUIRED');
    return request('/api/begin', { day });
  }
  if (typeof inputFile !== 'string' || !isAbsolute(inputFile)) fail('REVIEW_INPUT_REQUIRED');
  const observed = jsonFile(inputFile, 16384);
  if (action === 'remaining') {
    if (!only(observed, ['day', 'ids']) || !dayOK(observed.day)
      || !Array.isArray(observed.ids) || observed.ids.length > 100
      || !observed.ids.every(id => typeof id === 'string')) fail('REVIEW_INPUT_INVALID');
    const current = await request('/api/status');
    if (current.review?.day !== observed.day) fail('REVIEW_DAY_CHANGED');
    if (!current.review?.prepared) fail('REVIEW_PLAN_MISSING');
    return { day: observed.day, remaining: remainingSetItems(current.review.manifest, observed.ids) };
  }
  if (!only(observed, ['day', 'url', 'ids', 'confirmed']) || !dayOK(observed.day)
    || observed.confirmed !== true || typeof observed.url !== 'string' || typeof observed.ids !== 'string') fail('REVIEW_INPUT_INVALID');
  return request('/api/register', observed);
}

async function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  if (process.platform !== 'win32' || !process.env.LOCALAPPDATA
    || root.toLowerCase() !== resolve(process.env.LOCALAPPDATA, 'QBStudyFriend').toLowerCase()) fail('QB_WINDOWS_INSTALL_REQUIRED');
  const [action, value] = process.argv.slice(2);
  if (process.argv.length > 4) fail('REVIEW_ARGUMENTS_INVALID');
  const output = await runReviewAction({ root, action,
    ...(action === 'prepare' || action === 'begin' ? { day: value } : { inputFile: value }) });
  process.stdout.write(JSON.stringify(output) + '\n');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    const code = /^[A-Z_]{3,100}$/.test(error?.message ?? '') ? error.message : 'REVIEW_UNAVAILABLE';
    process.stderr.write(JSON.stringify({ event_code: code }) + '\n');
    process.exitCode = 1;
  });
}
