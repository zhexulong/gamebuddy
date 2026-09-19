# 21 Native Action Architecture Accounting

> **Status:** current source-first architecture discovery stage. It supersedes the mandatory whole-assembly AST/IL expansion language in `design/20`; Tree-sitter remains an on-demand exact-source reading tool. This document does not supersede runtime Game Action safety gates.

## 1. Purpose

The next required completeness result is deliberately narrower than a primitive basis and stronger than a sampled source reading:

```text
exact target inputs are completely accounted for
≠ native operations are completely recovered
≠ native primitive basis is complete
≠ player gameplay/action coverage is complete
```

It answers only this architectural question:

> For the locked target assembly and content snapshot, has every source/content input been visibly accounted for, and do the currently known architecture entry/handoff registers point into exact source-owned areas rather than silently disappearing?

This is an **accounting** result, not a semantic classification result.

## 2. Required input universe

The universe begins before any gameplay relevance filtering:

```text
all `.cs` files emitted by the locked decompilation
+ every path in Content/ContentHashes.json
```

No `isGameplayType`, method-name pattern, known Action registry, primitive basis, `semanticFamily`, DataLoader allowlist, or content relevance allowlist may remove an input from this universe.

The current target run attests:

```text
Stardew Valley.dll: 1.6.15.24356
assembly SHA-256: 7f1e5b8e58d2758b78570ba771bbeb03d33522f62188bf6c32edf0cf626deaee
emitted C# files: 948
content-hash paths: 3560
```

Counts are snapshot facts, not a cross-version promise. The output binds all counts to a source manifest hash, `ContentHashes.json` hash, content manifest hash, locked `ilspycmd` version, and decompiler configuration digest.

## 3. What the current checker proves

`pnpm derive:stardew-native-action-architecture-map -- --game-path <path> --out <report>`:

1. fails closed unless the exact DLL version and SHA-256 match;
2. produces a fresh temporary source snapshot with locked decompiler provenance;
3. accounts every emitted source path exactly once by neutral path-owned cluster;
4. accounts every `ContentHashes.json` path exactly once by its top-level content-owned cluster;
5. requires an exact source anchor for every registered root and handoff boundary;
6. rejects duplicate/unsafe paths, duplicate register IDs, missing source anchors, and missing required root families;
7. records only source/content accounting and architecture anchors.

The root register currently includes evidence anchors for these **architecture mechanism families**, not gameplay actions:

```text
player-control
game-update
world-location
menu-event-minigame
content-dispatch
save-load
day-progression
network
```

The boundary register records source anchors for content, event, menu, save, and network handoff shapes. A boundary is not a resolved target, action, operation, callback graph, or lifecycle proof.

## 4. Current completion state

The output intentionally reports two states:

```text
inputAccountingState:
  source_and_content_input_accounting_complete

architectureAccountingState:
  incomplete_pending_exhaustive_root_and_handoff_review
```

The first claim is valid only when:

```text
unaccounted source paths = 0
multiply-accounted source paths = 0
unaccounted content paths = 0
multiply-accounted content paths = 0
```

The second state remains incomplete because the root and handoff registers are currently a reviewed **seed**, not a mechanically exhaustive enumeration of all architecture roots/handoffs. Calling it `architecture_accounting_complete` now would be false precision.

## 5. Next completeness obligation

Before deriving native operations or primitives, grow the root/handoff registers to an exhaustive **source architecture register**. Each row must have:

```text
neutral mechanism/boundary family
exact target source path
exact source anchor
source ownership cluster
```

Every register row must be one of:

```text
known source-owned architecture anchor
known external/native boundary
explicit architecture-ownership gap
```

The required final gate is not `unknown = 0`. It is:

```text
no source/content path silently omitted
no root without a source owner, boundary, or explicit gap
no handoff without a source owner, boundary, or explicit gap
no unresolved architecture owner hidden by an allowlist
```

Only then may the state become:

```text
architecture_accounting_complete
```

Even that status will not claim native operation, primitive, player-action, GameBuddy API, contract, live, publish, or gameplay completeness.

## 6. Explicit non-goals

This stage must not derive or contain:

```text
actionId / primitiveId / capabilityId
semantic family / player intent / behavior taxonomy
contract / receipt / evidence / authorization / policy
public API projection or implementation reuse
resolved call, dispatch target, field write, state mutation, CFG, or data-flow
full AST, IL database, full call graph, or automatic primitive extractor
```

Targeted Tree-sitter or IL inspection remains available only when a specific source ambiguity blocks architecture review; neither is a global prerequisite.

## 7. Relation to legacy documents

- `design/12`, `design/14`, `design/15`, `design/16`, `design/17`, and `design/18` remain historical product/source-audit material, not discovery inputs.
- `design/20` is narrowed to its implemented Tree-sitter source-reading canary. Its prior mandatory whole-assembly AST/IL expansion implication is superseded here.
- Existing runtime live/contract/publish gates remain unchanged and are not satisfied by this static accounting work.
