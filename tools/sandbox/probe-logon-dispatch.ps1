param(
    [string]$Root = 'C:\gb-logon-vs'
)

$ErrorActionPreference = 'Continue'

# Two explanations for a guest desktop with no trace of the logon command:
#   A. the command runs and fails silently (mount race - what FINDINGS.md currently says), or
#   B. the command is never dispatched at all.
#
# The sandbox window shows a clean desktop with no console flash and no error dialog. That does not
# disprove A (a `cmd /c` that fails on a missing path can flash too briefly to see), so this probe makes
# the difference observable: the logon command writes into a directory that needs NO mapping at all -
# the guest's own C:\ root - and marks the desktop. If a file appears anywhere in the guest, the command
# was dispatched and the problem is only the share. If nothing appears anywhere, the command itself is
# not being run.
if (Test-Path -LiteralPath $Root) { Remove-Item -Recurse -Force -LiteralPath $Root }
New-Item -ItemType Directory -Force -Path $Root | Out-Null

$wsb = Join-Path $Root 'v.wsb'
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
    <Command>cmd.exe /c "echo dispatched > C:\logon-proof.txt &amp; echo dispatched-desktop > %USERPROFILE%\Desktop\logon-proof.txt &amp; ping -n 30 127.0.0.1 >nul"</Command>
  </LogonCommand>
</Configuration>
'@
$xml = $xml.Replace('__ROOT__', $Root)
[System.IO.File]::WriteAllText($wsb, $xml, (New-Object System.Text.UTF8Encoding($false)))
"wsb: $wsb"
Get-Content $wsb | Out-String

Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match '^WindowsSandbox' } |
    ForEach-Object { try { Stop-Process -Id $_.Id -Force -ErrorAction Stop } catch {} }
Start-Sleep -Seconds 20

Start-Process -FilePath 'C:\Windows\System32\WindowsSandbox.exe' -ArgumentList "`"$wsb`"" | Out-Null
"launched; the command keeps a console open for ~30s so it is visible in a capture"

# Give the guest time to log on, then capture the window while the console should still be on screen.
Start-Sleep -Seconds 45
& (Join-Path $PSScriptRoot 'capture-sandbox-window.ps1') -Output (Join-Path $Root 'during.png') | Out-String

# And check the share for any sign.
Start-Sleep -Seconds 60
'== share contents =='
Get-ChildItem -LiteralPath $Root -ErrorAction SilentlyContinue | Select-Object Name, Length, LastWriteTime |
    Format-Table -AutoSize | Out-String -Width 120
