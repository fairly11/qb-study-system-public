QB Record for Windows 0.1.1-preview
Windows 11 + Google Chrome（ARM64 / x64）

Windowsで解いたQBの記録を、MacやiPhoneと共通のNotionへ送ります。
復習候補の計算とセット作成はMacで行います。
復習候補の対象範囲にかかわらず、対応する問題番号の解答を記録します。

【はじめ方】
1. 配布ZIPをWindowsへ移します。connection-targets.json がある場合は、一緒に移すと接続先の入力に使えます。
2. ZIPを右クリックし「すべて展開」を選びます。
3. 展開先の docs\manual.html を開きます。
4. install.cmd を通常ユーザーとしてダブルクリックします。
5. start.cmd を開き、操作画面でNotionへ接続します。
6. 接続と記録サービスの起動を確認してから、Chromeに拡張を読み込みます。

設置先：%LOCALAPPDATA%\QBRecordWindows
初期設定には、既存の解答ログ、問題マスター、復習計画ページと、それらへアクセスできるNotion接続キーが必要です。
接続キーは操作画面へ入力し、チャットやメールでは送らないでください。
復習計画は、解答の学習区分を判定するために読み取ります。

【最初の記録を確認する】
普段の学習で1〜2問解き、PCとNotionの両方に同じ記録があることを確認します。
Windows実機での導入と動作は未検証です。検証の範囲は RELEASE.json と docs\Validation-ja.txt を参照してください。

【起動と停止】
start.cmd：起動します。
stop.cmd：終了を要求します。記録サービスのウィンドウが閉じたことも確認してください。
autostart-on.cmd：YESを入力すると、Windowsへのログイン時に自動起動します。
autostart-off.cmd：ログイン時の自動起動を解除します。
自動起動は初期状態で無効です。

【更新と取り外し】
既存の設置先がある場合、install.cmd は上書きせず停止します。
取り外すときは記録サービスを停止し、自動起動を解除します。
dataには送信待ちと履歴が残るため、Notionへの同期を確認するまで保管してください。
設定後の設置フォルダーには接続キーが含まれます。他人へ渡すときは元の配布ZIPを使ってください。
