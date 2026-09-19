# 14 Stardew Native Capability Audit

> **Status**: accepted supporting audit model. It helps verify one proposed capability against the locked target version; it is **not** the gameplay-completeness gate, a full reachable-code proof, an action registry, or a runtime capability source.
>
> **Scope**: vanilla Stardew Valley `1.6.15` build `24356`, normal native Farmhand gameplay under the supported multiplayer topology. Runtime authorization is outside this model.
>
> **Related**: [`11_GAMEPLAY_CAPABILITY_COVERAGE.md`](11_GAMEPLAY_CAPABILITY_COVERAGE.md), [`12_STARDEW_PRIMITIVE_ACTION_BASIS.md`](12_STARDEW_PRIMITIVE_ACTION_BASIS.md), and [`13_STARDEW_NATIVE_PROVENANCE.md`](13_STARDEW_NATIVE_PROVENANCE.md).

## 1. Purpose and stop rule

The product goal is a **minimal, complete, composable capability set** for the declared player gameplay scope:

```text
player intent
→ one reusable typed capability
| a receipt-linked composite of capabilities
| a native coordination/content contract
→ target-version native lifecycle
→ honest result and live evidence
```

This is not the same goal as proving that every internal method, callback, selector, tick, or content branch in Stardew has been enumerated. Attempting to reconstruct and classify the full player-reachable call graph is open-ended program analysis and does not determine the smallest useful capability set.

Therefore this audit stops when it has enough target-version evidence to decide one capability:

1. whether a normal Farmhand can perform the player-meaningful behavior under native rules;
2. which native rule boundary and guards govern it;
3. whether an existing capability can honestly cover it;
4. whether it needs a new capability, a composite, a coordination/content contract, or is currently blocked; and
5. what a formal live run must prove.

The audit must **not** create an action for every discovered source branch or demand `unknown = 0` across the game before the capability set can be decided.

## 2. Non-UI invariant

Normal player source paths are evidence of game rules only. The AI Farmhand never views, focuses, clicks, or competes for a human window, and never uses OS keyboard/mouse/XInput injection, raw coordinates, input replay, raw menu callbacks, arbitrary strings, or arbitrary native method calls.

A typed bridge request is valid only when the Mod runs it on the game thread through the target-version native lifecycle and independently verifies scope, target/input domain, state preconditions, receipt, and fresh postcondition.

## 3. Capability decision record

Every proposed capability has a short, versioned decision record. It is the unit of product design and implementation work:

| Field | Required decision |
|---|---|
| `capabilityId` | Stable player-meaningful name; not a method/branch/tick name. |
| Player outcome | One independently requestable and observable result. |
| Reuse decision | `reuse`, `new`, `composite`, `coordination`, `content_operation`, or `blocked`. |
| Native audit | Target assembly/content provenance, normal-player rule entry, guards, and native lifecycle boundary. |
| Target/input domain | Finite opaque live target(s) and typed parameters; no UI/raw-input escape hatch. |
| Result model | Success, failure, partial, capacity, cancellation, and non-guarantees. |
| Evidence | Exact receipt and fresh authoritative postcondition. |
| Live gate | Fixture/runner, formal attachment requirement, and observable acceptance condition. |
| Status | `proposed`, `experimental`, `published`, or `blocked`; only live-backed success can publish. |

A source-derived branch or selector may be attached as provenance to a decision record. It is never itself a capability merely because it was discovered.

## 4. Granularity and reuse rules

Use the smallest semantic unit that has one player-meaningful result, one bounded target/lifecycle, and one independently verifiable terminal outcome. A primitive may contain several native phases when they remain one causal lifecycle.

Before adding a capability, decide in this order:

```text
1. Reuse an existing published capability after a targeted native-equivalence audit.
2. Reuse an existing proposed/experimental Basis capability when its result model fits.
3. Compose existing capabilities when independent targets or fresh discovery boundaries exist.
4. Use an explicit coordination or finite content contract when native rules require it.
5. Add a new capability only when none of the above has an honest boundary.
```

Do not split a lifecycle merely because it contains internal methods, input edges, animations, timers, or callbacks. Conversely, do not combine independent targets or uncorrelated lifecycles into one success receipt.

Example:

```text
get wood from a tree
= chop_tree_source
→ fresh observation of independently created Debris
→ pickup_item*
→ aggregate exact inventory delivery
```

Tree transformation and debris delivery are independent and must remain a composite. By contrast, a normal item-use animation can remain one `use_item` primitive when the same item lifecycle has one terminal inventory/state result.

## 5. Target-version evidence tools

The direct inspector, assembly attestation, temporary ILSpy decompilation, selector extraction, target-game `DataLoader` probe, and optional source-branch helpers remain useful. They provide:

```text
target version/hash attestation
+ native rule/guard discovery
+ content-domain discovery
+ version-drift diagnostics
+ focused evidence for a capability decision record
```

They do **not** provide a capability count or gameplay-completeness percentage. The inspector may report `partial` discovery indefinitely without blocking capability-set design; its old PRCP reachability checker is diagnostic only and must not be read as a production completeness gate.

## 6. Per-capability closure

A capability decision is not closed by documentation or source reading. Each materialized or changed capability must finish:

```text
native feasibility audit
→ typed contract and implementation
→ deterministic contract/parser/fixture checks
→ formal Host + native AI Farmhand attachment
→ actual typed production request
→ same-execution terminal receipt
→ fresh authoritative postcondition
→ cleanup/recovery
→ published / experimental / blocked record
```

A composite additionally requires step receipt correlation, fresh observation across independent targets, an aggregate predicate, cancellation/timeout behavior, and an aggregate live run. A capability that cannot reach this live closure remains `proposed`, `experimental`, or `blocked`; it is not silently treated as covered.

## 7. Historical diagnostic prototype

The repository contains an early source-derived ingress/branch graph prototype. Its counts and `boundary_candidate` entries are research diagnostics only. It remains useful for locating native guards—such as the `Game1.tryToCheckAt` guard restored for `pickup_forage`—but it must not drive action granularity or be required to reach a green global gate. No further full-graph expansion is planned unless a specific capability audit needs it.
