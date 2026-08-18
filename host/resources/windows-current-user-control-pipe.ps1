[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$PipeName,[int]$FrameTimeoutMs=10000)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT' -or $PipeName -notmatch '^[A-Za-z0-9_-]{1,128}$' -or $FrameTimeoutMs -lt 100 -or $FrameTimeoutMs -gt 60000) { throw 'invalid_current_user_control_pipe' }
Add-Type -AssemblyName System.Core
$current = [System.Security.Principal.WindowsIdentity]::GetCurrent()
if ($null -eq $current.User) { throw 'current_user_sid_unavailable' }
$sid = $current.User
$security = [System.IO.Pipes.PipeSecurity]::new()
$security.SetAccessRuleProtection($true,$false)
$security.AddAccessRule([System.IO.Pipes.PipeAccessRule]::new($sid,[System.IO.Pipes.PipeAccessRights]::FullControl,[System.Security.AccessControl.AccessControlType]::Allow))

# Reads exactly one UTF-8 LF/CRLF framed line without ever materializing an
# unbounded string. The 16KiB payload buffer is the only frame accumulator;
# the single-byte read buffer and one permitted CR make the wire bound 16KiB
# plus its LF (or CRLF) terminator. One monotonic deadline applies to the
# whole frame, so a trickle client cannot renew its lease byte by byte. A
# timed-out read is never reused: caller fail-closes and disposes the pipe in
# finally, which releases that pending I/O.
function Read-BoundedUtf8Frame([System.IO.Pipes.NamedPipeServerStream]$Pipe,[int]$TimeoutMs) {
  $payload = New-Object byte[] 16384
  $oneByte = New-Object byte[] 1
  $count = 0
  $sawCr = $false
  $frameStopwatch = [System.Diagnostics.Stopwatch]::StartNew()
  while ($true) {
    # `Stopwatch` is monotonic. Recalculate the one frame's remaining budget
    # before every pending byte read; flooring never extends the deadline.
    $remainingMs = [int][Math]::Floor($TimeoutMs - $frameStopwatch.Elapsed.TotalMilliseconds)
    if ($remainingMs -le 0) { throw 'control_client_frame_timeout' }
    $read = $Pipe.ReadAsync($oneByte,0,1)
    if (-not $read.Wait($remainingMs)) { throw 'control_client_frame_timeout' }
    $readCount = $read.GetAwaiter().GetResult()
    if ($readCount -eq 0) {
      if ($count -eq 0 -and -not $sawCr) { return $null }
      throw 'control_client_frame_invalid'
    }
    $value = $oneByte[0]
    if ($sawCr) {
      if ($value -ne 10) { throw 'control_client_frame_invalid' }
      break
    }
    if ($value -eq 10) { break }
    if ($value -eq 13) {
      $sawCr = $true
      continue
    }
    if ($count -ge $payload.Length) { throw 'control_client_frame_invalid' }
    $payload[$count] = $value
    $count += 1
  }
  try {
    return [System.Text.UTF8Encoding]::new($false,$true).GetString($payload,0,$count)
  } catch {
    throw 'control_client_frame_invalid'
  }
}

function Emit([string]$connectionId,[object]$reply) { [Console]::Out.WriteLine((@{connectionId=$connectionId;reply=$reply}|ConvertTo-Json -Compress)); [Console]::Out.Flush() }
while ($true) {
  $pipe = $null
  $writer = $null
  try {
    $pipe = [System.IO.Pipes.NamedPipeServerStream]::new($PipeName,[System.IO.Pipes.PipeDirection]::InOut,1,[System.IO.Pipes.PipeTransmissionMode]::Byte,[System.IO.Pipes.PipeOptions]::Asynchronous,16384,16384,$security)
    $pipe.WaitForConnection()
    $connectionId = [guid]::NewGuid().ToString('N')
    $writer = [System.IO.StreamWriter]::new($pipe,[System.Text.UTF8Encoding]::new($false),16385,$true); $writer.AutoFlush=$true
    $sidValidated = $false
    while ($pipe.IsConnected) {
      $line = Read-BoundedUtf8Frame $pipe $FrameTimeoutMs
      # Only immediate peer EOF before any bytes is a normal per-client
      # disconnect. EOF after a partial frame is rejected by the reader.
      if ($null -eq $line) { break }
      if (-not $sidValidated) {
        # SID impersonation becomes available only after client data arrives;
        # revalidate strictly before forwarding the first non-null frame.
        $remoteSid = $null
        $pipe.RunAsClient([System.IO.Pipes.PipeStreamImpersonationWorker]{ $script:remoteSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value })
        if ($null -eq $remoteSid -or $remoteSid -ne $sid.Value) { throw 'client_sid_revalidation_failed' }
        $sidValidated = $true
      }
      # Blank, non-null frames deliberately reach the Host, whose strict
      # protocol validator seals this untrusted transport boundary.
      [Console]::Out.WriteLine((@{connectionId=$connectionId;line=$line}|ConvertTo-Json -Compress)); [Console]::Out.Flush()
      $response = [Console]::In.ReadLine()
      if ($null -eq $response) { throw 'control_broker_exit' }
      try { $envelope=$response|ConvertFrom-Json -ErrorAction Stop } catch { throw 'control_broker_frame_invalid' }
      if ($envelope.connectionId -ne $connectionId -or $null -eq $envelope.reply) { throw 'control_broker_frame_invalid' }
      $writer.WriteLine(($envelope.reply|ConvertTo-Json -Compress))
    }
  } finally {
    # A close can flush and fail after a normal peer disconnect. Disposal must
    # never replace a fail-closed exception or prevent the next accept cycle.
    foreach ($resource in @($writer,$pipe)) {
      if ($null -ne $resource) { try { $resource.Dispose() } catch {} }
    }
  }
}
