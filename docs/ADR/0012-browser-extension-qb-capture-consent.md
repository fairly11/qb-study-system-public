# ADR-0012: QB取得のdocument単位同意とfail-closed境界

- Status: Accepted
- Date: 2026-08-26

## Context

ADR-0010では、QB画面からの公開された取得手段、最小Chrome権限、および画面上の選択肢から1始まりindexへの対応規則を未解決としていました。その後、対象を `https://qb.medilink-study.com/quiz` の公開画面DOMに限定した観察により、問題文、選択肢本文、解説、画像、認証情報、非公開APIを扱わずに解答結果を判定できる最小DOM contractが得られました。

一方、static content scriptは対象documentへ自動配置されます。QB上で通常どおり解答する体験と、利用者がdocumentごとに記録開始を選べる境界を両立し、同意前のDOM取得を防ぐ必要があります。また、`AttemptEventV1`が要求する選択済みoption indexと、正誤比較のためだけに必要な正答option indexを分離しなければなりません。

## Decision

### 配置対象と最小権限

- Manifest V3のstatic content scriptを `https://qb.medilink-study.com:443/quiz` とquery付きURL用の `https://qb.medilink-study.com:443/quiz?*`、`document_start`、top frame、isolated worldに限定します。
- content scriptとservice workerの双方でexact origin `https://qb.medilink-study.com`、exact pathname `/quiz`、top frameを検証します。queryとfragmentは判定にも記録にも使いません。
- API permissionは `alarms` と `storage` だけとします。`tabs`、`webNavigation`、`activeTab`、`scripting`、cookie、webRequest権限を要求しません。
- QB hostを `host_permissions` に追加しません。`host_permissions` はloopback collector用の `http://127.0.0.1/*` だけとします。
- collector endpointはportだけを設定可能とし、pathを `/v1/attempt-events` に固定します。Google Sheetsへ直接アクセスしません。

### document単位の同意

content scriptは対象documentの開始時に配置されますが、同意前にはQB DOMをqueryせず、capture用`MutationObserver`を作らず、candidate、outbox、collector処理を開始しません。同意前のbootstrapはpage-session IDの生成、同意command listenerの登録、およびREADY通知だけを行います。workerが一時的にunavailableなら同じIDのREADYを再通知し、document identityによる重複排除で自動popupを最大1回に保ちます。

service workerはREADY senderのtab、window、active state、top frame、document identity、origin、pathnameを検証します。activeな新規documentごとに、Chrome 127以降の `chrome.action.openPopup()` で同意popupを1回だけ自動提示します。background tabではactiveになるまで待ち、activeになった時点で同じdocumentであることを再確認します。popup API呼出し直前にもtarget tabのactive状態を再確認します。API欠落またはrejectでは、そのtabに `!` badgeと `QB記録: 記録開始の確認が必要` titleを設定し、captureを開始しません。documentがstaleまたは到達不能ならsessionを破棄してbadge/titleを消し、storage失敗時も同意を推定せずcaptureを開始しません。workerのcapture core準備後にcontent scriptへのstart指示が失敗した場合もbadge/titleを設定して手動確認を促します。

Chromeのtab更新通知はdocument replacementとの順序を保証する同意証拠として扱いません。`loading`と`complete`の両方を照合契機とし、その時点で保存されているexact `documentId`、またはその代替となるpage-session IDへprobeします。同じ `/quiz` documentが応答すれば同意、capture状態、自動popup済み状態を変更せず保持し、応答不能または対象外locationの場合だけfail closedで破棄します。READYが更新通知より先でも後でも、この直列化された照合により新しいsessionを遅延通知で消去しません。tab closeとtab replacementはprobeせず無条件に破棄します。

同意操作の意味は次のとおりです。

- 「記録を開始」は、activeかつcurrentな同じdocumentへのstart commandが成功した場合だけcaptureを開始します。
- popupを閉じるだけの操作は同意でも拒否でもなく、何も変更しません。同じdocumentへの自動再提示は行わず、利用者はactionを手動で開けます。
- 「今回は記録しない」は同じdocumentへの自動提示を抑止しますが、captureを開始しません。利用者が同じdocumentでpopupを手動で開き、後から記録開始を選ぶことはできます。
- verified new document、対象外location、tab close、tab replacementへ同意を引き継ぎません。同じdocument内の `/quiz` 更新では同意を保持します。

同意状態はrestricted `storage.session`、outboxと配信状態はrestricted `storage.local`へ分離し、どちらも `TRUSTED_CONTEXTS` に限定します。content scriptから届くREADY、candidate、statusはuntrusted inputとして、message shape、sender、document identity、同意状態をservice workerで再検証します。

### 観察済みDOM contract

production adapterのselectorとclass tokenを1か所に集約し、次の観察済み構造だけをsupportします。

- `span.font-semibold.text-qb-blue` のdirect textから厳格な正規形question key候補を得て、exact 1件を要求する
- その祖先として `rounded-lg bg-white p-3 sm:p-4 flex flex-col gap-3` のquestion cardをexact 1件要求する。cardを含む `flex flex-col gap-2` 祖先は観察済みどおりexact 2件を要求し、近い方をfunctional quiz root、遠い方を外側layout wrapperとする
- question card内の `button.text-left` をoptionとし、exact 5件の場合だけDOM順を明示的な1始まりindexへ対応させる
- `border-qb-green` と `text-qb-green` の両方を持つoptionだけを選択済みとする
- quiz root内の `[data-testid="explanation-box-title"]` の出現をresolved markerとする
- question card内の全 `bg-qb-sky` 要素を、class token集合とtagが完全一致する正答badge、または観察済みのexact parent pathにあるprogress fillへ完全に分類する。progress fillは各optionにexact 1件を要求し、未分類、欠落、重複、path driftをUnsupportedとする
- 選択済みoptionが0件でresult markerと1件以上のexact正答badgeがあれば、正答index集合を導出せず `resolved_without_selection` とする。progress fillだけでは正答badgeの存在証拠にしない
- 選択済みoptionが1件以上の場合だけ、各optionのdirect first childにあるexact正答badgeを厳格に検証し、正答集合と選択済み集合が一致すれば `correct`、一致しなければ `incorrect` とする

main、key、cardは各1件、cardを含むreview済みroot祖先はexact 2件、optionは5件を要求します。functional root内のresolved markerが0件ならpending、1件以上ならresolved候補です。main、key、cardの件数不足・曖昧さ、root祖先の欠落または2件以外、不正配置、resolved時のselected marker pair不整合はUnsupportedです。resolved候補では全sky markerの完全分類と各optionのexact progress pathを先に検証します。選択済みoptionが1件以上の場合はcorrect badgeの欠落、同じoption indexへの重複、不正配置もUnsupportedです。未選択の場合は1件以上のexact correct badgeの存在だけを確認し、correct index集合の導出より前に非記録状態へ遷移します。内側rootのclassが失われた場合に外側wrapperへfallbackせず、外側wrapperだけのresult markerも証拠にしません。resultやindexを推測で補いません。

capture開始後にpendingを観測し、同じquestion keyがresolvedへ遷移した場合だけattempt candidateを生成します。capture開始時にすでにresolvedな画面は新規解答の証拠にしません。resolved時に選択済みoptionが0件なら `resolved_without_selection` としてterminal扱いにし、`correct`、`incorrect`、`unknown`へ変換せず履歴化しません。terminal状態はquestion key単位であり、同じdocumentに別のsupported question keyが現れれば次のpending-to-resolved cycleを継続します。人工的な問題数上限は設けません。

正答option indexは正答集合と選択済み集合を比較するadapter内の一時値に限定します。adapterの戻り値、message、`AttemptEventV1`、outbox、診断ログへ含めません。選択済みindexは1始まりのsafe integer、1件以上、uniqueである場合だけV1へ渡します。

DOMとのinteractionはread-only queryと`MutationObserver`だけです。click、submit、event dispatch、navigation、value変更、およびrating、note、bookmark、問題setの変更を禁止します。

### 契約と配信

既存の `AttemptEventV1` V1型とJSON Schemaを変更しません。画面から安全かつ明確に取得できない `qb_question_id`、`session_id`、`source_device`、自己評価は省略し、既存fieldを別の意味に転用しません。必須のV1証拠を満たさないDOMからeventを生成しません。

eventは先にlocal outboxへ保存し、loopback collectorから同一`event_id`のexact success acknowledgementを確認した後だけ削除します。同一`event_id`の再送を許容し、停止、network failure、HTTP 429、5xxではoutboxへ残します。現在のloopback HTTP profileはextension-localで認証を持たず、history-collectorのaccepted public contractではありません。

DOM contractの不一致は、自由形式detailではなく有限allowlistの `capture_unsupported_dom:<reason>` diagnostic codeとしてcontent scriptからbackgroundへ伝播します。codeはDOM text、HTML、URL、正答indexを含めません。popupのstatus/history routeはextension pageだけに許可し、content senderからの取得を拒否します。

popupの「直近の記録」は、既存outboxと送信済みcacheをbackgroundで統合し、question key、answered-at、result、選択済みindex、delivery stateだけをanswered-at降順で最大99件返します。これは表示上限であり、capture、outbox、同一document内の問題数には上限を追加しません。popupは`chrome.storage`へ直接アクセスせず、event ID、provenance、正答index、URL、DOM/問題内容を受け取りません。storage read失敗は空履歴と解釈せず、読み取り不能として表示します。

## Consequences

- 一般配布での自動popup提示にはChrome 127以降が必要です。自動提示できない場合もaction badge/titleから手動開始できます。
- 利用者は結果表示前、すなわちcaptureがpendingを観測できる時点で記録開始する必要があります。同意前に表示済みの結果は記録しません。
- static content scriptはdocument navigation時にmatchingされます。非matching pathからSPA内遷移で `/quiz` に入った場合はreloadが必要になる可能性があります。
- QB DOMが観察済みcontractから変わった場合はイベントを失う側へfail closedにします。再対応には新しい安全な観察、content-free fixture、adapter test、reviewが必要です。
- popupを閉じただけの場合、同じdocumentへ2回目の自動提示はしません。利用者がactionを手動で開く必要があります。
- `openPopup()`はwindow IDだけを受け取りtab IDを受け取らないため、直前確認とAPI呼出しの最終瞬間に発生するtab切替を原子的には排除できません。その場合も新しいactive tabには一致する同意tokenがなく、captureは開始しません。
- loopback portを別processが保持した場合の受信やack偽装を防げません。外部配布向けcollector連携には認証とendpoint ownershipの別判断が必要です。

## Verification

fixture testでcorrect、incorrect、initial resolved抑止、rerender重複抑止、`resolved_without_selection`抑止、入れ子layout wrapper内の最寄りroot選択、外側wrapperだけのresult marker除外、未知DOMのUnsupported、具体的なallowlist済みreason code、正答index非露出を確認します。mock Chrome APIで同意前の完全不活性、document相関、自動popup、badge/title fallback、closeの無操作、decline後の手動start、`loading`/`complete`照合、READYとの両順序、popup非重複、popup statusのextension-page-only境界、最小permissionを確認します。100問を超える合成transitionでも全件を生成し、問題数上限がないことを回帰確認します。popup historyはsafe fieldだけを最大99件に表示し、保存失敗を空履歴と誤表示しないことを確認します。mock HTTP serverでcollector停止中のoutbox保持と復旧後の再送を確認します。テストは実QBサイトへ接続しません。

## Relationship to ADR-0010

このADRは、ADR-0010のうちbrowser取得手段、最小Chrome権限、選択肢から1始まりindexへの対応、およびbrowser manifestを無権限とするtemporary consequenceだけをsupersedeします。ADR-0010自体は書き換えません。Sheets同期、問題set作成、記憶modelその他の未解決事項は引き続きProposedです。
