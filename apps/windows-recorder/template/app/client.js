const TARGET_KEYS = ['attemptsDataSourceId', 'questionsDataSourceId', 'reviewParentPageId'];
export function parseConnectionTargets(text) {
  if (typeof text !== 'string' || new TextEncoder().encode(text).byteLength > 4096) throw new Error('QB_TARGET_FILE_INVALID');
  let value;
  try { value = JSON.parse(text); } catch { throw new Error('QB_TARGET_FILE_INVALID'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== TARGET_KEYS.join(',')
    || !TARGET_KEYS.every(key => typeof value[key] === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(value[key]))) {
    throw new Error('QB_TARGET_FILE_INVALID');
  }
  return Object.fromEntries(TARGET_KEYS.map(key => [key, value[key].toLowerCase()]));
}

function initialize() {
  const $ = id => document.getElementById(id);
  const fragment = location.hash.slice(1);
  const storageKey = 'qb-recorder-local-key';
  let key;
  try {
    if (/^[a-f0-9]{64}$/u.test(fragment)) { sessionStorage.setItem(storageKey, fragment); history.replaceState(null, '', '/'); }
    key = sessionStorage.getItem(storageKey);
  } catch { /* A blocked browser session is reported by the authenticated status request. */ }
  let busy = false, configured = false, configError;
  const messages = {
    QB_SESSION_REQUIRED: 'start.cmdから、このPCの記録画面を開き直してください。',
    QB_BUSY: '接続の確認中です。完了するまでお待ちください。',
    QB_STOPPING: '記録サービスを停止しています。終了後、start.cmdで起動してください。',
    QB_COLLECTOR_START_FAILED: '接続設定は保存しましたが、記録サービスを開始できません。stop.cmdで停止し、start.cmdで起動し直してください。',
    QB_COLLECTOR_START_TIMEOUT: '記録サービスの起動を確認できません。stop.cmdで停止し、start.cmdで起動し直してください。',
    QB_TARGET_FILE_INVALID: '保存先ファイルを読み込めません。3つの保存先IDだけを含む connection-targets.json を選んでください。',
    NOTION_SETUP_EXISTS: '保存済み、または途中まで保存された接続設定があります。既存ファイルを削除せず、導入を担当したチャットへ確認してください。',
    NOTION_SETUP_ID_INVALID: '3つのIDを確認してください。データソースIDはデータベースIDと異なります。',
    NOTION_SETUP_TOKEN_INVALID: 'Notionの接続キーを確認してください。',
    NOTION_SETUP_PARENT_INVALID: '復習計画の親ページIDと、そのページへの接続権限を確認してください。',
    NOTION_UNAUTHORIZED: 'Notionの接続キーを確認してください。',
    NOTION_FORBIDDEN: '指定したNotionの保存先と復習親ページに、接続を許可してください。',
    NOTION_NOT_FOUND: '保存先のIDと、Notion側の接続権限を確認してください。',
    NOTION_RATE_LIMITED: 'Notionの利用制限に達しました。しばらく待ってから接続してください。',
    NOTION_SCHEMA_MISMATCH: '保存先の構造が記録アプリと一致しません。保存先を変更せず、導入を担当したチャットへ確認してください。',
    NOTION_STUDY_CONTEXT_SCHEMA_REQUIRED: '学習区分を保存する列が確認できません。保存先を変更せず、導入を担当したチャットへ確認してください。',
    NOTION_NETWORK_ERROR: 'Notionへ接続できません。通信状態を確認してください。',
    QB_RECORDS_UNAVAILABLE: 'このPCの保存状態を読み取れません。保存ファイルを削除せず、起動をやり直してください。',
  };
  const notice = (text, error = false) => { $('notice').textContent = text; $('notice').classList.toggle('error', error); };
  const message = code => messages[code] ?? `処理を完了できませんでした。確認用コード：${/^[A-Z_]{3,100}$/u.test(code ?? '') ? code : 'QB_OPERATION_FAILED'}`;
  const controls = () => {
    $('setup').disabled = busy || configured || !!configError;
    $('refresh').disabled = busy;
    for (const id of ['attemptsId', 'questionsId', 'reviewParentId', 'token', 'target-file']) $(id).disabled = busy || configured || !!configError;
  };
  async function api(path, body) {
    const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'X-QB-Local-Key': key ?? '', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await response.json();
    if (!response.ok) throw new Error(value.code ?? 'QB_OPERATION_FAILED');
    return value;
  }
  function render(data) {
    configured = data.configured; configError = data.configError;
    $('setup-section').hidden = configured;
    $('connection-section').hidden = !data.connection;
    for (const [id, field] of [['connected-attempts', 'attemptsDataSourceId'], ['connected-questions', 'questionsDataSourceId'], ['connected-review', 'reviewParentPageId']]) {
      $(id).textContent = data.connection?.[field] ?? '';
    }
    $('collector').textContent = !configured ? '記録サービス：接続設定待ち'
      : data.collector.state === 'running' ? '記録サービス：起動中'
        : data.collector.state === 'starting' ? '記録サービス：起動しています'
          : '記録サービス：停止中。start.cmdから起動してください。';
    if (data.collector.code) $('collector').textContent += `（${data.collector.code}）`;
    for (const field of ['total', 'confirmed', 'pending', 'blocked']) $(field).textContent = data.records[field];
    $('localOnly').hidden = !data.records.localOnly;
    $('localOnly').textContent = `PCのみに保存された記録：${data.records.localOnly}件。自動送信の対象外です。記録を削除せず、導入を担当したチャットへ確認してください。`;
    const rows = data.records.recent.map(item => {
      const tr = document.createElement('tr');
      for (const value of [item.question, new Date(item.answeredAt).toLocaleString('ja-JP'),
        item.selected.map(number => String.fromCharCode(96 + number)).join(', '),
        { correct: '正解', incorrect: '不正解', unknown: '未判定' }[item.result],
        { normal: '通常学習', review: '復習課題', unclassified: '判定未確認' }[item.mode]]) {
        const td = document.createElement('td'); td.textContent = value; tr.append(td);
      }
      const td = document.createElement('td');
      if (item.notionUrl && /^https:\/\/www\.notion\.so\/[a-f0-9]{32}$/iu.test(item.notionUrl)) {
        const a = document.createElement('a'); a.href = item.notionUrl; a.textContent = '確認済み・開く'; a.target = '_blank'; a.rel = 'noopener noreferrer'; td.append(a);
      } else td.textContent = { local_only: 'PCのみ', pending: '送信待ち', creating: '保存確認待ち', retry: '再試行待ち', blocked: '保留・要確認' }[item.sync] ?? '未確認';
      tr.append(td); return tr;
    });
    if (!rows.length) {
      const tr = document.createElement('tr'), td = document.createElement('td'); td.colSpan = 6;
      td.textContent = configured ? 'まだ記録はありません。Chrome拡張を読み込み、QBの新しいタブで解答すると表示します。' : '既存Notionへの接続後、記録を開始します。';
      tr.append(td); rows.push(tr);
    }
    $('records').replaceChildren(...rows);
    if (configError) notice(message(configError), true);
    controls();
  }
  const refresh = async () => render(await api('/api/status'));
  async function action(run) {
    if (busy) return;
    busy = true; controls();
    try { const text = await run(); await refresh(); if (!configError) notice(text); }
    catch (error) { notice(message(error.message), true); try { await refresh(); } catch { /* Keep the original error. */ } }
    finally { busy = false; controls(); }
  }
  $('target-file').addEventListener('change', () => {
    void action(async () => {
      const file = $('target-file').files?.[0];
      try {
        if (!file || file.size > 4096) throw new Error('QB_TARGET_FILE_INVALID');
        const target = parseConnectionTargets(await file.text());
        $('attemptsId').value = target.attemptsDataSourceId;
        $('questionsId').value = target.questionsDataSourceId;
        $('reviewParentId').value = target.reviewParentPageId;
        return '保存先を入力しました。Notion接続キーを入力して接続してください。';
      } finally { $('target-file').value = ''; }
    });
  });
  $('refresh').addEventListener('click', () => { void action(async () => 'このPCの保存状態を更新しました。'); });
  $('setup').addEventListener('click', () => {
    void action(async () => {
      const token = $('token').value.trim(); $('token').value = '';
      notice('既存Notionの保存先を確認しています…');
      await api('/api/setup', { token, attemptsDataSourceId: $('attemptsId').value.trim(),
        questionsDataSourceId: $('questionsId').value.trim(), reviewParentPageId: $('reviewParentId').value.trim() });
      return '既存の保存先へ接続しました。Chrome拡張を読み込み、QBの新しいタブで記録を始められます。';
    });
  });
  void refresh().then(() => { if (!configError) notice(configured ? '接続済みです。学習前に記録サービスの起動を確認してください。' : '先に既存Notionへ接続してください。'); })
    .catch(() => notice('記録サービスに接続できません。start.cmdから開き直してください。', true));
  setInterval(() => { if (!busy) void refresh().catch(() => notice('記録サービスに接続できません。start.cmdから開き直してください。', true)); }, 15_000);
}
if (typeof document !== 'undefined') initialize();
