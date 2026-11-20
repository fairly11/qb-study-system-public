# iPhone / iPad版の検証手順と確認範囲

公開ソースの検査と、利用者の実機および本番サービスでの確認を区別します。
この文書には個人の端末名、署名情報、接続先、学習履歴、過去の運用証跡を含めません。
公開前の検査では、全体の764テスト、Swiftの54テスト、署名なしのiOS Simulator向けビルドが成功しています。
実行環境と検証の範囲は [公開前の検証結果](PUBLICATION.md) を参照してください。
以下は同じ検査を再実行する手順です。

## ソースコードの検査

リポジトリ直下で実行します。
依存ライブラリの取得とビルド出力の生成を行いますが、QBや本番Notionへ試験データを送信しません。

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm verify
pnpm test:ios-native
```

| 検査 | 確認する範囲 |
|---|---|
| `pnpm build` | 共有データ形式の整合、TypeScriptの変換、ChromeとSafari拡張の生成 |
| `pnpm verify` | コード規則、型の整合、自動テスト、ビルド |
| `pnpm test:ios-native` | macOS上のSwiftによる保存、Notion同期、復習照合のテスト |

新しい作業フォルダでは、`pnpm verify` より先に `pnpm build` を実行します。
他のパッケージが参照する生成済みの型定義が必要なためです。

自動テストでは、問題本文を含まない合成画面、架空のイベント、模擬Notion応答、一時的な保存先を使います。
主な対象は、実解答と再表示の区別、保存確認前の送信待ち保持、同じIDでの再送、応答不明時の照合、学習区分の判定です。

## iOS向けのビルド検査

XcodeとiOS Simulator向けの開発部品が利用できるMacで実行します。

```sh
sh apps/ios-safari/scripts/check-ios-build.sh
```

成功時は `BUILD SUCCEEDED` と表示されます。
署名なしでシミュレータ向けにビルドする検査であり、端末へインストールしたり、アプリを配布したりしません。

| 停止コード | 確認すること |
|---|---|
| `IOS_BUILD_UNAVAILABLE` | Xcode本体と開発ツールの選択先 |
| `XCODE_LICENSE_REQUIRED` | Xcodeでの規約確認 |
| `XCODE_FIRST_LAUNCH_REQUIRED` | Xcodeの初回準備 |
| `IOS_SIMULATOR_SDK_MISSING` | iOS Simulator向けの開発部品 |
| `WEB_BUILD_MISSING` | 先に `pnpm build` を実行したか |
| `XCODE_PREFLIGHT_FAILED` | ライセンス状態の確認自体が失敗した理由 |

この検査は規約への自動同意を行いません。
SwiftのmacOSテスト成功は、iOSアプリ全体のビルド成功とは別に確認します。

## 実環境で別途確認する範囲

- iPhoneとiPadそれぞれの署名、導入、起動。
- Safari拡張の権限と実際のQB画面での取得。
- App Groupによる保存領域の共有とKeychainへのアクセス。
- 本番Notionの列構造、接続権限、送信後の独立した読み戻し。
- 通信切断、端末ロック、強制終了、長時間のバックグラウンドからの復帰。
- iPadの回転、狭いウィンドウ、キーボード表示での操作。
- 既存アプリの更新時の記録、接続設定、送信待ちの保持。

これらは、ソースの自動検査やシミュレータ向けビルドの成功だけでは確認済みになりません。
確認は [導入手順](IOS_SAFARI.md) に沿って行い、実施した環境と確認できた範囲を区別して記録してください。
