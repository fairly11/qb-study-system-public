# Windows記録専用版

最新Chrome拡張、PC内への耐久保存、既存Notion同期、公開済み復習セットの読取り照合を配布します。
復習計算と公開は既存Macが担当します。
Windows側には計算プログラム、発行用の設定、新しいNotionデータベースを作る処理を含めません。

## 開発環境の検証

1. `pnpm install --frozen-lockfile`
2. `pnpm build`
3. `pnpm lint`
4. `pnpm typecheck`
5. `pnpm test`
6. `pnpm build:windows-recorder`
7. `pnpm test:windows-recorder`

配布用テストは別ポートと一時フォルダを使い、Notionを模擬応答に置き換えます。
本番QBやNotionに試験用の解答を送信しません。
PowerShell検査は `test/check-powershell.ps1` です。
Mac上の構文検査とWindows実機のアクセス権検査は区別します。
Windows PowerShell 5.1の通常ユーザーで `test/check-windows-acl.ps1 -PackageRoot <展開先>` を実行すると、アクセス権の初回設定と再設定、作成後のファイルの保護、不要な読取り許可の拒否を一時フォルダで検査します。
0.1.1-previewでは、保護済みフォルダへの再設定で監査用の管理権限を要求していた処理を修正しました。
本人、SYSTEM、Administratorsだけにアクセスを許す条件は維持します。

## 配布

`scripts/package.py` は検証結果、配布内ファイル、秘密の混入、内容一致を検査してZIPを作ります。
`connection-targets.json` は本人の3つの公開接続先IDだけを持つ別ファイルです。
秘密の接続キーと学習履歴を配布ZIPに含めません。
Windows実機の導入とNotion到達は別途確認が必要です。
