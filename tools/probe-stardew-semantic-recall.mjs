// Real-environment semantic recall probe for find_destination.
// Connects to the live Mod bridge and issues NON-exact queries to prove
// the managed n-gram index + native metadata recall works in-game, not
// only exact-label lookups.
import { connectNativeLocalClient, observeFresh } from "./lib/stardew-native-smoke-harness-v1.mjs";
import { readFile } from "node:fs/promises";

const configPath = process.argv[2];
const config = JSON.parse(await readFile(configPath, "utf8"));
const session = await connectNativeLocalClient(config, { loadModule: loadDistTestClient });
try {
  await observeFresh(session.client, { actionable: true });
  const queries = [
    "wood",                    // prefix of Backwoods (latin prefix token)
    "back",                    // prefix of Backwoods
    "mine",                    // partial latin
    "罗宾",                     // CJK NPC display name (native metadata)
    "种子",                     // CJK service term (shop stock)
    "海滩",                     // CJK two-character intent
  ];
  const report = [];
  for (const query of queries) {
    const result = await session.client.navigationRead({ operation: "find_destination", args: { query } });
    const status = result?.payload?.status ?? result?.status;
    const reason = result?.payload?.reason ?? result?.reason;
    const candidates = result?.payload?.candidates ?? result?.candidates;
    report.push({
      query,
      status,
      reason,
      labels: Array.isArray(candidates) ? candidates.map((c) => c.label) : undefined,
    });
  }
  console.log(JSON.stringify(report, null, 2));
} finally {
  await session.close();
}

async function loadDistTestClient(entry) {
  const { LocalStardewBridgeClient } = await import(`../host/dist-test/${entry}`);
  return { LocalStardewBridgeClient };
}