---
id: TASK-WINDOWS-DESKTOP-HOST-RUNTIME-ADMISSION
type: task
status: completed
owner: windows-desktop-distribution
---

# Windows Desktop Host Runtime Admission and Root-Layout Capability

> **For agentic workers:** REQUIRED SUB-SKILL: Use the project's `subagent-driven-development` skill task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish the native Desktop predecessor that admits the exact bundled Host runtime/entry from the selected immutable generation, starts and authenticates that exact Host child through a one-shot private bootstrap channel, and lets Host fresh-revalidate the canonical root layout before any mutable owner opens.

**Architecture:** `GameBuddy.exe` consumes only the closed current-user root registration and the Host-owned selected generation admission contract. Host defines one generation-local `host-runtime-admission/v1` contract emitted atomically by the existing Host publisher only after its runtime executable, fixed Host entry, declared closure and inventory facts are verified. Desktop locks/verifies both runtime image and fixed Host entry identity through native handles: runtime remains locked through `CreateProcessW`; entry remains non-write/non-delete locked until the exact child completes bootstrap, proving its entry has loaded. Desktop starts only that admitted child and authenticates it using the same `CreateProcessW` process handle/PID plus native image and current-user token/SID comparison before writing a one-shot inherited-stdin bootstrap frame. The bootstrap frame supplies only fresh session material and opaque root-layout facts—not any CLI/environment root override. Host’s bootstrap consumer reconstructs/validates root layout, then fresh-revalidates every root’s current-user ownership, boundary ancestry/reparse state, program-generation separation and pairwise non-overlap before minting a non-serializable capability. This Phase 1 admission initializes and carries the long-lived Host composition but does not choose or synthesize Host `principal`, `authorityGeneration`, `fresh`/`known`, selected integration, GameSession, activation or world binding; those remain existing Host semantic-authority/composition and Phase 2 UI-driven GameSession owner facts. `dataRoot` is only one storage partition, never a complete authority; missing authority cannot create `local_default`, and known startup does not automatically increment `authorityGeneration`. No `ProductInputProducer` is introduced.

**Spec:** `design/103_WINDOWS_DISTRIBUTION_AND_DESKTOP_PRESENTATION_DESIGN.md` §§3–5; `design/tasks/active/windows-desktop-root-registration-layout.md`; `design/tasks/active/windows-desktop-guardian-generation-launcher.md`; `design/domains/stardew/integration.md`.

## Status and authority

`b098b57` closed root registration/layout and `6aaeb75` closed Guardian image admission/EOF supervision. This task was blocked on `TASK-HOST-BUNDLED-RUNTIME-BOOTSTRAP-CONTRACT`: the current Host artifact declares JS entry roots but does not declare/copy a fixed bundled runtime executable or fixed Host bootstrap entry, so Desktop cannot safely admit or authenticate an exact Host child. That publisher contract is now closed: the Host publisher emits an inventory-excluded `host-runtime-admission/v1` sidecar and a four-field `current.json` under a `runtime/` + `bootstrap/entry/` layout, and `build-desktop-launcher-test-generation.mjs` builds the source-bound fixture through that same publisher (`3da2a10` also removed the accidental `PublishAot` toolchain requirement that made the fixture depend on MSVC `link.exe`). The blocker is therefore resolved and this task's implementation is source-complete. This task establishes Desktop runtime admission and Host-side fresh root ownership validation. It does not start Guardian command relay, alter Task 3 process owners, create an app-instance owner, or present browser/UI.

## Accepted Desktop Host entry topology

The fixed Desktop-admitted script is the one formal Host entry:

```text
runtime/node.exe desktop-host-entry.internal.js
→ private desktop-runtime-bootstrap.internal.js frame/root admission
→ opaque desktop_root_layout/v1 capability
→ acknowledgement and Host lifetime
```

`desktop-host-entry.internal.ts` owns the only `import.meta.main` guard. The existing
`desktop-runtime-bootstrap.internal.ts` becomes an artifact-internal helper with no
terminal entry guard: it consumes the inherited one-shot frame, reconstructs and
revalidates the root layout, mints the non-serializable capability, and exposes only
private admit/ack/lifetime operations to the formal entry. The publisher sidecar,
Desktop lock, and `CreateProcessW` script argument name
`desktop-host-entry.internal.js`; the old entry name has no compatibility alias.

This task must **not** invent an inert mutable owner merely to consume the capability.
Its explicit fixture constraint forbids opening product owner stores, Guardian
sessions, installation selection, providers, browsers, or Stardew. The capability is
created by the accepted entry before acknowledgement and is reserved for a later
named product composition owner; that later owner must require it before any mutable
root-scoped construction. Ordinary `main.ts`, dialogue, preview, browser, and CLI
roots remain non-Desktop entrypoints and cannot mint or receive this capability.

## Global constraints

- Host publisher is the sole runtime/inventory/provenance authority. A `host-runtime-admission/v1` contract is an inventory-excluded fixed generation-local sidecar: Host first writes/verifies canonical inventory and digest, then emits/rechecks the contract’s exact canonical bytes, hashes those raw bytes, and only then atomically replaces the pointer. The destructive `current.json` has exactly `schema`, `generation`, `inventoryDigest`, and `runtimeAdmissionSha256`; the last field binds the pointer to the sidecar’s raw canonical bytes. The sidecar is emitted only after Host verifies the fixed runtime executable, fixed Host entry and declared external runtime closure already present in the selected generation. It is bound to the pointer inventory digest, generation identity, exact runtime/entry relative paths, file identities/digests and required entry facts. Desktop consumes this contract, not reconstruct inventory entries/origin/closure or create its own manifest/hash authority.
- Desktop production root source remains only `gamebuddy-windows-root-registration/v1`; no root/generation/runtime/entry comes from CLI, CWD, environment, app-adjacent folders, portable/QA roots, system Node/pnpm/PATH, repository checkout, user Pi/Magic Context or browser input.
- Desktop reads the selected pointer once and freezes an `InstalledGenerationSelection` containing the pointer’s generation/inventory digest, raw sidecar bytes and its verified hash, and the fixed runtime/bootstrap facts. Host bootstrap and Guardian admission consume that same frozen selection; neither re-reads a changed pointer or chooses another generation during the admission. Desktop verifies the sidecar raw-byte hash and the named fixed runtime/bootstrap handles/files only. It never reconstructs inventory/closure or a Node supply chain. No PATH, system runtime, or old-generation fallback exists.
- Desktop opens both admitted runtime executable and fixed Host entry before hashing, each with non-write/non-delete sharing, validates each bytes/path/file identity through its own same handle, and retains runtime through direct native `CreateProcessW`. It retains entry through authenticated bootstrap completion. Desktop verifies the created Host process image against the admitted runtime identity. A runtime/entry replacement, reparse/current-pointer mutation, bootstrap timeout or identity failure closes handles/stdio, terminates no fallback child and fails closed.
- Desktop creates a unique one-shot parent-writer/Host-reader bootstrap pipe for only the admitted Host child. `bInheritHandles=true` is allowed only with `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` containing that one reader; all other Desktop handles are non-inheritable/not listed. Bootstrap endpoint/token never enter command line or environment. Desktop writes exactly one bounded private frame to the inherited stdin writer, then both ends close; Host must not pass inherited bootstrap handles to descendants.
- An anonymous one-way stdin pipe has no client-PID query. Child authentication therefore binds the same `CreateProcessW` process handle/PID—not a pipe peer—to exact current-user token/SID and admitted runtime image identity **before Desktop writes** the bootstrap frame. Only that exact child inherited the reader handle. Duplicate/wrong-user/wrong-generation/PID/image/identity mismatch, malformed/timeout or Host exit fails closed and no root capability is minted.
- Host bootstrap consumer is internal-only. Ordinary Node/Host/browser entrypoints cannot construct it, receive root strings, receive bootstrap credentials or bypass capability validation. It receives the private frame only through the admitted Host child bootstrap reader, acknowledges only the frozen `InstalledGenerationSelection` after root revalidation, and returns an opaque `desktop_root_layout/v1` capability.
- Before any mutable owner or runtime constructor opens, Host fresh-revalidates each root against the received layout: current-user GameBuddy ownership, all registered boundary ancestors non-reparse, not under immutable program generation, exact expected partition, no foreign/unmanaged substitution and pairwise non-overlap. Failure opens no owner and starts no Guardian session.
- Tests use disposable runtime/Host fixtures only. They do not start Guardian sessions, relay Guardian commands, open product owner stores, select installations, invoke providers, browsers or live Stardew/SMAPI.

## Implemented private bootstrap wire for this task

The exact one-shot wire used by this predecessor is fixed here so Desktop and Host do not invent separate contracts. It is an internal implementation contract, not a public Host/browser API:

```ts
// One UTF-8 JSON document followed by exactly one LF on inherited stdin.
type DesktopHostBootstrapFrameV1 = Readonly<{
  schema: "gamebuddy-desktop-host-bootstrap/v1";
  protocolVersion: 1;
  bootstrapId: string;                 // lowercase hex, exactly 64 characters
  generation: string;                  // exact selected generation
  inventoryDigest: string;             // lowercase SHA-256
  runtimeAdmissionSha256: string;      // lowercase SHA-256 of raw sidecar bytes
  rootLayout: Readonly<{
    schema: "gamebuddy-windows-root-layout/v1";
    programRoot: string;
    dataRoot: string;
    operationalRoot: string;
    presentationRoot: string;
  }>;
}>;

// One bounded UTF-8 JSON document followed by exactly one LF on child stdout.
type DesktopHostBootstrapAckV1 = Readonly<{
  schema: "gamebuddy-desktop-host-bootstrap/v1";
  protocolVersion: 1;
  status: "accepted";
  bootstrapId: string;
  generation: string;
  inventoryDigest: string;
  runtimeAdmissionSha256: string;
  rootLayoutSchema: "gamebuddy-windows-root-layout/v1";
}>;
```

The maximum encoded frame and acknowledgement size is 32,768 bytes. Both documents require exact keys, reject duplicate/unknown keys, reject a BOM, reject embedded CR/LF/NUL, and use bounded lowercase hexadecimal identities. Desktop writes the frame only after authenticating the exact `CreateProcessW` child process handle/PID, runtime image identity, and current-user token/SID. The Host emits the acknowledgement only after reconstructing the expected current-user layout from its fixed `LOCALAPPDATA` identity and freshly verifying every registered boundary through the published Windows reparse inspector. The acknowledgement contains no root string, token, pipe, PID, handle, credential, or public URL. The inherited child handles are exactly the stdin reader and stdout writer; both are closed after the one-shot exchange, and no handle is passed to descendants.

## File and responsibility map

| File | Responsibility |
|---|---|
| `host/scripts/production-artifact.mjs` | Emits only Host-owned `host-runtime-admission/v1` after canonical selected-generation runtime/entry/closure verification. |
| `host/scripts/production-artifact.test.mjs` | Contract wire, atomic emission and malformed/foreign generation rejection. |
| `desktop/GameBuddy.Desktop/InstalledHostRuntimeAdmission.cs` | Fixed contract consumer; runtime image handle/digest/identity admission, no inventory reconstruction. |
| `desktop/GameBuddy.Desktop/RuntimeSupervisor.cs` | Native Host child creation and exact-child bootstrap authentication; no Guardian transport yet. |
| `desktop/GameBuddy.Desktop/WindowsNative.cs` | Narrow handle-list, pipe, process identity/PID primitives. |
| `desktop/GameBuddy.Desktop.Tests/*` | Disposable source-bound runtime/Host fixture, create-window race, bootstrap PID/image/EOF/credential tests. |
| `host/src/desktop-host-entry.internal.ts` | The only emitted Desktop Host entry; owns bootstrap admission/ack/lifetime sequencing, without public product or Guardian composition. |
| `host/src/desktop-runtime-bootstrap.internal.ts` | Artifact-internal frame consumer and fresh root-layout revalidation/capability mint; not an executable entry. |
| `host/src/*` later exact runtime-root consumers/tests | Require opaque root-layout capability before mutable owner/runtime construction; no public root strings. |

## Task 1: Freeze source-bound Host runtime admission

- [x] Write failing Host publisher and Desktop tests for a fixed inventory-excluded `host-runtime-admission/v1`: exact contract keys; destructive four-field `current.json`; pointer inventory digest/generation and raw-sidecar-byte hash binding; frozen shared `InstalledGenerationSelection`; fixed bundled runtime/Host entry paths; digests/closure facts; runtime **and entry** replacement/reparse/current-pointer races; foreign self-consistent contract rejection; contract publication ordering/no self-digest cycle; and no second verifier.
- [x] Emit the contract only from the existing Host publisher after canonical runtime/entry/closure verification: write/recheck the sidecar, hash its raw canonical bytes, then atomically replace the four-field current pointer. Desktop consumes only exact fixed contract fields; it does not enumerate/reconstruct generic inventory/closure or runtime supply chain.
- [x] Implement Desktop runtime/entry admission from one frozen `InstalledGenerationSelection`: verify the sidecar raw-byte hash, lock the exact runtime image and fixed Host entry before hashing, validate each through its same handle; retain runtime through native `CreateProcessW` and entry through authenticated bootstrap completion. Verify created Host process image identity. No Node/PATH/shell/system runtime or old-generation fallback.
- [x] Build source-bound disposable Host runtime fixture through the canonical Host publisher; run Host contract and Desktop admission tests with no skip.

## Task 2: Implement exact Host child bootstrap and fresh root-layout validation

- [x] Write failing tests for one-shot bootstrap stdin frame: Desktop validates the same `CreateProcessW` Host process handle/PID, current-user token/SID and admitted runtime image **before writing**; duplicate/wrong generation/wrong PID/image/timeout/Host exit rejection; entry lock remains through bootstrap completion; no token in command line/environment/log/files; and no non-bootstrap inherited handles.
- [x] Implement native parent-writer/Host-reader bootstrap pipe with explicit handle list and `STARTF_USESTDHANDLES`. Launch only admitted Host runtime/entry; authenticate exact created child process handle/PID/image/current-user token before writing root layout; close bootstrap handles and entry lock on success/failure/child exit.
- [x] Replace the fixed artifact entry with `desktop-host-entry.internal.js` and move the existing frame consumer behind it. The formal entry alone owns `import.meta.main`, invokes private bootstrap admission, emits the existing acknowledgement only after successful root validation/capability mint, and remains the admitted Host lifetime. Remove the old fixed entry identity without an alias.
- [x] Implement the artifact-internal Host bootstrap consumer and opaque `desktop_root_layout/v1` capability. Its private frame/ack is bound to the frozen selection; before acknowledgment or any mutable owner/runtime construction, freshly revalidate registered boundary ancestry/reparse, current-user ownership, program-root separation and partition non-overlap. Do not create a placeholder mutable owner in this task. Ordinary Host/browser entries cannot reach this capability or root strings.
- [x] Test mutated registration/layout after Desktop derivation but before Host first validation, reparse ancestor, overlap, foreign path, unmanaged sentinel and child credential/handle leakage: all fail before owner open or Guardian session.

## Task 3: Source-bound matrix and independent review

- [x] Run canonical Host artifact tests, source-bound Desktop runtime admission/bootstrap tests, focused Host bootstrap/root-capability tests, .NET build and `git diff --check`.
- [x] Fresh native/security review: locked runtime identity, handle inheritance, exact-child PID/image binding, bootstrap credential lifecycle and no runtime fallback.
- [x] Fresh Host architecture review: sole publisher contract, internal-only root capability, fresh first-write revalidation, no mutable owner/session before validation, no browser/public root/credential surface.

## Stop conditions

Stop and revise rather than add a fallback if:
- exact bundled runtime/Host entry cannot be admitted from one Host-owned generation contract;
- Desktop cannot bind the same `CreateProcessW` Host process handle/PID, image and current-user token/SID to the exact created Host child before bootstrap write;
- bootstrap endpoint/token/root facts must enter child command line, ambient environment, browser, public Host entry, durable storage, logs or descendants;
- Host cannot fresh-revalidate root ownership/layout before first mutable owner opens;
- implementation needs a second runtime inventory/verifier, system runtime, Node/PATH/shell spawn, arbitrary root/runtime path or generic bootstrap channel;
- implementation starts Guardian command relay or changes Task 3 role process ownership.

## Explicit residual follow-up

Guardian admission must consume the shared frozen `InstalledGenerationSelection`, but Guardian-specific sidecar pointer-binding proof remains a separate residual follow-up. This task does not claim that Guardian binding is already fixed, and its completion evidence must name that remaining work.

## Evidence

Source-complete at HEAD; the blocker (missing bundled runtime/entry in the Host artifact) is resolved by the publisher's `host-runtime-admission/v1` contract.

Verified locally (Windows, 2026-09-26):

- Host publisher contract suite `host/scripts/production-artifact.test.mjs`: 62 pass / 1 platform skip (`symlink unavailable: EPERM`, by design) / 0 fail.
- Desktop `dotnet test -c Release`: **172/172**, no skip. Includes `InstalledHostRuntimeAdmissionTests` 10/10 (runtime **and** bootstrap-entry replacement/delete/directory-move rejected by the share-mode lock, then admitted bytes re-read) and the ambient `GAMEBUDDY_ROOT` sentinel case.
- The formal entry tests run self-contained 5/5, including "no public exports", "ordinary import does not consume stdin or start", "malformed wire mints no acknowledgement", "Windows-only root refused until a private Guardian session is available" and "root validation precedes mint and acknowledgement".
- The `desktop-runtime-bootstrap` wire tests run **15/15** once the two drifted fixtures are repaired (see Residuals 3–4).
- `git diff --check` clean.

### Independent reviews

1. **Native/security review** (fresh, read-only): PASS on all three questions — (a) the runtime image cannot be substituted between hash and `CreateProcessW` because the admitted handle holds a share-mode lock (`FileReadData|FileExecute` with `FileShareRead` only, so `FILE_SHARE_WRITE`/`FILE_SHARE_DELETE` are both unset and the kernel rejects move/delete/replacement rather than a second hash re-check catching it), and `VerifyStillLocked` revalidates handle validity, volume serial, file index, reparse flag and final path before the launch; (b) there is no path that bypasses admission, and the only non-test `Process.Start` is the voice gateway on an already-admitted absolute path with no `PATH` in the child environment; (c) the bootstrap credential is a 256-bit CSPRNG value delivered over an anonymous one-way stdin pipe, never in command line/environment/log/file, accepted exactly once, with every failure path closing handles in `finally`.
2. **Host architecture review** (fresh, read-only): PASS on (a) the `desktop_root_layout/v1` capability cannot be minted externally — `mint`/`consume` are non-exported module-private functions over a module-private `WeakSet`, the only export is the bootstrap runner, `consume` deletes the capability so a second use throws, and the retained capability is never read as a path downstream; and (b) the `host-runtime-admission/v1` sidecar has a single authoritative producer with no second verifier and no self-digest cycle (the sidecar is excluded from the inventory). CONCERN raised on the game layer, handled below.

### Findings accepted from the reviews and resolved

1. The two fresh reviews above were required by this task and are now on record. Their residual notes (runtime `closure.files` shape-only, the Desktop→Guardian arm/recovery channel being a named pipe, and the `guardian-admission.json` pointer-binding gap) are recorded below rather than silently dropped; none is a supported-path defect.
2. The Host architecture review found that `host/src/games/stardew/lifecycle/stardew-bootstrap-guardian.private.ts` still **declared a game-layer type returning `Uint8Array`** and, worse, **built an arm frame in the game layer** with `Buffer.from(JSON.stringify(...), "utf8")`. That is exactly the Shape B prohibition (ADR-0007: the game-facing contract never exposes `Uint8Array` or any platform-frame representation), and the import-graph seam checker could not see it because the file contains no import that trips the rule. The seam was retired — production has zero callers — so it was deleted (`3e6d1fe`) together with its three dead tests, and the platform encoding stays in `composition/stardew/stardew-guardian-platform.ts`.

### Residuals (explicitly not closed here)

1. **Guardian admission sidecar pointer binding** remains a separate follow-up: Guardian and runtime already share the same frozen `InstalledGenerationSelection`, but the raw-byte binding between `guardian-admission.json` and `current.json` is proven only through `inventoryDigest`. Unchanged from the original residual note.
2. **`runtimeClosure.files` is shape-validated only** (`InstalledHostRuntimeAdmission.cs`): if the bundled runtime ever loads auxiliary files from `runtime/` (hostfxr/coreclr style), their integrity is outside the admission gate. Not reachable in the current bundled-Node shape, so this is a note, not a blocker.
3. **Desktop→Guardian private arm/recovery channel is a named pipe with Desktop as client that does not authenticate the server.** A same-user process could pre-empt the name; the 256-bit token reaches only the real Guardian's descendants through the environment. Not demonstrated exploitable and out of scope here.
4. The Host bootstrap **wire tests only execute once their fixtures are repaired**: `host/src/bootstrap/wire/desktop-runtime-bootstrap.internal.test.ts` referenced `games/stardew/lifecycle/contained-game-runtime-platform.private.*`, which moved to `composition/stardew/stardew-guardian-platform.ts`, and the test fixture lacked a stub for the `voice-bootstrap` module added by the voice lane. Both are fixed (`4f6d33e`, `1993abc`) and the suite is 15/15.

## Acceptance

This predecessor closes only when source-bound Host publisher/Desktop/Host fixture tests prove exact admitted runtime identity, exact authenticated Host child bootstrap, private root-layout handoff, Host fresh first-write root validation, zero bootstrap/root credential leakage, no fallback runtime/root path, and two independent reviews. It then activates the blocked Desktop↔Host Guardian broker task; it does not close the broker, Task 3, Task 4, installation registration, topology, presentation or live Stardew.
