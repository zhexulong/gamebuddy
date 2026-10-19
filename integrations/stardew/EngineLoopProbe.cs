using System;
using System.IO;
using System.Reflection;
using System.Threading;
using HarmonyLib;
using StardewModdingAPI;

namespace GameBuddy.Stardew;

/// <summary>
/// A Harmony postfix on the engine's own frame, so a stall can be attributed to the right side.
/// </summary>
/// <remarks>
/// Why this exists: measured 2026-10-19, three times, the game process stayed ALIVE with `Responding=False` and a climbing
/// CPU count while the Mod's log stopped and the Mod's own tick watchdog never fired - the tick had already returned, so
/// nothing inside the Mod can report what happened. The one question that decides the next step is whether the ENGINE's
/// per-frame update still runs: a growing counter means the engine kept its loop and the stall is inside a subsystem (or
/// SMAPI's event dispatch); a frozen counter means the process stopped before a frame could run.
/// <para>
/// Design notes, both learned the hard way: the counter is incremented on the game thread with no I/O (an earlier
/// instrument wrote ~500 lines a second synchronously and became part of the problem it was measuring), and the file is
/// written from a timer thread at `SamplePeriodMs`, so a frozen game thread still leaves a record.
/// </para>
/// </remarks>
internal sealed class EngineLoopProbe
{
    private const int SamplePeriodMs = 500;
    private const string FileName = "gamebuddy-engine-loop.txt";

    private static long frames;
    private long lastWrittenFrames = -1;

    /// <summary>Installs the postfix, or reports why it could not.</summary>
    internal static void TryInstall(Harmony harmony, IMonitor monitor)
    {
        MethodInfo? target = AccessTools.Method(
            typeof(StardewValley.Game1),
            "Update",
            new[] { typeof(Microsoft.Xna.Framework.GameTime) });
        MethodInfo? postfix = AccessTools.Method(typeof(EngineLoopProbe), nameof(CountFrame));
        if (target is null || postfix is null)
        {
            monitor.Log(
                "GameBuddy engine-loop probe could not be installed; a freeze's side will have to be inferred without it.",
                LogLevel.Warn);
            return;
        }
        harmony.Patch(target, postfix: new HarmonyMethod(postfix));
    }

    /// <summary>Counts one engine frame. One increment and nothing else, on the game thread.</summary>
    private static void CountFrame() => Interlocked.Increment(ref frames);

    /// <summary>Writes the counter to its own file, from a timer thread.</summary>
    internal void WriteSample()
    {
        try
        {
            long current = Interlocked.Read(ref frames);
            if (current == this.lastWrittenFrames) return;
            this.lastWrittenFrames = current;
            string directory = Path.Combine(Constants.DataPath, "ErrorLogs");
            Directory.CreateDirectory(directory);
            File.AppendAllText(
                Path.Combine(directory, FileName),
                $"{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()};frames={current}" + Environment.NewLine);
        }
        catch
        {
            // A probe that throws is worse than a probe that is silent.
        }
    }
}
