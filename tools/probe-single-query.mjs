// Minimal isolation: single-query find_destination probe
import { connectNativeLocalClient, observeFresh } from "./lib/stardew-native-smoke-harness-v1.mjs";
import { readFile } from "node:fs/promises";

const configPath = process.argv[2];
const query = process.argv[3] ?? "wood";
const config = JSON.parse(await readFile(configPath, "utf8"));
const session = await connectNativeLocalClient(config, { loadModule: loadDistTestClient });
try {
  await observeFresh(session.client, { actionable: true });
  console.log("query=", query);
  const result = await session.client.navigationRead({ operation: "find_destination", args: { query } });
  console.log("RAW RESULT:", JSON.stringify(result, null, 2).slice(0, 2000));
} catch (error) {
  console.log("ERROR:", error.message);
  console.log("DIAGNOSTICS:", JSON.stringify(session.diagnostics, null, 2).slice(0, 1500));
} finally {
  await session.close();
}

async function loadDistTestClient(entry) {
  const { LocalStardewBridgeClient } = await import(`../host/dist-test/${entry}`);
  return { LocalStardewBridgeClient };
}