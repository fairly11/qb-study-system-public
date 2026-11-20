# ADR-0003: バージョン付きJSON契約

- Status: Accepted
- Date: 2026-08-24

## Context

別々に開発されるコンポーネント間で、TypeScriptのcompile時だけでなく実行時にも入力を検証する必要があります。

## Decision

TypeBoxを型とschemaの正本とし、JSON Schema Draft 2020-12を生成・commitします。全recordは `schema_version` と固定 `record_type` を持ち、wire fieldはsnake_case、原則 `additionalProperties: false` とします。Ajv strict modeで検証します。

## Consequences

schemaの生成差分を検出できます。V1公開後の破壊的変更は既存schemaを編集せずV2追加とし、移行方針が必要です。
