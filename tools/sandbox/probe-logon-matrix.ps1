param(
    [string]$Root = 'C:\gb-logon-matrix',
    [int]$TimeoutSeconds = 120,
    [int]$BetweenSeconds = 20
)

$ErrorActionPreference = 'Continue'

# Which LogonCommand shapes does this platform actually execute?
#
# Established so far: `cmd.exe /c "echo guest-ran > C:\share\guest-marker.txt"` runs (guest wrote the
# file 15s after launch). A command containing `&amp;` plus a powershell invocation produced nothing at
# all - not even its first echo. That is not a quoting problem, so the variable is the command's
# shape. This runs each shape in its own sandbox and reports which ones fire, which is the fact the
# bus design has to be built on rather than guessed at.
$cases = @(
    @{ Name = 'echo-redirect';            Command = 'cmd.exe /c "echo ran > C:\share\a.txt"' }
    @{ Name = 'two-commands-amp';         Command = 'cmd.exe /c "echo one > C:\share\b1.txt &amp; echo two > C:\share\b2.txt"' }
    @{ Name = 'powershell-simple';        Command = 'powershell.exe -NoProfile -Command "New-Item -Path C:\share\c.txt -ItemType File -Force"' }
    @{ Name = 'cmd-then-powershell';      Command = 'cmd.exe /c "echo pre > C:\share\d0.txt &amp; powershell.exe -NoProfile -ExecutionPolicy Bypass -Command \"New-Item -Path C:\share\d1.txt -ItemType File -Force\""' }
    @{ Name = 'powershell-file-cmd';      Command = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\share\hello.ps1' }
)

$results = New-Object System.Collections.Generic.List[object]

foreach ($case in $cases) {
    $name = $case.Name
    $root = Join-Path $Root $name
    if (Test-Path -LiteralPath $root) { Remove-Item -Recurse -Force -LiteralPath $root }
    New-Item -ItemType Directory -Force -Path $root | Out-Null
    Set-Content -LiteralPath (Join-Path $root 'hello.ps1') -Value 'Set-Content -Path C:\share\e.txt -Value hello' -Encoding UTF8

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
    $xml = $xml.Replace('__ROOT__', $root).Replace('__COMMAND__', $case.Command)
    [System.IO.File]::WriteAllText($wsb, $xml, (New-Object System.Text.UTF8Encoding($false)))

    Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match '^WindowsSandbox' } |
        ForEach-Object { try { Stop-Process -Id $_.Id -Force -ErrorAction Stop } catch {} }
    Start-Sleep -Seconds $BetweenSeconds

    $started = Get-Date
    Start-Process -FilePath 'C:\Windows\System32\WindowsSandbox.exe' -ArgumentList "`"$wsb`"" | Out-Null

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 3
        $written = @(Get-ChildItem -LiteralPath $root -File -ErrorAction SilentlyContinue | Where-Object { $_.Extension -in @('.txt', '.ps1') -eq $false -or $_.Name -ne 'hello.ps1' -and $_.Name -ne 'x.wsb' })
        $any = @(Get-ChildItem -LiteralPath $root -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -notin @('hello.ps1', 'x.wsb') })
        if ($any.Count -gt 0) { break }
    }
    $produced = @(Get-ChildItem -LiteralPath $root -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -notin @('hello.ps1', 'x.wsb') } | ForEach-Object { $_.Name })
    $elapsed = [math]::Round(((Get-Date) - $started).TotalSeconds)
    $results.Add([pscustomobject]@{ Case = $name; Produced = ($produced -join ','); Seconds = $elapsed })
    "{0,-22} produced=[{1}] after {2}s" -f $name, ($produced -join ','), $elapsed
}

'== summary =='
$results | Format-Table -AutoSize | Out-String -Width 140

Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match '^WindowsSandbox' } |
    ForEach-Object { try { Stop-Process -Id $_.Id -Force -ErrorAction Stop } catch {} }
