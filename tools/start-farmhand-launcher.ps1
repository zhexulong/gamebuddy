[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)] [string]$GamePath,
    [Parameter(Mandatory = $true)] [string]$ExpectedFarmhandId,
    [Parameter(Mandatory = $true)] [string]$HostRuntimeRoot,
    # The companion language the fixture requires. Bounded BCP-47, not a closed pair: the
  # language is the player's choice and the Host's preference store accepts any tag.
  [ValidatePattern('^[A-Za-z]{2,8}(-[A-Za-z0-9]{2,16}){0,3}$')] [string]$PresentationLocale = "zh-CN",
    [ValidateRange(10, 300)] [int]$StartupTimeoutSeconds = 90,
    # The Mod reads only GAMEBUDDY_WINDOW_MODE in the child environment, and the
    # exact mode (plus validation authority) comes from the single shared
    # window-mode contract in tools/lib/stardew-live-run.mjs. See
    # Resolve-LiveRunWindowMode below; no window-mode vocabulary is re-declared
    # here.
    #
    # Each role is configurable separately. The host role is the human's window
    # and stays visible by default; the AI-client role is the silent farmhand
    # and defaults to the non-activating `background` shape. `hidden`/`background`
    # map to SW_HIDE -- an unattended-run choice; an operator can override each
    # role independently without ever hiding the window they must watch by
    # default.
    [string]$HostWindowMode = "visible",
    [string]$FarmhandWindowMode = "background",
    # The preview contract requires the companion continuity id (it partitions
    # Memory and the runtime identity), but the attachment manifest does not
    # carry one. The ladder runners already use GAMEBUDDY_COMPANION_CONTINUITY_ID
    # as the convention, so the launcher accepts the same value; a run without it
    # fails closed instead of inventing an identity.
    [string]$CompanionContinuityId = "",
    [switch]$RequireActiveStopProof
)

# The only Farmhand Companion Preview launcher. It intentionally owns the
# one-run bridge, transaction, child processes, and cleanup; callers cannot
# supply a pipe, token, manifest, action policy, or credential.
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Test-WindowsAbsolutePath([string]$Value) {
    # Windows PowerShell 5.1/.NET Framework lacks the newer full-path helper.
    # Accept only a drive-qualified path or a fully qualified UNC share; reject
    # rooted-relative paths such as \mods and all relative paths.
    return $Value -match '^[A-Za-z]:[\\/]' -or $Value -match '^\\\\[^\\/]+[\\/][^\\/]+'
}
function Assert-AbsoluteDirectory([string]$Value, [string]$Name) {
    if (-not (Test-WindowsAbsolutePath $Value) -or -not (Test-Path -LiteralPath $Value -PathType Container)) {
        throw "invalid_$Name"
    }
}
function Resolve-LiveRunWindowMode([string]$Value) {
    # Validation passes through the single shared window-mode authority in
    # tools/lib/stardew-live-run.mjs (frozen 5-mode mirror of
    # host/src/live-run/window-mode.ts); no vocabulary is re-declared here.
    $windowModeJson = & node $PSScriptRoot\lib\stardew-live-run.mjs --print-map 2>$null
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($windowModeJson)) { throw "live_run_window_mode_unavailable" }
    $windowModeNames = @(($windowModeJson | ConvertFrom-Json).windowModes.PSObject.Properties.Name)
    # Exact, case-sensitive member test: PowerShell's -in/-contains are
    # case-insensitive, and an upcased mode must not quietly pass this gate.
    if ($Value -cnotin $windowModeNames) { throw "invalid_live_run_window_mode:$Value" }
}
function Invoke-NodeQuiet([string[]]$Arguments, [string]$FailureCode) {
    # Native stderr must never become a terminating PowerShell error under
    # Windows PowerShell 5.1, but an operator still needs the stable typed
    # reason when a fixture helper fails. Capture it in this caller's private
    # scope, extract only the first matching allowlisted code, then discard it.
    $privateOutputPath = Join-Path ([IO.Path]::GetTempPath()) ("gamebuddy-node-" + [guid]::NewGuid().ToString("N") + ".stdout")
    $privateErrorPath = Join-Path ([IO.Path]::GetTempPath()) ("gamebuddy-node-" + [guid]::NewGuid().ToString("N") + ".stderr")
    try {
        # Start-Process avoids Windows PowerShell 5.1 promoting any native
        # stderr line to NativeCommandError before this function can reduce it.
        # Start-Process has no argv-array overload: splatting a [string[]]
        # passes it as one escaped command-line token. Quote its bounded trusted
        # arguments as an explicit command line; this preserves normal Windows
        # profile paths containing spaces without admitting player text or bridge
        # credentials into the helper invocation surface.
        $commandLine = [string]::Join(" ", @($Arguments | ForEach-Object { '"' + $_.Replace('"', '\"') + '"' }))
        $process = Start-Process -FilePath "node.exe" -ArgumentList $commandLine -NoNewWindow -Wait -PassThru -RedirectStandardOutput $privateOutputPath -RedirectStandardError $privateErrorPath
        if ($process.ExitCode -eq 0) { return }
        $raw = if (Test-Path -LiteralPath $privateErrorPath -PathType Leaf) { [IO.File]::ReadAllText($privateErrorPath) } else { "" }
        $match = [regex]::Match($raw, '\b(stardew_[a-z0-9_]+|fixture_[a-z0-9_]+|invalid_[a-z0-9_]+|attachment_[a-z0-9_]+|ENOENT)(:[A-Za-z0-9_.-]{1,96})?')
        $detail = if ($match.Success) { $match.Groups[0].Value } else { Get-BoundedFailureDetail $raw }
        throw ("{0}:{1}" -f $FailureCode, $detail)
    } finally {
        Remove-Item -LiteralPath $privateOutputPath, $privateErrorPath -Force -ErrorAction SilentlyContinue
    }
}
function Get-BoundedFailureDetail([string]$Raw) {
    # A helper that fails without a recognisable allowlisted code used to report
    # the bare word `unavailable`, which names nothing (measured 2026-10-05:
    # `fresh_attachment_manifest_failed:unavailable` cost a diagnosis cycle with
    # no way to see why). Surface the first USABLE stderr line instead, still
    # under the private-output rule: no path-shaped or URL-shaped text, no stack
    # frame, whitespace collapsed, bounded to 200 characters.
    foreach ($line in ($Raw -split "`r?`n")) {
        $trimmed = $line.Trim()
        if ($trimmed.Length -eq 0) { continue }
        if ($trimmed -match '[\\/]') { continue }
        if ($trimmed -match '^at\s' -or $trimmed -match 'node:internal') { continue }
        $collapsed = ($trimmed -replace '\s+', ' ')
        if ($collapsed.Length -gt 200) { $collapsed = $collapsed.Substring(0, 200) }
        return $collapsed
    }
    return "unavailable"
}
function Test-NamedPipeExists([string]$Name) {
    # Read-only presence check. The preview remains the only AUTHENTICATED readiness
    # authority; this only answers "has the other end created its pipe yet".
    if ([string]::IsNullOrWhiteSpace($Name)) { return $false }
    try { return [System.IO.Directory]::GetFiles("\\.\pipe\") -contains ("\\.\pipe\" + $Name) } catch { return $false }
}
function Get-BoundedLogDiagnostics([string]$Path, [int]$MaxLines = 5) {
    # Bounded, reason-carrying diagnostics from one game instance's captured console
    # log. Under the same privacy rule as Get-BoundedFailureDetail: no path-shaped or
    # URL-shaped text, no stack frames, whitespace collapsed, 200 characters.
    if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) { return @() }
    try { $content = Get-Content -LiteralPath $Path -Raw -ErrorAction Stop } catch { return @() }
    $preferred = New-Object System.Collections.Generic.List[string]
    $other = New-Object System.Collections.Generic.List[string]
    $scanned = 0
    foreach ($line in ($content -split "`r?`n")) {
        if ($scanned -ge 4000) { break }
        $scanned++
        $trimmed = $line.Trim()
        if ($trimmed.Length -eq 0) { continue }
        if ($trimmed -match '[\\/]') { continue }
        if ($trimmed -match '^at\s' -or $trimmed -match 'node:internal') { continue }
        $collapsed = ($trimmed -replace '\s+', ' ')
        if ($collapsed.Length -gt 200) { $collapsed = $collapsed.Substring(0, 200) }
        if ($collapsed -match 'GameBuddy') {
            if (-not $preferred.Contains($collapsed)) { $preferred.Add($collapsed) }
        } elseif (-not $other.Contains($collapsed)) { $other.Add($collapsed) }
    }
    # Our own Mod's lines are the ones that name a reason; fall back to the tail.
    $pool = if ($preferred.Count -gt 0) { $preferred } else { $other }
    $count = [Math]::Min($MaxLines, $pool.Count)
    return @($pool[$pool.Count - $count..($pool.Count - 1)])
}
function Stop-OwnedProcess($Process) {
    if ($null -eq $Process) { return }
    $Process.Refresh()
    if ($Process.HasExited) { return }
    # Tolerate the expected race: taskkill reports "could not be terminated" while a
    # descendant is already exiting, and under $ErrorActionPreference = "Stop" that
    # native stderr becomes a terminating error which aborts cleanup and replaces
    # the run's real failure (measured 2026-10-06: the actual stop was lost this
    # way). It kills only this launcher-owned process tree - never an unrelated
    # existing game process after the preflight guard. This call's diagnostic text
    # stays private; the bounded HasExited check below decides, and a real failure
    # still throws owned_process_stop_timeout.
    try { $null = & "$env:SystemRoot\System32\taskkill.exe" /PID $Process.Id /T /F 2>&1 } catch { }
    $Process.Refresh()
    if (-not $Process.HasExited) {
        $Process.WaitForExit(10000) | Out-Null
        $Process.Refresh()
    }
    if (-not $Process.HasExited) { throw "owned_process_stop_timeout" }
}
function Assert-NoGameProcesses {
    $names = @("StardewModdingAPI", "Stardew Valley", "StardewValley")
    foreach ($name in $names) {
        if (@(Get-Process -Name $name -ErrorAction SilentlyContinue).Count -gt 0) { throw "fixture_game_processes_running" }
    }
}
function Assert-PresentationStartupPreference([string]$RequiredLocale) {
    # Both transaction-owned clients run as this Windows user and Stardew reads
    # this native preference before its first window/font initialization. The
    # subsequent fixture readiness receipt proves the exact game-thread locale.
    $expectedLanguageCode = if ($RequiredLocale -eq "zh-CN") { "zh" } elseif ($RequiredLocale -eq "en-US") { "en" } else { throw "invalid_presentation_locale" }
    $preferencesPath = Join-Path $env:APPDATA "StardewValley\startup_preferences"
    if (-not (Test-Path -LiteralPath $preferencesPath -PathType Leaf)) { throw "live_locale_required" }
    try {
        [xml]$preferences = [IO.File]::ReadAllText($preferencesPath)
        if ($preferences.StartupPreferences.languageCode -ne $expectedLanguageCode) { throw "live_locale_required" }
    } catch {
        if ($_.Exception.Message -eq "live_locale_required") { throw }
        throw "live_locale_required"
    }
}
function Initialize-PrivateRunRoot([string]$Path) {
    New-Item -ItemType Directory -Path $Path -Force | Out-Null
    $item = Get-Item -LiteralPath $Path -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "preview_run_root_reparse_forbidden" }
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    if ($null -eq $sid) { throw "preview_run_root_current_user_unavailable" }
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $acl.SetAccessRuleProtection($true, $false)
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
        $sid,
        [Security.AccessControl.FileSystemRights]::FullControl,
        [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit,
        [Security.AccessControl.PropagationFlags]::None,
        [Security.AccessControl.AccessControlType]::Allow
    ))
    [IO.Directory]::SetAccessControl($Path, $acl)
    # Use the .NET API directly: this process can run under Windows PowerShell
    # 5.1 where Microsoft.PowerShell.Security may fail to autoload after a
    # PowerShell 7 type-data installation.
    $rules = @(([IO.Directory]::GetAccessControl($Path)).GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
    if ($rules.Count -ne 1 -or $rules[0].IsInherited -or $rules[0].IdentityReference.Value -ne $sid.Value -or $rules[0].AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or (($rules[0].FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -ne [Security.AccessControl.FileSystemRights]::FullControl)) { throw "preview_run_root_private_acl_failed" }
}
function Write-PrivateJson([string]$Path, [object]$Value) {    [IO.File]::WriteAllText($Path, ($Value | ConvertTo-Json -Depth 5 -Compress), [Text.UTF8Encoding]::new($false))
}
function Clear-RunSessionExchange([string]$Directory) {
    foreach ($name in @("stardew-session.json", "stardew-attachment-request.json", "stardew-attachment-response.json", "stardew-farmhand-manifest.json", "stardew-fixture-readiness.json")) {
        Remove-Item -LiteralPath (Join-Path $Directory $name) -Force -ErrorAction SilentlyContinue
    }
}
function Test-ActiveStopProofSignal([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
    try {
        $content = Get-Content -LiteralPath $Path -Raw -ErrorAction Stop
        return @($content -split "`r?`n" | Where-Object { $_ -eq "active_stop_proof_verified" }).Count -eq 1
    } catch [IO.IOException] {
        return $false
    }
}
# ---------------------------------------------------------------------------
# Launcher phase timing.
#
# The operator question "how long until the companion can exchange text" is not
# answerable with one stopwatch over the whole run: the host's fixture
# readiness, the signed attachment manifest, the AI client's boot and the
# Preview's readiness are four different costs with four different owners. These
# bounded one-line records name each one, and the final summary is one line of
# JSON. Only phase names and elapsed milliseconds are printed - never a path,
# token, or child output (see the private-output rules above).
# ---------------------------------------------------------------------------
$launcherStopwatch = [System.Diagnostics.Stopwatch]::StartNew()
$launcherPhases = [System.Collections.Generic.List[object]]::new()
function Write-LauncherPhase([string]$Phase) {
    $elapsedMs = $launcherStopwatch.ElapsedMilliseconds
    $launcherPhases.Add([pscustomobject]@{ phase = $Phase; elapsedMs = $elapsedMs })
    Write-Output ("[launcher-phase] {0} @ {1}ms" -f $Phase, $elapsedMs)
}
function Write-LauncherTiming() {
    $payload = @{
        schemaVersion = 1
        totalMs = $launcherStopwatch.ElapsedMilliseconds
        phases = @($launcherPhases)
    }
    Write-Output ("[launcher-timing] " + ($payload | ConvertTo-Json -Compress -Depth 4))
}

function Test-PreviewReadySignal([string]$Path) {
    # The immutable Preview writes this fixed redacted line only after its
    # receipt-backed snapshot admission and runtime installation. stdout is a
    # transaction-private launcher log, never user-visible or persisted after
    # teardown; accept no partial or decorated marker. Read via a permissive
    # FileShare mode: the launcher owns this log but the live child owns its
    # write handle on Windows.
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
    try {
        # `Start-Process -RedirectStandardOutput` holds the parent pipe/log
        # open in a way that can reject an ordinary second FileStream. Windows
        # PowerShell's Get-Content shares that redirected handle correctly;
        # read only the complete fixed marker and accept no decorated output.
        $content = Get-Content -LiteralPath $Path -Raw -ErrorAction Stop
        return @($content -split "`r?`n" | Where-Object { $_ -eq "farmhand_companion_preview_ready" }).Count -eq 1
    } catch [IO.IOException] {
        return $false
    }
}
function Get-PreviewIngressStages([string]$Path) {
    # Preserve only the predefined, content-free Host-side ingress phases in
    # the launcher completion record. Raw Preview output can contain runtime
    # details and is deleted with this transaction's private run root.
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return @() }
    $allowed = @(
        "native_chat_pipe_data_received:received",
        "native_chat_bridge_inbound_frame_received:received",
        "native_chat_bridge_player_control_validated:accepted",
        "native_chat_adapter_fact_forwarded",
        "ai_player_control_host_accepted",
        "ai_player_control_pipe_reader_ended",
        "ai_player_control_pipe_writer_ended",
        "player_input_accepted",
        "player_input_enqueued",
        "native_chat_bridge_inbound_rejected:malformed_player_control",
        "native_chat_bridge_inbound_rejected:scope_mismatch:integrationId",
        "native_chat_bridge_inbound_rejected:scope_mismatch:saveId",
        "native_chat_bridge_inbound_rejected:scope_mismatch:worldId",
        "native_chat_bridge_inbound_rejected:scope_mismatch:playerId",
        "native_chat_bridge_inbound_rejected:scope_mismatch:companionId",
        "native_chat_bridge_inbound_rejected:stale_or_invalid_timestamp"
    )
    try {
        return @(Get-Content -LiteralPath $Path -ErrorAction Stop | ForEach-Object {
            $match = [regex]::Match($_, '^GameBuddy native chat ingress stage=([A-Za-z0-9_:]+)$')
            if ($match.Success -and $match.Groups[1].Value -in $allowed) { $match.Groups[1].Value }
        } | Select-Object -Unique)
    } catch [IO.IOException] {
        return @()
    }
}

function Get-PreviewFailureCode([string]$Path) {
    # Preview stderr may contain config and bridge details. Publish only a
    # known typed Error code; never retain or echo the raw child output.
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return "preview_failure_code_unavailable" }
    # The redirect writer (the child, or the handle Start-Process handed it) can
    # still hold the log open just after exit, and ReadAllText opens exclusively.
    # Measured 2026-10-05/06: one run died with an IOException, and the retry then
    # reported `preview_failure_code_unreadable` for every attempt, losing the real
    # reason. Get-Content -Raw is the launcher's redirect-compatible reader (see
    # Test-PreviewReadySignal); an unreadable log stays a code, never a crash.
    try { $content = Get-Content -LiteralPath $Path -Raw -ErrorAction Stop } catch { return "preview_failure_code_unreadable" }
    $match = [regex]::Match($content, '(?m)\b(farmhand_[a-z0-9_]+|invalid_farmhand_companion_preview_config|stardew_[a-z0-9_]+|integration_[a-z0-9_]+|production_[a-z0-9_]+|bridge_[a-z0-9_]+|pipe_[a-z0-9_]+|unexpected_[a-z0-9_]+|ERR_[A-Z0-9_]+)(:[A-Za-z0-9_.-]{1,96})?')
    # Keep the bounded reason suffix: `bridge_disconnected:<reason>` names WHY the
    # bridge dropped, and truncating it at the colon reports the symptom only
    # (measured 2026-10-05 - the same truncation that hid a stale fixture lock for
    # three weeks).
    if ($match.Success) { return $match.Groups[0].Value }
    # An ENOENT message includes an absolute private runtime path. Its basename
    # is useful for diagnostics but the path itself may encode identity data.
    # Publish only an allowlisted filename and syscall; never echo the path.
    $missing = [regex]::Match($content, "(?m)Error: ENOENT: no such file or directory, (?<operation>[a-z]+) '[^']*[\\/](?<basename>[A-Za-z0-9._-]{1,128})'")
    $operationName = if ($missing.Success) { $missing.Groups["operation"].Value } else { "unknown" }
    if (-not $missing.Success) {
        # Node's structured diagnostic object uses `path: '...'` instead of
        # the headline wording above. Extract only the terminal basename.
        $missing = [regex]::Match($content, "(?m)^\s*path:\s*'[^']*[\\/](?<basename>[A-Za-z0-9._-]{1,128})'")
        $operation = [regex]::Match($content, "(?m)^\s*syscall:\s*'(?<operation>[a-z]+)'")
        if ($operation.Success) { $operationName = $operation.Groups["operation"].Value }
    }
    if ($missing.Success -and $missing.Groups["basename"].Value -in @("auth.json", "models.json", "models-store.json", "magic-context.jsonc", "identity-profile.json", "identity-profile-binding.json", "models-cache.json", "package.json", "index.js")) {
        return ("preview_enoent_" + $operationName + "_" + $missing.Groups["basename"].Value.Replace(".", "_"))
    }
    if ($content -match '(?m)\bENOENT\b') {
        # Named-pipe connect has no filesystem path. It is safe to identify by
        # syscall alone and is the sole transient condition the launcher may
        # retry while AI SMAPI completes its normal startup.
        if ($content -match "(?m)^\s*syscall:\s*'connect'") { return "preview_enoent_connect" }
        return "preview_enoent_unclassified"
    }
    return "preview_failure_code_unavailable"
}

if ($env:OS -ne "Windows_NT") { throw "windows_only" }
    # Caller-chosen per-role window modes are validated through the shared
    # single-authority contract before any process is launched, so this launcher
    # can never inject an unknown window shape into either game process.
    Resolve-LiveRunWindowMode $HostWindowMode
    Resolve-LiveRunWindowMode $FarmhandWindowMode
Assert-AbsoluteDirectory $GamePath "game_path"
# ModelProfileStore supplies the fixed Host-owned game default when its optional
# preference file is absent. Require only an existing absolute Host-owned root:
# do not synthesize or copy a profile (or any credential) into a Preview run.
Assert-AbsoluteDirectory $HostRuntimeRoot "host_runtime_root"
if ($ExpectedFarmhandId -notmatch "^[0-9]{6,20}$") { throw "invalid_expected_farmhand_id" }
$smapi = Join-Path $GamePath "StardewModdingAPI.exe"
if (-not (Test-Path -LiteralPath $smapi -PathType Leaf)) { throw "official_smapi_missing" }
if (-not $env:LOCALAPPDATA) { throw "localappdata_missing" }
Assert-NoGameProcesses

# Build the exact Release Mod DLL from the current source before a transaction
# can copy it into either fixture profile. Incremental outputs cannot stand in
# for a source-current live artifact at this gate. Do not rebuild the root
# solution here: it includes independent contract projects that are not part of
# the DLL projected into this Farmhand transaction.
$repositoryRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$stardewProject = Join-Path $repositoryRoot "integrations\stardew\GameBuddy.Stardew.csproj"
    & dotnet build $stardewProject --configuration Release --no-restore "-p:GamePath=$GamePath" -t:Rebuild
    if ($LASTEXITCODE -ne 0) { throw "stardew_release_rebuild_failed" }
    Write-LauncherPhase "modRebuilt"

# Both fixture roots come from the single shared resolver
# (tools/lib/stardew-fixture-roots.mjs); its defaults are the historical paths
# and GAMEBUDDY_STARDEW_PROFILE_ROOT / GAMEBUDDY_STARDEW_FIXTURE_ROOT point one
# concurrent lane at private roots. This is the launcher's one deliberately
# path-bearing line: an operator must see which profile root this run holds, or
# it cannot tell that two lanes are still sharing one transaction.
$fixtureRootsJson = & node $PSScriptRoot\lib\stardew-fixture-roots.mjs --print-json 2>$null
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($fixtureRootsJson)) { throw "stardew_fixture_roots_unavailable" }
$fixtureRoots = $fixtureRootsJson | ConvertFrom-Json
$fixtureRoot = [string]$fixtureRoots.profileRoot
$profilesRoot = [string]$fixtureRoots.profilesDir
Write-Output ("[stardew-fixture-roots] profileRoot={0} fixturesRoot={1}" -f $fixtureRoots.profileRoot, $fixtureRoots.fixturesRoot)
# Preview uses an allowlisted native locale selected by the launcher. The
# post-save-load fixture receipt below, not this preference, proves it applied.
Assert-PresentationStartupPreference $PresentationLocale
$hostModsPath = Join-Path $profilesRoot "A-host"
$aiModsPath = Join-Path $profilesRoot "A-ai-client"
$hostConfig = Join-Path $hostModsPath "GameBuddy\config.json"
$aiConfig = Join-Path $aiModsPath "GameBuddy\config.json"
foreach ($path in @($fixtureRoot, $hostModsPath, $aiModsPath)) { Assert-AbsoluteDirectory $path "fixture_path" }
foreach ($path in @($hostConfig, $aiConfig)) { if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "fixture_config_missing" } }

# Preserve the established formal fixture scenario; Preview does not add a
# scenario, action setup, chat injection, capability, or policy input.
# The launcher preserves the existing formally configured fixture rather than
# silently substituting the generic profile helper default.
$originalHost = Get-Content -LiteralPath $hostConfig -Raw | ConvertFrom-Json
$scenario = [string]$originalHost.HostAutomation.FixtureScenario
$targetSave = [string]$originalHost.HostAutomation.SaveName
if ($scenario -notin @("native_animal_product_v2", "native_feed_animal_v1", "native_water_crop_v1", "native_fertilize_tile_v1", "native_plant_seed_v1", "native_till_soil_v1", "native_machine_inspect_v1", "native_npc_relationship_v1", "native_pickup_forage_v1", "native_pickup_item_v1", "native_use_item_v1", "native_harvest_crop_v1") -or $targetSave -notmatch "^GameBuddyFixture_[A-Za-z0-9_-]{1,96}$") { throw "fixture_config_invalid" }
$backupName = ("preview-" + [guid]::NewGuid().ToString("N") + "-fixture-backup")
$runRoot = Join-Path $fixtureRoot ("farmhand-companion-preview-" + [guid]::NewGuid().ToString("N"))
$overridePath = Join-Path $runRoot "bridge-override.json"
$previewConfigPath = Join-Path $runRoot "preview-config.json"
$evidencePath = Join-Path $runRoot "preview-evidence.jsonl"
$pipeName = "gamebuddy_preview_" + [guid]::NewGuid().ToString("N")
$tokenBytes = [byte[]]::new(32)
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try { $rng.GetBytes($tokenBytes) } finally { $rng.Dispose() }
$bridgeToken = [Convert]::ToBase64String($tokenBytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
$hostProcess = $null
$aiProcess = $null
$previewProcess = $null
$hostLaunchGeneration = $null
$aiLaunchGeneration = $null
$previousLaunchGenerationPresent = Test-Path Env:GAMEBUDDY_STARDEW_LAUNCH_GENERATION
$previousLaunchGeneration = if ($previousLaunchGenerationPresent) { $env:GAMEBUDDY_STARDEW_LAUNCH_GENERATION } else { $null }
# The finally block may run before the first Preview attempt; StrictMode needs
# both redirected-log paths to exist as explicit null values in that case.
$previewStdoutPath = $null
$previewStderrPath = $null
# Each game instance's console output is captured separately. Without this the two
# instances share one SMAPI-latest.txt, so the farmhand's own view of why it dropped
# a preview connection is invisible (measured 2026-10-06).
$hostStdoutPath = $null
$aiStdoutPath = $null
$sessionDirectory = $null
$prepared = $false
$nativeServerReadyAtUnixMs = 0
$ingressStages = @()

try {
    Initialize-PrivateRunRoot $runRoot
    # This transaction-owned marker makes the Host's signed fixture readiness
    # prove the post-save-load game-thread locale. The startup preference above
    # remains early preflight only and is never accepted as runtime evidence.
    Invoke-NodeQuiet @("tools/prepare-stardew-fixture-profile.mjs", "--scenario", $scenario, "--backup-name", $backupName, "--target-save", $targetSave, "--require-fixture-live-locale", $PresentationLocale) "fixture_prepare_failed"
    $prepared = $true
    $hostProfile = Get-Content -LiteralPath $hostConfig -Raw | ConvertFrom-Json
    $sessionDirectory = [string]$hostProfile.HostFarmhandProvisioning.SessionDirectory
    Assert-AbsoluteDirectory $sessionDirectory "fixture_session_directory"
    Clear-RunSessionExchange $sessionDirectory

    # Host must publish an authenticated readiness fact before any attachment
    # request. It starts alone; the AI client remains offline for manifest mint.
    # Start-Process joins ArgumentList tokens itself; quote absolute paths so a
    # normal Windows user profile containing spaces reaches SMAPI intact.
    # The Mod accepts Host provisioning only with a fresh launcher-owned
    # generation. Keep it in this process environment solely long enough for the
    # directly supervised child to inherit it; never write it to config, argv,
    # session exchange, or Preview state.
    $hostLaunchGeneration = [guid]::NewGuid().ToString("N")
    $env:GAMEBUDDY_STARDEW_LAUNCH_GENERATION = $hostLaunchGeneration
    # The host role is the human's window; carry its validated mode into only
    # this child, exactly like the launch-generation pattern below. Clear it
    # before the AI launch so neither role inherits the other's shape.
    $env:GAMEBUDDY_WINDOW_MODE = $HostWindowMode
    $hostStdoutPath = Join-Path $runRoot "host.stdout.log"
    $hostProcess = Start-Process -FilePath $smapi -ArgumentList @("--mods-path", ('"{0}"' -f $hostModsPath)) -WorkingDirectory $GamePath -RedirectStandardOutput $hostStdoutPath -RedirectStandardError (Join-Path $runRoot "host.stderr.log") -PassThru
    Write-LauncherPhase "hostLaunched"
    $notBefore = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    Invoke-NodeQuiet @("tools/await-stardew-fixture-readiness.mjs", "--session-directory", $sessionDirectory, "--host-config", $hostConfig, "--timeout-ms", ($StartupTimeoutSeconds * 1000), "--not-before-unix-ms", $notBefore) "host_fixture_readiness_failed"
    Write-LauncherPhase "hostReady"
    # Fixture readiness is published during the same game-thread update that
    # starts the LAN server. Give the next update a bounded five-second window
    # to publish the separately signed attachment advertisement before the
    # App begins its own strict read/confirm cycle; no credentials or status
    # from this delay are accepted as authority.
    Start-Sleep -Seconds 5
    # Current production attachment flow authenticates the live advertisement,
    # request, response, and manifest before the transaction gets any bridge data.
    Invoke-NodeQuiet @("tools/stardew-attachment-request.mjs", "--session-directory", $sessionDirectory, "--host-config", $hostConfig, "--expected-farmhand-id", $ExpectedFarmhandId, "--timeout-ms", ($StartupTimeoutSeconds * 1000)) "fresh_attachment_manifest_failed"
    Write-LauncherPhase "attachmentManifestMinted"
    $manifestPath = Join-Path $hostProfile.HostFarmhandProvisioning.SessionDirectory "stardew-farmhand-manifest.json"
    if (-not (Test-WindowsAbsolutePath $manifestPath) -or -not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw "fresh_attachment_manifest_missing" }
    $manifestBytes = [System.IO.File]::ReadAllBytes($manifestPath)
    $manifest = [System.Text.Encoding]::UTF8.GetString($manifestBytes) | ConvertFrom-Json
    $identityParts = @($manifest.saveId, $manifest.worldId, $manifest.companionId)
    $invalidManifestIdentity = @($identityParts | Where-Object { $_ -notmatch '^[A-Za-z0-9_-]{1,128}$' }).Count -gt 0
    if ($manifest.farmhandId -ne $ExpectedFarmhandId -or $manifest.expiresAtUnixMs -le [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -or $invalidManifestIdentity) { throw "fresh_attachment_manifest_invalid" }
    $override = @{ pipeName = $pipeName; bridgeToken = $bridgeToken; saveId = [string]$manifest.saveId; worldId = [string]$manifest.worldId; playerId = [string]$manifest.farmhandId; companionId = [string]$manifest.companionId }
    Write-PrivateJson $overridePath $override
    Invoke-NodeQuiet @("tools/apply-stardew-fixture-bridge-override.mjs", "--backup-name", $backupName, "--override-file", $overridePath) "fixture_bridge_override_failed"


    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try { $manifestSha256 = (-join ($sha256.ComputeHash($manifestBytes) | ForEach-Object { $_.ToString("x2") })) } finally { $sha256.Dispose() }
    $companionContinuityId = if ($CompanionContinuityId.Length -gt 0) { $CompanionContinuityId } else { [string]$env:GAMEBUDDY_COMPANION_CONTINUITY_ID }
    if ($companionContinuityId -notmatch '^[A-Za-z0-9_-]{1,128}$') { throw "farmhand_companion_continuity_id_required" }
    $previewConfig = @{ schemaVersion = 1; runtimeRoot = $HostRuntimeRoot; runtimeInstanceId = ("preview_" + [guid]::NewGuid().ToString("N")); requiredPresentationLocale = $PresentationLocale; identity = @{ playerId = [string]$manifest.farmhandId; companionId = [string]$manifest.companionId; continuityId = $companionContinuityId; saveId = [string]$manifest.saveId; worldId = [string]$manifest.worldId }; bridge = @{ pipeName = $pipeName; bridgeToken = $bridgeToken }; evidence = @{ path = $evidencePath; manifestSha256 = $manifestSha256 } }
    Write-PrivateJson $previewConfigPath $previewConfig

    # The AI-client role also requires its own fresh generation. The Host
    # generation is no longer present in the AI child environment.
    $aiLaunchGeneration = [guid]::NewGuid().ToString("N")
    $env:GAMEBUDDY_STARDEW_LAUNCH_GENERATION = $aiLaunchGeneration
    # The AI-client role is the silent farmhand; refresh GAMEBUDDY_WINDOW_MODE
    # with its own validated mode so the host child's value cannot cross roles.
    $env:GAMEBUDDY_WINDOW_MODE = $FarmhandWindowMode
    $aiStdoutPath = Join-Path $runRoot "ai-client.stdout.log"
    $aiProcess = Start-Process -FilePath $smapi -ArgumentList @("--mods-path", ('"{0}"' -f $aiModsPath)) -WorkingDirectory $GamePath -RedirectStandardOutput $aiStdoutPath -RedirectStandardError (Join-Path $runRoot "ai-client.stderr.log") -PassThru
    Write-LauncherPhase "aiClientLaunched"
    # The AI client is a FULL game instance: it needs its own startup (measured
    # 18-27s) before its Mod creates the bridge pipe. Starting the preview sooner
    # made it fail with `bridge_disconnected` - a class the retry rule below treats
    # as terminal, deliberately - so the run aborted about a second after launching
    # the AI client (measured 2026-10-05). Wait, boundedly, for the pipe to exist;
    # the preview's authenticated connect stays the readiness authority.
    $bridgePipeDeadline = [DateTimeOffset]::UtcNow.AddSeconds($StartupTimeoutSeconds)
    while (-not (Test-NamedPipeExists $pipeName)) {
        if ([DateTimeOffset]::UtcNow -ge $bridgePipeDeadline) { throw "ai_client_bridge_pipe_timeout" }
        $aiProcess.Refresh()
        if ($aiProcess.HasExited) { throw "ai_client_exited_before_bridge" }
        Start-Sleep -Milliseconds 250
    }
    Write-LauncherPhase "aiClientBridgePipeVisible"
    # The AI client's own boot consumed part of the startup budget. Give the
    # preview attempts their own bounded window from HERE so a slow (but healthy)
    # farmhand boot cannot starve them: measured 2026-10-06, the pipe appeared
    # 17.6s after the AI launch, leaving ~72s of the original 90s budget.
    $previewDeadline = [DateTimeOffset]::UtcNow.AddSeconds($StartupTimeoutSeconds)
    # The Mod creates its named-pipe listener during its normal SMAPI startup.
    # The first Preview process is the sole safe readiness probe: only a typed
    # Windows named-pipe `connect` ENOENT may be retried. Any other Preview
    # failure is terminal and never reinterpreted as startup timing.
    $previewDeadline = [DateTimeOffset]::UtcNow.AddSeconds($StartupTimeoutSeconds)
    $previewAttempt = 0
    $lastPreviewFailureCode = "preview_enoent_connect"
    $previewReady = $false
    $activeStopProofVerified = $false
    # In active-stop-proof mode, readiness opens the manual session but is not
    # completion: keep supervising until the immutable wrapper emits its one
    # proof receipt while every owned process remains alive.
    # StartupTimeoutSeconds bounds only the Preview readiness phase. Once the
    # game is ready, the operator owns the manual interaction window; waiting
    # for a real Pi turn and `/stop` proof must never tear down the game.
    while (-not $previewReady) {
        # Do not start a new child after the bounded AI listener window.
        if ([DateTimeOffset]::UtcNow -ge $previewDeadline) {
            throw "preview_start_or_run_failed:$lastPreviewFailureCode"
        }
        $previewAttempt++
        $previewStdoutPath = Join-Path $runRoot ("preview-{0}.stdout.log" -f $previewAttempt)
        $previewStderrPath = Join-Path $runRoot ("preview-{0}.stderr.log" -f $previewAttempt)
        # A successful immutable Preview construction (its receipt-backed exact
        # snapshot admission) writes a redacted readiness marker and remains
        # alive for the manual player observation session.
        # Supervise the immutable artifact's actual Node process, not pnpm.cmd.
        # The package-manager wrapper can exit after spawning its Node child;
        # treating that wrapper as the Preview would prematurely revoke a healthy
        # bridge and then strand the real child outside owned cleanup.
        $previewArguments = @(
            "scripts/start-production-artifact.mjs",
            "farmhand-companion-preview.js"
        )
        if ($RequireActiveStopProof) {
            $previewArguments += "--require-active-stop-proof"
        }
        $previewArguments += @(
            "--config",
            $previewConfigPath
        )
        $previewCommandLine = [string]::Join(" ", @($previewArguments | ForEach-Object { '"' + $_.Replace('"', '\"') + '"' }))
        # -NoNewWindow: the preview is a headless Node harness and the retry loop
        # starts one per attempt. Without it every attempt opened a console window
        # on the operator's desktop and interfered with unrelated work (measured
        # 2026-10-06). This creates no window and keeps the file redirects; window
        # SHAPE for the two game roles is still owned solely by the shared
        # window-mode contract (see Resolve-LiveRunWindowMode).
        $previewProcess = Start-Process -FilePath "node.exe" -ArgumentList $previewCommandLine -WorkingDirectory (Join-Path (Split-Path $PSScriptRoot -Parent) "host") -RedirectStandardOutput $previewStdoutPath -RedirectStandardError $previewStderrPath -NoNewWindow -PassThru
        while ($true) {
            $previewProcess.Refresh()
            $hasReadySignal = Test-PreviewReadySignal $previewStdoutPath
            $previewProcess.Refresh()
            # Process.HasExited is cached by System.Diagnostics.Process. Refresh
            # immediately after the file probe so a child that is still writing
            # its fixed marker cannot be misclassified from a stale handle state.
            $aiProcess.Refresh()
            $hostProcess.Refresh()
            if ($aiProcess.HasExited -or $hostProcess.HasExited) { throw "preview_dependency_exited" }
            if ($hasReadySignal) {
                # A single exact marker is emitted only after receipt-backed
                # admission from the directly supervised immutable Node entry.
                # Ready ends startup for both ordinary and proof modes. Proof
                # is a separate, operator-driven interaction phase below.
                $previewReady = $true
                # The number an operator actually asks for: everything above is
                # "the companion cannot take a player message yet", everything
                # after this line is the manual interaction window.
                Write-LauncherPhase "previewReady"
                Write-LauncherTiming
                break
            }
            if ($previewProcess.HasExited) {
                # Proof has no meaning before receipt-backed Preview readiness:
                # classify the real child startup failure, never a missing
                # operator `/stop`, and retain the normal retry rule for the
                # only transient named-pipe connect condition.
                $failureCode = Get-PreviewFailureCode $previewStderrPath
                $lastPreviewFailureCode = $failureCode
                # Two classes are transient BY CONSTRUCTION while readiness has never
                # been observed: `preview_enoent_connect` (no pipe yet) and
                # `bridge_disconnected:<reason>` (measured 2026-10-05: the AI
                # client's pipe NAME existed ~15.8s after its launch, yet the
                # preview's connect was still dropped - the other end publishes its
                # pipe before it serves it). A disconnect AFTER a readiness marker
                # remains terminal, and the bounded deadline still closes the window.
                $transientPreviewFailure = $failureCode -eq "preview_enoent_connect" -or $failureCode -like "bridge_disconnected*"
                if (-not $transientPreviewFailure -or [DateTimeOffset]::UtcNow -ge $previewDeadline -or $previewReady) {
                    throw "preview_start_or_run_failed:$failureCode"
                }
                break
            }
            if ($RequireActiveStopProof -and -not $activeStopProofVerified -and (Test-ActiveStopProofSignal $previewStdoutPath)) {
                # This is a receipt, not a shutdown command. Recheck the exact
                # supervised wrapper liveness at observation time so a stale
                # terminal write cannot satisfy the live gate.
                $previewProcess.Refresh()
                if ($previewProcess.HasExited) { throw "preview_exited_after_active_stop_proof" }
                $activeStopProofVerified = $true
            }
            if ($previewReady -and $RequireActiveStopProof -and $activeStopProofVerified) { break }
            if ($previewReady -and $RequireActiveStopProof) {
                Start-Sleep -Milliseconds 250
                continue
            }
            if ([DateTimeOffset]::UtcNow -ge $previewDeadline) {
                # Name the last real failure: a bare timeout hides WHY every attempt
                # failed, which is the same diagnostic gap the reason suffix closed
                # for a single attempt.
                throw "preview_start_or_run_failed:preview_listener_start_timeout:$lastPreviewFailureCode"
            }
            Start-Sleep -Milliseconds 100
        }
        if (-not $previewReady -and -not $previewProcess.HasExited) {
            throw "preview_start_or_run_failed:preview_listener_start_timeout"
        }
    }
    if ($RequireActiveStopProof -and -not $activeStopProofVerified) {
        # Manual interaction phase. Do not apply the startup deadline here:
        # the user must first start a real Pi turn and then issue `/stop`.
        while (-not $activeStopProofVerified) {
            $previewProcess.Refresh()
            $aiProcess.Refresh()
            $hostProcess.Refresh()
            if ($previewProcess.HasExited) { throw "preview_exited_before_active_stop_proof" }
            if ($aiProcess.HasExited -or $hostProcess.HasExited) { throw "preview_dependency_exited" }
            if (Test-ActiveStopProofSignal $previewStdoutPath) {
                $previewProcess.Refresh()
                if ($previewProcess.HasExited) { throw "preview_exited_after_active_stop_proof" }
                $activeStopProofVerified = $true
                break
            }
            Start-Sleep -Milliseconds 250
        }
    }
    # A proof receipt is deliberately not process completion. Keep every owned
    # process alive after preview readiness and the STOP proof, until the
    # operator closes this launcher/Preview session.
    # Keep every owned process alive after confirmed Preview admission, until
    # the operator closes this launcher/Preview session. If either dependency
    # exits first, fail closed instead of leaving a live Preview misleadingly
    # available without the corresponding Host/Mod authority.
    while ($true) {
        $previewProcess.Refresh()
        $aiProcess.Refresh()
        $hostProcess.Refresh()
        if ($previewProcess.HasExited) {
            if ($RequireActiveStopProof) { throw "preview_exited_after_active_stop_proof" }
            break
        }
        if ($aiProcess.HasExited -or $hostProcess.HasExited) {
            throw "preview_dependency_exited"
        }
        Start-Sleep -Milliseconds 250
    }
} catch {
    # Keep the run's own failure so the cleanup path cannot replace it: an error
    # thrown from `finally` masks the exception that actually stopped the run.
    # Report it immediately, too - a cleanup race used to destroy the only record
    # of why the run stopped (measured 2026-10-06).
    $primaryFailure = $_
    Write-Output ("[launcher-failure] run failed: " + $_.Exception.Message)
    # The instances' own diagnostics: the farmhand's view of why it dropped the
    # preview is otherwise lost with the run root.
    foreach ($instance in @(@("host", $hostStdoutPath), @("ai-client", $aiStdoutPath))) {
        foreach ($line in (Get-BoundedLogDiagnostics $instance[1])) {
            Write-Output ("[launcher-instance-diag] " + $instance[0] + ": " + $line)
        }
    }
    throw
} finally {
    # Strict reverse ownership order. Restore only after every launched process
    # ended; a failed restore deliberately preserves its backup and lock. Cleanup
    # failures are reported ALONGSIDE the run's failure, never instead of it.
    $cleanupFailure = $null
    try { Stop-OwnedProcess $previewProcess } catch { if ($null -eq $cleanupFailure) { $cleanupFailure = $_ } }
    try { Stop-OwnedProcess $aiProcess } catch { if ($null -eq $cleanupFailure) { $cleanupFailure = $_ } }
    try { Stop-OwnedProcess $hostProcess } catch { if ($null -eq $cleanupFailure) { $cleanupFailure = $_ } }
    if ($null -ne $cleanupFailure -and $null -ne $primaryFailure) {
        Write-Output ("[launcher-failure] cleanup also failed: " + $cleanupFailure.Exception.Message)
    } elseif ($null -ne $cleanupFailure) {
        throw $cleanupFailure
    }
    if ($previousLaunchGenerationPresent) {
        $env:GAMEBUDDY_STARDEW_LAUNCH_GENERATION = $previousLaunchGeneration
    } else {
        Remove-Item Env:GAMEBUDDY_STARDEW_LAUNCH_GENERATION -ErrorAction SilentlyContinue
    }
    # Clear the per-role window mode exactly like the launch-generation clear
    # above, so neither role's validated mode can leak into any later process.
    Remove-Item Env:GAMEBUDDY_WINDOW_MODE -ErrorAction SilentlyContinue
    # Preview evidence is non-secret, content-free and hash-only. Preserve it
    # through teardown so the launcher can report the observed phase set;
    # remove it only with the private run root after that summary is captured.
    $evidenceKinds = @()
    if (Test-Path -LiteralPath $evidencePath) {
        try {
            $evidenceKinds = @(Get-Content -LiteralPath $evidencePath | ForEach-Object {
                if (-not [string]::IsNullOrWhiteSpace($_)) { ([System.Text.Json.JsonDocument]::Parse($_)).RootElement.GetProperty("event").GetProperty("kind").GetString() }
            } | Where-Object { $_ -match '^[a-z_]+$' } | Select-Object -Unique)
        } catch {
            $evidenceKinds = @("evidence_unreadable")
        }
    }
    if ($null -ne $previewStdoutPath) { $ingressStages = Get-PreviewIngressStages $previewStdoutPath }
    Remove-Item -LiteralPath $overridePath, $previewConfigPath -Force -ErrorAction SilentlyContinue
    if ($null -ne $sessionDirectory) { Clear-RunSessionExchange $sessionDirectory }
    if ($prepared) {
        try {
            Invoke-NodeQuiet @("tools/restore-stardew-fixture-profile.mjs", "--backup-name", $backupName) "fixture_restore_failed"
        } catch {
            if ($null -eq $primaryFailure) { throw }
            Write-Output ("[launcher-failure] run failed: " + $primaryFailure.Exception.Message + " | fixture restore also failed: " + $_.Exception.Message)
        }
    }
    Remove-Item -LiteralPath $runRoot -Recurse -Force -ErrorAction SilentlyContinue
}

# Redacted completion only: phase names are fixed, content-free diagnostics.
[pscustomobject]@{ state = "closed"; topology = "native_ai_farmhand_multiplayer"; evidenceKinds = $evidenceKinds; ingressStages = $ingressStages } | ConvertTo-Json -Compress
Remove-Item -LiteralPath $evidencePath -Force -ErrorAction SilentlyContinue
