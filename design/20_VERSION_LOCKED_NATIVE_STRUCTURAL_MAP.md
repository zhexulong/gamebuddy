# 20 Version-Locked Native Structural Map

> **Status:** constrained source-reading canary. `design/21_NATIVE_ACTION_ARCHITECTURE_ACCOUNTING.md` is the current native-architecture completeness methodology and supersedes this document's former whole-assembly AST/IL expansion implication. This replaces neither runtime Game Action gates nor their existing authorization/evidence constraints.

## 1. Decision

GameBuddy must not derive Stardew primitives from an existing action catalog, player-facing names, manually labelled ingress candidates, shared helpers, or an early contract/effect/reuse analysis.

The first normative discovery artifact is instead a version-locked **Native Structural Map** of mechanically verifiable assembly/source facts. It precedes every native operation model and primitive basis.

```text
exact target assembly + content provenance
→ Native Structural Map
→ source-owned native operation structure
→ native primitive basis
→ native player-operation composition
→ GameBuddy public Action API
→ authorization / receipt / contract / real-game live / publish gates
```

The direction is one-way. No existing GameBuddy action, public receipt, policy, candidate name, or implementation helper may decide a node or boundary in the structural map.

## 2. Current first canary

The first canary is deliberately smaller than a whole-game index:

```text
exact Stardew Valley.dll
→ version and SHA-256 verification
→ deterministic temporary ilspycmd decompilation
→ fixed, source-attested complete-file manifest:
  StardewValley/Object.cs
  StardewValley/TerrainFeatures/HoeDirt.cs
  StardewValley/Tools/FishingRod.cs
→ Tree-sitter C# concrete-syntax report
```

It emits only:

```text
source file + byte hash
AST declaration syntax and locators
body locators and hashes
if / switch / return syntax
invocation-expression syntax
assignment-expression syntax
member-access assignment-target syntax
parser / grammar / decompiler provenance
parse error and missing-node facts
```

It must not emit or infer:

```text
action
primitive
operation taxonomy
semantic family
player intent
target / guard / effect semantics
contract / receipt / evidence
public projection
capability / policy
implementation reuse
resolved call or runtime dispatch
field write / state mutation
IL or metadata identity
control-flow or data-flow semantics
```

This is a concrete-syntax parser experiment, not a semantic extractor. It can replace unsafe regex-based declaration extraction, but it cannot replace a later IL/metadata layer.

## 3. Why this comes before primitive discovery

Source authority does not imply source syntax is already a primitive catalog:

- one method can contain several guarded syntactic regions;
- one method can invoke different dispatch/lifecycle paths;
- one native lifecycle can span multiple methods, update callbacks and events;
- virtual/interface calls, content lookup, delegates, reflection, NetCode and save/network callbacks cannot be resolved from syntax alone.

The structural map records those facts before making any claim that a region is an operation or a primitive. Later operation reconstruction may use state ownership, guarded regions, explicit delegation and continuation ownership—but that is a distinct phase.

## 4. Legacy artifact status

The following are now **historical exploratory artifacts**, not normative inputs to native discovery:

```text
design/12_STARDEW_PRIMITIVE_ACTION_BASIS.md
design/14_STARDEW_PLAYER_COMMAND_COVERAGE_AUDIT.md
design/15_STARDEW_CAPABILITY_SET.md
design/16_SOURCE_FIRST_SEMANTIC_KERNEL_PROTOTYPE.md
design/17_WHOLE_GAME_SOURCE_FIRST_SEMANTIC_KERNEL_ATLAS.md
design/18_TOOL_FAMILY_SOURCE_EFFECT_LEDGER.md
tools/derive-stardew-soil-kernel.mjs
tools/derive-stardew-semantic-kernel-atlas.mjs
tools/derive-stardew-tool-effect-ledger.mjs
```

They retain historical source anchors, provenance experiments and future player-intent/API comparison value. They must not supply structural-map IDs, partitions, node labels, completion measures, primitive definitions, or future work queues. In particular, `207` denotes only an old extractor output and is not a behavior, operation, primitive, or action count.

## 5. Canary acceptance requirements

The Tree-sitter canary is accepted only if it:

1. verifies the fixed target file version and assembly SHA-256;
2. verifies a lexically ordered, version-controlled manifest of complete source files by relative path, byte length, SHA-256, and expected top-level declaration;
3. records and locks decompiler and parser/grammar provenance;
4. rejects parser errors and missing syntax nodes in every manifest source;
5. preserves distinct declarations (including overloads and nested declarations) with byte-exact locators;
6. retains branch, invocation and assignment *syntax*—including callee/argument and left/right expression hashes—without upgrading it to semantic claims;
7. emits no target installation path or proprietary source slice/text;
8. has fixture coverage for malformed syntax, nested declarations, overloads, branches, invocations, assignments and deterministic output;
9. makes no native behavior, primitive, API, contract, authorization, live-gate or coverage claim.

A passing canary proves only that this parser/runtime/grammar combination can structurally parse one exact target decompiler output.

## 6. Gates before whole-assembly expansion

Do not scale to the assembly until the structural representation can demonstrate, without special gameplay labels:

```text
one method with multiple guarded syntactic regions
nested/overloaded declarations
syntax-level polymorphic call sites retained unresolved
multi-method lifecycle references represented as references, not operations
content and event/delegate syntax retained without semantic guesses
parse/decompile/target drift fails closed
```

A later IL/metadata inspection may be used when a concrete source ambiguity blocks a review of canonical CLR identity, `call`/`callvirt`, real field access, override resolution, a control-flow graph, or a source-owned native operation structure. It is not a mandatory whole-assembly prerequisite.

## 7. Initial parser calibration result

A one-off, non-normative local calibration parsed the current exact-decompiler output for all `948` emitted `.cs` files with the same parser adapter. It found `940` parse-clean files and `8` files containing Tree-sitter `ERROR` nodes: `Game1.cs`, `Menus/CoopMenu.cs`, `Menus/FarmhandMenu.cs`, `Menus/SaveGameMenu.cs`, `Menus/TitleMenu.cs`, `Options.cs`, `SaveGame.cs`, and `StartupPreferences.cs`.

This is not an assembly-wide map and does not identify any native behavior. It establishes the necessary fail-closed expansion rule: a future whole-assembly structural index must report these syntax incompatibilities explicitly and cannot silently omit, repair, or semantically interpret them. Parser/grammar upgrades require a new version-locked calibration and manifest review.
