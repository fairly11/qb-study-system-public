# Test strategy

## 原則

テストは、証拠の意味、契約互換性、追記専用性、時刻境界、安全境界を優先します。実QBサイト、Google Sheets、認証サービスには接続しません。QB pageの検証は、問題文、選択肢本文、解説、画像を含まない合成HTML fixtureとmock Chrome APIだけで完結させます。

## 必須テスト群

### Question normalizer

- `119A12`、`119-A-12`、`119 A 12`、`１１９Ａ１２` が同じ正規形になる
- lowercaseや全角の許可表記を正規化する
- `11565`、複数英字、余分な記号、空文字を `invalid_format` として拒否する
- question keyからgroup IDを推定しない

### JSON Schema

- すべてのV1 schemaがAjv strict modeでcompileできる
- `$id` が一意である
- valid fixtureを受理し、invalid fixtureと追加fieldを拒否する
- schema再生成結果とcommit済みschemaに差分がない
- AttemptEventとHistorySnapshotを相互に拒否する
- `@ts-expect-error` fixtureで型レベルでも両者を混同できない

### SQLite

- 空DBからlatestまでmigrationできる
- 再実行がno-opである
- 適用済みmigrationのchecksum変更と番号欠落を拒否する
- migration途中の失敗をrollbackする
- 必須table、index、triggerが存在する
- attemptsと選択番号のUPDATE/DELETEを拒否する

### Idempotency

- 同一event ID・同一安全fieldの再送は `duplicate`
- 同一source record IDの再送を重複として扱う
- 同じidempotency keyで内容が異なる場合は `IDEMPOTENCY_CONFLICT`
- 別event IDで同一内容の正当な反復解答を統合しない

### Time zone

- `14:59:59.999Z` と `15:00:00.000Z` がAsia/Tokyoで別日になる
- offset付きinstantを同じUTC瞬間として扱う
- offsetなしdatetimeを拒否する
- date-onlyに架空のinstantを生成しない

### Extension manifestと配布境界

- manifest versionが3、`minimum_chrome_version`が127である
- API permissionが `alarms` と `storage` だけで、`tabs`、`webNavigation`、`activeTab`、`scripting`、cookie、webRequestを持たない
- `host_permissions` が `http://127.0.0.1/*` だけで、QB domain、localhost hostname、`<all_urls>` を含まない
- static content scriptが `https://qb.medilink-study.com:443/quiz` と `https://qb.medilink-study.com:443/quiz?*`、`document_start`、top frame only、`ISOLATED` worldに限定され、about/related frame fallbackを無効にする
- background、popup、content scriptの配布bundleがIIFEで自己完結し、ESM import、source map、`eval`、`new Function`、remote hosted codeを含まない
- 配布content scriptがsynthetic fixture selectorを含まず、synthetic adapterをproduction entrypointから到達不能にする
- capture pathにclick、submit、dispatch、navigation、DOM write、rating/note/bookmark/set変更がない

### Document単位の同意

- exact origin `https://qb.medilink-study.com`、exact pathname `/quiz`、top frameのdocumentだけがREADY登録される
- content bootstrapは同意前にQB DOMをqueryせず、capture `MutationObserver`、candidate、outbox、collector処理を開始しない
- workerの一時的なunavailable応答後も同じpage-session IDでREADYを再通知し、その間adapterとMutationObserverを開始しない
- activeな新規documentでは `chrome.action.openPopup()` を1回だけ試行し、同一READY再送で重複提示しない
- background tabでは提示せず、そのexact tabがactiveになった時だけdocumentのcurrent性をprobeして提示する
- popup試行途中にtarget tabがinactiveになった場合はwindowへpopupを開かず、状態をpendingへ戻す
- popup自動提示のAPI欠落・reject時はcaptureを開始せず、tab固有の `!` badgeと `QB記録: 記録開始の確認が必要` titleを表示する
- staleまたは到達不能なdocumentはephemeral sessionを破棄してbadge/titleを消し、captureを開始しない
- workerのcapture core準備後にcontent scriptへのstart指示が失敗した場合はcaptureを開始せず、tab固有のbadge/titleで手動確認を促す
- popupを閉じてdecision messageを送らない場合は、同意も拒否も記録せずcaptureを開始しない
- 「今回は記録しない」はそのdocumentをdeclinedにし、自動再提示せず、captureを開始しない
- declined後も同じactive/current documentに対する手動「記録を開始」は許可する
- start command成功前、start失敗後、および異なるdocument/tab/frame/origin/path senderからのcapture messageを拒否する
- `documentId`がある場合はそれを優先し、ない場合もgenerated page-session IDでstale documentを拒否する
- `loading`と`complete`の両方で、その時点の保存sessionをexact documentへprobeして照合する
- 同じdocumentが応答する場合は同意、observing、自動popup済み状態を保持し、popupを再表示しない
- probe不能、対象外location、またはverified different documentではfail closedでephemeral consentを消去する
- READYの後に遅延したtab更新が来る順序でも、tab更新の後にREADYが来る順序でも、新documentのsessionを誤消去しない
- tab closeとtab replacementではprobe結果にかかわらずephemeral consentを無条件に消去する
- consent stateを `storage.session`、outboxを `storage.local` に分離し、両方のaccess levelを `TRUSTED_CONTEXTS` にする
- badge/titleおよびconsent storageにquestion key、option index、URL、DOM text、credentialを含めない
- popup status/history取得をextension pageだけに許可し、content senderを拒否する
- popupの直近記録はoutboxと送信済みcacheを統合し、answered-at降順、表示のみ最大99件とする
- popupへ返す各記録をquestion key、answered-at、result、selected indices、delivery stateのexact fieldに限定し、event ID、provenance、正答index、URL、HTML、自由形式payloadを拒否する
- storage read失敗を空履歴と表示せず、`storage_state_blocked` と読み取り不能表示にする
- 旧popup-triggered capture版の診断codeを含むstateも復元し、既存outboxを読み取り不能にしない
- popup command成功後のstatus再取得が失敗した場合、古い成功codeで再取得errorを上書きしない

### Production QB adapterとcapture

- 観察済みfixture上でquestion keyのdirect textだけを正規化し、question cardをexact 1件、cardを含むreview済みroot祖先をexact 2件要求して近い方をfunctional rootとして選ぶ
- 外側layout wrapperだけにあるresult markerは現在の問題の証拠にせず、最寄りrootの外からresolved状態を生成しない
- 内側rootのclass driftまたは追加matching ancestorでroot祖先数が変わった場合は外側へfallbackせずUnsupportedにする
- optionはquestion card内の `button.text-left` がexact 5件の場合だけDOM順を1始まりindexへ対応させる
- selected markerは `border-qb-green` と `text-qb-green` の両方が一致するbuttonだけを受理する
- result marker出現後、card内の全 `bg-qb-sky` を、tagとclass token集合が完全一致するcorrect badge、または観察済みのexact三段pathにあるprogress fillへ分類する。progress fillを各optionにexact 1件要求し、未知要素、class追加・欠落、wrong tag、欠落、重複、path driftをUnsupportedにする
- selected集合が空なら全sky要素の分類後に1件以上のexact correct badgeの存在だけを確認して `resolved_without_selection` とし、正答index集合を導出しない。progress fillだけのDOMはcorrect marker missingとして拒否する
- selected集合が非空の場合だけ、各exact correct badgeがoptionのdirect first childであり、欠落・重複・不正配置がないことを確認して比較する
- correct markerを全件走査し、marker自身がoption、option祖先0件、option祖先複数、同一optionへの重複を拒否したうえで、全markerがdistinctなreview済みoptionへ一意対応するがpositionだけ未reviewの場合を単一の有限codeで示す。正答indexやDOM内容は診断へ含めず、この段階ではUnsupportedのままとする
- 同一optionへ複数markerが対応する場合も後続markerを最後まで検査し、option要素単位で重複除去した集合とselected option要素集合の関係を、一致、strict superset、strict subset、disjoint、同数partial overlap、異数partial overlapの排他的な有限codeで示す。correct option index、marker件数、DOM内容を返さず、全codeをUnsupportedのままとする。旧generic differs codeは保存済みstateの復元互換用にだけ残し、新規runtimeでは生成しない
- selected集合と一時的なcorrect集合の一致から `correct`、不一致から `incorrect` を生成する
- correct option indexをadapterのresolved observation、candidate、`AttemptEventV1`、outbox、logへ露出しない
- 初期resolved DOMは送信せず、同意後にpendingを観測してから同じquestion keyがresolvedへ遷移した場合だけ1件生成する
- `resolved_without_selection` はterminalとして同一questionの後続再描画を抑止するが、AttemptEventを生成しない
- `resolved_without_selection` ではevent IDと時刻を生成せず、real BackgroundCoreのoutbox、delivered event、collector requestがすべて0件のままである
- DOM再描画、同一result marker再挿入、MutationObserverの重複通知で同じeventを二重生成しない
- 100問を超えるdistinct question keyのpending-to-resolved反復を同一controllerで処理し、人工的な問題数上限なしに各問1件を生成する
- question key切替、main/cardの欠落・曖昧、root祖先数の不一致、option/markerの欠落・不整合、想定外locationはUnsupportedとなりeventを送らない
- Unsupportedの具体的理由を有限allowlistの `capture_unsupported_dom:<reason>` codeとして伝播し、任意detailやDOM内容を拒否する
- direct textが不正なquestion key要素は、boundedな子孫全体または個別text nodeが既存grammarに適合するかだけを有限分類し、raw textを返さず、候補があっても診断段階ではUnsupportedのままとする
- Unsupported状態が継続してもreasonが変われば新しいcodeを伝播し、同じreasonの重複だけを抑止する
- 後続の `capture_observing` やdelivery診断後も、直近のallowlist済みcapture failure codeをpopupで確認できる
- fixtureに問題文、選択肢本文、解説、画像、URL parameter値、認証情報を入れない

### Outboxとcollector

- backgroundのoutbox保存ackまではcontent scriptが同一event IDのcandidateを保持・再送する
- collector停止時にoutboxを保持し、同一event IDのinserted/duplicate ack後だけ削除する
- network failure、HTTP 429、5xxをretryし、malformed ack、event ID不一致、non-retryable responseをblockedにする
- collector復旧後にalarmまたは手動retryで送信できる
- blocked eventの後続pending eventをalarmなしで取り残さず、手動retryでblockedを再開する
- endpointは127.0.0.1、設定可能port、exact `/v1/attempt-events`だけを受理し、credentials、query、fragment、redirectを拒否する
- payloadが`AttemptEventV1`にstrict適合し、問題文、選択肢本文、解説、画像、正答index、session/device/self-rating、cookie、tokenを含まない

### History collector HTTP boundary

- serverがIPv4 `127.0.0.1`へだけbindし、port競合時に別portへfallbackしない
- exact `POST /v1/attempt-events`とuncompressed `application/json`だけを受け、
  method、path、query、Host、content type/encoding、credential headerの不一致を
  4xxで拒否する
- streaming bodyとContent-Lengthのいずれでも64 KiB上限を超える入力を拒否し、
  request bodyをerrorやlogへechoしない
- strict `AttemptEventV1`のinsertedでcommit後のexact ACKを返し、SQLite本体と
  全selected optionを再open後にも確認できる
- 同一payloadのreplayは行数を増やさずexact duplicate ACKを返す
- 同じevent IDの内容相違は409で既存rowを保持し、storage/runtime failureは5xxで
  extensionのretry対象にする
- 一件の合成outboxはexact committed ACKの後だけ`1 -> 0`となり、malformed ACK
  相当では削除しない
- graceful shutdownがlistenerを閉じてからowned storageを閉じ、重複closeも安全に
  処理する

### Repository safety

- review-engineがstorageをimportしない
- schema、fixture、ログtableに問題文、選択肢本文、解説、画像、認証情報用payloadがない
- `packages/contracts` のV1型と生成済みschemaにbrowser-extension都合の差分がない

## 実行

```sh
pnpm build
pnpm test
pnpm lint
pnpm typecheck
pnpm verify
```

各packageは `pnpm --filter @qb-study/<name> test` のように単独実行できる必要があります。browser-extension単体は `pnpm verify:browser-extension` でlint、typecheck、fixture test、bundle buildを確認します。ネットワークや実サイトを必要とするテストはこの基盤へ追加しません。
