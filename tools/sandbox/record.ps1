# Guest-side black box: record why a logon command works or fails, using only the guest's own C: drive.
#
# Why it looks like this: every previous attempt could not tell "the logon command never ran" from "it ran
# and the mapped folder was missing", because in both cases the host share stays empty. This recorder
# therefore writes to C:\boot.log on the guest, and it is copied to C:\ by the logon command before it
# does anything else - so a mount failure after that point cannot take it with it.
#
# The log is a sequence of numbered stages, so a failure names its own cause:
#   1  recorder started        (this line alone proves the logon command ran)
#   2  mount wait              (how long, or that the share never appeared)
#   3  share contents          (what the mount actually exposed)
#   4  gate run                (exit code, or that the gate was absent)
#   5  SANDBOX-DONE
#
# It also copies the log and the gate's output into the share at the end when the mount is live, so the host
# can read them without a screenshot. The guest copy is the authority; the share copy is convenience.

$ErrorActionPreference = 'Continue'
$Log = 'C:\boot.log'
$Share = 'C:\gamebuddy-share'
$Gate = Join-Path $Share 'sandbox-verify.cmd'
$GateLog = Join-Path $Share 'result.log'
$MountWaitSeconds = 600

function Write-Record {
    param([string]$Message)
    try {
        Add-Content -LiteralPath $Log -Value ('[' + (Get-Date -Format 'o') + '] ' + $Message) -Encoding UTF8
    } catch {
        # A recorder that throws is worse than no recorder.
    }
}

Write-Record '1 recorder-started'
$runId = [guid]::NewGuid().ToString('n').Substring(0, 12)
Write-Record ('1 run-id=' + $runId)

# The gate appends to its transcript, so a previous run's lines would be counted as this run's findings.
# Measured: a 0.27s aborted run left `[uninstall] removal completion marker written | FAIL:missing` at the
# top of result.log, and the verdict for the following, fully successful run reported that stale failure as
# its only problem. Each run owns its transcript, so it is cleared here before the gate starts.
foreach ($stale in @($GateLog, (Join-Path $Share 'sandbox-result.txt'), (Join-Path $Share 'sandbox-result.json'))) {
    try {
        if (Test-Path -LiteralPath $stale) { Remove-Item -LiteralPath $stale -Force -ErrorAction Stop }
    } catch {
        Write-Record ('1 could-not-clear-stale ' + $stale)
    }
}
Write-Record ('1 computer=' + $env:COMPUTERNAME + ' user=' + $env:USERNAME + ' powershell=' + $PSVersionTable.PSVersion)

$started = Get-Date
$polls = 0
while (-not (Test-Path -LiteralPath $Share) -and $polls -lt $MountWaitSeconds) {
    Start-Sleep -Seconds 1
    $polls++
}
Write-Record ('2 mount-wait-seconds=' + $polls + ' share-exists=' + (Test-Path -LiteralPath $Share))

if (Test-Path -LiteralPath $Share) {
    try {
        $entries = (Get-ChildItem -LiteralPath $Share -ErrorAction Stop | ForEach-Object { $_.Name }) -join ', '
        Write-Record ('3 share-contents=' + $entries)
    } catch {
        Write-Record ('3 share-unreadable ' + $_.Exception.Message)
    }
} else {
    Write-Record '3 share-NEVER-appeared'
}

if (Test-Path -LiteralPath $Gate) {
    Write-Record '4 gate-present, launching'
    try {
        & cmd.exe /c "$Gate > `"$GateLog`" 2>&1"
        Write-Record ('4 gate-exit-code=' + $LASTEXITCODE)
    } catch {
        Write-Record ('4 gate-FAILED-TO-LAUNCH ' + $_.Exception.Message)
    }
} else {
    Write-Record ('4 gate-ABSENT at ' + $Gate)
}

Write-Record ('5 SANDBOX-DONE elapsed=' + [int]((Get-Date) - $started).TotalSeconds + 's')

# Convenience copies for the host. Failures are recorded, never fatal.
foreach ($pair in @(
    @{ Source = $Log; Target = (Join-Path $Share 'boot.log') },
    @{ Source = 'C:\boot.log'; Target = (Join-Path $Share 'boot.again.log') }
)) {
    try {
        Copy-Item -LiteralPath $pair.Source -Destination $pair.Target -Force -ErrorAction Stop
    } catch {
        Write-Record ('5 copy-failed ' + $pair.Target + ' :: ' + $_.Exception.Message)
    }
}
