import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { type GameEnvironmentFactsRender, MAX_GAME_ENVIRONMENT_FACTS_BYTES } from "./game-world-vocabulary.js";
import type { RuntimePaths } from "./runtime-identity.js";

/**
 * What one delivered turn's `<world-state>` said about the environment, recorded as it is delivered.
 *
 * <p>
 * The session stores MESSAGES, so nothing downstream of a run can say what the model was SHOWN. Measured 2026-11-01
 * (`round18`, 24 minutes, 75 assembled requests): the bound session contained `位置:` 0 times, `脚下` 0 times and
 * `待浇水` 0 times. Two verdict criteria (`tools/live-run/round-verdict.mjs` rows 2 and 5) therefore had no file to read
 * and reported UNOBSERVABLE by construction - a fact about the instrument, not about the product.
 * </p>
 *
 * <p>
 * THE PRODUCER IS THE TURN, NOT THE TRANSFORM. The line is the paragraph `composeWorldState` renders every turn from the
 * reading that turn was composed from, and it says how old that reading is. A record taken anywhere else - from the
 * integration's live state, or from a Magic Context provider the transform asks at assembly time - describes a different
 * moment of the world and can disagree with the prompt it claims to describe. So the pump hands each delivery's render to
 * this recorder, and `event-pump.environment-facts-record.test.ts` asserts the recorded text appears verbatim inside the
 * batch that was delivered.
 * </p>
 *
 * <p>
 * This file is a RECORD, not a durable document. It lives beside the run manifest under the runtime root, is never written
 * into the session, the transcript or player memory, no product path reads it, and it is non-durable by design - exactly
 * like the paragraph it describes. A reader asks it: was the line rendered on every turn or did it vanish; what did the
 * unwatered count say, and did it ever go non-zero; did same-map villagers arrive with tiles; did the line reach the byte
 * cap and what did the cap drop.
 * </p>
 */

export const ENVIRONMENT_FACTS_RECORD_FILENAME = "environment-facts.jsonl";
export const ENVIRONMENT_FACTS_RECORD_SCHEMA = "gamebuddy_environment_facts_render/v1";

/**
 * The record's bound, sized from the measured turn count rather than guessed.
 *
 * The largest session measured in this loop is 285 turns and `round18` assembled 75 requests in 24 minutes. A recorded
 * line measured 309 B for a busy farm (clock, date, weather, location, tile, held tool, two nearby villagers, two
 * destinations, 24 unwatered crops and stamina), so 285 turns cost ~88 KB. 1200 records is 4.2x the largest measured run
 * and cannot exceed ~740 KB even if every line used the formatter's whole 512 B fact budget. The byte cap is the second
 * net, because the record must stay bounded for a caller that registers its own recorder.
 *
 * After either cap the file receives ONE truncation line and then nothing, so a runaway session cannot fill a disk and a
 * reader can see that the tail was cut rather than believe the run ended there.
 */
export const MAX_ENVIRONMENT_FACTS_RECORD_LINES = 1200;
export const MAX_ENVIRONMENT_FACTS_RECORD_BYTES = 1024 * 1024;

/** One line of the record: what was rendered, for which reading, and what the cap cost it. */
export type EnvironmentFactsRenderRecord = Readonly<{
  schema: string;
  /** When the turn was delivered, ISO-8601 - ordering one render against a game event needs a clock. */
  at: string;
  /** The snapshot revision the line was rendered from; `null` when the turn had no reading yet. */
  revision: number | null;
  bytes: number;
  /** Whether the rendered line still exceeded `MAX_GAME_ENVIRONMENT_FACTS_BYTES` after the cap ran. */
  overCap: boolean;
  /** Present only when the cap dropped something. */
  dropped?: readonly string[];
  /** The exact string the paragraph carries - `""` when it rendered empty (a turn with no reading yet). */
  text: string;
}>;

/**
 * Where this run's renders are recorded: beside the run manifest, inside the runtime root.
 *
 * The manifest is per surface session (`resolveRuntimePaths` puts it under `surface-sessions/<id>/` when there is one), so
 * a record written here belongs to one run rather than to every run that shares the continuity - and it is nowhere near
 * `<sessionDir>`, the transcript or the memory store.
 */
export function environmentFactsRecordPath(paths: RuntimePaths): string {
  return join(dirname(paths.runManifestPath), ENVIRONMENT_FACTS_RECORD_FILENAME);
}

/** Where one delivered turn's rendered environment line is recorded. */
export type EnvironmentFactsRecordPort = (rendered: GameEnvironmentFactsRender, revision: number | null) => void;

/**
 * The record around one delivery's render.
 *
 * ONLY THE RECORD IS BEST-EFFORT: a diagnostic that cannot be written must never become a failed turn, so a write failure
 * disables further writes (one bad path costs one syscall, not one per turn) and the absent file is the report. The render
 * itself has already happened by the time this is called, so nothing here can change what the model reads.
 *
 * SYNCHRONOUS, MEASURED, NOT BUFFERED. `appendFileSync` of a 309 B line on this platform (Windows, Node 24) costs
 * 0.15-0.19 ms per call over 500 calls; `round18`'s turn cadence was 24 minutes for 75 assembled requests, so the record
 * costs ~0.001% of a turn. Buffering would buy nothing measurable and would lose precisely the interesting turns - the
 * ones immediately before a killed run - which is the failure this record exists for. An `O_APPEND` handle would be
 * cheaper (0.0035 ms) but needs a close hook this recorder has none of, and a leaked descriptor per runtime is a worse
 * trade than 0.15 ms.
 */
export function createEnvironmentFactsRecord(recordPath: string): EnvironmentFactsRecordPort {
  let lines = 0;
  let bytes = 0;
  let directoryReady = false;
  let writable = true;
  let sealed = false;

  const append = (line: string): void => {
    const size = Buffer.byteLength(line, "utf8");
    try {
      if (!directoryReady) {
        mkdirSync(dirname(recordPath), { recursive: true });
        directoryReady = true;
      }
      appendFileSync(recordPath, line, "utf8");
    } catch {
      writable = false;
      return;
    }
    lines += 1;
    bytes += size;
  };

  return (rendered, revision): void => {
    if (!writable || sealed) return;
    const at = new Date().toISOString();
    const line = `${JSON.stringify({
      schema: ENVIRONMENT_FACTS_RECORD_SCHEMA,
      at,
      revision,
      bytes: rendered.bytes,
      overCap: rendered.bytes > MAX_GAME_ENVIRONMENT_FACTS_BYTES,
      ...(rendered.dropped.length === 0 ? {} : { dropped: rendered.dropped }),
      text: rendered.text,
    })}\n`;
    const size = Buffer.byteLength(line, "utf8");
    if (lines >= MAX_ENVIRONMENT_FACTS_RECORD_LINES || bytes + size > MAX_ENVIRONMENT_FACTS_RECORD_BYTES) {
      sealed = true;
      append(
        `${JSON.stringify({
          schema: ENVIRONMENT_FACTS_RECORD_SCHEMA,
          at,
          truncated: true,
          lines,
          bytes,
          reason: "environment_facts_record_cap_reached",
        })}\n`,
      );
      return;
    }
    append(line);
  };
}
