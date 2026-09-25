---
id: TASK-HOST-BUNDLED-RUNTIME-BOOTSTRAP-CONTRACT
type: task
status: active
owner: host-production-distribution
---

# Host Bundled Runtime and Fixed Bootstrap Entry Contract

> **For agentic workers:** REQUIRED SUB-SKILL: Use the project's `subagent-driven-development` skill task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Define and publish the exact, source-bound Windows Host runtime executable and fixed Host bootstrap entry inside each immutable Host generation, so a native Desktop supervisor can admit one exact runtime/entry pair without system Node, PATH, a runtime-version range, a JavaScript entry-root choice, or a second provenance verifier.

**Architecture:** The Host production publisher is the sole artifact/runtime authority. It receives an already verified, exact Windows x64 Node runtime bundle through a publisher-owned input contract, copies only that fixed runtime into staging, verifies its runtime executable and fixed Host bootstrap entry/closure, writes canonical inventory, then emits an inventory-excluded `host-runtime-admission/v1` sidecar before atomic generation/current-pointer publication. Desktop later consumes fixed sidecar fields only; it never selects a Node version, resolves a JavaScript entry root, reconstructs package closure, uses `process.execPath`, or falls back to a system runtime.

**Spec:** `design/103_WINDOWS_DISTRIBUTION_AND_DESKTOP_PRESENTATION_DESIGN.md` §§3–4; `design/tasks/active/windows-desktop-host-runtime-admission.md`; `host/package.json`; `host/production-artifact.config.json`.

## Status and authority

The current Host publisher declares JavaScript `entryRoots` and an engine compatibility range (`>=24.13.0 <25`), but it does not declare/copy a fixed bundled runtime executable or one fixed bootstrap entry. The current owner has approved the exact first-release runtime input below. Therefore `TASK-WINDOWS-DESKTOP-HOST-RUNTIME-ADMISSION` is blocked only until this task closes: Desktop cannot safely admit or authenticate an exact Host child until then. This task establishes only the missing publisher/runtime contract. It does not start Host, Guardian or broker sessions; modify root layout handling; replace Node process owners; or create app instance/browser/installer behavior.

## Global constraints

- An engine range is not a distributable runtime identity. The approved first-release runtime is **Node.js v24.20.0 LTS (Krypton), Windows x64**, acquired only from the official Node.js release archive `https://nodejs.org/dist/v24.20.0/node-v24.20.0-win-x64.zip`. Its archive SHA-256 is `6cac9ffbca8f6a47091e4b5c772e0606049c3871cb67d900c0cedde630e545ba`. Windows release CI validates only the committed SHA-256 before safe extraction; PGP, keyrings, OpenPGP, and release checksum manifests are not production runtime provenance authority. The fixed extracted runtime executable is `runtime/node.exe`; the contract must name its exact digest plus the exact required extracted runtime bundle layout/sidecar files. The publisher refuses a runtime input whose exact version/build/platform/arch/files/digests do not match this contract.
- The source of the runtime bundle is release-CI-owned and source-bound: it cannot be system `node.exe`, `process.execPath`, PATH lookup, nvm/volta, a repository checkout copy, user application data, or an arbitrary caller path. Runtime download occurs only in protected Windows release CI, never in player startup, ordinary development, or PR CI. Runtime update is an explicit current-owner change: update the exact release URL, committed archive SHA-256, and extracted-file contract together; it is not an implicit LTS/latest download at build or player launch time.
- The fixed Host bootstrap entry is the new emitted artifact-relative internal module `desktop-runtime-bootstrap.internal.js`, not an arbitrary `entryRoots` selector. It starts only the internal Desktop bootstrap consumer and has no browser/public CLI/root/session ingress. Existing `main.js`, dialogue, attachment and preview roots remain product entry roots but are not silently treated as the Desktop bootstrap entry.
- Host publisher remains the sole inventory/provenance authority. `host-runtime-admission/v1` is an inventory-excluded fixed generation-local sidecar. Publisher writes/verifies canonical inventory/digest first, then writes/rechecks the sidecar, then atomically renames generation and pointer. No second runtime manifest, inventory, independent Desktop hash registry or self-digest cycle.
- The sidecar has exact keys: schema, inventory digest, generation identity, runtime executable relative path/digest, fixed bootstrap entry relative path/digest, runtime version/platform/arch and fixed closure facts. It contains no root layout, bootstrap token, Guardian credential, browser/session fact, mutable owner data or general entry selector.
- `current.json` is destructively reduced to exactly four canonical fields: `schema`, `generation`, `inventoryDigest`, and `runtimeAdmissionSha256`. `runtimeAdmissionSha256` is the SHA-256 of the raw canonical `host-runtime-admission/v1` sidecar bytes, not a parsed-and-reserialized representation. The inventory digest remains over the inventory-defined generation contents and excludes the sidecar, avoiding a digest cycle.
- Source-bound tests use only disposable verified runtime bundle fixtures supplied through the same publisher-owned input contract. Production output rejects fixture/runtime-test artifacts. No runtime is executed by this task.

## File and responsibility map

| File | Responsibility |
|---|---|
| `host/production-artifact.config.json` | Declares exact bundled runtime/bootstrap contract, not a version range or arbitrary entry root. |
| `host/scripts/production-artifact.mjs` | Validates/copies publisher-owned runtime bundle, verifies fixed bootstrap entry/closure, emits inventory and sidecar in no-cycle order. |
| `host/scripts/production-artifact.test.mjs` | Runtime contract, malformed/foreign bundle, entry/closure, sidecar order and fixture rejection tests. |
| `host/scripts/build-production-artifact.mjs` | Supplies only approved source-bound runtime input to publisher; no system runtime fallback. |
| `host/src/desktop-runtime-bootstrap.internal.ts` | Fixed Host bootstrap entry, internal-only; no root/token/broker implementation yet. |
| `host/src/desktop-runtime-bootstrap.internal.test.ts` | Bootstrap entry boundary only. |
| `host/scripts/*runtime*fixture*` | Disposable publisher-owned runtime fixture builder only. |

## Accepted CI publication and pointer-binding contract

The publisher freezes a selected generation only after it has written and verified the canonical inventory and its digest, then written and reread the canonical `host-runtime-admission/v1` sidecar. It hashes those reread **raw canonical sidecar bytes** into `runtimeAdmissionSha256`, constructs the four-field `current.json`, and only then replaces the current pointer atomically. Any write, reread, canonical-byte, digest, generation-binding, or pointer-replacement failure leaves the candidate unpublished and does not retain a previous-generation fallback for this admission.

The emitted sidecar and pointer establish the immutable `InstalledGenerationSelection`: the selected `generation`, `inventoryDigest`, raw sidecar bytes/hash, and the fixed runtime/bootstrap file facts named by that sidecar. This selection is frozen once and is the common admission input for the Host bootstrap path and Guardian admission; neither consumer reparses a later pointer or substitutes a different generation during an in-flight admission. The Host publisher remains the only component that creates inventory and closure facts. Desktop can validate the pointer-bound sidecar bytes and the fixed runtime/bootstrap files that it names, but cannot rebuild an inventory, closure, or runtime supply chain.

Host receives session material only in the private one-shot bootstrap frame for this frozen selection. Its internal bootstrap consumer acknowledges that exact selection only after it has reconstructed the registered root layout and freshly revalidated every boundary before a mutable owner opens. The acknowledgement is an admission outcome, not permission to select another entry, root, or generation. There is no PATH, system runtime, or old-generation fallback.

**Residual follow-up:** Guardian sidecar pointer-binding is not closed by this publisher contract. The shared `InstalledGenerationSelection` defines its required input, but the Guardian-specific proof that its sidecar remains bound to that pointer is a separate follow-up and must not be represented as fixed here.

## Task 1: Freeze exact runtime and bootstrap artifact contract

- [x] Record the approved runtime acquisition/embedded artifact source and exact Windows x64 Node build/version: official Node.js v24.20.0 Windows x64 ZIP and committed archive SHA-256 as specified above. Windows release CI validates only the committed SHA-256 before safe extraction. This is stronger than the development `engines` range and excludes all system-runtime fallback.
- [ ] Write failing publisher tests for wrong version/platform/arch, fixed archive SHA-256 mismatch / protected Windows release-CI acquisition failure, missing/extra runtime files, runtime executable replacement/reparse, bootstrap entry replacement/reparse, system `process.execPath`/PATH rejection, fixture-runtime rejection in production output, foreign self-consistent sidecar and inventory/sidecar ordering without self-digest cycle.
- [ ] Declare fixed `runtime/node.exe` and `desktop-runtime-bootstrap.internal.js` paths in the Host artifact contract. Define exact `host-runtime-admission/v1` keys and canonical byte serialization, plus the destructive four-field `current.json` pointer and raw-sidecar-byte hash binding.

## Task 2: Implement source-bound publication

- [ ] Implement publisher-owned runtime bundle validation/copy into staging generation and fixed bootstrap entry/closure validation.
- [ ] Write canonical inventory, verify digest, then emit/recheck inventory-excluded `host-runtime-admission/v1`, hash its reread raw canonical bytes, and atomically replace only the complete four-field current pointer for that generation.
- [ ] Add source-bound disposable runtime fixture builder through the same input contract; prove production publisher rejects fixture markers.
- [ ] Keep existing Host JS product entry roots unchanged and do not start any runtime/Host child in this task.

## Task 3: Matrix and review

- [ ] Run Host publisher runtime/sidecar tests, source-bound fixture generation checks, fixed bootstrap boundary tests, production artifact checks and `git diff --check`.
- [ ] Fresh runtime supply-chain/distribution review: exact runtime source/version, no system runtime/PATH/repo fallback, contract atomicity and no second verifier.
- [ ] Fresh Host architecture review: fixed internal bootstrap entry, no public root/token/broker ingress and no Task 3 delegation.

## Test-support prerequisite

The exported status above is source-complete: `host/scripts/production-artifact.test.mjs`
has 63 cases (62 pass, 1 platform skip) and the publisher emits and rechecks the
inventory-excluded `host-runtime-admission/v1` sidecar together with the
destructive four-field current pointer.

The desktop test fixture that the generation carries must publish as one
self-contained executable renamed to `node.exe`, because the generation holds
exactly one runtime file and hashes it. It originally declared `PublishAot`,
which reaches that shape by way of the MSVC linker; on a machine without the
Visual Studio C++ build tools the link step failed (`MSB3073`, exit 9009), the
publish degraded to an apphost plus `node.dll`, and the generation's runtime
could not start — appearing as `host_runtime_unavailable` after a ~74s broker
timeout in `HostBootstrapSupervisorTests`.

No C++ toolchain is required. The fixture uses no `Marshal`, `Unsafe`,
reflection or JIT-specific behaviour, so managed single-file meets the same
one-file contract (`PublishSingleFile` + `PublishTrimmed` +
`EnableCompressionInSingleFile`, about 10 MiB). Trimming and compression are
load-bearing rather than cosmetic: the supervisor test asserts a runtime image
under 32 MiB, and an untrimmed bundle is about 67 MiB.

## Stop conditions

Stop and revise rather than invent a fallback if:
- no approved exact runtime source/version/build is current-owner authorized;
- runtime or bootstrap entry must be taken from system Node, PATH, `process.execPath`, arbitrary caller path, repository checkout or user environment;
- the publisher cannot verify/copy the runtime bundle without a second inconsistent provenance authority;
- contract/runtime publication creates inventory digest recursion or allows fixture output into production generation;
- implementation starts Host/Guardian, relays Guardian commands, exposes root/token facts, or changes Task 3 process owners.

## Acceptance

This task closes only when a source-bound Host publisher generation contains one approved exact bundled Windows runtime and one fixed internal bootstrap entry, emits/rechecks one inventory-excluded runtime admission sidecar in atomic publication order, rejects runtime/entry/sidecar tamper and all system-runtime fallbacks, and passes independent distribution and Host boundary review. It then activates `TASK-WINDOWS-DESKTOP-HOST-RUNTIME-ADMISSION`; it does not close runtime admission, broker, Task 3, Task 4, presentation, installation registration or live Stardew.
