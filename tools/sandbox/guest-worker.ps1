# The sandbox side of the file-bus control channel.
#
# Everything the host needs to control this session travels through one mapped folder: the host writes
# tasks into `tasks/`, this session's worker executes them and writes `results/`, and a host-side agent
# reads those. No port, no agent inside the guest, no dependency.
#
# Why the wait loop below exists (this is the whole reason earlier attempts failed): `LogonCommand` is
# dispatched when winlogon finishes the logon, while the mapped folder is attached asynchronously by a
# separate driver. Measured gap: one guest had to poll 158 times (~1s each) before the share existed.
# A command that touches the share before then fails instantly with "the system cannot find the path
# specified" and leaves no host-visible trace at all - which reads exactly like "the guest never ran
# anything". So the share is treated as something to WAIT FOR, never as a given.

$ErrorActionPreference = 'Continue'
$BusRoot = 'C:\gamebuddy-bus'

$mountPolls = 0
while (-not (Test-Path -LiteralPath $BusRoot) -and $mountPolls -lt 600) {
    Start-Sleep -Seconds 1
    $mountPolls++
}
if (-not (Test-Path -LiteralPath $BusRoot)) { exit 0 }

$TaskDir = Join-Path $BusRoot 'tasks'
$ResultDir = Join-Path $BusRoot 'results'
$RunningDir = Join-Path $BusRoot 'running'
$ReadyFile = Join-Path $BusRoot 'guest-ready.txt'

foreach ($dir in @($TaskDir, $ResultDir, $RunningDir)) {
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
}

@(
    "readyAt=$((Get-Date).ToString('o'))",
    "mountWaitSeconds=$mountPolls",
    "machine=$([System.Environment]::MachineName)",
    "user=$([System.Environment]::UserName)"
) | Set-Content -LiteralPath $ReadyFile -Encoding UTF8

function Complete-Task {
    param([string]$Id, [int]$ExitCode, [string]$Output, [string]$StartedAt)
    $result = [ordered]@{
        id          = $Id
        exitCode    = $ExitCode
        output      = $Output
        startedAt   = $StartedAt
        completedAt = (Get-Date).ToString('o')
    }
    # Written to a temporary name and then moved, so a host that polls never reads a partial file.
    $final = Join-Path $ResultDir "$Id.json"
    $temp = Join-Path $ResultDir "$Id.json.partial"
    $result | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $temp -Encoding UTF8
    Move-Item -LiteralPath $temp -Destination $final -Force
}

while ($true) {
    $tasks = @(Get-ChildItem -LiteralPath $TaskDir -Filter '*.json' -ErrorAction SilentlyContinue | Sort-Object Name)
    foreach ($task in $tasks) {
        $id = $task.BaseName
        $claimed = Join-Path $RunningDir "$id.claimed.json"
        try {
            Move-Item -LiteralPath $task.FullName -Destination $claimed -Force -ErrorAction Stop
        } catch {
            continue
        }

        $startedAt = (Get-Date).ToString('o')
        try {
            $data = Get-Content -LiteralPath $claimed -Raw -ErrorAction Stop | ConvertFrom-Json
            $command = [string]$data.command
            $timeout = 600
            if ($null -ne $data.timeoutSeconds) { $timeout = [int]$data.timeoutSeconds }

            $output = ''
            $exitCode = 0
            $job = Start-Job -ScriptBlock {
                param($cmd)
                $ErrorActionPreference = 'Continue'
                $out = Invoke-Expression $cmd 2>&1 | Out-String
                [pscustomobject]@{ Output = $out; ExitCode = $LASTEXITCODE; Success = $? }
            } -ArgumentList $command
            $finished = Wait-Job -Job $job -Timeout $timeout
            if ($null -eq $finished) {
                Stop-Job -Job $job -ErrorAction SilentlyContinue
                $output = "guest_worker_timeout:${timeout}s"
                $exitCode = 124
            } else {
                $state = Receive-Job -Job $job -ErrorAction SilentlyContinue
                if ($state) {
                    $output = [string]$state.Output
                    if ($state.Success -eq $false -and [int]$state.ExitCode -eq 0) { $exitCode = 1 } else { $exitCode = [int]$state.ExitCode }
                }
            }
            Remove-Job -Job $job -Force -ErrorAction SilentlyContinue

            Complete-Task -Id $id -ExitCode $exitCode -Output $output -StartedAt $startedAt
        } catch {
            $message = $_.Exception.Message
            Complete-Task -Id $id -ExitCode 1 -Output "guest_worker_error:$message" -StartedAt $startedAt
        } finally {
            Remove-Item -LiteralPath $claimed -Force -ErrorAction SilentlyContinue
        }
    }
    Start-Sleep -Milliseconds 250
}
