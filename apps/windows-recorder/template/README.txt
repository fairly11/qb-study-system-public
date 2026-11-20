QB記録 Windows版 0.1.1-preview
Windows 11 + Google Chrome（ARM64 / x64）

Windowsで解いた記録を、今までのNotionへ追加するアプリです。
復習課題の計算と作成は、これまでのMacで続けます。
第116〜120回の限定や第120回の優先は、解答記録には適用しません。

【はじめ方】
1. このZIPと別添 connection-targets.json をWindowsへ移します。
2. ZIPを右クリックし「すべて展開」を選びます。
3. 展開先の docs\manual.html を開きます。
4. install.cmd を通常ユーザーとしてダブルクリックします。
5. start.cmd を開き、操作画面で既存Notionへ接続します。
6. 接続と記録サービス起動を確認してから、Chromeに拡張を読み込みます。

設置先：%LOCALAPPDATA%\QBRecordWindows
接続キーはWindowsの本人用領域に保存します。配布ZIPには含めません。
チャットへ接続キーを貼り付ける必要はありません。
このアプリは新しいNotionデータベースを作りません。
既存の復習セットを「復習」と分類するため、公開済みの計画情報は読み取ります。

【検証の範囲】
検証結果は RELEASE.json と docs\Validation-ja.txt を参照してください。
Windows実機の導入、アクセス権、実際のQB解答、Notion到達は未検証です。
導入後の実記録がPCとNotionの両方に届くまで、導入完了とは扱いません。

【起動と停止】
start.cmd で起動、stop.cmd で終了を要求します。画面でも終了を確認してください。
ログイン時の自動起動は初期状態で無効です。
autostart-on.cmd でYESを入力すると有効、autostart-off.cmd で解除できます。
Mac側の定期実行は変更しません。

【保存済みデータを守る】
既存の設置先がある場合、install.cmd は上書きせず停止します。
取り外すときは停止と自動起動解除を先に行い、dataは送信待ちと履歴の控えとして保管してください。
設定後の設置フォルダを他人へ渡さないでください。
