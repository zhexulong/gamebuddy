# Player Onboarding and Surface Journeys Design

**Status:** Proposed product-experience owner for fresh-root Chat and Game journeys. It does not replace the execution/lifecycle owners in Designs 90, 91, or 99–103.

**Owner:** The composed GameBuddy player shell. It owns navigation, redacted readiness, player vocabulary, sequencing, and recovery actions. Host modules remain the producers of every readiness/lifecycle/content fact.

**Visual baseline:** `design/26_TAVERN_FRONTEND_DESIGN_SPEC.md` and the existing three-tier token system in `dialogue-web/src/style.css`. Preserve the warm charcoal surfaces, burgundy accent, gold focus, teal/warning/danger semantics, Chat-first 640–800px reading measure, one contextual drawer, 44px targets, en/zh-CN parity, reduced motion, and accessible native controls. Do not redesign GameBuddy into a generic AI dashboard, card grid, purple/blue gradient interface, operator console, or permanent Game column.

## 1. Product promise

A non-technical player can:

```text
install/open GameBuddy
→ understand what needs setup
→ configure or diagnose companion-provider readiness without exposing secrets
→ create/select a companion and Chat
→ send/stop/recover conversation
→ find or manually choose Stardew
→ understand SMAPI/GameBuddy Mod readiness
→ play/attach/reconnect with the companion
→ submit and stop a Game task through the Game owner
→ close/reopen without guessing what continues
```

The shell never makes one surface control another. Chat and Game may be visible together but remain independent owners.

## 2. Shell information architecture

The default screen is the current Chat. The AppBar exposes only real contextual entries:

```text
GameBuddy | active companion | connection status | Chats | Characters | Game | Settings
```

Exactly one contextual drawer is open. On mobile it is a full-height sheet. Game is not an inline technical status block, route-level dashboard, or second composer mixed into Chat.

First-run states:

1. **App setup needed:** runtime or provider readiness blocks useful Chat/Game.
2. **No companion:** Create companion / Import character card.
3. **Companion, no Chat:** New Chat / Chat History.
4. **Chat ready:** conversation timeline and composer.
5. **Game not configured:** Game drawer offers automatic search and native manual selection.
6. **Game configured:** player sees safe version/prerequisite summary and one truthful primary action.

Unknown URL/profile never produces a blank root. Host/bootstrap failure renders one actionable problem state with Retry/Open settings/Restart GameBuddy only when those actions are actually released.

## 3. Provider and model readiness

Credentials are not model preferences. The Desktop Player Release must provide at least one complete Host-owned setup journey for its shipped `cpa-oai` companion service; the existing `CPA_OAI_API_KEY` environment-variable path remains contributor/developer-only and cannot satisfy player onboarding.

```text
Settings → Companion service → Enter API key
→ authenticated bounded write
→ Host stores in current-user Windows credential vault
→ provider owner performs a bounded readiness probe
→ browser rereads ready | setup_needed | unavailable
```

The secret may exist transiently in the authenticated request body, but is never persisted by the browser, echoed in a response, inserted into DOM/state/history, logged, included in crash reports, written to product config/model preferences, or sent to Game. Host owns validation, Windows Credential Manager/vault write/delete, runtime resolution, restart reopen, and redacted probe result. Cancel preserves the previous credential/readiness. Invalid input remains `setup_needed` with safe correction copy. Provider outage is `unavailable` and must not erase a stored credential. Removing the credential requires explicit confirmation and authoritative reread.

Host/provider owners project only:

```text
ready
setup_needed
unavailable
```

Player copy:

- `Your companion service is ready`;
- `Your companion service needs setup`;
- `Your companion service is temporarily unavailable`.

Settings exposes only `Set up`, `Replace`, `Check again`, and `Remove` when the corresponding Host operations are mounted. The Game drawer never asks for an API key. Browser state contains no secret, credential source/account locator, raw provider error, prompt, provider state token, or Pi internals. The public contract is intentionally provider-neutral even though the first implementation supports one shipped provider; adding OAuth or another provider requires its own owner adapter, not a generic credential console.

Chat and Game may use separately named model profiles, but the player shell cannot select arbitrary models unless a separately released settings contract owns that choice. Provider failure must be distinguishable from Stardew setup failure.

## 4. Chat journey

### 4.1 Library and content

Host services already own companions, personas, scenarios, greetings, Chat creation/open, World Info, drafts, and Memory. The player shell must connect these through authenticated routes and one drawer model rather than requiring profile/hash/operator selection.

Required journey:

```text
Create/import companion
→ choose Persona/Scenario/Opening from safe catalogs
→ create Chat
→ durable greeting message 0 or honest blank Chat
→ Chat becomes active only after Host confirms it
→ send
→ stream/read durable reply
→ stop/fail/retry
→ reload/reopen exact Chat
→ manage Memory and World Info through real capability-gated actions
```

Unreleased operations remain absent. A service existing in Host is not player capability until route, browser client, UI, and mounted journey are all present.

### 4.2 Chat task control

Chat Stop cancels only the active reply. After authoritative reread:

- `Reply stopped. You can send another message.`
- `We couldn't finish that reply. Your message is saved.`

A future redirect/steer action requires its own authenticated route and durable semantics; it cannot be simulated by cancelling and silently resubmitting.

### 4.3 Profile composition

Reference Chat and Management are implementation profiles, not separate player applications. Public launcher/bootstrap selects one composed player shell. Chats, Memory, World Info, settings, and Game are contextual surfaces within it, capability-gated by Host. Unknown/missing hash profile is an error, never a blank page.

## 5. Game installation discovery and registration

### 5.1 Player actions

Game drawer state `not_configured` displays:

```text
Connect Stardew Valley
GameBuddy needs to find your Stardew Valley installation.
[Find automatically] [Choose game folder]
```

Manual selection always remains available and uses the existing Host-native folder picker. Browser/WebView never sends a path.

### 5.2 Automatic discovery

Automatic discovery is a separate Host-private candidate producer. It may inspect a bounded set of mature sources such as Steam's registered libraries/app manifest and GOG's supported installation records. It must not recursively scan drives.

Discovery produces untrusted candidates only:

```text
discovery source
→ candidate locator
→ strict admitStardewInstallation
→ safe candidate choice projection
→ explicit player confirmation
→ Design 101 registration publication
```

The browser receives only opaque short-lived candidate handles, safe source labels (`Steam`, `GOG`, `Manual`), and safe display hints. It never receives full path, registry/VDF bytes, executable, identity chain, or inspector output.

No candidate or heuristic becomes a fallback at launch. If the selected/registered installation later fails fresh admission, the state becomes `needs_setup`; the product never silently switches to another installation.

### 5.3 Registration

Design 101 remains the sole durable locator registration owner. First valid manual or confirmed discovered selection registers one private locator. Later launches fresh-admit it. `Forget this installation` is an explicit private revocation and is unavailable while an attempt fence is active.

## 6. Stardew prerequisites and repair vocabulary

The drawer distinguishes:

```text
not_configured
searching
candidate_found
ready
needs_smapi
needs_gamebuddy_mod
compatibility_warning
incompatible
setup_failed
```

Player-safe copy includes:

- `Stardew Valley was found`;
- `SMAPI needs to be installed`;
- `The GameBuddy mod needs attention`;
- `This game version has not been tested yet. You can still try.`;
- `This game version needs attention before a companion can connect`.

The UI shows only a real next action: Find again, Choose folder, Check again, Open supported installation help, Forget installation, Continue after warning. It never exposes loader logs, paths, hashes, PIDs, pipe/token, Mod profile directory, raw exception, or operational config.

This design does not authorize silent SMAPI installation or mutation of the player's default Mods folder. A later repair design may do so only with explicit ownership, rollback, licensing, and user consent.

## 7. Game lifecycle journey

The player sees one primary action: **Play with companion / 和伙伴一起玩**. Host state chooses whether that means launch or attach; UI does not ask the player to understand the two-process topology.

```text
ready
→ starting_game | looking_for_game
→ awaiting_confirmation
→ connecting_companion
→ ready_to_play
↔ game_task_active
→ stopping_game_task
→ game_task_stopped
→ reconnecting | disconnected | needs_attention
```

The Game drawer may explain that GameBuddy starts the player's Stardew and connects an AI companion, but it does not expose Player Host/AI client process details.

Cabin/Farmhand choice appears only when lifecycle state makes it available. A pre-attestation cabin read cannot permanently poison the UI: the drawer refreshes from a Game-owned state/event epoch and refetches choices only when safe. An uncertain confirmation is not replayed; it shows `We couldn't confirm that result. The latest game state is shown.` and reconciles from authoritative attachment state.

Attach/reconnect controls appear only when corresponding Host operations exist. Disconnect does not imply Chat close. Reconnect must use fresh generation/world validation and must not adopt an ambiguous prior role process.

## 8. Game task journey

Chat composer remains Chat. Game task input is a distinct control inside the Game drawer or a clearly named Game task mode. It dispatches only through the Game task ingress owned by the current attached Game facade.

Required projection:

- task availability and active/inactive state;
- redacted current intent/status;
- safe capability summary;
- latest source-owned outcome (`succeeded`, `failed`, `cancelled`, `uncertain`);
- fresh world/save/companion display labels where safely produced;
- STOP availability and settlement.

The browser never receives raw tool names, action IDs/revisions, prompts, plans, receipts, evidence payloads, or internal model output unless a later player-facing contract explicitly authorizes a safe presentation.

Game STOP is available whenever the Game owner says active work can be stopped. Copy is `Stop game task`, not `Stop game`, when it settles Agent/native task work. During settlement show `Stopping game task…`; Chat remains usable according to its own state.

## 9. Freshness and recovery

Chat SSE updates Chat. Game needs its own Host-owned state/event freshness or bounded polling; a Chat event must not be required to refresh Game state.

Required journeys:

- browser page reload;
- page/window close and tray reopen;
- Host restart;
- Game disconnect/reconnect;
- stale browser snapshot/generation;
- app crash/update recovery.

Every recovery rereads current owner state. It never duplicates a Chat message, provider prompt, Game task, cabin confirmation, launch, or native action.

### 9.1 Player data and privacy journey

Settings may explain the player-owned outcomes without exposing filesystem layout:

- provider credential: configured/not configured, replace, or remove through the Host-owned vault journey;
- game installation: configured/needs attention/forgotten through Design 101 operations;
- Chat, Memory, and World Info: managed only through their typed product operations;
- clear cache/presentation data: removes only disposable Design 103 operational/presentation state after affected presentation owners close;
- uninstall or `Remove all GameBuddy data`: delegates to Design 103 and never presents a generic folder picker or raw-root deletion.

The first Desktop Player Release does not advertise “Back up all GameBuddy data”, import a raw GameBuddy directory, expose Pi sessions/Magic Context databases, or imply that clearing cache erases Memory. If owner-specific export is offered, the UI names the exact content and excludes runtime authority/state owned by Pi, Magic Context, Game bootstrap/recovery, credentials, logs, and presentation profiles.

Player copy distinguishes:

```text
Clear temporary files        does not remove chats, memories, or game setup
Forget this game installation does not uninstall or modify Stardew/SMAPI
Remove provider credential   disables provider readiness; does not delete chats
Remove all GameBuddy data    explicit destructive confirmation after Chat/Game close
```

## 10. UI and accessibility contract

All implementation follows Design 26 and the redesign-existing-project audit discipline:

- work with React/Vite/vanilla CSS; no framework migration;
- retain the three-tier token architecture;
- conversation remains primary; use one contextual drawer/sheet;
- no nested generic cards, technical dashboard, gradient orb, glassmorphism, or fake data;
- every state has loading, empty, busy, success, failure, and recovery expression;
- use localized player outcomes, never raw enum (`connected_idle`, `state_unavailable`, etc.);
- complete en/zh-CN key parity including aria-labels and notices;
- 44×44 targets, visible focus, focus trap/restore, Escape/backdrop/Browser Back, skip link, polite live regions, sequential headings;
- reduced-motion support;
- screenshot/interaction checks at 375, phone landscape, 768, 1024, 1440 in both locales;
- long Chinese labels and authored content cannot overflow;
- no remote fonts or imagery dependency for core product usability.

## 11. Player acceptance journeys

A Desktop Player Release cannot close without real-listener/no-route-mock journeys for:

1. Fresh install → provider setup-needed → cancel → invalid secret → valid Host-vault write/probe → redacted ready → restart reread → explicit remove, with no secret in DTO/DOM/history/log evidence.
2. Create/import companion → choose Persona/Scenario/Opening → create/open Chat → greeting/blank semantics.
3. Send → stream → persisted reply → reload.
4. Send → Chat Stop → stopped state → send again.
5. Provider failure → actionable safe state → recovery without duplicate message.
6. Memory CRUD and World Info attach/remove → reload.
7. Game automatic discovery unique/multiple/none and manual picker cancel/invalid/valid.
8. Registered installation reopen, moved/missing/reparse/SMAPI-missing/Mod-failed/version-warning states.
9. Play with companion → launch or attach → cabin confirmation → AI companion ready.
10. Submit Game task → progress/outcome → Game STOP; Chat remains independent.
11. Game disconnect/reconnect and Host restart with no duplicate effects.
12. Page/window close, tray reopen, app Quit, crash/update recovery with truthful disclosed behavior.
13. Clear temporary files preserves Chat/Memory/game registration; forget-game and credential removal affect only their named owner; default uninstall preserves durable data; explicit purge closes owners, removes exact registered roots/vault entries, and rejects unmanaged/root-identity uncertainty.
14. A same-continuity Chat/Game pair may consume Magic Context-owned semantic Memory while keeping raw Pi sessions/transcript/tool/world/receipt state isolated; different continuity and system Pi/Magic Context data never cross.
15. Keyboard/focus/live-region/reduced-motion/viewport/localization matrix.

These journeys are executed by the Design 103 release verifier against the exact signed Setup/installed generation for a Desktop Player Release. The strict result binds verifier version, Setup file identity/version, Design 103 signer-policy version and per-file Authenticode outcomes, installed generation identity, OS/user fixture, each journey result, screenshot/accessibility artifacts, redacted failure category, teardown, and uninstall cleanup. No separate installer content digest is needed because signature plus immutable-generation inventory already provide identity/integrity. A development Host, unsigned/mixed generation, route mock, missing journey, provider-secret leak, residual owned process, or cleanup failure is a failed release gate.

## 12. Explicit exclusions

- No combined Chat/Game STOP owner.
- No Game action receipt rendered as Chat dialogue.
- No generic model/provider console.
- No path text input or browser filesystem picker for game setup.
- No drive-wide discovery scan or silent fallback installation.
- No inline technical Game status block in the timeline.
- No desktop shell authority in React.
- No generic raw-root browser, whole-GameBuddy-directory backup/import, Pi-session viewer, Magic Context database editor, or cache-as-durable-authority behavior.
