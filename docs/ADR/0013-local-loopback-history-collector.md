# ADR-0013: 同じ端末で動く解答収集サービス

- 状態: 採用
- 決定日: 2026-08-27
- 関連: [ADR-0002](0002-sqlite-source-of-truth.md)、[ADR-0005](0005-attempt-idempotency.md)、[ADR-0008](0008-data-minimization-and-safe-logs.md)、[ADR-0012](0012-browser-extension-qb-capture-consent.md)

## 背景

Chrome拡張内の送信待ちをSQLiteへ保存するため、同じ端末で解答を受け取るプロセスが必要になる。
既存の保存パッケージは入力検証と追記処理を持つため、収集サービスはその保存結果を確認してから拡張へ応答する。

## 通信と保存

`services/history-collector` をNode.js 24のHTTPサーバーとして実装する。
ADR-0012の解答送信について、次の制約を設ける。

- 待受アドレスはIPv4の `127.0.0.1` に固定する。
- 既定のポートは `8765`。設定できるのは1〜65535の整数ポートだけとする。
- 解答の受信先は `POST /v1/attempt-events` とし、クエリやフラグメントを拒否する。
- 非圧縮の `application/json` を一件受け付け、本文の上限は64 KiBとする。
- 認証ヘッダー、cookie、異なるHost、未対応のメソッド・パス・内容形式・エンコードを拒否する。
- CORSの許可は返さない。
- `validateAttemptEventV1` で検証し、`HistoryCollectorStorage.appendAttempt` で再検証して保存する。
- 保存結果が `inserted` または `duplicate` の場合だけ、`{event_id, status}` をHTTP 200で返す。

応答には受信したイベントIDを使い、保存層の `existing_record_id` は返さない。
識別子が同じで内容が異なる場合は409、不正な入力は4xx、予期しない保存失敗は500を返す。
エラーには定義済みのコードだけを含め、受信した本文をそのまま返さない。

## 設定と保存形式

待受ポートは `QB_STUDY_COLLECTOR_PORT`、SQLiteの保存先は `QB_STUDY_DB_PATH` で指定する。
保存先に相対パスが指定された場合は、待受開始前に停止する。
Macの既定の保存先は `~/Library/Application Support/qb-study-system/qb-study.sqlite` とする。

この受信処理ではV1契約やSQLiteスキーマを変更せず、既存のトランザクション、重複照合、追記専用トリガー、ファイル権限の管理を使う。
Notion同期と復習セット照合の追加は [ADR-0014](0014-notion-shared-original.md) と [ADR-0017](0017-automatic-qb-capture.md) を参照する。

## 制約

保存成功の応答は、SQLiteへのトランザクションが確定したことを意味する。
応答を失って再送しても `duplicate` を返せるため、拡張は同じ記録を二重保存せずに送信待ちを解消できる。
不正な入力や内容の競合を保存成功として扱わない。

SQLiteへの同期処理中は、設定した待機時間まで収集サービスの他の処理も待つことがある。
単一利用者の端末内通信として、この制約を受け入れる。

解答送信には収集サービスを認証する仕組みがない。
同じ端末上の別プロセスが指定ポートを使うと、解答を受け取ったり保存成功を偽装したりできる。
端末外に公開する場合は、接続先の所有確認と認証を別途設計する必要がある。
データベースの補助ファイル、バックアップ、親フォルダの権限、ディスク暗号化は [セキュリティ方針](../SECURITY.md) に従う。
