# GameBuddy Stardew integration

This is a **Phase 1 client-local Embodiment spike**. It binds only the real native `Game1.player` owned by the Stardew process which loaded the Mod. It never constructs a `Farmer`, mutates `Game1.otherFarmers`, controls a remote player, exposes a network listener, teleports the actor, or claims a shadow actor is a Farmhand.

The included `StardewBodyController` is a deliberately narrow local movement fixture. It accepts only a bounded target tile from `ExecutionManager`, maintains single movement ownership, records accepted/running/progress/blocked/terminal traces, is cancellable locally, and stops on menu/event/movement-lock/deadline conditions. It is not pathfinding, an Agent, or a player-facing Game Action surface.

`BridgeProtocol` and `BridgeSession` define a bounded, versioned, authenticated **game-thread-only** protocol façade. They deliberately do **not** listen on any network or pipe: Phase 2's production local IPC is still a transport decision requiring a real Windows AI-Farmhand client test. Any future I/O adapter must parse/frame on a background worker and enqueue validated requests to `BridgeSession` on `UpdateTicked`; it may not access Stardew APIs from its I/O thread.

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
gamebuddy_cancel
```

Capture the AI-client log showing `bound only local Game1.player`, the Farmhand multiplayer ID, execution trace, and matching host-visible result. This manual evidence is required before declaring Phase 1 accepted; a single-client compile/smoke, a shadow `Farmer`, or a bridge fixture is not a substitute.
