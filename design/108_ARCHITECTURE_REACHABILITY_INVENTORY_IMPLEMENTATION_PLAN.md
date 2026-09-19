# Architecture Reachability Inventory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the project's `subagent-driven-development` skill to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立一个只读、可重复的 JavaScript/TypeScript workspace 可达性盘点，并从第一次 CI 接入起阻断所有未处置的 Knip finding。通过逐批修复、迁移、精确配置或删除来清零阻断性 finding；不使用历史 baseline 掩盖现有问题，也不把静态“未发现引用”误判为删除授权。

**Architecture:** `pnpm-workspace.yaml` 是 workspace authority。Knip 只生成两份静态消费图候选报告：完整 workspace report，以及固定版本 CLI 的 `--production` mode report。二者都不代表 Host immutable artifact、runtime closure、SBOM、协议、发布或 live reachability。package scripts、workflow、runbook、dynamic `import()`/`require()`、glob/目录扫描、配置/环境选择、生成器、PowerShell/.NET、外部进程、ignored artifact/fixture 和 release/live consumer 必须经过额外 consumer-closure review。CI 从第一次接入起阻断配置/执行错误和所有 finding：任一报告或输入 error 先使 runner/CI 退出 `2`；仅在两份报告与同一严格 owner-disposition ledger 均有效后，runner 对 workspace 和 production 的每一个 current finding 分别按精确 identity 校验 disposition。ledger 只把 finding 转换为可审计的阻断责任，绝不作为永久数量 baseline、Knip ignore 或放行；`unresolved_blocking` 继续退出 `1`，`resolved` 必须从相应 current report 消失。每个 remediation wave 必须减少 unresolved identity，或产出明确的 `BLOCKED_OWNER_DECISION`；不启用 `--fix`、baseline、无界 ignore 或统一 architecture gate。

**Tech Stack:** Node.js 24.13.x（仓库 CI runtime）、pnpm 11.1.3、Knip 6.34.0、Node `node:test`、GitHub Actions，以及现有 Biome/TypeScript/Host boundary checker。

**Spec:** [架构治理与防腐政策](architecture/architecture-governance-and-anti-erosion.md)、[发布与验证模型](architecture/release-model.md)、[文档治理](handbook/documentation-guide.md)、[系统架构](architecture/system-overview.md)。

## Global Constraints

- workspace 范围必须来自 `pnpm-workspace.yaml`：`packages/*`、`host`、`voice-gateway`、`dialogue-web`、`integrations/stardew/action-development`；必须排除 `vendor/magic-context/**`。root `package.json.workspaces` 不能覆盖该边界。
- Knip 固定为 `6.34.0`，通过 root `package.json` 和 `pnpm-lock.yaml` 锁定；不得使用 `pnpm dlx`、latest、隐式全局安装或未锁定版本。
- Knip 的原始 CLI exit code 必须按固定 `6.34.0` 实测记录，不能预设未知选项一定是 exit `2`：真实 parser error 可能以 exit `1` 返回，并必须通过 stderr/解析器错误特征与 finding report 区分。runner 的分类是更严格的二次判定：只有有效 finding JSON 才归类为 finding；parser/config/plugin/runtime/spawn 错误无论原始 code 为何都归类为 execution error。不得使用 `--no-exit-code`、`--force-exit` 或其他 masking flag。
- Knip report 是 JS/TS 静态消费图候选，不是架构 authority、删除授权、production artifact closure、runtime closure、SBOM、协议、发布或 live evidence。
- 完整 workspace report 覆盖实际 workspace 的 production、test、build、配置和 package-script inputs；第二份 report 是固定 Knip CLI 的 `--production` mode，其范围仍由 workspace、`entry`、`project`、`ignore` 和 plugin 配置决定，不是 Host production artifact/runtime closure。
- dynamic `import()`/`require()`、glob/目录扫描、配置/环境选择、生成脚本、PowerShell/.NET、外部进程、operator/runbook、ignored artifact/fixture 和 release/live consumer 必须进入 consumer-closure review；静态图未发现引用不等于孤儿。
- Runner 只使用一个合并 exit-code precedence：任一报告或输入中的 execution/config/parser/plugin/runtime/spawn/JSON/report-shape/containment/ledger-validation error 均优先使 runner/CI 退出 `2`，即使另一份有效报告含 finding；只有两份报告均有效且 ledger 有效后才评估 findings。届时，workspace 与 production 的每一个 current finding 都必须精确匹配同一 ledger 中一个未过期的 record：`unresolved_blocking` 退出 `1`；`resolved` 当前仍出现、未知 status、unknown identity、identity mismatch、过期、无效或缺少 owner/obligation/risk/evidence 的 finding 均为 ledger validation error 并退出 `2`；两份报告均无 finding 且没有未解决 disposition 才退出 `0`。ledger 不是永久的五项/八项（或其他固定数量）baseline，也不是 Knip ignore。每个 finding 必须通过图建模、重构、删除或由 current owner 已验证的精确配置处置而消失；若无法确认 owner 或消费者，标记 `BLOCKED_OWNER_DECISION`，且不能无限续期。
- 不引入 dependency-cruiser、Madge、ts-prune、ESLint、统一 topology JSON、统一 architecture runner 或第二个 Host source-graph authority；只有发现具体且现有 checker 无法表达的 obligation，才另立工具评估任务。
- 不修改 Chat/Game、Desktop、Guardian、Stardew native action、Host runtime admission、production artifact authority 或任何 live mutation path。
- 报告目录必须位于 disposable/ignored CI temp root；不得上传 `node_modules`、production generations、credentials、browser state、raw transcript、Pi data 或其他敏感目录。
- 不相交文件面的 lane 可以并行写；`package.json`、`pnpm-lock.yaml`、lock-bound SBOM/advisory files 由 dependency lane 独占；workflow lane 只能写 `.github/workflows/ci.yml`；policy lane 只能写 design repository 内指定文件。共享决定先由父级确认，再进入单一 integration/review wave。

## Frozen Slice Card

**User-visible result:** 每次 PR/push 的 Windows CI 都运行 Knip config contract、完整 workspace report 和 Knip production-mode report；从第一次接入起，任何 finding、配置错误或执行错误都使 Knip job 失败。每个成功产生且通过 JSON 校验的 report 都被单独上传；失败命令不会伪造成功报告。Runner 使用唯一 precedence：任一报告或输入的 execution/config/parser/plugin/runtime/spawn/JSON/report-shape/containment/ledger-validation error 一律先退出 `2`；仅在两份报告和同一 ledger 均有效时，才按每个 workspace 或 production finding 的 identity、owner disposition 计算。`unresolved_blocking` finding 退出 `1`；current resolved-present、未知 status、identity mismatch、expired 或 invalid 均是 ledger validation error 并退出 `2`；两份报告均无 finding 才可能退出 `0`。status enum 仅为 `{unresolved_blocking, resolved}`。已修复、迁移、精确配置或批准删除且其证据已生效的 resolved finding 必须从对应 current report 消失，不能永久要求固定数量（例如五项、八项或 132 项）存在。Knip 不删除代码，也不替代产品发布门。

**In scope:** pinned Knip dependency、显式 workspace config、config contract test、跨平台 report runner、Windows CI report/artifact steps、SBOM/dependency-risk lock binding、治理政策命令语义更新。

**Explicit non-goals:** 不修改现有 Host import-boundary、artifact/release/live authority 或 C#/native/PowerShell consumer implementation；不建立 baseline-delta gate、全仓架构总分或自动删除机制；不把报告结果写成 release evidence。

**Acceptance scenario:**

```text
Given  fresh checkout、pnpm-workspace.yaml 和 frozen lockfile
When   CI 安装依赖并运行 config contract、workspace report 和 production-mode report
Then   六类 pnpm workspace 均在 scope 内，vendor/magic-context 被排除
And    原始 exit code 与 runner 分类分别记录：exit `0` 可表示无 finding；只有 exit `1` 且具备有效 finding JSON 才是 finding；parser/config/plugin/runtime error（包括可能以 exit `1` 返回的 unknown-option parser error）由 runner 归类为 execution error，不得声称未知选项固定 exit `2`
And    每个有效 JSON report 只在本次运行原子提升后上传；缺失/无效 report 使对应 upload 失败
And    任一报告或输入的 execution/config/parser/plugin/runtime/spawn/JSON/report-shape/containment/ledger-validation error 都优先使 runner/CI exit `2`；仅当两份报告与 ledger 都有效时，任一 workspace finding 直接 exit `1`，production 的 `unresolved_blocking` 或其他未解决 finding exit `1`，而两份报告均无 finding 且 production disposition 无未解决 finding 才 exit `0`；status enum 仅为 `{unresolved_blocking, resolved}`，未知 status 是 exit `2` 的 validation error；不被 baseline、无界 ignore 或 advisory mode 隐藏
And    现有 Host、voice、Stardew、artifact 和 release/live steps 未被替换或弱化
```

**Stop rule:** 若固定版本 CLI 不接受下述 config、不能稳定输出 JSON、不能覆盖 `pnpm-workspace.yaml` 的六类 workspace、不能由 runner 区分有效 finding 与原始 CLI parser/config/plugin/runtime error、需要改变动态 loader/artifact authority，或 CI artifact 会触碰 GameBuddy-owned production data，则停止并形成 `BLOCKED_OWNER_DECISION`；不得用 ignore、baseline、fallback 或 `--no-exit-code` 绕过阻断。

**Frozen execution budget:** 最多 3 个 mutation writers（dependency/config、CI、design policy），最多 2 个 read-only scouts，1 个 integration writer/reviewer；Wave 1 peak concurrency 为 5，禁止 live mutation、provider credential 和 system Pi access；单个 writer 只负责其 owned files，单一 integration wave 负责 shared verification；首次 batch 目标是一个 CI/config integration，不承诺在同一 batch 清零所有历史 finding。

## Mutation Lanes and Execution Order

### Wave 0 — Parent reconnaissance, no writes

父级记录 dirty paths、workspace manifests、CI runtime、`.gitignore`、现有 SBOM/dependency-risk contract、Knip registry availability 和当前无 Knip dependency/config/script 的基线。不得还原、暂存或清理其他 owner 的变更。

### Wave 1 — Independent lanes

- **Lane A — dependency/config/report runner (exclusive):** `package.json`、`pnpm-lock.yaml`、`knip.json`、`tools/knip-config.test.mjs`、`tools/run-knip-reports.mjs`、`third_party/sbom-node.json`、`security/dependency-advisories.json`、`security/dependency-risk-acceptances.json`。负责 pinned dependency、实际 CLI/config contract、runner、锁绑定 metadata。
- **Lane B — CI (exclusive):** `.github/workflows/ci.yml`。只增加 config test、report runner、两个精确 report upload steps，以及现有 CI 已有 dependency audit 旁边的 `pnpm check:dependency-risk` contract；不得改变 Host/voice/Stardew authority 或命令顺序。
- **Lane C — policy (exclusive):** `design/architecture/architecture-governance-and-anti-erosion.md` in the separate design repository。等待 Lane A 的最终 command/config semantics 后更新政策，不复制完整 JSON。
- **Read-only scouts:** 一个检查 Knip 对 scripts/workflows/dynamic loaders/runbooks/release consumers 的盲区；一个检查 Windows shell、Actions artifact path、ignored paths 和 data safety。

Lane A/B/C 可以准备阶段并行；Lane B/C 的实现验证等待 Lane A 的 pinned CLI/config contract 成功。每个 remediation wave 都必须在进入下一 wave 前重跑 architecture quality、authority boundary、evidence completeness 和 readability checks，并与上一 wave 对比确认没有退化；wave 不能以固定 finding 数量作为通过条件。Wave 1 结束后只能有一次 integration/review wave，不允许多个 writer 同时修同一失败。

## Task 0: Freeze Workspace Boundary

**Read:** `pnpm-workspace.yaml`、root/workspace `package.json`、`.github/workflows/ci.yml`、`.gitignore`、`third_party/sbom-node.json`、`security/dependency-advisories.json`、`security/dependency-risk-acceptances.json`。

- [ ] 保存 dirty-path 清单，不触碰其他 owner 文件。
- [ ] 确认六类 workspace 和 `vendor/magic-context/**` exclusion；确认 root npm workspaces 不被当作唯一输入。
- [ ] 确认 CI 使用的 Node/pnpm 版本和 root execution directory。
- [ ] 运行 `pnpm view knip@6.34.0 version`，必须返回 `6.34.0`；否则停止，不换 latest。
- [ ] 记录当前无 Knip dependency/config/script；这不是 finding。

**Acceptance:** scope、runtime、registry、lock-bound metadata 和 clean baseline 与本卡一致后，才允许进入 writer lanes。

## Task 1: Add Pinned Knip Configuration and Report Runner

**Owned files:**

- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `third_party/sbom-node.json`
- Modify: `security/dependency-advisories.json`
- Modify: `security/dependency-risk-acceptances.json`
- Create: `knip.json`
- Create: `tools/knip-config.test.mjs`
- Create: `tools/run-knip-reports.mjs`
- Create: `tools/knip-finding-ledger.json` (tracked, versioned disposition input; never a Knip baseline or ignore)

### Fixed config shape

Lane A must start from this explicit configuration shape rather than inventing a new model. The installed `6.34.0` CLI/config schema is authoritative for syntax, but any schema-driven adjustment must be recorded in the integration evidence and must preserve the same six workspace roots and exclusions:

```json
{
  "workspaces": {
    ".": {
      "entry": ["tools/*.mjs", "host/scripts/*.mjs"],
      "project": ["tools/**/*.mjs", "host/**/*.ts", "host/**/*.mjs"]
    },
    "packages/*": {
      "entry": ["src/index.{js,mjs,ts,tsx}", "bin/**/*.{js,mjs,ts}"],
      "project": ["src/**/*.{js,mjs,js,jsx,ts,tsx}", "tests/**/*.{js,mjs,ts,tsx}", "bin/**/*.{js,mjs,ts}"]
    },
    "host": {
      "entry": ["src/**/*.{ts,tsx}", "scripts/*.mjs"],
      "project": ["src/**/*.{ts,tsx,mjs}", "scripts/**/*.mjs"]
    },
    "voice-gateway": {
      "entry": ["src/**/*.{ts,tsx}"],
      "project": ["src/**/*.{ts,tsx}"]
    },
    "dialogue-web": {
      "entry": ["src/**/*.{ts,tsx}"],
      "project": ["src/**/*.{ts,tsx,mjs}", "scripts/**/*.mjs"]
    },
    "integrations/stardew/action-development": {
      "entry": ["src/**/*.mjs", "tests/**/*.mjs", "scripts/**/*.mjs", "scenarios/**/*.mjs"],
      "project": ["src/**/*.mjs", "tests/**/*.mjs", "scripts/**/*.mjs", "scenarios/**/*.mjs"]
    }
  },
  "ignore": [
    "vendor/magic-context/**",
    "**/dist/**",
    "**/dist-test/**",
    "**/node_modules/**",
    "**/.tmp/**",
    "**/artifacts/**",
    "**/coverage/**",
    "**/playwright-report/**"
  ]
}
```

The writer must correct only invalid Knip 6.34.0 syntax or demonstrably wrong scope discovered by the actual pinned CLI; it must not make the config pass by excluding tracked source or by turning every tool into an artificial entry. If package plugin discovery already covers package exports/bin or scripts, the explicit patterns remain project coverage, while entry patterns must be narrowed to genuine roots and documented in the contract test.

### Required package scripts

```json
{
  "test:knip-config": "node --test tools/knip-config.test.mjs",
  "report:knip": "knip --config knip.json --reporter json",
  "report:knip:production": "knip --config knip.json --production --reporter json"
}
```

`tools/run-knip-reports.mjs` must invoke the pinned local binary through `pnpm exec knip` rather than parse `pnpm run` lifecycle output. Its CLI contract requires exactly one named `--ledger <path>`, `--output-dir <path>`, and `--allowed-root <path>` argument (and rejects missing, repeated, unknown, or positional path arguments). The trusted caller supplies `allowedRoot`; the runner must never derive it from the output path, its parent, `runner.temp`, the repository, or any output value. `--ledger` is a tracked, versioned production input, not a test-only pseudo-baseline: the runner must validate its schema and expiry for the production report only. Workspace report execution and valid workspace-finding classification do not require a ledger disposition and must remain raw Knip blocking. It:

1. canonicalizes the supplied allowed root and output parent and proves the output parent is beneath the canonical allowed root: both are fresh, disposable CI paths outside the repository; traversal, aliases, repository containment, missing parents, existing destinations, symlinks, junctions, and every reparse component encountered while walking either path are rejected;
2. creates a fresh child directory only after parent admission, then re-reads its canonical parent/component identity and reparse state (including the final component) and rejects identity or containment changes; residual TOCTOU is an execution failure, not a fallback;
3. rejects pre-existing `workspace.json`, `production.json` and `.tmp` targets;
4. runs each report independently with `process.execPath`/`pnpm exec knip`, fixed config and reporter arguments, capturing stdout, stderr and exit code without shell redirection;
5. parses stdout as JSON separately and applies runner-level malformed-shape rejection: an original exit `1` is a finding only when JSON passes the observed minimum shape and stderr does not identify a parser/config/plugin/runtime error; unknown-option parser error is execution failure even if Knip returned exit `1`. Exit `2`, spawn failure, empty/invalid JSON, or missing/wrong report shape is an execution failure and is not promoted;
6. before promotion, revalidates canonical destination/parent/component identity, containment and no-reparse state; atomically writes only regular `workspace.json`/`production.json` files without following or replacing a reparse point, preserving a valid report from one command even if the other fails; any promotion identity, open, replace or post-create check failure is an execution error;
7. classifies each report independently, then applies the sole combined precedence: any execution/config/parser/plugin/runtime/spawn/JSON/report-shape/containment/ledger-validation error in either report or input exits `2` before any finding outcome, including when the other valid report has a workspace finding. Only when both reports are valid and the ledger is valid does it evaluate findings: any valid `workspace.json` finding exits `1` directly, with no ledger disposition lookup; otherwise `production.json` exits `1` when at least one current finding is `unresolved_blocking` or otherwise unresolved, and exits `0` only when both reports have no findings and the production disposition has no unresolved finding. A current `resolved` record, an unknown status, unknown current finding, identity mismatch, or missing/invalid/expired ledger data is a ledger-validation error and exits `2`. The only allowed ledger status enum is `{unresolved_blocking, resolved}`; `resolved` is retained auditable disposition history but must disappear from the current production report, so it cannot mask a report. Never uses `--no-exit-code` and never writes source or production data.

### Versioned finding disposition ledger (mandatory runner input)

The repository tracks one explicit ledger at a stable path (for example `tools/knip-finding-ledger.json`); CI passes that exact path using `--ledger`. It is not generated by tests, not a Knip baseline, and not a Knip ignore. The schema is versioned and rejects unknown versions, duplicate identities, any status outside the sole enum `{unresolved_blocking, resolved}`, missing fields, additional unrecognized fields, and invalid dates:

```json
{
  "schemaVersion": 1,
  "findings": [
    {
      "identity": "workspace|category|key",
      "owner": "team-or-person",
      "obligation": "fix|migrate|precisely-configure|delete",
      "risk": "why-this-candidate-is-safe-or-not-safe-to-remove",
      "evidence": ["opaque review/evidence reference"],
      "validUntil": "2030-01-31",
      "status": "unresolved_blocking"
    }
  ]
}
```

`report` is exactly `workspace` or `production`; `identity` is the canonical tuple of workspace, Knip category, and file/export/dependency key. The pair `(report, identity)` is unique across the ledger. `owner`, non-empty `obligation`, non-empty `risk`, at least one `evidence` reference, and a future `validUntil` are mandatory for every record. `status` must be exactly one of `{unresolved_blocking, resolved}`; any other or missing status is invalid ledger input and returns exit `2`. For both reports, `unresolved_blocking` is the only status that can represent an accepted current finding and always causes exit `1`; `resolved` records are retained only as auditable disposition history and must disappear from their scoped current report before exit `0`. Every current finding in `workspace.json` and `production.json` must match exactly one non-expired ledger record of the same `report` scope; a current finding with no record is unknown and exits `2`; a ledger record with an identity mismatch, expired `validUntil`, or malformed fields exits `2`. Ledger entries may not make findings disappear through a permanent allowlist, and the runner must not pass ledger identities to Knip as `ignore` or baseline configuration.

The runner must classify failures at runtime rather than by raw Knip code: valid JSON with the observed finding shape plus exit `1` is a finding result; parser/config/plugin/runtime errors (including unknown-option parser output even when raw exit is `1`), malformed/missing report, invalid production ledger (including an unknown status), spawn failure, or containment failure are execution errors. Any such error in either report or input takes precedence and exits `2`; only after both reports and the ledger validate may a finding result exit `1`. Tests must exercise each classification with real subprocesses and assert the runner's exit code, stderr/error category, and absence of promoted invalid output.

### Review-blocker requirements (mandatory, not illustrative)

The implementation and contract tests must close the following review blockers with real observable behavior; prose, mocked exit codes, or regex-only source checks are insufficient:

- **Real pinned finding fixture:** create a disposable, controlled fixture containing a genuinely unused file/export or dependency that is analyzed by the locally installed `knip@6.34.0` binary. Invoke the pinned binary with the same fixed config/reporter semantics used by the runner and prove exit `1` plus parseable JSON. Do not classify a fabricated `process.exit(1)` or a fixture excluded by `ignore` as evidence.
- **Real error fixtures:** exercise an invalid config fixture and an unknown-option invocation against the pinned binary on Windows. Record each raw exit code and stderr; do not assert that unknown-option parsing returns exit `2` because Knip `6.34.0` may return exit `1`. Neither may be accepted or retained as a finding report: the runner must classify the parser error as execution failure, distinct from the real finding fixture's valid exit-`1` JSON. Also exercise malformed, expired, schema-invalid, duplicate, unknown-status, unknown-identity, and identity-mismatched `--ledger` inputs; all are runner execution errors (exit `2`).
- **Observed reporter contract:** validate the minimum JSON shape actually emitted by Knip `6.34.0` in this repository, rather than requiring a guessed full schema. At minimum the parsed root must be a non-null object and contain the observed finding-bearing reporter field(s) with the expected JSON types; record the accepted shape in the test and reject empty objects, arrays, scalars, malformed JSON, and reports missing that minimum shape. Do not silently accept arbitrary JSON as a report.
- **Finding propagation and precedence:** a valid workspace finding report (exit `1` and minimum observed shape) must be promoted and, only after both reports and the ledger validate, directly exit `1` without a ledger lookup. A valid production finding report must be promoted and classified against the supplied ledger: current `unresolved_blocking` exits `1`, no current production findings exits `0`, and current `resolved`, unknown status, unknown identity, duplicate, identity-mismatched, or expired dispositions exit `2`. The ledger status enum is exactly `{unresolved_blocking, resolved}`. Any execution/config/parser/plugin/runtime/spawn/JSON/report-shape/containment/ledger-validation error in either report or input takes precedence as exit `2`, ahead of raw workspace or unresolved production findings. A valid workspace report is promoted after containment checks; a valid production report is promoted only after ledger and containment checks.
- **Output containment and reparse policy:** define the caller-to-runner `allowedRoot` contract explicitly. Canonicalize and validate the supplied output parent and runner-created destination before any write; both must remain beneath the canonical allowedRoot, outside the repository, and free of existing path, symlink, junction, or other reparse components discovered while walking every component. Reject traversal, path aliasing, and canonical paths escaping allowedRoot. Create the destination only after admission, then perform post-create canonical parent/component identity and no-reparse checks. Document residual TOCTOU after those checks; any identity change or non-regular target at open/replace is an execution failure, and the runner must never follow or replace a reparse point. `--ledger` is read only from its explicit path, must be a regular non-reparse file under the trusted ledger-root contract, and is never copied into output. Tests must cover parent/destination traversal and symlink/reparse rejection on Windows.
- **Windows direct CLI verification:** run the pinned local `knip@6.34.0` binary directly on Windows (not through a platform-wide skip, compatibility skip, or non-Windows substitute), including config, finding, and parser-error fixtures. A non-Windows environment may report the check not-run, but CI's Windows lane must not skip it.
- **Exact upload semantics:** CI has two independent `always()` upload steps, one for exactly `workspace.json` and one for exactly `production.json`, each using `if-no-files-found: error`, attempt-unique artifact names containing `${{ github.run_id }}-${{ github.run_attempt }}`, and `retention-days: 14`. Upload succeeds only for the corresponding promoted regular JSON file; no wildcard, directory, `.tmp`, stderr, cache, or fallback path is permitted. If one report is valid and the other fails, the valid report remains uploadable while the failing report's own upload fails; a finding report is valid/uploadable even though the job is failed.

`tools/knip-config.test.mjs` must use `node:test` and built-in JSON/process APIs. It must test the actual pinned binary, not only text. Every runner invocation in the contract tests passes an explicit tracked ledger covering the report scopes it emits; workspace and production findings must remain blocking dispositions rather than synthesized baselines or Knip ignores:

- exact six workspace keys and `pnpm-workspace.yaml` projection;
- Stardew workspace inclusion and vendor/generated output exclusion;
- exact script strings and exact dependency version;
- `knip --version` = `6.34.0` and `knip --help` contains the required report/config options;
- config acceptance for both normal and `--production` invocations;
- root `tools` and Stardew workspace appear in the effective project scope;
- a controlled unused fixture yields exit `1` with valid JSON;
- invalid config and unknown option are recorded with their raw exits; unknown-option parser output is not required to be exit `2`, and both are runner-classified as execution errors rather than findings;
- combined exit-code precedence: any execution/config/parser/plugin/runtime/spawn/JSON/report-shape/containment/ledger-validation error in either report or input exits `2` ahead of all findings; otherwise workspace valid finding exits `1` without a ledger disposition; production-ledger schema/version, owner/obligation/risk/evidence/validUntil validation and exact status enum `{unresolved_blocking, resolved}`, unresolved-blocking exit `1`, resolved-present/unknown-status/unknown-identity/identity-mismatched/invalid/expired exit `2`, and no-current-production-finding exit `0`; no Knip baseline or ignore is accepted;
- the report runner preserves the first valid report when the second command fails, rejects pre-existing output, rejects invalid stdout/spawn failure, rejects malformed report shapes at runner level, revalidates identity/reparse state before promotion, and returns non-zero for findings.

- [ ] **Step 1:** Install exact `knip@6.34.0` and update only necessary lockfile resolutions. Review Knip/transitive licenses and advisories.
- [ ] **Step 2:** On Windows, invoke the installed pinned `knip@6.34.0` CLI directly (without platform-wide skips); run `--version`/`--help` and fixtures, recording raw exit codes, stdout and stderr for `--production`, `--reporter json`, config schema, finding, invalid-config and unknown-option parser behavior. If behavior differs, update the runner classification contract here; do not invent a false exit `2` claim.
- [ ] **Step 3:** Write/validate `knip.json` from the fixed shape above; prove `integrations/stardew/action-development` is not lost because root npm workspaces omits it.
- [ ] **Step 4:** Add scripts and report runner; never add `--no-exit-code`, baseline or unbounded ignore.
- [ ] **Step 5:** Add the tracked versioned ledger schema and runner tests above, including direct Windows CLI execution, a real unused-source finding fixture, raw parser-error capture, combined error-precedence exit `2` when either report/input is invalid despite a sibling finding, raw workspace-finding exit `1` without ledger disposition only after both reports and ledger validate, malformed/expired/unknown-status/unknown-identity/identity-mismatched production-ledger classification, exact status enum `{unresolved_blocking, resolved}`, production unresolved-blocking exit `1`, production resolved-present exit `2`, no-current-production-finding exit `0`, no Knip baseline/ignore, explicit allowedRoot admission, canonical parent/component reparse checks, post-create identity checks, residual TOCTOU failure handling, and symlink/reparse rejection.
- [ ] **Step 6:** Run `pnpm install --frozen-lockfile`; confirm no further lockfile mutation. Regenerate/review `third_party/sbom-node.json`, `security/dependency-advisories.json` and `security/dependency-risk-acceptances.json` using existing repository commands. The acceptance file must at minimum receive the new lock identity even when there are no new advisory records.
- [ ] **Step 7:** Run `node tools/run-knip-reports.mjs --ledger tools/knip-finding-ledger.json --output-dir <fresh-disposable-dir> --allowed-root <fresh-disposable-allowed-root>` with the trusted caller-supplied allowed root; record both report counts and the exact combined precedence: any execution/config/parser/plugin/runtime/spawn/JSON/report-shape/containment/ledger-validation error in either report or input exits `2`; only otherwise does any valid workspace finding exit `1` without ledger disposition, production `unresolved_blocking` exit `1`, resolved-present/unknown-status/unknown-identity/identity/expired/invalid exit `2`, and no current production finding exit `0`. Ledger status is exactly `{unresolved_blocking, resolved}`.

**Acceptance:** pinned install, actual config acceptance, report runner contract, two valid JSON reports, SBOM and both dependency-risk metadata checks pass; workspace findings are raw blocking rather than hidden, and production findings follow the ledger disposition contract without using it as a baseline or ignore.

## Task 2: Add Blocking Knip Evidence to Windows CI

**Owned file:** `.github/workflows/ci.yml`

- [ ] **Step 1:** After existing frozen install and before expensive Host checks, add:

```yaml
- name: Validate Knip configuration
  run: pnpm test:knip-config

- name: Run blocking Knip reachability reports
  run: node tools/run-knip-reports.mjs --ledger tools/knip-finding-ledger.json --output-dir "${{ runner.temp }}\gamebuddy-knip" --allowed-root "${{ runner.temp }}"
```

The runner owns process exit semantics; the workflow must not pipe native commands through `Out-File`.

- [ ] **Step 2:** Add two separate upload steps, each with `if: ${{ always() }}`, `actions/upload-artifact@v4`, an exact path (`${{ runner.temp }}/gamebuddy-knip/workspace.json` or `production.json`), `if-no-files-found: error`, a name containing `${{ github.run_id }}-${{ github.run_attempt }}` and the report name, and `retention-days: 14`. A successfully completed report remains downloadable when the other report fails; a missing/invalid report makes its own upload fail. Upload only regular JSON reports, never `.tmp`, directories, stderr, caches or sensitive data. The runner step must pass the tracked ledger path exactly; uploads must not include the ledger, and no upload may use a wildcard, directory, fallback, or pseudo-baseline artifact.

- [ ] **Step 3:** Add `pnpm check:dependency-risk` to the existing appropriate deterministic CI job because the lockfile, advisory snapshot and acceptance hashes are part of this change. Do not replace the existing `pnpm dependency-audit`/SBOM command.
- [ ] **Step 4:** Do not move, delete, reorder, weaken or wrap existing Host import-boundary, typecheck, browser build, test, dependency-audit, SBOM, voice-gateway or Stardew commands. Knip cannot assemble a Host production generation or replace Stardew `action:ci`.
- [ ] **Step 5:** Validate YAML using an existing repository parser/check if one exists; otherwise use GitHub Actions workflow parsing before merge and record that evidence. Do not add a YAML dependency only for this task.
- [ ] **Step 6:** On the Windows CI lane, simulate the runner with the real pinned finding fixture and controlled execution-error fixtures; verify independent report execution, valid workspace finding JSON promotion and raw runner exit `1` without ledger disposition only after both reports and ledger validate, production unresolved-blocking exit `1`, production resolved-present/unknown-status/unknown-identity/identity/expired/invalid exit `2`, exact status enum `{unresolved_blocking, resolved}`, raw invalid/unknown-option parser outcomes and runner execution-error classification, combined error-precedence exit `2` for an error in either report/input despite a sibling finding, malformed-shape rejection, explicit allowedRoot/canonical parent and component containment, post-create identity and residual TOCTOU checks, reparse policy, final non-zero status, and exact output containment. Do not use a platform-wide skip.
- [ ] **Step 7:** Verify each upload step against the exact individual regular-file path and `always()` semantics: a valid report uploads independently when its sibling fails, while missing/invalid/non-regular output fails only its own upload and cannot be replaced by a wildcard, directory, `.tmp`, or fallback artifact.

**Acceptance:** On a fresh Windows CI run, config/Knip execution errors or any finding fail the Knip job; each successful report is uploaded; incomplete evidence cannot upload as a successful report; existing CI commands and authority remain unchanged.

## Task 3: Update Governance Policy

**Owned file:** `design/architecture/architecture-governance-and-anti-erosion.md` in the separate `design` repository.

- [ ] State that `pnpm-workspace.yaml` is workspace authority and list the six configured workspace classes with vendor exclusion.
- [ ] State that `report:knip` is the complete static workspace report and `report:knip:production` is the fixed Knip CLI production-mode static report; neither proves runtime/artifact/live reachability.
- [ ] State that CI blocks configuration/执行 errors and every unaddressed finding from the first run; no baseline, `--no-exit-code` or `--fix`.
- [ ] List mandatory manual closure categories: dynamic loaders, glob/目录扫描, generated outputs, config/environment selection, package scripts/workflows, PowerShell/.NET/external processes, operator/runbook, ignored artifacts/fixtures, release/live consumers and current owner documents.
- [ ] State that Knip cannot mint deletion, capability, receipt, artifact, release or live authority.
- [ ] In the design repository run `git -C design diff --check -- architecture/architecture-governance-and-anti-erosion.md` and `npm --prefix design run check`; record only unrelated pre-existing failures.

**Acceptance:** policy names actual commands and Knip production-mode semantics, records first-run blocking, and does not create a new architecture authority.

## Task 4: Integration and Interpretation Gate

**Read:** `knip.json`、root/package manifests、`pnpm-lock.yaml`、`third_party/sbom-node.json`、`security/dependency-advisories.json`、`security/dependency-risk-acceptances.json`、`.github/workflows/ci.yml`、config/runner tests、generated reports and policy.

- [ ] In a fresh disposable copy, run `pnpm install --frozen-lockfile`; expected no lockfile diff.
- [ ] Run `pnpm test:knip-config`; prove Stardew workspace inclusion, vendor exclusion and actual pinned CLI acceptance.
- [ ] Run `node tools/run-knip-reports.mjs --ledger tools/knip-finding-ledger.json --output-dir <fresh-disposable-dir> --allowed-root <fresh-disposable-allowed-root>`; record both report counts and exact combined precedence: any execution/config/parser/plugin/runtime/spawn/JSON/report-shape/containment/ledger-validation error in either report/input exits `2`; only when both reports and ledger are valid do workspace findings exit `1` directly without ledger disposition, production `unresolved_blocking` exit `1`, resolved-present/unknown-status/unknown-identity/identity/expired/invalid exit `2`, and no current production findings exit `0`. Ledger status is exactly `{unresolved_blocking, resolved}`.
- [ ] Run existing commands without changing semantics:

```text
pnpm format:check
pnpm lint
pnpm typecheck
pnpm check:host-production-import-boundary
pnpm dependency-audit
pnpm check:dependency-risk
pnpm --dir integrations/stardew/action-development action:ci
```

- [ ] Review Knip/transitive license, SBOM and advisory changes; verify lock hash consistency across both dependency-risk files.
- [ ] For every remediation wave, produce a before/after review record for architecture quality, authority boundaries, evidence completeness, and readability. The record must name the changed production finding identities, owner obligations, risk, evidence, and `validUntil`; prove no authority moved to Knip/ledger/runner, evidence remains independently reproducible, and the plan/report remains readable. Any degradation blocks acceptance. Apply the sole precedence first: any execution/config/parser/plugin/runtime/spawn/JSON/report-shape/containment/ledger-validation error in either report/input exits `2`. Only after both reports and ledger are valid, keep workspace findings raw so any valid current workspace finding yields exit `1` without ledger disposition; recompute production findings by identity and the exact `{unresolved_blocking, resolved}` enum so `unresolved_blocking` yields exit `1`, current `resolved` yields exit `2`, unknown status/identity/invalid/expired yields exit `2`, and no current production findings yields exit `0`; never assert a permanent count.
- [ ] Inspect at least one script-driven tool, one dynamic/scan-driven path and one package export/bin candidate; demonstrate that each enters consumer-closure review rather than automatic deletion.
- [ ] Audit `git status --short` and staged snapshot; no reports, caches, production artifacts, credentials, Pi data or unrelated dirty work is staged.
- [ ] Fresh final reviewer checks actual diff, CLI/report semantics, runner failure behavior, exact upload paths, workspace inclusion/exclusion, dependency metadata, data safety, existing CI command preservation and authority boundaries.

**Acceptance:** clean install, config test, two valid reports, existing static gates, dependency metadata, workflow validation, diff check and final review complete; findings/config/execution errors block and no production/live evidence is weakened.

## Evidence and Disposition

The remediation program runs in explicit waves, each with a named owner and an independently reviewable before/after record: Wave A closes architecture quality (scope and static-graph limitations); Wave B closes authority boundaries (Knip, ledger, and runner cannot mint deletion, capability, artifact, release, or live authority); Wave C closes evidence completeness (real CLI/report/ledger/CI upload evidence and reproducible identities); Wave D closes readability (unambiguous commands, schemas, errors, and consumer-closure instructions). A wave cannot close until all four dimensions are at least as strong as its pre-wave snapshot; degradation blocks the next wave.

`workspace.json` 是原始 Knip workspace report；production finding ledger 仅是 `production.json` disposition-aware 的当前状态投影，而非永久 baseline 或 ignore。Runner 使用唯一 precedence：任一报告或输入的 execution/config/parser/plugin/runtime/spawn/JSON/report-shape/containment/ledger-validation error 都先退出 `2`，即使另一份有效报告含 finding。只有两份报告与 ledger 均有效后才评估 finding：任何有效当前 workspace finding 必须直接退出 `1`，不匹配、不消耗且不得由 ledger 转换为 disposition；否则 production 的 `unresolved_blocking` 或其他未解决 finding 退出 `1`；两份报告均无 finding 且 production disposition 无未解决 finding 才退出 `0`。ledger status enum 仅为 `{unresolved_blocking, resolved}`：当前 production report 中 `resolved` 仍存在，或未知 status、unknown identity、identity mismatch、过期、无效或缺少 owner/evidence，均为 ledger validation error 并退出 `2`。每个 remediation wave 必须用稳定 production finding identity（workspace、category、file/export/dependency key）重算 ledger，验证修复、迁移、精确配置或删除处置确实使对应 finding 从当前 production report 消失；不得通过五项、八项或任何固定数量、baseline 或永久 allowlist 维持门槛。workspace 发现必须继续完成 consumer-closure remediation，不能被 ledger 允许。wave closeout 必须记录 architecture quality、authority boundary、evidence completeness 和 readability 四项检查的前后结果，并证明没有退化；任何退化都阻断下一 wave。

| Result | Meaning | Disposition |
|---|---|---|
| Valid reports and valid ledger, with workspace finding | Raw workspace static findings exist | Exit `1`; no ledger disposition may allow, ignore, or convert the finding. Fix, migrate, precisely configure with owner rationale, or delete; consumer closure precedes deletion |
| Valid reports and valid ledger, with unresolved production finding but no workspace finding | Production static findings exist | Apply only the exact owner-disposition ledger: `unresolved_blocking` exits `1`; exit `0` requires no current production finding and no unresolved production disposition. The ledger is never a baseline/ignore, and consumer closure precedes deletion |
| Any execution/config/parser/plugin/runtime/spawn/JSON/report-shape/containment/ledger-validation error in either report or input | Inventory or its disposition input is unavailable, malformed, or untrusted | Precedence exit `2`; fix runner/config/parser/plugin/runtime/ledger, not source candidates |
| Both reports and ledger valid, no workspace or production findings, and no unresolved production disposition | Inventory is clear | Exit `0` |
| Candidate has script/workflow/dynamic/runbook/live/owner consumer | Static graph is incomplete for that consumer | KEEP or owner decision; never auto-delete |
| Candidate has no consumer after full closure and focused acceptance | Confirmed orphan | Separate deletion slice; this plan never auto-deletes |

Knip reports cannot mint a release claim, capability, receipt, action completion, production artifact or live success. Any deletion slice must separately record owner, all consumers, unique evidence role, replacement, focused acceptance and deletion commit.

## Definition of Done

- `knip@6.34.0` is exact-pinned; `knip.json` is accepted by the actual pinned CLI and covers all six pnpm workspace classes while excluding vendor/generated output.
- `tools/knip-config.test.mjs`, `tools/run-knip-reports.mjs` and the tracked versioned ledger prove config scope, real pinned finding/error exit classification, minimum observed JSON reporter shape, the sole exit-code precedence (any execution/config/parser/plugin/runtime/spawn/JSON/report-shape/containment/ledger-validation error in either report/input exits `2` before findings), raw workspace finding exit `1` without ledger disposition only after both reports and ledger validate, production ledger owner/obligation/risk/evidence/validUntil validation and exact status enum `{unresolved_blocking, resolved}`, production unresolved-blocking exit `1`, production resolved-present/unknown-status/unknown-identity/identity/invalid/expired exit `2`, no-current-production-finding exit `0`, independent report execution, canonical output containment and reparse/symlink policy.
- `third_party/sbom-node.json`, `security/dependency-advisories.json` and `security/dependency-risk-acceptances.json` match the final lockfile and pass existing checks.
- Windows CI passes the tracked ledger via named `--ledger` for `production.json` only, applies the sole error-first precedence, then blocks valid workspace findings directly with exit `1` from the first run and production unresolved-blocking findings with exit `1`, treats resolved-present/unknown-status/unknown-identity/identity/expired/invalid as exit `2`, and independently uploads each valid regular report via its exact path with `always()`, `if-no-files-found: error`, `retention-days: 14`, and attempt-unique names, including valid finding reports despite job failure; the ledger is never uploaded as report evidence or used as a baseline/ignore.
- Governance policy is synchronized with actual command names and Knip production-mode semantics.
- No `--fix`, baseline, unbounded ignore, automatic deletion, new architecture authority or weakened product/release/live gate is introduced.
- Fresh frozen install, config test, reports, existing static gates, dependency-risk checks, workflow validation, `git -C design diff --check`, design check (or precise unrelated pre-existing failure record), `git diff --check` and final independent review are complete.

## Execution Closeout

At closeout record:

```text
result: delivered | blocked
acceptance scenario: the Given/When/Then block above
proven assertion: six-workspace scope + valid independent reports + first-run blocking CI disposition
producer→consumer→verifier: pnpm workspace/config → pinned Knip → report runner → JSON artifact / owner review
child runs: keys, peak concurrency and actual lanes
budget: frozen writers/scouts, review wave and elapsed time
checks: exact commands, exit codes, timing and report paths
finding disposition: counts by category; fixed/migrated/configured/deletion candidates; no baseline
residual risks: dynamic/non-JS/operator consumers and any owner-configured findings
next ready slice: named finding consumer-closure or deletion slice only after report-backed owner decision
```

Plan saved to `design/108_ARCHITECTURE_REACHABILITY_INVENTORY_IMPLEMENTATION_PLAN.md`. Execute it with the project's `subagent-driven-development` workflow.