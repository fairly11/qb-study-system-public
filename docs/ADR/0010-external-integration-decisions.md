# ADR-0010: 外部連携の設計課題

- 状態: 一部解決。未実装の連携は下表を参照
- 起案日: 2026-08-24

## 背景

初期設計では、QBの画面から取得できる情報、必要な権限、同期と問題セット作成の方法が未確定だった。
外部機能ごとにデータ形式と失敗時の扱いを決めてから実装する方針を採った。

## 各課題の決定先

| 課題 | 決定・状態 |
|---|---|
| QBの画面取得、Chromeの権限、選択番号の対応 | [ADR-0012](0012-browser-extension-qb-capture-consent.md)、[ADR-0017](0017-automatic-qb-capture.md) |
| ローカル収集サービスへの送信 | [ADR-0013](0013-local-loopback-history-collector.md) |
| 複数端末の記録共有 | Notionを使用。[ADR-0014](0014-notion-shared-original.md) |
| 記憶モデル、復習間隔、候補の優先順位 | [ADR-0015](0015-daily-review-model-and-selector.md) |
| QB問題セット作成と保存後の照合 | [ADR-0016](0016-daily-review-publication.md) |
| iPhone / iPadからの記録 | [ADR-0019](0019-ios-safari-recording.md) |
| Google Sheetsの列、認証、同期頻度、再試行、部分失敗 | 未決・未実装 |

## 初期方針との関係

初期の拡張機能を無権限とする方針は、ADR-0012で必要な権限を定義した時点で置き換えた。
その後の外部機能は上表のADRに従う。
