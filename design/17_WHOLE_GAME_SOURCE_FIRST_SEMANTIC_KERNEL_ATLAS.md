# 17 Whole-Game Source-First Semantic-Kernel Atlas

> **Status:** target-version static discovery artifact and methodology result. It does not change a public Game Action, authorization policy, capability registry, bridge route, receipt schema or release gate.
>
> **Target:** Stardew Valley `1.6.15` build `24356`, `Stardew Valley.dll` SHA-256 `7f1e5b8e58d2758b78570ba771bbeb03d33522f62188bf6c32edf0cf626deaee`.

## 1. Decision: implementation reuse and public semantic interfaces are separate

The soil prototype established one source-derived reusable kernel:

```text
Utility.tryToPlaceItem → Object.placementAction → HoeDirt.plant
```

for the closed native input union:

```text
seed | fertilizer
```

The public interfaces deliberately remain distinct:

```text
plant_seed
fertilize_tile
```

They carry materially different user intent, target predicates, failure explanations, postconditions and receipt evidence. Source reuse is valuable for implementation factorization, proof reuse where the branch is genuinely identical, and test planning. It does **not** force public interface coalescing.

The governing rule is therefore:

```text
Same source locus / implementation kernel
≠ same public Game Action.

A public action merge requires independent equality of authority,
typed preconditions, lifecycle, terminal-state algebra,
receipt/evidence contract and cancellation/replay behavior.
```

Absent that proof, retain separate interfaces—even if they call exactly the same native source method with a discriminant.

## 2. Why a whole-game atlas precedes a whole-game kernel basis

The target source can tell us much more than a manually maintained gameplay-name catalog:

```text
normal-player ingress
→ dispatch branch
→ native rule boundary
→ source method / selector / content domain
→ candidate state transition
```

But whole-program source analysis has unresolved dynamic dispatch, runtime events, save/network lifecycle, content-driven rules and menu/minigame protocols. It would be false to leap directly from source scanning to a “minimal complete primitive set.”

The whole-game artifact is consequently an **atlas**, not a basis. It has one narrow, auditable coverage claim:

```text
Every command-boundary candidate emitted by this exact conservative
inspector invocation is entered in the ledger.
```

It explicitly does **not** claim:

```text
- all player-achievable Stardew behavior is discovered;
- all candidates have complete semantic/effect summaries;
- source reuse proves public-action equivalence;
- all candidates are representable by the Farmhand bridge;
- any candidate/action has passed contract, real live, receipt or publish gates.
```

Unknown paths remain unknown; they are work items, not exclusions.

## 3. Reproducible target-version derivation

```powershell
pnpm derive:stardew-semantic-kernel-atlas -- --game-path $env:GAMEBUDDY_STARDEW_GAME_PATH --out .tmp-stardew-semantic-kernel-atlas.json --pretty
node --test tools/stardew-source-semantic-kernel-atlas.test.mjs
```

The command runs the existing exact-target inspector and emits only a redacted JSON report. The inspector:

1. verifies installed target file version and DLL SHA-256;
2. temporarily decompiles the exact assembly with local `ilspycmd`;
3. records the decompiled source manifest digest;
4. probes target-version `DataLoader` table metadata;
5. extracts normal-player ingress and first conservative source rule boundaries;
6. deletes the temporary decompilation.

The command does **not** start Stardew, load/save a game, communicate with the Mod bridge, access a player window, use keyboard/mouse/controller input, invoke a menu/minigame, or execute an action.

## 4. Current target run

The actual locked-target run produced:

| Evidence surface | Count | Meaning |
|---|---:|---|
| Normal-player ingress roots | 9 | Source-rooted control paths; all remain command-path candidates. |
| Reachable first/second-hop source edges | 252 | Conservative routing evidence, not action implementations. |
| Command-boundary entries | 207 | Every currently extracted branch/selector recorded in the atlas. |
| Static gameplay-shaped nodes | 501 | Method/selector discovery universe; 471 still require expansion. |
| Distinct command semantic-family labels | 33 | Triage labels, not a primitive basis. |
| Relevant content assets | 558 | Versioned data evidence; no asset becomes a capability by itself. |
| Content-operation families | 44 | Separate content-driven work domains. |
| DataLoader tables | 71 | Runtime target data tables; 38 gameplay-relevant tables require expansion. |

The discovered roots are:

```text
world_action_interaction
world_tool_use
world_tool_release
inventory_toolbar_selection
world_movement
menu_semantic_selection
event_dialogue_or_choice
text_chat_submission
minigame_continuous_control
```

This is an expansion of source evidence, not a claim that all nine roots will ever be exposed to the AI Farmhand. UI/window injection remains forbidden. Menus, events, text/chat and minigames are recorded to make scope/exclusion decisions auditable, never as a raw fallback mechanism.

### The largest current domain is map operations

The conservative inspector yielded 131 literal map-operation selectors under `GameLocation.performAction`, including entries such as:

```text
AdventureShop
AnimalShop
Arcade_Minecart
Blacksmith
Billboard
```

They must **not** become a generic `performAction(selector)` API. Each begins separately because the selector may open a UI, begin a content protocol, acquire/purchase/consume something, trigger a quest/event or switch to a minigame. The future procedure is:

```text
selector
→ effect/lifecycle summary
→ typed target and policy analysis
→ retain separate public action, form a closed typed protocol,
  mark unsupported, or prove a narrow semantic equivalence
```

## 5. Atlas data model

Each command-boundary entry records:

```text
atlasEntryId
candidateId
ingressId
semanticFamily            # only a triage label
nativeRuleBoundaryCandidate
source locus              # source file + method
literal selector, if any
source evidence
bridge route, if proven
semanticKernelState       # initially unproven
publicActionState         # always not_inferred here
```

A repeated source locus produces only a **reuse hypothesis**:

```text
implementation_reuse_observed_semantic_kernel_unproven
```

Required proof before considering it a semantic kernel is:

```text
1. branch-level effect summary and forward/backward source slice;
2. typed input / target / guard / terminal-state comparison;
3. policy, receipt and evidence compatibility review;
4. native AI-Farmhand live closure for every non-equivalent branch.
```

This guard specifically prevents a repeated source location from erasing semantic interfaces such as `plant_seed` and `fertilize_tile`.

## 6. Global derivation method

The scalable procedure is intentionally incremental and fail closed.

### Stage A — static universe ledger

Record exact assembly/source/content attestation and all discovered roots, branches, selectors, static gameplay nodes and content tables. A new target hash produces a new ledger; prior classifications must not silently survive.

### Stage B — effect-sliced candidate summary

For each ledger entry, build a bounded source/IL slice from its normal-player ingress to authority-visible commits and exits. The summary must record:

```text
actor and target type
preconditions / rejected branch reasons
state reads and writes
inventory/world/network/save effects
allocation/removal
random/time/event dependencies
lifecycle owner and terminal conditions
unknown dynamic/reflection/content/event sinks
```

Unmodelled virtual call, delegate, reflection, script/content dispatch or runtime event is an explicit `unknown` sink. It widens the analysis boundary; it cannot be treated as no effect.

### Stage C — kernel hypothesis

Candidate paths are comparable only when their effect summaries, type domains and lifecycle boundaries match. Structural/code similarity and shared source locus are merely a cheap way to prioritize comparison.

A source-derived implementation kernel may then be used to factor bridge implementation and non-live proof obligations. It remains distinct from a public action until Stage D succeeds.

### Stage D — public semantic projection

For every existing or proposed public interface, independently compare:

```text
authorization / scope
typed target and parameter domain
precondition and error algebra
effect and terminal-state algebra
evidence / receipt schema
cancellation, deadline, idempotency and replay behavior
save, multiplayer and cross-day ownership
```

Only an equality proof permits public interface unification. Otherwise retain the distinct interface over shared internal code.

### Stage E — native closure

No source-level conclusion is a publication conclusion. Every materialized action still needs:

```text
contract gate
+ target-version native AI-Farmhand live gate
+ authoritative receipt with action-specific postcondition
+ publication/policy gate
```

A composite additionally needs step receipts, fresh observations, aggregate success and lifecycle/coordination closure.

## 7. Consequences for the existing catalog and graph

- `design/gameplay-capability-catalog.json` remains a player-facing intent and coverage-decision record. It is **not** the discovery universe and does not grant actions.
- The PRCP graph remains an ingress/source audit. It is **not** an action graph.
- The atlas is a discovery ledger binding the two to locked-version evidence. It is **not** a primitive catalog.
- The action registry remains the only publication input, subject to live capability and policy intersection. The atlas cannot add to it.

This produces the correct division of labor:

```text
source / content / IL
  → discovery completeness and implementation-reuse evidence

semantic public contracts
  → agent-visible meaning, authority and receipts

live target game
  → proof that the bridge and native lifecycle actually close
```

## 8. Next bounded work batches

Do not attempt a 207-entry public action design pass. Work through source domains with the highest semantic leverage and clearest target-version lifecycle:

1. tool override families: Hoe, Watering Can, Axe, Pickaxe, Fishing Rod, Pan, weapons;
2. item placement and machine/container drop-in paths;
3. `GameLocation.checkAction` object/terrain/NPC/animal subbranches;
4. map operation selectors grouped by effect summary, never by selector name alone;
5. content-driven crop, machine, animal and recipe domains;
6. finite dialogue/event/festival protocols;
7. explicitly out-of-scope menu/text/minigame behavior, with source anchors and reasons.

Each batch ends with a versioned ledger delta, effect summaries, kernel hypotheses, decisions on separate versus shared public projections, and the required contract/live/publish proof matrix. It never ends merely because static discovery ran green.
