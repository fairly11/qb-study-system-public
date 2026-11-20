# Data contracts

## 正本と互換性

TypeBox定義をTypeScript型とJSON Schemaの正本とし、Draft 2020-12 schemaを `packages/contracts/schemas/v1` に生成・コミットします。wire fieldは `snake_case`、原則として `additionalProperties: false` です。

すべてのtop-level recordは次を持ちます。

- `schema_version: "1"`
- 固定値の `record_type`
- record固有UUID
- `provenance`: producer、producer version、source system、任意のsource record ID、recorded at
- `quality`: acquisition method、temporal precision、state precision

許可する品質語彙は次のとおりです。

- acquisition: `direct_capture | imported_baseline | derived | manual`
- temporal: `exact | date_only | not_applicable`
- state: `exact | final_state_only | not_applicable`

外部から取得して永続化する識別子は、自由文の退避先にしません。`producer`、`producer_version`、`source_system`、任意の `source_record_id`、`question_group_id`、algorithm ID/versionは長さを制限し、`^[A-Za-z0-9][A-Za-z0-9@._:/+%#=~-]*$` に一致するsafe tokenだけを受け付けます。利用者が付ける `set_name` はこの制約の対象外ですが、QBコンテンツを入れてよいことを意味しません。

完全なrequired/optional制約は生成済みJSON Schemaが正です。本書は意味上の不変条件を定めます。

生成Schemaのtimestamp `pattern` は字句形式とoffset上限を表し、calendar validityと「UTC正規化後も4桁yearに収まる」という演算を伴う制約は `format` の意味検証です。利用側は `packages/contracts` が公開するAjv validator、または同等のformat validatorを使用し、patternだけで受理判断してはいけません。

## 契約一覧

### AttemptEventV1

確実に観測した1回の解答を表します。問題key、任意のgroup ID、offset付き `answered_at`、`correct | incorrect | unknown`、重複しない1始まりの選択番号を扱います。問題文や選択肢本文は扱いません。

### HistorySnapshotV1

ある取込runで確認できた1問題の最終状態を表します。最終状態、任意の集計回数、および分かる場合だけ `last_attempted_at` または `last_attempted_on` を扱います。snapshotはattemptの代替ではなく、相互変換APIを設けません。

### QuestionStateV1

review algorithmが証拠から導出したモデル中立の状態です。algorithm ID/version、計算時刻、evidence watermark、evidence sufficiency、nullableな次回復習日を持てる設計です。具体的な記憶モデルはV1で固定しません。

### ReviewPlanV1 / ReviewPlanItemV1

`Asia/Tokyo` の対象日と、順位付きの問題項目を表します。生成algorithmと各項目の安全な選定理由を記録します。問題内容は含めません。

### SetBuildRequestV1 / SetBuildResultV1

requestはset名、正規化済みquestion key、任意のreview plan ID、dry-run指定を表します。resultはrun全体の状態と、問題key単位の安全な結果を表します。状態語彙は `planned | succeeded | partial | blocked | failed` です。

### SyncResultV1

SQLiteからGoogle Sheetsへの将来の片方向同期結果と件数を表します。SheetsからSQLiteへデータを取り込む意味は持ちません。

### ErrorEnvelopeV1

component、安定したerror code、retryable、correlation ID、およびallowlist化した安全な識別子だけを表します。任意payload、stack、秘密、QBコンテンツを運ぶ用途には使いません。

## 時刻

- 瞬間はtimezone offsetを含むISO 8601入力だけを受け、UTC `Z` に正規化します。numeric offsetは `-14:00` から `+14:00` までで、絶対値14時間では分を `00` に限定します。yearはproleptic Gregorian calendarの4桁 `0000`〜`9999` とし、UTC正規化後もこの範囲に収まる入力だけを受け付けます。小数秒は省略または1〜3桁（最大ミリ秒精度）だけを受け付け、範囲外へ正規化される値、範囲外offset、4桁以上の小数秒は丸めずに拒否します。canonicalな保存値は常に3桁のミリ秒を持つUTC `Z` 形式で、同じV1契約へ再入力できます。
- offsetのないlocal datetimeは拒否します。
- date-onlyは4桁yearのproleptic Gregorian `YYYY-MM-DD` と `Asia/Tokyo` の組として解釈します。
- date-onlyから午前0時のinstantを作りません。

## 問題識別子

正規形は `119A12` のような「回数 + 1英字 + 問題番号」です。NFKCと大文字化の後、回数・英字間および英字・問題番号間に限り、単一ASCII空白、または前後に単一ASCII空白を伴える単一ハイフンを区切りとして許可します。tab、改行、連続空白、連続ハイフン、先頭・末尾空白、その他の区切りは拒否します。`11565` のように英字を欠く値や余分な記号は推測補正しません。

連問では `question_group_id` と `question_key` を別々に保持します。連番、時刻、出題順からgroupを推定しません。

## 数値境界

JSONとJavaScript間で整数精度を失わないよう、すべての整数counter、index、count、positionはそれぞれの下限に加え `Number.MAX_SAFE_INTEGER`（`9007199254740991`）を上限とします。上限を超える入力は丸めずにschema validationで拒否します。

## 進化ルール

- V1のrequired field削除、意味変更、enum narrowing、field名変更をしません。
- 破壊的変更はV2 schemaと移行方針を追加します。
- schema生成差分、Ajv strict compile、valid/invalid fixtureをCI相当の `verify` で確認します。
- 契約に影響する未決事項は推測で埋めず、ADRがacceptedになるまで未解決として残します。
