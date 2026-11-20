# Security and privacy

## 保存禁止データ

次のデータはソース、SQLite、JSON、fixture、snapshot、ログ、エラー、スクリーンショットへ保存しません。

- QBの問題文
- 選択肢本文
- 解説
- 問題画像その他のQBコンテンツ
- password、token、cookie、session、OTPその他の認証情報
- ページ全体のHTML
- 不要なURL parameter、query、fragment
- 実サイトから導出した正答選択肢indexの永続化fieldまたはlist

問題を識別するために保存できるのは、正規化済みquestion key、選択済み選択肢の明示的な1始まりindex、正誤、検出時刻、および契約で定めた固定の由来・品質fieldだけです。

production adapterは正答markerから正答indexを一時的に導出し、選択済みindexの集合との比較にだけ使います。正答indexはadapterの戻り値、content/background message、`AttemptEventV1`、outbox、診断ログへ渡しません。content-freeの合成fixtureはmarker配置を再現できますが、実サイト由来の正答や正答index fieldを保存しません。問題文、選択肢本文、解説、画像のtext・HTML・URLを読み取るselectorや処理を設けません。

永続化する由来・group・algorithm識別子は、長さ制限付きのsafe tokenとして検証します。空白、改行、日本語その他の自由文を拒否し、識別子fieldを問題文や解説の迂回保存先にできないようにします。`set_name` は利用者向け表示名として自由文を許しますが、保存禁止データの規則は同様に適用されます。

## document単位の同意境界

Chromeはcontent scriptを `https://qb.medilink-study.com:443/quiz` とquery付きURL用の `https://qb.medilink-study.com:443/quiz?*` へ静的に配置しますが、同意前のbootstrapはcapture処理を完全に不活性に保ちます。同意前にはQB DOMのquery、capture用`MutationObserver`の作成、candidate生成、outbox参照、collector送信を行いません。bootstrapが行えるのは、安全なpage-session IDの生成、同意command listenerの登録、および対象documentが同意確認可能であることの通知だけです。workerが一時的に応答できない場合は同じpage-session IDのREADYだけを再通知し、document identityによるworker側の重複排除を維持します。

service workerはREADY senderについて、tab/window ID、active state、top frame、`documentId`またはpage-session ID、exact origin `https://qb.medilink-study.com`、exact pathname `/quiz`、credentialなしURLを検証します。content scriptからのmessageは侵害されたpage由来の可能性があるuntrusted inputとして、message shapeと同意状態を再検証します。

対象documentごとに1回だけ `chrome.action.openPopup()` で同意popupを提示します。background tabではactiveになるまで提示せず、popup APIを呼ぶ直前にもtarget tabがactiveであることを再確認します。`openPopup` APIが存在しないか呼出しがrejectされた場合は、そのtabだけに `!` badgeと `QB記録: 記録開始の確認が必要` titleを表示し、captureは開始しません。

- 「記録を開始」を選んだ後、同じactive documentへのstart commandが成功して初めてcapture messageを受理します。
- popupを閉じただけでは同意・拒否のどちらにもせず、完全な無操作としてcaptureを開始しません。
- 「今回は記録しない」はそのdocumentの自動提示を抑止し、captureを開始しません。同じdocumentでも利用者がpopupを手動で開けば後から開始できます。
- `loading`と`complete`はexact documentの照合契機にだけ使用し、通知自体から同意を付与または取消しません。同じ `/quiz` documentがprobeに応答する間は同意、capture、自動popup済み状態を保持します。verified new document、対象外location、到達不能documentではfail closedで破棄し、tab closeとtab replacementでは無条件に破棄します。
- 同意状態は `storage.session`、outboxと配信状態は `storage.local` に分離し、どちらも `TRUSTED_CONTEXTS` へ限定します。

## 外部システムと権限境界

- production adapterは観察済みの公開画面DOMだけを読み取ります。QBの非公開API、通信、内部実装を解析・推測・リバースエンジニアリングしません。
- QB上のbutton、選択肢、解答確定、rating、note、bookmark、問題set、navigationを一切操作しません。
- manifestのAPI permissionはoutbox/retryと同意状態に必要な `alarms` と `storage` だけです。`tabs`、`webNavigation`、`activeTab`、`scripting`、cookie、webRequest権限を要求しません。
- QB domainは `host_permissions` へ追加しません。page accessはstatic `content_scripts.matches`のexact scheme/host/default portと狭いquiz pathに限定し、runtimeでもexact origin/pathを検証します。
- `host_permissions` はcollector送信用の `http://127.0.0.1/*` だけです。collector endpointはportだけを設定可能とし、pathは `/v1/attempt-events` に固定します。
- collector requestはcredential、cookie、authorization header、redirect、query、fragmentを使用しません。
- Google Sheetsへ直接アクセスしません。

`chrome.action.openPopup()`を一般配布のextensionで使用できるChrome 127を最小versionとします。APIが存在しない、rejectされる、またはworkerのcapture core準備後にcontent scriptへのstart指示が失敗する場合はbadge/titleで手動確認を促し、captureを自動開始しません。一時的なtab更新通知だけではsessionを破棄せず、exact documentへのprobeが失敗した場合だけstaleまたは到達不能としてephemeral sessionを破棄し、badge/titleを消します。storageまたはcapture coreの準備失敗時も同意を推定せず、popup内のbounded error codeだけを表示してcaptureを開始しません。

## DOM解析のfail-closed境界

selectorとclass tokenはproduction adapterのDOM contractへ集約します。exact location、main、question key、question cardは各1件、cardを含むreview済みroot祖先は観察済みどおりexact 2件を要求し、近い方だけをfunctional quiz rootとします。root祖先が0件または2件以外ならUnsupportedとし、内側rootのclass drift時に外側wrapperへfallbackしません。question card内のoptionが5件でない場合もUnsupportedです。functional root内のresult markerが0件ならpendingとし、外側wrapperだけにあるmarkerからresolved状態を生成しません。resolved時のselected marker pair不整合はUnsupportedとしてeventを生成しません。question card内の全 `bg-qb-sky` は、tagとclass token集合が完全一致するcorrect badge、または各optionの観察済みexact path上にexact 1件あるprogress fillへ完全分類し、未分類、欠落、重複、path driftをUnsupportedにします。選択済みoptionが1件以上の場合だけcorrect badgeの配置・重複・範囲を検証し、不整合をUnsupportedにします。選択済みoptionが0件でresult markerと1件以上のexact correct badgeがある場合は、正答index集合を導出せず `resolved_without_selection` にします。progress fillだけではcorrect badgeの存在証拠にしません。

capture開始時にすでにresolvedな画面は新規解答の証拠にしません。同意後にpendingを観測し、同じquestion keyがresolvedへ遷移した場合だけcandidate生成対象にします。resolvedでも選択済みoptionが0件なら `resolved_without_selection` としてその問題をterminal扱いにし、`incorrect`や`unknown`へ変換せず履歴化しません。別のsupported question keyへ移れば同じdocumentのobserverで次のcycleを続け、問題数の上限は設けません。

## ログ方針

`system_logs` とextension診断はallowlist化した構造化fieldだけを持ちます。

- severity
- component
- event code
- timestamp
- 任意のrun ID、correlation ID、record ID、question key
- 数値カウンタ

自由形式payload、request/response dump、DOM text、URL、query、stack全体を永続化しません。error messageを直接保存せず、安定したallowlist済みerror codeを使用します。DOM不一致の診断も `capture_unsupported_dom:<reason>` の有限集合だけで、DOM text、HTML、URL、自由形式detailを含めません。badge/titleと同意状態にはquestion key、選択indexその他のattempt情報を表示・保存しません。

extension popupの「直近の記録」は、extension pageだけが利用できるbackground routeを通して、既存outboxと送信済みcacheから最大99件を表示します。表示fieldはquestion key、answered-at、result、選択済みindex、delivery stateだけです。popupから`chrome.storage`へ直接アクセスせず、event ID、provenance、正答index、URL、DOM/問題内容を返しません。99件は表示上限だけで、captureや保存の問題数上限ではありません。storage read失敗時は空履歴と断定せず、読み取り不能と表示します。最新の一般診断とは別に、直近のallowlist済みcapture failure codeを保持して表示し、後続の `capture_observing` で原因が見えなくなることを防ぎます。

## ローカルデータ

- 本番DBはiCloud配下のrepoに置かず、既定で `~/Library/Application Support/qb-study-system/` に置きます。
- `.env`、SQLite本体、WAL/SHM、ログ、build artifactをGit対象外にします。
- `.env.example` は安全な非秘密設定だけを示します。credential用変数を例示しません。
- SQLite adapterはPOSIX環境で作成directoryを `0700`、DB fileを `0600` にします。非POSIX環境、既存の親directory、backup、端末暗号化の運用は実運用開始前の未解決事項です。
- loopback collector profileには認証がなく、同じ端末でportを確保した別processによる受信・ack偽装を防げません。accepted collector contractとendpoint ownershipが確立するまで外部配布向けのproduction接続とは扱いません。

local history collectorは [ADR-0013](ADR/0013-local-loopback-history-collector.md)
に従い、IPv4 `127.0.0.1`へだけbindします。hostとpathは設定できず、portと
absolute database pathだけを設定できます。exact `POST /v1/attempt-events`、
uncompressed `application/json`、64 KiB以下のbodyだけを受け、Host、method、
path、content type/encoding、authorization、proxy authorization、cookieを
fail closedで検証します。CORS許可は返しません。

HTTP層とstorage層の両方で`AttemptEventV1`を検証し、SQLite transactionの
commitまたは同一payloadのduplicate確認後だけ同じevent IDのexact ACKを返し
ます。4xx/5xx error bodyはallowlist済みcodeだけで、request、header、DB path、
exception message、stackをechoしません。これは認証なしのlocal-only profileで
あり、別processによるport先取りや偽装を解決するものではありません。

## 失敗時の原則

- 同意、sender、DOM、schema、migration checksum、idempotencyのいずれかが不一致ならfail closedにします。
- 情報不足を `not_found` や推測値へ変換しません。
- collector成功をexact ackで確認するまでoutboxから削除しません。
- external writeの成否が不明な場合は成功扱いせず、`blocked` または明示的なunknownとして残します。
