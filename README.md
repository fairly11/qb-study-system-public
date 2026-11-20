# qb-study-system

QBオンラインで確定した解答を記録し、復習計画の計算と問題セット作成を支援するシステムです。
Chrome拡張、Macの収集サービス、iPhone / iPadのSafari拡張、Windows記録専用版を含みます。

このリポジトリは公開用に整理したソースコードです。
個人の学習履歴、接続設定、認証情報、端末の署名情報、過去の個人向け運用記録やGit履歴は含めません。
導入済みアプリや設定済みのサービスは含まれず、利用する端末と保存先に合わせた設定が必要です。

## 記録と復習の流れ

- Chrome拡張は、実際の解答確定を観測し、問題番号、正誤、選択記号、日時などを収集サービスへ渡します。収集サービスは端末内のSQLiteへ保存し、設定されていればNotionへ同期します。
- iPhone / iPad版は、Safari拡張内へ保存してから同じ端末の管理アプリと共有するSQLiteへ転送し、Notionへ同期します。記録と同期にMacの常時起動は必要ありません。
- Windows記録専用版は、Chrome拡張、端末内保存、既存Notionへの同期を提供します。復習計算と問題セットの公開は、指定したMacで行う構成です。
- 復習処理は、保存された解答履歴から候補を計算し、日次計画を固定します。QB上の問題セット作成は、画面での操作と登録後の照合を組み合わせます。

端末内への保存とNotionへの同期完了は別の状態です。
同期後に同じ記録を読み戻して一致を確認するまで、送信待ちを保持します。
Notion同期を設定しない収集サービスは、ローカル保存のみで動作します。

復習候補は現在、第116回から第120回までの国試問題を対象に、最大100問を選びます。
同じ優先分類内では第120回の忘却リスクに1.25倍の重みを付けます。
対象範囲は固定であり、年に応じて自動では変わりません。
記録対象の問題番号をこの復習範囲に制限するものではありません。

## 主なフォルダ

| フォルダ | 役割 |
|---|---|
| `apps/browser-extension` | Chromeでの解答取得と送信待ち管理 |
| `services/history-collector` | 端末内保存、Notion同期、日次復習の実行 |
| `apps/ios-safari` | iPhone / iPad共通のSafari拡張と管理アプリ |
| `apps/windows-recorder` | Windowsでの記録と既存Notionへの同期 |
| `apps/windows-friend` | 復習計算も含む従来のWindows配布構成。記録専用版とは別構成 |
| `apps/set-builder` | 問題セット作成用の計画と照合処理 |
| `packages/contracts` | コンポーネント間で共有するデータ形式 |
| `packages/storage` | SQLiteへの保存と移行処理 |
| `packages/review-engine` | 記憶状態と復習候補の計算 |
| `packages/question-normalizer` | 国試問題番号の正規化 |
| `tests/fixtures` | 問題本文を含まない合成テストデータ |

## 開発環境の準備と検証

Node.js 24.19.0、pnpm 11.19.0を使用します。
リポジトリ直下で次を実行してください。
依存する開発用ライブラリを取得し、コード生成と自動検査を行います。
QBや本番Notionへの試験データ送信は行いません。

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm lint
pnpm typecheck
pnpm verify
```

新しい作業フォルダでは、他のパッケージが使う型定義を生成するため、最初に `pnpm build` を実行します。
`pnpm verify` は、lint、typecheck、test、buildをまとめて実行します。

iPhone / iPad版の追加検査には、macOSとAppleの開発ツールを使用します。

```sh
pnpm test:ios-native
sh apps/ios-safari/scripts/check-ios-build.sh
```

Windows記録専用版の生成と配布用テストは、次を使用します。

```sh
pnpm build:windows-recorder
pnpm test:windows-recorder
```

ビルドや自動テストの成功は、各端末への導入、実際のQB画面での取得、本番Notionへの同期の確認とは区別します。
Windows上のアクセス権検査とiPhone / iPadの署名、Safari権限、バックグラウンド動作は、それぞれの実環境で確認が必要です。

## データの扱い

- QBの問題文、選択肢本文、解説、画像を取得・保存・ログ出力しません。選択した記号と選択肢本文は区別します。
- 認証情報をコード、設定例、テストデータ、ログへ含めません。
- QBの非公開APIは使用せず、画面上の解答操作を観測します。
- 取得できなかった解答や不確かな分類を、推測で作りません。
- 元の解答記録は追記して保存し、復習計算から書き換えません。
- 各利用者の接続先と秘密の接続キーは、公開ファイルへ追加しないでください。

## 導入手順と設計文書

- [Chrome拡張](apps/browser-extension/README.md)
- [収集サービス](services/history-collector/README.md)
- [Notion同期](docs/NOTION_SYNC.md)
- [日次復習の実行手順](docs/DAILY_REVIEW_OPERATIONS.md)
- [iPhone / iPad版の導入](docs/IOS_SAFARI.md)
- [iPhone / iPad版の検証範囲](docs/IOS_SAFARI_VALIDATION.md)
- [Windows記録専用版](apps/windows-recorder/README.md)
- [開発手順](docs/DEVELOPMENT.md)
- [製品仕様](docs/PRODUCT_SPEC.md)
- [設計判断の記録](docs/ADR/README.md)

公開前の検証結果と除外したデータは [公開ソースの範囲と検証](docs/PUBLICATION.md) に記載しています。
