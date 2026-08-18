# Stardew checked projection-contract executables

These are explicit console contract-test executables, not automatically discovered unit-test-framework projects. Both projects are included in `GameBuddy.sln`; therefore a solution build compiles each executable and cannot silently omit either checked projection.

Run the supported compile-and-execute command from the repository root:

```powershell
powershell -ExecutionPolicy Bypass -File integrations/stardew/tests/Run-ProjectionContractTests.ps1
```

For Release configuration:

```powershell
powershell -ExecutionPolicy Bypass -File integrations/stardew/tests/Run-ProjectionContractTests.ps1 -Configuration Release
```

The script:

1. runs `dotnet build GameBuddy.sln --configuration <Configuration>`;
2. calculates SHA-256 from the just-built `GameBuddy.Stardew.dll`;
3. runs `PortfolioMineElevatorProjection.Contract --expected-sha256 <digest> <path>`, including compiled-IL verification of the Mine Ladder runtime composition (typed construction, watchdog/active-disconnect, four inbound handlers, BridgeSession calls, and terminal drain); and
4. runs `FarmhandActionCapabilityProjection.Contract --expected-sha256 <digest> <path>` against that same DLL.

The executables require an externally supplied 64-lowercase-hex expected SHA-256 and production assembly path. They capture the caller-selected file once into a private snapshot, verify the supplied digest against that snapshot before metadata inspection or type loading, and use independent snapshot streams for metadata validation and loading; the byte-altered-file characterization independently captures the canonical snapshot, appends a byte, and proves rejection before metadata/load. This binds the process-runner to its private verified snapshot of caller-selected bytes. It does not establish independent provenance, signing, path immutability, or live proof.

The farmhand executable requires the production assembly because it validates the compiled projection using metadata and IL. For direct use, build the project and invoke its explicit compiled entrypoint with a production DLL path:

```powershell
dotnet build integrations/stardew/tests/FarmhandActionCapabilityProjection.Contract.csproj -p:GamePath=$env:GAMEBUDDY_STARDEW_GAME_PATH
$assembly = 'integrations/stardew/bin/Debug/net6.0/GameBuddy.Stardew.dll'
$digest = (Get-FileHash -LiteralPath $assembly -Algorithm SHA256).Hash.ToLowerInvariant()
dotnet integrations/stardew/tests/bin/Debug/net6.0/FarmhandActionCapabilityProjection.Contract.dll --expected-sha256 $digest $assembly
```
