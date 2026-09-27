---
reviewId: registration-topology-review
scope: >
  Independent adversarial review of the Shape B host↔game layer boundary and
  Stardew installation-registration privacy after the owner-approved
  unification that deleted the legacy game-layer Guardian facade
  (commit 93da045 "refactor(stardew): retire the orphaned Guardian owner seam")
  and the follow-up removal of a stale seam-allowlist entry
  (commit 3b12a18 "chore(tools): drop the deleted guardian module from the seam
  allowlist"). Files reviewed: tools/check-host-game-physical-seam.mjs,
  design/adr/0007-*.md, host/src/composition/stardew/stardew-guardian-platform.ts,
  host/src/games/stardew/provider.ts, host/src/stardew-installation-registration.internal.ts,
  design/architecture/stardew-installation-runtime-registration-plan.md (gates 1-10),
  desktop/GameBuddy.Desktop/RuntimeSupervisor.cs.
verdict: NO BLOCKER
date: 2026-09-27
reviewer: worker-subagent (independent adversarial review)
reviewerModel: worker-subagent (model identifier not exposed to the reviewing agent)
---

# Registration Topology Review

Both named commits are ancestors of `HEAD` (`a601ea1`); confirmed with
`git merge-base --is-ancestor`. `git cat-file -t` resolves `93da045`, `3b12a18`,
and the two referenced ancestors `2a34f2d` / `624a657`, so the unification story
in the commit messages is traceable, not asserted.

## Commands actually run

```text
node tools/check-host-game-physical-seam.mjs
  -> "host game physical seam: passed (16 production files)"   exit 0

node --test tools/check-host-game-physical-seam.test.mjs
  -> tests 17 | pass 17 | fail 0                               exit 0

npx depcruise --config .dependency-cruiser.host-production.cjs host/src/composition/desktop-host-composition.ts
  -> 1 warning (games-must-not-import-unapproved-generic-layers:
     composition/stardew/stardew-guardian-platform.ts -> games/stardew/.../stardew-private-bootstrap-composer.core.ts)
     "x 1 dependency violations (0 errors, 1 warnings). 134 modules"   exit 0

npx depcruise (temporary type-level config, tsPreCompilationDeps: true, games -> generic)
  -> 2 errors, both sanctioned edges:
     games/stardew/.../stardew-private-bootstrap-composer.internal.ts -> bootstrap/roots/stardew-private-mod-profile-staging.ts
     games/stardew/.../stardew-private-bootstrap-composer.core.ts    -> containment/runtime/contract/game-runtime.ts
  -> no game -> containment/runtime/core, no game -> containment/auth edge
```

The 16 inspected production files are exactly
`bootstrap/{entry,roots,wire}` (3), `composition` (5), `containment` (3),
`games/stardew` (5, including `provider.ts`). `games/stardew` contributes only
`lifecycle/*` + `provider.ts`; `provider.test.ts` is correctly excluded as a test.

---

## Q1 — Does `host/src/games/stardew/**` still reach forbidden layers or build native frames?

**Answer: no live violation.** Evidence:

- The only generic-layer import from the game layer is the sanctioned contract:
  `host/src/games/stardew/lifecycle/stardew-private-bootstrap-composer.core.ts:55`
  (and the inline `import("…/containment/runtime/contract/game-runtime.js")` type
  references at lines 190, 192, 195, 197, 200, 203). That is
  `containment/runtime/**contract**`, which ADR-0007 line 44/79 explicitly permits.
- The only other game→generic edge is the allowlisted staging provenance:
  `…/stardew-private-bootstrap-composer.internal.ts:10` →
  `bootstrap/roots/stardew-private-mod-profile-staging.js` (see Finding 4 for the
  ADR divergence in that allowance).
- `host/src/games/stardew/provider.ts` imports only
  `integration-catalog.js`, `game-browser-contract/index.js`,
  `game-browser/game-browser-state-provider.js`,
  `stardew-production-lifecycle-coordinator.internal.js`, and the game-owned
  `lifecycle/stardew-private-bootstrap-composer.core.js` (provider.ts:1-16). It
  does **not** import containment, runtime/core, the auth transport, any Windows
  module, Guardian, or Desktop. The Windows picker is relayed as an opaque
  branded type declared locally (provider.ts:27-30), which is the correct pattern.
- No raw `node:child_process`/`process`/`worker_threads` anywhere under
  `games/stardew` except the single allowlisted owner
  `lifecycle/stardew-process-implementations.ts:1`, which the process-owner test
  ("allows the Stardew lifecycle process owner and approved provenance contract")
  pins.
- **No native frame bytes in the game layer.** No `TextEncoder` occurs anywhere
  under `host/src/games/stardew/**` (repo-wide `TextEncoder` hits are only the
  two navigation characterization validators under `tools/`). The two `Uint8Array`
  / `Buffer` occurrences in `…/stardew-private-bootstrap-composer.core.ts:2682`
  and `:2689` are the `content: string | Uint8Array` parameter of the
  mod-profile **staging file writer** (`writeManagedFile`, byte-for-byte reread
  proof at :2690), not a platform-frame representation. The composition-owned
  encoder is where it belongs:
  `composition/stardew/stardew-guardian-platform.ts:121-136`
  (`encodeNativeRoleLaunchPlan` → `new TextEncoder()`) and `:251-263`
  (`encodeArmAuthorization`).

So the *stated* Shape B outcome holds in current source. What does **not** hold is
the checker's ability to keep it holding — Findings 1 and 2.

---

## Findings

### 1. HIGH — The seam checker is blind to type-only `import("…")` edges, so the exact forbidden layers ADR-0007 names can be re-imported with the gate still reporting `passed`

Evidence (file:line):
- `tools/check-host-game-physical-seam.mjs:150-161` — the AST visitor records a
  reference only for `ImportDeclaration`, `ExportDeclaration`,
  `ImportEqualsDeclaration` (external module ref) and `CallExpression` with
  `import`/`require`. A TypeScript `ImportTypeNode`
  (`import("path").Type`) is none of these and is not recorded.
- `tools/check-host-game-physical-seam.mjs:184-186` — the
  `game_imports_generic_layer` / `game_imports_desktop_raw_module` decisions only
  run inside `for (const reference of references)`, so an unrecorded edge is
  never evaluated. `unresolved_dynamic_import` (:164) does not fire either.

Empirical proof (throwaway fixtures against the real checker export; probes were
run and then deleted):
```text
A  host/src/games/stardew/lifecycle/probe.ts =
     export type X = import("../../../containment/runtime/core/contained-game-runtime.js").ContainedGameRuntime;
   -> passed   []
B  same edge written as `import type { … } from "…/runtime/core/…"`
   -> blocked  ["game_imports_generic_layer"]
C  export type Y = import("../../../containment/auth/desktop-guardian-session.internal.js").DesktopGuardianSession;
   -> passed   []
D  composer.core-shaped inline import() of runtime/core
   -> passed   []
```
B proves the checker sees the edge when written one way and not the other; A/C/D
prove the `import()` spelling is a full blind spot for the game layer.

This is not a theoretical concern. The `93da045` commit itself updated
`design/tasks/active/stardew-bootstrap-containment-recovery.md` with the sentence
"**The automated seam checker inspects imports, not type declarations, so nothing
currently catches it.**" That is a recorded instance of a seam existing outside
the gate; the gate was not subsequently hardened.

Recommended fix: in `check-host-game-physical-seam.mjs`, extend the visitor to
record `ts.isImportTypeNode(node)` whose `node.argument` is a `ts.LiteralTypeNode`
with a `StringLiteral`, using the same `source.getLineAndCharacterOfPosition`
line reporting. Then add a test case to
`tools/check-host-game-physical-seam.test.mjs` mirroring probe A/C (expect
`blocked`, `game_imports_generic_layer`) so the blind spot cannot return.

---

### 2. HIGH — The checker never inspects the flat `host/src/*.ts` production layer, so design gate 10 has no implementing test

Evidence (file:line):
- `tools/check-host-game-physical-seam.mjs:136` —
  `productionFiles = allFiles.filter((p) => genericPath(p, root) || gamePath(p, root))`
  where `genericPath` is `GENERIC_LAYERS.has(layer(...))` and
  `GENERIC_LAYERS = {bootstrap, containment, composition}` (:11). Files directly
  under `host/src/` therefore have `layer() === "README/…"`-style non-matching
  first segment and are traversed only for the *placement* check (:140-145), never
  as importers.
- `design/architecture/stardew-installation-runtime-registration-plan.md:204`
  (gate 10) requires: *"production import tests reject registration-core/storage
  imports from Preview, Portfolio, operator selection, generic launcher, browser
  DTO, run manifest, operational runner and action-development."* Every one of
  those producers is a flat `host/src/*.ts` module
  (`stardew-integration-launcher.ts`, `run-manifest.ts`,
  `game-operational-gate-evidence.ts`, `stardew-game-integration-adapter.ts`, …)
  or lives outside `host/src/{bootstrap,containment,composition,games}`. No test
  in the repo asserts that (grep for the registration module name across
  `*.test.ts`, `tools/*.mjs` matches only the seam checker and its own suite).

Empirical proof (throwaway fixtures, then deleted):
```text
F flat host/src/stardew-production-lifecycle-coordinator.internal.ts imports
  withStardewLifecycleInstallationRegistrationOwner from the registration module
  -> passed   []   inspected: 0
G flat host/src/stardew-something.internal.ts does require(registration module)
  -> passed   []   inspected: 0
H flat host/src/stardew-something.internal.ts imports containment/runtime/core
  -> passed   []   inspected: 1   (the runtime/core file itself is inspected; the importer is not)
I flat host/src/stardew-something.internal.ts imports bootstrap/roots staging
  -> passed   []   inspected: 1
```
Case F is the important one: gate 10's "registration-core/storage imports" from a
non-owner flat module are invisible to the gate, and the
`stardew_registration_import_not_owner` rule (:179-181) can never fire outside
`bootstrap|containment|composition|games`.

Current source is clean — no flat module imports `containment/runtime/core`,
`bootstrap/roots`, or the registration mutation facade (verified by direct scan
of `host/src/*.ts`) — so this is a *detection* gap, not a live defect.

Recommended fix: either widen the inspected set to every production `host/src/**`
file that is not a test/fixture (the `isTest` predicate already exists at :62-66),
or add an explicit gate-10 test that enumerates the named producers from the plan
and asserts none imports `stardew-installation-registration.internal` (mutation
facade) or `containment/runtime/core`. Widening the traversal is the smaller
change and also closes Finding 1's blast radius for flat modules.

---

### 3. HIGH — A second stale allowlist entry of exactly the kind `3b12a18` removed still grants a live game module permission to import the auth transport

Evidence (file:line):
- `tools/check-host-game-physical-seam.mjs:35-42`:
  ```js
  const ALLOWED_STARDew_GENERIC_IMPORTERS = new Map([
    ["containment/auth/desktop-guardian-session.internal", new Set([
      "games/stardew/lifecycle/stardew-private-bootstrap-composer.internal",   // :37
    ])],
    ["bootstrap/roots/stardew-private-mod-profile-staging", new Set([ … ])],     // :39-41
  ]);
  ```
- The named importer **no longer imports that module.** Commit `3a7f46c`
  ("remove retired desktop-session guardian seam and dead test bindings",
  2026-09-18) deleted
  `createStardewBootstrapGuardianOwnerFromDesktopSession` and, with it,
  `import type { DesktopGuardianSession } from "../../../containment/auth/desktop-guardian-session.internal.js";`.
  Today `host/src/games/stardew/lifecycle/stardew-private-bootstrap-composer.internal.ts`
  contains no `guardian`/`session` import — only the game-owned
  `StardewBootstrapGuardianSettlementProof` type and the `StardewBootstrapGuardianOwnerFactory`
  type declaration.
- `tools/check-host-game-physical-seam.test.mjs:40-45` still *exercises* the dead
  permission with a synthetic fixture
  (`"import type { DesktopGuardianSession } from '../../../containment/auth/desktop-guardian-session.internal.js';"`),
  so the suite pins the inert allowance instead of the live graph.

This is the same defect class that `3b12a18`'s own commit message describes:
*"A stale allowlist entry is an inert permission that would silently re-admit the
retired path if the file ever returned, so remove it rather than leave the slot
open."* The remaining entry is strictly worse than the one that was removed,
because it points at a module that still exists and is still live
(`containment/auth/desktop-guardian-session.internal.ts` is imported by
`bootstrap/wire/desktop-runtime-bootstrap.internal.ts:4`,
`composition/desktop-host-composition.ts:10` and
`composition/stardew/stardew-guardian-platform.ts:18`), so the permission is
immediately usable rather than only re-admissible. ADR-0007 line 89 forbids
`games/stardew/** → containment auth transport` unconditionally.

Recommended fix: delete `tools/check-host-game-physical-seam.mjs:37-38`
(keeping only the `bootstrap/roots/stardew-private-mod-profile-staging` entry
that has a live importer), and update the fixture at
`check-host-game-physical-seam.test.mjs:40-43` to drop the `DesktopGuardianSession`
line so the "allows the Stardew lifecycle process owner and approved provenance
contract" test asserts the live graph rather than an inert permission. Keep a
negative test that a game-layer `import type { DesktopGuardianSession }` is
`blocked` with `game_imports_generic_layer`.

---

### 4. MEDIUM — The `bootstrap/roots` exception for `games/stardew` is enforced by two tool configs but is absent from ADR-0007, which lists `bootstrap roots` as forbidden

Evidence (file:line):
- `design/adr/0007-…md:89` — forbidden: *"games/stardew/** → runtime/core、containment auth transport、bootstrap roots、Desktop、Guardian、Windows、Win32/native 或任何 raw IPC/pipe/token/Job/PID/path"*. Unqualified: game modules may not import bootstrap roots.
- `tools/check-host-game-physical-seam.mjs:39-41` grants
  `bootstrap/roots/stardew-private-mod-profile-staging` to
  `games/stardew/lifecycle/stardew-private-bootstrap-composer.internal`.
- `.dependency-cruiser.host-production.cjs:42` likewise carries
  `bootstrap/roots/stardew-private-mod-profile-staging` in the `pathNot` list of
  the `games-must-not-import-unapproved-generic-layers` rule.
- Live importer: `…/stardew-private-bootstrap-composer.internal.ts:10`.
- `design/adr/0007-…md:44` states the governing rule for such changes: *"Moving or
  renaming either path requires updating this ADR and the directory-local
  ownership rules atomically."* The directory-local rule was written
  (`host/src/games/stardew/lifecycle/README.md:10-13` describes the injected
  capability model) but the ADR was not amended, and a grep of `design/**/*.md`
  for `stardew-private-mod-profile-staging` returns nothing.

Impact: the frozen authority and the executable gate disagree, so a reader
auditing ADR-0007 alone would conclude the tree is in violation, and a future
reviewer has no ADR-sanctioned way to tell this exception from an accident.

Recommended fix (pick one, and make the two artifacts agree):
(a) amend `design/adr/0007-…md:89` to name the single exception
`bootstrap/roots/stardew-private-mod-profile-staging` and state why (provenance of
the staged mod profile, no process/transport authority); or
(b) remove the dependency by having composition inject the staging provider the
way it already injects the folder-picker capability (`provider.ts:27-30`,
`InjectedStardewFolderPickerCapability`), then delete the allowlist entry from
both tool configs. Option (b) matches the ADR's stated composition direction and
the pointer's own inspection.

---

### 5. MEDIUM — `containment/runtime/core` is whitelisted for games in the dependency-cruiser config, contradicting ADR-0007; both boundary rules are non-failing `warn`

Evidence (file:line):
- `.dependency-cruiser.host-production.cjs:42` `pathNot`
  `"^host/src/(?:containment/auth/desktop-guardian-session\\.internal|containment/runtime/contract|containment/runtime/core|bootstrap/roots/stardew-private-mod-profile-staging)"`
  — this exempts **runtime/core** and the **auth transport** in addition to the
  ADR-permitted contract. ADR-0007 lines 44 and 89 permit only
  `containment/runtime/contract/game-runtime.ts` to the game layer and forbid
  `runtime/core` outright.
- Rules `generic-layers-must-not-import-games`
  (`.dependency-cruiser.host-production.cjs:21-23`) and
  `games-must-not-import-unapproved-generic-layers` (:33-35) are both
  `severity: "warn"`, and the config declares no `errorThreshold` (grep for
  `errorThreshold|maxWarnings|ruleSet` returns nothing). Confirmed empirically:
  the current tree produces **1 warning and exit code 0** for the sanctioned
  composition→game edge.
- The package script that runs it (`package.json:53`,
  `check:host-module-graph`) therefore cannot fail on a game-layer boundary
  violation; only the seam checker can, and per Findings 1-2 its coverage has two
  holes.

Impact: the two executable gates for ADR-0007 both under-enforce. Neither is
currently tripped, so this is a hardening finding, not a live violation. Note also
that `containment/runtime/core` in the `pathNot` list means the *very* edge the
ADR calls out is explicitly suppressed in the dependency-cruiser gate — only the
seam checker (with its blind spots) would catch it.

Recommended fix: narrow the `pathNot` to
`containment/runtime/contract` and `bootstrap/roots/stardew-private-mod-profile-staging`
only (plus `desktop-guardian-session.internal` **if and only if** Finding 3's
allowance is kept — otherwise drop it too), and either raise both game/generic
rules to `severity: "error"` or add an explicit `errorThreshold` so the boundary
gate can fail.

---

### 6. LOW — `provider.ts` publishes the coordinator's whole activation owner on the projection while its doc comment claims private snapshots stay in the module's closure

Evidence (file:line):
- `host/src/games/stardew/provider.ts:124-127`:
  ```js
  const lifecycleActivationBindingSink = Object.freeze({
    ...coordinator.activationOwner,
    gameDiscovery: createStardewGameDiscoveryBinding(coordinator.activationOwner),
  });
  ```
  `coordinator.activationOwner` is the full owner object built at
  `stardew-production-lifecycle-coordinator.internal.ts:1753-1770`
  (`bindBrowserAdmissionIssuer, activate, setupPlayerHost, launchPlayerHost,
  readPrivateActivationSnapshot, readCabinChoices, confirmCabinChoice, resume,
  createGameSession, cancelResume, reopenActionAuthority, openInstallationPicker,
  readInstallationDiscovery, …`), so the spread carries
  `readPrivateActivationSnapshot` and `activate` across the seam.
- `host/src/games/stardew/provider.ts:32-38` claims: *"the coordinator object,
  private activation snapshots, and launch authority stay in this module's
  closure."* The coordinator object is indeed not published, but the activation
  owner is, and it is the object that produces the private snapshot.
- The declared sink type
  (`composed-reference-game-browser.ts:114-140`,
  `integration-catalog.ts:59-63`) narrows what a well-typed consumer may call, and
  every real consumer builds an explicit property allowlist
  (`tavern/composed-reference-game-static-shell-composition.ts:93-170` names each
  seam individually). The snapshot itself carries no locator, guardian fact or
  registration revision — it is exactly
  `{schemaVersion, requestId, authorityGeneration, revision, state}`
  (`stardew-production-lifecycle-coordinator.internal.ts:91-97`), and its exact
  keys are pinned by tests
  (`stardew-production-lifecycle-coordinator.internal.test.ts:893`).

Impact: no durable fact leaks today, so per ADR-0007's validation-budget
clarification (lines 110-119) this does not justify a new gate. It is worth
naming because the comment is inaccurate and because a structural narrowing is
cheap: the projection is a superset of its declared seam.

Recommended fix: replace the spread with an explicit allowlist (the properties the
sink type actually declares), or correct the comment at `provider.ts:32-38` to say
that the *snapshot reader* is technically reachable but is a stateless closure.
Prefer the explicit allowlist — it keeps the comment true and preserves the
"one spelling per concept" property.

---

### 7. NOTE — `RAW_STARDew_MODULES` deny entries, ADR directory list, and scratch artifacts

- `tools/check-host-game-physical-seam.mjs:43-46` lists
  `windows-bootstrap-guardian`, `windows-stardew-folder-picker`,
  `windows-stale-lock-reclaimer`, `windows-reparse-inspector`. All four paths still
  exist under `host/src/`, so these are **live deny entries** — correct to keep.
  No deleted-module names remain in any checker allowlist or deny list: the only
  path-shaped names the checker references (`GAME_IMPORTABLE_GENERIC_PATH`,
  `STARDew_PROCESS_IMPLEMENTATIONS`, `STARDew_REGISTRATION`,
  `STARDew_REGISTRATION_OWNER`) all resolve to existing files. The `3b12a18`
  removal was complete within the checker.
- `design/adr/0007-…md:70` still declares the fixed seam directories as
  `games/stardew/{lifecycle,launch,bridge}`; `launch/` and `bridge/` do not exist
  (only `lifecycle/`, `provider.ts`, `README.md`). The ADR at line 74 says these
  READMEs are created "在落地时", so this is forward-looking wording rather than a
  stale claim — noting it only so a reader does not mistake it for drift.
- Stale-but-harmless retired-name references outside authority:
  `check-tests.mjs:9` (repo root, **untracked scratch** — not a repo artifact);
  `handoff.md:200,372` and `handoff-action-nav.md:134` (tracked handoff notes, not
  current authority); the gitignored-in-intent but **untracked** `host/.dist-*`
  build trees (`host/.dist-discovery-run/…`, `host/.dist-focused-review/…`, …)
  still contain compiled copies of the deleted module
  (`…/stardew-bootstrap-guardian.private.js`) and of the retired
  `contained-game-runtime-platform.private.js`. `git check-ignore` reports these
  paths as **not** ignored, so they surface as `??` noise; they are outside the
  checker's `host/src` root and no packaging script reads them. No action needed
  for this review's scope; worth a later `rm -rf` under the temporary-data policy.
- `git diff --cached --name-only` is empty. Working tree has pre-existing
  modifications from other lanes (`design/**`, `dialogue-web/**`, `host/src/protocol.ts`,
  `integrations/stardew/action-development/**`); none of them touch the files in
  this review's scope, and this review wrote only
  `design/reviews/registration-topology-review.md`.

---

## Q2 — Other stale allowlist / allowance / inventory entries naming deleted modules or retired seams

Beyond Findings 3 and 5:

- **No further stale allowlist entry exists in the seam checker.** Every
  path-shaped constant resolves (`containment/runtime/contract/game-runtime.ts`,
  `games/stardew/lifecycle/stardew-process-implementations.ts`,
  `stardew-installation-registration.internal.ts`,
  `games/stardew/lifecycle/stardew-private-bootstrap-composer.core.ts`, all four
  `windows-*` deny targets, `bootstrap/roots/stardew-private-mod-profile-staging.ts`,
  `containment/auth/desktop-guardian-session.internal.ts`). Verified by
  `Test-Path` on each of the 11 referenced paths (all `True`).
- **No tracked config, script, package.json script, tsconfig, or `.cjs`/`.mjs`
  gate names a deleted module.** `git grep -n -E
  "stardew-bootstrap-guardian|contained-game-runtime-platform" -- "*.json" "*.mjs"
  "*.cjs" "*.yml" "*.yaml" "*.txt"` returns nothing; `git grep -ln
  "stardew-bootstrap-guardian" -- "host/tsconfig*.json"` returns nothing.
- The only surviving in-repo reference in *tracked source* is the negative
  assertion `host/src/games/stardew/lifecycle/stardew-private-bootstrap-composer.test.ts:590`
  (`assert.doesNotMatch(productionCoreSource, /…\/stardew-bootstrap-guardian\.private\.js/)`),
  which is an intentional "this must never come back" pin and should stay.
  Likewise `host/src/composition/desktop-host-composition.test.ts:43,58,114`
  assert the retired `StardewBootstrapGuardianOwnerFactory` name is absent from the
  composition surface. Both are correct anti-regression pins, not stale entries.
- `design/tasks/active/stardew-bootstrap-containment-recovery.md` names the
  deleted module inside the `93da045` "Residual closed" paragraph, i.e. as
  history. Correct.
- **Residual (not an allowlist, reported for completeness):**
  `StardewBootstrapGuardianOwnerFactory` is declared at
  `host/src/games/stardew/lifecycle/stardew-private-bootstrap-composer.internal.ts:23`
  and has **no consumer anywhere** other than the two `assert.doesNotMatch`
  call sites in `desktop-host-composition.test.ts:43`. It is the last surviving
  artefact of the retired game-layer Guardian owner seam. It is a type-only
  declaration with no runtime cost and no security consequence, and `93da045`
  deliberately trimmed the module to its settlement interface, so I am not
  calling it a defect — but it is dead surface that a future cleanup pass may
  want to remove alongside a matching assertion update.

---

## Q3 — Is the registration record opacity-preserving?

**Answer: yes at every projection I could reach; two minor notes.**

Preserved:
- `host/src/stardew-installation-registration.internal.ts:24-35` is the only
  record shape: `{schema, binding:{rootLayoutVersion}, revision, state, locator,
  activeAttempt:{bootstrapCorrelation}|null}`. `validateRecord` (:353-382) rejects
  any extra key via `requireExactObject` and requires the binding to have exactly
  `["rootLayoutVersion"]` (:357-358), so `continuityId`, `companionId`,
  `playerId`, `authorityGeneration`, guardian/Job/lease fields and a
  `productInstallationId` binding cannot be read in (gate 1).
- **No browser projection of the record exists.** Grep for
  `registration|locator|guardian` across `host/src/game-browser/**`,
  `host/src/game-browser-contract/*.ts`, `dialogue-web/src/**` returns **zero**
  matches. `GameBrowserStateV1` (`host/src/game-browser-contract/index.ts:189`) has
  no registration field, and there is no `readView()` registration DTO (gate 8's
  "no `readView()`" requirement holds).
- The discovery projection is path-safe **by construction, not just by filter**:
  `games/stardew/provider.ts:42-60` maps each candidate to
  `{candidateId, source, label, hint, status}` and `hint` is
  `candidate.displayPath === REDACTED_DISCOVERY_HINT ? REDACTED_DISCOVERY_HINT : null`
  (:51). Because an unexpected `displayPath` (e.g. a real path) yields `null`, not
  the path, the projection is fail-safe rather than fail-open. The contract schema
  `GameCandidateV1Schema` (`game-browser-contract/index.ts:239-245`) has no path
  field and `index.test.ts:91,95,99` reject a `path` key on the candidate, the
  confirm command and the mutation result. The upstream provider already redacts
  (`windows-stardew-installation-discovery/internal.ts:38` writes the literal).
- Errors are fixed tokens only: `stardew_installation_registration_{busy,conflict,
  unavailable}` and `invalid_stardew_installation_registration_publish`
  (:465-485); admission failures are `stardew_installation_admission_failed`
  (`stardew-installation-admission.core.ts:187`) and registration-missing is
  `stardew_registered_installation_unavailable`
  (`stardew-production-lifecycle-coordinator.internal.ts:841,1810`). The
  registration suite proves this dynamically: `rejectsRedacted(...)` asserts the
  sentinel locator appears in neither the message nor the error
  (`stardew-installation-registration.internal.test.ts:150-169`).
- The private activation snapshot carries no locator/revision/pointer:
  keys `["authorityGeneration","requestId","revision","state","schemaVersion"]`,
  asserted exactly at
  `stardew-production-lifecycle-coordinator.internal.test.ts:893`, with
  `JSON.stringify(...)` checked not to contain the game directory candidate at
  `:993` and `:1580`. Its `revision` is the *activation* revision
  (`stardew-production-lifecycle-coordinator.internal.ts:672-681`), not the
  registration revision — no conflated concept.
- The locator is consumed only inside the game lifecycle
  (`…coordinator.internal.ts:838-844` → `admitStardewInstallation(inspector, registration.locator)`)
  and written only through the single owner facade
  (`host/src/stardew-installation-registration.internal.ts:74-196`
  `withStardewLifecycleInstallationRegistrationOwner`), whose only production
  consumer is `games/stardew/lifecycle/stardew-private-bootstrap-composer.core.ts:48`
  — the same single-consumer shape the seam checker enforces at
  `check-host-game-physical-seam.mjs:179-181`.

Notes:
- (a) `provider.ts:40` and `windows-stardew-installation-discovery/internal.ts:38`
  define the redaction sentinel as two **independent** string literals that must
  stay byte-identical for `provider.ts:51`'s equality test to fire. Today the
  comparison only decides between the constant and `null`, both of which are
  path-free, so a drift cannot leak the locator — but the coupling is implicit.
  Prefer one exported constant, or keep the current fail-safe `null` default and
  note the coupling in `provider.ts:40`.
- (b) The record's `locator` is stored in cleartext in the runtime-root file
  (`stardew-installation-registration.internal.ts:384-398`). That is the intended
  Host-private durable design ("the locator remains Host-private and is never sent
  to browser, Devkit, adapter, control start/result, logs, or evidence" —
  `handoff.md:218`), so it is not a finding; noting only that the opacity claim is
  about *projections*, and the durable file itself is the authority.

---

## Q4 — Was the removed `productInstallationId` field genuinely unowned?

**Answer: yes. Verified. No production consumer and no launcher-side implementation exists.**

Evidence:
- Repo-wide, `productInstallationId` appears in exactly **two** places under
  `host/src`, both inside the negative test:
  `host/src/stardew-installation-registration.internal.test.ts:126` (test name,
  "…unowned productInstallationId…") and `:139`
  (`{ ...record(), binding: { rootLayoutVersion: 1, productInstallationId: "desktop_installation_01" } }`
  — asserted to be rejected). Zero production occurrences: the record type
  (`stardew-installation-registration.internal.ts:24-35`), the validator, the
  serializer and the wire never mention it.
- **Launcher side: nothing.** A recursive content search over `desktop/` for
  `productInstallationId|rootLayoutVersion|stardew-installation-registration|locator`
  returns no matches, and a search over all 62 `desktop/**/*.cs` files for
  `productInstallationId|rootLayoutVersion|InstallationRegistration` returns no
  matches. `RuntimeSupervisor.cs` never learns or emits the registration binding;
  the broker it constructs at `RuntimeSupervisor.cs:58`
  (`DesktopHostBootstrapBroker.Create(bootstrapId, selection, layout)`) takes the
  installed-generation selection and the root layout, neither of which carries a
  product-installation identity. So there is no launcher-side implementation that
  was silently orphaned by dropping the field.
- The removal is documented as deliberate and enforced:
  `handoff-action-nav.md:549-559` states *"`productInstallationId` is unowned and
  must not appear in registration schema, fixtures, validation, serialized
  records, or control protocols; records carrying it are rejected rather than
  migrated or compatibility-read."* Only `handoff.md:200` still lists it, in a
  historical *proposed* binding shape (`desktop binding { rootLayoutVersion,
  productInstallationId }`); `handoff.md` is a tracked handoff note, not current
  authority, and the same file's §317 area points at the recovery task that
  `93da045` closed.
- Enforcement is structural, not incidental: `requireExactObject(record.binding,
  ["rootLayoutVersion"])` (`stardew-installation-registration.internal.ts:357`)
  rejects the extra key, matching ADR-0007's "no compatibility layer, fallback or
  migration" and the project rule against backward-compatibility paths.

I found **no** surviving consumer, and I am saying so explicitly because the
prompt asked for a loud report if one existed: **none exists.**

---

## VERDICT: NO BLOCKER

No live production violation was found in the reviewed surface. The game layer
imports only the sanctioned contract and the one allowlisted staging provenance;
it builds no native frame bytes; the registration record contradicts no
projection and leaks no locator, pointer, guardian fact, or revision into any
browser/public DTO, error, or log; and `productInstallationId` is genuinely
unowned, with no production consumer and no launcher-side implementation.

The highest-severity findings are enforcement gaps in the Shape B gate rather than
boundary breaches, and they are cheap to close:

1. **HIGH** — seam checker is blind to type-only `import("…")`
   (`check-host-game-physical-seam.mjs:150-161`) — Findings 1.
2. **HIGH** — seam checker never inspects flat `host/src/*.ts`, leaving design
   gate 10 unimplemented (`check-host-game-physical-seam.mjs:136`) — Finding 2.
3. **HIGH** — one stale allowlist entry of the same class `3b12a18` removed still
   grants the auth transport to a live game module
   (`check-host-game-physical-seam.mjs:37-38`) — Finding 3.
4. **MEDIUM** — `bootstrap/roots` game exception and the `containment/runtime/core`
   whitelist are enforced in tooling but absent from / contrary to ADR-0007
   (`check-host-game-physical-seam.mjs:39-41`,
   `.dependency-cruiser.host-production.cjs:42`, ADR-0007:89) — Findings 4 and 5.
5. **LOW/NOTE** — projection/comment divergence in `provider.ts:124-127` vs
   `:32-38`, sentinel-literal coupling, dead
   `StardewBootstrapGuardianOwnerFactory` type, untracked `.dist-*` trees —
   Findings 6 and 7.

Recommended next step: land Findings 1-3 as one small hardening commit (extend the
AST visitor to `ImportTypeNode`, widen the inspected set to all non-test
`host/src/**` production files, delete the stale auth allowlist entry and update
its fixture, and add the two negative test cases), then resolve Finding 4 by
either amending ADR-0007 line 89 or injecting the staging provider from
composition. Finding 5 should be applied with the same commit that removes the
Finding 3 allowance so the two tool configs stay in agreement.
