# GameBuddy Stardew integration

This is a **Phase 0A lifecycle-only SMAPI scaffold**. It intentionally contains no Companion Actor, Body Controller, bridge, network listener, Game Action, world mutation, or tick-driven behavior.

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

Do not commit a game installation path, game DLLs, SMAPI binaries, or generated mod output. CI restores the locked NuGet package and validates the manifest/lifecycle-only source shape; it cannot compile against proprietary game assemblies without a licensed installation.
