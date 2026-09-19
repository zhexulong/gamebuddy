# Tavern Management World Info Binding Tracer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the project's `subagent-driven-development` skill to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a player on the currently mounted, pristine Chat inspect Host-owned managed World Info revisions and durably bind or unbind one exact immutable revision, with authoritative read-back in the management browser.

**Architecture:** Reuse the existing revisioned `WorldInfoManagementRepository`, extend its immutable `createManagedWorldInfoBindingResolver()` with exact-revision-only `bindExact(publicTitle, revision)`, and use `ChatThreadStore.setWorldBookBinding()` rather than creating a parallel World Info store or Chat-selection path. A lease-bound management service translates browser-only opaque source and binding-revision handles into the current immutable source title and the store's private `updatedAtMs` CAS value; browser callers never receive source storage handles, raw durable thread identifiers, timestamps, canonical hashes, or resolver authority. The existing management dispatcher projects the current state and handles the one CSRF-protected bind route; the React shell only renders the validated snapshot and replaces state with Host read-back.

**Tech Stack:** TypeScript ESM, Node HTTP, TypeBox/TypeBox Compile, existing Tavern `ChatThreadStore`, React, Vite, Playwright, Node test runner.

**Spec:** `design/78_CHAT_PIPELINE_FULL_PRODUCT_IMPLEMENTATION_PLAN.md` Task 10; `design/40_CHAT_PIPELINE_RELEASE_ENGINEERING_IMPLEMENTATION_PLAN.md` P9 management authority requirements.

## Global Constraints

- This is a **binding tracer**, not Task 10 completion: catalog create/edit/history, import/export, recovery, and broad World Info lifecycle remain out of scope.
- No Chat creation, active-selection mutation, runtime replacement, provider invocation, prompt assembly, Memory mutation, direct SQLite access, or browser-visible durable identity may be added.
- The only bind owner is `ChatThreadStore.setWorldBookBinding()`; it must receive its exact mounted thread/surface/companion/continuity tuple and its existing `updatedAtMs` optimistic CAS.
- Binding is legal only while `messages.length === 0`; existing store lock semantics remain authoritative. Greeting/opening content counts as content and therefore locks the binding.
- The browser may name only a canonical opaque source handle and opaque binding-revision handle minted by the lease-bound Host service. It must never send a public title, source storage handle, canonical hash, `updatedAtMs`, thread ID, surface ID, companion ID, continuity ID, or selector identity.
- Every mutable route is same-origin, browser-session authenticated, CSRF-protected, strict-schema validated, and has durable read-back before it returns `200`.
- Profile projection is closed and exact. The management profile gains only the named World Info routes/operation/navigation item; no UI control is rendered merely because an old mock component exists.
- Rejected mutations preserve the previous browser session until the client completes the authoritative `/state` re-read; a stale or locked request must never result in optimistic local binding state.
- Browser projections are safe public title/summary only. Resolver content, source handles, canonical hashes, managed storage handles, raw thread data, and `updatedAtMs` never leave Host.
- Preserve the dirty baseline outside the owned paths listed below. Do not revert, format, or stage unrelated work.

---

## Frozen Slice Card

```text
User-visible result:
  A mounted management user can open World Info, see the safe catalog of
  existing managed revisions, bind one exact revision to an empty Chat, or
  unbind it. The selected/locked state survives reload through durable
  read-back; no raw content or mutation outside bind/unbind is visible.

In scope:
  Existing managed-source catalog projection; exact current-Chat bind/unbind;
  opaque browser handles; revision conflict and content-lock failure recovery;
  English and existing zh-CN labels for the new mounted control.

Explicit non-goals:
  Creating/editing/deleting/importing/exporting World Info; Chat creation or
  switching; provider/runtime/prompt changes; any task-10 release claim.

Required topology and authority boundary:
  browser DTO -> management HTTP dispatcher -> lease-bound WorldInfoBinding
  service -> existing managed resolver + ChatThreadStore.setWorldBookBinding
  -> reopen/read-back -> strict DTO -> management state snapshot -> browser
  session/UI. The service owns all opaque-handle-to-private-fact mappings.

Acceptance scenario:
  Given a real mounted empty Chat and a real managed World Info revision,
  When the browser binds its opaque source handle using the opaque revision
  from the validated state snapshot, Then the Host stores the exact immutable
  binding and returns a read-back state whose item is selected. And after a
  reload the same exact revision remains selected. When it is unbound with
  the next opaque revision, the durable read-back is `none`. When a stale
  revision or a Chat with a message is used, Then the request rejects and
  the browser reads authoritative state without changing the prior UI.

Scenario-batch boundary:
  Contract, Host service, dispatcher/composition/state projection, browser
  client/session/UI, and one real mounted browser proof land together.

Cheapest seam checks:
  contract unit -> service mounted unit -> handler HTTP unit -> web DTO/session
  tests -> fresh emitted focused suites -> immutable production Chromium journey.

Mutation lane / owned paths:
  One writer owns the connected chain:
  host/src/tavern/world-info-management/**
  host/src/tavern/world-info-binding/**
  host/src/tavern/browser-contract/index.ts and its test
  host/src/tavern/tavern-management-state.ts and its test
  host/src/tavern-management-dialogue-web.ts and its test
  host/src/dialogue-web-main.ts
  dialogue-web/src/management-pipeline-api.ts
  dialogue-web/src/management-pipeline-session.ts
  dialogue-web/src/components/ManagementApp.tsx
  dialogue-web/src/i18n.ts
  dialogue-web/tests/management-pipeline-browser.spec.ts
  dialogue-web/tests/reference-pipeline-api.test.mjs and session test only if
  their management DTO fixtures require the new strict field.

Independent read-only lane:
  One final reviewer inspects the actual post-write diff and recorded gates;
  no parallel writer edits this chain.

Stop/escalation condition:
  Stop if this requires mounting an unapproved selector/runtime replacement,
  exposing a durable identity/timestamp, inventing a second binding store,
  changing prompt materialization, or broadening into catalog lifecycle.
```

## File Structure

| Path | Responsibility |
| --- | --- |
| `host/src/tavern/world-info-management/world-info-management.ts` | Existing durable, revisioned public managed-source owner; no browser route or source handle leaks. |
| `host/src/tavern/world-info-binding/managed-world-info-binding.ts` | Exact-revision resolver; add `bindExact(publicTitle, revision)` so browser-selected revisions never resolve as latest. |
| `host/src/tavern/world-info-binding/world-info-binding-management-service.ts` | New lease-bound adapter: safe source projection, opaque mapping, exact store CAS, durable read-back. |
| `host/src/tavern/world-info-binding/world-info-binding-management-service.test.ts` | Mounted service proof for bind/unbind, stale mapping/CAS, lock, forged lease/profile, and safe projection. |
| `host/src/tavern/browser-contract/index.ts` | Closed DTO schemas, route and operation declarations, profile-composition types. |
| `host/src/tavern/tavern-management-state.ts` | Exact mounted state projection including safe World Info state supplied by the binding service. |
| `host/src/tavern-management-dialogue-web.ts` | Profile gate, CSRF dispatcher, state projection, problem mapping, one route. |
| `host/src/dialogue-web-main.ts` | Production composition injects one repository/resolver/binding service into the management profile. |
| `dialogue-web/src/management-pipeline-api.ts` | Strict browser DTO mirror and same-origin client; no Host import. |
| `dialogue-web/src/management-pipeline-session.ts` | Atomic snapshot replacement/read-back state only; no optimistic source/binding mutation. |
| `dialogue-web/src/components/ManagementApp.tsx` | Capability-gated World Info panel, bind/unbind controls, state refresh after all outcomes. |
| `dialogue-web/src/i18n.ts` | English and zh-CN copy keys used by the actual panel. |
| `dialogue-web/tests/management-pipeline-browser.spec.ts` | Immutable artifact mounted journey with a real seeded managed repository revision. |

## Task 1: Close the World Info browser contract and service boundary

**Files:**
- Create: `host/src/tavern/world-info-binding/world-info-binding-management-service.ts`
- Create: `host/src/tavern/world-info-binding/world-info-binding-management-service.test.ts`
- Modify: `host/src/tavern/browser-contract/index.ts`
- Modify: `host/src/tavern/browser-contract/index.test.ts`

**Interfaces:**
- Consumes: `HostDeploymentManifest`, coordinator-branded `MountedChatRuntimeLease`, composed profile, `WorldInfoManagementRepository`, `createManagedWorldInfoBindingResolver()`, `ChatThreadStore.resumeThread()` and `.setWorldBookBinding()`.
- Produces: an extended resolver with the exact-only API:
  ```ts
  type ManagedWorldInfoBindingResolver = Readonly<{
    bindExact(publicTitle: string, revision: number): Promise<TavernStableManagedWorldInfoBinding>;
    resolve(binding: TavernStableManagedWorldInfoBinding): Promise<ManagedWorldInfoSource>;
  }>;
  ```
  and the browser-facing service types:
  ```ts
  export type WorldInfoStateV1 = Readonly<{
    state: "none" | "selected" | "locked" | "unavailable";
    revision: string;
    items: readonly Readonly<{
      handle: string;
      title: string;
      summary: string | null;
      selected: boolean;
    }>[];
  }>;
  export type SetWorldInfoBindingCommandV1 = Readonly<{
    apiVersion: 1;
    selectionGeneration: number;
    expectedRevision: string;
    sourceHandle: string | null;
  }>;
  export type WorldInfoBindingManagementService = Readonly<{
    read(): Promise<WorldInfoStateV1>;
    setBinding(command: SetWorldInfoBindingCommandV1): Promise<WorldInfoStateV1>;
    close(): Promise<void>;
  }>;
  ```

- [ ] **Step 1: Write the failing contract and mounted-service tests.**

  Add strict-schema cases that reject an extra field, noncanonical source handle, raw public title in the command, raw numeric `updatedAtMs`, absent CSRF route operation, and a profile where one new operation is missing.

  Add a mounted child-process service test that:
  1. creates a genuine mounted lease and an empty exact Chat;
  2. creates `Pelican Town` through the real repository;
  3. reads a state with an opaque item handle and opaque revision, neither equal to `Pelican Town` nor a numeric timestamp;
  4. binds using those two opaque values and observes `selected: true` after the service reopens the thread;
  5. attempts the old revision and receives the typed conflict;
  6. appends one normal message, then attempts unbind and receives the typed locked outcome without changing the durable binding;
  7. passes a forged/revoked lease and a profile missing `world-info.bind` and asserts construction fails before durable I/O.

- [ ] **Step 2: Run the focused tests to verify red.**

  Run the project’s normal emitted-test build command, then run the emitted contract and new service test files. Expected: route/schema and service imports fail because no World Info browser contract or service exists.

- [ ] **Step 3: Make immutable binding selection exact before adding the browser contract.**

  In `host/src/tavern/world-info-binding/managed-world-info-binding.ts`, add:

  ```ts
  async bindExact(publicTitle: string, revision: number): Promise<TavernStableManagedWorldInfoBinding> {
    if (!Number.isSafeInteger(revision) || revision < 1) throw new Error("managed_world_info_revision_missing");
    const history = await repository.history(publicTitle);
    const projection = history.find((candidate) => candidate.revision === revision);
    if (projection === undefined) throw new Error("managed_world_info_revision_missing");
    return bindingFor(projection);
  }
  ```

  Retire the latest-resolving `bind(publicTitle)` method rather than keeping two mutable-selection semantics. Add resolver tests showing that `bindExact("Pelican Town", 1)` remains revision 1 after repository revision 2 exists, and that an absent revision fails closed.

- [ ] **Step 4: Add the exact closed browser contract.**

  In `host/src/tavern/browser-contract/index.ts`:

  ```ts
  const WorldInfoBindingState = Type.Union([
    Type.Literal("none"), Type.Literal("selected"),
    Type.Literal("locked"), Type.Literal("unavailable"),
  ]);
  export const WorldInfoStateV1Schema = strictObject({
    state: WorldInfoBindingState,
    revision: OpaqueHandle,
    items: Type.Array(strictObject({
      handle: OpaqueHandle,
      title: Type.String({ minLength: 1, maxLength: 256 }),
      summary: Type.Union([Type.String({ maxLength: 512 }), Type.Null()]),
      selected: Type.Boolean(),
    }), { maxItems: 100 }),
  });
  export const SetWorldInfoBindingCommandV1Schema = strictObject({
    apiVersion: ApiVersion,
    selectionGeneration: PositiveGeneration,
    expectedRevision: OpaqueHandle,
    sourceHandle: Type.Union([OpaqueHandle, Type.Null()]),
  });
  ```

  Replace the existing snapshot's loose World Info object with `WorldInfoStateV1Schema`. Add `world-info.read` (`GET /api/tavern/v1/world-info`) and `world-info.bind` (`PUT /api/tavern/v1/world-info`) route descriptors. `world-info.bind` has operation ID `world-info.bind`, same-origin browser session auth, required CSRF, no idempotency, and the exact command schema. Add the operation/label literal and export static types/validators. Do not add a navigation item: this is a management-shell contextual panel, not an unapproved top-level route.

- [ ] **Step 5: Implement the lease-bound service with private mappings.**

  Create `world-info-binding-management-service.ts` with this construction shape:

  ```ts
  export function createWorldInfoBindingManagementService(options: Readonly<{
    manifest: HostDeploymentManifest;
    lease: MountedChatRuntimeLease;
    profile: ComposedTavernProfile;
    repository: WorldInfoManagementRepository;
  }>): WorldInfoBindingManagementService;
  ```

  At construction, require a current coordinator lease and a frozen composed profile containing both `world-info.read` and `world-info.bind`. Create the exact thread store from `manifest.runtimeRoot` and `identityKey(manifest.principal)`, then create the existing managed resolver from the supplied repository.

  On every `read()` and `setBinding()`:
  - reject a closed or noncurrent lease before I/O and after every await;
  - reopen only `lease.chatThreadId` + `lease.chatSurfaceSessionId` and verify the exact companion/continuity tuple against `manifest.principal`;
  - list public repository projections and mint random canonical opaque handles into a private per-service map whose values are `{ publicTitle, revision }`; never use or return a storage handle;
  - mint a distinct opaque `revision` map entry whose value is the reopened thread `updatedAtMs` plus its current binding fingerprint; the browser cannot decode it;
  - project `state: "locked"` when the exact thread has messages; otherwise `"none"` or `"selected"`; an unavailable repository/read maps only to `"unavailable"` for read and a typed unavailable error for mutation;
  - mark exactly one catalog item selected only when its `{ publicTitle, revision, canonicalHash }` equals the existing managed binding; an unsupported legacy WorldBook binding projects no selected item and does not become mutable;
  - on mutation, require matching `apiVersion`, exact lease selection generation, a private unexpired revision mapping, and a known current source mapping (or `null` for unbind); resolve `{ publicTitle, revision }` through `resolver.bindExact()` immediately before store mutation; call the existing `setWorldBookBinding()` with exact private identity tuple and mapped `expectedUpdatedAtMs`; reopen and return a new safe projection;
  - map store revision changes to `world_info_binding_conflict`, a nonempty transcript to `world_info_binding_locked`, missing/replaced mappings to `world_info_binding_conflict`, and storage/runtime failures to existing unavailable categories.

  The service must not export its store, resolver, maps, root, lease, source title lookup, timestamp, or canonical hash. `close()` only rejects future calls and clears maps; it must not close a coordinator-owned lease or repository.

- [ ] **Step 6: Run focused resolver, service and contract tests.**

  Rebuild the Host test artifact, then run the emitted browser-contract and `world-info-binding-management-service` suites. Expected: all pass, including genuine mounted lease, stale opaque revision, lock, profile gate, and raw-identity nonleak cases.

## Task 2: Mount the exact service in management state, HTTP and production composition

**Files:**
- Modify: `host/src/tavern/tavern-management-state.ts`
- Modify: `host/src/tavern/tavern-management-state.test.ts` (or the existing test file that owns this facade)
- Modify: `host/src/tavern-management-dialogue-web.ts`
- Modify: `host/src/tavern-management-dialogue-web.test.ts`
- Modify: `host/src/dialogue-web-main.ts`

**Interfaces:**
- Consumes: `WorldInfoBindingManagementService.read()` and `.setBinding()` from Task 1.
- Produces: validated `TavernStateSnapshotV1.chat.worldInfo`, `GET /api/tavern/v1/world-info`, and CSRF-protected `PUT /api/tavern/v1/world-info`.

- [ ] **Step 1: Write failing facade/HTTP tests.**

  Add handler tests that bootstrap an exact profile containing both World Info routes/operation and a stub World Info service. Assert:
  - bootstrap/state snapshots contain the exact safe World Info state;
  - `GET /world-info` requires an authenticated same-origin browser session, rejects query/body, and returns the validated service read;
  - `PUT /world-info` rejects missing/incorrect Origin, cookie, CSRF, content type, extra fields, raw title, and stale selection before calling the service;
  - a valid `PUT` calls only `setBinding()` with the strict DTO and returns its read-back;
  - a profile advertising either World Info route without the injected service fails construction;
  - conflict/locked/unavailable errors map to `409 state_reconciliation_required` or existing safe unavailable problem codes, never raw error text.

  Add facade tests for a World Info service returning malformed projection: `read()` must fail closed rather than construct a partial state.

- [ ] **Step 2: Run focused tests to verify red.**

  Rebuild the Host test artifact and run emitted management state/handler suites. Expected: exact profile assertions and the `/world-info` route are absent.

- [ ] **Step 3: Thread service into state projection.**

  Extend `createTavernManagementStateFacade` options only if required to receive `WorldInfoBindingManagementService`; retain the facade's existing exact lease identity checks. In `read()`, perform the existing exact thread projection and `worldInfoService.read()` under the same current-lease before/after-await policy, then validate `WorldInfoStateV1Schema` before returning it. Do not recreate or resolve catalog sources in the facade.

- [ ] **Step 4: Extend the closed management dispatcher.**

  In `tavern-management-dialogue-web.ts`:
  - append `world-info.read` and `world-info.bind` once, in fixed order, to the memory-capable management profile route set and append `world-info.bind` once to operation IDs;
  - inject `worldInfoService` as a required dependency exactly when that profile declares the World Info routes;
  - make `sendProjectedSnapshot()` obtain and validate the safe World Info state through the facade/service and put it in `chat.worldInfo`, never `null` for this profile;
  - implement `GET /api/tavern/v1/world-info` and `PUT /api/tavern/v1/world-info` using the same request/body/auth/CSRF discipline as `chat.rename`;
  - validate `SetWorldInfoBindingCommandV1Schema` before the service call and validate `WorldInfoStateV1Schema` before responding;
  - extend `close()` to close the binding service exactly once after active dispatches drain.

  Keep the profile ID stable only if its exact route/operation assertions are updated everywhere; otherwise choose a new composed profile ID and update the immutable artifact/browser expectations atomically. Do not leave a legacy accepted profile shape.

- [ ] **Step 5: Compose the real repository and service in production.**

  In `dialogue-web-main.ts`, create `createWorldInfoManagementRepository(manifest.runtimeRoot)` and pass it to `createWorldInfoBindingManagementService({ manifest, lease, profile, repository })`. Pass the same binding service to state facade and static shell composition. No browser fixture or production code may inject raw source records or an alternate resolver.

- [ ] **Step 6: Run focused Host gates.**

  Rebuild `host/dist-test`; run the new service, browser-contract, management state, and management handler emitted suites serially. Run `npm run typecheck` (or the repository's current direct TypeScript command) in `host`. Expected: all green with no profile fallback.

## Task 3: Consume only validated World Info facts in the management browser

**Files:**
- Modify: `dialogue-web/src/management-pipeline-api.ts`
- Modify: `dialogue-web/src/management-pipeline-session.ts`
- Modify: `dialogue-web/src/components/ManagementApp.tsx`
- Modify: `dialogue-web/src/i18n.ts`
- Test: `dialogue-web/tests/reference-pipeline-api.test.mjs`
- Test: `dialogue-web/tests/reference-pipeline-session.test.mjs`

**Interfaces:**
- Consumes: strict snapshot World Info state plus `GET/PUT /api/tavern/v1/world-info` DTOs from Tasks 1–2.
- Produces: a profile/operation-gated panel whose UI state is replaced only by validated Host read-back.

- [ ] **Step 1: Write failing browser DTO and reducer tests.**

  Add cases that reject: missing `revision`, a raw numeric revision, unknown World Info state, extra item property, two selected items, selected item when state is `none`, an unselected catalog when state is `selected`, raw title in bind command, malformed response, and a wrong status code. Add reducer tests that state replacement preserves exact mounted identity but rejects a changed selection fingerprint; it must not locally flip `selected` on a command.

- [ ] **Step 2: Run web tests to verify red.**

  Run the project’s management API/session test command against source or fresh emitted web tests. Expected: current loose `worldInfo` validation and no `readWorldInfo`/`setWorldInfoBinding` client calls.

- [ ] **Step 3: Mirror the strict contract locally.**

  Replace `worldInfo: Readonly<Record<string, unknown>> | null` in management snapshot types with a strict `WorldInfoStateV1` mirror. Implement exact local guards for `revision`, `state`, max 100 safe title/summary items, canonical opaque handles, and selection consistency. Add:

  ```ts
  readWorldInfo(): Promise<WorldInfoStateV1>;
  setWorldInfoBinding(
    command: SetWorldInfoBindingCommandV1,
    csrfToken: string,
  ): Promise<WorldInfoStateV1>;
  ```

  The client uses only relative same-origin paths, `credentials: "same-origin"`, and required JSON + `x-csrf-token` on `PUT`. It must never serialize a title, timestamp, source ID, root, or raw handle.

- [ ] **Step 4: Render the contextual panel with read-back replacement.**

  In `ManagementApp.tsx`, derive visibility only from the validated `chat.worldInfo` snapshot and the `world-info.bind` operation availability. Add a compact World Info toggle/panel only when that state is non-null; do not reuse `App.tsx` mock `WorldInfoDrawer`.

  Panel behavior:
  - display safe title/summary rows and current selected state;
  - offer Bind only for unselected items and Unbind only for the selected item, disabled when `state === "locked"`, `"unavailable"`, or operation unavailable;
  - on bind/unbind, submit the snapshot's opaque `revision` and selected `sourceHandle|null`;
  - on either success or failure, call `readState()`, apply the identity-checked snapshot to the reducer, then show a localized success/failure notice; never locally mutate row selection;
  - show a safe localized empty/locked/unavailable message, not raw server errors;
  - preserve existing draft/list/title/Memory behavior and prevent an open drawer/panel from blocking its actual controls.

  Add exact English/zh-CN message keys for the panel, bind/unbind, empty, locked, and unavailable copy. Do not add dormant character/provider/import controls.

- [ ] **Step 5: Run web checks.**

  Run the API/session test suites, `npm run typecheck`, and Vite build in `dialogue-web`. Expected: strict DTO tests, state-replacement behavior, typecheck, and production browser build pass.

## Task 4: Prove the real mounted browser journey and review the bounded slice

**Files:**
- Modify: `dialogue-web/tests/management-pipeline-browser.spec.ts`
- Modify: `design/78_CHAT_PIPELINE_FULL_PRODUCT_IMPLEMENTATION_PLAN.md` only after every gate below passes

**Interfaces:**
- Consumes: immutable generated Host/browser artifact and the production management composition from Tasks 1–3.
- Produces: a privacy-safe browser proof of exact durable bind/unbind/read-back; an accurate bounded-slice ledger entry.

- [ ] **Step 1: Seed a real managed revision through the production repository in the mounted fixture.**

  In `startMountedManagementComposition()`, dynamically load `tavern/world-info-management/world-info-management.js` from the immutable generation. Before starting the binding service, use `createWorldInfoManagementRepository(root).create()` with a safe synthetic title/summary/entry. Pass that same real repository to the production-equivalent binding service/composition. Do not use `page.route`, a UI mock, direct JSON writes, an in-memory source service, or a raw handle assertion.

- [ ] **Step 2: Add the bounded Playwright scenario.**

  Extend the English mounted journey (or add one independent test) to assert:
  1. bootstrap renders World Info sourced from a real `GET /world-info` and safe catalog title/summary;
  2. bind sends `PUT /world-info`, renders exactly one selected source, and no raw canonical hash/storage handle/content appears in DOM or observed request body;
  3. reload preserves the selected exact safe revision through real `/state` read-back;
  4. unbind sends `sourceHandle: null`, returns/render `none`, and reload remains unbound;
  5. after a durable message is appended through the real store fixture, a binding request yields the safe locked/failure behavior and the preexisting durable binding/transcript remain intact.

  Keep P8 Memory assertions and existing P9 draft/title/locale tests. Update fixed request counts only after recording the real endpoint counts; assert the World Info GET/PUT methods and paths explicitly rather than relying solely on totals.

- [ ] **Step 3: Run the full bounded verification set.**

  In order:
  1. fresh `host/dist-test` build;
  2. all changed Host emitted suites (service, contract, state, handler) serially;
  3. `host` and `dialogue-web` typechecks plus Vite build;
  4. `node host/scripts/build-production-artifact.mjs`;
  5. production artifact checker and Host import-boundary checker;
  6. immutable-generation management Chromium suite with `--workers=1`;
  7. `git diff --check -- <owned paths>`.

  Preserve exact commands, exit status, artifact generation, test totals, and the route evidence. If a stale/locked case is not demonstrably durable, stop rather than update the ledger.

- [ ] **Step 4: Fresh final review.**

  Dispatch one read-only reviewer after the writer's gates. The reviewer must inspect actual diff and evidence for: owner reuse, opaque mapping, exact lease/identity checks before/after awaits, raw identity/content nonleak, no selector/runtime/provider expansion, closed profile/route behavior, stale/lock read-back, and test validity. Fix only findings that affect this frozen slice; any required authority expansion is a blocker.

- [ ] **Step 5: Update the status ledger truthfully.**

  Only if the final reviewer accepts and all gates pass, update Task 10's status in `design/78_CHAT_PIPELINE_FULL_PRODUCT_IMPLEMENTATION_PLAN.md` to state:
  - released: bounded exact mounted managed World Info bind/unbind tracer;
  - evidenced: immutable browser artifact, exact durable read-back, conflict/lock behavior and safe projection;
  - still incomplete: catalog edit/history/import/export/recovery and full Task 10 lifecycle.

  Do not mark Task 10 complete.

## Self-Review

- **Spec coverage:** Task 10's full lifecycle requires catalog/edit/bind/unbind/export/conflict/recovery. This plan deliberately covers only the independently demonstrable bind/unbind/conflict/lock/read-back tracer, and the final ledger step explicitly records the uncovered lifecycle rows. It does not claim a substitute for Task 10 completion.
- **Authority coverage:** The only mutable producer is the existing exact-scope `ChatThreadStore.setWorldBookBinding()`; Task 1 maps browser handles privately and Task 2 carries it through the closed profile/dispatcher. No new selection or provider authority is introduced.
- **Persistence coverage:** Task 1 service read-back reopens the exact thread after mutation; Task 4 reloads the immutable browser artifact and asserts durable binding/unbinding and lock preservation.
- **Privacy coverage:** Task 1 and Task 3 reject raw fields structurally; Task 4 observes real request/DOM facts. The plan never exposes source storage handles, canonical hashes, resolver content, raw thread identity, timestamps, or roots.
- **Placeholder scan:** No task contains TBD/TODO/similar-to wording. Every changing seam has an explicit producer, consumer, verifier, and test command category.
- **Type consistency:** `WorldInfoStateV1`, `SetWorldInfoBindingCommandV1`, and `WorldInfoBindingManagementService` are declared in Task 1 and consumed under those exact names thereafter.

## Execution Handoff

Plan complete and saved to `design/84_TAVERN_MANAGEMENT_WORLD_INFO_BINDING_TRACER_IMPLEMENTATION_PLAN.md`.

Execution follows the project’s subagent-driven path: one writer owns the connected producer-to-browser chain, then one fresh read-only reviewer inspects the actual diff and complete acceptance evidence. The frozen slice explicitly stops if its implementation requires unapproved Chat replacement, new authority, or broad lifecycle expansion.
