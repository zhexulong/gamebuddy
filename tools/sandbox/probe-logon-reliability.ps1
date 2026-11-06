param(
    [string]$Root = 'C:\gb-race',
    [int]$Rounds = 6,
    [int]$TimeoutSeconds = 100,
    [int]$CooldownSeconds = 25
)

$ErrorActionPreference = 'Continue'

# One variable, measured: does a fresh sandbox run LogonCommand every time, or only some times?
#
# The evidence says the latter - the SAME .wsb content ran once (guest wrote guest-marker.txt 23s
# after the config was written) and then produced nothing on later identical attempts. So the question
# is what differs. This records, per round: how many vmwp/session processes exist before launching,
# whether the launcher exits 0, whether a session appears, and whether the guest's file appears.
# Schema is stable JSON lines so the pattern can be read off rather than argued about.
$rounds = New-Object System.Collections.Generic.List[object]

for ($round = 1; $round -le $Rounds; $round++) {
    $work = Join-Path $Root "round$round"
    if (Test-Path -LiteralPath $work) { Remove-Item -Recurse -Force -LiteralPath $work }
    New-Item -ItemType Directory -Force -Path $work | Out-Null

    $wsb = Join-Path $work 'r.wsb'
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
    <Command>cmd.exe /c "echo ran > C:\share\ran.txt"</Command>
  </LogonCommand>
</Configuration>
'@
    $xml = $xml.Replace('__ROOT__', $work)
    [System.IO.File]::WriteAllText($wsb, $xml, (New-Object System.Text.UTF8Encoding($false)))

    # Fully drain before each round: no sandbox UI, and wait for vmwp to clear so this round starts from
    # the same state the successful one did.
    Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match '^WindowsSandbox' } |
        ForEach-Object { try { Stop-Process -Id $_.Id -Force -ErrorAction Stop } catch {} }
    $drainDeadline = (Get-Date).AddSeconds(90)
    while ((Get-Date) -lt $drainDeadline) {
        $holders = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match 'Sandbox|vmwp' })
        if ($holders.Count -eq 0) { break }
        Start-Sleep -Seconds 2
    }
    $holdersBefore = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match 'Sandbox|vmwp' })
    $vmwpBefore = @($holdersBefore | Where-Object { $_.ProcessName -eq 'vmwp' }).Count
    if ($holdersBefore.Count -gt 0) {
        "round ${round}: waiting an extra cooldown with $vmwpBefore vmwp still held"
        Start-Sleep -Seconds $CooldownSeconds
    }

    $started = Get-Date
    $launcher = Start-Process -FilePath 'C:\Windows\System32\WindowsSandbox.exe' -ArgumentList "`"$wsb`"" -PassThru -ErrorAction SilentlyContinue
    if ($launcher) { [void]$launcher.WaitForExit(4000) }

    $guestFile = Join-Path $work 'ran.txt'
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline -and -not (Test-Path -LiteralPath $guestFile)) {
        Start-Sleep -Seconds 2
    }
    $elapsed = [math]::Round(((Get-Date) - $started).TotalSeconds)
    $produced = Test-Path -LiteralPath $guestFile
    $sessionsAfter = @(Get-Process -ErrorAction SilentlyContinue -Name 'WindowsSandboxRemoteSession').Count
    $vmwpAfter = @(Get-Process -ErrorAction SilentlyContinue -Name 'vmwp').Count

    $rounds.Add([pscustomobject]@{
        Round = $round
        VmwpBefore = $vmwpBefore
        GuestRan = $produced
        Seconds = $elapsed
        SessionsAfter = $sessionsAfter
        VmwpAfter = $vmwpAfter
    })

    $line = [ordered]@{ round = $round; vmwpBefore = $vmwpBefore; guestRan = $produced; seconds = $elapsed; sessionsAfter = $sessionsAfter; vmwpAfter = $vmwpAfter } | ConvertTo-Json -Compress
    $line
    if ($produced) { "  content: " + (Get-Content -LiteralPath $guestFile -Raw) }
}

'== summary =='
$rounds | Format-Table -AutoSize | Out-String -Width 140

# Leave nothing behind.
Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match '^WindowsSandbox' } |
    ForEach-Object { try { Stop-Process -Id $_.Id -Force -ErrorAction Stop } catch {} }
