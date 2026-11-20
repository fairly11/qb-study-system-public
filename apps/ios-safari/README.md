# iPhone / iPad用QB記録

SafariでQBを解いたときの記録を端末内に保存し、Notionへ同期するアプリと拡張です。
iOS / iPadOS 16.4以上をビルド対象とし、iPhoneとiPadで同じ保存・同期処理を使用します。
Macの起動や同じWi-Fiへの接続には依存しません。

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
QBの画面構造が対応する形式と一致しない場合は取得を停止します。
