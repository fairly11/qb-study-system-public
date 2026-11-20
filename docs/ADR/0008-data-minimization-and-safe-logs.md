# ADR-0008: データ最小化と安全なログ

- Status: Accepted
- Date: 2026-08-24

## Context

目的に不要なQBコンテンツや認証情報を保存すると、権利・秘密・個人情報上のリスクが増えます。自由形式ログは意図せず本文やtokenを取り込みます。

## Decision

問題文、選択肢本文、解説、画像、認証情報を取得・保存・ログ出力しません。system logはseverity、component、event code、時刻、安全なID、数値counterのallowlistに限定し、自由形式payloadを設けません。

永続化される `producer`、`producer_version`、`source_system`、任意の `source_record_id`、`question_group_id`、algorithm ID/versionは長さを制限し、`^[A-Za-z0-9][A-Za-z0-9@._:/+%#=~-]*$` に一致するsafe tokenだけを受け付けます。これらのidentifier fieldへ自由文やQBコンテンツを迂回保存できないようにします。利用者向けの `set_name` は意図的に自由文を許可する例外ですが、QBコンテンツや認証情報の保存禁止は引き続き適用します。実サイト操作と非公開API解析を初期版の対象外とします。

## Consequences

デバッグは安定したerror codeとcorrelation ID中心になります。必要な情報がallowlistにない場合は、安全性をレビューしてschemaとADRを変更する必要があります。
