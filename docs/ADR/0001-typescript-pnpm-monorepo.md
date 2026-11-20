# ADR-0001: TypeScript pnpm monorepo

- Status: Accepted
- Date: 2026-08-24

## Context

4コンポーネントを独立して開発・実行しながら、型、schema、storage、test基盤を共有する必要があります。

## Decision

Node.js 24.19.0、pnpm 11.19.0、ESM、TypeScript strict、project referencesを使用します。workspaceは `apps/*`、`services/*`、`packages/*` とし、内部依存は `workspace:*` に限定します。

## Consequences

各packageをfilterして検証でき、worktreeで並行開発できます。循環依存を禁止し、root lockfileと共通compiler/lint/test設定を維持する必要があります。
