# Local Stardew automation tools

These scripts support repeatable local-co-op smoke preparation without editing game memory, save data, or multiplayer state.

## Portfolio environment runbook

Before running the isolated `single_player_native_companion` Portfolio gates, read [`fixtures/stardew/PORTFOLIO_ENVIRONMENT_RUNBOOK.md`](../fixtures/stardew/PORTFOLIO_ENVIRONMENT_RUNBOOK.md). It documents the P0a/P0b/P1c environment-variable layers, local path sources, process-local secret handling, native-scope provenance, Farmhand exclusions, and fail-closed gate order. It never records token values or signing material. Portfolio P0a/P0b/P1c runners do not load `.env.local`; set non-secret variables in the same PowerShell process that invokes the runner and inject secrets only for the duration of the required gate.

## Portfolio command-path governance and bounded source-audit dossiers

```powershell
pnpm test:stardew-portfolio-command-path-charter
pnpm check:stardew-portfolio-command-path-charter
pnpm test:stardew-portfolio-m1-source-audit
pnpm check:stardew-portfolio-m1-source-audit
pnpm test:stardew-portfolio-m2-source-audit
pnpm check:stardew-portfolio-m2-source-audit
pnpm test:stardew-portfolio-m3-source-audit
pnpm check:stardew-portfolio-m3-source-audit
```

`stardew-portfolio-command-path-charter` is the pre-Action governance model for the finite `Core Valley Milestone Portfolio v1`. It starts from the approved M1–M10 persisted predicates and freezes one parameterized, fresh-observation command-path family per scope atom. It refuses Action/catalog/registry inputs, raw UI, concrete recordings, cross-topology or candidate-evidence inheritance, duplicate scope mappings, source-impact gaps, and all closure claims.

The v1 Charter remains strictly **pre-realization**: every trace must be `unknown` or `disproven` with a blocking disposition, and it cannot project an Action/capability class. A future source-realization promotion requires a separately versioned dossier whose exact-target provenance and source anchors can be machine-revalidated; arbitrary hashes/strings in the Charter are not evidence.

The M1 route, M2 crop, and M3 forage/debris dossiers are narrow audit aids, not realization or release gates. Their checkers revalidate the pinned `design/16` authority hash, metadata recorded in `design/13`, and exact file/slice hashes from the committed decompilation snapshot. M1 records normal-player map-warp ingress, native warp request/pending/commit lifecycle, and content-driven route variability; it does not select a route, supply a route planner, or authorize coordinates. M3 explicitly preserves the unresolved partition question: spawned forage Objects use normal `tryToCheckAt → GameLocation.checkAction` delivery, while `Debris` uses a distinct automatic collection lifecycle. No dossier authorizes a bridge route, mutation, CCM row, live receipt, or publication. The local snapshot is not a target-version source-realization substitute.


## Gameplay capability catalog design guard

```powershell
pnpm check:gameplay-capability-catalog
pnpm test:gameplay-capability-catalog
```

These commands validate the versioned `design/gameplay-capability-catalog.json` **semantic catalog** with its canonical versioned Basis inputs. The checker requires every current published Stardew registry action to map to at least one `covered` intent variant with a closed parameter domain, native lifecycle/evidence boundary, aggregate result and explicit remaining-gap semantics. It rejects a `covered` row whose implementation is not published, validates composite primitive/coordination graph closure, and reports explicit `semanticCompleteness`: a passing result still does not mean every target-version player intent is implemented or live-verified.

This tool is not a runtime capability source. It must not grant an action, materialize a Host tool, alter Mod policy, or treat a catalog result as a production receipt. The primitive basis, target-version provenance limitation, and catalog semantics are documented in `design/11_GAMEPLAY_CAPABILITY_COVERAGE.md`, `design/12_STARDEW_PRIMITIVE_ACTION_BASIS.md`, and `design/13_STARDEW_NATIVE_PROVENANCE.md`.

## Direct target-game gameplay-surface inspection

```powershell
$env:GAMEBUDDY_STARDEW_GAME_PATH = "D:\\Steam\\steamapps\\common\\Stardew Valley"
pnpm inspect:stardew-gameplay-surface -- --pretty --out .tmp-stardew-gameplay-surface.json
pnpm check:stardew-gameplay-completeness -- --report .tmp-stardew-gameplay-surface.json
```

The inspector reads the supplied target installation's `Stardew Valley.dll` and `Content/ContentHashes.json`, verifies file version `1.6.15.24356`, computes the assembly hash, and temporarily decompiles the exact DLL with the local `ilspycmd`. It emits only a redacted report: no absolute installation path, game binary, save, or content file is copied into the repository. A mismatched or missing target fails closed.

The inspector is a **focused native capability-audit and version-drift diagnostic**, not a global gameplay-completeness proof. It reads `StardewValley.Game1.UpdateControlInput`, source branches, selectors, menu/minigame surfaces and target-game `DataLoader` tables only to find evidence for a proposed player-meaningful capability: the human native rule/guard, finite domain, lifecycle and result boundary. It never creates keyboard/mouse injection, UI reading, window focus, runtime actions, or an action simply because a method/selector was discovered.

## Tree-sitter C# syntax structural canary

```powershell
pnpm derive:stardew-csharp-syntax-structural-canary -- `
  --game-path $env:GAMEBUDDY_STARDEW_GAME_PATH `
  --out .tmp-stardew-csharp-syntax-structural-canary.json
node --test tools/stardew-csharp-syntax-structural-canary.test.mjs
```

This is the first, deliberately narrow input to a future version-locked **Native Structural Map**. It verifies the exact pinned `Stardew Valley.dll` file version and SHA-256, temporarily decompiles it, then parses a fixed, lexically ordered manifest of three complete source files: `StardewValley/Object.cs`, `StardewValley/TerrainFeatures/HoeDirt.cs`, and `StardewValley/Tools/FishingRod.cs`. The manifest locks each relative path, source byte length, source SHA-256, expected top-level declaration, `ilspycmd` version, and decompiler configuration digest; any mismatch fails closed. Parsing is sequential through the cross-platform `web-tree-sitter` runtime and a version-pinned C# WASM grammar. The emitted report contains only concrete C# syntax facts: declaration and source-span locators, syntax body hashes, `if`/`switch`/`return`, invocation-expression syntax/argument hashes, and assignment-expression left/right syntax hashes. Parse errors and missing syntax nodes fail closed.

It intentionally does **not** identify actions, primitives, native operations, semantic families, contracts, receipts, GameBuddy projections, code reuse, resolved calls, field writes, state mutations, control-flow semantics, or IL/metadata identity. A Tree-sitter AST proves only the syntax of this decompiler output; it does not prove runtime behavior. The report never includes an installation path, game binary, full proprietary source text, UI interaction, runtime action, save, bridge request, or Game Action publication. IL/metadata inspection may be used later only when a concrete source ambiguity requires it; it is not a whole-assembly prerequisite.

## Stardew native action architecture accounting

```powershell
pnpm derive:stardew-native-action-architecture-map -- --game-path $env:GAMEBUDDY_STARDEW_GAME_PATH --out .worktree/stardew-native-action-architecture-map.json
node --test tools/stardew-native-architecture-accounting.test.mjs
```

This is the current lightweight completeness foundation. It attests the exact target, a fresh decompiler snapshot, **all** emitted `.cs` paths, and **all** `Content/ContentHashes.json` paths before applying any gameplay-relevance classification. Every input path is accounted for once in a neutral source/content ownership cluster; registered architecture-root and handoff anchors must exist in exact source. It intentionally reports `architectureAccountingState: incomplete_pending_exhaustive_root_and_handoff_review` until that register has itself been exhaustively audited. It does not build a full AST/IL/call graph or infer actions, primitives, behaviors, state writes, contracts, policies, receipts, projections, or reuse. See `design/21_NATIVE_ACTION_ARCHITECTURE_ACCOUNTING.md`.

## Stardew native interaction-mechanism enumeration

```powershell
pnpm derive:stardew-native-interaction-mechanisms -- --game-path $env:GAMEBUDDY_STARDEW_GAME_PATH --out .worktree/stardew-native-interaction-mechanisms.json
node --test tools/stardew-native-interaction-mechanisms.test.mjs
```

This is Stage 1 of `design/22_NATIVE_PRIMITIVE_DERIVATION_EXECUTION_PLAN.md`. From a fresh exact-target decompile it retains neutral source-syntax matches for native host declarations, content interpreters, and continuation shapes. Source files with Tree-sitter parse errors are emitted as explicit `parseGaps` rather than silently skipped. The report does **not** resolve an owner, dispatch target, transition, primitive, player operation, content behavior, or public Action. Its raw match counts are a review universe, never action/primitive counts.

The raw syntax report is then reduced mechanically to an exhaustive **mechanism-family index**, rather than being manually reviewed one row at a time:

```powershell
pnpm derive:stardew-native-mechanism-family-register -- `
  --mechanism-report .worktree/stardew-native-interaction-mechanisms.json `
  --out .worktree/stardew-native-mechanism-families.json
pnpm test:stardew-native-mechanism-family-register
```

Each raw match belongs to exactly one row keyed by neutral discovery category, pattern family and source cluster. The index records exact member IDs, source paths, syntax state and lexical syntax facts. It does **not** decide whether a family is a gameplay mechanism, resolve its owner, or infer a transition; an unreviewed family remains blocking. It exists to make the next source review unit a dispatcher/owner/continuation family rather than thousands of individual syntax matches.

The older semantic-kernel, atlas and tool-ledger sections below are historical exploratory source-audit artifacts. Do not extend them as the current discovery pipeline; they are retained solely for their exact-target/provenance mechanics and source-anchor experiments.

## Native normal-player ingress / caller register

The family index cannot select roots by directory or method name. The next source-first artifact therefore admits a root only through an exact target-version native entrypoint, exact caller callsite, input-state/guard witness, and source-order router exit inventory:

```powershell
pnpm test:stardew-native-normal-player-ingress-register
pnpm check:stardew-native-normal-player-ingress-register -- `
  --register <exact-ingress-register.json> `
  --mechanism-report .worktree/stardew-native-interaction-mechanisms.json `
  --source-root .tmp-stardew-decompile
```

It records framework/native entrypoints, direct/virtual/interface/delegate/content caller edges, input provenance, exact branch guards, root candidates and explicit parse/dynamic gaps. It cannot emit Actions, primitives, transitions, contracts or semantic families. A dynamic call target, partial router inventory or parse ambiguity is blocking rather than being guessed from a file path, method name or static caller count.

`derive:stardew-native-normal-player-ingress-control-slice` is a deliberately **partial**, source-anchored derivation for the direct normal-control exits currently witnessed in `Game1.UpdateControlInput`:

```powershell
pnpm derive:stardew-native-normal-player-ingress-control-slice -- `
  --mechanism-report .worktree/stardew-native-interaction-mechanisms.json `
  --source-root .tmp-stardew-decompile `
  --out .worktree/stardew-native-normal-player-ingress-control-slice.json
```

It establishes exact caller/input witnesses for `pressActionButton`, `pressUseToolButton`, `pressSwitchToolButton`, `Farmer.FireTool`, and `Farmer.setMoving`; it deliberately retains the mutable hook, event receiver, and all other un-inventoried `UpdateControlInput` exits as closure-blocking gaps. Those five direct dispatch targets are roots of further native analysis, not player Actions or primitives.

Before one of those roots is source-owner reviewed, use the neutral router invocation inventory to get a complete syntax-level callsite queue for the **one exact method body**:

```powershell
pnpm derive:stardew-native-router-invocation-inventory -- `
  --source-root .tmp-stardew-decompile `
  --source-path StardewValley/Game1.cs `
  --signature "public static bool pressActionButton(KeyboardState currentKBState, MouseState currentMouseState, GamePadState currentPadState)" `
  --out .worktree/press-action-invocations.json
```

The inventory is source ordered and byte-attested, but does not resolve overloads, receivers, guards, owners, transitions, or relevance. It prevents a source review from accidentally skipping a lexical invocation while keeping every dynamic target unclassified until its own exact-source analysis. Its `syntaxInventoryState` is only parse-clean for errors that overlap the exact router body; unrelated parser gaps elsewhere in the same decompiled source file remain recorded in the report but do not invalidate this bounded lexical inventory.

Use `check:stardew-native-router-exit-classifier` to require one neutral disposition for each inventoried callsite. Direct source handoffs require exact target anchors; dynamic dispatches remain blocking gaps; source-local mutation regions stay source regions pending owner/continuation recovery. This classifier is still below transition/primitive/API level.

`stardew-native-event-continuation-trace` and `stardew-native-field-continuation-trace` are equally narrow follow-up witnesses. The first binds an exact event field, registration, `Fire`, `Poll`, and handler source anchors; the second binds a field declaration with exact writer, consumer, and clearer source anchors. Neither turns an event callback, a field write, or a cross-frame consumer into a transition, primitive, or public action. They make the continuation source handoff inspectable before that later analysis.

## Source-attested state-machine family register

The invocation, receiver, event, and field artifacts above are **evidence guards**, not work units. The current source-first unit is an exact native lifecycle/state-machine family: a small ordered slice from attested ingress through source owner(s), native handoff/resume mechanism(s), and explicitly retained dynamic gaps.

```powershell
pnpm derive:stardew-native-state-machine-family-register -- `
  --source-root .tmp-stardew-decompile `
  --out .worktree/stardew-native-state-machine-families.json
pnpm test:stardew-native-state-machine-family-register
```

The register is a source-attested discovery ledger, not a transition, primitive, player operation, or Action. It records exact source anchors and preserves unresolved dynamic edges. Its initial exact-target report has 12 deliberately partial families: player tool-event lifecycle; held-item selection; location interaction precedence; item placement/stow routing; object/terrain routing; movement; map-action content interpretation; event command protocol; menu host; minigame host; save/load; and new-day/network barrier protocol. It is only the bridge from source-callsite evidence to Stage 2.

Use the Stage-2 `native_transition_family_universe` artifact for the actual source-family work queue:

```powershell
pnpm derive:stardew-native-transition-family-universe -- `
  --source-root .tmp-stardew-decompile `
  --definitions .worktree/transition-family-universe-definitions.json `
  --out .worktree/stardew-native-transition-family-universe.json
pnpm test:stardew-native-transition-family-universe
```

A universe row has exact source-owned regions, complete exit inventories and explicitly blocking dynamic/content/continuation gaps. It is intentionally unable to state a transition identity, primitive, equivalence class, player operation, or Action. The work completes only after each in-scope normal-player family has a source-derived transition/protocol closure—or a remaining blocking gap. Only after that closure can a separately frozen GameBuddy semantic-equivalence standard compare actor/target typing, authoritative post-state, pending native continuation, authority, cancellation/replay, typed failure and required evidence to derive an internal basis and then public Actions.

The approved completion claim is version-locked, scope-bounded conservative completeness and relative minimality; see `design/23_BOUNDED_SOURCE_FIRST_ACTION_BASIS_SCOPE.md`. Use `check:stardew-native-source-closure -- --certificate <certificate.json>` only to validate that every dynamic edge is explicitly `source_resolved`, `runtime_modeled`, `approved_scope_boundary`, or `unknown_blocking`. An `unknown_blocking` edge prevents `bounded_source_closure_complete`; static source work never establishes public Action live/publish evidence.

`derive:stardew-native-virtual-receiver-register -- --source-root <exact-decompile> --method <Tool virtual member> --out <report.json>` mechanically enumerates direct source `Tool` subclasses and source-visible overrides for one of `leftClick`, `beginUsing`, `DoFunction`, `onRelease`, or `endUsing`. It is a receiver-declaration universe, not a proof that every subtype is constructible, equipped, normal-player reachable, behaviorally equivalent, or a distinct action. Any indirect/multiple-declaration uncertainty stays explicit rather than becoming a resolved dispatch claim.

`derive:stardew-native-virtual-member-invocation-register -- --source-root <exact-decompile> --method <Tool virtual member> --out <report.json>` then inventories all invocation syntax within the exact `Tool` base virtual body and every direct-source visible override. Invocation-free bodies are retained as a valid empty inventory; that fact also has no semantic interpretation. The report still does not resolve runtime receivers, overloads, state effects, continuation ownership, transitions, primitives, or public actions.

`derive:stardew-native-completion-event-register -- --source-root <exact-decompile> --definitions <events.json> --out <report.json>` records exact local NetEvent completion wiring for a deliberately supplied source set: declaration, `onEvent` registration, every local `Fire`, every local `Poll`, and handler declaration. Its report establishes neither event-delivery timing nor terminality. `stardew-native-tool-owner-slice` is the fail-closed validator used by later source review: every invocation in one virtual implementation must receive exactly one neutral source-owner record, with dynamic targets still retained as blocking gaps. `stardew-native-tool-update-dispatch-boundary` proves only whether the exact visible `Tool.Update` receiver universe has any override. `stardew-native-farmer-sprite-callback-boundary` proves only that `FarmerSprite` stores an end callback and later invokes that stored delegate from per-frame animation update; it does not resolve callback identity or treat the callback as completion.

## Source-owned transition / continuation ledger

```powershell
pnpm derive:stardew-native-mechanism-review-register-template -- `
  --mechanism-report .worktree/stardew-native-interaction-mechanisms.json `
  --out .worktree/stardew-native-mechanism-review-register.json
# The generated all-gap template is intentionally blocking until source review
# assigns each row one exact disposition.
pnpm test:stardew-native-mechanism-review-register
pnpm check:stardew-native-mechanism-review-register -- `
  --mechanism-report .worktree/stardew-native-interaction-mechanisms.json `
  --register <complete-exact-review-register.json> `
  --source-root .tmp-stardew-decompile

pnpm test:stardew-native-transition-ledger
pnpm check:stardew-native-transition-ledger -- `
  --ledger tools/stardew-native-transition-ledger.fixture.json `
  --mechanism-report .worktree/stardew-native-interaction-mechanisms.json `
  --review-register <complete-exact-review-register.json> `
  --scope-manifest <approved-exact-scope-manifest.json> `
  --source-root .tmp-stardew-decompile
```

This is the Stage-2 ledger schema from `design/22_NATIVE_PRIMITIVE_DERIVATION_EXECUTION_PLAN.md`, not a primitive extractor. Before a root can be scoped, the exact report must have a complete Stage-1 review register: each raw match gets exactly one source-anchored disposition, and Stage 2 accepts only explicit `in_scope_*` rows. A scoped ledger binds those reviewed IDs to source routers, source-owned transitions, owner-managed pending native continuations, approved scope-exclusion boundaries, or explicit unresolved gaps. Every source node has ordered, typed, source-anchored handoffs (`direct_call`, conditional, virtual/delegate, content, event registration, update resume, or external) plus a one-to-one exit inventory; an `exhaustive` claim cannot contain an unresolved exit, while a partial region must source-anchor its omitted exit to an explicit unresolved gap. The checker reopens the fresh exact decompile supplied through `--source-root` and validates each report/review locator and anchor against byte spans, slice hashes, member identifiers, and complete-file hashes—not merely asserted filenames. A source-owned transition must retain exact owner/commit source anchors and two narrowly source-derived observation sets:

```text
postStateObservations
pendingNativeContinuationState
```

The former records source-owned state which native gameplay later reads; the latter records pending state already registered for a native update/event/day/save/network continuation. Neither is a whole-heap model, player-visible outcome comparison, contract, receipt, or GameBuddy capability. The checker rejects stale target/source attestation, malformed source manifests, incomplete/stale review registers, unknown or duplicated scoped mechanism IDs, unreviewed/excluded root injection, empty routers, unordered/dangling handoffs, unanchored conditional exits, incomplete exit inventories, partial exits without a gap, orphan transitions, absent commits/continuation registration/resume state, forbidden public API vocabulary, and any `native_transition_closure_complete` claim with an unresolved gap. A terminal `scope_exclusion_boundary` must exactly cite a version-locked scope-manifest row. The approved `normal_player_vanilla` scope never permits virtual dispatch, delegate, content lookup, event registration, or external paths to be silently excluded; they remain gaps until source-expanded. The included fixture deliberately stays `partial`: it demonstrates the `Game1.pressSwitchToolButton → Farmer.CurrentToolIndex` source transition and retains its polymorphic item callback as a blocking gap.

## Source-first semantic-kernel prototype

```powershell
pnpm derive:stardew-soil-kernel -- --game-path $env:GAMEBUDDY_STARDEW_GAME_PATH --out .tmp-stardew-soil-kernel.json
node --test tools/stardew-source-semantic-kernel.test.mjs
```

`derive:stardew-soil-kernel` is a bounded proof-of-method over the exact `1.6.15.24356` assembly. It re-decompiles the locally installed DLL, requires source anchors for the normal player ingress plus `Hoe`, `WateringCan`, `Object`, `Utility`, `HoeDirt`, and `Crop`, then produces a redacted factorization of the soil-tile domain. It demonstrates a source-derived reusable `soil.apply_input` kernel with the closed `seed | fertilizer` union behind today's separately published `plant_seed` and `fertilize_tile` contracts; tilling, watering, and grab harvesting remain distinct source-derived kernels.

This report is **not** an action migration, registry input, runtime capability source, or a live gate. It must fail closed when any required target-version anchor drifts. A future API merge still requires policy/receipt compatibility review, typed bridge-equivalence proof, and formal native AI-Farmhand live evidence for every non-equivalent kernel and each discriminated input variant. The tool never starts the game, loads a save, reads a UI, or invokes a runtime action.

## Trace-first Interaction Transition Model (ITM) canary

```powershell
pnpm derive:stardew-soil-itm-canary -- `
  --source-root .tmp-stardew-decompile `
  --out .worktree/stardew-soil-itm-canary-report.json
pnpm test:stardew-soil-itm-canary
```

This canary tests the alternate, evidence-backed derivation method documented in `research/2026-08-action-basis-methods.md`: its normative input is a finite set of required, observable player interaction traces, **not** the prior action registry/catalog or a source call graph. The derivation then uses only the source files named by each class as a version-locked native-realization witness; the generated source manifest and every witness span are checked fail closed.

The current soil canary contains five independently necessary interaction classes (`till`, seed establishment, fertilizer establishment, watering, and ordinary grab harvest) plus an explicit native day-progression/fresh-observation protocol. It records both pairwise separation obligations and per-class deletion counterfactuals. It deliberately retains seed and fertilizer as separate labels because their target sort, commit, continuation, failure, and evidence obligations differ, even though they share a native implementation path. It does not read legacy catalog/registry identifiers when deriving interaction classes, derive or publish an Action, grant a capability, or substitute for any real-game live gate.

`assess:stardew-soil-itm-conformance` separately maps the five already-materialized bridge routes to the ITM labels solely to audit the **projection**. It reports incomplete unless independently recorded exact-target live cases satisfy every modelled observable commit; it deliberately does not reinterpret source/static checks or existing publication as live evidence.

## Whole-game source discovery atlas

```powershell
pnpm derive:stardew-semantic-kernel-atlas -- --game-path $env:GAMEBUDDY_STARDEW_GAME_PATH --out .tmp-stardew-semantic-kernel-atlas.json --pretty
node --test tools/stardew-source-semantic-kernel-atlas.test.mjs
```

The atlas runs the same exact-target inspection, then faithfully ledgers **every command-boundary candidate that the conservative inspector currently emits**—not an asserted complete list of Stardew actions. It preserves every candidate's ingress, native-boundary label, source locus, selector and unresolved bridge state; it also records 501 static gameplay-shaped nodes, content-operation families and `DataLoader` domains as independent pending universes. Repeated source loci yield only `implementation_reuse_observed_semantic_kernel_unproven` hypotheses: source reuse is useful prioritization evidence, but never silently merges public interfaces such as `plant_seed` and `fertilize_tile`.

The resulting whole-game report has state `source_discovery_partial` until every unresolved source/selector/content path has an effect summary and typed route. It intentionally does **not** claim all player-achievable behavior has been discovered, that a candidate is an action, that source clones share policy/receipt semantics, or that an action is live/publish verified. It never invokes a raw dispatcher, menu, minigame, UI or runtime action.

## Tool-family effect-summary ledger

```powershell
pnpm derive:stardew-tool-effect-ledger -- --game-path $env:GAMEBUDDY_STARDEW_GAME_PATH --out .tmp-stardew-tool-effect-ledger.json
node --test tools/stardew-tool-effect-ledger.test.mjs
```

This is the atlas's first Stage-B slice: exact target-version effect summaries for `Hoe`, `Axe`, `Pickaxe`, `WateringCan`, `Pan`, `FishingRod`, and `MeleeWeapon`. Each summary states typed inputs, guards, anchored writes, lifecycle, explicit unknown sinks, implementation-reuse hypotheses, and the fact that its public projection is `not_inferred`. It proves neither generic tool APIs nor a public action merge: `water_crop` remains deliberately narrower than the Watering Can's heterogeneous multi-tile source loop, and all target dispatch, content/RNG, event and timing gaps remain fail-closed work.

The report's early source-derived Player-Reachable Command Path (PRCP) graph and `boundary_candidate` entries remain diagnostic research evidence. They must not be expanded until every internal edge is classified, and `check:stardew-gameplay-completeness` is deliberately a fail-closed **research diagnostic**, not a required green release gate. Capability-set decisions instead follow source-derived semantic reuse where it is proven, then use composite/coordination/content contracts where the native semantic graph requires them. Each materialized capability still needs its own contract, formal native AI-Farmhand live run, terminal receipt, fresh postcondition and recovery before it is covered/published. `performAction(any string)` and all raw dispatcher/UI paths remain prohibited.

## Removed UI/XInput automation

`drive-stardew-ui.ps1` and `check-xinput.ps1` were removed. They focused a Stardew window and injected keyboard/mouse/XInput-adjacent interaction, which conflicts with the formal non-UI AI-Farmhand boundary. Attachment, fixtures, action gates, and PRCP audit never use window focus, visual inspection, OS input injection, or local split-screen automation.

The scripts do not install drivers, inject a Farmer, edit saves, bypass Steam, or emulate multiplayer packets. A driver-backed virtual XInput device must be provisioned separately and deliberately by the operator.

## Formal Phase 1 prerequisite gate

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/check-stardew-phase1-prerequisites.ps1
```

This reports whether the licensed Stardew/SMAPI installation, separate Host and AI-client Mod profiles, shared session directory, and exact native Farmhand ID are configured. If `GAMEBUDDY_STARDEW_GAME_PATH` is not exported, pass the installed directory explicitly with `-GamePath`. The deployed `Mods/GameBuddy/config.json` is used as the Host profile by default; pass `-AiClientModConfigPath <path>` for the separately controlled AI-client profile, plus `-SessionDirectory <absolute-path>` and `-ExpectedFarmhandId <native-id>` (or set the matching environment variables). Add `-RequireRunningClients` only for a real two-process `@game` run. A blocked result is expected when the environment is not provisioned; the script never treats the diagnostic probe, a single client, or a static/compile check as proof of the BDD scenarios for provisioning, save/reconnect, day transition, scope, or host-visible synchronization.

## Attachment regression

For a fully provisioned local save, `run-stardew-attachment-regression.ps1` runs the non-UI Host-first attachment regression: initial signed request, native `Saving/Saved`, AI-client entry, client-exit save, same-Host reconnect, Host restart nonce rotation, old-manifest rejection, and a new signed attachment after restart. The Host profile used by this runner must explicitly enable `HostAutomation.TriggerNativeSaveAfterAttachment` and `HostAutomation.TriggerNativeSaveAfterClientExit`; these are test-fixture switches and must remain disabled in a production Host profile.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/run-stardew-attachment-regression.ps1 `
  -GamePath "D:\\Steam\\steamapps\\common\\Stardew Valley" `
  -HostModsPath "C:\\Users\\you\\AppData\\Local\\GameBuddy\\stardew-profiles\\A-host" `
  -AiClientModsPath "C:\\Users\\you\\AppData\\Local\\GameBuddy\\stardew-profiles\\A-ai-client" `
  -HostConfigPath "C:\\Users\\you\\AppData\\Local\\GameBuddy\\stardew-profiles\\A-host\\GameBuddy\\config.json" `
  -SaveName "A_445094166" -ExpectedFarmhandId "native-id" `
  -SessionDirectory "C:\\Users\\you\\AppData\\Local\\GameBuddy\\stardew-session-A"
```

The runner does not use Computer Use, keyboard injection, or UI navigation. It only starts isolated SMAPI profiles, reads the signed session exchange, invokes the existing Companion App attachment flow, and asserts native game-thread/log evidence.

## Native-local action runners

Farmhand action runners are selected only through `tools/stardew-action-gate-descriptors.mjs`. Each published action resolves to one `run-stardew-native-local-player-*-smoke.mjs` runner, which uses the shared `stardew-native-smoke-harness-v1.mjs` connection, receipt, fresh-reread, and teardown mechanics. The disposable fixture launcher selects the same runner identity:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/run-stardew-native-local-player-move-fixture.ps1 `
  -GamePath "D:\\Steam\\steamapps\\common\\Stardew Valley" `
  -ModsPath "C:\\Users\\you\\AppData\\Local\\GameBuddy\\stardew-fixture-mods" `
  -FixtureRoot "C:\\Users\\you\\AppData\\Local\\GameBuddy\\stardew-fixtures" `
  -SaveName "GameBuddyFixture_445094166" `
  -Action equip_tool
```

The runner never enables capabilities itself. A passed result requires its exact action-specific terminal evidence and fresh postcondition; it is not a release or whole-product acceptance claim.

## Windows TTS output gate

The Gateway can use the current Windows default render device only when both a
bounded MiMo provider probe and a real `waveOut` open/write/completion check
succeed. `default` means Windows resolves its current default device on every
open; an explicit `waveout:N` selection never silently falls back.

```powershell
$env:MIMO_API_KEY = '<process-local key>'
node tools/run-windows-voice-output-gate.mjs `
  --device default --voice Chloe --port 49739 `
  --token '<16+ opaque local token>'
```

The runner starts a temporary Gateway, obtains authenticated health, and exits
zero only if the MiMo probe returned PCM and the selected Windows device
accepted/completed the write. It never records provider audio, text, or the
credential.

## Windows PTT input gate

```powershell
node tools/run-windows-voice-input-gate.mjs --device default --duration-ms 1000
```

The input gate opens the current Windows default capture device (or a strict
`wavein:N` selection), starts a bounded 16 kHz mono PCM16 recording and checks
that the driver returns a non-empty frame. It does not save PCM or invoke ASR.
In the real Gateway this adapter is mountable only after the operator-provided
Fun-ASR asset manifest passes SHA-256 audit; local PCM is pulled inside the
Gateway at PTT stop and never sent through Host protocol. A full speech-input
pass requires the separately audited Fun-ASR native runtime, encoder, decoder,
and VAD assets plus a real final transcript gate.

## Windows PTT → final transcript gate

```powershell
node tools/run-windows-sensevoice-final-transcript-gate.mjs `
  --manifest "$env:LOCALAPPDATA\GameBuddy\voice-assets\funasr-llamacpp\sensevoice-assets.manifest.json" `
  --device default `
  --port 49741 `
  --token '<16+ opaque local token>' `
  --duration-ms 4000
```

This one-shot, loopback-only gate verifies local asset hashes, opens the selected
PTT device, invokes native Fun-ASR, and accepts only a sanitized
`final_transcript` event from authenticated Gateway polling. It never prints raw
audio or transcript text. Silence/no-speech remains `blocked`, never success.
The runner has no option to display, compare, hash, persist, or otherwise derive
a correctness metric from user speech; users assess any local transcription only
in their own product UI.

## Fun-ASR offline regression baseline

```powershell
node tools/run-funasr-offline-baseline.mjs `
  --manifest "$env:LOCALAPPDATA\GameBuddy\voice-assets\funasr-llamacpp\sensevoice-assets.manifest.json"
```

This gate uses the vendored, Apache-2.0 `FunAudioLLM/Fun-ASR` fixed 6-second
Chinese regression clip and its frozen upstream reference text. It SHA-256 audits
both source fixture files and requires an exact normalized text match. It exposes
lengths and match state only, never transcript content. This exact comparison is
permitted only because the fixture and reference are public, upstream-provided,
and Apache-2.0 licensed. Passing this model/runtime baseline does not establish
microphone accuracy; user speech must never be matched, hashed, scored, or
reported by a validation runner.

For the currently verified bridge/ledger guards, run:

```powershell
node tools/run-stardew-bridge-ledger-smoke.mjs `
  --client-config "C:\\Users\\you\\AppData\\Local\\GameBuddy\\stardew-profiles\\A-ai-client\\GameBuddy\\config.json"
```

This checks a stale revision rejection, idempotency-key conflict rejection, and a final Tool restore through the formal named-pipe bridge.


## Ongoing-interaction Historian authoring gate

`run-ongoing-interaction-historian-authoring.mjs` is a provider-backed
verification of the Magic Context fork's Historian authoring path. It creates a
fresh GameBuddy-owned temporary runtime and in-memory test DB, obtains the
configured model only through that runtime's embedded Pi SDK registry, and
directly exercises the fork's native Historian publication pipeline. It is
intentionally not the normal long-context trigger: production scheduling stays
unchanged and enables the same embedded, no-tool Historian only when Magic
Context's own context-pressure scheduler requires it.

```powershell
node tools/run-ongoing-interaction-historian-authoring.mjs
```

A pass executes two native Magic Context scenarios: a one-off Episodic fixture
must publish a compartment with zero `SEMANTIC_MEMORY` rows while
`auto_promote=false`; a separately explicit, confirmed durable-preference
fixture must publish exactly one scoped `SEMANTIC_MEMORY` row only with the
test-gate's `auto_promote=true`. This verifies Magic Context's existing
promotion semantics. GameBuddy selects Magic Context's native product
`auto_promote` setting and automatic embedded Historian authoring. Magic
Context alone decides when normal product sessions are under sufficient context
pressure to run it. The Historian has no tools, browser surface, Game surface,
Host Memory API, or system `pi` CLI path. Output contains only counts and gate
state, never
model text or credentials. A failure is a bounded non-zero exit and does not
change product configuration.
