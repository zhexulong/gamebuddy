/**
 * Whether the game process is answering, what its threads are waiting on, and how much of the machine it holds.
 *
 * Read-only: nothing here kills or signals anything. Every probe distinguishes "the world answered", "the world is not
 * running" and "the probe itself failed", because the last one is not evidence about the world - measured 2026-10-19
 * (g70probe), a freeze recorded `game_responding=null` while collapsing a dead process into a failed query.
 */
import { execFileSync } from "node:child_process";

/**
 * Whether the game process is answering Windows messages, and how much CPU it has burned.
 *
 * Read-only, and matched by name because the runner does not receive the launched pid: nothing here kills or signals
 * anything, and an absent process answers `responded: null` rather than guessing.
 */
/**
 * The threads of the game process and what they are waiting on.
 *
 * The decisive reading after g80stall: BOTH timer-thread files stopped - the engine-frame writer and the watchdog's
 * fallback - while the process stayed alive, which points at the managed side as a whole rather than one blocked
 * thread. A thread-state census taken during the stall separates the remaining cases: every thread parked on one
 * lock (a managed deadlock), threads waiting on I/O, or a suspended runtime.
 *
 * Four different answers, four different values, each naming the pid it asked about: `no_game_process` (nothing to
 * census), `pid=<id>;process_without_threads`, `pid=<id>;threads=<n>;<groups>`, and `probe_unavailable:<why>` (the
 * query itself failing, which is NOT evidence about the world). They used to be ONE value, `unavailable` - and a
 * real artifact shows why that was unreadable: the same tick reported `game_cpu_s=539` from the process probe beside
 * it while the census said `unavailable`, so the reader could not tell a dead process from a threadless one from a
 * broken query (2026-10-19, multiday_routine).
 */
export function sampleGameThreads() {
  const query = () =>
    execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        "$p = Get-Process -Name StardewModdingAPI,Stardew* -ErrorAction SilentlyContinue | Select-Object -First 1; " +
          'if ($null -ne $p) { [pscustomobject]@{ "pid" = $p.Id; "threadCount" = $p.Threads.Count; "census" = ' +
          '(($p.Threads | Group-Object ThreadState,WaitReason | ForEach-Object { "$($_.Count)x$($_.Name)" }) -join "|") } ' +
          "| ConvertTo-Json -Compress }",
      ],
      { encoding: "utf8", timeout: 8_000 },
    );
  let rows;
  try {
    rows = query();
  } catch (error) {
    return `probe_unavailable:${String(error?.message ?? error)
      .replace(/\s+/gu, " ")
      .slice(0, 120)}`;
  }
  const text = rows.trim();
  // An empty answer is Get-Process finding nothing, which is the only reading here that says the game is not running.
  if (text === "") return "no_game_process";
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    return `probe_unavailable:unparseable_output:${text.slice(0, 120)}`;
  }
  const pid = Number.isInteger(parsed?.pid) ? String(parsed.pid) : "unknown";
  const census = typeof parsed?.census === "string" ? parsed.census.trim().replace(/\s+/gu, " ") : "";
  if (census === "") return `pid=${pid};process_without_threads`;
  const threadCount = Number.isInteger(parsed?.threadCount) ? String(parsed.threadCount) : "unknown";
  return `pid=${pid};threads=${threadCount};${census.slice(0, 400)}`;
}

export function sampleGameProcess() {
  /**
   * Three different answers, three different values.
   *
   * `responding: false` is a live process that is not pumping messages - the signature of the engine-side freeze.
   * `responding: null` with `note: "no_game_process"` is a game that is not running. `note: "probe_unavailable"` is the
   * query itself failing, which is NOT evidence about the world: measured 2026-10-19 (g70probe), the sampler recorded
   * `game_responding=null` during a freeze in which the game was alive, collapsing two of these into one value.
   */
  const query = () =>
    execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        "Get-Process -Name StardewModdingAPI,Stardew* -ErrorAction SilentlyContinue | Select-Object -First 1 -Property Responding,CPU,WorkingSet64,PrivateMemorySize64 | ConvertTo-Json -Compress",
      ],
      { encoding: "utf8", timeout: 8_000 },
    );
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const rows = query();
      const parsed = JSON.parse(rows.trim() === "" ? "null" : rows);
      if (parsed === null) return Object.freeze({ responding: null, cpuSeconds: null, note: "no_game_process" });
      return Object.freeze({
        responding: parsed.Responding === true,
        cpuSeconds: typeof parsed.CPU === "number" ? parsed.CPU : null,
        // The game's own working set. Without it a run that dies of memory exhaustion cannot say whose: the harness
        // records system-wide free memory and the Host's RSS, and never the process that owns most of the machine.
        // Measured 2026-11-09: `minFreeMb: 97` beside `hostRssMb: 934` on a machine whose rest state is 4.2 GB free of
        // 31 - a 934 MB process cannot account for that, so the attribute had no owner in any artifact.
        workingSetMb: typeof parsed.WorkingSet64 === "number" ? Math.round(parsed.WorkingSet64 / (1024 * 1024)) : null,
        privateMb:
          typeof parsed.PrivateMemorySize64 === "number"
            ? Math.round(parsed.PrivateMemorySize64 / (1024 * 1024))
            : null,
        note: null,
      });
    } catch {
      // A failed query is not evidence; try once more, then say so.
    }
  }
  return Object.freeze({ responding: null, cpuSeconds: null, note: "probe_unavailable" });
}
