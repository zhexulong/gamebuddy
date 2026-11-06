param(
    [string]$Root = 'C:\gb-mount-race',
    [int]$Rounds = 3,
    [int]$PollLimitSeconds = 150,
    [int]$SettleSeconds = 90
)

$ErrorActionPreference = 'Continue'

# Decisive test of the mount-race hypothesis.
#
# Claim: `LogonCommand` fires when winlogon logs the user in, but the mapped folder is attached
# asynchronously by a separate driver. If the command's FIRST statement touches the share before it
# exists, the whole command dies instantly ("the system cannot find the path specified") - which is
# exactly what produced breadcrumb-less silence in earlier rounds.
#
# This probe's logon command therefore does nothing that depends on the share except POLL for it, and
# only writes once it is there. If this succeeds on every round - including rounds that would have
# failed before - the hypothesis is confirmed and the fix is "wait for the mount, then run", not
# "this platform cannot run logon commands reliably".
$rows = New-Object System.Collections.ArrayList

for ($round = 1; $round -le $Rounds; $round++) {
    $work = Join-Path $Root "round$round"
    if (Test-Path -LiteralPath $work) { Remove-Item -Recurse -Force -LiteralPath $work }
    New-Item -ItemType Directory -Force -Path $work | Out-Null

    # The polling bootstrap. Everything before `C:\share` appears is a pure inner-VM operation
    # (cmd built-in + ping, both always present), so nothing can fail for lack of a mount.
    # Once the share exists, it writes a file whose presence is the observable.
    $wsb = Join-Path $work 'm.wsb'
    $xml = @'
<Configuration>
  <MappedFolders>
    <MappedFolder>
      <HostFolder>__ROOT__</HostFolder>
      <SandboxFolder>C:\share</SandboxFolder>
      <ReadOnly>false</ReadOnly>
    </MappedFolder>
  </MappedFolders>
  <Networking>Disable</Networking>
  <LogonCommand>
    <Command>cmd.exe /c "for /L %i in (1,1,300) do @(if exist C:\share (echo mount-ready-at-tick-%i > C:\share\mounted.txt) else ping -n 1 127.0.0.1 >nul)"</Command>
  </LogonCommand>
</Configuration>
'@
    $xml = $xml.Replace('__ROOT__', $work)
    [System.IO.File]::WriteAllText($wsb, $xml, (New-Object System.Text.UTF8Encoding($false)))

    # Drain: close the UI and let the worker retire, without requiring vmwp==0 as a precondition -
    # this probe must be free to run even when the platform is in the state that used to block it.
    Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match '^WindowsSandbox' } |
        ForEach-Object { try { Stop-Process -Id $_.Id -Force -ErrorAction Stop } catch {} }
    Start-Sleep -Seconds $SettleSeconds

    $vmwpBefore = @(Get-Process -Name 'vmwp' -ErrorAction SilentlyContinue).Count
    $started = Get-Date
    Start-Process -FilePath 'C:\Windows\System32\WindowsSandbox.exe' -ArgumentList "`"$wsb`"" | Out-Null

    $marker = Join-Path $work 'mounted.txt'
    $deadline = (Get-Date).AddSeconds($PollLimitSeconds)
    while ((Get-Date) -lt $deadline -and -not (Test-Path -LiteralPath $marker)) {
        Start-Sleep -Milliseconds 500
    }
    $elapsed = [math]::Round(((Get-Date) - $started).TotalSeconds)
    $ok = Test-Path -LiteralPath $marker
    $content = ''
    if ($ok) { $content = (Get-Content -LiteralPath $marker -Raw).Trim() }

    $null = $rows.Add([pscustomobject]@{
        Round      = $round
        VmwpBefore = $vmwpBefore
        Mounted    = $ok
        Seconds    = $elapsed
        Content    = $content
    })
    "round {0}: vmwpBefore={1} mounted={2} after {3}s {4}" -f $round, $vmwpBefore, $ok, $elapsed, $content
}

'== result =='
$rows | Format-Table -AutoSize | Out-String -Width 160
$okCount = @($rows | Where-Object { $_.Mounted }).Count
"mounted in $okCount of $($rows.Count) rounds"

Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match '^WindowsSandbox' } |
    ForEach-Object { try { Stop-Process -Id $_.Id -Force -ErrorAction Stop } catch {} }
