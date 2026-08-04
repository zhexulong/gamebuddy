# Local Stardew automation tools

These scripts support repeatable local-co-op smoke preparation without editing game memory, save data, or multiplayer state.

## XInput gate

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/check-xinput.ps1
```

The probe calls the Windows XInput API for users 0-3. It exits non-zero when no controller endpoint is available. A virtual controller bus driver alone is not an endpoint.

## Window driver

The driver requires a target Stardew/SMAPI PID and verifies the process path and window title before focusing or sending a key. Input is disabled unless `-AllowInput` is supplied.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/drive-stardew-ui.ps1 -ProcessId <pid> -Action Focus
powershell -NoProfile -ExecutionPolicy Bypass -File tools/drive-stardew-ui.ps1 -ProcessId <pid> -Action StartLocalCoop -AllowInput
```

`StartLocalCoop` first runs `check-xinput.ps1` and refuses to send any input unless a real or explicitly provisioned second XInput endpoint exists. The script only navigates the visible Stardew menu; the game itself must perform Farmhand creation and local-co-op state changes.

The scripts do not install drivers, inject a Farmer, edit saves, bypass Steam, or emulate multiplayer packets. A driver-backed virtual XInput device must be provisioned separately and deliberately by the operator.

## Formal Phase 1 prerequisite gate

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/check-stardew-phase1-prerequisites.ps1
```

This reports whether the licensed Stardew/SMAPI installation, separate Host and AI-client Mod profiles, shared session directory, and exact native Farmhand ID are configured. If `GAMEBUDDY_STARDEW_GAME_PATH` is not exported, pass the installed directory explicitly with `-GamePath`. The deployed `Mods/GameBuddy/config.json` is used as the Host profile by default; pass `-AiClientModConfigPath <path>` for the separately controlled AI-client profile, plus `-SessionDirectory <absolute-path>` and `-ExpectedFarmhandId <native-id>` (or set the matching environment variables). Add `-RequireRunningClients` only for a real two-process `@game` run. A blocked result is expected when the environment is not provisioned; the script never treats the diagnostic probe, a single client, or a static/compile check as proof of the BDD scenarios for provisioning, save/reconnect, day transition, scope, or host-visible synchronization.

## Attachment regression

For a fully provisioned local save, `run-stardew-attachment-regression.ps1` runs the non-UI Host-first attachment regression: initial signed request, native `Saving/Saved`, AI-client entry, client-exit save, same-Host reconnect, Host restart nonce rotation, old-manifest rejection, and a new signed attachment after restart. The Host profile used by this runner must explicitly enable `HostAutomation.TriggerNativeSaveAfterAttachment` and `HostAutomation.TriggerNativeSaveAfterClientExit`; these are test-fixture switches and must remain disabled in a production Host profile.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/run-stardew-attachment-regression.ps1 `
  -GamePath "D:\\Steam\\steamapps\\common\\Stardew Valley" `
  -HostModsPath "C:\\Users\\you\\AppData\\Local\\GameBuddy\\stardew-profiles\\A-host" `
  -AiClientModsPath "C:\\Users\\you\\AppData\\Local\\GameBuddy\\stardew-profiles\\A-ai-client" `
  -HostConfigPath "C:\\Users\\you\\AppData\\Local\\GameBuddy\\stardew-profiles\\A-host\\GameBuddy\\config.json" `
  -SaveName "A_445094166" -ExpectedFarmhandId "native-id" `
  -SessionDirectory "C:\\Users\\you\\AppData\\Local\\GameBuddy\\stardew-session-A"
```

The runner does not use Computer Use, keyboard injection, or UI navigation. It only starts isolated SMAPI profiles, reads the signed session exchange, invokes the existing Companion App attachment flow, and asserts native game-thread/log evidence.

## Verified native mechanics smoke

When a formal AI-client is already at `readyToPlay`, `run-stardew-equip-tool-smoke.mjs` sends one `equip_tool` request through the production named-pipe bridge. The Mod must advertise `equip_tool` in the local player's `EnabledActions`; the script never enables capabilities itself.

```powershell
node tools/run-stardew-equip-tool-smoke.mjs `
  --client-config "C:\\Users\\you\\AppData\\Local\\GameBuddy\\stardew-profiles\\A-ai-client\\GameBuddy\\config.json" `
  --slot 3
```

The result is accepted only when the Mod receipt is `state=succeeded`, `reasonCode=tool_selected`, and its evidence contains matching `before`, `expected`, and `after` tool identities. This is a single non-resource-changing capability proof, not complete mechanics or Agent acceptance.

For the currently verified bridge/ledger guards, run:

```powershell
node tools/run-stardew-bridge-ledger-smoke.mjs `
  --client-config "C:\\Users\\you\\AppData\\Local\\GameBuddy\\stardew-profiles\\A-ai-client\\GameBuddy\\config.json"
```

This checks a stale revision rejection, idempotency-key conflict rejection, and a final Tool restore through the formal named-pipe bridge.


## Ongoing-interaction Historian authoring gate

`run-ongoing-interaction-historian-authoring.mjs` is a provider-backed
verification of the Magic Context fork's Historian authoring path. It creates a
fresh GameBuddy-owned temporary runtime and in-memory test DB, obtains the
configured model only through that runtime's embedded Pi SDK registry, and
directly exercises the fork's native Historian publication pipeline. It is
intentionally not the normal long-context trigger: production scheduling stays
unchanged and enables the same embedded, no-tool Historian only when Magic
Context's own context-pressure scheduler requires it.

```powershell
node tools/run-ongoing-interaction-historian-authoring.mjs
```

A pass executes two native Magic Context scenarios: a one-off Episodic fixture
must publish a compartment with zero `SEMANTIC_MEMORY` rows while
`auto_promote=false`; a separately explicit, confirmed durable-preference
fixture must publish exactly one scoped `SEMANTIC_MEMORY` row only with the
test-gate's `auto_promote=true`. This verifies Magic Context's existing
promotion semantics. GameBuddy selects Magic Context's native product
`auto_promote` setting and automatic embedded Historian authoring. Magic
Context alone decides when normal product sessions are under sufficient context
pressure to run it. The Historian has no tools, browser surface, Game surface,
Host Memory API, or system `pi` CLI path. Output contains only counts and gate
state, never
model text or credentials. A failure is a bounded non-zero exit and does not
change product configuration.
