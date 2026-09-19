# Windows Distribution and Desktop Presentation Design

**Status:** Proposed and required for a Desktop Player Release. It is not required to describe or run the existing developer Browser Preview, but no installed-desktop, tray, WebView2, signing, update, or uninstall claim is permitted until this design's corresponding gates close.

**Owner:** The GameBuddy Windows product shell and distribution layer. It owns installation, one app instance, runtime supervision, presentation visibility, update activation, and uninstall policy. It does not own Chat, Game, provider, Memory, Pi, bridge, action, receipt, or Stardew lifecycle semantics.

**Primary references:** `AGENTS.md`; `design/00_CORE_PRODUCT.md`; `design/26_TAVERN_FRONTEND_DESIGN_SPEC.md`; `design/29_TAVERN_CHAT_LIFECYCLE_V1.md`; `design/30_CROSS_PROCESS_CONTINUITY_SURFACE_FOUNDATION.md`; `design/90_SIMPLIFIED_PI_BACKED_CHAT_PRODUCT_IMPLEMENTATION_PLAN.md`; `design/91_OPEN_GAMEPLAY_PIPELINE_RELEASE_IMPLEMENTATION_PLAN.md`; Designs 99–102; `host/scripts/production-artifact.mjs`; `host/scripts/start-production-artifact.mjs`; `host/src/dialogue-web-main.ts`; `host/src/companion-control-server.ts`; and Microsoft WebView2 distribution, navigation, and process-recovery documentation.

## 1. Release claims

GameBuddy has three deliberately different presentation/distribution claims. The names are release labels and must not be reused for another claim.

### 1.1 Browser Preview

The existing local-web composition may be delivered only to developers, QA, and bounded preview users as an explicitly named **Browser Preview**:

```text
verified Host/browser artifact
→ developer/QA runtime wrapper
→ Host-owned loopback bootstrap
→ default browser
```

A Browser Preview may prove ordinary Chat or Game browser journeys. It does not prove `GameBuddy.exe`, a desktop shell, system tray, installer, signing, automatic update, or store-ready product. Installed builds must never display the `Browser Preview` release label.

### 1.2 Desktop Browser Presentation

The first installed player presentation may use the system browser behind a signed desktop owner:

```text
signed per-user Setup.exe
→ signed GameBuddy.exe primary app instance and tray
→ bundled version-locked runtime
→ verified immutable Host/browser/native generation
→ fixed, non-secret loopback entry
→ system browser
```

This is named **Desktop Browser Presentation** in player copy and release evidence. It is a temporary presentation adapter for the Desktop Player Release, not `Browser Preview` and not WebView2. Its retirement condition is that the WebView2 adapter passes the same player journeys, presentation isolation, accessibility, crash/reopen, and update-generation gates without changing Host or domain contracts.

### 1.3 Desktop Player Release

A public Windows player release is:

```text
signed per-user Setup.exe
→ signed GameBuddy.exe primary app instance
→ bundled version-locked runtime
→ verified immutable Host/browser/native generation
→ Host-owned bootstrap and independent Chat/Game surfaces
→ tray-owned reopen/hide/quit presentation
→ Desktop Browser Presentation initially
→ WebView2 presentation later
```

A player never installs Node, pnpm, repository dependencies, Pi, or developer tools. `pnpm` remains a contributor workflow only. Portable layouts are developer/QA artifacts, not an alternative public-release claim; if public portable distribution is proposed later, it requires a separate signed-entry, roots, update, and support contract.

## 2. Ubiquitous language

| Term | Meaning |
| --- | --- |
| **Distribution authority** | Produces and verifies signed Setup/install layouts, signed product entry, immutable generations, and uninstall registration. It may produce a clearly non-public QA portable layout but cannot create Chat/Game authority. |
| **App-instance authority** | The current-user owner proving exactly one installed/portable GameBuddy app instance for one product partition. Secondary launches may request only `open` or `focus`. |
| **Runtime supervisor** | Starts the bundled runtime and exact verified Host generation, observes exit, and requests product shutdown/recovery. It never synthesizes domain success or retries effects. |
| **Presentation shell** | Owns window/tray visibility and navigation. Initially it opens the Desktop Browser Presentation; later it may host the same web artifact in WebView2. It is never a Host authority. |
| **Browser Preview** | A named developer/QA/bounded-preview lane using the system browser. It is never the label of an installed product and is not evidence for tray/WebView2/installer behavior. |
| **Desktop Browser Presentation** | The temporary system-browser adapter launched and supervised by signed `GameBuddy.exe`. It may prove installed desktop/tray behavior but is not a WebView2 claim. |
| **Desktop Player Release** | A signed, installable player product whose complete app-instance, runtime, presentation, root, shutdown, and update contracts are verified. |
| **Hide** | Remove the visible window while retaining the app and its independently owned surfaces. It is not STOP or quit. |
| **Presentation disconnect** | Browser/WebView connection disappears. It does not by itself stop Chat or Game. |
| **Quit app** | The shell asks each mounted surface owner to close, waits for their bounded terminal outcomes, closes Host/runtime ingress, then exits. It is not one global STOP. |

## 3. Authority graph

```text
Distribution authority
→ installed immutable generation + bundled runtime + product manifest
→ app-instance authority
→ runtime supervisor
→ verified Host entry
├─ independent Chat owner
├─ independent Game/Stardew coordinator
└─ Host-owned browser bootstrap/session/CSRF
→ presentation shell
   ├─ Desktop Browser Presentation
   └─ later WebView2 presentation
```

The shell never chooses continuity, Pi session, provider credentials, model tools, installation path, Stardew bridge facts, action scope, receipt truth, or lifecycle generation. It receives only fixed redacted app/surface readiness and one-time presentation handoff material from Host.

## 4. Installed layout and storage roots

### 4.1 Program generation

A per-user installation uses an immutable, versioned program layout under `%LOCALAPPDATA%\Programs\GameBuddy`. One active pointer selects an already verified generation. A generation includes:

- `GameBuddy.exe` launcher/shell;
- a version-locked private Node runtime;
- Host production artifact and declared external runtime closure;
- verified Dialogue Web artifact;
- verified native helpers and Stardew integration bundle;
- exact product/inventory metadata.

The launcher must not fall back to system Node, global pnpm, repository `node_modules`, a system Pi installation, arbitrary PATH lookup, or a previous unverified generation.

### 4.2 Canonical current-user roots

The launcher resolves and privately hands Host one versioned `gamebuddy-windows-root-layout/v1` before any mutable owner opens. Public Windows releases do not derive authority from the development fallback `~/.gamebuddy`, app-adjacent folders, current working directory, environment-selected arbitrary roots, or folders discovered from a user's Pi/Magic Context installation.

```text
%LOCALAPPDATA%\Programs\GameBuddy\       immutable installed generations
%LOCALAPPDATA%\GameBuddy\data\           durable GameBuddy product authority
%LOCALAPPDATA%\GameBuddy\operational\    logs, cache, crash categories, update staging
%LOCALAPPDATA%\GameBuddy\presentation\   browser/WebView2 profile and disposable UI cache
Windows current-user Credential Vault     provider credentials
```

The root-layout object contains only canonical registered product roots and its schema version. It is launcher-owned bootstrap input, not a browser DTO, operator option, environment-variable override, or generic filesystem capability. Host revalidates that each filesystem root is current-user GameBuddy-owned, non-reparse at the registered boundary, outside the immutable program generation, and non-overlapping with every other authority class before first write. This is ordinary path ownership validation against wrong-root deletion/adoption; it does not add hashes, signatures, or a second storage attestation chain.

There is one root-registration lifecycle. Setup registers the fixed per-user product-root constants in current-user Windows uninstall/product-registration metadata outside the deletable `data`, `operational`, and `presentation` roots. The launcher reads that registration, derives the v1 layout, and gives it privately to Host. Repair preserves it; reinstall reuses the same fixed roots after revalidation; explicit purge consumes it but does not invent a second registry; final uninstall removes the product-registration metadata only after the selected preserve/purge policy completes. The first release does not support arbitrary player-selected product roots.

### 4.3 Durable owner partitions

`data` is one GameBuddy-owned top-level root with separate owner namespaces; it is not one shared store:

```text
data\
├─ contexts\<opaque-continuity-key>\
│  ├─ pi-agent\                         embedded Pi configuration/runtime data
│  ├─ surface-sessions\<opaque-id>\    surface-local Pi session JSONL and run manifests
│  ├─ .cortexkit\magic-context.jsonc   Host-fixed Magic Context configuration
│  └─ data\                             Magic Context-owned semantic data via scoped XDG_DATA_HOME
├─ tavern\...                           Chat SQLite/thread/draft/turn authority
├─ settings\...                         non-secret model/provider preferences
└─ stardew-private-bootstrap\...        Game registration, attempt, and recovery authority
```

The layout above fixes ownership and isolation, not a browser-visible path contract. Owner-specific schemas remain defined by their domain modules and may evolve transactionally without another owner opening their files.

- Chat and Game always use different surface-session/Pi-session partitions. Neither reads the other's raw transcript, prompt, tool trace, world state, receipt, or run manifest.
- Only Magic Context-owned semantic Memory may be consumed across Chat and Game, and only when both surfaces are explicitly bound to the same manifest-derived continuity identity. Host does not copy raw Chat/Game history into the other surface or read/write Magic Context SQLite directly.
- Embedded Pi and Magic Context use only the bundled, Host-declared runtime/packages and the scoped roots above. User `%USERPROFILE%\.pi`, global Cortex/Magic Context data, system sessions, extensions, skills, prompts, credentials, and SQLite files are never discovery or fallback inputs.
- Settings may reference credential readiness but secrets live only in the Windows current-user Credential Vault. Secrets never enter `data`, `operational`, `presentation`, browser storage, Pi sessions, Magic Context, Game configuration, or product logs.
- `operational` and `presentation` are disposable and never become continuity, recovery, registration, receipt, or credential authority.

The only first-release player operation for these roots is shell-owned `clearTemporaryPresentationData`. It requires updater idle, seals presentation admission, closes the browser/WebView2 presentation owner, and asks Host to close current log/cache writers before revalidating the registered roots. It may delete only the dedicated presentation profile/cache plus declared disposable operational cache and rotated-log categories. It excludes active logs, crash reports retained by policy, update download/activation/rollback staging, and every durable namespace. Failure to close an affected owner, prove updater idle, or revalidate a root returns a fixed redacted failure and performs no cross-root best-effort continuation. Success reopens a fresh presentation session without restarting, erasing, or reconstructing Chat, Memory, credentials, Game registration, or lifecycle state.

### 4.4 Reinstall, reset, export, and purge

Update/reinstall may reopen only currently supported owner stores under the exact registered durable root. It must not silently adopt legacy JSON, another GameBuddy root, app-adjacent data, a user's system Pi/Magic Context data, arbitrary prior folders, or unmanaged files.

The first Desktop Player Release does not offer a generic whole-root backup/import or filesystem browser. Player-visible export/reset operations are owner-specific and typed: for example Chat/Memory export through their domain APIs, provider credential removal through the credential owner, and “forget this game installation” through Design 101. They never copy/import Pi session JSONL, Magic Context SQLite, Game attempt fences, bootstrap records, credentials, logs, or presentation profiles as a bulk archive. This prevents an apparently convenient backup from replaying runtime authority or combining inconsistent stores; no cryptographic backup gate is introduced.

Default uninstall preserves `data` and provider-vault entries. Explicit `Remove all GameBuddy data` first closes Chat and Game owners, then deletes only the registered `data`, `operational`, and `presentation` roots plus GameBuddy credential-vault entries. Failure to confirm owner shutdown or root identity blocks purge and reports a fixed redacted category. It never scans disks or deletes Stardew, SMAPI, saves, user Mods, provider-owned files, or unmanaged sentinels.

### 4.5 QA portable layout

A portable layout is a non-public developer/QA artifact in this design. It is independently identified and cannot silently switch between app-adjacent and per-user roots. Its isolated QA roots must not discover or adopt installed-player roots. Deleting it is not described as a supported player data purge. A future public portable product requires a separate design amendment covering signed entry, data roots, update, uninstall/support, and player-visible policy.
## 5. Single instance and launch

The app-instance authority is a same-user, cross-process native lease separate from Chat continuity locks, path locks, Stardew guardian leases, and bridge ownership.

- One primary instance may start Host/runtime.
- A secondary invocation sends only a bounded `open`/`focus` intent and exits.
- A secondary invocation cannot supply a profile, root, continuity, provider, Game installation, task, bridge, or bootstrap token.
- Owner-dead recovery must be evidence-based and fail closed on ambiguity.
- Installed and portable partitions cannot collide accidentally; the partition rule is explicit and tested.

Startup ordering is:

```text
acquire app-instance authority
→ select verified immutable generation
→ resolve registered GameBuddy-owned roots
→ start bundled runtime/Host through private parent-child channel
→ Host constructs selected product composition
→ Host publishes one-time presentation handoff only after its browser surface is ready
→ shell opens/focuses the presentation
```

No listener URL, port, cookie, nonce, or token is printed as the supported product handoff. Diagnostic stdout must remain credential-free. Installed presentation launch uses the fixed non-secret entry contract below.

## 6. Browser presentations and WebView2

### 6.1 Installed Desktop Browser Presentation

The first installable product may use the default browser if it also has a clear GameBuddy tray owner. It uses no bearer URL:

```text
private launcher→Host channel arms one short-lived presentation admission
→ shell invokes a fixed non-secret loopback entry URL
→ Host accepts only an exact top-level navigation during that pending admission
→ Host consumes the admission and returns an HttpOnly session cookie
→ every later write uses existing same-origin + CSRF controls
```

The fixed entry URL may necessarily appear in browser command-line/history handling, but it contains no secret, token, nonce, profile selector, root, generation, or user data. The Host validates exact loopback origin/Host, pending app instance/generation, top-level navigation Fetch Metadata, bounded lifetime, and single consumption. Cross-site/subresource requests, replay, wrong generation/user, and navigation without a pending private admission fail. The threat model protects against remote/cross-site trigger, stale/replayed presentation entry, accidental disclosure, and another GameBuddy generation; it does not claim protection from malware already executing as the same user.

- first successful startup opens one Desktop Browser Presentation;
- installed player copy names it `Desktop Browser Presentation`, never `Browser Preview` or WebView2;
- closing the tab does not claim to stop Chat/Game;
- tray `Open GameBuddy` privately arms a fresh admission before opening/focusing;
- the page plainly states its local-app close behavior during onboarding;
- the session cannot replay across app generation, user, profile, or Host restart.

### 6.2 Later WebView2 shell

WebView2 is a presentation replacement, not a second product architecture. It loads the same verified web artifact and consumes the same Host browser contract.

Required policies:

- use WebView2 Evergreen unless a later measured requirement justifies Fixed Version;
- use a dedicated GameBuddy-owned user-data folder;
- allow only the exact loopback origin and expected app routes;
- cancel arbitrary navigation and explicitly route safe external links to the system browser;
- block or handle popups, permissions, downloads, external protocols, and devtools by explicit policy;
- handle renderer/browser-process failure without creating a second Host;
- expose no generic native bridge, Node integration, filesystem API, process API, or secret getter to renderer code.

## 7. Close, STOP, and quit semantics

Chat and Game remain independent surfaces.

| Player action | Required semantics |
| --- | --- |
| Close browser tab | Presentation disconnect only. It does not imply Chat Stop, Game Stop, or app quit. |
| Close WebView window | Default: hide to tray. First occurrence explains that active work may continue. |
| Chat Stop | Cancels only the current Chat reply through Chat's authenticated owner. |
| Game Stop | Settles only the current Game task through Game's authenticated owner. |
| Disconnect Game | Closes the Game attachment according to its lifecycle; Chat remains mounted. |
| Tray Quit | Requests Chat close and Game close independently, reports uncertainty honestly, then seals Host ingress and exits. |
| Force-kill/crash | Runtime supervisor records a redacted crash category and invokes owner-specific recovery on next launch; it never retries a Chat prompt or Game mutation automatically. |

If active work exists when hiding/quitting, the shell displays the truthful owner-projected state and explicit actions. It must not invent an app-wide `Stop all` unless a later design defines one as a composition of separately settled surface operations with no shared authority.

## 8. Update, rollback, and uninstall

### 8.1 Update authority

If automatic update is claimed, update is:

```text
fetch signed release metadata
→ download to inactive generation
→ verify signature + complete inventory + platform/runtime contract
→ request primary app quiescence/quit
→ atomically activate generation pointer
→ start and verify new generation
→ rollback pointer on startup failure
```

Partial downloads, mixed native/browser/Host generations, in-place overwrite of a running generation, and fallback to unverified program files are forbidden.

Mutable data schema changes require an owner-specific transaction and rollback policy. The updater cannot infer that a newer binary makes uncertain Chat/Game work safe to replay.

### 8.2 Uninstall authority

Default uninstall removes program generations, shortcuts, updater cache, and registered binaries while preserving the registered durable root and GameBuddy credential-vault entries. `Remove all GameBuddy data` is a separate explicit confirmation governed by Section 4.4: it closes both surface owners, revalidates exact registered roots, removes only GameBuddy durable/operational/presentation roots and GameBuddy vault entries, and fails closed on uncertain shutdown or root identity. It never scans disks or deletes Stardew, SMAPI, saves, user Mods, provider-owned data, system Pi/Magic Context data, or unmanaged files.
## 9. Player-visible application states

The shell projects only:

```text
Starting GameBuddy
Opening GameBuddy
GameBuddy is ready
GameBuddy needs attention
GameBuddy stopped unexpectedly
Checking for updates
Update ready / Update failed; previous version kept
Closing Chat
Closing Game
Safe to exit
Could not confirm shutdown
```

It never shows raw root, PID, pipe, token, listener port, manifest path, hash, Job, lease, provider secret, or native diagnostic.

## 10. Verification matrix

### 10.1 Versioned signer policy

Release verification consumes a repository-published `gamebuddy-windows-signer-policy/v1`; it never trusts signer identity declared by the candidate installer. The policy fixes the product publisher subject and allowed leaf-certificate SPKI identities, an explicitly versioned overlap window for certificate rotation, required Windows Authenticode chain validation to a trusted root, RFC 3161 timestamp validation so an otherwise valid signature may remain acceptable after leaf expiry, and revocation checking for both leaf and chain. Online release attestation fails closed on revoked, unknown, offline/unreachable revocation, invalid/missing timestamp, wrong publisher/SPKI, untrusted/expired-at-signing chain, or mixed signer outside an approved overlap. A separately named offline QA result may report `revocation_unavailable` but cannot authorize public release.

The policy enumerates every required signed file class: `Setup.exe`, `GameBuddy.exe`, updater/uninstaller executables, resident guardian and every shipped native helper, and any executable sidecar. Scripts/data/browser assets are instead bound by the selected immutable generation inventory. Every signed executable must both pass its class rule and belong to that same selected generation; a valid signature from an allowed publisher does not authorize a stale or foreign generation. Rotation changes require a reviewed policy-version update signed/published through the release channel, never a value supplied by the artifact under test.

1. **Clean machine:** signed Setup and signed `GameBuddy.exe` start on a fresh Windows user with no Node, pnpm, repo checkout, or system Pi. The QA portable layout is checked separately and is not a public-release substitute.
2. **Inventory:** every runtime, Host/browser asset, native helper, integration bundle, and manifest belongs to one verified generation; tamper/mixed generation fails before Host start.
3. **Single instance:** simultaneous and slow double launch yield one primary Host; secondary only opens/focuses. Owner-dead and cross-user cases are fail closed.
4. **Private bootstrap:** no secret/token/nonce/profile appears in stdout, GameBuddy process command lines, logs, crash reports, durable storage, fixed entry URL, browser history, DTO, or DOM; only the fixed non-secret entry URL may appear in browser launch/history handling. Navigation without an exact pending private admission, replay, cross-site/subresource, and wrong generation/user/profile fail.
5. **Presentation labels and behavior:** Browser Preview artifacts display only the Preview label and make no desktop claim. Installed Desktop Browser Presentation never displays the Preview/WebView2 label; page close, browser close, reload, tray reopen, Host unhealthy, and app quit match visible copy and do not duplicate work.
6. **Independent surfaces:** active Chat and Game coexist; Chat Stop does not stop Game, Game Stop does not stop Chat, and tray Quit waits for both owner-specific closes.
7. **Crash:** kill shell, renderer, Host, and runtime at startup, Chat turn, Game attach/action/STOP, and update phases; stale capability is rejected and no effect is automatically replayed.
8. **Update:** interrupted download, bad signature/inventory, low disk, running process, activation crash, and rollback leave one bootable generation and declared data intact.
9. **Storage isolation and uninstall:** a fresh install resolves the canonical v1 root layout; Chat and Game Pi sessions remain separate; only explicitly same-continuity Magic Context semantic Memory crosses surfaces; system Pi/Magic Context, app-adjacent data, logs/cache/profile, and arbitrary environment roots are never adopted. Default preserve, explicit purge, reinstall, portable removal, ACL/reparse/root-overlap failure, vault removal failure, active-owner uncertainty, and unmanaged-file sentinels affect only exact registered owners.
10. **WebView2 later:** navigation, popup, permission, download, external protocol, process failure, profile lock, runtime absence/update, close/hide, and accessibility matrix pass without renderer authority.
11. **Release verifier:** one versioned verifier consumes the signed Setup path, expected product version, an independently published `gamebuddy-windows-signer-policy/v1`, and fresh Windows-user fixture; verifies Setup and all required executable classes, installs, starts the selected immutable generation, runs Design 104 real-listener journeys, records machine-readable pass/fail plus redacted reason categories and screenshot/accessibility artifacts, confirms no system Node/pnpm/Pi and exact cleanup, then uninstalls. The report binds Setup file identity/version, signer-policy version and per-file Authenticode outcomes, installed generation identity, verifier version, OS/user fixture, journey results, and cleanup result. It does not add an installer content digest because Authenticode plus exact generation/inventory binding already supplies the required identity and integrity facts. Any signature/generation mismatch, journey failure, secret leak, residual owned process, or cleanup failure blocks Desktop Player Release.

## 11. Migration order

1. Freeze exact installed/portable layouts, the canonical current-user root resolver/registry, owner partitions, and preserve/purge policy.
2. Build a thin signed launcher over the existing verified Host/browser artifact; bundle the runtime.
3. Add same-user app-instance authority and private Host presentation handoff.
4. Deliver tray-owned Desktop Browser Presentation as the first installable presentation; keep Browser Preview developer/QA-only.
5. Close hide/quit/crash/update/uninstall matrices.
6. Only then label the artifact a Desktop Player Release.
7. Add WebView2 later without changing Host browser or domain authority.

Verifier delivery is explicitly two-stage: Task 103.8 first closes only the versioned signer/install/start/real-listener driver and strict report infrastructure; Design 104 Tasks 1–10 then close the actual player journeys; finally that already-versioned verifier executes the full journey set as the shared Design 103/104 Desktop Player Release gate. Verifier infrastructure does not wait for journey implementation, and neither design may claim final release from infrastructure alone.

## 12. Explicit exclusions

- No Electron/Tauri migration in this design.
- No overlay, global hotkey, always-on-top mini window, or in-game rendering.
- No renderer-owned provider/Game/filesystem/process API.
- No automatic installation or modification of Stardew/SMAPI in the distribution authority.
- No desktop-release claim from existing pnpm/CLI/browser evidence alone.
