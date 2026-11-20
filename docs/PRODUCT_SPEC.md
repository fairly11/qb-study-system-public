# Product specification

## 目的

qb-study-systemは、QBオンラインで確実に観測できた演習事実と、既存履歴から得た限定的な状態を区別して保存し、将来の復習計画と問題セット作成へ安全に受け渡すローカルシステムです。

## 対象利用者と前提

- 単一のローカル利用者を対象とします。
- 問題空間は医師国家試験QBに限定します。
- 標準タイムゾーンは `Asia/Tokyo` です。
- ローカル単独動作ではSQLiteを正本とします。ADR-0014で有効にしたNotion同期範囲はNotionが複数Mac共通の原本、SQLiteは送信待ちと控えです。Google Sheets同期は未実装です。

## コンポーネント

1. Browser extension: 利用者の自動記録指示（ADR-0017）に基づきQB `/quiz` への画面移動で記録を開始し、問題数の固定上限を設けず、観察済みDOM contractを満たす各解答イベントだけを契約へ変換する読み取り専用境界。
2. History collector: attemptとhistory snapshotを検証・照合し、SQLiteへ安全に追記する境界。
3. Review engine: 保存された証拠から、モデル中立のquestion stateとreview planを純粋計算する境界。
4. Set builder: 承認済みrequestを問題セット作成結果へ変換する境界。

共通契約、ストレージ、正規化、テスト基盤に加え、browser-extensionの自動開始する読み取り専用capture、local outbox、loopback collector配送を実装します。ADR-0014のNotion同期はcollectorの後段で動きます。その他の外部連携はAccepted ADRができるまで骨格または未実装のままです。

## 証拠モデル

- `AttemptEventV1` は、解答単位で正確に観測できたイベントです。offset付きの解答時刻が必要です。
- `HistorySnapshotV1` は、最終演習日、最終状態、集計回数など、ある時点で確認できた状態です。
- snapshotの情報量を増やす推測は禁止します。特に、snapshotから架空のattempt、時刻、選択内容、正誤系列を生成しません。
- 各レコードは由来と品質を明示し、不明値を推測で埋めません。

## 成功条件

- 7つのworkspace packageを別々にbuild、test、lint、typecheckできます。
- バージョン付きJSON SchemaがTypeScript型と同じ正本から再生成できます。
- 問題番号の許可表記を正規形へ変換し、曖昧な値を拒否できます。
- SQLite migrationが空DB、再実行、checksum不一致、失敗rollbackを安全に扱います。
- attemptsの追記専用性とidempotency conflictがDB/APIの両方で守られます。
- local history collectorがstrict `AttemptEventV1`をSQLiteへcommitした後だけ
  exact ACKを返し、browser outboxを安全に解消できます。
- UTC瞬間とAsia/Tokyoの暦日境界を混同しません。
- ログ、fixture、schema、コードにQBコンテンツや認証情報を含めません。

## 対象外

- QBサイトへの書き込み操作、解答操作、画面遷移の自動化
- QB非公開APIの解析やリバースエンジニアリング
- 問題文、選択肢本文、解説、画像の外部保存
- QBの認証、cookie、token管理（Notion接続の認証はADR-0014で扱う）
- Google Sheetsへの実同期
- 記憶モデル、復習間隔、優先順位の確定
- 問題セットを実サイトに作成する操作

## 解決済みのbrowser境界

QB画面からの取得範囲、最小Chrome権限、および画面上optionのDOM順から1始まりindexへの対応は [ADR-0012](ADR/0012-browser-extension-qb-capture-consent.md) に従います。ページごとの開始操作は [ADR-0017](ADR/0017-automatic-qb-capture.md) の自動開始へ置き換えます。確認済みの復習セットは復習とし、それ以外は原則通常学習にします。セット照合の障害や不正なセットIDは判定未確認として残し、拡張の二つのボタンで現在の演習を手動分類できます。手動選択は以後の解答だけに適用し、保存済みの記録は変更しません。`AttemptEventV1` V1は変更しません。

## 未解決事項

- Google Sheetsの列、認証方式、同期頻度、部分失敗時の運用
- 問題セット作成時の操作方式、承認手順、検証方法
- 具体的な記憶モデル、復習間隔、優先順位、evidence不足時の扱い

残る事項は公開契約または外部操作に影響するため、後続ADRで決定するまで実装しません。
