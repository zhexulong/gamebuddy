[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('list', 'probe', 'capture', 'stop')]
    [string]$Mode,
    [string]$Device = 'default',
    [string]$PcmPath,
    [string]$ReadyPath,
    [string]$ReceiptPath,
    [string]$EventName,
    [int]$MaxDurationMs = 30000
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'windows_audio_required' }
if ($Device -eq 'default') { $deviceId = -1 }
elseif ($Device -match '^wavein:([0-9]{1,4})$') { $deviceId = [int]$Matches[1] }
else { throw 'invalid_windows_input_device' }
if ($Mode -in @('capture', 'stop') -and [string]::IsNullOrWhiteSpace($EventName)) { throw 'capture_event_required' }
if ($Mode -eq 'capture' -and ([string]::IsNullOrWhiteSpace($PcmPath) -or [string]::IsNullOrWhiteSpace($ReadyPath) -or [string]::IsNullOrWhiteSpace($ReceiptPath) -or [string]::IsNullOrWhiteSpace([IO.Path]::GetDirectoryName($PcmPath)))) { throw 'capture_path_required' }
if ($MaxDurationMs -lt 100 -or $MaxDurationMs -gt 60000) { throw 'invalid_capture_duration' }

if (-not ('GameBuddyWaveIn.Native' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

namespace GameBuddyWaveIn {
  public static class Native {
    [StructLayout(LayoutKind.Sequential)] public struct WAVEFORMATEX { public ushort wFormatTag,nChannels; public uint nSamplesPerSec,nAvgBytesPerSec; public ushort nBlockAlign,wBitsPerSample,cbSize; }
    [StructLayout(LayoutKind.Sequential)] public struct WAVEHDR { public IntPtr lpData; public uint dwBufferLength,dwBytesRecorded; public IntPtr dwUser; public uint dwFlags,dwLoops; public IntPtr lpNext,reserved; }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Auto)] public struct WAVEINCAPS { public ushort wMid,wPid; public uint vDriverVersion; [MarshalAs(UnmanagedType.ByValTStr,SizeConst=32)] public string szPname; public uint dwFormats; public ushort wChannels,wReserved1; }
    [DllImport("winmm.dll")] public static extern uint waveInGetNumDevs();
    [DllImport("winmm.dll",CharSet=CharSet.Auto)] public static extern uint waveInGetDevCaps(IntPtr id,out WAVEINCAPS caps,uint size);
    [DllImport("winmm.dll")] public static extern uint waveInOpen(out IntPtr handle,int device,ref WAVEFORMATEX format,IntPtr callback,IntPtr instance,uint flags);
    [DllImport("winmm.dll")] public static extern uint waveInGetID(IntPtr handle,out uint deviceId);
    [DllImport("winmm.dll")] public static extern uint waveInPrepareHeader(IntPtr handle,ref WAVEHDR header,uint size);
    [DllImport("winmm.dll")] public static extern uint waveInAddBuffer(IntPtr handle,ref WAVEHDR header,uint size);
    [DllImport("winmm.dll")] public static extern uint waveInStart(IntPtr handle);
    [DllImport("winmm.dll")] public static extern uint waveInStop(IntPtr handle);
    [DllImport("winmm.dll")] public static extern uint waveInReset(IntPtr handle);
    [DllImport("winmm.dll")] public static extern uint waveInUnprepareHeader(IntPtr handle,ref WAVEHDR header,uint size);
    [DllImport("winmm.dll")] public static extern uint waveInClose(IntPtr handle);
    const uint WHDR_DONE=1;
    static WAVEFORMATEX Format(){return new WAVEFORMATEX{wFormatTag=1,nChannels=1,nSamplesPerSec=16000,nAvgBytesPerSec=32000,nBlockAlign=2,wBitsPerSample=16,cbSize=0};}
    static void Check(uint r,string op){if(r!=0)throw new InvalidOperationException(op+"_"+r);}
    public static string[] List(){uint count=waveInGetNumDevs();var values=new string[count];for(uint i=0;i<count;i++){WAVEINCAPS c;Check(waveInGetDevCaps((IntPtr)i,out c,(uint)Marshal.SizeOf(typeof(WAVEINCAPS))),"wavein_get_caps");values[i]="wavein:"+i+"|"+(c.szPname??"unknown");}return values;}
    public static CaptureResult Capture(int device,string eventName,string readyPath,int milliseconds){
      var bytes=new byte[Math.Min(960000,Math.Max(3200,(milliseconds*32)+3200))]; IntPtr handle=IntPtr.Zero;GCHandle pin=default(GCHandle);WAVEHDR header=new WAVEHDR();bool prepared=false;
      try {var f=Format();Check(waveInOpen(out handle,device,ref f,IntPtr.Zero,IntPtr.Zero,0),"wavein_open");uint actualDevice;Check(waveInGetID(handle,out actualDevice),"wavein_get_id");WAVEINCAPS caps;Check(waveInGetDevCaps((IntPtr)actualDevice,out caps,(uint)Marshal.SizeOf(typeof(WAVEINCAPS))),"wavein_get_caps");pin=GCHandle.Alloc(bytes,GCHandleType.Pinned);header.lpData=pin.AddrOfPinnedObject();header.dwBufferLength=(uint)bytes.Length;Check(waveInPrepareHeader(handle,ref header,(uint)Marshal.SizeOf(typeof(WAVEHDR))),"wavein_prepare");prepared=true;Check(waveInAddBuffer(handle,ref header,(uint)Marshal.SizeOf(typeof(WAVEHDR))),"wavein_add_buffer");Check(waveInStart(handle),"wavein_start");
        File.WriteAllText(readyPath,"ready");
        using(var stop=new EventWaitHandle(false,EventResetMode.ManualReset,eventName)){ var deadline=DateTime.UtcNow.AddMilliseconds(milliseconds);while((header.dwFlags&WHDR_DONE)==0&&DateTime.UtcNow<deadline&&!stop.WaitOne(10)){} }
        Check(waveInStop(handle),"wavein_stop"); var count=(int)header.dwBytesRecorded;Check(waveInReset(handle),"wavein_reset");if(count<=0||count>bytes.Length||count%2!=0)throw new InvalidOperationException("wavein_no_pcm16");var output=new byte[count];Buffer.BlockCopy(bytes,0,output,0,count);return new CaptureResult{Bytes=output,DeviceId=actualDevice,DeviceName=caps.szPname??"unknown"};
      } finally {if(handle!=IntPtr.Zero){waveInReset(handle);if(prepared)waveInUnprepareHeader(handle,ref header,(uint)Marshal.SizeOf(typeof(WAVEHDR)));waveInClose(handle);}if(pin.IsAllocated)pin.Free();}
    }
    public sealed class CaptureResult { public byte[] Bytes; public uint DeviceId; public string DeviceName; }
    public static void Stop(string eventName){using(var stop=new EventWaitHandle(false,EventResetMode.ManualReset,eventName)){stop.Set();}}
  }
}
'@
}
if ($Mode -eq 'list') { [GameBuddyWaveIn.Native]::List() | ForEach-Object { $id,$name=$_ -split '\|',2; [pscustomobject]@{id=$id;name=$name} } | ConvertTo-Json -Compress; exit 0 }
if ($Mode -eq 'stop') { [GameBuddyWaveIn.Native]::Stop($EventName); [pscustomobject]@{state='stopped'}|ConvertTo-Json -Compress; exit 0 }
$event = if ($Mode -eq 'probe') { "GameBuddyWaveInProbe_$([Guid]::NewGuid().ToString('N'))" } else { $EventName }
$duration = if ($Mode -eq 'probe') { 250 } else { $MaxDurationMs }
$ready = if ($Mode -eq 'capture') { $ReadyPath } else { [IO.Path]::GetTempFileName() }
try { $capture=[GameBuddyWaveIn.Native]::Capture($deviceId,$event,$ready,$duration) }
finally { if ($Mode -eq 'probe') { Remove-Item -LiteralPath $ready -Force -ErrorAction SilentlyContinue } }
$receipt=[pscustomobject]@{state='passed';mode=$Mode;device=$Device;resolvedDeviceId=("wavein:"+$capture.DeviceId);resolvedDeviceName=$capture.DeviceName;pcm16Bytes=$capture.Bytes.Length}
if ($Mode -eq 'capture') { [IO.File]::WriteAllBytes($PcmPath,$capture.Bytes); [IO.File]::WriteAllText($ReceiptPath,($receipt|ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false)) }
$receipt|ConvertTo-Json -Compress
