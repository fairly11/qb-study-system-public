# Notion同期の設定

Chrome拡張で取得した解答を、各PCの収集サービスから共通のNotionへ同期します。
複数の端末で同じ問題を解いた場合も、解答ごとに別の記録として残ります。
この手順はMacの収集サービス向けです。
iPhone / iPadは [Safari版の導入手順](IOS_SAFARI.md)、Windowsは [Windows記録専用版](../apps/windows-recorder/README.md) を参照してください。

## 接続先を用意する

Notionの内部接続を作成し、「QB解答ログ」と「QB問題マスター」をその接続と共有します。
内部接続は、このプログラムがNotionへアクセスするための設定です。
必要な権限はコンテンツの読み取り、挿入、更新です。
更新権限は問題マスターとの関連付け修復に使います。
ユーザー情報、メール、コメントの権限は不要です。

保存先は、プログラムが定義する列と関連付けに合わせて用意してください。
設定コマンドは既存の構造を検査し、不一致の場合は停止します。
データベースを新規作成するコマンドではありません。
必要な列の定義は `services/history-collector/src/notion-client.ts` の構造検証処理を参照してください。

「QB解答ログ」の `記録データV1` 列には、取得した解答の元データをJSON形式で保存します。
問題文や解説は含みません。
Notionの「解答日時」「取得日時」は一覧表示用に分単位で保存し、秒以下を含む正確な日時は元データに保持します。
同じ分に解いた別の解答も、異なるイベントIDでそれぞれ保存します。

## Macに接続設定を保存する

Node.js 24.19.0以上25未満とpnpmを用意し、リポジトリ直下でビルドします。

```sh
pnpm install --frozen-lockfile
pnpm build
```

次のコマンドの二つのIDを、Notionの解答ログと問題マスターの `data_source_id` に置き換えます。
`database_id` やページIDとは異なります。

```sh
pnpm --filter @qb-study/history-collector notion:configure 解答ログのdata_source_id 問題マスターのdata_source_id
```

接続キーを求められたら、ターミナルへ入力します。
入力内容は表示されません。
プログラムは接続先の構造を読み取り、成功すると次のファイルへ設定を保存します。
この確認では学習記録を追加しません。

```text
~/Library/Application Support/qb-study-system/notion-sync.json
~/Library/Application Support/qb-study-system/notion-token
```

設定JSONには接続先IDと接続キーファイルの場所を保存します。
接続キー本体は別ファイルに保存し、どちらも所有する利用者だけが読み書きできる権限で作成します。
既存の設定がある場合は、上書きせず `NOTION_SETUP_EXISTS` で停止します。

設定後に収集サービスを起動します。

```sh
pnpm --filter @qb-study/history-collector start
```

15秒ごとに新しい記録を同期します。
最初に同期を有効にした時点より前の履歴は、既定では対象に含めません。
再起動しても対象の開始位置は変わらず、送信待ちは保持します。
PCごとに設定し、SQLiteファイルをPC間で複製・共有しないでください。

## ログイン時の自動起動

自動起動にはmacOSのLaunchAgentを使用できます。
利用者のログインに合わせてプログラムを起動する仕組みで、設定したMacと利用者にだけ有効です。
このリポジトリの起動コマンドは、LaunchAgentを自動登録しません。

手動で設定する場合は、Node.js、ビルド済みの収集サービス、データベース移行用ファイルを固定の場所へ配置します。
開発中に削除・移動するフォルダやキャッシュを起動先にしないでください。

配置例:

```text
~/Library/Application Support/qb-study-system/runtime/node-v24.19.0/bin/node
~/Library/Application Support/qb-study-system/runtime/collector/dist/collector.mjs
~/Library/Application Support/qb-study-system/runtime/collector/migrations/
~/Library/LaunchAgents/local.qb-study.history-collector.plist
```

起動設定には実行ファイル、SQLite、Notion設定、ログの絶対パスを指定します。
接続キー本体は書きません。
異常終了時の再起動には間隔を設け、正常終了時は再起動しない構成にします。

切り替え時には起動中の収集サービスを終了し、同じSQLiteとNotion設定を使います。
二重起動がないことと、ログアウト後の再ログインで起動することを確認してください。
コードを更新した際は、この配置先のプログラムも更新します。

解除時はLaunchAgentを登録解除し、対応するplistをLaunchAgentsの外へ移します。
SQLiteとNotion設定は削除する必要はありません。

## 動作を確かめる

ChromeのQB記録拡張を有効にし、普段どおり問題を解きます。
Notionの解答ログで、問題番号、日時、選択記号、正誤、問題マスターとの関連付けを確認してください。
複数端末を使う場合は、各端末での解答が同じ表に追加されることを確認します。

拡張のOutboxが0なら、同じPCへの保存が完了しています。
収集サービスの同期結果では、確認済みを `confirmed`、送信待ちを `pending`、調査が必要な状態を `blocked` で示します。
これらの件数は、その収集サービスが確認した記録の件数です。
Notion全体の総件数ではありません。

## 通信失敗からの復旧

一時的な読み取り失敗や送信制限では、待機して再試行します。
Notionへの作成中に通信が切れた場合は、同じイベントが既に保存されているかを読み戻します。
照合できなければ再作成を保留し、元のデータをPCに残します。

| コード | 対処 |
|---|---|
| `NOTION_SCHEMA_MISMATCH` | 列の型、選択肢、関連先を確認する |
| `NOTION_UNAUTHORIZED` / `NOTION_FORBIDDEN` | 接続キーと対象表への権限を確認する |
| `NOTION_CREATE_UNCONFIRMED` | 同じイベントIDでNotionの保存内容を照合する |
| `NOTION_DUPLICATE_EVENT` / `NOTION_EVENT_CONFLICT` | 重複や内容不一致を元の記録と比較する |
| `NOTION_REMOTE_MISSING` | 一度確認した行の削除や権限変更を調べる |

保存結果が不明なまま、同期記録やイベントIDを消さないでください。
再送時に同じ記録を照合できなくなり、重複作成につながります。

## 同期を止める

収集サービスを終了すると同期も停止します。
ローカル記録だけを続ける場合は、`notion-sync.json` の `enabled` を `false` にして再起動します。
再開するときは `true` に戻します。
この設定では解答と送信待ちを削除しません。

新しいデータベース形式を古いプログラムで開くと拒否されます。
同期の問題を切り分ける際は、旧版へ戻す前に同じ版で同期を無効にしてください。
データベースを更新する前には、別のローカルファイルへバックアップを保存します。

記録前に閉じたタブや、未対応の画面で取得できなかった解答を、同期処理が後から補うことはありません。
取得側の制限は [Chrome拡張](../apps/browser-extension/README.md#更新と制限) を参照してください。
