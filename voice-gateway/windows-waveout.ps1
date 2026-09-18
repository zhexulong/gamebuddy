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
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

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
    [DllImport("winmm.dll")] public static extern uint timeBeginPeriod(uint uPeriod);
    [DllImport("winmm.dll")] public static extern uint timeEndPeriod(uint uPeriod);
    const uint WHDR_DONE = 0x00000001;
    const uint CALLBACK_EVENT = 0x00050000;
    // The driver holds this event's handle across the whole playback lifetime;
    // a local SafeWaitHandle could be finalized mid-play (GC) and leave the
    // driver signalling a dead handle. Keep it rooted on the class.
    static AutoResetEvent s_doneEvent = new AutoResetEvent(false);
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
    static bool WaitDone(WAVEHDR[] headers, int slot, long freqTicksPerMs) {
      long deadlineMs = Math.Max(5000L, (headers[slot].dwBufferLength / 32L) + 3000L);
      long deadline = Stopwatch.GetTimestamp() + deadlineMs * freqTicksPerMs;
      // Distinguish "driver says done but event missed" from "not done yet".
      // Event wait precision on Windows can be coarse; a tight spin on the
      // authoritative WHDR_DONE flag keeps pacing exact (caller bounds CPU by
      // the 20ms audio duration).
      while ((headers[slot].dwFlags & WHDR_DONE) == 0) {
        if (s_doneEvent.WaitOne(0)) continue;
        System.Threading.Thread.SpinWait(64);
        if (Stopwatch.GetTimestamp() >= deadline) return false;
      }
      return true;
    }
    // Resident-stream render (callback-driven, jitter-buffered): the device
    // opens once and stays open while PCM frames arrive on stdin as
    // [4-byte LE length][PCM16 bytes]. A background thread reads stdin into a
    // bounded queue so TTS bursts are absorbed; the render loop submits 20ms
    // frames with CALLBACK_EVENT wakeups (the driver signals a manual-reset
    // event when a buffer finishes, instead of Sleep-polling at the ~15.6ms
    // system clock granularity). A length of 0 (or EOF) stops playback and
    // exits; a final JSON stats line is printed to stdout:
    // {frames,audioMs,wallMs,maxGapMs,gapsOverStepMs}
    //   where gap = time between consecutive buffer-completion callbacks.
    //   gapsOverStepMs counts gaps exceeding the buffer's own audio duration
    //   + 8ms — the intrinsic "stutter" the playout path would otherwise hide.
    public static void Stream(int deviceId, Stream input) {
      timeBeginPeriod(1);
      IntPtr hwo = IntPtr.Zero;
      var format = Format();
      Check(waveOutOpen(out hwo, deviceId, ref format, IntPtr.Zero, s_doneEvent.SafeWaitHandle.DangerousGetHandle(), CALLBACK_EVENT), "waveout_stream_open");
      // Deep device queue: submit up to 100 frames upfront (2s of audio) so a
      // bursty TTS upstream (e.g. MiMo SSE with network gaps) never underruns
      // the device; the render loop refills greedily from stdin.
      int slots = 100;
      byte[][] audio = new byte[slots][];
      GCHandle[] pins = new GCHandle[slots];
      WAVEHDR[] headers = new WAVEHDR[slots];
      bool[] active = new bool[slots];
      long audioBytes = 0L;
      long maxGapMs = 0L;
      long gapsOverStepMs = 0L;
      long previousDoneTicks = 0L;
      long firstDoneTicks = 0L;
      long lastDoneTicks = 0L;
      try {
        Queue<byte[]> queue = new Queue<byte[]>();
        bool inputEnded = false;   // sealed with queueLock; stop frame or EOF
        bool stopRequested = false; // sealed with queueLock; break the render loop now
        object queueLock = new object();
        // Background reader: keep stdin fully drained into jitter queue so a
        // slow TTS upstream simply delays, it never blocks the render loop.
        Thread reader = new Thread(() => {
          byte[] lengthBytes = new byte[4];
          for (;;) {
            if (!ReadExact(input, lengthBytes, 4)) { lock (queueLock) { inputEnded = true; } return; }
            int length = BitConverter.ToInt32(lengthBytes, 0);
            if (length == 0) { lock (queueLock) { inputEnded = true; stopRequested = true; } return; }
            if (length < 0 || length % 2 != 0 || length > 1920000) { lock (queueLock) { inputEnded = true; stopRequested = true; } return; }
            byte[] frame = new byte[length];
            if (!ReadExact(input, frame, length)) { lock (queueLock) { inputEnded = true; stopRequested = true; } return; }
            lock (queueLock) { if (queue.Count < 6000) queue.Enqueue(frame); /* 2s of 20ms frames, bounded */ }
          }
        });
        reader.Priority = ThreadPriority.AboveNormal;
        reader.IsBackground = true;
        reader.Start();

        Func<int, bool> submit = slot => {
          byte[] frame;
          lock (queueLock) { if (queue.Count == 0) return false; frame = queue.Dequeue(); }
          audio[slot] = frame;
          pins[slot] = GCHandle.Alloc(frame, GCHandleType.Pinned);
          headers[slot] = new WAVEHDR();
          headers[slot].lpData = pins[slot].AddrOfPinnedObject();
          headers[slot].dwBufferLength = (uint)frame.Length;
          Check(waveOutPrepareHeader(hwo, ref headers[slot], (uint)Marshal.SizeOf(typeof(WAVEHDR))), "waveout_stream_prepare");
          Check(waveOutWrite(hwo, ref headers[slot], (uint)Marshal.SizeOf(typeof(WAVEHDR))), "waveout_stream_write");
          active[slot] = true;
          audioBytes += frame.Length;
          return true;
        };

        long freqTicksPerMs = Stopwatch.Frequency / 1000L;

        // Wait for the first frame so the render loop never starts empty.
        for (;;) {
          bool available;
          lock (queueLock) { available = queue.Count > 0 || inputEnded; }
          if (available) break;
          Thread.Sleep(1);
        }
        // Prime the full deep queue so playback begins with ~320ms of head.
        int primed = 0;
        for (int slot = 0; slot < slots && submit(slot); slot++) primed++;
        if (primed > 0) {
          int activeCount = primed;
          int playing = 0;
          while (activeCount > 0) {
            // A stop frame interrupts immediately: flush the device queue now.
            bool stopNow;
            lock (queueLock) { stopNow = stopRequested; }
            if (stopNow) {
              waveOutReset(hwo);
              // Every queued header is marked DONE by Reset; release them all.
              for (int slot = 0; slot < slots; slot++) {
                if (active[slot]) {
                  try { waveOutUnprepareHeader(hwo, ref headers[slot], (uint)Marshal.SizeOf(typeof(WAVEHDR))); } catch { }
                  if (pins[slot].IsAllocated) pins[slot].Free();
                  active[slot] = false;
                }
              }
              activeCount = 0;
              break;
            }
            // Advance to the oldest active slot; a slot whose refill missed
            // (queue momentarily empty) must be skipped, otherwise WaitDone
            // would block forever on a header the device never owned.
            while (!active[playing]) playing = (playing + 1) % slots;
            // Wait for the oldest queued buffer to finish.
            if (!WaitDone(headers, playing, freqTicksPerMs)) throw new TimeoutException("waveout_stream_playback_timeout");
            long now = Stopwatch.GetTimestamp();
            long gapMs = 0L;
            if (firstDoneTicks == 0L) firstDoneTicks = now;
            else {
              gapMs = (now - previousDoneTicks) / freqTicksPerMs;
              if (gapMs > maxGapMs) maxGapMs = gapMs;
              long stepMs = audio[playing].Length / 32L;
              if (gapMs > stepMs + 8L) gapsOverStepMs++;
            }
            previousDoneTicks = now;
            lastDoneTicks = now;
            waveOutUnprepareHeader(hwo, ref headers[playing], (uint)Marshal.SizeOf(typeof(WAVEHDR)));
            pins[playing].Free();
            active[playing] = false;
            activeCount--;
            // Refill aggressively: fill EVERY idle slot from the jitter queue
            // (not just the just-finished one) so the device queue stays deep.
            // A 1:1 refill never builds the deep queue — each 20ms frame then
            // pays the full unprepare/prepare/write overhead (~10ms) between
            // buffers, which measures as uniform ~30ms gaps.
            for (int slot = 0; slot < slots; slot++) {
              if (!active[slot] && submit(slot)) activeCount++;
            }
            // Advance to the next buffer in FIFO order.
            playing = (playing + 1) % slots;
            if (activeCount == 0) {
              // All slots idle: either stop was signaled or the queue is
              // drained. Wait (bounded) for the reader to deliver more frames
              // before declaring the stream over.
              bool drained;
              lock (queueLock) { drained = inputEnded; }
              if (drained) break;
              // Upstream still active: poll until the queue refills or the
              // stop marker arrives.
              for (;;) {
                Thread.Sleep(1);
                if (submit(playing)) { activeCount++; break; }
                lock (queueLock) { drained = inputEnded; }
                if (drained) break;
              }
            }
          }
        }
        long endTicks = Stopwatch.GetTimestamp();
        long wallMs = (firstDoneTicks == 0L) ? 0L : (endTicks - firstDoneTicks) / freqTicksPerMs;
        long audioMs = audioBytes / 32L;
        string stats = "{\"frames\":" + audioBytes / 640L
          + ",\"audioMs\":" + audioMs + ",\"wallMs\":" + wallMs
          + ",\"maxGapMs\":" + maxGapMs + ",\"gapsOverStepMs\":" + gapsOverStepMs + "}";
        var statsBytes = System.Text.Encoding.UTF8.GetBytes(stats + "\n");
        using (var stdout = Console.OpenStandardOutput()) stdout.Write(statsBytes, 0, statsBytes.Length);
      } finally {
        timeEndPeriod(1);
        if (hwo != IntPtr.Zero) { waveOutReset(hwo); waveOutClose(hwo); }
        for (int slot = 0; slot < slots; slot++) {
          if (active[slot]) {
            try { waveOutUnprepareHeader(hwo, ref headers[slot], (uint)Marshal.SizeOf(typeof(WAVEHDR))); } catch { }
            if (pins[slot].IsAllocated) pins[slot].Free();
          }
        }
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
    try { [GameBuddyWaveOut.Native]::Stream($deviceId, $stdin) }
    catch { $_ | Out-String | Write-Error; exit 3 }
    [pscustomobject]@{ state = 'stopped'; mode = 'stream'; device = $Device } | ConvertTo-Json -Compress
    exit 0
}

[GameBuddyWaveOut.Native]::ProbeOrPlay($deviceId, $PcmPath, $Mode -eq 'probe')
[pscustomobject]@{ state = 'passed'; mode = $Mode; device = $Device } | ConvertTo-Json -Compress
