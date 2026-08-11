[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'windows_named_mutex_required' }

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Threading;
namespace GameBuddy.NamedMutexBroker {
 public sealed class Store : IDisposable {
  sealed class Held {
   public readonly string TargetId; public readonly Mutex Mutex; public readonly bool WasAbandoned;
   public readonly AutoResetEvent Release=new AutoResetEvent(false); public readonly AutoResetEvent Seal=new AutoResetEvent(false);
   public readonly ManualResetEvent OwnerExited=new ManualResetEvent(false); public volatile bool Sealed;
   public Held(string targetId, Mutex mutex, bool wasAbandoned) { TargetId=targetId; Mutex=mutex; WasAbandoned=wasAbandoned; }
  }
  sealed class Pending { public readonly string Name; public readonly CancellationTokenSource Cancel=new CancellationTokenSource(); public readonly ManualResetEvent Completed=new ManualResetEvent(false); public Pending(string name) { Name=name; } }
  sealed class TerminalRecord { public readonly string Name; public readonly string State; public TerminalRecord(string name,string state) { Name=name; State=state; } }
  readonly Dictionary<string,Held> held=new Dictionary<string,Held>(); readonly Dictionary<string,Held> sealedHeld=new Dictionary<string,Held>(); readonly Dictionary<string,Pending> pending=new Dictionary<string,Pending>(); bool sealing; readonly Dictionary<string,TerminalRecord> terminals=new Dictionary<string,TerminalRecord>(); readonly Queue<string> terminalOrder=new Queue<string>(); readonly object gate=new object(); static readonly object output=new object(); const int WaitMs=1000; const int CancelWaitMs=5000; const int MaxTerminalRecords=128;
  static void Reply(string id,bool ok,string code,string targetId=null,string name=null,string terminal=null) { lock(output) { var suffix=targetId==null ? "" : ",\"targetId\":\""+targetId+"\",\"name\":\""+name+"\",\"terminal\":\""+terminal+"\""; Console.Out.WriteLine("{\"id\":\""+id+"\",\"ok\":"+(ok?"true":"false")+",\"code\":\""+code+"\""+suffix+"}"); Console.Out.Flush(); } }
  void Terminal(string id,string name,string state) { lock(gate) { terminals[id]=new TerminalRecord(name,state); terminalOrder.Enqueue(id); while(terminalOrder.Count>MaxTerminalRecords) { var expired=terminalOrder.Dequeue(); terminals.Remove(expired); } Pending p; if(pending.TryGetValue(id,out p)) { pending.Remove(id); p.Completed.Set(); p.Cancel.Dispose(); } } }
  bool TerminalHeld(string id,string name,Held h,Pending p) { lock(gate) { if(p.Cancel.IsCancellationRequested) { Held current; if(held.TryGetValue(name,out current) && Object.ReferenceEquals(current,h)) held.Remove(name); return false; } pending.Remove(id); p.Completed.Set(); p.Cancel.Dispose(); return true; } }
  void CancelledAfterAcquire(string id,string name,Mutex mutex) { try { mutex.ReleaseMutex(); } catch {} try { mutex.Dispose(); } catch {} Terminal(id,name,"cancelled"); Reply(id,false,"cancelled"); }
  public void BeginAcquire(string id,string name,int timeoutMs) {
   var p=new Pending(name); lock(gate) { if(sealing) { Reply(id,false,"acquire_failed"); return; } pending.Add(id,p); }
   var thread=new Thread(() => AcquireOnDedicatedThread(id,name,timeoutMs,p)); thread.IsBackground=true; thread.Name="GameBuddyNamedMutexOwner"; thread.Start();
  }
  void AcquireOnDedicatedThread(string id,string name,int timeoutMs,Pending p) {
   Mutex mutex=null; Held h=null; bool added=false;
   try {
    mutex=new Mutex(false,name); var started=Environment.TickCount; bool acquired=false; bool abandoned=false;
    while(!p.Cancel.IsCancellationRequested) {
     try { if(mutex.WaitOne(50)) { acquired=true; break; } }
     catch(AbandonedMutexException) { acquired=true; abandoned=true; break; }
     if(unchecked(Environment.TickCount-started)>=timeoutMs) break;
    }
    if(p.Cancel.IsCancellationRequested) { Reply(id,false,"cancelled"); Terminal(id,name,"cancelled"); return; }
    if(!acquired) { Reply(id,true,"timeout"); Terminal(id,name,"timeout"); return; }
    lock(gate) { if(p.Cancel.IsCancellationRequested || held.ContainsKey(name) || sealedHeld.ContainsKey(name)) { CancelledAfterAcquire(id,name,mutex); mutex=null; return; } h=new Held(id,mutex,abandoned); held.Add(name,h); added=true; }
    if(!TerminalHeld(id,name,h,p)) { added=false; CancelledAfterAcquire(id,name,mutex); mutex=null; return; }
    Reply(id,true,abandoned?"abandoned":"acquired"); mutex=null; HoldUntilReleased(name,h);
   } catch { if(added && h!=null) Rollback(name,h); Reply(id,false,"acquire_failed"); Terminal(id,name,"failed"); }
   finally { if(mutex!=null) { try { mutex.Dispose(); } catch {} } }
  }
  void HoldUntilReleased(string name,Held h) {
   try {
    var signalled=WaitHandle.WaitAny(new WaitHandle[] {h.Release,h.Seal});
    if(signalled==1) return;
    try { h.Mutex.ReleaseMutex(); } finally { h.Mutex.Dispose(); h.OwnerExited.Set(); }
   } catch { if(!h.Sealed) Rollback(name,h); }
   finally { if(h.Sealed) h.OwnerExited.Set(); }
  }
  void Rollback(string name,Held h) { lock(gate) { Held current; if(held.TryGetValue(name,out current) && Object.ReferenceEquals(current,h)) held.Remove(name); } try { h.Mutex.ReleaseMutex(); } catch {} try { h.Mutex.Dispose(); } catch {} try { h.OwnerExited.Set(); } catch {} }
  public string Cancel(string id,string name) { Pending p=null; lock(gate) { if(pending.TryGetValue(id,out p)) { if(p.Name!=name) return "failed"; p.Cancel.Cancel(); } else { Held h; if(held.TryGetValue(name,out h) && h.TargetId==id) return "held"; TerminalRecord terminal; if(!terminals.TryGetValue(id,out terminal) || terminal.Name!=name) return "failed"; terminals.Remove(id); return terminal.State; } } if(!p.Completed.WaitOne(CancelWaitMs)) return "failed"; lock(gate) { Held h; if(held.TryGetValue(name,out h) && h.TargetId==id) return "held"; TerminalRecord terminal; if(!terminals.TryGetValue(id,out terminal) || terminal.Name!=name) return "failed"; terminals.Remove(id); return terminal.State; } }
  public bool Release(string name) { Held h; lock(gate) { if(!held.TryGetValue(name,out h)) return false; held.Remove(name); } h.Release.Set(); if(!h.OwnerExited.WaitOne(WaitMs)) { Rollback(name,h); return false; } h.Release.Dispose(); h.Seal.Dispose(); h.OwnerExited.Dispose(); return true; }
  public string SafetySeal(string targetId,string name) { Held h; lock(gate) { if(sealing || pending.Count!=0 || held.Count!=1 || !held.TryGetValue(name,out h) || h.TargetId!=targetId || !h.WasAbandoned || h.Sealed) return "failed"; sealing=true; h.Sealed=true; held.Remove(name); sealedHeld.Add(name,h); } h.Seal.Set(); if(!h.OwnerExited.WaitOne(WaitMs)) return "failed"; return "safety_sealed"; }
  public void Dispose() { string[] names; lock(gate) names=new List<string>(held.Keys).ToArray(); foreach(var name in names) Release(name); /* sealedHeld deliberately retains its native handles until sidecar process exit */ }
 }
}
'@
$store=[GameBuddy.NamedMutexBroker.Store]::new()
function Write-Reply([string]$id,[bool]$ok,[string]$code,[string]$targetId=$null,[string]$name=$null,[string]$terminal=$null) { $reply=[ordered]@{id=$id;ok=$ok;code=$code}; if(-not [string]::IsNullOrEmpty($targetId)){$reply.targetId=$targetId;$reply.name=$name;$reply.terminal=$terminal}; [Console]::Out.WriteLine(($reply|ConvertTo-Json -Compress));[Console]::Out.Flush() }
function Valid-Name([object]$name) { return $name -is [string] -and $name.StartsWith('Local\GameBuddy.Host.') -and $name.Substring(21) -match '^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$' }
try { while (($line=[Console]::In.ReadLine()) -ne $null) { if($line.Length -gt 4096){Write-Reply '' $false 'protocol_line_too_long';continue}; try{$request=$line|ConvertFrom-Json -ErrorAction Stop}catch{Write-Reply '' $false 'invalid_protocol_json';continue}; $properties=@($request.PSObject.Properties);$names=@($properties|ForEach-Object{$_.Name}); if($null -eq $request -or $names -notcontains 'id' -or $names -notcontains 'op' -or $names -notcontains 'name' -or $names -notcontains 'timeoutMs'){Write-Reply '' $false 'invalid_protocol_shape';continue}; if($request.id -isnot [string] -or $request.id -notmatch '^[a-f0-9-]{36}$'){Write-Reply '' $false 'invalid_protocol_id';continue}; if(-not(Valid-Name $request.name)){Write-Reply $request.id $false 'invalid_mutex_name';continue}; if($request.op -eq 'acquire'){if($properties.Count -ne 4 -or $request.timeoutMs -isnot [int] -or $request.timeoutMs -lt 0 -or $request.timeoutMs -gt 30000){Write-Reply $request.id $false 'invalid_timeout';continue};$store.BeginAcquire($request.id,$request.name,$request.timeoutMs)} elseif($request.op -eq 'cancel'){if($properties.Count -ne 5 -or $request.timeoutMs -ne 0 -or $request.targetId -isnot [string]){Write-Reply $request.id $false 'invalid_cancel_request';continue};$terminal=$store.Cancel($request.targetId,$request.name);Write-Reply $request.id $true 'cancelled' $request.targetId $request.name $terminal} elseif($request.op -eq 'release'){if($properties.Count -ne 4 -or $request.timeoutMs -ne 0){Write-Reply $request.id $false 'invalid_release_request';continue};if($store.Release($request.name)){Write-Reply $request.id $true 'released'}else{Write-Reply $request.id $false 'not_held'}} elseif($request.op -eq 'safety_seal'){if($properties.Count -ne 5 -or $request.timeoutMs -ne 0 -or $request.targetId -isnot [string]){Write-Reply $request.id $false 'invalid_safety_seal_request';continue};$result=$store.SafetySeal($request.targetId,$request.name);Write-Reply $request.id ($result -eq 'safety_sealed') $result $request.targetId $request.name 'sealed'} else{Write-Reply $request.id $false 'invalid_protocol_operation'} } } finally { $store.Dispose() }
