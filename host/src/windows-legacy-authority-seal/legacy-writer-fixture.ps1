param(
  [Parameter(Mandatory = $true)][string]$Root,
  [Parameter(Mandatory = $true)][string]$PipeName,
  [Parameter(Mandatory = $true)][string]$Nonce,
  [string]$ProtocolNoise,
  [string]$StartupNoise
)
$ErrorActionPreference = 'Stop'
$Protocol = 'gamebuddy.windows-legacy-authority-seal/v1'

function Reply([hashtable]$Value) {
  $Value.protocol = $Protocol
  $Value.nonce = $Nonce
  $writer.WriteLine(($Value | ConvertTo-Json -Compress))
}
function PathFor([string]$Name) { Join-Path $Root $Name }
function Attempt([scriptblock]$Operation) {
  try { & $Operation; Reply @{ ok = $true; code = 'ok' } }
  catch { Reply @{ ok = $false; code = $_.Exception.GetType().Name; message = $_.Exception.Message } }
}
function CurrentUserRule([System.Security.AccessControl.FileSystemRights]$Rights, [System.Security.AccessControl.AccessControlType]$Type) {
  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  [System.Security.AccessControl.FileSystemAccessRule]::new($identity, $Rights, $Type)
}
function SetControlledAcl([bool]$DenyWrite) {
  $security = [System.Security.AccessControl.DirectorySecurity]::new()
  $security.SetAccessRuleProtection($true, $false)
  $security.AddAccessRule((CurrentUserRule ([System.Security.AccessControl.FileSystemRights]::FullControl) ([System.Security.AccessControl.AccessControlType]::Allow)))
  if ($DenyWrite) {
    $writeRights = [System.Security.AccessControl.FileSystemRights]::CreateFiles -bor [System.Security.AccessControl.FileSystemRights]::AppendData -bor [System.Security.AccessControl.FileSystemRights]::WriteData
    $security.AddAccessRule((CurrentUserRule $writeRights ([System.Security.AccessControl.AccessControlType]::Deny)))
  }
  [IO.Directory]::SetAccessControl($Root, $security)
}
function RestoreHeldControlledAllow() {
  $path = PathFor 'held.txt'
  if (-not [IO.File]::Exists($path)) { return }
  $security = [System.Security.AccessControl.FileSecurity]::new()
  $security.SetAccessRuleProtection($true, $false)
  $security.AddAccessRule((CurrentUserRule ([System.Security.AccessControl.FileSystemRights]::FullControl) ([System.Security.AccessControl.AccessControlType]::Allow)))
  [IO.File]::SetAccessControl($path, $security)
}

# This is deliberately an independent legacy process. Its held FileStream models
# a writer that acquired GENERIC_WRITE before a later DACL change. Protocol traffic
# uses a dedicated pipe: PowerShell host output must never be treated as a reply.
$pipe = [IO.Pipes.NamedPipeClientStream]::new('.', $PipeName, [IO.Pipes.PipeDirection]::InOut, [IO.Pipes.PipeOptions]::None)
$pipe.Connect(10000)
$utf8NoBom = [Text.UTF8Encoding]::new($false)
$reader = [IO.StreamReader]::new($pipe, $utf8NoBom, $false, 1024, $true)
$writer = [IO.StreamWriter]::new($pipe, $utf8NoBom, 1024, $true)
$writer.AutoFlush = $true
$originalAcl = [IO.Directory]::GetAccessControl($Root)
$held = $null
if ($PSBoundParameters.ContainsKey('ProtocolNoise')) { $writer.WriteLine($ProtocolNoise) }
Reply @{ ok = $true; code = 'ready'; pid = $PID }
if ($PSBoundParameters.ContainsKey('StartupNoise')) { [Console]::Out.WriteLine($StartupNoise) }
while (($line = $reader.ReadLine()) -ne $null) {
  try { $request = $line | ConvertFrom-Json } catch { Reply @{ ok = $false; code = 'bad_json' }; continue }
  switch ($request.op) {
    'write' { Attempt { [IO.File]::WriteAllText((PathFor 'legacy.txt'), 'write') } }
    'append' { Attempt { [IO.File]::AppendAllText((PathFor 'legacy.txt'), 'append') } }
    'create' { Attempt { [IO.File]::WriteAllText((PathFor 'created.txt'), 'created') } }
    'delete' { Attempt { Remove-Item -LiteralPath (PathFor 'legacy.txt') -Force } }
    'rename' { Attempt { Move-Item -LiteralPath (PathFor 'legacy.txt') -Destination (PathFor 'renamed.txt') -Force } }
    'openHeld' {
      try { $held = [IO.File]::Open((PathFor 'held.txt'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete)); $held.SetLength(0); Reply @{ ok = $true; code = 'ok' } }
      catch { Reply @{ ok = $false; code = $_.Exception.GetType().Name; message = $_.Exception.Message } }
    }
    'writeHeld' { Attempt { if ($null -eq $held) { throw 'held_handle_not_open' }; $bytes = [Text.Encoding]::UTF8.GetBytes('still-authorized'); $held.Position = 0; $held.Write($bytes, 0, $bytes.Length); $held.Flush() } }
    'denyControlledWrite' { Attempt { SetControlledAcl $true } }
    'restoreControlledAllow' { Attempt { SetControlledAcl $false; RestoreHeldControlledAllow } }
    'restoreOriginalAcl' { Attempt { [IO.Directory]::SetAccessControl($Root, $originalAcl) } }
    'close' { if ($null -ne $held) { $held.Dispose(); $held = $null }; Reply @{ ok = $true; code = 'closed' } }
    default { Reply @{ ok = $false; code = 'unknown_op' } }
  }
}
if ($null -ne $held) { $held.Dispose() }
$writer.Dispose()
$reader.Dispose()
$pipe.Dispose()
