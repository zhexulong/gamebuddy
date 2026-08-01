# GameBuddy Stardew integration

This directory contains the formal Stardew Attachment / Provisioning slice plus an earlier local split-screen Farmhand Embodiment and bridge fixture. The split-screen code is retained as historical development material and is **not** the formal product topology or Phase 1 acceptance path.

The formal topology is an independent Stardew AI client joining the human host through a version-locked, non-UI Farmhand Provisioning path. `HostFarmhandProvisioner` publishes a signed live advertisement, accepts only a signed request made after App confirmation, creates a native Farmhand through `Cabin.CreateFarmhand()`, persists the Companion/save/world/cabin/native-ID binding in save data, and issues a signed short-lived manifest. `StardewAttachmentFlow` is the App-owned discovery/confirmation/file exchange boundary; it has no Agent tool and never accepts endpoint or Farmhand ID from model text. The client `FarmhandProvisioner` validates the manifest, exact ID, target game/protocol/integration versions, expiry, signature and save/world scope before reusing the native LAN client. It reaches Embodiment only after `readyToPlay` and local `Game1.player` identity match. Neither side drives Stardew UI, injects OS input, constructs a fake `Farmer`, mutates `Game1.otherFarmers`, controls a remote player, exposes a public network listener, teleports the actor, or claims a shadow actor is a Farmhand.

The fixture below must not be used as evidence that the independent-client path is implemented.

The included `StardewBodyController` is a deliberately narrow local movement fixture. It accepts a bounded target tile from `ExecutionManager`, maintains single movement ownership, atomically invalidates a superseded directive before starting a replacement, records accepted/running/progress/blocked/terminal traces with route revision and local actor evidence, is cancellable locally, and stops on menu/event/movement-lock/deadline conditions. A stall gets exactly one alternate-axis local recovery attempt before a factual terminal failure. It is not general pathfinding, an Agent, or a player-facing Game Action surface.

For Phase 1 native-mechanics evidence, `equip_tool` is now available through the formal AI-client named-pipe bridge when the player explicitly enables it in `EnabledActions`. It selects a Tool already owned by this Farmhand, does not consume an item, stamina, time, or world resource, and returns authoritative before/expected/after `CurrentTool` evidence. The verified live smoke uses `tools/run-stardew-equip-tool-smoke.mjs`; it is a single capability proof, not evidence that movement, resource-changing actions, multi-step execution, or Agent planning are complete. The older `gamebuddy_equip_tool_fixture <inventory-slot> <request-id>` console command remains a local diagnostic fixture only.

`BridgeProtocol` and `BridgeSession` define a bounded, versioned, authenticated **game-thread-only** protocol façade. `LocalPipeBridge` is the selected opt-in Windows local transport candidate: it is a current-user-only named pipe, frames bounded UTF-8 JSON on background tasks, attaches every queue item to a connection generation, and lets `UpdateTicked` drain at most eight requests. It never calls Stardew APIs off the game thread. Authentication opens transport only; scope, player-enabled capability, deadline, idempotency, cancellation IDs, request shape, and game-state preconditions are revalidated by the Mod before an execution can reach `ExecutionManager`.

### Player action policy

`config.json` is the local, player-controlled source of Game Action authorization. `EnabledActions` is an allowlist; the default empty list exposes no Game Actions through the bridge. To let the Companion use the currently verified local actions, set an explicit player allowlist. For example:

```json
"EnabledActions": ["move_to_tile", "equip_tool"]
```

`equip_tool` only selects a Tool already owned in the AI Farmhand's inventory. The Mod returns authoritative before/expected/after `CurrentTool` evidence and does not consume a resource. An empty list exposes no Game Actions.

The Mod reports this as a live capability in `hello_ack` and snapshots. The Host only mounts the corresponding tool while that capability remains declared; it never mints a token, interprets model text as permission, or enables an action itself. Disabling the action (or any current Mod/world precondition failing) prevents new executions. Local cancellation remains available regardless of the action allowlist.

Enable the bridge only in the local untracked `config.json` installed with the AI-client Integration Mod; `config.example.json` documents the shape. `PlayerId` is the native independent-client Farmhand's `UniqueMultiplayerID`, not the human host's ID. It needs opaque IDs and a 16+ character token; it never listens on LAN or the public network. A real Windows AI-Farmhand transport/reconnect test remains required before treating this candidate as accepted production IPC.

### Legacy split-screen fixture

The code below uses one Stardew process and `PerScreen<T>` because it predates the formal independent-client topology. It is not a supported product attachment flow, and its screen-local state must not be reused as the formal AI-client state model. The formal Integration uses per-client state and native Farmhand identity after non-UI provisioning.

The old local input-device instruction is retained only for historical reproduction. The formal product path must not require it: the App Attachment Flow and host/client Provisioning adapters handle session selection and native attachment without driving Stardew UI or injecting OS input.

## Local compilation

The official SMAPI build configuration compiles against the game's proprietary assemblies. A developer with a local Stardew Valley + SMAPI installation can provide its path outside Git using a `stardewvalley.targets` file in their user profile:

```xml
<Project>
  <PropertyGroup>
    <GamePath>C:\path\to\Stardew Valley</GamePath>
  </PropertyGroup>
</Project>
```

Then run:

```powershell
dotnet build GameBuddy.sln --configuration Release
```

Do not commit a game installation path, game DLLs, SMAPI binaries, generated mod output, Steam credentials, invitation codes, account IDs, or save files. CI restores the locked NuGet package and validates the fail-closed local-embodiment source shape; it cannot compile against proprietary game assemblies without a licensed installation.

## Formal Attachment Flow

Configure separate host and AI-client Mod profiles with the same local session directory and session token, and the locked `1.6.15` game version. The Host generates a fresh session nonce on every process start; the App and AI client must consume that current signed advertisement rather than reuse a configured nonce. The host profile must list the authorized opaque Companion ID. With a real host save loaded and the host LAN server ready, the App reads and verifies `stardew-session.json`, displays the host scope and cabin facts, and asks the player to confirm the selected Companion/cabin. Only after confirmation it writes a signed `stardew-attachment-request.json`; the Host Mod consumes it on the game thread, creates or reuses the exact native Farmhand binding, persists the binding through the game's save data, and writes `stardew-farmhand-manifest.json`. Copying or editing a manifest, endpoint, Farmhand ID, scope, or action policy is rejected.

The AI-client Mod reads that manifest from its local profile and starts the native LAN adapter. Its bridge remains closed until `readyToPlay`, exact `Game1.player.UniqueMultiplayerID`, manifest save/world scope, and target-version checks all pass. The diagnostic `FarmhandProvisioningProbe` remains available only as a separately opt-in version-locked regression fixture. The local target-version regression has passed the non-UI attachment/reconnect/Host-restart hard scenarios, and the formal named-pipe bridge has passed one `equip_tool` action with native before/expected/after evidence. This does not cover day transition, resource-changing actions, movement, multi-step execution, Agent planning, or complete release BDD. Use `tools/check-stardew-phase1-prerequisites.ps1 -GamePath <path> -AiClientModConfigPath <path> -SessionDirectory <absolute-path> -ExpectedFarmhandId <native-id>` to report the environment gate.

## Legacy fixture gate (not formal attachment)

The old local split-screen fixture requires one legitimate Stardew process and a second local input device. Start the human save, use Stardew's official `Start Local Co-op` flow for the second local player, then run `gamebuddy_farmhands` in the SMAPI console. Copy the intended native Farmhand's reported `player_id` into the local untracked `config.json` `PlayerId` field. Reload the shared save so GameBuddy can bind that screen, then run the following only from the configured AI Farmhand screen's SMAPI console:

```text
gamebuddy_farmhands
gamebuddy_status
gamebuddy_move_fixture <nearby-x> <nearby-y> phase1_move_01
# Before the first route reaches its target, replace it with a new directive:
gamebuddy_move_fixture <other-nearby-x> <other-nearby-y> phase1_move_02
gamebuddy_equip_tool_fixture <tool-slot> phase1_equip_01
gamebuddy_cancel
gamebuddy_trace
```

Capture the log showing `bound configured AI Farmhand only`, the Farmhand multiplayer ID and `screen_id`, plus the JSON emitted by `gamebuddy_trace`. Verify that replacement records a terminal `superseded_by_new_directive` receipt before the new request's distinct route revision, then compare the trace and native tool before/after receipt to the matching human-screen-visible result. Exercise replacement, bounded blockage recovery, menu/warp invalidation, saving/cutover, local-co-op reconnect, and the native tool fixture in the dedicated test save. This manual evidence is required before declaring Phase 1 accepted; a single-screen compile/smoke, a shadow `Farmer`, or a bridge fixture is not a substitute.
