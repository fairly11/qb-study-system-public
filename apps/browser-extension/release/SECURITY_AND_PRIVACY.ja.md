# セキュリティとプライバシー

## 保存する情報

- 正規化済み問題番号
- 重複排除・同一性確認用のランダムなイベントID（UUID）とpayloadのSHA-256
- 利用者が明示的に選択した選択肢の1始まり番号
- 正解、不正解、unknownの結果
- 解答結果を検出した時刻
- AttemptEventV1で固定されたschema、由来、品質field
- 学習区分と、確認できた場合の復習計画ID
- Outboxの再試行状態と、有限の診断code・発生時刻

Chromeのsession中だけ、現在のdocumentに対する同意状態、tab・window・documentの
識別子、ランダムなpage session ID、移動元のセットIDも`storage.session`へ保持します。これらは
AttemptEventやcollectorのSQLiteへ送りません。

## 保存しない情報

- 問題文、選択肢本文、解説、画像
- ページ全体のHTMLや不要なURL parameter
- Cookie、password、token、OTP、ログイン情報
- QBの非公開APIや通信内容
- 正答選択肢番号

拡張機能は利用者の自動記録指示に従い、問題画面で対応するDOMを読み取るだけで、クリック、解答確定、画面遷移、
評価、ノート、ブックマーク、問題セットを変更しません。DOMが確認済み構造と
一致しない場合はイベントを作らず、Unsupportedとして停止します。

未送信イベントはChromeの `storage.local` Outboxへ残ります。collectorは
`127.0.0.1`だけで待受け、AttemptEventV1をSQLiteへcommitした後にだけACKを
返します。ACKを確認するまで拡張機能はOutboxからイベントを削除しません。

collectorは認証なしのローカル専用profileです。同じ端末上の悪意あるprocessが
先にportを確保した場合の受信や偽ACKを防げません。このベータ版は個人管理下または
信頼できる端末だけで使用してください。

SQLiteのdirectoryは新規作成時`0700`、DB本体は`0600`です。端末暗号化、backup、
既存親directoryの権限は利用者が管理します。
