QB Study Friend 1.1.0-preview
Windows 11 + Google Chrome

QBの解答を記録し、Notionに集めた履歴から毎日の復習候補を選ぶアプリです。
最初に docs\manual.html を開いてください。
Claudeに導入や復習セット作成を任せる場合は docs\Claude-guide.html を参照してください。

【はじめ方】
1. ZIPを右クリックして「すべて展開」を選びます。
2. install.cmd を通常ユーザーとしてダブルクリックします。管理者として実行しないでください。
3. start.cmd をダブルクリックします。記録サービスのウィンドウは開いたままにします。
4. Chromeの chrome://extensions から %LOCALAPPDATA%\QBStudyFriend\browser-extension を読み込みます。
5. 解答前に、手順に沿ってNotionの専用ページと保存先を作ります。
6. 普段の学習で1〜2問解き、PCとNotionに同じ記録があることを確認します。

【毎日の復習】
WindowsとiPhoneから同じNotionへ同期した解答を使って、復習候補を計算します。
日本時間の午前4時を1日の区切りとし、翌朝4時より前に復習期限を迎える問題を最大100問選びます。
同じ日の候補は固定されます。QB上のセット作成と照合は、manual.html の手順に従って行ってください。

【Claudeに操作を任せる】
docs\CLAUDE_SETUP_PROMPT.txt：初回導入の依頼文。
docs\CLAUDE_DAILY_PROMPT.txt：候補計算、QBセット作成、完成確認の依頼文。
内容を確認してからClaudeへ貼り付けてください。
WindowsのファイルとChromeを操作できる接続が必要です。利用条件は docs\Claude-guide.html を参照してください。
コマンドを使う場合は、start.cmd で起動後、review.cmd から状態確認、候補計算、登録を行えます。

【起動と停止】
stop.cmd：終了を要求します。記録サービスのウィンドウが閉じ、操作画面が停止または未接続になったことを確認してください。
autostart-on.cmd：YESを入力すると、Windowsへのログイン時に自動起動します。
autostart-off.cmd：ログイン時の自動起動を解除します。
ログイン時の自動起動と、復習セットを作る定期実行は別の設定です。

【更新とデータの保管】
既存の設置先がある場合、install.cmd は上書きせず停止します。
更新のために設置フォルダーや data を削除しないでください。
設定後のフォルダーには接続キーと履歴が含まれます。他人へ渡すときは元の配布ZIPを使ってください。
Notion接続キーは操作画面へ入力し、Claudeやメールでは送らないでください。

iPhone / iPadで記録するにはSafari拡張を別途導入します。
Windows実機とClaudeからの操作は未検証です。検証の範囲は docs\Validation-ja.txt を参照してください。
