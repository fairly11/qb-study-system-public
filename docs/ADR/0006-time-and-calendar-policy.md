# ADR-0006: UTC瞬間とAsia/Tokyo暦日

- Status: Accepted
- Date: 2026-08-24

## Context

演習時刻と復習対象日は性質が異なり、offsetなし日時やdate-onlyの午前0時化は曖昧さを生みます。

## Decision

exactな瞬間はoffset必須のISO 8601として入力し、保存時にUTC `Z` へ正規化します。numeric offsetは `-14:00` から `+14:00` までとし、絶対値が14時間の場合は分を `00` に限定します。yearは4桁の `0000`〜`9999` をproleptic Gregorian calendarとして扱い、UTC正規化後も同じ4桁year範囲に収まる入力だけを受け付けます。canonical storage precisionはJavaScriptが正確に扱えるミリ秒とし、入力の小数秒は省略または1〜3桁だけを許可します。範囲外へ正規化される値や4桁以上の小数秒は黙って切り捨てたり丸めたりせず、schema validatorとnormalizerの両方で拒否します。正規化後は常に3桁のミリ秒を含むUTC形式です。日だけ分かる値も4桁yearのproleptic Gregorian `YYYY-MM-DD` として `Asia/Tokyo` のまま保持します。利用者の標準タイムゾーンを `Asia/Tokyo` とします。

JSONとJavaScript間の数値精度も同じくfail closedで扱います。すべての整数counter、index、count、positionは下限に加えて `Number.MAX_SAFE_INTEGER`（`9007199254740991`）を上限とし、超過値を丸めずに拒否します。

## Consequences

UTC 15:00の日付境界、最大offset、西暦0000〜0099、正規化後のyear範囲、小数秒1〜3桁の正規化、範囲外offsetと4桁以上の小数秒の拒否、すべての整数schemaの安全上限を明示的にテストします。受理したcanonical timestampは同じ契約へ再入力できなければなりません。UTC変換を伴うyear境界はJSON Schemaのpatternだけでは判定せず、共通contract packageのformat validatorを利用します。date-onlyから架空のinstantを生成せず、instantとlocal dateを別fieldで扱う必要があります。
