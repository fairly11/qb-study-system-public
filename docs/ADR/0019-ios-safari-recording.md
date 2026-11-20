# ADR-0019: iPhoneのSafariで解答を記録する

Status: Accepted for implementation; device acceptance pending
Date: 2026-10-25

## 設計の範囲

iPhoneとiPadで動作するSafari拡張と端末内保存、Notion同期を実装する。
復習計算と日次問題セット作成は対応するMac側の処理を使用する。
Appleの登録、課金、規約同意、端末への導入、Notionの接続設定は利用環境ごとに行う。

## 保存と同期の境界

Safari内の取得処理は実際の解答操作と結果表示を組み合わせ、内容を含まないAttemptEventV1を作る。
解答操作を伴わない結果の再描画や再入場は新しい解答を作らない。
同じ問題への新しい解答操作は、新しいevent_idを持つ別の履歴になる。

最初に拡張専用の永続領域へ、event_idごとに独立した項目として保存する。
Safariの背景処理は、保存した項目をネイティブメッセージ（拡張からiPhone側プログラムへの連絡）で渡す。
iPhone側はApp Group（アプリと拡張だけが共有する保存領域）のSQLiteへ、解答と由来を一つの処理で保存してから応答する。
この応答を受けるまでSafariの送信待ちを削除しない。
同じevent_idの再送は内容を照合し、異なる内容なら停止する。

iPhone側のインストール識別子と演習セッション識別子を既存のprovenance.source_record_idへ記録する。
公開V1のフィールドは追加・変更しない。
Notionを端末共通の原本とし、端末内の記録は送信待ちと控えとして保持する。
端末内の解答、分類結果、同期の経過は追記専用にする。

Notionへの新規作成前には、作成予定をSQLiteへ確定保存する。
送信の成否が分からない場合、event_idまたは既知のページIDで読み戻す。
見つからないことだけを理由にもう一度作成しない。
問題マスターの新規作成にも同じ制約を適用する。
MacとiPhoneが同時に同じ問題マスターを作る場合、Notionに一意制約がないため競合は完全には防げない。重複や不一致は停止して表示する。

アプリと拡張の同期処理はOSのファイルロックで同時実行を防ぐ。
時刻だけで期限切れと判断するロックは使用しない。停止中の処理が復帰して別の処理と重なることを避けるためである。
アプリを閉じたままの常時送信は保証しない。Safari内だけに残る転送待ちはQBへの再入場か拡張の表示で再開する。
アプリ側に保存済みなら管理アプリの起動からもNotion送信を再開できる。

## 分類と既存Notionへの統合

確認済みの移動元セットIDを、既存Notionの日次計画データと公開済みリンクへ照合する。
完全な読み取りで非該当が確認できた場合だけ通常学習とし、確認済みシステムセットは復習とする。
長い照合では、確認済みのページID、タイトルのハッシュ、セットIDと計画ID、再開位置だけをSQLiteへ追記する。
任意のNotion本文は保存しない。期限切れや親ページの変更を確認し、完了していない一覧から非該当を推定しない。
照合中断時は由来がある解答の分類を未確定のまま保持し、次回に続ける。
由来が失われた場合、応答が不完全な場合、計画が矛盾する場合は未分類として保存する。
セット名、問題番号の一致、正答率から由来を推定しない。

V1のproducerは既存の `browser-extension` を維持し、producer_versionを `ios-0.1.0` とする。
Notionの「記録元」は「Safari拡張」とする。
Mac側の読み取り処理には、この組み合わせを受け入れる最小限の互換変更を用意する。
既存の本番Macへは自動配備しない。配備前の本番集計はSafari行を受け入れられないため、iPhoneの本番送信開始前に対応版の配備が必要になる。

## 秘密情報と通信

接続キーは共有App Groupに属するKeychainへ、端末限定の保護属性で保存する。
JavaScript、QBページ、応答、ログ、テスト、配布物にキーを渡さない。
通信先はネイティブ側の `https://api.notion.com/v1` に固定し、リダイレクトを追跡しない。
接続先の列構造を読み取り確認し、合わなければ新規記録を送らない。
保存先IDは初回設定後に固定し、送信待ちを別のNotionへ転送しない。

## 残る確認

合成DOM、自動テスト、SwiftのmacOSコンパイルでは、モバイルQBの表示構造とiPhone上のAPI動作を確認できない。
iOS SDKでのビルド、シミュレータ、署名、App GroupとKeychainの実機共有、実解答とNotionの一致は別々に確認する。
画面離脱の直前に保存処理自体が完了しない場合や、未対応のDOMでは記録を保証できない。
保存に失敗した状態を保存済みと表示せず、架空の履歴で穴埋めしない。

## 参照した公式仕様

- [Safari拡張の作成](https://developer.apple.com/documentation/safariservices/creating-a-safari-web-extension)
- [ネイティブメッセージとApp Group](https://developer.apple.com/documentation/safariservices/messaging-between-the-app-and-javascript-in-a-safari-web-extension)
- [iOSでの非永続背景処理](https://developer.apple.com/documentation/safariservices/optimizing-your-web-extension-for-safari)
- [Keychainの共有](https://developer.apple.com/documentation/security/sharing-access-to-keychain-items-among-a-collection-of-apps)
- [Notionの送信制限と再試行](https://developers.notion.com/reference/request-limits)
