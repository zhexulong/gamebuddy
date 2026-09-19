# Community Game Connector Architecture

**Status:** Accepted architectural direction; no community connector runtime is authorized by this document alone.

**Owner:** GameBuddy Host Core owns connector supervision, the versioned connector protocol, installation policy, and the shared player-facing Game surface. Each game project owns its game-specific connector implementation, native bridge/Mod, action semantics, attachment/provisioning, and verification.

**Primary references:** `AGENTS.md`, `design/00_CORE_PRODUCT.md`, `design/91_OPEN_GAMEPLAY_PIPELINE_RELEASE_IMPLEMENTATION_PLAN.md`, `design/95_CROSS_GAME_ACTION_DEVELOPMENT_PLATFORM_IMPLEMENTATION_PLAN.md`, `design/research/community-game-connector-architecture-2026.md`.

## 1. Decision

GameBuddy will support a future community ecosystem through **out-of-process Game Connectors**, not by dynamically importing third-party JavaScript, DLLs, or npm packages into the Host process.

A connector is a game-specific executable plus a strict manifest and a versioned local IPC protocol. The Host starts and supervises it for one bounded integration session. The Host remains the only owner of Companion identity, browser sessions, Pi runtime, Memory, product credentials, lifecycle projection, action admission, and product-facing receipts. A connector may request a typed operation or report a typed source fact only within its own authenticated session and declared integration namespace; it never receives a generic Host object, arbitrary tool execution, browser route, Memory/transcript access, or another connector's state.

Stardew remains the first canonical connector implementation, but its private SMAPI package, `--mods-path`, two-role process topology, bridge, role/generation attestation, provisioning, and target-version mechanics remain Stardew-private. They are not elevated into a universal launcher manifest or cross-game configuration language.

## 2. Why this is the chosen seam

The product needs two different seams, which must not be conflated:

| Seam | Consumer | What it standardizes | What it deliberately does not standardize |
|---|---|---|---|
| `GameIntegrationAdapter` / `IntegrationLauncher` | Trusted first-party Host runtime | authoritative observation, typed action projection, receipt correlation, cancellation, connection closure | game installation, process topology, native Mod/bridge protocol, profile format, attachment UX |
| `ConnectorSessionAdapter` | Trusted, statically compiled Host Core module | validates one installed connector's fixed descriptor, projects its bounded tools, performs generic policy/scope/deadline/correlation admission, and transports typed request/receipt/observation envelopes | game mechanics, native preconditions, action-specific postconditions, game installation, process topology, native Mod/bridge protocol, profile format, attachment UX |
| Game Connector Protocol | a game-specific external connector process | lifecycle handshake, redacted prerequisite/status projection, declared action request envelope, cancellation, receipt query, close | dynamic tool publication, arbitrary game launch flags, save/world schema, native calls, UI code, Host authority |

The existing adapter seam remains the trusted, in-process seam for first-party integrations. `ConnectorSessionAdapter` is a different trusted, generic Host module: it implements only the fixed connector ABI and does not contain game-specific code or a gameplay interpreter. The connector protocol is a separately versioned **external ABI**. A community connector does not implement either Host module, cannot gain Host authority by claiming a TypeScript shape, and cannot replace them at runtime.

This split keeps the Host deep: generic callers ask a small product interface for lifecycle state and typed integration work. They do not learn the installation path, executable, connector entrypoint, Mod layout, pipe, token, native identity, role topology, or action-dispatch choreography for any game.

## 3. Trust model and honest limits

### 3.1 First-party and community code

| Connector origin | Execution location | Product treatment |
|---|---|---|
| First-party | May use trusted compiled Host adapters and game-specific first-party processes | eligible for the normal shipped launch/attach path after game-specific evidence closes |
| Community external | Separate Host-supervised child process | explicit community-source and requested-access disclosure; no in-process Host code, no automatic promotion to a supported/verified integration |
| Developer local | Same external process contract, enabled only through a developer setting | not a normal release claim and not eligible for automatic player-facing recommendation |

A community connector process is **not an OS security sandbox** merely because it is a child process. On current Windows installations it normally has the user's OS identity and may have whatever filesystem/network access that identity grants. The initial boundary protects Host architecture and fault containment: the connector receives no direct Host object, no in-process access to Host memory, and no protocol right to create product facts. It does not honestly claim to protect a user who installs hostile native code from that native code.

The install screen must state this limitation plainly. Users choose whether they trust a community connector author just as they choose whether to run other local executables. A future sandboxed tier may strengthen this only after a dedicated runtime and Windows containment evidence exist.

### 3.2 Capability mediation

The Host grants a connector only the intersection of:

```text
manifest-declared capability class
∩ user-approved capability class
∩ current Host policy
∩ exact active integration session
```

The grant is not an action permission. For a game mutation the Host still applies current Companion/player/scope policy, and the game-native owner must repeat its own admission checks before side effect. A connector's `succeeded` message is not a product completion fact; Host accepts an outcome only through the integration's source-owned receipt and fresh postcondition path.

The initial connector does not receive Host provider credentials, Pi sessions, raw Chat transcripts, Memory records, browser cookie/CSRF material, GameBuddy runtime-root authority, other connector sessions, unrestricted filesystem handles, unrestricted network handles, shell access, or generic arbitrary action dispatch.

## 4. Initial package and protocol

### 4.1 Package layout

The first community installation format is a user-selected directory under the GameBuddy-owned connector root:

```text
connectors/<integration-id>/
  manifest.json
  connector.exe                # Windows first; one fixed manifest-relative entry
  docs/README.md
```

`manifest.json` is a schema-validated declaration, not executable policy. It contains exactly one fixed connector identity, capability request, and finite action descriptor list:

```json
{
  "integrationId": "example_game",
  "displayName": "Example Game",
  "version": "1.0.0",
  "protocolVersion": 1,
  "entry": "connector.exe",
  "requestedCapabilities": ["observation.read", "action.request"],
  "actions": [
    {
      "id": "weather.read",
      "displayName": "Read weather",
      "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
    }
  ],
  "documentation": "docs/README.md"
}
```

The `actions` list is metadata interpreted only by the generic `ConnectorSessionAdapter`: each identifier is opaque and unique within its `integrationId`; each `inputSchema` is a deliberately small, published JSON-Schema subset; and the list is finite at installation time. It gives the Host enough information to create bounded typed Agent tools without importing community code. It does **not** describe mechanics, preconditions, postconditions, save/world fields, native calls, completion predicates, routes, UI, or a workflow language.

Rules:

- `integrationId` equals the immediate package directory name and is unique among enabled connectors.
- `version` is semantic version text and `protocolVersion` is the connector ABI breaking-change number.
- `entry` and `documentation` are normalized, package-relative paths; no absolute path, parent traversal, shell command, URL, dependency installation directive, script hook, arbitrary environment mapping, or dynamic module list is accepted.
- An installed connector can never add, remove, or alter an action descriptor through IPC. Any manifest change is a stopped, user-initiated package update followed by a new validation and explicit capability review.
- The Host owns package discovery. It does not scan arbitrary directories, install npm dependencies, run installers, download code, execute manifest scripts, or accept a browser-supplied entrypoint.
- Initial installation is manual directory placement/selection with a visible community-code warning. Update is user-initiated stop → replace package directory atomically → rescan. There is no marketplace, remote install, auto-update, custom signature system, or silent protocol migration.

A manifest parse/shape failure leaves that connector disabled with one redacted diagnostic code. It never partially loads or falls back to a guessed entrypoint.

### 4.2 Connector Protocol v1

The Host creates stdin/stdout for the connector child and owns the session. Frames are canonical UTF-8 JSON objects, one object per newline, with a strict maximum frame size. Neither side accepts additional fields, duplicate keys, non-object frames, or traffic before handshake completion.

The protocol has a small fixed vocabulary:

```text
connector.hello
host.grant
lifecycle.read
observation.read
action.request
action.cancel
receipt.query
session.close
ping
```

Every request and event is correlated to one Host-minted connector session and one exact integration identity. `connector.hello` declares the package's protocol version and requested capability classes. `host.grant` either returns the intersected grant and a session-scoped opaque token delivered only through child-process environment, or rejects and closes. Protocol version mismatch, undeclared method, ungranted capability, malformed frame, session mismatch, and deadline expiry fail closed; no compatibility fallback or auto-negotiated downgrade exists.

The connector can answer one fixed manifest-declared operation after `ConnectorSessionAdapter` validates the exact action identifier and payload schema, applies generic current policy/scope/deadline/correlation admission, and forwards a bounded `action.request` envelope. The connector cannot add or mutate an action catalog over IPC, create a Host tool outside that fixed list, choose a Companion, invent a world/save scope, issue an unrestricted process launch, write a browser response, or mark a task complete. Game-specific request/response payloads remain opaque data to the Host beyond the published descriptor schema; Host Core never interprets their gameplay semantics.

A terminal receipt or observation received from a community connector is `community_reported`, not `authoritatively_completed`. The generic module can correlate request → terminal connector receipt → fresh connector observation and report that lineage honestly, but it cannot evaluate an action-specific gameplay postcondition it does not own. A connector may state that its native game bridge revalidates mutations; that is a game-specific claim, not a Host substitute. A future first-party reviewed adapter binding may consume this connector's protocol and add game-specific postcondition semantics, but is optional and must be a separate game-specific implementation/review decision.

### 4.3 Lifecycle and recovery

```text
installed_disabled
→ package_validated
→ spawn_pending
→ handshaking
→ active
→ closing
→ closed | failed
```

The Host owns the only spawn and shutdown transitions. It records a redacted lifecycle projection, detects child failure, performs bounded graceful close, and uses exact child-handle identity revalidation before termination where the platform supports it. A closed or failed session is not reconnectable by the connector; a player-requested reconnect creates a new Host-minted session and performs a new handshake. Crash restart policy is deliberately deferred until a real connector needs it; the initial behavior is fail closed and wait for explicit player retry.

No connector protocol timeout becomes a gameplay quota. A connector request with a real game execution deadline follows the existing receipt/uncertain-recovery semantics; liveness timeouts merely close the external connector session and report an honest lifecycle failure.

## 5. Browser and player experience

The shared Game drawer renders Host-owned, redacted state. A connector can supply only typed prerequisite/status code, localized message key, and bounded remediation category. It cannot supply React, HTML, CSS, JavaScript, browser routes, arbitrary forms, or diagnostic logs.

The shared shell owns user confirmation, connector source disclosure, install/update/removal confirmation, launch/attach/stop/reconnect commands, errors, and accessibility. A game connector may describe game-specific prerequisites or bounded candidate choices through a future declarative schema. The schema must be designed only when two real games demonstrate a shared need; it must not be inferred from Stardew's SMAPI or Farmhand flow.

## 6. Staged delivery

### Stage 0 — current Stardew tracer

Finish one first-party Stardew path using the existing `IntegrationLauncher`, `GameIntegrationAdapter`, native Mod bridge, and two-role topology. Keep all Stardew asset admission, profile staging, process launch, and attestation internal to the Stardew implementation. Do not expose a generic package/install/launch manifest as a substitute for that path.

**Exit evidence:** the shipped UI launches or attaches the Stardew topology; the authenticated bridge provides source-owned observation/action/receipt facts; STOP/reconnect/teardown close honestly.

### Stage 1 — external connector host and SDK

After the first-party Stardew path is real, introduce the package manifest, strict stdio protocol, Host supervisor, declarative capability grant, redacted lifecycle projection, and one **developer-local fixture connector**. The fixture proves process/session framing and failure behavior only; it cannot access a real game, publish actions, or claim live support.

**Exit evidence:** malformed manifests/frames and action descriptors fail closed; an ungranted or undeclared action is rejected; connector crash/close cannot affect the Host session; user-visible state is redacted; and the fixture proves descriptor → generic tool projection → bounded request → correlated `community_reported` terminal receipt/observation → close without importing Host internals.

### Stage 2 — first community connector

Admit one community connector only after its game-specific action/attachment evidence exists and the connector protocol supports all facts it actually needs. It remains community-labelled and follows the external-process disclosure.

**Exit evidence:** one real connector reaches a normal integration lifecycle and invokes one manifest-declared typed action without a special Host bypass; a focused conformance suite proves descriptor admission, handshake, tool projection, policy denial, cancellation, receipt recovery, close, and the `community_reported` rather than first-party-completion projection. Any stronger action-specific completion claim needs a separately reviewed first-party game adapter binding.

### Stage 3 — sandbox research, not a promise

Evaluate a dedicated WASI/component runtime or platform-native containment only through a separate Windows-focused spike. `node:wasi` is not an acceptable sandbox. No WASM support is published until the selected runtime can demonstrate that its granted filesystem/network/process capabilities are actually enforceable on supported platforms.

## 7. Non-goals

- No arbitrary in-process community JavaScript/DLL/plugin loading.
- No plugin marketplace, remote package registry, auto-update service, custom signing/key system, reputation score, or automatic safety review.
- No universal game launcher/profile/config DSL.
- No generic gameplay ontology, generic action interpreter, or universal game-specific UI bundle.
- No promise that Stage 0 Stardew mechanics are portable to another game.
- No weakening of current first-party native Mod authority or game-thread revalidation.

## 8. Relationship to existing documents

- `design/00_CORE_PRODUCT.md` owns product vocabulary and the shared App Shell / game-specific attachment-flow principle.
- `design/91_OPEN_GAMEPLAY_PIPELINE_RELEASE_IMPLEMENTATION_PLAN.md` owns the current Stardew release path. Its Task 5 is a Stage 0 first-party implementation and does not wait for Stage 1.
- `design/95_CROSS_GAME_ACTION_DEVELOPMENT_PLATFORM_IMPLEMENTATION_PLAN.md` owns action-development devkit/project extraction, not connector loading. It records the later runtime seam extraction but must not build a connector marketplace or confuse descriptor-based `ConnectorSessionAdapter` transport with a generic gameplay implementation.
- This document owns the community connector boundary and staged roadmap. Any implementation task must first be added here with a bounded slice card, a concrete failure model, and a producer → consumer → verifier assertion.

## 9. Source basis

The direction is grounded in the research report at `design/research/community-game-connector-architecture-2026.md`: VS Code's separate extension host process, OBS WebSocket's versioned server-authoritative protocol, Home Assistant's in-process custom integration trade-off, and WASI's no-ambient-authority model plus Node's explicit warning that `node:wasi` is not a secure sandbox. The report is evidence for the direction, not a runtime dependency or an authorization to copy any project code.
