# ADR-0019: iPhone / iPadのSafariで解答を記録する

- 状態: 採用
- 決定日: 2026-10-25
- 関連: [ADR-0017](0017-automatic-qb-capture.md) の学習区分

## 背景と構成

iPhoneやiPadだけで解答を保存し、Macの起動状況に依存せずNotionへ送信できるようにする。
Safari拡張が解答を取得し、Swiftで実装した端末側の処理がSQLiteへの保存とNotion同期を担う。
復習計算と問題セット作成にはMac側の処理を使用する。

## 二段階の保存

Safariの取得処理は、実際の解答操作と結果表示から `AttemptEventV1` を作る。
操作を伴わない再表示では増やさず、同じ問題を実際に解き直した場合は新しい `event_id` を発行する。

最初に拡張専用の永続領域へ、イベントIDごとに独立した項目として保存する。
Safariの背景処理は、ネイティブメッセージで端末側のプログラムへ渡す。
端末側はApp Group（アプリと拡張の共有領域）のSQLiteへ、解答と由来を一つのトランザクションで保存してから応答する。
この応答を受けるまでSafariの送信待ちを取り除かない。
同じイベントIDの再送は内容を照合し、不一致なら停止する。

端末側のインストール識別子と演習セッション識別子を、取得元の記録を識別する `provenance.source_record_id` に含める。
V1のフィールドは追加・変更しない。
Notionを端末共通の原本、SQLiteを送信待ちと控えとして扱い、解答、分類結果、同期経過を追記専用にする。

## 同期と再開

Notionへの新規作成前に、作成予定をSQLiteへ確定保存する。
応答が不明な場合はイベントIDまたは既知のページIDで読み戻し、見つからないことだけを理由に再作成しない。
問題マスターの作成にも同じ制約を適用する。
Notionには一意制約がないため、複数端末による同時作成の競合を完全には防げない。
重複や不一致は停止して表示する。

アプリと拡張の同期処理は、OSのファイルロックで同時実行を防ぐ。
時刻だけでロックの期限切れを判断すると、停止中だった処理の復帰時に重なるおそれがあるため、この方式は使わない。

iOSは背景処理を停止することがあり、アプリを閉じたままの常時送信は保証できない。
Safari内だけに残った記録は、QBへの再入場や拡張の表示で転送を再開する。
端末側へ保存済みの記録は、管理アプリを開いた場合もNotion送信を再開できる。

## 学習区分とNotionへの接続

学習区分はADR-0017に従う。
確認済みの復習セットは復習、由来のない正当な問題画面は通常学習とする。
セットの由来がある場合は、Notionの日次計画データと確定済みのセットリンクを照合する。
途中までしか読めていない一覧から、復習セットではないと判定しない。

照合を続きから再開できるよう、確認済みのページID、タイトルのハッシュ、セットID、計画ID、再開位置をSQLiteへ追記する。
通信の失敗や計画の矛盾で分類できない解答は端末に保持し、後で再開する。
手動選択は以後の解答に適用し、古い送信待ちには保存時の規則を維持する。
問題番号、セット名、正答率だけから学習区分を推定しない。

V1の `producer` は `browser-extension`、`producer_version` は `ios-0.1.0` とし、Notionの「記録元」は「Safari拡張」とする。
共通履歴を読むMac側も、この記録元を受け付ける版である必要がある。

## 接続キーと通信先

接続キーは共有App Groupに属するKeychainへ、端末限定の保護属性で保存する。
JavaScriptやQBページへ渡さず、応答とログにも含めない。
Notionへの通信は端末側で行い、接続先を `https://api.notion.com/v1` に固定してリダイレクトを追跡しない。

保存前に接続先の列構造を確認し、想定と異なる場合は新しい解答を送信しない。
保存先IDは初回設定後に固定する。
送信待ちの記録が、設定変更によって別のNotionへ送られるのを防ぐためである。

## 検証と制約

合成画面と自動テストでは、保存順序、再送、分類、応答喪失からの回復を検証する。
iOS向けビルド、端末への署名と導入、App GroupとKeychainの共有、実際の解答とNotionの一致は、それぞれ別に確認する必要がある。
検証結果と残る範囲は [iPhone / iPad版の検証](../IOS_SAFARI_VALIDATION.md) を参照する。

画面を離れる前に保存処理が完了しなかった場合や、未対応の画面構造では記録できないことがある。
保存に失敗した状態は保存済みと表示せず、推測した履歴で補わない。

## 参照

- [Safari拡張の作成](https://developer.apple.com/documentation/safariservices/creating-a-safari-web-extension)
- [ネイティブメッセージとApp Group](https://developer.apple.com/documentation/safariservices/messaging-between-the-app-and-javascript-in-a-safari-web-extension)
- [iOSでの非永続背景処理](https://developer.apple.com/documentation/safariservices/optimizing-your-web-extension-for-safari)
- [Keychainの共有](https://developer.apple.com/documentation/security/sharing-access-to-keychain-items-among-a-collection-of-apps)
- [Notionの送信制限と再試行](https://developers.notion.com/reference/request-limits)
