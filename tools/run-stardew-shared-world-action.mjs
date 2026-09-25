import { readFile } from "node:fs/promises";
import { connectNativeLocalClient } from "./lib/stardew-native-smoke-harness-v1.mjs";
import { loadHostTestModule } from "./lib/host-test-module.mjs";

/**
 * Shared-world action executor.
 *
 * The 43 native-local `run*Smoke` exports are already pure functions over an
 * already-connected bridge session: `(client, receipts, config, options)`. The
 * only thing that pinned them to one process was their `import.meta.main` block,
 * which reconnects through the immutable production loader. That loader is
 * currently unavailable (the release generation lacks the voice gateway
 * sidecar), so this executor performs the connection itself against the
 * compiled test artifact - the same carrier the native-local runners already
 * use - and then calls the very same exported contract function.
 *
 * It is an execution shim only. It selects no action semantics, weakens no
 * assertion, and produces no publish or closure decision.
 */
function option(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || index + 1 >= process.argv.length) throw new Error(`missing_${name.slice(2)}`);
  return process.argv[index + 1];
}

const clientConfigPath = option("--client-config");
const action = option("--action");
if (!/^[a-z][a-z0-9_]*$/.test(action)) throw new Error("invalid_action_id");

const config = JSON.parse((await readFile(clientConfigPath, "utf8")).replace(/^\uFEFF/, ""));

const runnerFile = {
  machine_inspect: "run-stardew-native-local-player-machine-inspect-smoke.mjs",
}[action];
if (runnerFile === undefined) throw new Error(`shared_world_runner_not_wired:${action}`);

const runner = await import(`./${runnerFile}`);
const runSmoke = Object.entries(runner).find(([name]) => /^run[A-Za-z]*Smoke$/.test(name))?.[1];
if (typeof runSmoke !== "function") throw new Error("shared_world_runner_export_missing");

const session = await connectNativeLocalClient(config, { loadModule: loadHostTestModule });
let result;
try {
  result = await runSmoke(session.client, session.receipts, config);
} finally {
  await session.close();
}
console.log(JSON.stringify(result));
if (result?.state !== "passed") process.exitCode = 2;
