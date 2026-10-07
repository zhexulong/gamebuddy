import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { produceProjectionParitySnapshot } from "./projection-parity-producer.mjs";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dest = path.join(packageDir, "contracts", "projection", "action-projection-parity.v1.json");
const produced = await produceProjectionParitySnapshot();
await mkdir(path.dirname(dest), { recursive: true });
await writeFile(dest, JSON.stringify(produced, null, 2) + "\n");
console.log("parity snapshot written:", dest);