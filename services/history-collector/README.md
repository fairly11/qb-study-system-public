# 解答記録の収集サービス

Chrome拡張から届いた解答を、同じPCのSQLiteへ保存するサービスです。
Notion同期を設定すると、保存した解答を共通のNotionデータベースへ送ります。
拡張に返す保存応答はローカル保存の完了を意味し、Notionへの送信完了とは別です。

## 起動と設定

リポジトリ直下で実行します。

```sh
pnpm build
pnpm --filter @qb-study/history-collector start
```

既定の待ち受け先と保存先は次のとおりです。

```text
http://127.0.0.1:8765
~/Library/Application Support/qb-study-system/qb-study.sqlite
```

待ち受けアドレスは `127.0.0.1` に固定しています。
ポート番号とデータベースの絶対パスを変更する場合は、次の環境変数を指定します。

```sh
QB_STUDY_COLLECTOR_PORT=9876 \
QB_STUDY_DB_PATH="/absolute/path/qb-study.sqlite" \
pnpm --filter @qb-study/history-collector start
```

起動中のターミナルで `Control-C` を押すと終了します。
プログラムから停止する場合は `SIGINT` または `SIGTERM` を送ります。

Notion同期の導入は [設定と復旧の手順](../../docs/NOTION_SYNC.md)、復習計画の作成は [日次復習の手順](../../docs/DAILY_REVIEW_OPERATIONS.md) を参照してください。
Notion設定がなければ、ローカル保存だけで動作します。

## HTTPの受け付け経路

| メソッドと経路 | 用途 |
|---|---|
| `POST /v1/attempt-events` | `AttemptEventV1` 一件の保存 |
| `POST /v2/attempt-events` | 解答と学習区分を含む `StudyAttemptEnvelopeV1` 一件の保存 |
| `GET /v1/review-sets/<ID>` | 確認済みの日次計画とセットIDの照合 |

POSTは圧縮されていない `application/json` を受け付け、本文の上限は64 KiBです。
形式と内容を検証し、解答と選択番号の保存が確定してから応答します。
学習区分を含む場合は、その区分も同じ保存処理で確定します。

新規保存と、同一の解答を再送した場合は、ともにHTTP 200で返します。

```json
{"event_id":"10000000-0000-4000-8000-000000000001","status":"inserted"}
```

```json
{"event_id":"10000000-0000-4000-8000-000000000001","status":"duplicate"}
```

同じイベントIDで内容が異なる場合は409、入力不正は4xx、保存処理の失敗は500です。
復習セットの照合が利用できない場合は503を返します。
エラー応答に入力内容は含めません。

認証ヘッダー、Cookie、追加のクエリー文字列、想定外のHostヘッダーを拒否します。
復習セット照合は拡張用の固定ヘッダーも検証します。
CORSによる外部サイトからの接続は許可しません。

## 保存とセキュリティ

解答は追記専用で、同じイベントIDの再送によって件数を増やしません。
保存応答の後に拡張が送信待ちを取り除くため、収集サービスを再起動しても受領済みの解答を再送できます。

このサービスには通信相手の認証がありません。
同じPCで別のプログラムがポートを先に使うと、収集サービスになりすますことができます。
外部ネットワークに公開せず、管理できるPCで使用してください。

通常のログは構成要素名、診断コード、件数などに限定しています。
解答の本文、リクエスト全体、認証情報は出力しません。

## 検証

```sh
pnpm --filter @qb-study/history-collector verify
```

合成イベント、一時的なSQLite、同じPC内のテスト用ポートを使用します。
保存後の応答、同一IDの再送、内容競合、入力拒否、本文サイズ制限、停止処理、拡張の送信待ちとの連携を検査します。
