# GameBuddy Stardew integration

This is a **Phase 1/2 client-local Embodiment and bridge spike**. It binds only the real native `Game1.player` owned by the Stardew process which loaded the Mod. It never constructs a `Farmer`, mutates `Game1.otherFarmers`, controls a remote player, exposes a network listener, teleports the actor, or claims a shadow actor is a Farmhand.

The included `StardewBodyController` is a deliberately narrow local movement fixture. It accepts a bounded target tile from `ExecutionManager`, maintains single movement ownership, atomically invalidates a superseded directive before starting a replacement, records accepted/running/progress/blocked/terminal traces with route revision and local actor evidence, is cancellable locally, and stops on menu/event/movement-lock/deadline conditions. A stall gets exactly one alternate-axis local recovery attempt before a factual terminal failure. It is not general pathfinding, an Agent, or a player-facing Game Action surface.

For Phase 1 native-mechanics evidence, the local-only `gamebuddy_equip_tool_fixture <inventory-slot> <request-id>` fixture selects a Tool already owned by this Farmhand. It does not consume an item, stamina, time, or world resource; its receipt records the selected slot and authoritative before/after `CurrentTool`. It remains a development fixture—not an Agent-facing capability—until native multiplayer and action-level policy gates have passed.

`BridgeProtocol` and `BridgeSession` define a bounded, versioned, authenticated **game-thread-only** protocol façade. `LocalPipeBridge` is the selected opt-in Windows local transport candidate: it is a current-user-only named pipe, frames bounded UTF-8 JSON on background tasks, attaches every queue item to a connection generation, and lets `UpdateTicked` drain at most eight requests. It never calls Stardew APIs off the game thread. Authentication, scope, deadline, permission token, idempotency, cancellation IDs, and request shape are revalidated by the Mod before an execution can reach `ExecutionManager`.

Enable it only in the local untracked `config.json` installed with the AI-client Mod; `config.example.json` documents the shape. It needs opaque IDs and a 16+ character token; it never listens on LAN or the public network. A real Windows AI-Farmhand transport/reconnect test remains required before treating this candidate as accepted production IPC.

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

A real Farmhand test requires two separately authenticated, legitimately licensed Stardew clients and a host save with a vacant cabin. Start the human host and join the second client through Stardew's normal multiplayer flow. Install this Mod on the **AI client**, load the shared save, then use SMAPI's console:

```text
gamebuddy_status
gamebuddy_move_fixture <nearby-x> <nearby-y> phase1_move_01
gamebuddy_equip_tool_fixture <tool-slot> phase1_equip_01
gamebuddy_cancel
```

Capture the AI-client log showing `bound only local Game1.player`, the Farmhand multiplayer ID, directive/route/body execution trace, and matching host-visible result. Exercise replacement, bounded blockage recovery, menu/warp invalidation, saving/cutover, reconnect, and the native tool fixture in the dedicated test save. This manual evidence is required before declaring Phase 1 accepted; a single-client compile/smoke, a shadow `Farmer`, or a bridge fixture is not a substitute.
