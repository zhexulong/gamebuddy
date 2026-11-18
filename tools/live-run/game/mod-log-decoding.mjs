/**
 * One Mod-log source, decoded by the encoding it was WRITTEN in, and the archive a run keeps of it.
 *
 * The sources are written by two different things: SMAPI writes UTF-8, and a lane's console capture is a PowerShell
 * redirect, which writes UTF-16LE. Reading both as UTF-8 put a NUL between every character of the console half, so the
 * concatenation was a binary file (measured 2026-11-18, `round76`) and every tool that sniffs for a NUL refused to read
 * `mod-log.txt` as text. Where the sources ARE is the runner's answer (a lane log, then the rotating SMAPI logs), so the
 * caller hands its paths in: this module decides how the bytes are read, never which files exist.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * This run's Mod log, copied into the run directory, plus the lines an audit needs out of it.
 *
 * The Mod's own phase facts live in %APPDATA%/StardewValley/ErrorLogs/SMAPI-latest.txt, which ROTATES: once the
 * next run starts, the previous night's is_saving, save_boundary_not_observed, SaveGameMenu and
 * SetForegroundWindow evidence is gone - the round-2 audit could not confirm the crossing cause for exactly that
 * reason ("the facts are not in the surviving artifacts"). Durability is the fix. Note what it already shows: the
 * foreground WINDOW MODE is not a proxy for actual activation, because a real run logged
 * SetForegroundWindow=refused while running in foreground mode.
 */
/**
 * One Mod-log source, decoded by the encoding it was WRITTEN in.
 *
 * The sources are written by two different things: SMAPI writes UTF-8, and the lane's console capture is a PowerShell
 * redirect, which writes UTF-16LE. Reading both as UTF-8 put a NUL between every character of the console half, so the
 * concatenation was a binary file (measured 2026-11-18, `round76`) and every tool that sniffs for a NUL refused to read
 * `mod-log.txt` as text - including the ones this archive exists for.
 */
export function readModLogSource(candidate) {
  const bytes = readFileSync(candidate);
  const encoding = modLogEncoding(bytes);
  const text = encoding === "utf8" ? bytes.toString("utf8") : decodeUtf16(bytes, encoding);
  return Object.freeze({ path: candidate, encoding, text });
}

/**
 * The encoding a Mod-log source carries, from its bytes rather than from its name.
 *
 * A BOM is decisive, and so is the shape when there is none: every ASCII character of a UTF-16LE line is followed by a
 * NUL, and a NUL at an odd offset is not a byte any UTF-8 writer produces.
 */
export function modLogEncoding(bytes) {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return "utf16le";
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return "utf16be";
  for (let index = 1; index < Math.min(bytes.length, 512); index += 2) {
    if (bytes[index] === 0) return "utf16le";
  }
  return "utf8";
}

/** One UTF-16 source as text, BOM or not. Node has no big-endian decoder, so that case swaps the pairs first. */
export function decodeUtf16(bytes, encoding) {
  const bommed =
    bytes.length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff));
  const body = bommed ? bytes.subarray(2) : bytes;
  if (encoding === "utf16le") return body.toString("utf16le");
  const swapped = Buffer.alloc(body.length - (body.length % 2));
  for (let index = 0; index + 1 < body.length; index += 2) {
    swapped[index] = body[index + 1];
    swapped[index + 1] = body[index];
  }
  return swapped.toString("utf16le");
}

export function captureModLogFacts(runDir, modLogPaths) {
  // EVERY source, not one of them, and the archive says which files supplied it. The sources are the caller's answer
  // (`MOD_LOG_PATHS` in the runner: the lane's console capture, then SMAPI's own log files), so this module never
  // decides which files exist - only how their bytes are decoded and what the archive says about them.
  //
  // This used to read a single path, and that path was the one the liveness meter read - which turned out to be the lane's
  // CONSOLE capture while the Mod writes its markers into the SMAPI log FILE. A run whose observation layer reads the wrong
  // stream does not merely lose a heartbeat: it loses the receipts, refusals and save-boundary facts this function exists to
  // make durable, and the artifact then says "no evidence" about things that were logged.
  try {
    const decoded = modLogPaths.map(readModLogSource).filter((source) => source.text.length > 0);
    const text = decoded.map((source) => source.text).join("\n");
    const rows = text.split("\n");
    const tail = (pattern, count = 4) =>
      rows
        .filter((row) => pattern.test(row))
        .slice(-count)
        .map((row) => row.trim().slice(0, 400));
    const archived = typeof runDir === "string" && runDir.length > 0;
    if (archived) {
      // AS UTF-8, WHATEVER EACH SOURCE WAS WRITTEN IN. A PowerShell redirect (`| Out-File`) writes UTF-16LE and SMAPI
      // writes UTF-8; concatenating the two as if both were UTF-8 put a NUL between every character of the console half,
      // so `mod-log.txt` was a file that `grep`, `diff` and every tool that sniffs for a NUL read as BINARY - measured
      // 2026-11-18 (`round76`), where the markers this archive exists for could not be read out of it at all. The
      // encoding each source was decoded from travels in `mod-log-sources.json`, so the archive says what it is.
      writeFileSync(join(runDir, "mod-log.txt"), text, "utf8");
      writeFileSync(
        join(runDir, "mod-log-sources.json"),
        JSON.stringify(
          decoded.map((source) => ({ path: source.path, encoding: source.encoding })),
          null,
          2,
        ),
      );
    }
    const lastWith = (needle) => (rows.filter((row) => row.includes(needle)).slice(-1)[0] ?? "").trim().slice(0, 400);
    return Object.freeze({
      // `sources` rather than a `path`: there is more than one source now, and the list is archived beside the text
      // (`mod-log-sources.json`). Measured 2026-11-05: this read a bare `path` that no enclosing scope declared, so
      // EVERY call threw `ReferenceError: path is not defined` - and the catch threw the same one, which ended the run
      // at the very line that assembles its result.
      sources: Object.freeze(decoded.map((source) => ({ path: source.path, encoding: source.encoding }))),
      // The size of the archive this run writes, in BYTES of the UTF-8 text: `text.length` counted characters, which is
      // the wrong number for a file whose sources were written in two different encodings.
      bytes: Buffer.byteLength(text, "utf8"),
      archived,
      setForegroundWindow: tail(/SetForegroundWindow/i),
      saveGameMenu: tail(/SaveGameMenu/i),
      saveBoundary: tail(/save_boundary|SaveBoundaryFrameBudget|save boundary/i),
      sleepLifecycle: tail(/sleep lifecycle/i, 6),
      // The two lines a freeze is diagnosed from, straight into the result instead of only into the archived log: the
      // last step the tick NAMED (a stage marker) and the last thing the Mod say through the pipe ingress path.
      lastStage: (rows.filter((row) => row.includes("DEBUG-native-local-stage")).slice(-1)[0] ?? "")
        .trim()
        .slice(0, 300),
      lastIngress: (rows.filter((row) => row.includes("native chat ingress")).slice(-1)[0] ?? "").trim().slice(0, 300),
      // The frames the outbound queue REFUSED, by frame kind: a terminal receipt dropped there is a state the Host waits
      // for and never receives, and until the bridge named it the run read as a companion that simply stopped answering.
      // The bridge bounds it to one line per second, so this tail is the whole population of a bounded fact.
      bridgeFrameRefused: tail(/bridge_frame_refused:/, 8),
      lastFrameState: lastWith("game_mode="),
      lastSavingState: lastWith("saving="),
    });
  } catch (error) {
    return Object.freeze({ archived: false, error: String(error?.message ?? error).slice(0, 240) });
  }
}
