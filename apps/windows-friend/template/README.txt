QB Study Friend 1.1.0-preview
Windows 11 + Google Chrome / 2026年10月29日

最初に docs\manual.html を開いてください。
Claudeを使う場合は docs\Claude-guide.html へ進みます。

【はじめ方】
1. ZIPを右クリックして「すべて展開」。
2. install.cmd を通常ユーザーとしてダブルクリック（管理者として実行しない）。
3. start.cmd をダブルクリック。記録用の黒いウィンドウは開いたままにします。
4. Chromeの chrome://extensions で、%LOCALAPPDATA%\QBStudyFriend\browser-extension を読み込みます。
5. 解答前に、手順に沿って自分のNotionに専用ページと保存先を作ります。
6. 普段の学習で1〜2問解き、PCとNotionに同じ記録があることを確認します。

【Claudeへ渡すもの】
docs\CLAUDE_SETUP_PROMPT.txt：初回導入の依頼文。
docs\CLAUDE_DAILY_PROMPT.txt：日々の候補計算・QBセット作成・完成確認の依頼文。
内容を本人が読んでから、自分のClaudeへ貼り付けてください。
有料Claude DesktopとClaude in Chromeを接続して使います。
端末のファイル・Chromeを使う間は、PC、Claude Desktop、Chrome、記録サービスが動いている必要があります。
このZIPだけでClaudeの接続や毎朝の予約は登録されません。
任意のreview.cmd経路も同梱しています。start.cmdで起動後に利用し、秘密の接続キーをClaudeへ渡さず状態確認・候補計算・登録を行えます。
引数とJSONの形式は docs\Claude-guide.html にあります。

【この版でできること】
Chromeでの解答記録、自分のNotionへの保存、WindowsとiPhoneの同期済み記録からの復習候補計算。
日次計画は日本時間04:00区切り。翌04:00より前に復習期限を迎える問題を最大100問選び、同じ日の候補は固定します。
Claudeが同梱計算プログラムとQBの公開画面を操作する手順を含みます。

【配布範囲と検証状況】
iPhoneアプリはこのZIPに含まれず、別途導入が必要です。
Windows実機・受領者本人のQB/Notionでの動作確認は未実施です。
開発環境の検証結果と実機検証は別です。docs\Validation-ja.txt の検証記録を参照してください。

【自分の履歴と接続キーを守る】
配布するのは元のZIPだけです。設定後の設置フォルダーやdataを他人へ渡さないでください。
Notion接続キーは本人が操作画面に入力します。Claudeや配布者に送る必要はありません。
QBの問題文、選択肢本文、解説、画像は取り扱いません。
既にQBStudyFriendを導入済みの場合、install.cmdは上書きせず停止します。
既存の設置フォルダーやdataを削除せず、更新手順を確認してください。

停止：stop.cmd（停止要求後、黒いウィンドウの終了と操作画面の停止・未接続まで確認）
ログイン時の自動起動：autostart-on.cmd（本人がYESと入力した場合だけ有効化）
自動起動の解除：autostart-off.cmd
※ログイン時の自動起動は、毎朝のQBセット作成とは別の機能です。
