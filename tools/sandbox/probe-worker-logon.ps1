param(
    [string]$Root = 'C:\gb-worker-test',
    [int]$TimeoutSeconds = 240
)

$ErrorActionPreference = 'Continue'

# Isolate the last unknown: does the WORKER run when started by LogonCommand?
#
# Already proven: the guest boots, the share is mounted read-write, and `cmd /c "echo ... > file"`
# executes (guest wrote its marker 15s after launch). What has not been proven is that the worker
# script itself starts under the logon command. So this probe copies the real worker in and adds a
# first-line breadcrumb the worker cannot skip: a separate `cmd` that writes a file BEFORE powershell
# is invoked. If the breadcrumb appears but the ready file does not, the failure is inside the worker;
# if neither appears, the failure is in launching powershell from the logon command.
if (Test-Path -LiteralPath $Root) { Remove-Item -Recurse -Force -LiteralPath $Root }
foreach ($dir in @('', 'tasks', 'results', 'running')) {
    New-Item -ItemType Directory -Force -Path (Join-Path $Root $dir) | Out-Null
}
Copy-Item -Path (Join-Path $PSScriptRoot 'guest-worker.ps1') -Destination (Join-Path $Root 'guest-worker.ps1') -Force

$wsb = Join-Path $Root 'w.wsb'
$xml = @'
<Configuration>
  <MappedFolders>
    <MappedFolder>
      <HostFolder>__ROOT__</HostFolder>
      <SandboxFolder>C:\bus</SandboxFolder>
      <ReadOnly>false</ReadOnly>
    </MappedFolder>
  </MappedFolders>
  <Networking>Disable</Networking>
  <LogonCommand>
    <Command>cmd.exe /c "echo breadcrumb > C:\bus\breadcrumb.txt &amp; powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\bus\guest-worker.ps1"</Command>
  </LogonCommand>
</Configuration>
'@
$xml = $xml.Replace('__ROOT__', $Root)
[System.IO.File]::WriteAllText($wsb, $xml, (New-Object System.Text.UTF8Encoding($false)))

Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match '^WindowsSandbox' } |
    ForEach-Object { try { Stop-Process -Id $_.Id -Force -ErrorAction Stop } catch {} }
Start-Sleep -Seconds 8

$started = Get-Date
Start-Process -FilePath 'C:\Windows\System32\WindowsSandbox.exe' -ArgumentList "`"$wsb`"" | Out-Null
"launched $($started.ToString('HH:mm:ss'))"

$breadcrumb = Join-Path $Root 'breadcrumb.txt'
$ready = Join-Path $Root 'guest-ready.txt'
$errOut = Join-Path $Root 'worker-stderr.txt'
for ($i = 1; $i -le [math]::Ceiling($TimeoutSeconds / 3); $i++) {
    Start-Sleep -Seconds 3
    $b = Test-Path -LiteralPath $breadcrumb
    $r = Test-Path -LiteralPath $ready
    if ($b -or $r) { "t+$($i * 3)s breadcrumb=$b ready=$r" }
    if ($r) { break }
}

'== outcome =='
"breadcrumb (cmd ran):        $(Test-Path -LiteralPath $breadcrumb)"
"guest-ready (worker ran):    $(Test-Path -LiteralPath $ready)"
if (Test-Path -LiteralPath $ready) { Get-Content -LiteralPath $ready | ForEach-Object { "    $_" } }
'== share contents =='
Get-ChildItem -LiteralPath $Root | Select-Object Name, Length | Format-Table -AutoSize | Out-String -Width 100
