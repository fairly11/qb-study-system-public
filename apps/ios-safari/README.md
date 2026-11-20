# iPhone / iPad用QB記録

Safari Web Extension、設定用iOSアプリ、SQLite保存とNotion同期のSwiftライブラリです。
iOS / iPadOS 16.4以上をビルド対象とし、iPhoneとiPadで同じ保存・同期処理を使用します。
Macの起動や同じWi-Fiへの接続には依存しません。

公開ソースには個人の署名設定、Notion接続キー、保存先ID、学習履歴を含めません。
利用者の端末への導入と、実環境での記録・同期は別途確認が必要です。

導入は [導入手順](../../docs/IOS_SAFARI.md)、検査の範囲は [検証手順](../../docs/IOS_SAFARI_VALIDATION.md) を参照してください。
プロジェクト直下の `pnpm build` で拡張ファイルを生成してから、Xcodeで `ios/QBRecord.xcodeproj` を開きます。

| 場所 | 役割 |
|---|---|
| `src/` | QB画面での解答取得、拡張内保存、管理アプリへの転送 |
| `native/` | 端末保存、Notion照合、復習セット確認、自動テスト |
| `ios/App/` | 保存状態とNotion接続設定を表示するアプリ |
| `ios/Shared/` | App Group、Keychain、受信処理 |
| `ios/Extension/` | Safariと管理アプリの処理を接続する部分 |
| `ios/Config/` | 署名と識別子の設定例。接続キーは保存しない |

Chrome版の画面解析処理を再利用します。
自動テストの合成画面には、QBの問題文や選択肢本文を含めません。
実際のQB画面が変わった場合の取得可否は、その画面で確認する必要があります。
