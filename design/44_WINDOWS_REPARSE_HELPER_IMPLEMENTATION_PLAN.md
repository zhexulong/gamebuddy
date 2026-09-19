# Windows Reparse Inspection Helper — Implementation Plan

**Status:** frozen prerequisite slice for the Chat artifact boundary. It implements the unresolved requirement in `design/42_WINDOWS_REPARSE_ENFORCEMENT_DECISION.md`; it is not a Chat runtime, browser session, or release claim.

## Decision

Use a **repository-owned, version-locked, self-contained .NET 8 Windows executable** with a strict one-request JSON protocol. It invokes `FindFirstFileW` and reads `WIN32_FIND_DATAW.dwFileAttributes`; no shell, PowerShell, PATH discovery, temporary scripts, operator-configured executable, or Stardew project is permitted.

The helper is an executable rather than a Node FFI/DLL bridge because the repository has .NET 8 SDK available, has no approved Node Win32 FFI dependency, and the executable protocol makes the native boundary observable, bounded, and callable by both ESM consumers.

## User-visible result

A Windows artifact verifier/generator accepts an artifact entry only after a shared policy proves the exact entry is **not** marked `FILE_ATTRIBUTE_REPARSE_POINT`; missing helper, malformed protocol, failed native inspection, timeout, unexpected stderr, or an indeterminate result fails closed with a safe, path-free category.

## Scope and explicit non-goals

In scope:

- a new independent native project under `host/native/windows-reparse-inspector/`;
- a self-contained, version-locked `win-x64` helper publication workflow owned by Host artifact engineering;
- a strict JSON stdin/stdout protocol and Node policy adapter;
- use by both `dialogue-web/scripts/browser-artifact-manifest.mjs` and `host/src/tavern/static-artifact/index.ts` before every root/manifest/directory/entry HTML/listed asset traversal/open;
- real Windows tests for junction and directory symlink, plus an available non-link reparse variant or an explicit blocked evidence result;
- fail-closed prerequisite/release evidence transition only after the binary identity, protocol, and probes are verified.

Not in scope:

- HTTP mounting, browser bootstrap, `/api/tavern/v1`, Chat runtime, provider, Context, or Tavern management;
- a promise of hostile same-user pathname TOCTOU resistance. Native inspection is required before each open/traversal but is not a handle-relative no-follow proof;
- reusing or modifying any Stardew/game/tool probe project;
- arbitrary platforms: non-Windows remains `not_applicable`, with existing Node checks still defense in depth.

## Authority and topology

```text
versioned source + pinned .NET SDK
  → Host-owned self-contained helper publication + canonical SHA-256
  → shared artifact policy adapter validates exact helper identity
  → one bounded absolute-executable child request per inspected path
  → strict result parse / safe category mapping
  → browser manifest generator and Host static verifier
  → Host outer publisher / later static HTTP server
```

The helper has two fixed build-owned locations:

```text
host/native/windows-reparse-inspector/.dist/win-x64/
  GameBuddy.WindowsReparseInspector.exe
  windows-reparse-inspector.manifest.json

# copied only by the Host outer builder into the published generation
native/windows-reparse-inspector/win-x64/
  GameBuddy.WindowsReparseInspector.exe
  windows-reparse-inspector.manifest.json
```

The private `.dist` location is derived from repository source location, not PATH, environment, CLI input, or cwd. Before the Vite artifact generator calls it, the generator's shared policy validates the fixed manifest's exact schema/version/RID and SHA-256 of the exact regular binary. The Host outer builder creates it before invoking Vite, then revalidates and copies it into the fixed artifact-internal location. A later production static-server composer mints its capability from that artifact-internal pair.

This replaces the earlier cross-process "injected opaque capability" idea: an in-memory capability cannot cross the Host→Vite process boundary. The **policy authority** remains Host-owned because only a repository-relative, fixed-name, hash-verified build product is acceptable; the browser cannot choose a helper path. Normal developer Vite builds on Windows fail closed if this exact build product is missing or invalid.

## Native protocol

Exactly one UTF-8 JSON request on stdin, followed by EOF:

```json
{"schemaVersion":1,"operation":"inspect","path":"C:\\absolute\\path"}
```

Exactly one UTF-8 JSON response on stdout, newline-terminated, no stderr:

```json
{"schemaVersion":1,"result":"regular"}
```

Permitted results:

```text
regular | reparse | missing | indeterminate
```

No optional keys, path echo, Win32 error text, stack trace, diagnostic, second line, BOM, invalid UTF-8, or nonzero exit is accepted. The native process maps `FindFirstFileW` results to only these categories. It uses the exact absolute path in extended-length `\\?\` form (including UNC conversion where relevant), tests:

```text
(dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0
```

and closes the search handle with `FindClose`. `reparse`, `missing`, and `indeterminate` are all rejection by the JS policy. Any unavailable binary, hash mismatch, protocol mismatch, child timeout, output overflow, stderr, malformed output, nonzero exit, or unexpected result is `windows_reparse_inspection_unavailable` to callers; callers never receive a user path.

## Shared adapter contract

The adapter has two construction modes, both fixed and non-configurable:

- `createBuildWindowsReparseInspector()` derives and verifies the repository-relative private build pair above; it is used by browser generation and Host build composition.
- `createPublishedWindowsReparseInspector(hostArtifactRoot)` derives and verifies the fixed artifact-internal pair above; a later production static-server composer uses it.

Both return an opaque `WindowsReparseInspectorCapability` only after validating exact platform `win32` / architecture `x64`, fixed filename/RID, regular non-link binary and manifest, canonical SHA-256, frozen protocol version, and the fixed bounded child-launch policy. The capability is not serializable and does not reveal the executable path to callers.

It exposes only:

```ts
assertNoWindowsReparse(capability, absolutePath): Promise<void>
```

On non-Windows, construction returns a `not_applicable` implementation; Node containment checks remain required. On Windows, a missing/invalid build pair or absent capability is rejection, never a fallback to Node-only behavior.

## Required call locations

Both consumers invoke the same policy:

1. browser artifact root before `readdir` / `realpath`;
2. every discovered directory before entry;
3. manifest before read;
4. `index.html` before read;
5. every manifest-listed asset before read;
6. Host copied subtree root and equivalent entries before verification/serve.

The outer artifact builder uses the same policy while copying and does not publish the native binary as an executable browser resource.

## Implementation lanes

### Lane A — helper and deterministic build

Own:

```text
host/native/windows-reparse-inspector/**
host/scripts/build-windows-reparse-inspector.mjs
host/scripts/build-windows-reparse-inspector.test.mjs
```

Deliver a `net8.0` console project with pinned source/protocol identity and deterministic self-contained `win-x64` publish. The builder invokes a repository-resolved absolute `dotnet.exe`, with fixed args/cwd, minimal environment, timeout/output bounds, and no shell. It verifies the emitted executable hash against its generated build attestation; no checked-in binary is authority.

### Lane B — Host capability/policy

Own:

```text
host/src/windows-reparse-inspector/**
host/src/tavern/static-artifact/index.ts
host/src/tavern/static-artifact/index.test.ts
host/tsconfig.production.json
```

Implement opaque capability minting, exact helper child protocol, safe error mapping, and static verifier integration. Node link/realpath checks remain as defense in depth and comments must not claim generic reparse coverage without the capability.

### Lane C — browser generator adapter

Own:

```text
dialogue-web/scripts/browser-artifact-manifest.mjs
dialogue-web/scripts/browser-artifact-manifest.d.mts
dialogue-web/vite.config.ts
dialogue-web/tests/manifest-boundary.test.mjs
```

Remove the implication that Node checks are sufficient on Windows. Use `createBuildWindowsReparseInspector()` through a shared adapter/package that derives only the fixed repository-relative build pair and validates its manifest/hash; it must never reach for a helper via PATH/environment/CLI/cwd. Normal `pnpm build` fails closed on Windows if that build pair is absent or invalid.

### Lane D — Host outer artifact composition and evidence

Own:

```text
host/scripts/build-production-artifact.mjs
host/scripts/build-production-artifact.test.mjs
host/scripts/production-artifact.mjs
host/scripts/production-artifact.test.mjs
tools/check-tavern-release-prerequisites.mjs
tools/check-tavern-release-prerequisites.test.mjs
```

Materialize helper in private staging, mint capabilities, pass them through the browser and Host verifier boundaries, copy only verified browser content, and record binary/probe evidence. The existing prerequisite blocker can become passable only once all required Windows probes/evidence are present.

## Acceptance scenario

**Given** a fresh Host-owned private artifact staging root and the exact version-locked `win-x64` helper,

**when** the browser generator and Host verifier inspect a tree containing a junction, directory symbolic link, or available non-link reparse entry,

**then** each rejects before traversal/read/serve/publish with a safe path-free failure,

**and** a regular artifact succeeds with the same helper protocol and exact hash,

**and** helper absence/malformed output/version/hash/timeout/indeterminate all fail closed,

**and** a restart/reopen cannot replace native provenance with a node-only fallback.

Producer → consumer → verifier:

```text
native FindFirstFileW classification
→ strict protocol adapter / opaque capability
→ generator + Host static verifier rejection
→ builder publication refusal and prerequisite evidence
```

## Gates

Before a production/release claim:

1. static C# protocol tests, including UTF-8/Unicode/long path parsing and no path echo;
2. deterministic helper publish + hash verification;
3. Node adapter malformed/unavailable/timeout/nonzero/stderr/output-overflow tests;
4. actual Windows regular file, junction, directory symlink, and available non-link reparse probes;
5. both generator and Host verifier consume those probes;
6. outer builder failure preserves old generation;
7. prerequisite checker is green for this check only with recorded current binary/probe evidence.

If a non-link reparse fixture cannot be created on the target runner, the gate remains `blocked` with an explicit evidence reason—no skip-to-pass.

## Residual risk

This plan enforces the required metadata inspection and removes Node-only ambiguity. It does not assert an atomic handle-relative defense against a same-user process replacing a path after metadata inspection; that remains the documented P3 residual risk unless a future native no-follow/handle-relative design is approved.
