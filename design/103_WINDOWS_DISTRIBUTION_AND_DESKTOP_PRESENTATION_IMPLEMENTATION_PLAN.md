# Windows Distribution and Desktop Presentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the project's `subagent-driven-development` skill task-by-task. Steps use checkbox syntax. Use TDD for each state transition and keep native shell/distribution work separate from Chat and Game owners.

**Goal:** Deliver a clean-machine signed Windows GameBuddy product that installs without Node/pnpm, owns one app instance and tray lifecycle, opens the existing Host-owned web product safely as the temporary Desktop Browser Presentation, preserves independent Chat/Game authorities, and can later replace that presentation with WebView2 without changing domain contracts. A portable layout remains developer/QA-only.

**Architecture:** A thin native `GameBuddy.exe` consumes one verified immutable program generation, starts a bundled runtime and Host through a private handoff, and owns only app-instance, supervision, tray/window visibility, update activation, and uninstall policy. Host remains the only browser bootstrap, Chat, Game, credential, Pi, Memory, and lifecycle authority. The first installable presentation uses the default browser; WebView2 is a later adapter at the same presentation seam.

**Tech Stack:** Windows/.NET 8 launcher, existing Node 24 Host production artifact, existing React/Vite Dialogue Web artifact, current-user Windows IPC/mutex helpers, signed per-user installer, Node `node:test`, .NET tests, Playwright, Windows disposable-user/VM gates.

**Spec:** `design/103_WINDOWS_DISTRIBUTION_AND_DESKTOP_PRESENTATION_DESIGN.md`

## Global constraints

- Do not move Host authority into native shell, tray, browser, or WebView2.
- Do not use system Node, pnpm, Pi, repository dependencies, or arbitrary PATH fallback.
- Do not combine Chat Stop, Game Stop, and app Quit into one domain owner.
- Do not implement WebView2 before Desktop Browser Presentation packaging/supervision/auth is independently green. Browser Preview remains developer/QA-only and never labels an installed product.
- Do not claim auto-update until signed inactive-generation activation and rollback are tested.
- Do not touch Stardew/SMAPI installation files from the installer.
- Public releases resolve only `gamebuddy-windows-root-layout/v1`; `~/.gamebuddy`, app-adjacent folders, arbitrary environment roots, user Pi/Magic Context roots, and QA portable roots are not installed-product fallbacks.
- Program, durable, operational, presentation, and credential-vault owners remain distinct. Logs/cache/WebView2 profile never become continuity or recovery inputs, and no generic whole-root backup/import is introduced.

---

## Task 1 — Freeze and verify the distributable layout

**Outcome:** One builder produces a developer/QA portable layout and an installable-generation payload containing the bundled runtime, exact Host/browser/native artifacts, and no development dependencies. Only the latter feeds the public signed installer.

**Files:**
- Create: `desktop/GameBuddy.Desktop/GameBuddy.Desktop.csproj`
- Create: `desktop/GameBuddy.Desktop/Program.cs` (initial no-window launcher skeleton)
- Create: `desktop/GameBuddy.Desktop/DistributionLayout.cs`
- Create: `desktop/GameBuddy.Desktop/CurrentUserRootLayout.cs`
- Create: `desktop/GameBuddy.Desktop.Tests/DistributionLayoutTests.cs`
- Create: `desktop/GameBuddy.Desktop.Tests/CurrentUserRootLayoutTests.cs`
- Create: `host/scripts/build-desktop-generation.mjs`
- Create: `host/scripts/build-desktop-generation.test.mjs`
- Modify: Host production startup/composition and runtime-root consumers, including `host/src/runtime.ts` and every production entrypoint that constructs Chat/Game runtimes
- Modify: root/Host package scripts only for explicit desktop build/check commands

- [ ] Write failing tests for exact generation layout, missing/mixed runtime, extra entry, reparse/symlink, system-Node fallback, and clean-machine path independence.
- [ ] Write failing root tests for wrong user, reparse boundary, overlap with program/other roots, app-adjacent/current-working-directory/environment substitution, `~/.gamebuddy`, system Pi/Magic Context discovery, installed↔portable collision, and pre-existing unmanaged sentinels.
- [ ] Implement one canonical installed/portable generation manifest consuming the existing production inventory; do not create a parallel Host inventory.
- [ ] Implement one `gamebuddy-windows-root-registration/v1` in current-user Windows product/uninstall registration metadata outside all deletable product roots. It contains only the fixed first-release root constants and schema version; Setup creates it, repair/reinstall preserves and revalidates it, launcher consumes it, Task 5 purge consumes the same registry, and final uninstall removes it after preserve/purge policy completes. Do not build a second root registry or support player-selected product roots in this release.
- [ ] Implement `gamebuddy-windows-root-layout/v1` with exact `%LOCALAPPDATA%\GameBuddy\{data,operational,presentation}` roots and Windows current-user vault namespace; pass it to Host over the private parent-child bootstrap before any mutable owner opens. Browser and secondary instance receive no root fields.
- [ ] Make the Desktop Host production root-layout input required and validated at every production runtime-construction entrypoint before `createRuntime()`, `resolveRuntimePaths()`, Chat store, Magic Context, or Game owner construction. Missing/invalid input fails closed. Retain `~/.gamebuddy` only behind an explicit dev/QA composition and add a topology/import test proving no Desktop startup can reach the default root.
- [ ] Bind Host owners to registered namespaces: Tavern/Chat stores, continuity `contexts` (embedded Pi + surface sessions + scoped Magic Context), non-secret settings, and Stardew registration/bootstrap. Preserve existing owner schemas; do not build a generic storage facade.
- [ ] Bundle the exact supported Node runtime and resolve Host entry only inside the selected generation.
- [ ] Build a clearly non-public QA portable layout with isolated QA roots, no system Node/pnpm/Pi/repository checkout, and no inherited installed-player credentials or roots. Network behavior is selected by an explicit QA mode: deterministic offline suites stay offline, while disposable real-provider QA may opt in. It is not an alternative Desktop Player Release artifact.
- [ ] Run .NET tests, focused Node tests, production artifact check, and `git diff --check`.
- [ ] Independent review: verify the launcher cannot choose domain identity, provider, Game installation, task, or bridge facts.

## Task 2 — Add current-user single instance and runtime supervision

**Outcome:** Double launch creates one primary GameBuddy runtime; secondary launch requests only Open/Focus.

**Files:**
- Create: `desktop/GameBuddy.Desktop/AppInstanceOwner.cs`
- Create: `desktop/GameBuddy.Desktop/RuntimeSupervisor.cs`
- Create: `desktop/GameBuddy.Desktop/PrimaryIntentPipe.cs`
- Create/modify corresponding .NET tests and disposable process workers
- Modify Host startup wrapper only to accept a private inherited handoff, not public app options

- [ ] Write process tests for concurrent/slow starts, stale owner, primary crash, cross-user denial, installed/portable partition, and secondary payload rejection.
- [ ] Implement an ACL-protected current-user app-instance lease distinct from Chat/Game/path/guardian locks.
- [ ] Limit secondary intents to exact `{ open | focus }`; reject roots, profiles, tokens, tasks, paths, provider or Game fields.
- [ ] Implement bundled Host process supervision with bounded startup/close and redacted exit categories; no automatic effect retry.
- [ ] Verify exactly one Host/store/provider/control owner, canonical root layout delivered before owner construction, and no inherited secret or raw root in browser/secondary-instance/stdout surfaces.
- [ ] Independent native-security/lifecycle review.

## Task 3 — Replace stdout URL with private presentation handoff

**Outcome:** Host owns one pending installed-presentation admission after browser readiness; the launcher opens a fixed non-secret loopback entry and no bearer authority material enters a URL.

**Files:**
- Create: `host/src/desktop-presentation-handoff.internal.ts`
- Create direct tests
- Modify: `host/src/dialogue-web-main.ts` and exact static-shell composition startup
- Modify: `desktop/GameBuddy.Desktop/RuntimeSupervisor.cs`
- Add mounted production-browser tests

- [ ] Write failing tests proving no token/nonce/profile/root/generation in stdout, GameBuddy command lines, environment dumps, logs, durable files, fixed entry URL, browser history, DTO, or DOM. The fixed non-secret loopback URL may appear in browser launch/history handling.
- [ ] Implement one private parent-child command that arms an exact short-lived pending presentation admission; shell then opens only the fixed non-secret entry route.
- [ ] Require exact loopback Host/origin, top-level navigation Fetch Metadata, pending app instance/generation/user, bounded lifetime, and single consumption; cross-site/subresource, absent admission, replay, wrong generation/user/profile fail.
- [ ] On consumption return the existing HttpOnly session cookie and preserve same-origin/CSRF, strict DTO, and Host-owned profile binding. Do not put a bearer credential in path/query/fragment.
- [ ] Make first launch/readiness failure and secondary Open observable through fixed redacted categories.
- [ ] Run real-listener Desktop Browser Presentation tests for first open, reload, tab close, tray reopen, cross-site/subresource trigger, absent admission, replay, wrong generation/user/profile, Host unhealthy, and no duplicate work.
- [ ] Review browser security and authority redaction.

## Task 4 — Deliver tray-owned Desktop Browser Presentation lifecycle

**Outcome:** `GameBuddy.exe` has a tray owner with Open, status, and Quit; page/window closure no longer leaves ambiguous product behavior.

**Files:**
- Create: native tray/window modules and tests under `desktop/GameBuddy.Desktop/`
- Modify: Host app readiness/shutdown projection only through a narrow app-shell contract
- Modify: Dialogue Web onboarding/copy using Design 26 tokens and i18n; no native authority in React
- Add Playwright journeys

- [ ] Define typed shell intents: `open`, `hide`, `quit`; no generic command bridge.
- [ ] Project independent Chat and Game activity/close availability from Host; do not expose raw internals.
- [ ] Implement Quit as independent Chat-close and Game-close requests followed by Host ingress sealing; uncertainty is shown, not coerced to success.
- [ ] Add first-run explanation using the exact `Desktop Browser Presentation` label: this browser page is the installed GameBuddy UI; closing it does not stop background work; tray Open/Quit own reopening/exiting. Installed copy never says Browser Preview or WebView2.
- [ ] Test page close, browser close, reload, tray hide/open/quit with idle/active Chat, active Game task, voice, failure, and simultaneous Chat+Game.
- [ ] Verify keyboard, notification, localization, 44px targets, and no generic AI-dashboard visual drift.

## Task 5 — Build signed per-user installer and uninstall/data policy

**Outcome:** Players install/uninstall normally; default uninstall preserves registered durable data and GameBuddy vault entries, while explicit purge first closes both surface owners and removes only exact registered GameBuddy roots/vault entries.

**Files:**
- Create a single approved installer project under `desktop/installer/`
- Consume the Task 1 root registration and add owner-specific preserve/purge tests; do not create another root registry
- Add signing/publication scripts without secrets in repo
- Add clean-machine install tests

- [ ] Freeze per-user install, shortcuts, uninstall registration, no-admin default, the single Task 1 root-registration lifecycle, canonical root layout, GameBuddy vault namespace, and default-preserve/explicit-purge policy.
- [ ] Test install/start/repair/uninstall/reinstall, running Chat/Game owners, uncertain shutdown, different user, ACL/disk failure, reparse/root overlap, unmanaged sentinels, vault removal failure, default preserve, and explicit purge.
- [ ] Implement purge as a narrow owner-orchestrated operation: independently close Chat and Game, revalidate registered root identities, delete only `data`, `operational`, `presentation`, and GameBuddy vault entries, and fail closed without scanning or best-effort continuation.
- [ ] Do not offer a generic whole-root backup/import. Any player export/reset route must be typed and domain-owned; Pi JSONL, Magic Context SQLite, Game fences/bootstrap records, credentials, logs, and presentation profiles are never bulk-imported.
- [ ] Publish and consume a versioned `gamebuddy-windows-signer-policy/v1` independent of candidate artifacts: fixed publisher subject/allowed leaf SPKI identities, reviewed certificate-rotation overlap, trusted Authenticode chain, RFC 3161 timestamp, online revocation fail-closed rules, and exact required executable classes. Sign `Setup.exe`, `GameBuddy.exe`, updater/uninstaller, guardian, and every required shipped native executable in release CI; unsigned dev/QA builds remain clearly non-public.
- [ ] Verify installer never discovers/modifies Stardew or stores provider secrets.
- [ ] Run fresh Windows VM with no Node/pnpm/Pi and complete Desktop Browser Presentation onboarding.
- [ ] Independent release/data-deletion review.

## Task 6 — Add inactive-generation update and rollback

**Outcome:** A failed or interrupted update preserves one bootable prior generation and all declared data.

- [ ] Write updater state-machine tests for bad signature/inventory, partial download, low disk, running Host, crash before/after pointer switch, rollback, owner-specific data-schema failure, and attempted operational/presentation-cache adoption as durable state.
- [ ] Download only to inactive generation and verify complete signed inventory before activation.
- [ ] Quiesce/quit through shell/Host owners; never overwrite a running generation.
- [ ] Activate one pointer atomically and rollback on startup health failure.
- [ ] Show fixed update states without paths/hashes/secrets; never retry Chat/Game effects.
- [ ] Run clean-machine upgrade and downgrade/rollback matrix and fresh review.

## Task 7 — Optional WebView2 presentation adapter

**Entry gate:** Tasks 1–6 and Desktop Browser Presentation player journeys are green. This task is not a prerequisite for the first signed Desktop Player Release.

- [ ] Write shell tests for Evergreen runtime absent/update, exact registered presentation-root user-data folder, profile lock, attempted durable/system-profile adoption, navigation/popup/permission/download/external protocol, renderer/browser-process crash, close/hide, cache clear, and accessibility.
- [ ] Embed the exact Host-served artifact; no file/remote app page and no desktop-only domain contract.
- [ ] Restrict navigation to exact loopback origin/routes, send safe external links to system browser, and expose no generic native bridge.
- [ ] Preserve tray/single-instance/runtime supervisor and Host bootstrap unchanged.
- [ ] Prove renderer crash/reopen cannot create a second Host or duplicate Chat/Game work.
- [ ] Independent renderer-isolation review.

## Task 8 — Add the signed fresh-install release verifier infrastructure

**Outcome:** One versioned entrypoint establishes the signer/install/start/real-listener driver and strict report machinery against the exact signed installer and immutable installed generation, rather than a development Host. This infrastructure can close before Design 104 journeys exist; it does not by itself authorize Desktop Player Release.

- [ ] Create a versioned runner under `tools/` and strict machine-readable report schema. Inputs are signed Setup path, expected product version, independently published `gamebuddy-windows-signer-policy/v1`, and a disposable fresh Windows-user/VM fixture; no provider secret or Game path is written into the report.
- [ ] Implement the signer-policy validator: publisher/SPKI and rotation version, Authenticode trusted chain, RFC 3161 timestamp, online revocation fail closed, required executable class enumeration, and fixed redacted failure categories. Never infer allowed signer from the candidate Setup.
- [ ] Verify Setup and required shipped executable signatures, install, start through `GameBuddy.exe`, read only a redacted installed-generation identity from the app/verifier boundary, bind each executable to that generation inventory, and reject a development/unsigned/mixed/stale generation.
- [ ] Provide versioned real-listener journey-driver APIs, screenshot/a11y artifact references, label assertions, teardown/uninstall checks, and exclusive report creation so Design 104 can add journeys without changing release authority.
- [ ] Prove no system Node/pnpm/Pi/Magic Context/repository dependency; no app-adjacent, `~/.gamebuddy`, arbitrary environment, system Pi/Cortex, or QA-root adoption; no secret in process/URL/history/DTO/DOM/log artifacts; and no residual owned Host/helper/Stardew process after declared close.
- [ ] Include verifier version, Setup file identity/version, signer-policy version and per-file Authenticode outcomes, installed product/generation identity, OS/user fixture, per-journey outcomes, redacted reason categories, artifact references, and cleanup result. Do not add a content digest that duplicates Authenticode + generation inventory.
- [ ] After Design 104 Tasks 1–10 close, run the complete no-route-mock journeys with this unchanged versioned infrastructure. Any signature/generation mismatch, missing journey, secret leak, residual process, accessibility failure, or cleanup failure blocks the shared Design 103/104 Desktop Player Release gate. Independent release/security review is mandatory.

## Final release gates

A Desktop Player Release requires Tasks 1–6, Task 8 verifier infrastructure, Design 104 Tasks 1–10, the shared final verifier execution in Design 104 Task 11, Chat MVP acceptance, Stardew lifecycle closure, clean-machine canonical-root isolation, signing, independent authority/data-deletion review, and no known unresolved app/Chat/Game shutdown or root-ownership uncertainty. WebView2 remains optional until Task 7 closes.
