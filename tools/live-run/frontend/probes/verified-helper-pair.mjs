#!/usr/bin/env node
// Probe: prints the native helper pair a builder would ACCEPT, by asking that builder's own
// `readVerifiedPair()`.
//
// Why it exists: the pin phase copies a published pair from the main checkout into the pinned
// worktree so a fresh stage never has to publish one. Copying is only worth anything if the build
// phase's builder will accept the copy - a pair it rejects makes the builder fall through to
// `dotnet publish --self-contained`, which is the restore that asks the package source for
// vulnerability data and fails on a machine with no route to api.nuget.org (measured 2026-11-20:
// three consecutive frontend live runs died in the pinned build for exactly that reason). The
// acceptance rule therefore lives in ONE place - the builder - and this probe reports its verdict
// rather than a second reading of "two files are present".
//
//   node tools/live-run/frontend/probes/verified-helper-pair.mjs <path to the builder module>
//
// exit 0: `pair_verified sha256=<hex> outputRoot=<path>`
// exit 1: `pair_rejected outputRoot=<path> reason=<why>` (the reason names the reading that failed)
// exit 2: the probe was called without a builder path.
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const builderPath = process.argv[2];
if (builderPath === undefined) {
  console.error("verified-helper-pair: a builder module path is required");
  process.exit(2);
}

const absolute = resolve(builderPath);
let builder;
try {
  builder = await import(pathToFileURL(absolute).href);
} catch (error) {
  console.error(
    `pair_rejected builder=${absolute} reason=builder_module_unreadable(${error instanceof Error ? error.message : String(error)})`,
  );
  process.exit(1);
}

if (typeof builder.readVerifiedPair !== "function" || typeof builder.outputRoot !== "string") {
  console.error(`pair_rejected builder=${absolute} reason=builder_does_not_export_readVerifiedPair`);
  process.exit(1);
}

const pair = await builder.readVerifiedPair();
if (pair === undefined) {
  console.error(`pair_rejected outputRoot=${builder.outputRoot} reason=readVerifiedPair_returned_undefined`);
  process.exit(1);
}
console.log(`pair_verified sha256=${pair.sha256} outputRoot=${builder.outputRoot}`);
