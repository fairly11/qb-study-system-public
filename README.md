# qb-study-system

QBオンラインの解答を自動で記録し、解いた履歴から「今日復習する問題」を選ぶ学習支援プログラムです。
記録の転記や復習問題を選ぶ手間を減らし、間違えた問題や忘れかけた問題に取り組めるように設計しています。

PC・iPhone・iPadで解いた履歴をNotionにまとめ、正誤と解いた間隔から復習の優先順位を計算します。
選ばれた問題は、QBの復習用セットに登録して解き直せます。

## できること

- **解答の自動記録**：問題番号、解答日時、正誤、選んだ記号を記録します。同じ問題を解き直した場合も、別の解答として残します。
- **端末をまたいだ履歴の共有**：Mac・WindowsのChrome、iPhone・iPadのSafariからNotionへ同期します。通信できない間は端末に保存し、接続が戻ってから送信します。
- **復習候補の選定**：間隔反復モデルで次の復習時期を推定し、手動で指定した復習日や直近の不正解も考慮して、1日最大100問を選びます。
- **復習の進捗確認**：通常学習と復習を分けて記録し、計画した問題のうち何問を解いたか確認できます。

QBの問題文、選択肢本文、解説、画像は保存しません。
問題を読むことと解答することは、これまでどおりQB上で行います。

## 使う端末と役割

| 端末 | 記録方法 | 復習計画 |
|---|---|---|
| Mac | Chrome拡張とローカルの収集サービス | 履歴の集計、候補の計算、問題セット登録の照合を担当 |
| Windows | Chrome拡張とWindows記録専用アプリ | Notionへ送信し、Mac側の計画に反映 |
| iPhone / iPad | Safari拡張と「QB記録」アプリ | Notionへ直接送信し、Mac側の計画に反映 |

iPhone・iPadでの記録と同期に、Macの常時起動は必要ありません。

## 導入について

利用する端末に拡張機能と保存用プログラムを導入し、複数端末で使う場合は同じNotionの保存先を設定します。
iPhone・iPad版はXcodeでビルドし、端末への署名とSafari拡張の有効化が必要です。

- Mac：[Chrome拡張](apps/browser-extension/README.md) → [収集サービス](services/history-collector/README.md) → [Notion同期](docs/NOTION_SYNC.md)
- Windows：[Windows記録専用版](apps/windows-recorder/README.md)
- iPhone / iPad：[Safari版の導入手順](docs/IOS_SAFARI.md)
- 復習計画：[日次復習の実行手順](docs/DAILY_REVIEW_OPERATIONS.md)

QBの問題セットへの登録は、ブラウザでの操作と登録後の照合が必要です。

## 現在の復習ルールと制約

- 復習候補は第116回〜第120回の国試問題に限定しています。範囲は年に応じて自動更新されません。
- 同じ優先分類と分野の配分条件では、第120回の忘却リスクに1.25倍の重みを付けます。
- 作成済みの当日計画は固定し、その後の解答で候補を自動的に入れ替えません。
- 記録できる問題の範囲は、復習候補の範囲に制限されません。
- QBの画面構造が変わると取得できなくなる場合があります。取得できなかった解答を推測で補完しません。
- iOSがバックグラウンド処理を停止した場合、同期の再開にSafariや管理アプリを開く必要があります。

自動テストと実機確認の範囲は [検証状況](docs/VALIDATION.md) にまとめています。

## 開発

Node.js 24.19.0、pnpm 11.19.0を使用します。
リポジトリ直下で依存ライブラリを導入し、ビルドしてから検証します。

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm verify
```

`pnpm verify` はコード規則、型の整合、自動テスト、ビルドをまとめて確認します。
端末別のビルドとテストは [開発手順](docs/DEVELOPMENT.md) を参照してください。

| フォルダ | 役割 |
|---|---|
| `apps/browser-extension` | Chromeでの解答取得と送信待ち管理 |
| `services/history-collector` | PC内保存、Notion同期、日次復習の実行 |
| `apps/ios-safari` | Safari拡張とiPhone / iPadアプリ |
| `apps/windows-recorder` | Windowsでの記録と既存Notionへの同期 |
| `apps/windows-friend` | 復習計算も含む別構成のWindowsアプリ |
| `apps/set-builder` | 問題セットの登録順序と登録結果の照合 |
| `packages/contracts` | 共有するデータ形式と検証処理 |
| `packages/storage` | SQLiteへの保存とデータ構造の更新 |
| `packages/review-engine` | 記憶状態と復習候補の計算 |
| `packages/question-normalizer` | 国試問題番号の表記統一 |

設計を調べる場合は、[仕様](docs/PRODUCT_SPEC.md)、[構成とデータの流れ](docs/ARCHITECTURE.md)、[設計判断の記録](docs/ADR/README.md)を参照してください。
