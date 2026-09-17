[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('list', 'probe', 'play', 'stream')]
    [string]$Mode,
    [string]$Device = 'default',
    [string]$PcmPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($env:OS -ne 'Windows_NT') { throw 'windows_audio_required' }
if ($Device -eq 'default') { $deviceId = -1 }
elseif ($Device -match '^waveout:([0-9]{1,4})$') { $deviceId = [int]$Matches[1] }
else { throw 'invalid_windows_output_device' }
if ($Mode -eq 'play' -and ([string]::IsNullOrWhiteSpace($PcmPath) -or -not (Test-Path -LiteralPath $PcmPath -PathType Leaf))) { throw 'pcm_file_required' }

if (-not ('GameBuddyWaveOut.Native' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;

namespace GameBuddyWaveOut {
  public static class Native {
    [StructLayout(LayoutKind.Sequential)] public struct WAVEFORMATEX {
      public ushort wFormatTag, nChannels; public uint nSamplesPerSec, nAvgBytesPerSec; public ushort nBlockAlign, wBitsPerSample, cbSize;
    }
    [StructLayout(LayoutKind.Sequential)] public struct WAVEHDR {
      public IntPtr lpData; public uint dwBufferLength, dwBytesRecorded; public IntPtr dwUser; public uint dwFlags, dwLoops; public IntPtr lpNext, reserved;
    }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Auto)] public struct WAVEOUTCAPS {
      public ushort wMid, wPid; public uint vDriverVersion; [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string szPname; public uint dwFormats; public ushort wChannels, wReserved1; public uint dwSupport;
    }
    [DllImport("winmm.dll")] public static extern uint waveOutGetNumDevs();
    [DllImport("winmm.dll", CharSet=CharSet.Auto)] public static extern uint waveOutGetDevCaps(IntPtr uDeviceID, out WAVEOUTCAPS caps, uint size);
    [DllImport("winmm.dll")] public static extern uint waveOutOpen(out IntPtr hwo, int deviceId, ref WAVEFORMATEX format, IntPtr callback, IntPtr instance, uint flags);
    [DllImport("winmm.dll")] public static extern uint waveOutPrepareHeader(IntPtr hwo, ref WAVEHDR header, uint size);
    [DllImport("winmm.dll")] public static extern uint waveOutWrite(IntPtr hwo, ref WAVEHDR header, uint size);
    [DllImport("winmm.dll")] public static extern uint waveOutUnprepareHeader(IntPtr hwo, ref WAVEHDR header, uint size);
    [DllImport("winmm.dll")] public static extern uint waveOutReset(IntPtr hwo);
    [DllImport("winmm.dll")] public static extern uint waveOutClose(IntPtr hwo);
    const uint WHDR_DONE = 0x00000001;
    static WAVEFORMATEX Format() { return new WAVEFORMATEX { wFormatTag=1, nChannels=1, nSamplesPerSec=16000, nAvgBytesPerSec=32000, nBlockAlign=2, wBitsPerSample=16, cbSize=0 }; }
    static void Check(uint result, string operation) { if (result != 0) throw new InvalidOperationException(operation + "_" + result); }
    public static string[] List() {
      uint count=waveOutGetNumDevs(); var values=new string[count];
      for (uint i=0;i<count;i++) { WAVEOUTCAPS caps; Check(waveOutGetDevCaps((IntPtr)i,out caps,(uint)Marshal.SizeOf(typeof(WAVEOUTCAPS))),"waveout_get_caps"); values[i] = "waveout:"+i+"|"+(caps.szPname ?? "unknown"); }
      return values;
    }
    static bool ReadExact(Stream input, byte[] buffer, int count) {
      int offset = 0;
      while (offset < count) {
        int read = input.Read(buffer, offset, count - offset);
        if (read <= 0) return false;
        offset += read;
      }
      return true;
    }
    // Resident-stream render: the device opens once and stays open while PCM
    // frames arrive on stdin as [4-byte LE length][PCM16 bytes]. A length of 0
    // signals stop: the device is reset and released. This is the structure
    // reference repos use (devices stay open; frames stream in), which makes
    // 20ms micro-chunk playback and prompt barge-in physically possible.
    public static void Stream(int deviceId, Stream input) {
      IntPtr hwo = IntPtr.Zero;
      var format = Format();
      Check(waveOutOpen(out hwo, deviceId, ref format, IntPtr.Zero, IntPtr.Zero, 0), "waveout_stream_open");
      try {
        byte[] lengthBytes = new byte[4];
        for (;;) {
          if (!ReadExact(input, lengthBytes, 4)) break; // EOF = stop
          int length = BitConverter.ToInt32(lengthBytes, 0);
          if (length == 0) break; // explicit stop frame
          if (length < 0 || length % 2 != 0 || length > 1920000) throw new InvalidOperationException("invalid_pcm16_frame");
          byte[] audio = new byte[length];
          if (!ReadExact(input, audio, length)) throw new InvalidOperationException("truncated_pcm16_frame");
          GCHandle handle = GCHandle.Alloc(audio, GCHandleType.Pinned);
          WAVEHDR header = new WAVEHDR();
          bool prepared = false;
          try {
            header.lpData = handle.AddrOfPinnedObject();
            header.dwBufferLength = (uint)audio.Length;
            Check(waveOutPrepareHeader(hwo, ref header, (uint)Marshal.SizeOf(typeof(WAVEHDR))), "waveout_stream_prepare");
            prepared = true;
            Check(waveOutWrite(hwo, ref header, (uint)Marshal.SizeOf(typeof(WAVEHDR))), "waveout_stream_write");
            var deadline = DateTime.UtcNow.AddMilliseconds(Math.Max(5000, (audio.Length / 32) + 3000));
            while ((header.dwFlags & WHDR_DONE) == 0 && DateTime.UtcNow < deadline) System.Threading.Thread.Sleep(5);
            if ((header.dwFlags & WHDR_DONE) == 0) throw new TimeoutException("waveout_stream_playback_timeout");
          } finally {
            if (hwo != IntPtr.Zero) { if (prepared) waveOutUnprepareHeader(hwo, ref header, (uint)Marshal.SizeOf(typeof(WAVEHDR))); if (handle.IsAllocated) handle.Free(); }
          }
        }
      } finally {
        if (hwo != IntPtr.Zero) { waveOutReset(hwo); waveOutClose(hwo); }
      }
    }
    public static void ProbeOrPlay(int deviceId, string path, bool probe) {
      byte[] audio = probe ? new byte[320] : File.ReadAllBytes(path);
      if (audio.Length == 0 || audio.Length % 2 != 0 || audio.Length > 1920000) throw new InvalidOperationException("invalid_pcm16_audio");
      IntPtr hwo=IntPtr.Zero; GCHandle handle=default(GCHandle); WAVEHDR header=new WAVEHDR(); bool prepared=false;
      try {
        var format=Format(); Check(waveOutOpen(out hwo,deviceId,ref format,IntPtr.Zero,IntPtr.Zero,0),"waveout_open");
        handle=GCHandle.Alloc(audio,GCHandleType.Pinned); header.lpData=handle.AddrOfPinnedObject(); header.dwBufferLength=(uint)audio.Length;
        Check(waveOutPrepareHeader(hwo,ref header,(uint)Marshal.SizeOf(typeof(WAVEHDR))),"waveout_prepare"); prepared=true;
        Check(waveOutWrite(hwo,ref header,(uint)Marshal.SizeOf(typeof(WAVEHDR))),"waveout_write");
        var deadline=DateTime.UtcNow.AddMilliseconds(Math.Max(5000, (audio.Length/32)+3000));
        while ((header.dwFlags & WHDR_DONE)==0 && DateTime.UtcNow < deadline) System.Threading.Thread.Sleep(5);
        if ((header.dwFlags & WHDR_DONE)==0) throw new TimeoutException("waveout_playback_timeout");
      } finally {
        if (hwo!=IntPtr.Zero) { waveOutReset(hwo); if (prepared) waveOutUnprepareHeader(hwo,ref header,(uint)Marshal.SizeOf(typeof(WAVEHDR))); waveOutClose(hwo); }
        if (handle.IsAllocated) handle.Free();
      }
    }
  }
}
'@
}

if ($Mode -eq 'list') {
    [GameBuddyWaveOut.Native]::List() | ForEach-Object {
        $id, $name = $_ -split '\|', 2
        [pscustomobject]@{ id = $id; name = $name }
    } | ConvertTo-Json -Compress
    exit 0
}

if ($Mode -eq 'stream') {
    $stdin = [Console]::OpenStandardInput()
    [GameBuddyWaveOut.Native]::Stream($deviceId, $stdin)
    [pscustomobject]@{ state = 'stopped'; mode = 'stream'; device = $Device } | ConvertTo-Json -Compress
    exit 0
}

[GameBuddyWaveOut.Native]::ProbeOrPlay($deviceId, $PcmPath, $Mode -eq 'probe')
[pscustomobject]@{ state = 'passed'; mode = $Mode; device = $Device } | ConvertTo-Json -Compress
