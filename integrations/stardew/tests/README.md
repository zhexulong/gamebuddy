## Two kinds of test in `GameBuddy.Stardew.Integration.Tests`

**A source-shape pin is a test whose body reads a repository file (`File.ReadAllText`/`ReadAllLines`/`ReadAllBytes`) and asserts on its text (`Should().Contain`/`NotContain`) instead of constructing and calling product code.** Its opposite, a behaviour test, builds the real objects and calls them.

Every file in this project is classified on every run by reading its contents, so the counts live in the gate's output rather than in this paragraph - a number written here is a measurement that goes stale on the next commit, and that is the same defect as a pin that follows the code it pins.

| Kind | Meaning |
| --- | --- |
| shape-only | every test is a source-shape pin |
| mixed | some pins, some behaviour tests |
| behaviour-only | no pins |
| ambiguous | a pin whose assertion is inside a custom helper the definition cannot see through; the gate lists it and leaves the file alone |
| no tests | a file the runner does not collect a test from |

```powershell
node tools/audit-stardew-test-shape.mjs          # the current counts, then any findings
```

The trait is `[Trait("kind", "source-shape")]`, and it is on shape-only classes **only**. A mixed file does not get it: the trait would tell a reader - and `--filter` - that the whole class pins text, when half of it exercises behaviour. Mixed files say so in a `// MIXED SHAPE AND BEHAVIOUR:` comment above the class instead. Shape-only files are named `<Subject>SourceShapeTests.cs`, so the file name carries the same fact the trait does.

Run only the behaviour tests:

```powershell
dotnet test integrations/stardew/tests/GameBuddy.Stardew.Integration.Tests --filter kind!=source-shape
```

Run only the pins:

```powershell
dotnet test integrations/stardew/tests/GameBuddy.Stardew.Integration.Tests --filter kind=source-shape
```

### Why a pin exists at all

The game assembly cannot load on a CI runner: the Mod's tests need a real Stardew Valley install, and a headless runner has no `Game1`, no player and no live location. A pin therefore asserts *which native members an action writes, and that no menu path is driven*, by reading the Mod's own source. That is weaker than exercising the behaviour, and it is the strongest thing available without a game. **Do not convert a pin into an integration test, and do not reword its assertions to match new code** - a pin that follows the code it pins has stopped pinning anything.

### The gate

`tools/audit-stardew-test-shape.mjs` derives its population from file content on every run - never from a list - and fails when a file drifts:

- a shape-only file without the trait, or without the `SourceShapeTests.cs` suffix;
- a behaviour-only or mixed file carrying the trait;
- a mixed file with no `// MIXED SHAPE AND BEHAVIOUR:` line, or one too short to say why.

```powershell
node tools/audit-stardew-test-shape.mjs          # counts + findings
node tools/audit-stardew-test-shape.mjs --list   # every file with its kind
node tools/audit-stardew-test-shape.mjs --json   # the full report
```

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
3. runs `FarmhandActionCapabilityProjection.Contract --expected-sha256 <digest> <path>` against that same DLL.

The executables require an externally supplied 64-lowercase-hex expected SHA-256 and production assembly path. They capture the caller-selected file once into a private snapshot, verify the supplied digest against that snapshot before metadata inspection or type loading, and use independent snapshot streams for metadata validation and loading; the byte-altered-file characterization independently captures the canonical snapshot, appends a byte, and proves rejection before metadata/load. This binds the process-runner to its private verified snapshot of caller-selected bytes. It does not establish independent provenance, signing, path immutability, or live proof.

The farmhand executable requires the production assembly because it validates the compiled projection using metadata and IL. For direct use, build the project and invoke its explicit compiled entrypoint with a production DLL path:

```powershell
dotnet build integrations/stardew/tests/FarmhandActionCapabilityProjection.Contract.csproj -p:GamePath=$env:GAMEBUDDY_STARDEW_GAME_PATH
$assembly = 'integrations/stardew/bin/Debug/net6.0/GameBuddy.Stardew.dll'
$digest = (Get-FileHash -LiteralPath $assembly -Algorithm SHA256).Hash.ToLowerInvariant()
dotnet integrations/stardew/tests/bin/Debug/net6.0/FarmhandActionCapabilityProjection.Contract.dll --expected-sha256 $digest $assembly
```
