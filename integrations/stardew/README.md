# GameBuddy Stardew integration

This is a **Phase 1/2 local split-screen Farmhand Embodiment and bridge spike**. One Stardew process runs the human host and native local-co-op Farmhand. GameBuddy binds only the configured Farmhand's real screen-local `Game1.player`; it never constructs a `Farmer`, mutates `Game1.otherFarmers`, controls a remote player, exposes a network listener, teleports the actor, or claims a shadow actor is a Farmhand.

The included `StardewBodyController` is a deliberately narrow local movement fixture. It accepts a bounded target tile from `ExecutionManager`, maintains single movement ownership, atomically invalidates a superseded directive before starting a replacement, records accepted/running/progress/blocked/terminal traces with route revision and local actor evidence, is cancellable locally, and stops on menu/event/movement-lock/deadline conditions. A stall gets exactly one alternate-axis local recovery attempt before a factual terminal failure. It is not general pathfinding, an Agent, or a player-facing Game Action surface.

For Phase 1 native-mechanics evidence, the local-only `gamebuddy_equip_tool_fixture <inventory-slot> <request-id>` fixture selects a Tool already owned by this Farmhand. It does not consume an item, stamina, time, or world resource; its receipt records the selected slot and authoritative before/after `CurrentTool`. It remains a development fixture—not an Agent-facing capability—until native multiplayer and action-level policy gates have passed.

`BridgeProtocol` and `BridgeSession` define a bounded, versioned, authenticated **game-thread-only** protocol façade. `LocalPipeBridge` is the selected opt-in Windows local transport candidate: it is a current-user-only named pipe, frames bounded UTF-8 JSON on background tasks, attaches every queue item to a connection generation, and lets `UpdateTicked` drain at most eight requests. It never calls Stardew APIs off the game thread. Authentication opens transport only; scope, player-enabled capability, deadline, idempotency, cancellation IDs, request shape, and game-state preconditions are revalidated by the Mod before an execution can reach `ExecutionManager`.

### Player action policy

`config.json` is the local, player-controlled source of Game Action authorization. `EnabledActions` is an allowlist; the default empty list exposes no Game Actions through the bridge. To let the Companion use the currently verified, cancellable local move action autonomously, set:

```json
"EnabledActions": ["move_to_tile"]
```

The Mod reports this as a live capability in `hello_ack` and snapshots. The Host only mounts the corresponding tool while that capability remains declared; it never mints a token, interprets model text as permission, or enables an action itself. Disabling the action (or any current Mod/world precondition failing) prevents new executions. Local cancellation remains available regardless of the action allowlist.

Enable the bridge only in the local untracked `config.json` installed with the split-screen Mod; `config.example.json` documents the shape. `PlayerId` is the native local-co-op Farmhand's `UniqueMultiplayerID`, not the human host's ID. It needs opaque IDs and a 16+ character token; it never listens on LAN or the public network. A real Windows AI-Farmhand transport/reconnect test remains required before treating this candidate as accepted production IPC.

### Split-screen profile

The supported embodiment topology is one Stardew process using the game's official local split-screen co-op. `PerScreen<T>` isolates GameBuddy execution, ledger, bridge, and trace state per local screen. The configured `PlayerId` is the sole authority for selecting the AI Farmhand; no state is initialized or controlled on the human screen.

Split-screen uses a single Stardew process and global game audio mixer. GameBuddy must not change `startup_preferences`, persistent game volume, window settings, or input bindings to mute the AI screen: that would affect the human player and risks concurrent preference writes. The single Companion Host/Voice Gateway is the intentional player-audible voice output. There is no supported per-screen game-audio mute API.

Use a second local input device only to let the native Farmhand join through Stardew's UI. After it joins, keep human input ownership with the human screen; GameBuddy issues only bounded in-game actions for the configured Farmhand and never injects OS input or takes window focus.

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

## Manual Phase 1 gate (not automated)

A real Farmhand test requires one legitimate Stardew process, a host save with a vacant cabin, and a second local input device. Start the human save, use Stardew's official `Start Local Co-op` flow for the second local player, and configure GameBuddy with that native Farmhand's `UniqueMultiplayerID`. Load the shared save, then run the following only from the configured AI Farmhand screen's SMAPI console:

```text
gamebuddy_status
gamebuddy_move_fixture <nearby-x> <nearby-y> phase1_move_01
# Before the first route reaches its target, replace it with a new directive:
gamebuddy_move_fixture <other-nearby-x> <other-nearby-y> phase1_move_02
gamebuddy_equip_tool_fixture <tool-slot> phase1_equip_01
gamebuddy_cancel
gamebuddy_trace
```

Capture the log showing `bound configured AI Farmhand only`, the Farmhand multiplayer ID and `screen_id`, plus the JSON emitted by `gamebuddy_trace`. Verify that replacement records a terminal `superseded_by_new_directive` receipt before the new request's distinct route revision, then compare the trace and native tool before/after receipt to the matching human-screen-visible result. Exercise replacement, bounded blockage recovery, menu/warp invalidation, saving/cutover, local-co-op reconnect, and the native tool fixture in the dedicated test save. This manual evidence is required before declaring Phase 1 accepted; a single-screen compile/smoke, a shadow `Farmer`, or a bridge fixture is not a substitute.
