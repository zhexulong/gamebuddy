// What did the Host actually ASK for? The attachment request, kept as it appears, beside the advertisement of
// the moment.
//
// WHY THIS EXISTS. `stardew-attachment-request.json` lives for one game tick: the Player Host writes it, and the
// Mod deletes it before it answers (`integrations/stardew/HostFarmhandProvisioner.cs`, `ProcessRequest`). The
// Mod's answer carries a reason code and nothing else, and the Host keeps no copy - so "the companion's join was
// refused" could not be resolved against the request that was refused. That is how run r26 on 2026-11-21 ended:
// one refusal, no request, no field. This module watches every lane's bootstrap session directory and keeps each
// appearance of the request with the `stardew-session.json` that was on disk at that instant, which is the
// comparison that names the fact (lane FIRSTJOIN used it to show the request and the advertisement agree
// field-for-field, and that a world created in the same session attaches).
//
//   node tools/live-run/frontend/lib/attachment-request-capture.mjs --lanes E:\gb-lanes --sink .tmp/requests.jsonl
//
// Start it before the run; it discovers `<lane>.stage/root/GameBuddy/data/stardew-private-bootstrap/*/session`
// on its own and polls at 1 ms, because the file it is after is gone in ~16 ms.
import { appendFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const REQUEST = "stardew-attachment-request.json";
const ADVERTISEMENT = "stardew-session.json";
const BOOTSTRAP = join("root", "GameBuddy", "data", "stardew-private-bootstrap");

function sessionDirectories(lanesRoot) {
  const found = [];
  let lanes;
  try {
    lanes = readdirSync(lanesRoot, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const lane of lanes) {
    if (!lane.isDirectory()) continue;
    const bootstrapRoot = join(lanesRoot, lane.name, BOOTSTRAP);
    let bootstraps;
    try {
      bootstraps = readdirSync(bootstrapRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const bootstrap of bootstraps)
      if (bootstrap.isDirectory()) found.push(join(bootstrapRoot, bootstrap.name, "session"));
  }
  return found;
}

/**
 * Keeps every appearance of the attachment request under `lanesRoot`, one JSON line per capture:
 * `{ atMs, directory, request, advertisement }` - the advertisement verbatim, or null when the Mod had removed
 * it. A body already captured from the same directory is not appended twice.
 */
export function startAttachmentRequestCapture(options) {
  const lanesRoot = options.lanesRoot;
  const sink = options.sink;
  const now = options.nowMs ?? Date.now;
  const records = [];
  const captured = new Set();
  let directories = sessionDirectories(lanesRoot);
  let polling = null;
  let discovering = null;

  mkdirSync(dirname(sink), { recursive: true });

  const poll = () => {
    for (const directory of directories) {
      let request;
      try {
        request = readFileSync(join(directory, REQUEST), "utf8");
      } catch {
        continue;
      }
      const identity = `${directory}\u0000${request}`;
      if (captured.has(identity)) continue;
      captured.add(identity);
      let advertisement = null;
      try {
        advertisement = readFileSync(join(directory, ADVERTISEMENT), "utf8");
      } catch {
        advertisement = null;
      }
      const record = { atMs: now(), directory, request, advertisement };
      records.push(record);
      appendFileSync(sink, `${JSON.stringify(record)}\n`);
    }
  };

  poll();
  polling = setInterval(poll, 1);
  discovering = setInterval(() => {
    directories = sessionDirectories(lanesRoot);
  }, 2_000);
  return {
    records,
    directories: () => directories,
    stop() {
      clearInterval(polling);
      clearInterval(discovering);
    },
  };
}

if (process.argv[1]?.endsWith("attachment-request-capture.mjs")) {
  const argument = (name, fallback) => {
    const index = process.argv.indexOf(`--${name}`);
    return index > 0 && index + 1 < process.argv.length ? process.argv[index + 1] : fallback;
  };
  const capture = startAttachmentRequestCapture({
    lanesRoot: argument("lanes", "E:\\gb-lanes"),
    sink: argument("sink", join(".tmp", "attachment-requests.jsonl")),
  });
  process.stdout.write(
    `watching ${capture.directories().length} session dir(s) under ${argument("lanes", "E:\\gb-lanes")}; each request is appended to ${argument("sink", join(".tmp", "attachment-requests.jsonl"))}\n`,
  );
  setInterval(() => {
    process.stdout.write(`captured ${capture.records.length} request(s)\n`);
  }, 10_000);
}
