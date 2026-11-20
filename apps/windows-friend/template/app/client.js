'use strict';
const $ = id => document.getElementById(id);
const fragment = location.hash.slice(1);
if (/^[a-f0-9]{64}$/.test(fragment)) { sessionStorage.setItem('qb-local-key', fragment); history.replaceState(null, '', '/'); }
const key = sessionStorage.getItem('qb-local-key');
let busy = false, currentDay, currentReview, configured = false;
const messages = {
  QB_SESSION_REQUIRED: 'start.cmdをもう一度開いて、このPC用の操作画面を表示してください。',
  QB_BUSY: '別の処理が進行中です。完了してからもう一度操作してください。',
  QB_STOPPING: '記録サービスを停止しています。終了後、start.cmdで起動し直してください。',
  QB_COLLECTOR_START_FAILED: '記録サービスを開始できません。stop.cmdで停止した後、start.cmdで起動し直してください。',
  REVIEW_NOTION_REQUIRED: '先にNotionの保存先を設定してください。',
  REVIEW_PLAN_EMPTY: '今日の復習候補はありません。空のQBセットを作る必要はありません。',
  REVIEW_DAY_CHANGED: '復習の日付が変わりました。記録を更新して、今日の候補を確認してください。',
  REVIEW_QB_MEMBERSHIP_MISMATCH: '問題番号・件数・順序が候補と一致しません。QBのセットを確認して修正してください。',
  REVIEW_OBSERVED_ID_INVALID: '問題番号だけを入力してください。例：123A1。番号の間は改行・空白・カンマで区切ります。',
  REVIEW_QB_URL_INVALID: 'QBでセットを開いた検索画面のURLを入力してください。questionSetIdを含むURLが必要です。',
  REVIEW_CONFIRM_REQUIRED: 'QB上の全件数・問題番号・順序・URLを確認して、チェックを入れてください。',
  REVIEW_JOURNAL_CONFLICT: '既に保存したセット情報と一致しません。新しいセットを作らず、以前のセットを確認してください。',
  REVIEW_SET_ALREADY_USED: 'そのQBセットは別の日の復習に登録済みです。今日のセット名で作成した別のセットを使ってください。',
  REVIEW_PUBLISHER_LOCKED: '復習処理が実行中か、前回の中断記録があります。繰り返し作成せず、マニュアルの相談手順を確認してください。',
  NOTION_SETUP_OUTCOME_UNKNOWN: 'Notion側に作成された可能性があります。同じ作成を繰り返さず、Notionのページを確認してください。',
  NOTION_SETUP_PARENT_NOT_EMPTY: '専用ページに既存の内容があります。新しい空の専用ページを用意してください。',
  NOTION_SETUP_PARENT_INVALID: 'Notionの専用ページのURLを確認してください。',
  NOTION_SETUP_TOKEN_INVALID: 'Notionの内部接続トークンを確認してください。',
  NOTION_SAFARI_SCHEMA_REQUIRED: '既存のNotion保存先がiPhone記録に未対応です。新しい保存先を重複作成せず、配布者へこの確認用コードだけを伝えてください。',
  NOTION_SETUP_OPTIONS_CONFLICT: '以前の接続設定と今回の指定が一致しません。保存先や既存設定を削除せず、導入手順を確認してください。',
  NOTION_UNAUTHORIZED: 'Notionの接続キー、接続先ページのアクセス許可を確認してください。',
};
function notice(text, error = false) { $('notice').textContent = text; $('notice').classList.toggle('error', error); }
function enable() {
  for (const button of document.querySelectorAll('button')) button.disabled = busy;
  $('prepare').disabled = busy || !configured;
  $('begin').disabled = busy || !currentReview?.manifest?.question_ids.length || !!currentReview?.verified;
}
async function api(path, body) {
  const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', headers: { 'X-QB-Local-Key': key ?? '', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.code ?? 'QB_OPERATION_FAILED');
  return value;
}
function link(id, url) { const element = $(id); element.hidden = !url; if (url) element.href = url; }
function render(data) {
  configured = data.configured;
  $('setup-section').hidden = configured;
  const connection = data.connection;
  $('iphone-section').hidden = !connection;
  $('attemptsId').value = connection?.attemptsDataSourceId ?? '';
  $('questionsId').value = connection?.questionsDataSourceId ?? '';
  $('reviewParentId').value = connection?.reviewParentPageId ?? '';
  $('review-limit').textContent = connection ? `このPCに保存された候補上限：${connection.maxQuestions}問。既存設定は自動で書き換えません。` : '';

  $('collector').textContent = data.collector.state === 'running' ? '記録サービス：起動中' : '記録サービス：停止または起動失敗。学習前にstart.cmdで起動してください。';
  if (data.collector.code) $('collector').textContent += ' ／ 要確認：' + data.collector.code;
  for (const field of ['total', 'confirmed', 'pending', 'blocked']) $(field).textContent = data.records[field];
  $('localOnly').textContent = data.records.localOnly ? `Notion設定前など、PCのみに保存された記録：${data.records.localOnly}件。これらは自動転送の対象外です。` : '';
  const rows = data.records.recent.map(record => {
    const tr = document.createElement('tr');
    for (const value of [record.question, new Date(record.answeredAt).toLocaleString('ja-JP'), record.selected.map(n => n <= 26 ? String.fromCharCode(96+n) : n).join(', '),
      { correct: '正解', incorrect: '不正解', unknown: '未判定' }[record.result], { normal: '通常学習', review: '復習', unclassified: '未分類' }[record.mode]]) {
      const td = document.createElement('td'); td.textContent = value; tr.append(td);
    }
    const td = document.createElement('td');
    if (record.notionUrl) { const a = document.createElement('a'); a.href = record.notionUrl; a.textContent = '保存済み・開く'; a.target = '_blank'; a.rel = 'noopener noreferrer'; td.append(a); }
    else td.textContent = { local_only: 'PCのみ', pending: '同期待ち', creating: '同期中', retry: '再試行待ち', blocked: '要確認' }[record.sync] ?? '未確認';
    tr.append(td); return tr;
  });
  if (!rows.length) { const tr = document.createElement('tr'), td = document.createElement('td'); td.colSpan = 6; td.textContent = 'まだ解答記録はありません。Notionの設定後、QBを新しいタブで開いて1〜2問解いてください。'; tr.append(td); rows.push(tr); }
  $('records').replaceChildren(...rows);
  const review = data.review;
  if (currentReview?.manifest?.plan_id !== review.manifest?.plan_id || currentReview?.revision !== review.revision) {
    $('setUrl').value = ''; $('observedIds').value = ''; $('confirmedSet').checked = false;
  }
  currentDay = review.day; currentReview = review;
  $('review').hidden = !review.prepared; $('review-empty').hidden = review.prepared;
  if (review.prepared) {
    $('review-summary').textContent = `${review.day}の復習候補：${review.manifest.question_ids.length}問`;
    $('setName').value = review.manifest.name;
    $('plannedIds').value = review.manifest.question_ids.join('\n');
    link('review-notion', review.notionUrl);
    $('register-panel').hidden = !review.started || review.linked;
    $('resume').textContent = '作成を中断した場合は同じ名前のセットを探して再開してください。重複するセットを新しく作らないでください。';
    if (review.set && !$('setUrl').value) $('setUrl').value = review.set.url;
    $('set-result').textContent = review.linked ? '照合とNotionへのリンク保存を確認しました。下のセットから演習を開始してください。' : review.verified ? '問題の照合は済んでいます。Notionリンクの保存が未確認です。同じURLと番号で登録操作を再実行してください。' : '';
    link('verified-set', review.verified ? review.set?.url : undefined);
  }
  enable();
}
async function refresh() { const data = await api('/api/status'); render(data); return data; }
async function action(work) {
  if (busy) return; busy = true; enable(); notice('処理しています。完了するまでこの画面と記録用ウィンドウを開いたままにしてください。');
  try { const message = await work(); await refresh(); notice(message); }
  catch (error) { notice((messages[error.message] ?? '処理を完了できませんでした。マニュアルの困ったときの手順を確認してください。') + '\n確認用コード：' + error.message, true); }
  finally { busy = false; enable(); }
}
$('refresh').addEventListener('click', () => action(async () => { await refresh(); return 'このPCの記録と、そのNotion保存確認を更新しました。'; }));
$('setup').addEventListener('click', () => action(async () => {
  const token = $('token').value.trim(); $('token').value = '';
  await api('/api/setup', { parentPage: $('parentPage').value.trim(), token });
  return 'Notionの保存先を作成・確認しました。Chrome拡張を読み込み、QBを新しいタブで開いて1〜2問解いてください。';
}));
$('prepare').addEventListener('click', () => action(async () => { await api('/api/prepare', {}); return '復習候補を確認しました。同じ日の候補は固定です。'; }));
$('begin').addEventListener('click', () => action(async () => { const result = await api('/api/begin', { day: currentDay });
  return result.may_create ? '登録準備ができました。下の手順に沿ってQBの画面でセットを作成してください。' : '途中の登録を再開します。QBに同じ名前のセットがあれば、そのセットを使ってください。'; }));
$('register').addEventListener('click', () => action(async () => { await api('/api/register', { day: currentDay, url: $('setUrl').value, ids: $('observedIds').value, confirmed: $('confirmedSet').checked }); return '復習セットの照合とNotionへのリンク保存を確認しました。'; }));
refresh().then(() => notice('接続できました。学習前に記録サービスの起動とNotionの設定を確認してください。')).catch(error => notice(messages[error.message] ?? '接続できません。start.cmdから開き直してください。', true));
setInterval(() => { if (!busy) refresh().catch(() => notice('記録サービスに接続できません。start.cmdから開き直してください。', true)); }, 15_000);
