# jscpd clone baseline (2026-09-16)

This is the initial report-only baseline for 110 Task 3. It is informational: no duplication threshold is configured, and the `report:clones` script is not a quality gate.

> **2026-09-25 note**: this script was renamed from `check:clones` to `report:clones`. The old name
> implied a gate that could fail, but `jscpd.json` sets `exitCode: 0` so it never could. The rename
> makes the report-only nature explicit. The script also had a stale `voice-gateway/src` scan path
> (Voice moved to the `vendor/pi-koe` submodule) which made `jscpd` exit non-zero with
> `path does not exist`; that path was removed.

## Tool and invocation

- jscpd version: `5.2.1` (root devDependency).
- Command: `pnpm report:clones` (`jscpd --config jscpd.json`).
- Configuration: `jscpd.json`; `minTokens: 50`, `minLines: 5`, `blame: false`, `exitCode: 0`.
- Report scope: `host/src`, `dialogue-web/src`, `packages`, and root `tools` modules filtered to JavaScript/TypeScript. `tools/lib/**` is ignored because the requested `tools/*.mjs` scope is root-level only. (The former `voice-gateway/src` entry was removed on 2026-09-25 — Voice is now the `vendor/pi-koe` submodule and no longer has an in-repo `src`.)
- Ignored paths include `vendor`, `ref`, `tmp`, `.worktrees`, `dist*`, test files, `node_modules`, `.commit-validation`, and `tools/lib`.

## Baseline totals

| Format | Files | Lines | Tokens | Clones | Duplicated lines | Duplicated tokens |
|---|---:|---:|---:|---:|---:|---:|
| javascript | 156 | 32676 | 232768 | 299 | 3363 (10.29%) | 23936 (10.28%) |
| typescript | 217 | 74422 | 463056 | 337 | 4609 (6.19%) | 32570 (7.03%) |
| **Total** | **373** | **107098** | **695824** | **636** | **7972 (7.44%)** | **56506 (8.12%)** |

## Purpose

Informational trend baseline for future drift comparison; not a gate.