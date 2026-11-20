# QB study system 信頼ユーザー向けmacOSベータ

Version: `__VERSION__`

Source commit: `__GIT_COMMIT__`

このZIPは、Chrome Web Storeを使わず、内容と送信元を確認できる信頼ユーザーが
macOS上で利用するためのベータ配布物です。Chrome拡張機能とローカルcollectorを
含みます。問題への解答、画面遷移、評価、ノート、ブックマーク、問題セットを
自動操作しません。

## 必要環境

- macOS
- Google Chrome 127以上
- Node.js 24.19.0以上、25未満
- 利用者自身が正当にアクセスできるQBアカウント

Chrome Web Store版ではないため、自動更新はありません。信頼できる送信元から
受け取ったZIPだけを使用し、同時配布されたZIPのSHA-256と、展開後の
`CHECKSUMS.sha256`を確認してください。

ZIPと同名の`.zip.sha256`を同じdirectoryへ置き、そのdirectoryで次を実行します。

```sh
shasum -a 256 -c qb-study-system-trusted-macos-v__VERSION__.zip.sha256
```

## 1. 展開場所

ZIPを展開し、フォルダ全体を今後も変更しない場所へ置きます。特に
`browser-extension`フォルダを読み込み後に移動しないでください。unpacked拡張は
フォルダの場所が変わると別の拡張として扱われ、既存Outboxへアクセスできなく
なる場合があります。

展開したフォルダをTerminalのcurrent directoryにして、内部ファイルも確認します。

```sh
shasum -a 256 -c CHECKSUMS.sha256
```

## 2. Chrome拡張機能の読み込み

1. Chromeで `chrome://extensions` を開きます。
2. 右上の「デベロッパー モード」を有効にします。
3. 「パッケージ化されていない拡張機能を読み込む」を押します。
4. この配布物内の `browser-extension` フォルダを選択します。
5. 拡張機能メニューから `QB capture status` をツールバーへ固定します。

Chromeはunpacked拡張へ自動更新を提供しません。更新方法は後述します。

## 3. collectorの起動

Finderで `start-collector.command` をダブルクリックします。macOSが初回実行を
確認した場合は、ファイルの送信元とchecksumを確認したうえで、Terminalから次を
実行できます。

```sh
zsh ./start-collector.command
```

次の1行が表示されれば起動済みです。

```json
{"component":"history-collector","event_code":"COLLECTOR_LISTENING","port":8765}
```

collectorを利用している間はTerminalを開いたままにします。停止はTerminalで
`Control-C`を押します。停止中も未送信イベントはChromeのローカルOutboxに残り、
次回起動後に再送できます。

SQLiteは既定で次へ保存されます。

```text
~/Library/Application Support/qb-study-system/qb-study.sqlite
```

## 4. 記録

1. collectorを起動します（ログイン時の自動起動を設定済みなら操作不要です）。
2. ChromeでQBの問題セットを開き、演習を始めます。
3. 問題画面で記録が自動開始します。目的の選択は不要です。
4. 確認済みの復習セットは「復習課題」、それ以外は原則「通常学習」です。セット照合の通信失敗や不正なセットIDでは「判定未確認」を表示します。拡張の「通常学習」「復習課題」ボタンで、現在の演習の区分を選べます。選択後の解答に適用し、保存済みの記録は変更しません。
5. 一時停止と再開はツールバーから拡張の画面を開いて行います。
6. Outboxが `0` なら同じMacのcollectorへの保存確認済みです。Notionへの保存完了とは区別します。

DOMが確認済み構造と一致しない場合は `Capture: unsupported` となり、推測した
イベントを保存しません。

## 更新

1. popupでOutboxが `0` であることを確認します。
2. collectorを `Control-C` で停止します。
3. 現在Chromeへ読み込ませている**同じ** `browser-extension` フォルダの中身を、
   新しい配布物の `browser-extension` の中身で置き換えます。
4. `chrome://extensions` の対象拡張で「再読み込み」を押します。
5. 新しい `start-collector.command` と `collector` フォルダを使用します。

フォルダ自体を別の場所へ移したり、新しい場所から別拡張として読み込んだり
しないでください。更新前にOutboxが残っている場合は、先に旧collectorで送信を
完了してください。

## 削除

1. collectorを停止します。
2. `chrome://extensions` から拡張機能を削除します。
3. この配布フォルダを削除します。

Chrome内のOutboxも不要であることを確認してから拡張機能を削除してください。
SQLite履歴まで消したい場合だけ、上記保存先のDBを別途削除します。DB削除は
元に戻せないため、必要なら先にバックアップしてください。

## 既知の制限

- collectorは自動起動しません。
- unpacked拡張は自動更新されません。
- QBのDOM変更や未確認の問題形式はfail closedでUnsupportedになります。
- loopback collectorは認証を持たず、同じ端末上の別processによるport先取りや
  ACK偽装を防ぎません。個人管理下または信頼できる端末だけで使用してください。

詳細は `SECURITY_AND_PRIVACY.ja.md` を参照してください。
