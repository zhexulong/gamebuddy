// English semantic-term recall (locale is en-US in the live fixture):
// NPC resident names and shop stock terms come from Data/Characters,
// Data/Shops + Data/Objects enrichment, not hardcoded aliases.
import { connectNativeLocalClient, observeFresh } from "./lib/stardew-native-smoke-harness-v1.mjs";
import { readFile } from "node:fs/promises";

const configPath = process.argv[2];
const config = JSON.parse(await readFile(configPath, "utf8"));
const session = await connectNativeLocalClient(config, { loadModule: loadDistTestClient });
try {
  await observeFresh(session.client, { actionable: true });
  const queries = [
    "Robin",      // NPC resident -> ScienceHouse (carpenter)
    "Pierre",     // NPC resident -> SeedShop
    "Seed Shop",  // location label variant -> SeedShop
    "seeds",      // shop stock term -> SeedShop
    "Carpenter",  // shop key term -> ScienceHouse
    "saloon",     // shop key -> Saloon
  ];
  const report = [];
  for (const query of queries) {
    const result = await session.client.navigationRead({ operation: "find_destination", args: { query } });
    const payload = result?.payload ?? result;
    report.push({
      query,
      status: payload.status,
      reason: payload.reason,
      labels: Array.isArray(payload.candidates) ? payload.candidates.map((c) => c.label) : undefined,
      resolved: payload.destination ? { kind: payload.destination.kind, label: payload.destination.label } : undefined,
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