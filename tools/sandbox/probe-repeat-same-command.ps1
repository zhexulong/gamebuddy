param(
    [string]$Root = 'C:\gb-repeat-matrix',
    [int]$TimeoutSeconds = 90,
    [int]$BetweenSeconds = 12,
    [string[]]$Commands = @('echo-redirect')
)

$ErrorActionPreference = 'Continue'

# Control experiment for the previous matrix.
#
# That matrix showed the FIRST case producing a file and the next four producing nothing. Two
# explanations fit: (a) the command shapes are wrong, or (b) only the first sandbox of a run can get a
# session, and every later one is refused - which the harness would have reported as "the command did
# not run". This repeats ONE known-good command several times. If the later repetitions also produce
# nothing, then the matrix was measuring session exhaustion, not command validity, and its conclusion
# about `&amp;`/powershell was wrong.
$shapes = @{
    'echo-redirect' = 'cmd.exe /c "echo ran > C:\share\a.txt"'
    'echo-redirect-2' = 'cmd.exe /c "echo ran2 > C:\share\z2.txt"'
    'echo-and' = 'cmd.exe /c "echo one > C:\share\b1.txt &amp; echo two > C:\share\b2.txt"'
}

$observations = New-Object System.Collections.Generic.List[object]
$round = 0

foreach ($name in $Commands) {
    $round++
    $command = $shapes[$name]
    $root = Join-Path $Root ("r$round")
    if (Test-Path -LiteralPath $root) { Remove-Item -Recurse -Force -LiteralPath $root }
    New-Item -ItemType Directory -Force -Path $root | Out-Null

    $wsb = Join-Path $root 'x.wsb'
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
    <Command>__COMMAND__</Command>
  </LogonCommand>
</Configuration>
'@
    $xml = $xml.Replace('__ROOT__', $root).Replace('__COMMAND__', $command)
    [System.IO.File]::WriteAllText($wsb, $xml, (New-Object System.Text.UTF8Encoding($false)))

    # Close whatever is running, and record what the pool looked like BEFORE this round: that number is
    # the fact that explains a silent round.
    Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match '^WindowsSandbox' } |
        ForEach-Object { try { Stop-Process -Id $_.Id -Force -ErrorAction Stop } catch {} }
    Start-Sleep -Seconds $BetweenSeconds
    $sessionsBefore = @(Get-Process -ErrorAction SilentlyContinue -Name 'WindowsSandboxRemoteSession').Count
    $vmwpBefore = @(Get-Process -ErrorAction SilentlyContinue -Name 'vmwp').Count

    $started = Get-Date
    $launcher = Start-Process -FilePath 'C:\Windows\System32\WindowsSandbox.exe' -ArgumentList "`"$wsb`"" -PassThru -ErrorAction SilentlyContinue
    $launcherExit = 'running'
    if ($launcher) {
        if ($launcher.WaitForExit(5000)) { $launcherExit = "exit=$($launcher.ExitCode)" } else { $launcherExit = 'running' }
    }

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 3
        $any = @(Get-ChildItem -LiteralPath $root -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -ne 'x.wsb' })
        if ($any.Count -gt 0) { break }
    }
    $produced = @(Get-ChildItem -LiteralPath $root -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -ne 'x.wsb' } | ForEach-Object { $_.Name })
    $sessionsAfter = @(Get-Process -ErrorAction SilentlyContinue -Name 'WindowsSandboxRemoteSession').Count
    $elapsed = [math]::Round(((Get-Date) - $started).TotalSeconds)
    $observations.Add([pscustomobject]@{
        Round = $round
        Shape = $name
        SessionsBefore = $sessionsBefore
        VmwpBefore = $vmwpBefore
        Launcher = $launcherExit
        SessionsAfter = $sessionsAfter
        Produced = ($produced -join ',')
        Seconds = $elapsed
    })
    "round $round ($name): sessionsBefore=$sessionsBefore vmwpBefore=$vmwpBefore launcher=$launcherExit produced=[$($produced -join ',')] in ${elapsed}s"
}

'== summary =='
$observations | Format-Table -AutoSize | Out-String -Width 160

Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match '^WindowsSandbox' } |
    ForEach-Object { try { Stop-Process -Id $_.Id -Force -ErrorAction Stop } catch {} }
