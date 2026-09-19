# Chat Pipeline Batch 05 — P4a Durable Acceptance

**Status:** frozen implementation slice  
**Parent:** `design/40_CHAT_PIPELINE_RELEASE_ENGINEERING_IMPLEMENTATION_PLAN.md` §5.5–§6.8, §12 P4  
**Predecessor:** P3 exact same-origin static shell/API composition  
**Release status:** non-release foundation; P2 Windows reparse live evidence remains a release blocker.

## 1. User-visible result

An already mounted, exact Chat has one Host-owned durable acceptance operation. It accepts a player message exactly once across a lost caller response or restart, clears only the exact durable draft on acceptance, and exposes a durable `accepted_queued` turn read-back. It does **not** prompt Pi, present a bubble, start SSE, or mount a browser route in this batch.

## 2. Scope and explicit non-goals

### In scope

- destructive cutover from standalone `chat-draft` files to an exact `draft.json` within the selected ChatThread directory;
- extension of the existing ChatThread journal to recover one complete owned state: thread, messages, draft, TurnLedger and idempotency records;
- a typed, Host-internal P4 acceptance facade whose input is bound to a current `MountedChatRuntimeLease` and the exact deployment principal;
- draft read through the P3 exact-state facade after the cutover;
- durable acceptance, exact duplicate replay, mismatch conflict, `turn_busy`, durable restart read-back, and transaction recovery tests.

### Explicit non-goals

- no HTTP/browser-contract/profile change, message route, submission-status route, cookie/CSRF handling, frontend submit UI or browser pending-key persistence;
- no Pi/provider attempt, `DialogueController`, prompt/context mutation, presentation, response commit, cancellation, terminalization, SSE, or Memory delegation;
- no Chat switching, Tavern management, retention expiry, migration/adoption, fallback, read-repair or import of former standalone drafts.

## 3. Authority and storage topology

`ChatThreadStore` remains the sole durable owner. Every ChatThread directory gains a required `draft.json` and state records for one `TurnLedgerV1` plus its scoped idempotency retention entries. `transaction.json` is the sole prepared transaction and contains the full next state; recovery writes every exact artifact, re-reads it, and only then removes the journal.

The former `tavern/v1/chat-drafts` repository is deleted. A fresh thread writes its required empty draft artifact atomically with the initial thread and message artifacts. An exact thread with any partial/missing new artifact fails closed. Existing separate draft files are never read, migrated, adopted or used as a fallback.

A P4 acceptance facade derives the exact `{ principal, chatThreadId, chatSurfaceSessionId, selectionGeneration }` from the currently branded mounted lease and deployment manifest. It rejects structural/closed leases before and after durable access. Store commands receive this internal binding only; a browser or arbitrary Host caller cannot make caller-supplied selection generation authoritative.

## 4. P4a operation

The only new operation is a typed internal `acceptPlayerMessage` command. Its canonical idempotency fingerprint binds:

```text
principal + route `chat.message.submit` + exact Chat binding + selectionGeneration
+ normalized NFC player text bytes + locale + expected draft revision
```

P4a deliberately has no Memory delegation field; that field is added only with its owning Memory admission capability in a later frozen slice.

Within one exact ChatThread lock/CAS it:

1. validates exact binding and NFC bounded text/locale/key/fingerprint inputs;
2. checks an existing idempotency record *before* the busy test: same key/fingerprint returns its durable accepted result, different fingerprint fails `idempotency_conflict`;
3. rejects a different key while a non-terminal turn exists with `turn_busy`, without any append, draft mutation or new idempotency record;
4. validates `expectedDraftRevision` before accepting; conflict leaves all owned artifacts unchanged;
5. appends one player message, clears only the exact draft, creates immutable `accepted_queued` TurnLedger state and the scoped accepted idempotency result;
6. commits the complete next state through `transaction.json`, re-reads exact durable artifacts, then returns the read-back result.

No attempt generation is minted in P4a. `accepted_queued` remains a durable queued state for the next P4 slice.

## 5. Acceptance scenarios

### A. First acceptance and restart

**Given** a genuine mounted lease and an exact Chat with draft revision `r` and text.  
**When** P4a accepts key `k` and an exact expected draft revision.  
**Then** one player message, cleared draft revision `r + 1`, one `accepted_queued` turn and key result exist in the exact durable state.  
**And** a newly constructed store reads the identical accepted result without a duplicate message.

### B. Retry and conflict

**Given** completed scenario A.  
**When** the same key and exact canonical command are retried.  
**Then** it returns the original result and writes nothing.  
**When** the same key has a changed canonical input.  
**Then** it fails `idempotency_conflict` and writes nothing.

### C. Concurrent distinct keys

**Given** a pristine exact Chat.  
**When** distinct keys race.  
**Then** one wins; every loser is `turn_busy`; there is exactly one player message, one turn and one cleared draft.

### D. Fail-closed boundaries

A stale/mismatched selection binding, draft revision conflict, forged/closed lease, missing required exact artifact or interrupted prepared transaction must not create a duplicate message or silently use a former draft store.

## 6. Mutation lanes and verification order

This is one connected persistence/authority chain and has **one writer**:

- `host/src/tavern/chat-thread-store.ts` and focused tests;
- `host/src/tavern/p4-durable-turn-acceptance.ts` and focused tests;
- `host/src/tavern/p3-exact-chat-state.ts` and focused tests;
- deletion of `host/src/tavern/chat-draft/chat-draft-store.{ts,test.ts}`.

The writer must first add the scenario tests, then implement the state cutover and P4 facade. Run focused Node tests, Host typecheck/build-test, and diff checks before independent review. The final reviewer must inspect actual post-write state/journal boundaries and acceptance evidence.

## 7. Stop conditions

Stop and return a new prerequisite rather than widening this batch if implementation requires a new semantic selection/switch authority, HTTP route semantics, provider invocation, presentation admission, Memory admission, compatibility/migration path, or any second transaction repository.


# --- CONSOLIDATED P4A REMEDIATION AND CLOSURE SECTIONS ---


## From 50_CHAT_PIPELINE_BATCH_05_P4A_REMEDIATION.md

## 1. Defects being closed

The prior P4a implementation is not acceptable because its public `ChatThreadStore.acceptPlayerMessage` took caller-supplied Chat/selection facts, the facade could combine a genuine lease with an unrelated manifest/root, lease close could race a durable commit, and recovered artifacts were not validated as one coherent state.

This remediation changes no player feature, HTTP route, provider behavior, presentation, cancellation, SSE, Memory or Tavern-management scope.

## 2. Exclusive admission path

A P4 player-message acceptance is legal only inside a coordinator-owned, close-drained mounted-lease operation.

The semantic production coordinator privately records, when it mints a mounted lease:

```text
runtimeRoot + full principal { playerId, companionId, continuityId }
+ exact chatThreadId + chatSurfaceSessionId + selectionGeneration
```

It exports one narrow Host-internal operation runner. The runner:

1. recognizes the exact currently active lease by private identity;
2. compares the complete passed deployment manifest (root and every principal field) to its private record;
3. starts the coordinator's existing `begin()` operation before invoking the callback, so `lease.close()` sets closing/revokes new access but waits for this already admitted operation before tearing down the mounted runtime;
4. exposes only an opaque callback-scoped P4 admission capability, not private records or a general lease executor;
5. rejects saved/replayed/reentrant/closed capability use and makes no second minting route.

The P4 facade is the only consumer. It calls this runner around the full durable store transaction. A close that begins after admission drains after the transaction and the caller receives its durable accepted receipt; a call that begins after close is rejected before any mutation.

The runner's implementation belongs in the coordinator internal module; its public facade exports no private record or mutation control. The P4 opaque capability is callback-scoped/WeakSet branded and cannot be constructed from browser/Host caller data.

## 3. Store boundary

`ChatThreadStore` no longer exposes `acceptPlayerMessage` or an acceptance input containing authority facts. Its normal public surface remains content/lifecycle storage only.

A dedicated P4 internal store port is created only through an opaque coordinator admission. Its command contains player-controlled fields only:

```text
text + locale + idempotencyKey + expectedDraftRevision
```

The port derives complete durable binding facts from the opaque admission: full principal, exact Chat/surface and selection generation. Its idempotency fingerprint includes every such fact. No caller can choose `chatThreadId`, surface, companion, continuity, player or selection generation.

The raw store transaction remains testable only through a test-only module-local maker; production tests primarily exercise the real mounted facade.

## 4. Exact durable-state integrity

Before committing, recovering, returning or replaying any state, validator must require:

- artifact directory ID equals `thread.chatThreadId`;
- every idempotency key is unique;
- every idempotency result references exactly one existing `player` message;
- every idempotency result's key equals its record key;
- turn IDs and message IDs in idempotency records are unique;
- a non-null TurnLedger references exactly one existing `player` message and exactly one equal idempotency result;
- an idempotency record cannot exist when TurnLedger is null in P4a's one-nonterminal-turn model;
- the TurnLedger has exactly one matching idempotency record;
- values returned from durable acceptance are the exact fully validated read-back record.

Any missing/mismatched/transplanted artifact or malformed prepared journal fails closed and is not repaired, migrated, inferred or replayed. A prepared journal is only removed after all exact artifact files are written and the full cross-artifact validator reads them back.

## 5. Draft proof

The cutover continues to prohibit former `chat-drafts` reads. Tests use a valid in-journal non-null exact `draft.json` state before acceptance, then prove only that exact thread's text clears and revision increases once; a second thread's draft state remains untouched. P4a intentionally has no ordinary draft-write API—the later P4 route/draft-surface slice owns that producer.

## 6. Required evidence

1. genuine mounted lease + matching manifest accepts, then close waits until a deliberately delayed in-flight durable acceptance returns its receipt and only then tears down;
2. mismatched root/principal manifest with a genuine lease rejects before store I/O; forged/replayed/reentrant/closed admission rejects;
3. production `ChatThreadStore` has no public acceptance operation or caller-supplied authority input;
4. all cross-artifact corruption variants above fail before recovery/replay; exact directory/thread mismatch fails;
5. non-null exact draft clearing / other-thread non-mutation proof;
6. prior replay, conflict, race, restart and prepared-journal recovery evidence remains green;
7. focused tests, Host typecheck/build-test, emitted tests, diff check and independent review pass.


## From 51_CHAT_PIPELINE_BATCH_05_P4A_REVIEW_REMEDIATION.md

## Scope and non-goals

This slice closes only the P4a defects found in review: a clean production import-boundary result, exact bridge export confinement, and no-write prepared-journal validation. It adds no HTTP route, browser API, provider attempt, presentation, cancellation, SSE, Memory, normal draft-write API, or Tavern-management feature.

## 1. Clean package closure, not an allowlist bypass

A package listed in `externalRuntimeClosure.packages` authorizes exactly:

```text
package
package/<subpath>
```

It does not authorize prefix lookalikes such as `package-untrusted/...`, scoped-package siblings, dynamic imports, `require`, or undeclared packages. The checker must therefore accept the declared TypeBox subpaths that the actual P3/P4 production closure imports, and the real check must be clean—not merely P4-clean-with-unrelated-findings.

## 2. One exported P4 bridge operation

The P4 private bridge may expose exactly one runtime export:

```text
acceptMountedP4DurableTurnFromFacade
```

It may import exactly the already approved opaque coordinator runner/consumer and raw store ingress. It may not re-export, alias-export, default-export, namespace-export, or otherwise make any imported sensitive capability reachable. The source checker must track imported local aliases and reject all bridge runtime export forms except the named bridge entry, including transitive aliases.

The P4 facade remains the only permitted bridge importer. The public coordinator module remains the normal sole importer of its internal implementation; P4 bridge is the one exact named exception.

## 3. Validate a prepared state against its target before any recovery write

`validatePrepared` takes the expected target ChatThread ID derived from the exact thread artifact directory. Before `readState` writes a prepared state to any artifact, it must reject a state whose `thread.chatThreadId` does not equal that target ID.

A rejected prepared journal is not repaired, deleted, inferred from, or partially applied. Its bytes and every existing artifact byte remain unchanged. The required adversarial fixture uses a valid P4-shaped state (non-null ledger plus matching idempotency) for thread B placed in thread A's journal, proving that whole-state coherence alone cannot authorize cross-directory recovery.

## 4. Evidence topology

### Manifest mismatch

The real coordinator internal runner has one explicit callback barrier: it validates the exact active lease and full manifest before calling the callback. A focused real-Windows test supplies each bad root/principal manifest to the runner with a callback that records/throws if invoked; every case must reject with zero callback invocations. Import topology proves raw store ingress can be reached only inside that callback from the private bridge, so zero callback invocation proves zero P4 store ingress / durable I/O for this path.

### Close drain

The existing real coordinator+raw-store overlap test remains the authority evidence for the callback-scoped drain: an admitted transaction is delayed before the exact store ingress, `lease.close()` starts and remains unsettled, then receipt and durable read-back precede teardown completion. The public facade has no alternate work path: the checked production source invokes only `acceptMountedP4DurableTurnFromFacade`, and its public happy-path test verifies this composition. This slice must add a source/topology assertion for that one entry call rather than adding a product-visible delay/test control.

## Required verification

1. Checker fixtures cover valid declared subpaths and reject prefix lookalikes; real checker returns `passed` with zero findings.
2. Checker fixtures cover alias import followed by named/default/namespace export, direct re-export, and allowed sole bridge entry; real bridge passes.
3. A transplant journal rejects before write and preserves bytes of `thread.json`, `messages.json`, `draft.json`, `turn-ledger.json`, `idempotency.json`, and `transaction.json`.
4. Real mounted runner calls no callback under bad root or each bad principal, with durable state still pristine; facade source/topology retains its one bridge call.
5. Existing opaque-admission lifecycle, close-drain, draft-isolation, idempotency/restart and grammar evidence stays green.
6. Host typecheck, emitted focused tests, clean full import checker, diff check, no staged files, and independent review pass.


## From 52_CHAT_PIPELINE_BATCH_05_P4A_FINAL_CHECKER_REMEDIATION.md

## Scope

This slice changes only `tools/check-host-production-import-boundary.mjs` and its tests. It does not modify the P4 facade, coordinator, store, wire contract, browser, provider, presentation, cancellation, SSE, Memory, or management scope.

## 1. Provenance closure for the one P4 bridge export

The P4 bridge continues to have exactly one permitted runtime export:

```text
acceptMountedP4DurableTurnFromFacade
```

That name must designate the bridge's locally implemented wrapper, never an imported sensitive capability or any direct/transitive local alias of one. The checker must derive provenance for a closed, simple local-alias graph before assessing bridge exports:

- Sensitive origins remain the approved coordinator internal bindings and `acceptP4MountedPlayerMessage` from the raw store.
- Direct import local names are sensitive.
- A local initializer that is a bare sensitive identifier makes its declared local sensitive; repeat to fixed point for any chain of `const`, `let`, or `var` aliases.
- Exports of a sensitive local, under any public name—including the one permitted bridge-entry name—are invalid.
- `export default`, `export { local }`, `export { local as name }`, `export *`, namespace exports, and `export ... from` remain invalid runtime bridge surface forms.
- Type-only declarations and type-only specifiers are erased and do not create runtime aliases or exports.

The static checker is intentionally not an evaluator: function calls, member expressions, destructuring, assignments, and unknown initializers do not acquire provenance. The sole target is to reject the known direct/transitive identifier-alias escape without broad source inference.

## 2. TypeScript erased constructs do not form runtime graph edges

The production **runtime** import graph must exclude TypeScript-erased references:

```ts
type T = import("./x").T;
type Namespace = typeof import("./x");
import { type T } from "./x";
export { type T } from "./x";
```

For mixed named clauses, retain a runtime graph edge only when at least one binding is runtime-bearing. A clause with only `type` specifiers is erased. Ordinary default, namespace, named runtime imports, re-exports, `require`, and actual `import(...)` expressions remain subject to the current fail-closed policy.

## Required evidence

1. Bridge fixtures reject two-hop and longer local alias chains of each approved sensitive origin, both named export under the permitted name and default export; the actual bridge remains accepted.
2. Fixtures prove type queries and all-type named import/export clauses do not traverse or report semantic/legacy authority imports.
3. Mixed clauses still retain the runtime edge and are rejected when their runtime binding reaches restricted authority.
4. Actual production checker is clean; checker tests, Host typecheck/build-test, focused P4 emitted tests, diff check, no staged files, and fresh independent review pass.


## From 53_CHAT_PIPELINE_BATCH_05_P4A_FINAL_AUTHORITY_CLOSURE.md

## Scope

This slice changes only `tools/check-host-production-import-boundary.mjs` and its tests. It does not change the P4 facade, private bridge, coordinator, raw store, durable protocol, wire/browser/provider/presentation/cancellation/SSE/Memory/management scope.

## Closure target

The existing P4 topology remains exactly:

```text
public facade → private bridge → coordinator opaque admission → raw store ingress
```

No other production source form may make `acceptP4MountedPlayerMessage` runtime-reachable.

## 1. Erased assertion aliases retain sensitive provenance

A variable initialized from a sensitive local remains sensitive when its runtime initializer is that identifier wrapped by TypeScript-erased syntax:

```ts
const next = raw as typeof raw;
const next = raw satisfies typeof raw;
const next = raw!;
const next = (raw);
```

The checker must use the pinned TypeScript AST to unwrap only `ParenthesizedExpression`, `AsExpression`, `SatisfiesExpression`, and `NonNullExpression`. If the resulting initializer is a bare `Identifier`, fixed-point provenance continues exactly as for `const next = raw`; all other initializer expressions remain outside this deliberately narrow alias rule.

Any direct or transitive sensitive alias exported from the P4 bridge—under the otherwise permitted bridge export name included—is invalid.

## 2. Static computed Node module members are CommonJS ingress

`moduleBinding["createRequire"]` and `moduleBinding["require"]` are runtime-equivalent to the existing dot member forms. The checker must recognize only a computed property whose argument is a static string exactly equal to `createRequire` or `require`; computed non-literals remain unresolvable and must fail closed when used as an ingress.

Recognition applies consistently to factory/require alias propagation and direct call extraction, so a computed `createRequire` followed by a relative CommonJS load is traversed and subject to normal P4 store-ingress topology checks.

## Required evidence

1. Bridge fixtures reject a raw store binding routed through each erased-wrapper form and re-exported as `acceptMountedP4DurableTurnFromFacade`.
2. Fixtures prove a computed `node:module` `createRequire` direct load and alias load traverse a relative legacy/store target; computed `require` direct and alias forms do the same.
3. Existing dot-member behavior, genuine P4 bridge implementation, type-only erasure, dynamic-import fail-closed behavior, and full production checker remain green.
4. Run checker tests, actual checker, Host typecheck/build-test, focused emitted P4 tests, `git diff --check`, no staged files, then a fresh independent authority review.


## From 54_CHAT_PIPELINE_BATCH_05_P4A_BRIDGE_COMMONJS_CLOSURE.md

## Scope

Only `tools/check-host-production-import-boundary.mjs` and its tests change. No P4 product/runtime/store/coordinator/wire/browser/provider/presentation/cancellation/SSE/Memory/management behavior changes.

## Exact bridge import rule

The private P4 bridge may reach the raw store only through one exact ESM static import:

```ts
import { acceptP4MountedPlayerMessage } from "./chat-thread-store.js";
```

A raw-store `require`, `createRequire` load, `module.require` load, dynamic import, re-export, default import, namespace import, or non-allowlisted named import is invalid even if the importer is the P4 bridge. CommonJS has no dependable static named-binding clause, so it cannot establish the only permitted raw-store capability edge.

A raw-store CommonJS import from any non-bridge importer remains `unauthorized_p4_store_ingress_import`; from the bridge it is `invalid_p4_bridge_store_edge`. Both are fail-closed topology violations.

## Required evidence

1. The actual bridge’s intended named ESM import remains accepted.
2. P4 bridge fixtures reject raw-store access via direct `createRequire`, a `createRequire` loader alias, direct `module["require"]`, and a `module["require"]` loader alias.
3. Non-bridge computed CommonJS store ingress remains rejected.
4. Run checker tests, real checker, Host typecheck/build-test, focused emitted P4 suite, diff check, no staged files, then a new independent final authority review.


## From 55_CHAT_PIPELINE_BATCH_05_P4A_IMPLEMENTATION_AND_LOADER_CLOSURE.md

## Scope

Only the production import-boundary checker and its tests change. P4’s public facade, private bridge, coordinator, raw store, durable behavior, routes, browser, provider, presentation, cancellation, SSE, Memory, and management scope do not change.

## 1. P4 bridge is a fixed source form

The private bridge is a bounded implementation seam, not an extensible module. The checker must parse it with the Host-pinned TypeScript AST and accept exactly this runtime chain:

```ts
acceptMountedP4DurableTurn(manifest, lease, admission =>
  consumeMountedP4Admission(admission, binding =>
    acceptP4MountedPlayerMessage(binding, command)))
```

The bridge may have only the required type-only imports, exact runtime named imports, erased type declarations, and this one exported async function. Its runtime imports must be exactly:

```text
coordinator internal: acceptMountedP4DurableTurn, consumeMountedP4Admission
raw store: acceptP4MountedPlayerMessage
```

The sole runtime export is `acceptMountedP4DurableTurnFromFacade(manifest, lease, command)`. Every direct raw-store call, substituted callback, wrapped execution path, runtime variable statement, CommonJS loader, dynamic import, re-export, default/namespace import, extra runtime export, or non-exact function body is `invalid_p4_bridge_implementation`.

This is intentionally a fixed implementation verifier, not general semantic equivalence analysis. It proves the one admitted composition path and fails closed on any structural deviation.

## 2. Unrecognized loader forms fail closed

No current production source requires `process.getBuiltinModule`, so any runtime reference to that Node module-loader capability is an unresolved dynamic require. This covers direct, computed, and alias acquisition without inventing a second approved loader policy.

For an already identified `node:module` namespace binding, a computed member whose property is not a literal token must likewise produce `unresolved_dynamic_require`; it cannot silently avoid raw-store topology inspection. Literal computed members continue through the existing static `createRequire` / `require` policy.

## Required evidence

1. The real bridge passes the AST implementation verifier.
2. A bridge fixture with the allowed raw ESM named import but a direct wrapper call blocks as `invalid_p4_bridge_implementation`.
3. Bridge fixtures with lexical computed `node:module` loader keys and `process.getBuiltinModule` block.
4. Non-bridge lexical computed `node:module` and any `process.getBuiltinModule` source block as unresolved dynamic requires.
5. Run checker tests, actual checker, Host typecheck/build-test, focused emitted P4 tests, diff check, no staged files, then fresh independent review.


## From 56_CHAT_PIPELINE_BATCH_05_P4A_FORMAL_AND_REFLECTION_CLOSURE.md

## Scope

Only `tools/check-host-production-import-boundary.mjs` and its focused tests may change. No P4 production behavior, durable schema, provider, browser, routes, presentation, cancellation, SSE, Memory, or management scope changes.

## 1. The bridge’s formal interface is fixed as well as its body

The exact P4 private bridge function has exactly three required ordinary parameters named `manifest`, `lease`, and `command`. Each must have:

- no initializer;
- no `...` rest marker;
- no `?` optional marker;
- no parameter modifiers.

This eliminates pre-body default-initializer execution before coordinator admission. A bridge fixture whose third parameter defaults through `acceptP4MountedPlayerMessage(...)` must be rejected as `invalid_p4_bridge_implementation`.

## 2. Reflection is an unresolved runtime loader capability

P4 requires a statically auditable production loader graph. No current Host production source uses runtime reflection. Therefore, rather than attempting to reason about arbitrary reflective provenance, the production source scanner rejects every executable `Reflect.get` / `Reflect["get"]` invocation as `unresolved_dynamic_require`.

This is deliberately conservative and closes reflection of:

- `process.getBuiltinModule`;
- `node:module.createRequire` / `require`;
- their aliases and arbitrary receiver expressions.

Type-only `Reflect` text is irrelevant; the check applies to executable call expressions parsed by pinned TypeScript AST. Required fixtures cover reflection of `process`, `node:module`, computed `Reflect["get"]`, and a bridge parameter-initializer raw-store bypass.

## Required evidence

1. Checker regression suite passes and rejects all new repro fixtures.
2. Actual production checker remains clean.
3. Host typecheck, test artifact build, focused P4 emitted suite, and diff check pass.
4. A fresh independent reviewer finds no concrete pre-admission raw-store bypass in the bounded P4 composition graph.


## From 57_CHAT_PIPELINE_BATCH_05_P4A_DESCRIPTOR_LOADER_CLOSURE.md

## Scope

Only these files may change:

- `tools/check-host-production-import-boundary.mjs`
- `tools/check-host-production-import-boundary.test.mjs`
- `host/scripts/production-artifact.mjs`
- `host/scripts/production-artifact.test.mjs`

No P4 application code, durable state format, provider behavior, browser/API route, presentation, cancellation, SSE, Memory, or management scope may change.

## Threat and decision

A non-bridge P4 facade can obtain `process.getBuiltinModule` using a computed `Object.getOwnPropertyDescriptor` call, then obtain `node:module.createRequire` and load the raw ChatThreadStore ingress. This bypasses both opaque coordinator admission and the bridge’s fixed source form.

The Host has no approved production use of runtime Node module-loader acquisition or runtime reflection for this purpose. The scanners therefore fail closed at capability acquisition rather than attempting arbitrary JavaScript provenance analysis.

## Required enforcement

Both source and emitted-artifact guards must reject:

1. `Object.getOwnPropertyDescriptor(process, "getBuiltinModule")` and its static bracket spelling;
2. any executable non-string computed member call on global `Object` whose first argument is `process`;
3. existing direct/computed/destructured `process.getBuiltinModule` and `Reflect.get` paths remain rejected.

The import boundary emits `unresolved_dynamic_require`; the artifact verifier emits its existing process-built-in loader ingress error. An unrelated computed `Object` call whose first argument is not `process` is not in scope for this narrow rule.

## Required regressions and evidence

- A P4 facade fixture using
  `Object[("getOwn" + "PropertyDescriptor") as "getOwnPropertyDescriptor"](process, "getBuiltinModule")`
  and then raw-store invocation is rejected before topology acceptance.
- The artifact verifier rejects the analogous emitted JavaScript.
- Existing positive artifact fixture with unrelated reflection/property names remains valid.
- Run checker tests, actual checker, production-artifact focused test, Host typecheck/build-test, P4 emitted suite, and `git diff --check`.
- Obtain a fresh read-only authority review before closing P4a.


## From 58_CHAT_PIPELINE_BATCH_05_P4A_GLOBAL_PROCESS_LOADER_CLOSURE.md

## Scope

Only these files may change:

- `tools/check-host-production-import-boundary.mjs`
- `tools/check-host-production-import-boundary.test.mjs`
- `host/scripts/production-artifact.mjs`
- `host/scripts/production-artifact.test.mjs`

No product P4 facade/bridge/coordinator/store code, durable artifact, API/browser/provider/SSE/presentation/cancel/Memory/management code may change.

## Decision

`process.getBuiltinModule` is a Node loader authority regardless of whether `process` is referenced as a direct identifier or as the static global path `globalThis.process` / `global.process`.

Both guards must reject an executable non-string computed member on either global process path, before any topology or artifact closure acceptance. Existing direct and static-bracket `getBuiltinModule` detection remains in force. This is bounded syntax enforcement, not general alias/data-flow analysis; the repository has no approved production use of non-string computed members on these global process paths.

## Required regression evidence

Both the source boundary and emitted artifact guard must reject:

```ts
const builtin = globalThis.process[("getBuiltin" + "Module") as keyof typeof globalThis.process];
```

when used to load `node:module`, create a `require`, and access the raw P4 store ingress. The existing non-loader positive fixtures must remain accepted.

Run checker tests, actual checker, full production-artifact tests, Host typecheck/build-test, focused P4 emitted tests, diff check, and a new independent authority review before P4a can close.


## From 59_CHAT_PIPELINE_BATCH_05_P4A_COMPUTED_GLOBAL_LOADER_CLOSURE.md

## Scope

Only these files may change:

- `tools/check-host-production-import-boundary.mjs`
- `tools/check-host-production-import-boundary.test.mjs`
- `host/scripts/production-artifact.mjs`
- `host/scripts/production-artifact.test.mjs`

No P4 product module or durable behavior changes. No HTTP/browser/provider/SSE/presentation/cancel/Memory/management work.

## Decision

The production Host has no approved executable computed member access on the Node global objects `globalThis` or `global`. Both source and emitted-artifact guards must reject any `globalThis[nonStringExpression]` or `global[nonStringExpression]` before import topology or artifact closure acceptance.

This is a bounded syntactic loader-authority rule, not a general provenance analyzer. It closes direct computed acquisition of `process`, including:

```ts
const processRef = globalThis[("pro" + "cess") as "process"];
```

which otherwise reaches `getBuiltinModule → createRequire → raw P4 store` before coordinator admission.

Static global properties remain outside this precise new condition; existing process-loader checks continue to govern `globalThis.process` / `global["process"]` descendants.

## Required evidence

Both guards must reject a fixture using the exact global computed process acquisition above, then `Object.getOwnPropertyDescriptor(..., "getBuiltinModule")`, `node:module.createRequire`, and raw store ingress. Existing intended production check, test suites, typecheck/build-test, focused P4 emitted tests, diff check, and a fresh independent authority review are required before P4a closure.


## From 60_CHAT_PIPELINE_BATCH_05_P4A_STATIC_GLOBAL_PROCESS_CLOSURE.md

## Scope

Only the source production-import boundary checker, its tests, emitted production-artifact guard, its tests, and this design may change. No P4 product module, durable behavior, browser/API/provider/SSE/presentation/cancel/Memory/management scope changes are allowed.

## Decision

The production Host has no approved runtime use of `globalThis.process`, `global.process`, `globalThis["process"]`, or `global["process"]`. Both source and emitted guards must therefore reject acquisition of a static global `process` path itself before later loader/topology acceptance.

Together with design/59's rejection of computed access on `globalThis`/`global`, this prevents process being captured through either static or computed global member syntax and subsequently passed through an alias into a descriptor/reflection loader. This is bounded syntax policy, not general alias/data-flow analysis. Direct `process` usage remains subject to existing constrained loader rules, as current production needs it for ordinary non-loader behavior.

## Required evidence

Source and emitted fixtures must contain the full static-global alias chain:

```ts
const processRef = globalThis["process"];
const builtin = Object.getOwnPropertyDescriptor(processRef, "getBuiltinModule")!.value;
const raw = builtin("node:module")
  .createRequire(import.meta.url)("./chat-thread-store.js")
  .acceptP4MountedPlayerMessage;
```

Both must fail before execution. The emitted fixture must include the raw-store tail, not stop at `descriptor.value`. Evidence requires both guard suites, actual source checker, Host typecheck/build-test, the focused P4 suite executed with a serial/concurrency-safe topology, diff check, and a fresh independent review.


## From 61_CHAT_PIPELINE_BATCH_05_P4A_NESTED_GLOBAL_LOADER_CLOSURE.md

## Scope

Only these files may change:

- `tools/check-host-production-import-boundary.mjs`
- `tools/check-host-production-import-boundary.test.mjs`
- `host/scripts/production-artifact.mjs`
- `host/scripts/production-artifact.test.mjs`

No P4 product module or durable behavior changes. No HTTP/browser/provider/SSE/presentation/cancel/Memory/management work.

## Decision

There is no approved production runtime acquisition of Node global self aliases. Source and emitted guards must reject direct static self-alias access from either global object:

```ts
globalThis.global
globalThis.globalThis
global.global
global.globalThis
```

before loader/topology acceptance. This complements design/59 (computed global members) and design/60 (direct global `process` acquisition). It is a small executable-syntax rule, not general alias/data-flow analysis.

## Required evidence

Both guard suites must include the full pre-admission raw-store tail rooted at:

```ts
const processRef = globalThis.global.process;
const builtin = Object.getOwnPropertyDescriptor(processRef, "getBuiltinModule")!.value;
const raw = builtin("node:module")
  .createRequire(import.meta.url)("./chat-thread-store.js")
  .acceptP4MountedPlayerMessage;
```

The guard must reject before the fixture could execute `raw`. Re-run the actual source checker, emitted artifact suite, Host typecheck/build-test, serial P4 focused suite, diff check, and a fresh independent authority review.


## From 62_CHAT_PIPELINE_BATCH_05_P4A_TRANSPARENT_GLOBAL_WRAPPER_CLOSURE.md

## Scope

Only these files may change:

- `tools/check-host-production-import-boundary.mjs`
- `tools/check-host-production-import-boundary.test.mjs`
- `host/scripts/production-artifact.mjs`
- `host/scripts/production-artifact.test.mjs`

No P4 product module, durable behavior, HTTP, browser, provider, SSE, presentation, cancel, Memory, or management change is allowed.

## Decision

The existing direct-static-global policy is semantic, not spelling-dependent. Before evaluating a receiver as `globalThis` or `global`, each guard must unwrap transparent syntax only:

- Source TypeScript: parenthesized, `as`, `satisfies`, and non-null expressions.
- Emitted JavaScript: parenthesized expressions.

The rule then rejects all design/61 nested self aliases, including wrapped spellings such as:

```ts
(globalThis).global
(globalThis as typeof globalThis).global
(globalThis satisfies typeof globalThis).global
(globalThis!).global
```

This is deliberately not general alias/data-flow analysis. It only normalizes the AST wrappers that preserve the identical receiver at runtime before applying the existing bounded global-loader rule.

## Required evidence

Both guard suites must reject the complete pre-admission raw-store tail rooted at:

```ts
const processRef = (globalThis).global.process;
const builtin = Object.getOwnPropertyDescriptor(processRef, "getBuiltinModule")!.value;
const raw = builtin("node:module")
  .createRequire(import.meta.url)("./chat-thread-store.js")
  .acceptP4MountedPlayerMessage;
```

Source coverage must additionally reject the three source-only erased wrappers. Re-run both guard suites, actual source checker, Host typecheck/build-test, serial P4 focused emitted suite after a standalone build, diff check, and a fresh independent authority review.

## From 63_CHAT_PIPELINE_BATCH_05_P4A_TRANSPARENT_PROCESS_CAPABILITY_CLOSURE.md

## Scope

Only these files may change:

- `tools/check-host-production-import-boundary.mjs`
- `tools/check-host-production-import-boundary.test.mjs`
- `host/scripts/production-artifact.mjs`
- `host/scripts/production-artifact.test.mjs`

No product, durable behavior, HTTP, browser, provider, SSE, presentation, cancel, Memory, or management changes are permitted.

## Decision

The transparent-expression normalization introduced by design/62 applies to every syntactic value tested as a Node `process` capability path, not only global-object receivers:

- Source TypeScript unwraps parenthesized, `as`, `satisfies`, and non-null expressions.
- Emitted JavaScript unwraps parenthesized expressions.

After normalization, the existing exact process/global-process checks apply. This remains a bounded AST normalization rule, not variable alias/data-flow analysis.

## Required evidence

Both guards must reject the full raw-store tail rooted at:

```ts
const processRef = (process);
const builtin = Object.getOwnPropertyDescriptor(processRef, "getBuiltinModule")!.value;
const raw = builtin("node:module")
  .createRequire(import.meta.url)("./chat-thread-store.js")
  .acceptP4MountedPlayerMessage;
```

Source coverage must also prove the source-only erased wrapper forms. Re-run both guard suites, actual source checker, Host typecheck/build-test, serial P4 focused emitted suite after a standalone build, production artifact verification, diff check, and fresh independent review.

## From 64_CHAT_PIPELINE_BATCH_05_P4A_PRODUCTION_COMPOSITION_CLOSURE.md

## Scope

Only production-emission, production-artifact composition/verification, their focused tests, and this design may change. No P4 HTTP/browser/profile/provider/SSE/presentation/cancel/Memory/management behavior changes are allowed.

## Decision

P4a is a Host-internal mounted capability, not a launchable application entry point. It must therefore be emitted and retained in every production generation as a **verification composition root**, while remaining ineligible for `resolveProductionEntry()` or any launcher-facing entry selection.

The production artifact configuration has two disjoint lists:

- `entryRoots`: existing launchable root files, constrained to direct root-level filenames;
- `verificationRoots`: non-empty only for frozen internal composition modules. Each must be a canonical, relative `.js` module path below the artifact root, with no absolute path, traversal, backslash, empty segment, or duplicate. It is retained and fully verified but cannot be resolved as a production entry.

For this slice, the sole verification root is:

```text
tavern/p4-durable-turn-acceptance.js
```

Its static closure includes the private bridge, coordinator admission internals, and raw `ChatThreadStore` ingress. `retainEntrypointClosure`, artifact reachability verification, inventory generation/recheck, and external runtime lexical scanning must operate on the union of launchable entry roots and verification roots. Runtime entry selection remains limited strictly to `entryRoots`.

## Required evidence

1. `tsconfig.production.json` emits the P4 facade (and therefore its private bridge closure).
2. A production build’s inventory contains both P4 facade and private bridge.
3. Removing either P4 module from a completed generation causes `assertCompleteProductionArtifact()` to fail due to a missing verification root or its reachable closure.
4. `resolveProductionEntry(..., "tavern/p4-durable-turn-acceptance.js")` remains rejected as `production_entry_not_configured`.
5. Existing launchable roots and browser artifact behavior remain unchanged.
6. Run production artifact / build tests, source import boundary, actual production build and recheck, Host typecheck/build-test, serial P4 focused suite, `git diff --check`, then fresh independent authority review.

## Non-goals

No public route, browser import, direct start command, profile operation, or actual turn-attempt behavior is introduced. This is emitted authority evidence only.

## From 65_CHAT_PIPELINE_BATCH_05_P4A_STRICT_PRODUCTION_CONFIG_CLOSURE.md

## Decision

`production-artifact.config.json` is a versioned, exact production authority descriptor. It is schema `gamebuddy-host-production-artifact-config/v2` and must have only these top-level keys:

```text
schema
entryRoots
verificationRoots
resources
browserArtifact (optional)
windowsReparseInspector (optional)
externalRuntimeClosure
```

`verificationRoots` is required—not defaulted—and must equal the frozen P4 composition root list exactly:

```text
tavern/p4-durable-turn-acceptance.js
```

An absent, empty, reordered-with-extra, replacement, duplicate, entry-root-overlapping, malformed, or unknown-key configuration fails before any artifact copying, inventory construction, or entry resolution. Test fixtures must state this descriptor explicitly; no legacy config shape remains accepted.

The prior division remains unchanged: `verificationRoots` participates in emitted closure retention and full artifact verification but is never accepted by `resolveProductionEntry()`.

## Evidence

Tests must demonstrate `readArtifactConfig()` rejects wrong schema, missing verification roots, empty/replaced/extra P4 root, and unknown keys. Existing published-artifact composition, serial P4 behavior, source-boundary and typecheck gates must remain green. A fresh independent review must confirm P4 proof can no longer silently disappear through configuration downgrade.

## Non-goals

No runtime behavior, public API, browser route, provider attempt, event stream, presentation, cancellation, or management capability changes.