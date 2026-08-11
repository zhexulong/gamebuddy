[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$Name)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Threading;
public static class RetainedAbandonFixture {
 public static Mutex RetainAbandoned(string name) {
  Mutex retained = new Mutex(false, name);
  var ready = new ManualResetEvent(false);
  var owner = new Thread(() => { retained.WaitOne(); ready.Set(); });
  owner.IsBackground = true;
  owner.Start();
  if (!ready.WaitOne(5000)) throw new Exception("owner_not_ready");
  if (!owner.Join(5000)) throw new Exception("owner_not_exited");
  return retained;
 }
}
'@
$mutex=[RetainedAbandonFixture]::RetainAbandoned($Name)
[Console]::Out.WriteLine('ready')
[Console]::Out.Flush()
try { while ([Console]::In.ReadLine() -ne $null) {} } finally { $mutex.Dispose() }
