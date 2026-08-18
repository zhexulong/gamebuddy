import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const launcher = await readFile(resolve("tools/start-farmhand-launcher.ps1"), "utf8");

test("launcher rejects caller bridge credentials and requires an existing Host-owned runtime root without synthesizing a profile", () => {
  assert.match(launcher, /\[string\]\$HostRuntimeRoot/);
  assert.match(launcher, /Assert-AbsoluteDirectory \$HostRuntimeRoot "host_runtime_root"/);
  assert.match(launcher, /function Test-WindowsAbsolutePath/);
  assert.match(launcher, /\^\[A-Za-z\]:\[\\\\\/\]/);
  assert.doesNotMatch(launcher, /\[System\.IO\.Path\]::IsPathFullyQualified/);
  assert.match(launcher, /RandomNumberGenerator\]::Create\(\)/);
  assert.doesNotMatch(launcher, /RandomNumberGenerator\]::Fill/);
  assert.match(launcher, /SHA256\]::Create\(\)/);
  assert.doesNotMatch(launcher, /Convert\]::ToHexString/);
  assert.match(launcher, /\[IO\.Directory\]::GetAccessControl\(\$Path\)/);
  assert.doesNotMatch(launcher, /Get-Acl -LiteralPath/);
  assert.doesNotMatch(launcher, /host_runtime_model_profile_missing/);
  assert.doesNotMatch(launcher, /Copy-Item.*model-profiles|Write-PrivateJson.*model-profiles/);
  assert.doesNotMatch(launcher, /\$PipeName|\$BridgeToken|\$ManifestPath|\$SessionToken/);
  assert.match(launcher, /windows_only/);
  assert.match(launcher, /\[ValidateSet\("zh-CN", "en-US"\)\] \[string\]\$PresentationLocale = "zh-CN"/);
  assert.match(launcher, /Assert-PresentationStartupPreference/);
  assert.match(launcher, /live_locale_required/);
  assert.match(launcher, /\$expectedLanguageCode = if \(\$RequiredLocale -eq "zh-CN"\) \{ "zh" \} elseif \(\$RequiredLocale -eq "en-US"\) \{ "en" \}/);
  assert.match(launcher, /--require-fixture-live-locale", \$PresentationLocale/);
  assert.match(launcher, /Initialize-PrivateRunRoot/);
  assert.match(launcher, /preview_run_root_private_acl_failed/);
});

test("launcher preserves the configured formal fixture and clears only known generated session exchange", () => {
  assert.match(launcher, /\$scenario = \[string\]\$originalHost\.HostAutomation\.FixtureScenario/);
  assert.match(launcher, /\$targetSave = \[string\]\$originalHost\.HostAutomation\.SaveName/);
  assert.match(launcher, /"--target-save", \$targetSave/);
  assert.match(launcher, /function Clear-RunSessionExchange/);
  assert.match(launcher, /stardew-session\.json/);
  assert.match(launcher, /stardew-fixture-readiness\.json/);
  assert.doesNotMatch(launcher, /\$host\s*=/);
  assert.match(launcher, /\$hostProfile\s*=/);
});

test("launcher rebuilds the current Release Mod before it can prepare a fixture transaction", () => {
  const rebuild = launcher.indexOf("-t:Rebuild");
  const prepare = launcher.indexOf("prepare-stardew-fixture-profile.mjs");
  assert.ok(rebuild >= 0 && rebuild < prepare);
  assert.match(launcher, /\$stardewProject = Join-Path \$repositoryRoot "integrations\\stardew\\GameBuddy\.Stardew\.csproj"/);
  assert.match(launcher, /dotnet build \$stardewProject/);
  assert.doesNotMatch(launcher, /dotnet build \(Join-Path \$repositoryRoot "GameBuddy\.sln"\)/);
  assert.match(launcher, /--configuration Release --no-restore "-p:GamePath=\$GamePath" -t:Rebuild/);
  assert.match(launcher, /stardew_release_rebuild_failed/);
});

test("launcher starts Host, authenticates readiness and fresh manifest before AI or Preview", () => {
  const hostStart = launcher.indexOf("$hostProcess = Start-Process");
  const readiness = launcher.indexOf("await-stardew-fixture-readiness.mjs");
  const attachment = launcher.indexOf("stardew-attachment-request.mjs");
  const override = launcher.indexOf("apply-stardew-fixture-bridge-override.mjs");
  const aiStart = launcher.indexOf("$aiProcess = Start-Process");
  const previewStart = launcher.indexOf("$previewProcess = Start-Process");
  assert.ok(
    hostStart >= 0 &&
      hostStart < readiness &&
      readiness < attachment &&
      attachment < override &&
      override < aiStart &&
      aiStart < previewStart,
  );
  assert.match(launcher, /fresh_attachment_manifest_invalid/);
  const handoff = launcher.indexOf("Start-Sleep -Seconds 5");
  assert.ok(handoff > readiness && handoff < attachment);
  assert.match(launcher, /separately signed attachment advertisement/);
  assert.match(launcher, /"--require-fixture-live-locale", \$PresentationLocale/);
  assert.match(launcher, /post-save-load game-thread locale/);
  assert.match(launcher, /startup preference above[\s\S]*never accepted as runtime evidence/);
  assert.match(launcher, /receipt-backed exact[\s\S]*snapshot admission/);
});

test("Preview command has only immutable entry and private config arguments", () => {
  assert.match(launcher, /Assert-PresentationStartupPreference \$PresentationLocale/);
  assert.match(launcher, /requiredPresentationLocale = \$PresentationLocale/);
  assert.match(launcher, /\$previewArguments = @\(/);
  assert.match(launcher, /\$previewCommandLine = \[string\]::Join\(" ", @\(\$previewArguments \| ForEach-Object/);
  assert.match(launcher, /scripts\/start-production-artifact\.mjs/);
  assert.match(launcher, /farmhand-companion-preview\.js/);
  assert.match(launcher, /Start-Process -FilePath "node\.exe" -ArgumentList \$previewCommandLine/);
  assert.doesNotMatch(launcher, /Start-Process -FilePath "pnpm\.cmd"/);
  assert.match(launcher, /\("--mods-path", \('\"\{0\}\"' -f \$hostModsPath\)\)/);
  assert.match(launcher, /\("--mods-path", \('\"\{0\}\"' -f \$aiModsPath\)\)/);
  assert.doesNotMatch(launcher, /GAMEBUDDY_CONTROL_PIPE|GAMEBUDDY_CONTROL_TOKEN|local-bootstrap|semantic/i);
  assert.match(launcher, /evidenceKinds = @\(\)/);
  assert.match(launcher, /\$previewStdoutPath = \$null/);
  assert.match(launcher, /\$previewStderrPath = \$null/);
  assert.match(launcher, /GetProperty\("event"\)\.GetProperty\("kind"\)/);
  assert.match(launcher, /evidence_unreadable/);
  assert.match(launcher, /evidenceKinds = \$evidenceKinds/);
  assert.match(launcher, /function Get-PreviewIngressStages/);
  assert.match(launcher, /native_chat_adapter_fact_forwarded/);
  assert.match(launcher, /ai_player_control_host_accepted/);
  assert.match(launcher, /ai_player_control_pipe_reader_ended/);
  assert.match(launcher, /ai_player_control_pipe_writer_ended/);
  assert.match(launcher, /native_chat_bridge_inbound_rejected:malformed_player_control/);
  assert.match(launcher, /player_input_accepted/);
  assert.match(launcher, /player_input_enqueued/);
  assert.match(launcher, /ingressStages = \$ingressStages/);
  assert.match(launcher, /Remove-Item -LiteralPath \$evidencePath -Force/);
});

test("cleanup terminates owned children in reverse order then restores transaction", () => {
  const preview = launcher.indexOf("Stop-OwnedProcess $previewProcess");
  const ai = launcher.indexOf("Stop-OwnedProcess $aiProcess");
  const host = launcher.indexOf("Stop-OwnedProcess $hostProcess");
  const restore = launcher.indexOf("restore-stardew-fixture-profile.mjs");
  assert.ok(preview >= 0 && preview < ai && ai < host && host < restore);
  assert.match(launcher, /fixture_restore_failed/);
  assert.match(launcher, /\$taskkillOutput = & .*taskkill\.exe.*2>&1/);
  assert.match(launcher, /if \(-not \$Process\.HasExited\) \{ throw "owned_process_stop_timeout" \}/);
});

test("launcher keeps secret config and child output private", () => {
  assert.match(launcher, /RedirectStandardOutput/);
  assert.match(launcher, /RedirectStandardError/);
  assert.doesNotMatch(launcher, /Write-Host|Write-Output.*bridgeToken/);
  assert.doesNotMatch(launcher, /BridgeLeaseExpiresAtUnixMs|bridgeLeaseExpiresAtUnixMs|leaseExpiry|leaseStartupDeadline/);
  assert.match(launcher, /Write-PrivateJson \$previewConfigPath \$previewConfig/);
  assert.match(launcher, /state = "closed"/);
  assert.match(launcher, /function Invoke-NodeQuiet/);
  assert.match(launcher, /privateOutputPath/);
  assert.match(launcher, /privateErrorPath/);
  assert.match(launcher, /\$commandLine = \[string\]::Join\(" ", @\(\$Arguments \| ForEach-Object/);
  assert.match(launcher, /Start-Process -FilePath "node\.exe" -ArgumentList \$commandLine -NoNewWindow -Wait -PassThru -RedirectStandardOutput \$privateOutputPath -RedirectStandardError \$privateErrorPath/);
  assert.match(launcher, /stardew_\[a-z0-9_\]\+/);
  assert.match(launcher, /fixture_\[a-z0-9_\]\+/);
  assert.match(launcher, /throw \("\{0\}:\{1\}" -f \$FailureCode, \$detail\)/);
  assert.match(launcher, /Remove-Item -LiteralPath \$privateOutputPath, \$privateErrorPath/);
  assert.match(launcher, /function Get-PreviewFailureCode/);
  assert.match(launcher, /native_chat_pipe_data_received:received/);
  assert.match(launcher, /native_chat_bridge_inbound_frame_received:received/);
  assert.match(launcher, /native_chat_bridge_player_control_validated:accepted/);
  assert.match(launcher, /preview_start_or_run_failed:\$failureCode/);
  assert.match(launcher, /never retain or echo the raw child output/);
  assert.match(launcher, /stardew_\[a-z0-9_\]\+/);
  assert.match(launcher, /bridge_\[a-z0-9_\]\+/);
  assert.match(launcher, /ERR_\[A-Z0-9_\]\+/);
  assert.match(launcher, /preview_enoent_/);
  assert.match(launcher, /never echo the path/);
  assert.match(launcher, /preview_enoent_connect/);
});

test("launcher reads a live Preview readiness marker through the redirect-compatible reader", () => {
  assert.match(launcher, /Get-Content -LiteralPath \$Path -Raw -ErrorAction Stop/);
  assert.doesNotMatch(launcher, /\[IO\.File\]::Open\(\$Path/);
});

test("active STOP proof starts its manual interaction phase only after Preview ready and never applies the startup timeout", () => {
  assert.match(launcher, /while \(-not \$previewReady\)/);
  assert.match(launcher, /if \(\$hasReadySignal\) \{[\s\S]*?\$previewReady = \$true[\s\S]*?break/);
  assert.match(launcher, /if \(\$RequireActiveStopProof -and -not \$activeStopProofVerified\) \{[\s\S]*?while \(-not \$activeStopProofVerified\)/);
  assert.match(launcher, /Manual interaction phase\. Do not apply the startup deadline here/);
  assert.doesNotMatch(launcher, /active_stop_proof_unverified/);
  assert.match(launcher, /if \(\$previewProcess\.HasExited\) \{ throw "preview_exited_before_active_stop_proof" \}/);
  assert.match(launcher, /if \(Test-ActiveStopProofSignal \$previewStdoutPath\) \{[\s\S]*?\$activeStopProofVerified = \$true/);
  assert.match(launcher, /A proof receipt is deliberately not process completion[\s\S]*?Keep every owned/);
  assert.doesNotMatch(launcher, /if \(\$RequireActiveStopProof\) \{ return \}/);
});

test("launcher keeps a receipt-backed Preview alive only after its redacted readiness marker and supervises dependencies", () => {
  assert.match(launcher, /function Test-PreviewReadySignal/);
  assert.match(launcher, /Get-Content -LiteralPath \$Path -Raw -ErrorAction Stop/);
  assert.match(launcher, /catch \[IO\.IOException\]/);
  assert.match(launcher, /farmhand_companion_preview_ready/);
  assert.match(launcher, /\$hasReadySignal = Test-PreviewReadySignal \$previewStdoutPath/);
  assert.match(launcher, /if \(\$hasReadySignal\)/);
  assert.match(launcher, /if \(\$hasReadySignal\) \{[\s\S]*?\$previewReady = \$true[\s\S]*?break/);
  assert.match(launcher, /\$previewReady = \$true/);
  assert.doesNotMatch(launcher, /\$previewProcess\.WaitForExit\(\)/);
  assert.match(launcher, /\$aiProcess\.HasExited -or \$hostProcess\.HasExited/);
  assert.match(launcher, /preview_dependency_exited/);
  assert.match(launcher, /preview_listener_start_timeout/);
});

test("launcher retries only the bounded AI pipe-listener connect race before the startup deadline", () => {
  assert.match(
    launcher,
    /\$previewDeadline = \[DateTimeOffset\]::UtcNow\.AddSeconds\(\$StartupTimeoutSeconds\)/,
  );
  assert.match(
    launcher,
    /if \(\[DateTimeOffset\]::UtcNow -ge \$previewDeadline\) \{\s*throw "preview_start_or_run_failed:\$lastPreviewFailureCode"/,
  );
  assert.match(
    launcher,
    /\$failureCode -ne "preview_enoent_connect" -or \[DateTimeOffset\]::UtcNow -ge \$previewDeadline/,
  );
  assert.match(launcher, /Proof has no meaning before receipt-backed Preview readiness/);
  assert.match(launcher, /throw "preview_start_or_run_failed:\$failureCode"/);
  assert.match(launcher, /preview-\{0\}\.stderr\.log/);
  assert.doesNotMatch(launcher, /catch\s*\{\s*Start-Sleep/);
});
